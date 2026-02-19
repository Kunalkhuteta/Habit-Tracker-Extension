/* =========================================================
   KEEPALIVE — Must be the very first thing that runs.
========================================================= */
const KEEPALIVE_ALARM = "focus-tracker-keepalive";
const HEARTBEAT_MS    = 20_000;
const ALARM_INTERVAL  = 0.4;

let _heartbeatTimer = null;

function startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    chrome.storage.local.set({ _sw_heartbeat: Date.now() });
  }, HEARTBEAT_MS);
}

async function registerKeepaliveAlarm() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      delayInMinutes: ALARM_INTERVAL,
      periodInMinutes: ALARM_INTERVAL
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    startHeartbeat();
    chrome.storage.local.set({ _sw_heartbeat: Date.now() });
  }
});

startHeartbeat();
registerKeepaliveAlarm();

/* =========================================================
   GLOBAL STATE
========================================================= */
let currentDomain  = null;
// FIX: Removed isIdle and chromeFocused entirely.
// We track ALL time while any site is active in the browser.
// No idle pause, no window focus requirement.
let bufferTime     = {};

let focusModeOn      = false;
let pomodoroTimer    = null;
let focusLockUntil   = 0;
let hardFocusActive  = false;

const BASE_RULE_ID = 1000;
const MAX_RULES    = 100;

let categoryMappings = {};
let authToken = null;

const BG_API_BASE = "https://habit-tracker-extension.onrender.com";

/* =========================================================
   UTILS
========================================================= */
function normalizeDomain(domain) {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0];
}

function getDomain(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

function getCategory(domain) {
  if (!domain) return "Other";
  const normalized = normalizeDomain(domain);
  if (categoryMappings[normalized]) return categoryMappings[normalized];
  const parts = normalized.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (categoryMappings[parent]) return categoryMappings[parent];
  }
  if (categoryMappings[parts[0]]) return categoryMappings[parts[0]];
  if (/leetcode|geeksforgeeks|coursera|udemy|khanacademy|edx|pluralsight/.test(normalized)) return "Learning";
  if (/youtube|instagram|facebook|twitter|reddit|tiktok|netflix|twitch/.test(normalized)) return "Distraction";
  if (/github|stackoverflow|dev\.to|medium|docs\.|mdn|npmjs/.test(normalized)) return "Development";
  return "Other";
}

/* =========================================================
   AUTHENTICATION
========================================================= */
async function loadAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken"], (data) => {
      authToken = data.authToken || null;
      resolve(authToken);
    });
  });
}

