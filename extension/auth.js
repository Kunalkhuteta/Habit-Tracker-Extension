/* =========================================================
   auth.js — Sign-in, sign-up, Google OAuth, forgot password

   CSP FIX: All event handlers wired here in JS, zero onclick=
   in HTML. Chrome extensions block inline handlers via CSP.
========================================================= */

// const AUTH_API = (typeof API_BASE !== "undefined" && API_BASE)
//   ? API_BASE
//   : "http://localhost:5000";
const AUTH_API = (typeof API_BASE !== "undefined" && API_BASE)
  ? API_BASE
  : "https://habit-tracker-extension.onrender.com";

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
function initPasswordStrength() {
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
}

/* =========================
   FETCH WITH TIMEOUT
========================= */
async function apiFetch(path, options = {}, timeoutMs = 30000) {
  const controller    = new AbortController();
  const timeoutId     = setTimeout(() => controller.abort(), timeoutMs);
  const wakeHintTimer = setTimeout(() => {
    if (!document.getElementById("msgBox")?.classList.contains("show")) {
      showMsg("⏳ Server waking up (free tier cold start)… please wait up to 30s", "info");
    }
  }, 6000);

  try {
    const res = await fetch(`${AUTH_API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
    clearTimeout(wakeHintTimer);
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(wakeHintTimer);
    clearTimeout(timeoutId);
    if (err.name === "AbortError")
      throw new Error("Server is still waking up — please try again in 15 seconds.");
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
    }, () => {
      chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" }, () => {
        void chrome.runtime.lastError;
      });
      resolve();
    });
  });
}

function goToDashboard() {
  window.location.href = "dashboard.html";
}

/* =========================
   AUTO-LOGIN CHECK
========================= */
async function checkExistingSession() {
  let data;
  try {
    data = await new Promise(resolve =>
      chrome.storage.local.get(["authToken", "lastValidated"], resolve)
    );
  } catch { return; }

  if (!data.authToken) return;

  const today = new Date().toISOString().split("T")[0];
  if (data.lastValidated === today) { goToDashboard(); return; }

  try {
    const { ok } = await apiFetch("/auth/me", {
      headers: { Authorization: `Bearer ${data.authToken}` }
    }, 8000);
    if (ok) {
      await new Promise(resolve => chrome.storage.local.set({ lastValidated: today }, resolve));
      goToDashboard();
    }
  } catch { /* server unreachable — show login */ }
}

/* =========================
   SIGN IN
========================= */
async function handleLogin() {
  const email    = (document.getElementById("loginEmail")?.value    || "").trim();
  const password = (document.getElementById("loginPassword")?.value || "");

  if (!email || !password) { showMsg("Please enter your email and password"); return; }

  setLoading("loginBtn", true, "Sign In");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/login", {
      method: "POST",
      body:   JSON.stringify({ email, password })
    });

    if (ok && data.token) {
      await storeSession(data.token, data.user);
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
  const name     = (document.getElementById("signupName")?.value     || "").trim();
  const email    = (document.getElementById("signupEmail")?.value    || "").trim();
  const password = (document.getElementById("signupPassword")?.value || "");

  if (!email)                { showMsg("Email is required"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg("Please enter a valid email address"); return; }
  if (!password)             { showMsg("Password is required"); return; }
  if (password.length < 8)  { showMsg("Password must be at least 8 characters"); return; }

  setLoading("signupBtn", true, "Create Account");
  hideMsg();

  try {
    const { ok, status, data } = await apiFetch("/auth/signup", {
      method: "POST",
      body:   JSON.stringify({ email, password, name })
    });

    if (ok && data.token) {
      await storeSession(data.token, data.user);
      if (!data.user?.isVerified) {
        showMsg("✅ Account created! Check your email to verify, then redirecting…", "info");
        setTimeout(goToDashboard, 2500);
      } else {
        showMsg("✅ Account created! Redirecting…", "success");
        setTimeout(goToDashboard, 800);
      }
    } else if (status === 409) {
      showMsg("An account with this email already exists. Try signing in instead.");
      setTimeout(() => switchTab("login"), 2000);
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
========================= */
const GOOGLE_BTN_HTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style="width:20px;height:20px;" /> Continue with Google`;

async function handleGoogleSignIn() {
  hideMsg();
  const btn = document.getElementById("googleBtn");
  if (!btn) return;

  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner" style="border-color:rgba(0,0,0,0.15);border-top-color:#374151;"></span> Signing in…`;

  if (!chrome?.runtime?.sendMessage) {
    showMsg("Chrome extension API not available. Try reloading.");
    btn.disabled = false; btn.innerHTML = GOOGLE_BTN_HTML; return;
  }

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Google sign-in timed out. Try email/password instead.")), 35000)
  );
  const authPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GOOGLE_AUTH" }, (response) => {
      if (chrome.runtime.lastError)
        resolve({ success: false, error: chrome.runtime.lastError.message });
      else
        resolve(response || { success: false, error: "No response from background" });
    });
  });

  try {
    const response = await Promise.race([authPromise, timeoutPromise]);
    if (response.success && response.token) {
      await storeSession(response.token, response.user);
      showMsg("Welcome! Redirecting…", "success");
      setTimeout(goToDashboard, 800);
    } else {
      showMsg(response.error || "Google sign-in failed. Please try email/password instead.");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    btn.disabled = false; btn.innerHTML = GOOGLE_BTN_HTML;
  }
}

