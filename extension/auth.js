/* =========================================================
   auth.js — Sign-in, sign-up, Google OAuth, forgot password
   
   KEY FIXES:
   1. fetch() now has a 15s timeout — Render free tier cold
      starts take 30-60s, previously the button just froze
      with no feedback. Now shows "Server is waking up..."
   2. Google auth routed through background.js via sendMessage
      because chrome.identity only works in service worker
   3. All errors shown visibly — no more silent failures
========================================================= */

/* =========================
   UI HELPERS
========================= */
function showMsg(text, type = "error") {
  const box = document.getElementById("msgBox");
  if (!box) return;
  box.textContent = text;
  box.className   = `msg ${type} show`;
  if (type === "success") setTimeout(() => box.classList.remove("show"), 5000);
}

function hideMsg() {
  document.getElementById("msgBox")?.classList.remove("show");
}

function setLoading(btnId, loading, label = "") {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled  = loading;
  btn.innerHTML = loading
    ? `<span class="spinner"></span> Please wait…`
    : (label || btn.dataset.label || btn.textContent);
  if (label) btn.dataset.label = label;
}

function switchTab(tab) {
  hideMsg();
  document.getElementById("loginSection")?.classList.toggle("active",  tab === "login");
  document.getElementById("signupSection")?.classList.toggle("active", tab === "signup");
  document.getElementById("tabLogin")?.classList.toggle("active",  tab === "login");
  document.getElementById("tabSignup")?.classList.toggle("active", tab === "signup");
}

function showForgot() {
  hideMsg();
  document.getElementById("mainSection").style.display = "none";
  document.getElementById("forgotSection").classList.add("active");
}

function showMain() {
  hideMsg();
  document.getElementById("mainSection").style.display = "";
  document.getElementById("forgotSection").classList.remove("active");
  document.getElementById("forgotStep1").style.display = "";
  document.getElementById("forgotStep2").style.display = "none";
}

/* =========================
   PASSWORD STRENGTH
========================= */
document.getElementById("signupPassword")?.addEventListener("input", (e) => {
  const val  = e.target.value;
  const fill = document.getElementById("strengthFill");
  const text = document.getElementById("strengthText");
  if (!fill || !text) return;

  let score = 0;
  if (val.length >= 8)          score++;
  if (/[A-Z]/.test(val))        score++;
  if (/[0-9]/.test(val))        score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;

  const levels = [
    { w: "0%",   bg: "#e2e8f0", label: "" },
    { w: "25%",  bg: "#ef4444", label: "Weak" },
    { w: "50%",  bg: "#f97316", label: "Fair" },
    { w: "75%",  bg: "#eab308", label: "Good" },
    { w: "100%", bg: "#22c55e", label: "Strong" }
  ];
  const lvl = levels[score] || levels[0];
  fill.style.width      = lvl.w;
  fill.style.background = lvl.bg;
  text.textContent      = lvl.label;
  text.style.color      = lvl.bg;
});

/* =========================
   FETCH WITH TIMEOUT
   
   Render free tier sleeps after 15 min — first request
   takes 30-60s to wake up. Without a timeout the button
   just freezes indefinitely with no feedback.
   We show a helpful "waking up" message after 5s.
========================= */
async function apiFetch(path, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);

  // Show "waking up" hint after 5 seconds of waiting
  let wakeHintTimer = setTimeout(() => {
    const box = document.getElementById("msgBox");
    if (box && !box.classList.contains("show")) {
      showMsg("⏳ Server is waking up (Render free tier)... please wait up to 30s", "info");
    }
  }, 5000);

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    clearTimeout(wakeHintTimer);
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };

  } catch (err) {
    clearTimeout(wakeHintTimer);
    clearTimeout(timeoutId);

    if (err.name === "AbortError") {
      throw new Error("Request timed out. The server may be waking up — please try again in 30 seconds.");
    }
    throw new Error("Cannot reach server. Check your internet connection.");
  }
}

/* =========================
   SESSION HELPERS
========================= */
function storeSession(token, user) {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      authToken:     token,
      userInfo:      user,
      lastValidated: new Date().toISOString().split("T")[0]
    }, resolve);
  });
}

function goToDashboard() {
  window.location.href = "dashboard.html";
}

/* =========================
   AUTO-LOGIN CHECK
========================= */
async function checkExistingSession() {
  const data = await new Promise(resolve =>
    chrome.storage.local.get(["authToken", "lastValidated"], resolve)
  );

  if (!data.authToken) return;

  const today = new Date().toISOString().split("T")[0];
  if (data.lastValidated === today) {
    goToDashboard();
    return;
  }

  try {
    const { ok } = await apiFetch("/auth/me", {
      headers: { Authorization: `Bearer ${data.authToken}` }
    }, 10000);

    if (ok) {
      await new Promise(resolve =>
        chrome.storage.local.set({ lastValidated: today }, resolve)
      );
      goToDashboard();
    }
  } catch {
    // Server unreachable or token expired — show login page
  }
}

/* =========================
   SIGN IN
========================= */
async function handleLogin() {
  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!email || !password) { showMsg("Please enter your email and password"); return; }

  setLoading("loginBtn", true, "Sign In");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    if (ok && data.token) {
      await storeSession(data.token, data.user);
      chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" });
      showMsg("Welcome back! Redirecting…", "success");
      setTimeout(goToDashboard, 800);
    } else {
      showMsg(data.error || "Incorrect email or password");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("loginBtn", false, "Sign In");
  }
}