function getAuthHeaders() {
  if (!authToken) return { "Content-Type": "application/json" };
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`
  };
}

/* =========================================================
   TIME TRACKING

   FIX: trackOneSecond no longer checks isIdle or chromeFocused.
   Time accumulates for currentDomain every second, period.
   This means: open laptop, chrome open on claude.ai = time tracked.
========================================================= */
function trackOneSecond() {
  if (!currentDomain) return;
  // Skip internal browser pages
  if (!currentDomain || currentDomain.length < 2) return;
  bufferTime[currentDomain] = (bufferTime[currentDomain] || 0) + 1000;
}

async function flushBufferToStorage() {
  if (Object.keys(bufferTime).length === 0) return;

  const today    = getTodayKey();
  const captured = { ...bufferTime };
  bufferTime     = {};

  const timeData = await new Promise((resolve) => {
    chrome.storage.local.get(["timeData"], (res) => resolve(res.timeData || {}));
  });

  timeData[today] = timeData[today] || {};

  for (const domain in captured) {
    const category = getCategory(domain);
    if (!timeData[today][domain]) {
      timeData[today][domain] = { time: 0, category };
    }
    timeData[today][domain].time     += captured[domain];
    timeData[today][domain].category  = category;
  }

  chrome.storage.local.set({ timeData });
}

setInterval(trackOneSecond, 1000);
setInterval(flushBufferToStorage, 3000);

/* =========================================================
   CATEGORY SYNC FROM SERVER
   FIX: Uses /categories (correct endpoint matching server.js)
========================================================= */
async function syncCategoriesFromServer() {
  const token = await loadAuthToken();
  if (!token) return;
  try {
    const response = await fetch(`${BG_API_BASE}/categories`, {
      headers: getAuthHeaders()
    });
    if (!response.ok) return;
    const mappings = await response.json();
    categoryMappings = {};
    if (Array.isArray(mappings)) {
      mappings.forEach((m) => {
        if (m.domain && m.category) {
          categoryMappings[normalizeDomain(m.domain)] = m.category;
        }
      });
    }
    console.log("Categories synced:", Object.keys(categoryMappings).length);
  } catch (err) {
    console.error("Failed to sync categories:", err);
  }
}

loadAuthToken().then(() => {
  syncCategoriesFromServer();
  setInterval(syncCategoriesFromServer, 1800000);
});

/* =========================================================
   TAB & WINDOW EVENTS

   FIX: Window focus changes do NOT stop tracking.
   We only update currentDomain, never pause counting.
========================================================= */
chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs.get(info.tabId, (tab) => {
    if (chrome.runtime.lastError) return;
    if (tab && tab.url) {
      const d = getDomain(tab.url);
      if (d) currentDomain = d;
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      if (tabs && tabs[0] && tabs[0].id === tabId) {
        const d = getDomain(tab.url || tabs[0].url);
        if (d) currentDomain = d;
      }
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  // FIX: Only update currentDomain. Never pause tracking.
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs && tabs[0] && tabs[0].url) {
      const d = getDomain(tabs[0].url);
      if (d) currentDomain = d;
    }
  });
});

// FIX: chrome.idle.onStateChanged listener REMOVED.
// We no longer pause on idle. Track everything.

// Set initial active tab
chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
  if (chrome.runtime.lastError) return;
  if (tabs && tabs[0] && tabs[0].url) {
    const d = getDomain(tabs[0].url);
    if (d) currentDomain = d;
  }
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
  const token = await loadAuthToken();
  if (!token) return [];
  try {
    const res = await fetch(`${BG_API_BASE}/blocked-sites`, { headers: getAuthHeaders() });
    if (!res.ok) return [];
    const sites = await res.json();
    return Array.isArray(sites) ? sites : [];
  } catch {
    return [];
  }
}

function removeAllBlockingRules() {
  const removeIds = Array.from({ length: MAX_RULES }, (_, i) => BASE_RULE_ID + i);
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
}

async function applyBlockedSitesRulesIfFocusOn() {
  const focusData = await new Promise((resolve) => {
    chrome.storage.local.get(["focusMode"], resolve);
  });
  if (!focusData.focusMode) { removeAllBlockingRules(); return; }
  const blockedSites = await fetchBlockedSites();
  const rules = blockedSites.slice(0, MAX_RULES).map((site, i) => ({
    id: BASE_RULE_ID + i,
    priority: 1,
    action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
    condition: { urlFilter: `||${site}^`, resourceTypes: ["main_frame"] }
  }));
  const removeIds = Array.from({ length: MAX_RULES }, (_, i) => BASE_RULE_ID + i);
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
}

function isBlockedUrl(url, blockedSites) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return blockedSites.some(site => hostname === site || hostname.endsWith("." + site));
  } catch { return false; }
}

/* =========================================================
   FOCUS MODE
========================================================= */
async function startFocus(durationMinutes = 25, hard = false) {
  const now        = Date.now();
  const durationMs = Math.max(5, durationMinutes) * 60 * 1000;
  clearTimeout(pomodoroTimer);
  focusModeOn     = true;
  hardFocusActive = hard;
  focusLockUntil  = hard ? now + durationMs : 0;
  await chrome.storage.local.set({ focusMode: true, focusLockUntil });
  await applyBlockedSitesRulesIfFocusOn();
  updateBadge();
  notify(`Focus Mode ON • ${durationMinutes} min`);
  chrome.tabs.query({ windowType: "normal" }, async (tabs) => {
    const blockedSites = await fetchBlockedSites();
    tabs.forEach((tab) => {
      if (!tab.url || tab.url.startsWith("chrome://")) return;
      if (isBlockedUrl(tab.url, blockedSites)) chrome.tabs.reload(tab.id);
    });
  });
  if (hard) pomodoroTimer = setTimeout(() => stopFocus(true), durationMs);
}

function stopFocus(force = false) {
  const now = Date.now();
  if (!force && hardFocusActive && now < focusLockUntil) { notify("Hard focus active — cannot stop yet"); return; }
  clearTimeout(pomodoroTimer);
  focusModeOn     = false;
  hardFocusActive = false;
  focusLockUntil  = 0;
  removeAllBlockingRules();
  chrome.storage.local.set({ focusMode: false, focusLockUntil: 0 });
  updateBadge();
  notify("Focus Mode OFF");
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const now = Date.now();

    if (msg.type === "GOOGLE_AUTH") {
      try {
        if (!chrome.identity) { sendResponse({ success: false, error: "chrome.identity not available." }); return; }
        const accessToken = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!token) reject(new Error("No token returned"));
            else resolve(token);
          });
        });
        const res  = await fetch(`${BG_API_BASE}/auth/google`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.token) {
          await new Promise(r => chrome.storage.local.set({
            authToken: data.token, userInfo: data.user,
            lastValidated: new Date().toISOString().split("T")[0]
          }, r));
          await loadAuthToken();
          await syncCategoriesFromServer();
          sendResponse({ success: true, token: data.token, user: data.user });
        } else {
          sendResponse({ success: false, error: data.error || "Server rejected Google token" });
        }
      } catch (err) { sendResponse({ success: false, error: err.message }); }
      return;
    }

    if (msg.type === "GET_LIVE_TIME") {
      await flushBufferToStorage();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "FOCUS_ON") {
      await startFocus((!msg.duration || msg.duration < 5) ? 25 : msg.duration, !!msg.hard);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "FOCUS_OFF") {
      stopFocus(false);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "GET_FOCUS_STATUS") {
      sendResponse({ status: focusModeOn, locked: hardFocusActive && now < focusLockUntil, remaining: Math.max(0, focusLockUntil - now) });
      return;
    }

    if (msg.type === "ADD_BLOCK_SITE") {
      await loadAuthToken();
      if (!authToken) { sendResponse({ success: false, error: "Not authenticated" }); return; }
      try {
        const res = await fetch(`${BG_API_BASE}/blocked-sites`, {
          method: "POST", headers: getAuthHeaders(), body: JSON.stringify({ site: msg.site })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); sendResponse({ success: false, error: e.error || "Server error" }); return; }
        await applyBlockedSitesRulesIfFocusOn();
        const blockedSites = await fetchBlockedSites();
        chrome.tabs.query({ windowType: "normal" }, (tabs) => {
          tabs.forEach((tab) => {
            if (!tab.url || tab.url.startsWith("chrome://")) return;
            if (isBlockedUrl(tab.url, blockedSites)) chrome.tabs.reload(tab.id);
          });
        });
        sendResponse({ success: true });
      } catch (err) { sendResponse({ success: false, error: err.message }); }
      return;
    }

    if (msg.type === "REMOVE_BLOCK_SITE") {
      await loadAuthToken();
      if (!authToken) { sendResponse({ success: false, error: "Not authenticated" }); return; }
      try {
        const res = await fetch(`${BG_API_BASE}/blocked-sites/${encodeURIComponent(msg.site)}`, { method: "DELETE", headers: getAuthHeaders() });
        if (!res.ok) { sendResponse({ success: false, error: "Server error" }); return; }
        await applyBlockedSitesRulesIfFocusOn();
        sendResponse({ success: true });
      } catch (err) { sendResponse({ success: false, error: err.message }); }
      return;
    }

    if (msg.type === "SYNC_CATEGORIES") {
      await syncCategoriesFromServer();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "AUTH_TOKEN_UPDATED") {
      await loadAuthToken();
      await syncCategoriesFromServer();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "LOGOUT") {
      authToken = null;
      categoryMappings = {};
      stopFocus(true);
      chrome.storage.local.remove(["authToken", "lastValidated"]);
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

async function syncFocusState() {
  const data = await new Promise((resolve) => {
    chrome.storage.local.get(["focusMode", "focusLockUntil"], resolve);
  });
  const now = Date.now();
  if (data.focusMode) {
    const locked           = data.focusLockUntil && data.focusLockUntil > now;
    const remainingMs      = Math.max(0, (data.focusLockUntil || 0) - now);
    const remainingMinutes = Math.ceil(remainingMs / 60000) || 25;
    startFocus(remainingMinutes, locked);
  } else {
    stopFocus(true);
  }
  await loadAuthToken();
  await syncCategoriesFromServer();
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) return;
    if (tabs && tabs[0] && tabs[0].url) {
      const d = getDomain(tabs[0].url);
      if (d) currentDomain = d;
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.authToken) {
    loadAuthToken().then(() => syncCategoriesFromServer());
  }
});