

const AUTH_API = (typeof API_BASE !== "undefined" && API_BASE)
  ? API_BASE
  : "https://habit-tracker-extension.onrender.com";

/* =========================================================
   THEME SYNC — read saved prefs and apply to <html>
========================================================= */
function applyStoredTheme() {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.local.get(["theme", "accentColor"], (d) => {
    const html   = document.documentElement;
    const theme  = d.theme       || "light";
    const accent = d.accentColor || "indigo";
    if (theme === "dark") html.setAttribute("data-theme",  "dark");
    else                  html.removeAttribute("data-theme");
    html.setAttribute("data-accent", accent);
  });
}

/* =========================================================
   BROWSER / IDENTITY CAPABILITY DETECTION
   ─────────────────────────────────────────────────────────
   Returns true only when chrome.identity.getAuthToken is
   genuinely available. We probe it with interactive:false
   so there's no UX disruption on first load; we use the
   promise result only to set the hint text.
========================================================= */
function hasIdentityAPI() {
  try {
    return typeof chrome !== "undefined" &&
           typeof chrome.identity !== "undefined" &&
           typeof chrome.identity.getAuthToken === "function";
  } catch { return false; }
}

/* Quick silent probe — returns true if token comes back
   without the "API not supported" error.            */
async function probeIdentity() {
  if (!hasIdentityAPI()) return false;
  return new Promise(resolve => {
    try {
      chrome.identity.getAuthToken({ interactive: false }, (token) => {
        const err = chrome.runtime.lastError?.message || "";
        // "not supported" or "not signed in" both tell us about availability
        if (err.toLowerCase().includes("not supported") ||
            err.toLowerCase().includes("unsupported")) {
          resolve(false);
        } else {
          // any other result (including "user not signed in") means API is there
          resolve(true);
        }
      });
    } catch { resolve(false); }
  });
}

/* =========================================================
   UI HELPERS
========================================================= */
function showMsg(text, type = "error") {
  const box = document.getElementById("msgBox");
  if (!box) return;
  box.textContent = text;
  box.className   = `msg ${type} show`;
  if (type === "success") setTimeout(() => box.classList.remove("show"), 5000);
}
function hideMsg() { document.getElementById("msgBox")?.classList.remove("show"); }

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
  document.getElementById("loginSection") ?.classList.toggle("active", tab === "login");
  document.getElementById("signupSection")?.classList.toggle("active", tab === "signup");
  document.getElementById("tabLogin") ?.classList.toggle("active", tab === "login");
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

/* =========================================================
   PASSWORD STRENGTH
========================================================= */
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
      { w: "0%",   bg: "var(--border)", label: "" },
      { w: "25%",  bg: "#ef4444",       label: "Weak" },
      { w: "50%",  bg: "#f97316",       label: "Fair" },
      { w: "75%",  bg: "#eab308",       label: "Good" },
      { w: "100%", bg: "#22c55e",       label: "Strong" },
    ];
    const lvl = levels[score] || levels[0];
    fill.style.width = lvl.w; fill.style.background = lvl.bg;
    text.textContent = lvl.label; text.style.color = lvl.bg;
  });
}

/* =========================================================
   API FETCH WITH TIMEOUT + COLD-START HINT
========================================================= */
async function apiFetch(path, options = {}, timeoutMs = 30000) {
  const ctrl    = new AbortController();
  const tId     = setTimeout(() => ctrl.abort(), timeoutMs);
  const wakeId  = setTimeout(() => {
    if (!document.getElementById("msgBox")?.classList.contains("show"))
      showMsg("⏳ Server waking up (free tier cold start)… up to 30s", "info");
  }, 6000);
  try {
    const res = await fetch(`${AUTH_API}${path}`, {
      ...options, signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    clearTimeout(wakeId); clearTimeout(tId);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(wakeId); clearTimeout(tId);
    if (err.name === "AbortError")
      throw new Error("Server is still waking up — please try again in 15 s.");
    throw new Error("Cannot reach server. Check your internet connection.");
  }
}

/* =========================================================
   SESSION STORAGE
========================================================= */
function storeSession(token, user) {
  return new Promise(resolve => {
    chrome.storage.local.set({
      authToken:     token,
      userInfo:      user,
      lastValidated: new Date().toISOString().split("T")[0],
    }, () => {
      chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" }, () => {
        void chrome.runtime.lastError;
      });
      resolve();
    });
  });
}
function goToDashboard() { window.location.href = "dashboard.html"; }

/* =========================================================
   AUTO-LOGIN CHECK
========================================================= */
async function checkExistingSession() {
  let d;
  try { d = await new Promise(r => chrome.storage.local.get(["authToken","lastValidated"], r)); }
  catch { return; }
  if (!d.authToken) return;
  const today = new Date().toISOString().split("T")[0];
  if (d.lastValidated === today) { goToDashboard(); return; }
  try {
    const { ok } = await apiFetch("/auth/me", { headers: { Authorization: `Bearer ${d.authToken}` } }, 8000);
    if (ok) {
      await new Promise(r => chrome.storage.local.set({ lastValidated: today }, r));
      goToDashboard();
    }
  } catch { /* unreachable — show login */ }
}