/* =========================
   FORGOT PASSWORD
========================= */
let forgotEmailCache = "";

async function handleSendOtp() {
  const email = (document.getElementById("forgotEmail")?.value || "").trim();
  if (!email) { showMsg("Please enter your email"); return; }

  setLoading("sendOtpBtn", true, "Send Reset Code");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email })
    });
    if (ok) {
      forgotEmailCache = email;
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
  const otp         = (document.getElementById("otpInput")?.value  || "").trim();
  const newPassword = (document.getElementById("newPassword")?.value || "");

  if (!otp || otp.length !== 6) { showMsg("Enter the 6-digit code from your email"); return; }
  if (!newPassword || newPassword.length < 8) { showMsg("New password must be at least 8 characters"); return; }

  setLoading("resetBtn", true, "Reset Password");
  hideMsg();

  try {
    const { ok, data } = await apiFetch("/auth/reset-password", {
      method: "POST",
      body:   JSON.stringify({ email: forgotEmailCache, otp, newPassword })
    });
    if (ok) {
      showMsg("✅ Password reset! You can now sign in.", "success");
      setTimeout(() => {
        showMain(); switchTab("login");
        const el = document.getElementById("loginEmail");
        if (el) el.value = forgotEmailCache;
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
   BOOT — wire ALL handlers here, zero inline HTML
========================= */
document.addEventListener("DOMContentLoaded", () => {
  // Tab switching — replaces onclick="switchTab('login')" in HTML
  document.getElementById("tabLogin")?.addEventListener("click",  () => switchTab("login"));
  document.getElementById("tabSignup")?.addEventListener("click", () => switchTab("signup"));

  // Forgot password link — replaces onclick="showForgot()"
  document.getElementById("forgotLink")?.addEventListener("click", showForgot);

  // Back to login — replaces onclick="showMain()"
  document.getElementById("backToLoginBtn")?.addEventListener("click", showMain);

  // Main auth buttons
  document.getElementById("loginBtn")?.addEventListener("click",   handleLogin);
  document.getElementById("signupBtn")?.addEventListener("click",  handleSignup);
  document.getElementById("googleBtn")?.addEventListener("click",  handleGoogleSignIn);
  document.getElementById("sendOtpBtn")?.addEventListener("click", handleSendOtp);
  document.getElementById("resetBtn")?.addEventListener("click",   handleResetPassword);
  document.getElementById("resendBtn")?.addEventListener("click",  handleSendOtp);

  // OTP: numbers only
  document.getElementById("otpInput")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  // Password strength meter
  initPasswordStrength();

  // Enter key support
  const enterMap = {
    "loginEmail":     handleLogin,
    "loginPassword":  handleLogin,
    "signupName":     handleSignup,
    "signupEmail":    handleSignup,
    "signupPassword": handleSignup,
    "forgotEmail":    handleSendOtp,
    "newPassword":    handleResetPassword,
  };
  for (const [id, fn] of Object.entries(enterMap)) {
    document.getElementById(id)?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") fn();
    });
  }

  // Auto-login if valid session exists
  checkExistingSession().catch(console.error);
});