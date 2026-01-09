let currentDomain = null;
let isIdle = false;

/* ================= HELPERS ================= */

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function getCategory(domain) {
  if (!domain) return "Other";
  if (domain.includes("leetcode") || domain.includes("geeksforgeeks")) return "Learning";
  if (domain.includes("youtube") || domain.includes("instagram")) return "Distraction";
  if (domain.includes("github") || domain.includes("stackoverflow")) return "Development";
  return "Other";
}

/* ================= CORE TRACKING ================= */

/**
 * ⏱️ Called EVERY SECOND
 */
function trackOneSecond() {
  if (!currentDomain || isIdle) return;

  const today = getTodayKey();

  chrome.storage.local.get(["timeData"], res => {
    const timeData = res.timeData || {};

    if (!timeData[today]) timeData[today] = {};
    if (!timeData[today][currentDomain]) {
      timeData[today][currentDomain] = {
        time: 0,
        category: getCategory(currentDomain)
      };
    }

    // ✅ ADD EXACTLY 1 SECOND
    timeData[today][currentDomain].time += 1000;

    chrome.storage.local.set({ timeData });
  });
}

/* ================= HEARTBEAT ================= */

// 🔥 REAL TIME TRACKING (every second)
setInterval(trackOneSecond, 1000);

/* ================= TAB EVENTS ================= */

chrome.tabs.onActivated.addListener(info => {
  chrome.tabs.get(info.tabId, tab => {
    currentDomain = getDomain(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    currentDomain = getDomain(changeInfo.url);
  }
});

/* ================= IDLE HANDLING ================= */

chrome.idle.setDetectionInterval(60);

chrome.idle.onStateChanged.addListener(state => {
  isIdle = state !== "active";
});

/* ================= INITIAL TAB ================= */

chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
  if (tabs[0]?.url) {
    currentDomain = getDomain(tabs[0].url);
  }
});
