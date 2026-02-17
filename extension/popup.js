/* =========================================================
   popup.js — Extension popup (clicks on icon)
========================================================= */

function formatTime(ms) {
  if (!ms || ms <= 0) return "0m";
  const minutes = Math.floor(ms / 60000);
  const hours   = Math.floor(minutes / 60);
  if (hours > 0)   return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function loadQuickStats() {
  chrome.storage.local.get(["timeData"], (res) => {
    const today     = new Date().toISOString().split("T")[0];
    const todayData = res.timeData?.[today] || {};

    const categoryTime = { Learning: 0, Distraction: 0, Development: 0, Other: 0 };

    for (const site in todayData) {
      const entry    = todayData[site];
      const time     = typeof entry === "number" ? entry : (entry.time || 0);
      const category = (typeof entry === "object" && entry.category) ? entry.category : "Other";
      categoryTime[category] = (categoryTime[category] || 0) + time;
    }

    const totalTime  = Object.values(categoryTime).reduce((a, b) => a + b, 0);
    const productive = (categoryTime.Learning || 0) + (categoryTime.Development || 0);
    const negative   = categoryTime.Distraction || 0;
    const total      = productive + negative;
    const score      = total === 0 ? 0 : Math.round((productive / total) * 100);

    document.getElementById("totalTime").textContent         = formatTime(totalTime);
    document.getElementById("productivityScore").textContent = score + "%";
  });
}

function updateFocusUI(isOn, locked = false, remainingMs = 0) {
  const startBtn   = document.getElementById("startFocus");
  const stopBtn    = document.getElementById("stopFocus");
  const focusBtn   = document.getElementById("focusBtn");
  const dot        = document.getElementById("statusIndicator");
  const dot2       = document.getElementById("statusIndicatorSmall");
  const lockBanner = document.getElementById("lockedBanner");

  startBtn.disabled = isOn;
  stopBtn.disabled  = !isOn || locked;

  if (locked) {
    const mins = Math.ceil(remainingMs / 60000);
    focusBtn.textContent = `🔒 LOCKED — ${mins}m left`;
  } else if (isOn) {
    focusBtn.textContent = "✅ FOCUS MODE ON";
  } else {
    focusBtn.textContent = "⭕ FOCUS MODE OFF";
  }

  [dot, dot2].forEach(d => {
    if (d) d.classList.toggle("active", isOn);
  });

  if (lockBanner) lockBanner.classList.toggle("show", locked);
}

function refreshFocusStatus() {
  chrome.runtime.sendMessage({ type: "GET_FOCUS_STATUS" }, (res) => {
    if (res) updateFocusUI(res.status, res.locked, res.remaining);
  });
}

document.addEventListener("DOMContentLoaded", () => {

  // Auth check — redirect to auth page if not logged in
  chrome.storage.local.get(["authToken"], (data) => {
    if (!data.authToken) {
      chrome.windows.create({
        url:    chrome.runtime.getURL("auth.html"),
        type:   "popup",
        width:  460,
        height: 620
      });
      window.close();
      return;
    }

    // Logged in — load stats and focus status
    loadQuickStats();
    refreshFocusStatus();

    // Start Focus (25 min soft)
    document.getElementById("startFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: "FOCUS_ON", duration: 25, hard: false },
        (res) => { if (res?.success) refreshFocusStatus(); }
      );
    });

    // Hard Focus
    document.getElementById("hardFocus").addEventListener("click", () => {
      const input   = prompt("Hard Focus — how many minutes? (min 5)", "25");
      const minutes = parseInt(input, 10);
      if (!input) return;
      if (isNaN(minutes) || minutes < 5) {
        alert("Minimum hard focus time is 5 minutes.");
        return;
      }
      chrome.runtime.sendMessage(
        { type: "FOCUS_ON", duration: minutes, hard: true },
        (res) => { if (res?.success) refreshFocusStatus(); }
      );
    });

    // Stop Focus
    document.getElementById("stopFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: "FOCUS_OFF" },
        (res) => { if (res?.success) refreshFocusStatus(); }
      );
    });

    // Open Dashboard in a large window
    document.getElementById("openDashboard").addEventListener("click", () => {
      chrome.windows.create({
        url:    chrome.runtime.getURL("dashboard.html"),
        type:   "popup",
        width:  1400,
        height: 900
      });
    });

    // Live update when focus state or time data changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        if (changes.focusMode || changes.focusLockUntil) refreshFocusStatus();
        if (changes.timeData) loadQuickStats();
      }
    });
  });
});