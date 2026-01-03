let currentDomain = null;
let startTime = null;
let isIdle = false;

// Idle detection
chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  isIdle = state !== "active";
});

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getCategory(domain) {
  if (!domain) return "Other";
  if (domain.includes("leetcode") || domain.includes("geeksforgeeks"))
    return "Learning";
  if (domain.includes("youtube") || domain.includes("instagram"))
    return "Distraction";
  if (domain.includes("github") || domain.includes("stackoverflow"))
    return "Development";
  return "Other";
}

// 🔒 SINGLE responsibility: save time
function saveCurrentTime() {
  if (!currentDomain || !startTime || isIdle) return;

  const now = Date.now();
  const timeSpent = now - startTime;

  chrome.storage.local.get(["timeData"], (res) => {
    const timeData = res.timeData || {};

    if (!timeData[currentDomain]) {
      timeData[currentDomain] = {
        time: 0,
        category: getCategory(currentDomain)
      };
    }

    timeData[currentDomain].time += timeSpent;
    chrome.storage.local.set({ timeData });
  });

  startTime = now;
}

// Tab switch
chrome.tabs.onActivated.addListener((activeInfo) => {
  saveCurrentTime();

  chrome.tabs.get(activeInfo.tabId, (tab) => {
    currentDomain = getDomain(tab.url);
    startTime = Date.now();
  });
});

// 🔴 MESSAGE HANDLER (NO DOM HERE)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "flushCurrentTab") {
    saveCurrentTime();
    sendResponse({ status: "ok" });
    return true; // keeps channel open safely
  }
});

console.log("Background service worker running (stable)");
