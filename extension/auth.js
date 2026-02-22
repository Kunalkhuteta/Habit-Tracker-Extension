/* auth.js — Focus Tracker authentication
   Handles: Sign in, Sign up, Google OAuth (web popup + chrome.identity),
   Forgot password / OTP reset, theme sync, auto-login
*/

const AUTH_API = (typeof API_BASE !== "undefined" && API_BASE)
  ? API_BASE.replace(/\/+$/, "")
  : "https://habit-tracker-extension.onrender.com";

/* ─────────────────────────────────────────
   THEME SYNC
───────────────────────────────────────── */
function applyStoredTheme() {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  chrome.storage.local.get(["theme", "accentColor"], (d) => {
    const html   = document.documentElement;
    const theme  = d.theme       || "light";
    const accent = d.accentColor || "indigo";
    if (theme === "dark") html.setAttribute("data-theme", "dark");
    else                  html.removeAttribute("data-theme");
    html.setAttribute("data-accent", accent);
  });
}

/* ─────────────────────────────────────────
   IDENTITY API PROBE
───────────────────────────────────────── */
function hasIdentityAPI() {
  try {
    return (
      typeof chrome !== "undefined" &&
      typeof chrome.identity !== "undefined" &&
      typeof chrome.identity.getAuthToken === "function"
    );
  } catch { return false; }
}

async function probeIdentity() {
  if (!hasIdentityAPI()) return false;
  return new Promise(resolve => {
    try {
      chrome.identity.getAuthToken({ interactive: false }, () => {
        const err = chrome.runtime.lastError?.message || "";
        resolve(
          !err.toLowerCase().includes("not supported") &&
          !err.toLowerCase().includes("unsupported")
        );
      });
    } catch { resolve(false); }
  });
}

/* ─────────────────────────────────────────
   UI HELPERS
───────────────────────────────────────── */
function showMsg(text, type = "error") {
  const box = document.getElementById("msgBox");
  if (!box) return;
  box.textContent = text;
  box.className   = `msg ${type} show`;
  if (type === "success") setTimeout(() => box.classList.remove("show"), 5000);
}
function hideMsg() { document.getElementById("msgBox")?.classList.remove("show"); }

function setLoading(btnId, loading, label) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  if (label) btn.dataset.label = label;
  btn.innerHTML = loading
    ? `<span class="spinner"></span>Please wait…`
    : (btn.dataset.label || label || btn.textContent);
}

function switchTab(tab) {
  hideMsg();
  document.getElementById("loginSection") ?.classList.toggle("active", tab === "login");
  document.getElementById("signupSection")?.classList.toggle("active", tab === "signup");
  document.getElementById("tabLogin") ?.classList.toggle("active", tab === "login");
  document.getElementById("tabSignup")?.classList.toggle("active", tab === "signup");
  const h = document.getElementById("formH");
  const p = document.getElementById("formP");
  if (h) h.textContent = tab === "login" ? "Welcome back"   : "Create account";
  if (p) p.textContent = tab === "login"
    ? "Sign in to your account to continue"
    : "Start tracking your focus today";
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

/* ─────────────────────────────────────────
   PASSWORD STRENGTH
───────────────────────────────────────── */
function initPasswordStrength() {
  document.getElementById("signupPassword")?.addEventListener("input", (e) => {
    const val  = e.target.value;
    const fill = document.getElementById("strengthFill");
    const text = document.getElementById("strengthText");
    if (!fill || !text) return;
    let score = 0;
    if (val.length >= 8)           score++;
    if (/[A-Z]/.test(val))         score++;
    if (/[0-9]/.test(val))         score++;
    if (/[^A-Za-z0-9]/.test(val))  score++;
    const levels = [
      { w: "0%",   bg: "var(--border)", label: "" },
      { w: "25%",  bg: "#ef4444",       label: "Weak" },
      { w: "50%",  bg: "#f97316",       label: "Fair" },
      { w: "75%",  bg: "#eab308",       label: "Good" },
      { w: "100%", bg: "#22c55e",       label: "Strong" },
    ];
    const lvl = levels[score] || levels[0];
    fill.style.width      = lvl.w;
    fill.style.background = lvl.bg;
    text.textContent      = lvl.label;
    text.style.color      = lvl.bg;
  });
}

/* ─────────────────────────────────────────
   API FETCH — timeout + cold-start hint
───────────────────────────────────────── */
async function apiFetch(path, options = {}, timeoutMs = 30000) {
  const ctrl   = new AbortController();
  const tId    = setTimeout(() => ctrl.abort(), timeoutMs);
  const wakeId = setTimeout(() => {
    const box = document.getElementById("msgBox");
    if (!box?.classList.contains("show"))
      showMsg("⏳ Server is waking up (free tier cold start — up to 30s)…", "info");
  }, 7000);
  try {
    const res = await fetch(`${AUTH_API}${path}`, {
      ...options,
      signal:  ctrl.signal,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    clearTimeout(wakeId);
    clearTimeout(tId);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(wakeId);
    clearTimeout(tId);
    if (err.name === "AbortError")
      throw new Error("Server took too long to respond. Please try again.");
    throw new Error("Cannot reach server. Check your internet connection.");
  }
}

/* ─────────────────────────────────────────
   SESSION STORAGE
───────────────────────────────────────── */
function storeSession(token, user) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === "undefined" || !chrome.storage) {
      resolve();
      return;
    }
    chrome.storage.local.set(
      {
        authToken:     token,
        userInfo:      user || {},
        lastValidated: new Date().toISOString().split("T")[0],
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        try {
          chrome.runtime.sendMessage({ type: "AUTH_TOKEN_UPDATED" }, () => {
            void chrome.runtime.lastError;
          });
        } catch { /* background not running is fine */ }
        resolve();
      }
    );
  });
}

