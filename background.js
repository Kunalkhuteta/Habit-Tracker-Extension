/* =========================================================
   GLOBAL STATE
========================================================= */
let currentDomain = null;
let isIdle = false;
let chromeFocused = true;
let bufferTime = {};

let focusModeOn = false;
let pomodoroTimer = null;
let focusLockUntil = 0;
let hardFocusActive = false;

const BASE_RULE_ID = 1000;
const MAX_RULES = 100;

// Category mappings from server
let categoryMappings = {};

/* =========================================================
   UTILS
========================================================= */
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

async function getCategory(domain) {
  if (!domain) return "Other";
  
  // Check server-synced categories first
  if (categoryMappings[domain]) {
    return categoryMappings[domain];
  }
  
  // Fallback to default categorization
  if (domain.includes("leetcode") || domain.includes("geeksforgeeks") || 
      domain.includes("coursera") || domain.includes("udemy")) {
    return "Learning";
  }
  if (domain.includes("youtube") || domain.includes("instagram") || 
      domain.includes("facebook") || domain.includes("twitter") || 
      domain.includes("reddit") || domain.includes("tiktok")) {
    return "Distraction";
  }
  if (domain.includes("github") || domain.includes("stackoverflow") || 
      domain.includes("dev.to") || domain.includes("medium")) {
    return "Development";
  }
  
  return "Other";
}

/* =========================================================
   TIME TRACKING
========================================================= */
function trackOneSecond() {
  if (!currentDomain || isIdle) return;
  bufferTime[currentDomain] = (bufferTime[currentDomain] || 0) + 1000;
}

async function flushBufferToStorage() {
  const today = getTodayKey();

  chrome.storage.local.get(["timeData"], async res => {
    const timeData = res.timeData || {};
    timeData[today] ??= {};

    for (const domain in bufferTime) {
      const category = await getCategory(domain);
      
      timeData[today][domain] ??= {
        time: 0,
        category: category
      };
      timeData[today][domain].time += bufferTime[domain];
      timeData[today][domain].category = category; // Update category
    }

    bufferTime = {};
    chrome.storage.local.set({ timeData });
  });
}

setInterval(trackOneSecond, 1000);
setInterval(flushBufferToStorage, 10000);

/* =========================================================
   CATEGORY SYNC FROM SERVER
========================================================= */
async function syncCategoriesFromServer() {
  try {
    const response = await fetch("http://localhost:5000/categories");
    const mappings = await response.json();
    
    categoryMappings = {};
    mappings.forEach(m => {
      categoryMappings[m.domain] = m.category;
    });
    
    console.log("✅ Categories synced:", categoryMappings);
  } catch (err) {
    console.error("❌ Failed to sync categories:", err);
  }
}

// Sync categories on startup and every hour
syncCategoriesFromServer();
setInterval(syncCategoriesFromServer, 3600000); // 1 hour

/* =========================================================
   TAB & IDLE EVENTS
========================================================= */
chrome.tabs.onActivated.addListener(info => {
  chrome.tabs.get(info.tabId, tab => {
    currentDomain = getDomain(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.url) {
    currentDomain = getDomain(changeInfo.url);
  }
});

chrome.windows.onFocusChanged.addListener(id => {
  chromeFocused = id !== chrome.windows.WINDOW_ID_NONE;
  isIdle = !chromeFocused;
});

chrome.idle.onStateChanged.addListener(state => {
  isIdle = state !== "active" || !chromeFocused;
});

chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
  if (!tabs || !tabs.length) return;
  if (tabs[0]?.url) currentDomain = getDomain(tabs[0].url);
});

/* =========================================================
   UI HELPERS
========================================================= */
function updateBadge() {
  chrome.action.setBadgeText({ text: focusModeOn ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title: "Focus Mode",
    message
  });
}

/* =========================================================
   BLOCKING LOGIC
========================================================= */
async function fetchBlockedSites() {
  try {
    const res = await fetch("http://localhost:5000/blocked-sites");
    const sites = await res.json();
    return sites || [];
  } catch (err) {
    console.error("Failed to fetch blocked sites:", err);
    return [];
  }
}

