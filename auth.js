const API_BASE = "http://localhost:5000";

// ==================== UTILITY FUNCTIONS ====================

function showSection(sectionId) {
  document.querySelectorAll(".auth-section").forEach(section => {
    section.classList.add("hidden");
  });
  document.getElementById(sectionId).classList.remove("hidden");
}

function showLoading(show = true) {
  const overlay = document.getElementById("loadingOverlay");
  if (show) {
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

function showError(message) {
  const errorEl = document.getElementById("errorMessage");
  errorEl.textContent = message;
  errorEl.classList.remove("hidden");
  
  setTimeout(() => {
    errorEl.classList.add("hidden");
  }, 5000);
}

function showSuccess(message) {
  const successEl = document.getElementById("successMessage");
  successEl.textContent = message;
  successEl.classList.remove("hidden");
  
  setTimeout(() => {
    successEl.classList.add("hidden");
  }, 5000);
}

async function storeToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ 
      authToken: token,
      lastValidated: new Date().toISOString().split("T")[0]
    }, resolve);
  });
}

async function getStoredToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken", "lastValidated"], (data) => {
      resolve(data);
    });
  });
}

async function clearStoredToken() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["authToken", "lastValidated"], resolve);
  });
}

// ==================== DAILY VALIDATION CHECK ====================

async function checkDailyValidation() {
  const { authToken, lastValidated } = await getStoredToken();
  const today = new Date().toISOString().split("T")[0];
  
  // If no token stored, show login
  if (!authToken) {
    showSection("loginSection");
    return false;
  }
  
  // If already validated today, proceed to dashboard
  if (lastValidated === today) {
    openDashboard();
    return true;
  }
  
  // Need to validate token for today
  showSection("loginSection");
  document.getElementById("loginToken").value = authToken;
  return false;
}

// ==================== VALIDATE TOKEN ====================

async function validateToken(token) {
  showLoading(true);
  
  try {
    const response = await fetch(`${API_BASE}/auth/validate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    
    const data = await response.json();
    showLoading(false);
    
    if (response.ok && data.valid) {
      await storeToken(token);
      showSuccess("Token validated successfully!");
      
      setTimeout(() => {
        openDashboard();
      }, 1000);
      
      return true;
    } else {
      showError(data.error || "Invalid token");
      await clearStoredToken();
      return false;
    }
  } catch (error) {
    showLoading(false);
    showError("Network error. Please check if the server is running.");
    return false;
  }
}

// ==================== ACTIVATE NEW TOKEN ====================

async function activateNewToken(email) {
  showLoading(true);
  
  try {
    const response = await fetch(`${API_BASE}/auth/activate-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email || null })
    });
    
    const data = await response.json();
    showLoading(false);
    
    if (response.ok && data.token) {
      // Display the generated token
      document.getElementById("generatedToken").textContent = data.token;
      showSection("tokenDisplaySection");
      
      // Store token temporarily (will be stored permanently when user clicks Continue)
      window.tempToken = data.token;
      
      return true;
    } else {
      showError(data.error || "Failed to generate token");
      return false;
    }
  } catch (error) {
    showLoading(false);
    showError("Network error. Please check if the server is running.");
    return false;
  }
}

// ==================== REQUEST OTP ====================

async function requestOTP(email) {
  showLoading(true);
  
  try {
    const response = await fetch(`${API_BASE}/auth/request-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    showLoading(false);
    
    if (response.ok && data.success) {
      // Show OTP verification form
      document.getElementById("requestOtpForm").classList.add("hidden");
      document.getElementById("verifyOtpForm").classList.remove("hidden");
      
      // Store email for verification
      window.recoveryEmail = email;
      
      return true;
    } else {
      showError(data.error || "Failed to send OTP");
      return false;
    }
  } catch (error) {
    showLoading(false);
    showError("Network error. Please check if the server is running.");
    return false;
  }
}

// ==================== VERIFY OTP ====================

async function verifyOTP(email, otp) {
  showLoading(true);
  
  try {
    const response = await fetch(`${API_BASE}/auth/verify-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp })
    });
    
    const data = await response.json();
    showLoading(false);
    
    if (response.ok && data.token) {
      // Display the new token
      document.getElementById("generatedToken").textContent = data.token;
      
      // Show token display section
      showSection("tokenDisplaySection");
      
      // Store token temporarily
      window.tempToken = data.token;
      
      return true;
    } else {
      showError(data.error || "Invalid OTP");
      return false;
    }
  } catch (error) {
    showLoading(false);
    showError("Network error. Please check if the server is running.");
    return false;
  }
}

