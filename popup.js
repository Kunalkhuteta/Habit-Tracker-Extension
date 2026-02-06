// Load quick stats
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
        const time = entry.time || 0;
        const category = entry.category || "Other";
        categoryTime[category] += time;
      }
      
      const totalTime = Object.values(categoryTime).reduce((a, b) => a + b, 0);
      const productive = (categoryTime.Learning || 0) + (categoryTime.Development || 0);
      const negative = categoryTime.Distraction || 0;
      const total = productive + negative;
      const productivity = total === 0 ? 0 : Math.round((productive / total) * 100);
      
      document.getElementById("productivityScore").textContent = productivity;
      document.getElementById("totalTime").textContent = formatTime(totalTime);
    });
  }
  
  function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return "0m";
  }
  
  function updateFocusButtons(isOn, locked = false) {
    const startBtn = document.getElementById("startFocus");
    const stopBtn = document.getElementById("stopFocus");
    const focusBtn = document.getElementById("focusBtn");
    const statusInd = document.getElementById("statusIndicator");
    
    startBtn.disabled = isOn;
    stopBtn.disabled = !isOn || locked;
    
    focusBtn.textContent = locked ? "FOCUS LOCKED" : 
                           isOn ? "FOCUS MODE ON" : "FOCUS MODE OFF";
    
    if (isOn) {
      statusInd.classList.add("active");
    } else {
      statusInd.classList.remove("active");
    }
  }
  
  document.addEventListener("DOMContentLoaded", () => {
    loadQuickStats();
    
    // Start Focus
    document.getElementById("startFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "FOCUS_ON",
        duration: 25,
        hard: false
      });
    });
  
    // Hard Focus
    document.getElementById("hardFocus").addEventListener("click", () => {
      const input = prompt("Hard Focus duration (minutes, min 5):", "25");
      const minutes = parseInt(input, 10);
  
      if (isNaN(minutes) || minutes < 5) {
        alert("Minimum hard focus time is 5 minutes");
        return;
      }
  
      chrome.runtime.sendMessage({
        type: "FOCUS_ON",
        duration: minutes,
        hard: true
      });
    });
  
    // Stop Focus
    document.getElementById("stopFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_OFF" });
    });
  
    // Open Dashboard
    document.getElementById("openDashboard").addEventListener("click", () => {
      chrome.windows.create({
        url: chrome.runtime.getURL("dashboard.html"),
        type: "popup",
        width: 1400,
        height: 900
      });
    });
  
    // Get initial status
    chrome.runtime.sendMessage(
      { type: "GET_FOCUS_STATUS" },
      res => updateFocusButtons(res?.status, res?.locked)
    );
  
    // Listen for changes
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.focusMode || changes.focusLockUntil)) {
        chrome.runtime.sendMessage(
          { type: "GET_FOCUS_STATUS" },
          res => updateFocusButtons(res?.status, res?.locked)
        );
      }
    });
  });