/* =========================================================
   SIGN IN
========================================================= */
async function handleLogin() {
  const email    = (document.getElementById("loginEmail")?.value    || "").trim();
  const password = (document.getElementById("loginPassword")?.value || "");
  if (!email || !password) { showMsg("Please enter your email and password"); return; }
  setLoading("loginBtn", true, "Sign In"); hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/login", {
      method: "POST", body: JSON.stringify({ email, password }),
    });
    if (ok && data.token) {
      await storeSession(data.token, data.user);
      showMsg("Welcome back! Redirecting…", "success");
      setTimeout(goToDashboard, 700);
    } else { showMsg(data.error || "Incorrect email or password"); }
  } catch (err) { showMsg(err.message); }
  finally { setLoading("loginBtn", false, "Sign In"); }
}

/* =========================================================
   SIGN UP
========================================================= */
async function handleSignup() {
  const name     = (document.getElementById("signupName")?.value     || "").trim();
  const email    = (document.getElementById("signupEmail")?.value    || "").trim();
  const password = (document.getElementById("signupPassword")?.value || "");
  if (!email)              { showMsg("Email is required"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg("Please enter a valid email"); return; }
  if (!password)           { showMsg("Password is required"); return; }
  if (password.length < 8) { showMsg("Password must be at least 8 characters"); return; }
  setLoading("signupBtn", true, "Create Account"); hideMsg();
  try {
    const { ok, status, data } = await apiFetch("/auth/signup", {
      method: "POST", body: JSON.stringify({ email, password, name }),
    });
    if (ok && data.token) {
      await storeSession(data.token, data.user);
      showMsg("✅ Account created! Redirecting…", "success");
      setTimeout(goToDashboard, data.user?.isVerified ? 700 : 2200);
    } else if (status === 409) {
      showMsg("An account with this email already exists. Sign in instead.");
      setTimeout(() => switchTab("login"), 1800);
    } else { showMsg(data.error || "Sign up failed — please try again"); }
  } catch (err) { showMsg(err.message); }
  finally { setLoading("signupBtn", false, "Create Account"); }
}


/* original google button inner HTML so we can restore it */
const GOOGLE_BTN_HTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" style="width:17px;height:17px;flex-shrink:0;" /><span id="googleBtnLabel">Continue with Google</span>`;

let _identityWorks = null; // cached after first probe

async function handleGoogleSignIn() {
  hideMsg();
  const btn = document.getElementById("googleBtn");
  if (!btn) return;

  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner muted"></span> <span>Signing in…</span>`;

  // First run: probe which path to use
  if (_identityWorks === null) {
    _identityWorks = await probeIdentity();
  }

  try {
    if (_identityWorks) {
      await googleSignInViaIdentity();
    } else {
      await googleSignInViaWebPopup();
    }
  } catch (err) {
    showMsg(err.message || "Google sign-in failed. Please use email and password.");
    btn.disabled  = false;
    btn.innerHTML = GOOGLE_BTN_HTML;
  }
}

/* PATH A — chrome.identity (Chrome) */
async function googleSignInViaIdentity() {
  const btn = document.getElementById("googleBtn");
  const result = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GOOGLE_AUTH" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { success: false, error: "No response" });
      }
    });
  });

  if (result.success && result.token) {
    await storeSession(result.token, result.user);
    showMsg("Welcome! Redirecting…", "success");
    setTimeout(goToDashboard, 700);
  } else {
    const msg = result.error || "";
    // If chrome.identity failed with "not supported" at runtime, try web popup
    if (msg.toLowerCase().includes("not supported") ||
        msg.toLowerCase().includes("unsupported")) {
      _identityWorks = false;
      if (btn) { btn.disabled = false; btn.innerHTML = GOOGLE_BTN_HTML; }
      await googleSignInViaWebPopup();
    } else {
      throw new Error(msg || "Google sign-in failed. Try email/password instead.");
    }
  }
}

/* PATH B — web OAuth popup (works on Edge, Firefox, Opera, everything) */
async function googleSignInViaWebPopup() {
  const btn = document.getElementById("googleBtn");

  // Open the server's popup-initiator endpoint
  const popupUrl = `${AUTH_API}/auth/google/popup`;
  const pw = 480, ph = 580;
  const pl = Math.round(screen.width  / 2 - pw / 2);
  const pt = Math.round(screen.height / 2 - ph / 2);
  const popup = window.open(
    popupUrl, "ft_google_auth",
    `width=${pw},height=${ph},left=${pl},top=${pt},toolbar=no,menubar=no,location=no,scrollbars=yes`
  );

  if (!popup || popup.closed) {
    throw new Error(
      "Popup was blocked by your browser.\n" +
      "Please allow popups for this extension and try again."
    );
  }

  showMsg("👆 Complete Google sign-in in the popup window…", "info");

  return new Promise((resolve, reject) => {
    let done = false;

    // Timeout: 2 minutes
    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true; cleanup();
      reject(new Error("Google sign-in timed out. Please try again."));
    }, 120_000);

    // Poll for early close (user closed popup manually)
    const pollId = setInterval(() => {
      if (!popup.closed) return;
      clearInterval(pollId);
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      window.removeEventListener("message", onMsg);
      hideMsg();
      if (btn) { btn.disabled = false; btn.innerHTML = GOOGLE_BTN_HTML; }
      // don't reject — user just closed it deliberately
    }, 400);

    function cleanup() {
      clearTimeout(timeoutId);
      clearInterval(pollId);
      window.removeEventListener("message", onMsg);
      try { popup.close(); } catch {}
    }

    async function onMsg(ev) {
      if (!ev.data || ev.data.type !== "FOCUS_TRACKER_AUTH") return;
      if (done) return;
      done = true; cleanup();

      const { token, user, error } = ev.data;
      if (token) {
        try {
          await storeSession(token, user);
          hideMsg();
          showMsg("Welcome! Redirecting…", "success");
          setTimeout(() => { goToDashboard(); resolve(); }, 700);
        } catch (e) { reject(e); }
      } else {
        reject(new Error(error || "Google sign-in failed. Please try again."));
      }
    }

    window.addEventListener("message", onMsg);
  });
}