// ==================== OPEN DASHBOARD ====================

function openDashboard() {
  window.location.href = "dashboard.html";
}

// ==================== EVENT LISTENERS ====================

document.addEventListener("DOMContentLoaded", () => {
  // Check if user needs to validate today
  checkDailyValidation();
  
  // ============ LOGIN SECTION ============
  
  document.getElementById("validateTokenBtn").addEventListener("click", async () => {
    const token = document.getElementById("loginToken").value.trim();
    
    if (!token) {
      showError("Please enter your access token");
      return;
    }
    
    if (token.length !== 64) {
      showError("Token must be exactly 64 characters");
      return;
    }
    
    await validateToken(token);
  });
  
  // Allow Enter key to validate
  document.getElementById("loginToken").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("validateTokenBtn").click();
    }
  });
  
  document.getElementById("showActivateBtn").addEventListener("click", () => {
    showSection("activateSection");
  });
  
  document.getElementById("showForgotBtn").addEventListener("click", () => {
    showSection("forgotSection");
  });
  
  // ============ ACTIVATE SECTION ============
  
  document.getElementById("activateTokenBtn").addEventListener("click", async () => {
    const email = document.getElementById("activateEmail").value.trim();
    
    // Email is optional, but validate if provided
    if (email && !email.includes("@")) {
      showError("Please enter a valid email address");
      return;
    }
    
    await activateNewToken(email);
  });
  
  document.getElementById("backToLoginBtn").addEventListener("click", () => {
    showSection("loginSection");
  });
  
  // ============ TOKEN DISPLAY SECTION ============
  
  document.getElementById("copyTokenBtn").addEventListener("click", () => {
    const token = document.getElementById("generatedToken").textContent;
    
    navigator.clipboard.writeText(token).then(() => {
      showSuccess("Token copied to clipboard!");
      
      // Change button text temporarily
      const btn = document.getElementById("copyTokenBtn");
      const originalText = btn.textContent;
      btn.textContent = "✅ Copied!";
      
      setTimeout(() => {
        btn.textContent = originalText;
      }, 2000);
    }).catch(() => {
      showError("Failed to copy. Please copy manually.");
    });
  });
  
  document.getElementById("continueBtn").addEventListener("click", async () => {
    if (window.tempToken) {
      await storeToken(window.tempToken);
      delete window.tempToken;
      openDashboard();
    }
  });
  
  // ============ FORGOT TOKEN SECTION ============
  
  document.getElementById("requestOtpBtn").addEventListener("click", async () => {
    const email = document.getElementById("recoveryEmail").value.trim();
    
    if (!email || !email.includes("@")) {
      showError("Please enter a valid email address");
      return;
    }
    
    await requestOTP(email);
  });
  
  document.getElementById("verifyOtpBtn").addEventListener("click", async () => {
    const otp = document.getElementById("otpInput").value.trim();
    
    if (!otp || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
      showError("Please enter a valid 6-digit OTP");
      return;
    }
    
    if (!window.recoveryEmail) {
      showError("Session expired. Please request OTP again.");
      return;
    }
    
    await verifyOTP(window.recoveryEmail, otp);
  });
  
  // Allow Enter key for OTP
  document.getElementById("otpInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("verifyOtpBtn").click();
    }
  });
  
  // Auto-format OTP input (numbers only)
  document.getElementById("otpInput").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });
  
  document.getElementById("resendOtpBtn").addEventListener("click", async () => {
    if (window.recoveryEmail) {
      await requestOTP(window.recoveryEmail);
      showSuccess("OTP resent to your email");
    }
  });
  
  document.getElementById("backToLoginFromForgot").addEventListener("click", () => {
    // Reset forgot section
    document.getElementById("requestOtpForm").classList.remove("hidden");
    document.getElementById("verifyOtpForm").classList.add("hidden");
    document.getElementById("recoveryEmail").value = "";
    document.getElementById("otpInput").value = "";
    delete window.recoveryEmail;
    
    showSection("loginSection");
  });
});