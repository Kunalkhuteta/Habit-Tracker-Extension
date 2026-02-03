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

let lastBlockedTab = null;
let lastBlockedUrl = null;


// /* =========================================================
//    BLOCKING RULES
// ========================================================= */
// const BLOCK_RULE_IDS = [1, 2];

// const BLOCK_RULES = [
//   {
//   id: 1,
//   priority: 1,
//   action: { type: "block" },
//   condition: {
//     urlFilter: "||youtube.com/",
//     resourceTypes: ["main_frame"]
//   }
// },
// {
//   id: 2,
//   priority: 1,
//   action: { type: "block" },
//   condition: {
//     urlFilter: "||github.com/",
//     resourceTypes: ["main_frame"]
//   }
// }
// ];

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
  if (!tabs || !tabs.length) return;
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



chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  // If user is redirected to blocked.html
  if (changeInfo.url.includes("blocked.html")) {
    // Save the last attempted URL
    if (tab.pendingUrl) {
      chrome.storage.local.set({
        lastBlockedUrl: tab.pendingUrl
      });
    }
  }
});

const FOCUS_RULE_IDS = [1001, 1002];

function enableBlocking() {
  const rules = [
    {
      id: 1001,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html" }
      },
      condition: {
        urlFilter: "||youtube.com^",
        resourceTypes: ["main_frame"]
      }
    },
    {
      id: 1002,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html" }
      },
      condition: {
        urlFilter: "||instagram.com^",
        resourceTypes: ["main_frame"]
      }
    }
  ];

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: FOCUS_RULE_IDS,
    addRules: rules
  });
}

function disableBlocking() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: FOCUS_RULE_IDS
  });
}

async function enableBlockingFromServer() {
  // Only apply rules if focus mode is active
  chrome.storage.local.get(["focusMode"], async (res) => {
    if (!res.focusMode) {
      console.log("Focus Mode is OFF — skipping applyBlockedSites");
      return;
    }

    try {
      const response = await fetch("http://localhost:5000/blocked-sites");
      const blockedSites = await response.json();

      const BASE_RULE_ID = 1000;
      const MAX_RULES = 100;

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

      const removeIds = [];
      for (let i = 0; i < MAX_RULES; i++) removeIds.push(BASE_RULE_ID + i);

      chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: removeIds,
        addRules: rules
      });

      console.log("Blocking rules updated from server:", blockedSites);
    } catch (err) {
      console.error("Failed to fetch blocked sites:", err);
    }
  });
}

function isBlockedUrl(url, blockedSites) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return blockedSites.some(site => hostname === site || hostname.endsWith("." + site));
  } catch {
    return false;
  }
}

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

  // ✅ Apply blocking rules
  await applyBlockedSitesRulesIfFocusOn();

  updateBadge();
  notify(`Focus Mode ON • ${durationMinutes} min`);

  // 🔥 RELOAD ALL NORMAL TABS
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

  // ✅ ONLY remove rules — NO reload
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
    // Normal focus: instantly toggle ON
    if (!msg.hard) {
      startFocus(msg.duration || 25, false);
    } else {
      // Hard focus: require duration and lock buttons
      if (!msg.duration || msg.duration < 5) msg.duration = 25;
      startFocus(msg.duration, true);
    }

    return ;
  }

  if (msg.type === "FOCUS_OFF") {
    stopFocus(false);
    return ;

  }

  if (msg.type === "GET_FOCUS_STATUS") {
    sendResponse({
      status: focusModeOn,
      locked: hardFocusActive && now < focusLockUntil,
      remaining: Math.max(0, focusLockUntil - now)
    });
  }
  if (msg.type === "ADD_BLOCK_SITE") {
    await fetch("http://localhost:5000/blocked-sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: msg.site })
    });

    // ✅ Apply rules ONLY if focus mode is ON
    await applyBlockedSitesRulesIfFocusOn();

    sendResponse({ success: true });
    return;
  }
})();

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

const BASE_RULE_ID = 1000;
const MAX_RULES = 100;

// Fetch blocked sites from backend
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

