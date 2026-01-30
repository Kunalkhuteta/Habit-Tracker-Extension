/* =========================================================
   GLOBAL STATE (AUTHORITATIVE)
========================================================= */
let currentDomain = null;
let isIdle = false;
let chromeFocused = true;
let bufferTime = {};

let focusModeOn = false;
let pomodoroTimer = null;
let isWorkPeriod = true;

const workDuration = 25 * 60 * 1000;
const breakDuration = 5 * 60 * 1000;
let focusLockUntil = 0; // timestamp
let hardFocusActive = false; // new


/* =========================================================
   BLOCKING RULES
========================================================= */
const BLOCK_RULE_IDS = [1, 2];

const BLOCK_RULES = [
  {
  id: 1,
  priority: 1,
  action: { type: "block" },
  condition: {
    urlFilter: "||youtube.com/",
    resourceTypes: ["main_frame"]
  }
},
{
  id: 2,
  priority: 1,
  action: { type: "block" },
  condition: {
    urlFilter: "||instagram.com/",
    resourceTypes: ["main_frame"]
  }
}
];

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

function getCategory(domain) {
  if (!domain) return "Other";
  if (domain.includes("leetcode") || domain.includes("geeksforgeeks")) return "Learning";
  if (domain.includes("youtube") || domain.includes("instagram")) return "Distraction";
  if (domain.includes("github") || domain.includes("stackoverflow")) return "Development";
  return "Other";
}

/* =========================================================
   TIME TRACKING
========================================================= */
function trackOneSecond() {
  if (!currentDomain || isIdle) return;
  bufferTime[currentDomain] = (bufferTime[currentDomain] || 0) + 1000;
}

function flushBufferToStorage() {
  const today = getTodayKey();

  chrome.storage.local.get(["timeData"], res => {
    const timeData = res.timeData || {};
    timeData[today] ??= {};

    for (const domain in bufferTime) {
      timeData[today][domain] ??= {
        time: 0,
        category: getCategory(domain)
      };
      timeData[today][domain].time += bufferTime[domain];
    }

    bufferTime = {};
    chrome.storage.local.set({ timeData });
  });
}

setInterval(trackOneSecond, 1000);
setInterval(flushBufferToStorage, 10000);

/* =========================================================
   TAB & IDLE EVENTS
========================================================= */
chrome.tabs.onActivated.addListener(info => {
  chrome.tabs.get(info.tabId, tab => currentDomain = getDomain(tab.url));
});

chrome.tabs.onUpdated.addListener((_, changeInfo) => {
  if (changeInfo.url) currentDomain = getDomain(changeInfo.url);
});

chrome.windows.onFocusChanged.addListener(id => {
  chromeFocused = id !== chrome.windows.WINDOW_ID_NONE;
  isIdle = !chromeFocused;
});

chrome.idle.onStateChanged.addListener(state => {
  isIdle = state !== "active" || !chromeFocused;
});

chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
  if (tabs[0]?.url) currentDomain = getDomain(tabs[0].url);
});

/* =========================================================
   UI HELPERS
========================================================= */
function updateBadge() {
  chrome.action.setBadgeText({ text: focusModeOn ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "red" });
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
   BLOCKING CONTROL
========================================================= */
/* =========================
   DYNAMIC SITE BLOCKING
========================= */

function normalizeSite(site) {
  site = site.trim().toLowerCase();
  site = site.replace(/^https?:\/\//, ""); // remove protocol
  site = site.replace(/\/$/, "");          // remove trailing slash
  return site;
}

function applyBlockedSites(sites) {
  const rules = sites.map((site, i) => {
    const domain = normalizeSite(site);
    return {
      id: 1000 + i,
      priority: 1,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ["main_frame"]
      }
    };
  });

  // Remove old dynamic rules first
  chrome.declarativeNetRequest.getDynamicRules(existingRules => {
    const oldIds = existingRules.map(r => r.id);
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: oldIds,
      addRules: rules
    });
  });
}

/* =========================
   OVERRIDE ENABLE/DISABLE BLOCKING
========================= */

function enableBlocking() {
  chrome.storage.local.get(["blockedSites"], res => {
    const sites = res.blockedSites || [];
    applyBlockedSites(sites);
  });
}

function disableBlocking() {
  chrome.declarativeNetRequest.getDynamicRules(existingRules => {
    const oldIds = existingRules.map(r => r.id);
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds });
  });
}
/* =========================================================
   POMODORO ENGINE (ONLY HERE)
========================================================= */

function startFocus(durationMinutes = 25, hard = false) {
  const now = Date.now();
  const durationMs = Math.max(5, durationMinutes) * 60 * 1000;

  clearTimeout(pomodoroTimer);

  focusModeOn = true;
  hardFocusActive = hard;
  focusLockUntil = hard ? now + durationMs : 0;

  chrome.storage.local.set({
    focusMode: true,
    focusLockUntil
  });

  // ✅ Apply blocking for Focus Mode
  enableBlocking();
  updateBadge();
  notify(`Focus Mode ON • ${durationMinutes} min${hard ? " (HARD)" : ""}`);

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
  });

  if (hard) {
    pomodoroTimer = setTimeout(() => stopFocus(true), durationMs);
  }
}

function stopFocus(force = false) {
  const now = Date.now();
  if (!force && hardFocusActive && now < focusLockUntil) {
    notify("⛔ Hard focus active, cannot stop until time ends");
    return;
  }

  clearTimeout(pomodoroTimer);

  focusModeOn = false;
  hardFocusActive = false;
  focusLockUntil = 0;

  chrome.storage.local.set({
    focusMode: false,
    focusLockUntil: 0
  });

  // ✅ Remove dynamic blocking
  disableBlocking();
  updateBadge();
  notify("Focus Mode OFF");

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0]?.id) chrome.tabs.reload(tabs[0].id);
  });
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  const now = Date.now();

  if (msg.type === "FOCUS_ON") {
    // Normal focus: instantly toggle ON
    if (!msg.hard) {
      startFocus(msg.duration || 25, false);
    } else {
      // Hard focus: require duration and lock buttons
      if (!msg.duration || msg.duration < 5) msg.duration = 25;
      startFocus(msg.duration, true);
    }
  }

  if (msg.type === "FOCUS_OFF") {
    stopFocus(false);
  }

  if (msg.type === "GET_FOCUS_STATUS") {
    sendResponse({
      status: focusModeOn,
      locked: hardFocusActive && now < focusLockUntil,
      remaining: Math.max(0, focusLockUntil - now)
    });
  }

  return true;
});

/* =========================================================
   SYNC STATE ON STARTUP
========================================================= */
chrome.runtime.onStartup.addListener(syncFocusState);
chrome.runtime.onInstalled.addListener(syncFocusState);

function syncFocusState() {
  chrome.storage.local.get(["focusMode", "focusLockUntil"], data => {
    const now = Date.now();

    if (data.focusMode) {
      const locked = data.focusLockUntil && data.focusLockUntil > now;
      startFocus(25, locked); // restore last session
    } else {
      stopFocus(true);
    }
  });
} 