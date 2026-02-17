/* =========================================================
   auth.js  —  Handles sign-in, sign-up, Google OAuth,
               forgot password, and session management.

   Depends on: config.js (provides API_BASE)
========================================================= */

/* =========================
   UI HELPERS
========================= */
function showMsg(text, type = "error") {
  const box = document.getElementById("msgBox");
  box.textContent = text;
  box.className   = `msg ${type} show`;
  // Auto-hide success messages
  if (type === "success") setTimeout(() => box.classList.remove("show"), 4000);
}

function hideMsg() {
  document.getElementById("msgBox").classList.remove("show");
}

function setLoading(btnId, loading, label = "") {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<span class="spinner"></span> Please wait…`
    : label || btn.dataset.label || btn.textContent;
  if (label) btn.dataset.label = label;
}

function switchTab(tab) {
  hideMsg();
  document.getElementById("loginSection").classList.toggle("active", tab === "login");
  document.getElementById("signupSection").classList.toggle("active", tab === "signup");
  document.getElementById("tabLogin").classList.toggle("active", tab === "login");
  document.getElementById("tabSignup").classList.toggle("active", tab === "signup");
}

function showForgot() {
  hideMsg();
  document.getElementById("mainSection").style.display  = "none";
  document.getElementById("forgotSection").classList.add("active");
}

function showMain() {
  hideMsg();
  document.getElementById("mainSection").style.display  = "";
  document.getElementById("forgotSection").classList.remove("active");
  // Reset forgot steps
  document.getElementById("forgotStep1").style.display = "";
  document.getElementById("forgotStep2").style.display = "none";
}

/* =========================
   PASSWORD STRENGTH
========================= */
document.getElementById("signupPassword").addEventListener("input", (e) => {
  const val  = e.target.value;
  const fill = document.getElementById("strengthFill");
  const text = document.getElementById("strengthText");

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
   STORAGE HELPERS
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

/* =========================
   API HELPERS
========================= */
async function apiFetch(path, options = {}) {
  const res  = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function goToDashboard() {
  window.location.href = "dashboard.html";
}

/* =========================
   SIGN IN
========================= */
async function handleLogin() {
  const email    = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  if (!email || !password) {
    showMsg("Please enter your email and password");
    return;
  }

  setLoading("loginBtn", true, "Sign In");
  hideMsg();

  const { ok, data } = await apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  setLoading("loginBtn", false);

  if (ok && data.token) {
    await storeSession(data.token, data.user);
    // Tell background script to reload its auth state
    chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" });
    showMsg("Welcome back! Redirecting…", "success");
    setTimeout(goToDashboard, 800);
  } else {
    showMsg(data.error || "Sign in failed. Please try again.");
  }
}

/* =========================
   SIGN UP
========================= */
async function handleSignup() {
  const name     = document.getElementById("signupName").value.trim();
  const email    = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;

  if (!email || !password) {
    showMsg("Email and password are required");
    return;
  }
  if (password.length < 8) {
    showMsg("Password must be at least 8 characters");
    return;
  }

  setLoading("signupBtn", true, "Create Account");
  hideMsg();

  const { ok, data } = await apiFetch("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, name })
  });

  setLoading("signupBtn", false);

  if (ok && data.token) {
    await storeSession(data.token, data.user);
    chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" });

    if (!data.user?.isVerified) {
      showMsg("Account created! Check your email to verify your account.", "info");
      setTimeout(goToDashboard, 2000);
    } else {
      showMsg("Account created! Welcome!", "success");
      setTimeout(goToDashboard, 800);
    }
  } else {
    showMsg(data.error || "Sign up failed. Please try again.");
  }
}

/* =========================
   GOOGLE SIGN-IN
========================= */
async function handleGoogleSignIn() {
  hideMsg();

  // chrome.identity.getAuthToken gets a Google OAuth access token
  // without the user ever seeing a "token" string — they just click
  // their Google account and that's it.
  chrome.identity.getAuthToken({ interactive: true }, async (accessToken) => {
    if (chrome.runtime.lastError || !accessToken) {
      showMsg("Google sign-in was cancelled or failed. Please try again.");
      return;
    }

    document.getElementById("googleBtn").disabled = true;
    document.getElementById("googleBtn").innerHTML = `<span class="spinner" style="border-color:rgba(0,0,0,0.2);border-top-color:#374151;"></span> Signing in…`;

    const { ok, data } = await apiFetch("/auth/google", {
      method: "POST",
      body: JSON.stringify({ accessToken })
    });

    document.getElementById("googleBtn").disabled = false;
    document.getElementById("googleBtn").innerHTML = `
      <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style="width:20px;height:20px;" />
      Continue with Google
    `;

    if (ok && data.token) {
      await storeSession(data.token, data.user);
      chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" });
      showMsg("Welcome! Redirecting…", "success");
      setTimeout(goToDashboard, 800);
    } else {
      showMsg(data.error || "Google sign-in failed. Please try again.");
    }
  });
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

  const { ok, data } = await apiFetch("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email })
  });

  setLoading("sendOtpBtn", false);

  if (ok) {
    forgotEmail = email;
    showMsg("Reset code sent! Check your inbox.", "success");
    setTimeout(() => {
      hideMsg();
      document.getElementById("forgotStep1").style.display = "none";
      document.getElementById("forgotStep2").style.display = "";
    }, 1200);
  } else {
    showMsg(data.error || "Failed to send reset email");
  }
}

async function handleResetPassword() {
  const otp         = document.getElementById("otpInput").value.trim();
  const newPassword = document.getElementById("newPassword").value;

  if (!otp || otp.length !== 6) { showMsg("Enter the 6-digit code from your email"); return; }
  if (!newPassword || newPassword.length < 8) { showMsg("Password must be at least 8 characters"); return; }

  setLoading("resetBtn", true, "Reset Password");
  hideMsg();

  const { ok, data } = await apiFetch("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ email: forgotEmail, otp, newPassword })
  });

  setLoading("resetBtn", false);

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
}

/* =========================
   AUTO-LOGIN CHECK
========================= */
async function checkExistingSession() {
  const data = await new Promise(resolve =>
    chrome.storage.local.get(["authToken", "lastValidated"], resolve)
  );

  if (!data.authToken) return; // No session, show login

  const today = new Date().toISOString().split("T")[0];
  if (data.lastValidated === today) {
    // Already validated today — go straight to dashboard
    goToDashboard();
    return;
  }

  // Validate token with server (might be expired)
  const { ok } = await apiFetch("/auth/me", {
    headers: { Authorization: `Bearer ${data.authToken}` }
  });

  if (ok) {
    // Token still valid — update validation date and proceed
    await new Promise(resolve =>
      chrome.storage.local.set({ lastValidated: today }, resolve)
    );
    goToDashboard();
  }
  // else: token expired — show login page (do nothing)
}

/* =========================
   OTP INPUT: numbers only
========================= */
document.getElementById("otpInput").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
});

/* =========================
   EVENT LISTENERS
========================= */
document.addEventListener("DOMContentLoaded", () => {
  checkExistingSession();

  document.getElementById("loginBtn").addEventListener("click", handleLogin);
  document.getElementById("signupBtn").addEventListener("click", handleSignup);
  document.getElementById("googleBtn").addEventListener("click", handleGoogleSignIn);
  document.getElementById("sendOtpBtn").addEventListener("click", handleSendOtp);
  document.getElementById("resetBtn").addEventListener("click", handleResetPassword);
  document.getElementById("resendBtn").addEventListener("click", handleSendOtp);

  // Enter key support
  ["loginEmail", "loginPassword"].forEach(id => {
    document.getElementById(id)?.addEventListener("keypress", e => {
      if (e.key === "Enter") handleLogin();
    });
  });

  ["signupName", "signupEmail", "signupPassword"].forEach(id => {
    document.getElementById(id)?.addEventListener("keypress", e => {
      if (e.key === "Enter") handleSignup();
    });
  });

  document.getElementById("forgotEmail")?.addEventListener("keypress", e => {
    if (e.key === "Enter") handleSendOtp();
  });

  document.getElementById("newPassword")?.addEventListener("keypress", e => {
    if (e.key === "Enter") handleResetPassword();
  });
});