function goToDashboard() {
  window.location.href = "dashboard.html";
}

/* ─────────────────────────────────────────
   AUTO-LOGIN CHECK
───────────────────────────────────────── */
async function checkExistingSession() {
  let d;
  try {
    d = await new Promise((resolve, reject) => {
      chrome.storage.local.get(["authToken", "lastValidated"], (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
  } catch { return; }

  if (!d.authToken) return;

  const today = new Date().toISOString().split("T")[0];

  // Validated today already — skip network call, go straight to dashboard
  if (d.lastValidated === today) {
    goToDashboard();
    return;
  }

  // Validate with server
  try {
    const { ok, status } = await apiFetch(
      "/auth/me",
      { headers: { Authorization: `Bearer ${d.authToken}` } },
      10000
    );
    if (ok) {
      await new Promise(r => chrome.storage.local.set({ lastValidated: today }, r));
      goToDashboard();
    } else if (status === 401 || status === 403) {
      chrome.storage.local.remove(["authToken", "lastValidated", "userInfo"]);
    }
  } catch {
    // Server unreachable — stay on auth page, user can still log in
  }
}

/* ─────────────────────────────────────────
   SIGN IN
───────────────────────────────────────── */
async function handleLogin() {
  const email    = document.getElementById("loginEmail")?.value?.trim()  || "";
  const password = document.getElementById("loginPassword")?.value       || "";
  if (!email || !password) { showMsg("Please enter your email and password"); return; }

  setLoading("loginBtn", true, "Sign In");
  hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/login", {
      method: "POST",
      body:   JSON.stringify({ email, password }),
    });
    if (ok && data.token) {
      await storeSession(data.token, data.user);
      showMsg("Welcome back! Redirecting…", "success");
      setTimeout(goToDashboard, 700);
    } else {
      showMsg(data.error || "Incorrect email or password");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("loginBtn", false, "Sign In");
  }
}

/* ─────────────────────────────────────────
   SIGN UP
───────────────────────────────────────── */
async function handleSignup() {
  const name     = document.getElementById("signupName")?.value?.trim()   || "";
  const email    = document.getElementById("signupEmail")?.value?.trim()  || "";
  const password = document.getElementById("signupPassword")?.value       || "";

  if (!email)              { showMsg("Email is required"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showMsg("Enter a valid email"); return; }
  if (!password)           { showMsg("Password is required"); return; }
  if (password.length < 8) { showMsg("Password must be at least 8 characters"); return; }

  setLoading("signupBtn", true, "Create Account");
  hideMsg();
  try {
    const { ok, status, data } = await apiFetch("/auth/signup", {
      method: "POST",
      body:   JSON.stringify({ email, password, name }),
    });
    if (ok && data.token) {
      await storeSession(data.token, data.user);
      showMsg("✅ Account created! Redirecting…", "success");
      setTimeout(goToDashboard, data.user?.isVerified ? 800 : 2000);
    } else if (status === 409) {
      showMsg("An account with this email already exists. Sign in instead.");
      setTimeout(() => switchTab("login"), 1800);
    } else {
      showMsg(data.error || "Sign up failed — please try again");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("signupBtn", false, "Create Account");
  }
}

/* ─────────────────────────────────────────
   GOOGLE SIGN IN
───────────────────────────────────────── */
let _identityAvailable = null;

async function handleGoogleSignIn() {
  hideMsg();
  const btn = document.getElementById("googleBtn");
  if (!btn || btn.disabled) return;

  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner muted"></span><span>Signing in…</span>`;

  if (_identityAvailable === null) {
    _identityAvailable = await probeIdentity();
  }

  try {
    if (_identityAvailable) {
      await googleSignInViaIdentity();
    } else {
      await googleSignInViaWebPopup();
    }
  } catch (err) {
    showMsg(err.message || "Google sign-in failed. Please use email and password.");
    _resetGoogleBtn();
  }
}

function _resetGoogleBtn() {
  const btn = document.getElementById("googleBtn");
  if (!btn) return;
  btn.disabled  = false;
  btn.innerHTML = `<img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
    alt="Google" style="width:18px;height:18px;flex-shrink:0;" />
    <span id="googleBtnLabel">Continue with Google</span>`;
}

/* PATH A — chrome.identity */
async function googleSignInViaIdentity() {
  const result = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GOOGLE_AUTH" }, response => {
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
    return;
  }

  const errMsg = result.error || "";
  if (errMsg.toLowerCase().includes("not supported") ||
      errMsg.toLowerCase().includes("unsupported")) {
    _identityAvailable = false;
    _resetGoogleBtn();
    await googleSignInViaWebPopup();
  } else {
    throw new Error(errMsg || "Google sign-in failed. Try email/password instead.");
  }
}

/* PATH B — web OAuth popup (works on all browsers including non-Chrome) */
async function googleSignInViaWebPopup() {
  const popupUrl = `${AUTH_API}/auth/google/popup`;
  const pw = 480, ph = 600;
  const pl = Math.round(screen.width  / 2 - pw / 2);
  const pt = Math.round(screen.height / 2 - ph / 2);

  const popup = window.open(
    popupUrl, "ft_google_auth",
    `width=${pw},height=${ph},left=${pl},top=${pt},toolbar=no,menubar=no,location=no,scrollbars=yes`
  );

  if (!popup || popup.closed) {
    throw new Error("Popup was blocked. Allow popups for this extension and try again.");
  }

  showMsg("Complete Google sign-in in the popup window…", "info");

  return new Promise((resolve, reject) => {
    let settled = false;

    function finish(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(pollId);
      window.removeEventListener("message", onMessage);
      try { popup.close(); } catch {}
      fn();
    }

    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error("Google sign-in timed out. Please try again.")));
    }, 120_000);

    const pollId = setInterval(() => {
      if (!popup.closed) return;
      // User manually closed popup — restore button silently
      finish(() => {
        hideMsg();
        _resetGoogleBtn();
        resolve(); // not an error — user chose to close
      });
    }, 400);

    async function onMessage(ev) {
      if (!ev.data || ev.data.type !== "FOCUS_TRACKER_AUTH") return;

      const { token, user, error } = ev.data;

      if (token) {
        // ── CRITICAL FIX ──
        // storeSession THEN redirect inside finish() callback.
        // Previously storeSession ran after finish() cleared listeners,
        // causing the popup close poll to fire first and resolve() early,
        // then storeSession wrote storage after goToDashboard() already ran,
        // so checkExistingSession() on the dashboard found no token and
        // bounced back to auth page.
        finish(async () => {
          try {
            await storeSession(token, user);
            hideMsg();
            showMsg("Welcome! Redirecting…", "success");
            setTimeout(goToDashboard, 700);
            resolve();
          } catch (e) {
            reject(new Error("Failed to save session. Please try again."));
          }
        });
      } else {
        finish(() => reject(new Error(error || "Google sign-in failed. Please try again.")));
      }
    }

    window.addEventListener("message", onMessage);
  });
}

