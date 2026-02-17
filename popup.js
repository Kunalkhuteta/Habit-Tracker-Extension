/* =========================================================
   POPUP.JS — Extension popup quick view
========================================================= */

function formatTime(ms) {
  if (!ms || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `<1m`;
}

function loadQuickStats() {
  chrome.storage.local.get(["timeData"], (res) => {
    const today = new Date().toISOString().split("T")[0];
    const todayData = res.timeData?.[today] || {};

    const categoryTime = {
      Learning: 0,
      Distraction: 0,
      Development: 0,
      Other: 0
    };

    for (const site in todayData) {
      const entry = todayData[site];
      // Support both old numeric format and new object format
      const time = typeof entry === "number" ? entry : (entry.time || 0);
      const category = (typeof entry === "object" && entry.category) ? entry.category : "Other";
      categoryTime[category] = (categoryTime[category] || 0) + time;
    }

    const totalTime = Object.values(categoryTime).reduce((a, b) => a + b, 0);
    const productive = (categoryTime.Learning || 0) + (categoryTime.Development || 0);
    const negative = categoryTime.Distraction || 0;
    const total = productive + negative;
    const productivity = total === 0 ? 0 : Math.round((productive / total) * 100);

    const scoreEl = document.getElementById("productivityScore");
    const timeEl = document.getElementById("totalTime");

    if (scoreEl) scoreEl.textContent = productivity;
    if (timeEl) timeEl.textContent = formatTime(totalTime);
  });
}

function updateFocusButtons(isOn, locked = false) {
  const startBtn = document.getElementById("startFocus");
  const stopBtn = document.getElementById("stopFocus");
  const focusBtn = document.getElementById("focusBtn");
  const statusInd = document.getElementById("statusIndicator");

  if (startBtn) startBtn.disabled = isOn;
  if (stopBtn) stopBtn.disabled = !isOn || locked;

  if (focusBtn) {
    focusBtn.textContent = locked ? "🔒 FOCUS LOCKED" :
      isOn ? "✅ FOCUS MODE ON" : "⭕ FOCUS MODE OFF";
  }

  if (statusInd) {
    statusInd.classList.toggle("active", isOn);
  }
}

document.addEventListener("DOMContentLoaded", () => {

  // BUG FIX: Check auth token before showing UI. If no token, redirect to auth page.
  chrome.storage.local.get(["authToken"], (data) => {
    if (!data.authToken) {
      // Open auth page if not logged in
      chrome.windows.create({
        url: chrome.runtime.getURL("auth.html"),
        type: "popup",
        width: 480,
        height: 600
      });
      window.close();
      return;
    }

    // User is authenticated — load popup normally
    loadQuickStats();

    // Start Focus
    document.getElementById("startFocus")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_ON", duration: 25, hard: false }, (res) => {
        if (res?.success) updateFocusButtons(true, false);
      });
    });

    // Hard Focus
    document.getElementById("hardFocus")?.addEventListener("click", () => {
      const input = prompt("Hard Focus duration (minutes, min 5):", "25");
      const minutes = parseInt(input, 10);

      if (isNaN(minutes) || minutes < 5) {
        alert("Minimum hard focus time is 5 minutes");
        return;
      }

      chrome.runtime.sendMessage({ type: "FOCUS_ON", duration: minutes, hard: true }, (res) => {
        if (res?.success) updateFocusButtons(true, true);
      });
    });

    // Stop Focus
    document.getElementById("stopFocus")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_OFF" }, (res) => {
        if (res?.success) updateFocusButtons(false, false);
      });
    });

    // Open Dashboard
    document.getElementById("openDashboard")?.addEventListener("click", () => {
      chrome.windows.create({
        url: chrome.runtime.getURL("dashboard.html"),
        type: "popup",
        width: 1400,
        height: 900
      });
    });

    // Get initial focus status
    chrome.runtime.sendMessage(
      { type: "GET_FOCUS_STATUS" },
      res => updateFocusButtons(res?.status, res?.locked)
    );

    // Live update when focus state changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.focusMode || changes.focusLockUntil)) {
        chrome.runtime.sendMessage(
          { type: "GET_FOCUS_STATUS" },
          res => updateFocusButtons(res?.status, res?.locked)
        );
        loadQuickStats();
      }
    });
  });
});