/* =========================================================
   FORGOT PASSWORD
========================================================= */
let forgotEmailCache = "";

async function handleSendOtp() {
  const email = (document.getElementById("forgotEmail")?.value || "").trim();
  if (!email) { showMsg("Please enter your email"); return; }
  setLoading("sendOtpBtn", true, "Send Reset Code"); hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email }),
    });
    if (ok) {
      forgotEmailCache = email;
      showMsg("Reset code sent! Check your inbox.", "success");
      setTimeout(() => {
        hideMsg();
        document.getElementById("forgotStep1").style.display = "none";
        document.getElementById("forgotStep2").style.display = "";
      }, 1400);
    } else { showMsg(data.error || "Failed to send reset email"); }
  } catch (err) { showMsg(err.message); }
  finally { setLoading("sendOtpBtn", false, "Send Reset Code"); }
}

async function handleResetPassword() {
  const otp         = (document.getElementById("otpInput")?.value   || "").trim();
  const newPassword = (document.getElementById("newPassword")?.value || "");
  if (!otp || otp.length !== 6) { showMsg("Enter the 6-digit code from your email"); return; }
  if (!newPassword || newPassword.length < 8) { showMsg("New password must be at least 8 characters"); return; }
  setLoading("resetBtn", true, "Reset Password"); hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/reset-password", {
      method: "POST", body: JSON.stringify({ email: forgotEmailCache, otp, newPassword }),
    });
    if (ok) {
      showMsg("✅ Password reset! You can now sign in.", "success");
      setTimeout(() => {
        showMain(); switchTab("login");
        const el = document.getElementById("loginEmail");
        if (el) el.value = forgotEmailCache;
      }, 1400);
    } else { showMsg(data.error || "Reset failed. Please try again."); }
  } catch (err) { showMsg(err.message); }
  finally { setLoading("resetBtn", false, "Reset Password"); }
}

/* =========================================================
   BOOT — wire all handlers; zero inline HTML
========================================================= */
document.addEventListener("DOMContentLoaded", async () => {

  // 1. Apply saved theme immediately to avoid flash
  applyStoredTheme();

  // 2. Wire tabs
  document.getElementById("tabLogin") ?.addEventListener("click", () => switchTab("login"));
  document.getElementById("tabSignup")?.addEventListener("click", () => switchTab("signup"));

  // 3. Forgot / back
  document.getElementById("forgotLink")    ?.addEventListener("click", showForgot);
  document.getElementById("backToLoginBtn")?.addEventListener("click", showMain);

  // 4. Auth buttons
  document.getElementById("loginBtn") ?.addEventListener("click", handleLogin);
  document.getElementById("signupBtn")?.addEventListener("click", handleSignup);
  document.getElementById("googleBtn")?.addEventListener("click", handleGoogleSignIn);
  document.getElementById("sendOtpBtn")?.addEventListener("click", handleSendOtp);
  document.getElementById("resetBtn") ?.addEventListener("click", handleResetPassword);
  document.getElementById("resendBtn")?.addEventListener("click", handleSendOtp);

  // 5. OTP: digits only
  document.getElementById("otpInput")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  // 6. Password strength
  initPasswordStrength();

  // 7. Enter key support
  const enterMap = {
    loginEmail: handleLogin, loginPassword: handleLogin,
    signupName: handleSignup, signupEmail: handleSignup, signupPassword: handleSignup,
    forgotEmail: handleSendOtp, newPassword: handleResetPassword,
  };
  for (const [id, fn] of Object.entries(enterMap)) {
    document.getElementById(id)?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") fn();
    });
  }

  // 8. Set Google button hint + probe capability in background
  //    (don't await — do it async so page loads instantly)
  probeIdentity().then(works => {
    _identityWorks = works;
    const hint = document.getElementById("googleHint");
    if (hint) {
      hint.textContent = works
        ? ""  // seamless on Chrome — no hint needed
        : "Opens a secure sign-in window";
    }
  });

  // 9. Auto-login if valid session
  checkExistingSession().catch(console.error);
});