/* ─────────────────────────────────────────
   FORGOT PASSWORD
───────────────────────────────────────── */
let _forgotEmailCache = "";

async function handleSendOtp() {
  const email = document.getElementById("forgotEmail")?.value?.trim() || "";
  if (!email) { showMsg("Please enter your email address"); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showMsg("Enter a valid email address");
    return;
  }

  setLoading("sendOtpBtn", true, "Send Reset Code");
  hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/forgot-password", {
      method: "POST",
      body:   JSON.stringify({ email }),
    });
    if (ok) {
      _forgotEmailCache = email;
      showMsg("Reset code sent! Check your inbox and spam folder.", "success");
      setTimeout(() => {
        hideMsg();
        document.getElementById("forgotStep1").style.display = "none";
        document.getElementById("forgotStep2").style.display = "";
      }, 1200);
    } else {
      showMsg(data.error || "Failed to send reset email. Please try again.");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("sendOtpBtn", false, "Send Reset Code");
  }
}

async function handleResetPassword() {
  const otp         = document.getElementById("otpInput")?.value?.trim()  || "";
  const newPassword = document.getElementById("newPassword")?.value       || "";

  if (!otp || !/^\d{6}$/.test(otp)) { showMsg("Enter the 6-digit code from your email"); return; }
  if (!newPassword || newPassword.length < 8) { showMsg("New password must be at least 8 characters"); return; }

  setLoading("resetBtn", true, "Reset Password");
  hideMsg();
  try {
    const { ok, data } = await apiFetch("/auth/reset-password", {
      method: "POST",
      body:   JSON.stringify({ email: _forgotEmailCache, otp, newPassword }),
    });
    if (ok) {
      showMsg("✅ Password reset! You can now sign in.", "success");
      setTimeout(() => {
        showMain();
        switchTab("login");
        const el = document.getElementById("loginEmail");
        if (el) el.value = _forgotEmailCache;
      }, 1400);
    } else {
      showMsg(data.error || "Reset failed. Check your code and try again.");
    }
  } catch (err) {
    showMsg(err.message);
  } finally {
    setLoading("resetBtn", false, "Reset Password");
  }
}