function removeAllBlockingRules() {
  const removeIds = Array.from(
    { length: MAX_RULES },
    (_, i) => BASE_RULE_ID + i
  );

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds
  });
}

async function applyBlockedSitesRulesIfFocusOn() {
  chrome.storage.local.get(["focusMode"], async (res) => {
    if (!res.focusMode) {
      removeAllBlockingRules();
      return;
    }

    const blockedSites = await fetchBlockedSites();

    const rules = blockedSites.slice(0, MAX_RULES).map((site, i) => ({
      id: BASE_RULE_ID + i,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html" }
      },
      condition: {
        urlFilter: `||${site}^`,
        resourceTypes: ["main_frame"]
      }
    }));

    const removeIds = Array.from(
      { length: MAX_RULES },
      (_, i) => BASE_RULE_ID + i
    );

    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules
    });
  });
}

function isBlockedUrl(url, blockedSites) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return blockedSites.some(site => 
      hostname === site || hostname.endsWith("." + site)
    );
  } catch {
    return false;
  }
}

/* =========================================================
   FOCUS MODE
========================================================= */
async function startFocus(durationMinutes = 25, hard = false) {
  const now = Date.now();
  const durationMs = Math.max(5, durationMinutes) * 60 * 1000;

  clearTimeout(pomodoroTimer);

  focusModeOn = true;
  hardFocusActive = hard;
  focusLockUntil = hard ? now + durationMs : 0;

  await chrome.storage.local.set({
    focusMode: true,
    focusLockUntil
  });

  await applyBlockedSitesRulesIfFocusOn();

  updateBadge();
  notify(`Focus Mode ON • ${durationMinutes} min`);

  // Reload blocked tabs
  chrome.tabs.query({ windowType: "normal" }, async (tabs) => {
    const blockedSites = await fetchBlockedSites();

    tabs.forEach(tab => {
      if (!tab.url || tab.url.startsWith("chrome://")) return;

      if (isBlockedUrl(tab.url, blockedSites)) {
        chrome.tabs.reload(tab.id);
      }
    });
  });

  if (hard) {
    pomodoroTimer = setTimeout(() => stopFocus(true), durationMs);
  }
}

function stopFocus(force = false) {
  const now = Date.now();

  if (!force && hardFocusActive && now < focusLockUntil) {
    notify("Hard focus active, cannot stop yet");
    return;
  }

  clearTimeout(pomodoroTimer);

  focusModeOn = false;
  hardFocusActive = false;
  focusLockUntil = 0;

  removeAllBlockingRules();

  chrome.storage.local.set({
    focusMode: false,
    focusLockUntil: 0
  });

  updateBadge();
  notify("Focus Mode OFF");
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const now = Date.now();

    if (msg.type === "FOCUS_ON") {
      if (!msg.hard) {
        await startFocus(msg.duration || 25, false);
      } else {
        if (!msg.duration || msg.duration < 5) msg.duration = 25;
        await startFocus(msg.duration, true);
      }
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "FOCUS_OFF") {
      stopFocus(false);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "GET_FOCUS_STATUS") {
      sendResponse({
        status: focusModeOn,
        locked: hardFocusActive && now < focusLockUntil,
        remaining: Math.max(0, focusLockUntil - now)
      });
      return;
    }

    if (msg.type === "ADD_BLOCK_SITE") {
      await fetch("http://localhost:5000/blocked-sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: msg.site })
      });

      await applyBlockedSitesRulesIfFocusOn();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "SYNC_CATEGORIES") {
      await syncCategoriesFromServer();
      sendResponse({ success: true });
      return;
    }
  })();

  return true;
});

/* =========================================================
   STARTUP SYNC
========================================================= */
chrome.runtime.onStartup.addListener(syncFocusState);
chrome.runtime.onInstalled.addListener(syncFocusState);

function syncFocusState() {
  chrome.storage.local.get(["focusMode", "focusLockUntil"], data => {
    const now = Date.now();

    if (data.focusMode) {
      const locked = data.focusLockUntil && data.focusLockUntil > now;
      startFocus(25, locked);
    } else {
      stopFocus(true);
    }
  });
  
  // Sync categories on startup
  syncCategoriesFromServer();
}