/* =========================
   SIGN UP
========================= */
async function handleSignup() {
  const name     = document.getElementById("signupName").value.trim();
  const email    = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;

  if (!email)            { showMsg("Email is required"); return; }
  if (!password)         { showMsg("Password is required"); return; }
  if (password.length < 8) { showMsg("Password must be at least 8 characters"); return; }

  setLoading("signupBtn", true, "Create Account");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, name })
    });

    if (ok && data.token) {
      await storeSession(data.token, data.user);
      chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" });

      if (!data.user?.isVerified) {
        showMsg("Account created! Check your email to verify.", "info");
        setTimeout(goToDashboard, 2500);
      } else {
        showMsg("Account created!", "success");
        setTimeout(goToDashboard, 800);
      }
    } else {
      showMsg(data.error || "Sign up failed — please try again");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("signupBtn", false, "Create Account");
  }
}

/* =========================
   GOOGLE SIGN-IN
   
   Routed through background.js because chrome.identity
   ONLY works in the service worker — not in extension pages.
========================= */
async function handleGoogleSignIn() {
  console.log("[AUTH.JS] Google button clicked");
  hideMsg();

  const btn = document.getElementById("googleBtn");
  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner" style="border-color:rgba(0,0,0,0.15);border-top-color:#374151;"></span> Signing in…`;

  // Check chrome.runtime is available
  if (!chrome?.runtime?.sendMessage) {
    showMsg("Chrome extension API not available. Try reloading.");
    btn.disabled = false;
    btn.innerHTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:18px;height:18px;" alt="Google" /> Continue with Google`;
    return;
  }

  console.log("[AUTH.JS] Sending GOOGLE_AUTH message to background...");

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("No response from background after 35s. Open chrome://extensions → service worker → Console to see the error.")), 35000)
  );

  const authPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GOOGLE_AUTH" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[AUTH.JS] sendMessage error:", chrome.runtime.lastError.message);
        resolve({ success: false, error: "Background error: " + chrome.runtime.lastError.message });
      } else {
        console.log("[AUTH.JS] Got response from background:", response);
        resolve(response || { success: false, error: "Background returned no response" });
      }
    });
  });

  try {
    const response = await Promise.race([authPromise, timeoutPromise]);

    if (response.success && response.token) {
      await storeSession(response.token, response.user);
      showMsg("Welcome! Redirecting…", "success");
      setTimeout(goToDashboard, 800);
    } else {
      showMsg(response.error || "Google sign-in failed. Please try again.");
    }
  } catch (err) {
    console.error("[AUTH.JS] Google auth error:", err.message);
    showMsg(err.message);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" style="width:18px;height:18px;" alt="Google" /> Continue with Google`;
  }
}

/* =========================
   FORGOT PASSWORD
========================= */
let forgotEmail = "";

async function handleSendOtp() {
  const email = document.getElementById("forgotEmail").value.trim();
  if (!email) { showMsg("Please enter your email"); return; }

  setLoading("sendOtpBtn", true, "Send Reset Code");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    if (ok) {
      forgotEmail = email;
      showMsg("Reset code sent! Check your inbox.", "success");
      setTimeout(() => {
        hideMsg();
        document.getElementById("forgotStep1").style.display = "none";
        document.getElementById("forgotStep2").style.display = "";
      }, 1500);
    } else {
      showMsg(data.error || "Failed to send reset email");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("sendOtpBtn", false, "Send Reset Code");
  }
}

async function handleResetPassword() {
  const otp         = document.getElementById("otpInput").value.trim();
  const newPassword = document.getElementById("newPassword").value;

  if (!otp || otp.length !== 6) { showMsg("Enter the 6-digit code from your email"); return; }
  if (!newPassword || newPassword.length < 8) { showMsg("Password must be at least 8 characters"); return; }

  setLoading("resetBtn", true, "Reset Password");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ email: forgotEmail, otp, newPassword })
    });

    if (ok) {
      showMsg("Password reset! You can now sign in.", "success");
      setTimeout(() => {
        showMain();
        switchTab("login");
        document.getElementById("loginEmail").value = forgotEmail;
      }, 1500);
    } else {
      showMsg(data.error || "Reset failed. Please try again.");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("resetBtn", false, "Reset Password");
  }
}

/* =========================
   OTP: numbers only
========================= */
document.getElementById("otpInput")?.addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
});

/* =========================
   EVENT LISTENERS
========================= */
document.addEventListener("DOMContentLoaded", () => {
  // Check if already logged in — skip auth if valid session exists
  checkExistingSession().catch(console.error);

  document.getElementById("loginBtn")?.addEventListener("click", handleLogin);
  document.getElementById("signupBtn")?.addEventListener("click", handleSignup);
  document.getElementById("googleBtn")?.addEventListener("click", handleGoogleSignIn);
  document.getElementById("sendOtpBtn")?.addEventListener("click", handleSendOtp);
  document.getElementById("resetBtn")?.addEventListener("click", handleResetPassword);
  document.getElementById("resendBtn")?.addEventListener("click", handleSendOtp);

  // Enter key support
  document.getElementById("loginEmail")?.addEventListener("keypress",     e => e.key === "Enter" && handleLogin());
  document.getElementById("loginPassword")?.addEventListener("keypress",  e => e.key === "Enter" && handleLogin());
  document.getElementById("signupName")?.addEventListener("keypress",     e => e.key === "Enter" && handleSignup());
  document.getElementById("signupEmail")?.addEventListener("keypress",    e => e.key === "Enter" && handleSignup());
  document.getElementById("signupPassword")?.addEventListener("keypress", e => e.key === "Enter" && handleSignup());
  document.getElementById("forgotEmail")?.addEventListener("keypress",    e => e.key === "Enter" && handleSendOtp());
  document.getElementById("newPassword")?.addEventListener("keypress",    e => e.key === "Enter" && handleResetPassword());
});