/* ─────────────────────────────────────────
   BOOT
───────────────────────────────────────── */
document.addEventListener("DOMContentLoaded", async () => {

  // 1. Apply theme before anything renders
  applyStoredTheme();

  // 2. Tabs
  document.getElementById("tabLogin") ?.addEventListener("click", () => switchTab("login"));
  document.getElementById("tabSignup")?.addEventListener("click", () => switchTab("signup"));

  // 3. Forgot / back
  document.getElementById("forgotLink")    ?.addEventListener("click", showForgot);
  document.getElementById("backToLoginBtn")?.addEventListener("click", showMain);

  // 4. Auth actions
  document.getElementById("loginBtn") ?.addEventListener("click", handleLogin);
  document.getElementById("signupBtn")?.addEventListener("click", handleSignup);
  document.getElementById("googleBtn")?.addEventListener("click", handleGoogleSignIn);
  document.getElementById("sendOtpBtn")?.addEventListener("click", handleSendOtp);
  document.getElementById("resetBtn")  ?.addEventListener("click", handleResetPassword);
  document.getElementById("resendBtn") ?.addEventListener("click", handleSendOtp);

  // 5. OTP — digits only, auto-submit on 6
  document.getElementById("otpInput")?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    if (e.target.value.length === 6) handleResetPassword();
  });

  // 6. Password strength
  initPasswordStrength();

  // 7. Enter key
  const enterMap = {
    loginEmail:     handleLogin,
    loginPassword:  handleLogin,
    signupName:     handleSignup,
    signupEmail:    handleSignup,
    signupPassword: handleSignup,
    forgotEmail:    handleSendOtp,
    newPassword:    handleResetPassword,
  };
  for (const [id, fn] of Object.entries(enterMap)) {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); fn(); }
    });
  }

  // 8. Probe Google identity (background — doesn't block page load)
  probeIdentity().then(works => {
    _identityAvailable = works;
    const hint = document.getElementById("googleHint");
    if (hint) hint.textContent = works ? "" : "Opens a secure Google sign-in window";
  });

  // 9. Auto-login — must be last so all handlers are wired first
  await checkExistingSession().catch(() => { /* stay on page */ });
});