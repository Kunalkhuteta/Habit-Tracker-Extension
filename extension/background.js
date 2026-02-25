/* =========================================================
   KEEPALIVE
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
let currentDomain   = null;
let bufferTime      = {};

let focusModeOn     = false;
let hardFocusActive = false;
let focusLockUntil  = 0;
let pomodoroTimer   = null;

const BASE_RULE_ID  = 1000;
const MAX_RULES     = 100;

let categoryMappings = {};
let authToken        = null;

// const BG_API_BASE = "http://localhost:5000";
const BG_API_BASE = (typeof API_BASE !== "undefined" && API_BASE)
  ? API_BASE
  : "https://habit-tracker-extension.onrender.com";

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
  try { return new URL(url).hostname.replace(/^www\./, "") || null; }
  catch { return null; }
}

function getTodayKey() { return new Date().toISOString().split("T")[0]; }

function getCategory(domain) {
  if (!domain) return "Other";
  const n = normalizeDomain(domain);
  if (categoryMappings[n]) return categoryMappings[n];
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(i).join(".");
    if (categoryMappings[parent]) return categoryMappings[parent];
  }
  if (/leetcode|geeksforgeeks|coursera|udemy|khanacademy|edx|pluralsight/.test(n)) return "Learning";
  if (/youtube|instagram|facebook|twitter|reddit|tiktok|netflix|twitch/.test(n))    return "Distraction";
  if (/github|stackoverflow|dev\.to|medium|docs\.|mdn|npmjs/.test(n))               return "Development";
  return "Other";
}

/* =========================================================
   AUTH
========================================================= */
async function loadAuthToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken"], (d) => {
      authToken = d.authToken || null;
      resolve(authToken);
    });
  });
}

function getAuthHeaders() {
  return authToken
    ? { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` }
    : { "Content-Type": "application/json" };
}

function getUserId() {
  if (!authToken) return "default";
  try {
    const payload = authToken.split(".")[0];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split(".")[0];
  } catch {
    return authToken.slice(0, 16);
  }
}

function timeDataKey()     { return `timeData_${getUserId()}`; }
function blockedSitesKey() { return `blockedSites_${getUserId()}`; }

/* =========================================================
   TIME TRACKING
========================================================= */
function trackOneSecond() {
  if (!currentDomain || currentDomain.length < 2) return;
  bufferTime[currentDomain] = (bufferTime[currentDomain] || 0) + 1000;
}

async function flushBufferToStorage() {
  if (Object.keys(bufferTime).length === 0) return;
  const today    = getTodayKey();
  const captured = { ...bufferTime };
  bufferTime     = {};
  const key      = timeDataKey();
  const timeData = await new Promise((resolve) =>
    chrome.storage.local.get([key], (res) => resolve(res[key] || {}))
  );
  timeData[today] = timeData[today] || {};
  for (const domain in captured) {
    const category = getCategory(domain);
    if (!timeData[today][domain]) timeData[today][domain] = { time: 0, category };
    timeData[today][domain].time     += captured[domain];
    timeData[today][domain].category  = category;
  }
  chrome.storage.local.set({ [key]: timeData });
}

setInterval(trackOneSecond, 1000);
setInterval(flushBufferToStorage, 3000);

/* =========================================================
   CATEGORY SYNC
========================================================= */
async function syncCategoriesFromServer() {
  const token = await loadAuthToken();
  if (!token) return;
  try {
    const r = await fetch(`${BG_API_BASE}/categories`, { headers: getAuthHeaders() });
    if (!r.ok) return;
    const mappings = await r.json();
    categoryMappings = {};
    if (Array.isArray(mappings)) {
      mappings.forEach((m) => {
        if (m.domain && m.category) categoryMappings[normalizeDomain(m.domain)] = m.category;
      });
    }
    console.log(`[BG] Synced ${Object.keys(categoryMappings).length} category mappings`);
  } catch (err) { console.error("syncCategories failed:", err); }
}

loadAuthToken().then(() => {
  syncCategoriesFromServer();
  setInterval(syncCategoriesFromServer, 1800000);
});

/* =========================================================
   TAB & WINDOW TRACKING
========================================================= */
chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs.get(info.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.url) return;
    const d = getDomain(tab.url);
    if (d) currentDomain = d;
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      if (tabs?.[0]?.id === tabId) {
        const d = getDomain(tab.url || tabs[0].url);
        if (d) currentDomain = d;
      }
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.[0]?.url) return;
    const d = getDomain(tabs[0].url);
    if (d) currentDomain = d;
  });
});

chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
  if (chrome.runtime.lastError || !tabs?.[0]?.url) return;
  const d = getDomain(tabs[0].url);
  if (d) currentDomain = d;
});

/* =========================================================
   BADGE & NOTIFY
========================================================= */
function updateBadge() {
  chrome.action.setBadgeText({ text: focusModeOn ? "ON" : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
}

function notify(message) {
  chrome.notifications.create({
    type: "basic", iconUrl: "icon.png", title: "Focus Mode", message
  });
}

/* =========================================================
   BLOCKED SITES
========================================================= */
async function getBlockedSites() {
  const key = blockedSitesKey();
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (d) => {
      void chrome.runtime.lastError;
      resolve(Array.isArray(d[key]) ? d[key] : []);
    });
  });
}

function isBlockedUrl(url, blockedSites) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return blockedSites.some((s) => host === s || host.endsWith("." + s));
  } catch { return false; }
}

/* =========================================================
   BUILD BLOCK RULES
   FIX: Each rule's redirect now includes ?site=<domain> so
   blocked.html can display which site was blocked.
   We use extensionPath + a transform approach: since
   declarativeNetRequest redirect.extensionPath cannot be
   dynamic per-domain, we instead redirect to a generic path
   and rely on a webNavigation listener to rewrite the URL
   with the actual origin, OR we use the simpler approach of
   one rule per site with a unique extensionPath query string.

   declarativeNetRequest supports redirect.extensionPath as a
   static string only — it cannot interpolate the blocked URL.
   SOLUTION: redirect to blocked.html?site=DOMAIN by encoding
   each site's domain into its own rule's extensionPath string.
   This is fully supported in MV3.
========================================================= */
async function enableBlocking() {
  const sites = await getBlockedSites();

  // One rule per blocked site; each redirect carries ?site=<domain>
  // so blocked.html always knows which site was blocked.
  const addRules = sites.slice(0, MAX_RULES).map((site, i) => ({
    id:       BASE_RULE_ID + i,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        // Pass the blocked domain as a query param — blocked.html reads ?site=
        extensionPath: `/blocked.html?site=${encodeURIComponent(site)}`
      }
    },
    condition: {
      urlFilter:     `||${site}^`,
      resourceTypes: ["main_frame"]
    }
  }));

  const removeIds = Array.from({ length: MAX_RULES }, (_, i) => BASE_RULE_ID + i);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules
  });

  console.log(`[Focus] Blocking ENABLED — ${sites.length} sites:`, sites);
  return sites;
}

async function disableBlocking() {
  const removeIds = Array.from({ length: MAX_RULES }, (_, i) => BASE_RULE_ID + i);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: []
  });

  console.log("[Focus] Blocking DISABLED — all rules removed");
}

/* =========================================================
   FOCUS MODE
========================================================= */
async function startFocus(durationMinutes, hard) {
  durationMinutes  = Math.max(5, durationMinutes || 25);
  const durationMs = durationMinutes * 60 * 1000;

  clearTimeout(pomodoroTimer);

  focusModeOn     = true;
  hardFocusActive = hard;
  focusLockUntil  = hard ? Date.now() + durationMs : 0;

  await chrome.storage.local.set({
    focusMode:       true,
    hardFocusActive: hard,
    focusLockUntil:  focusLockUntil
  });

  const blockedSites = await enableBlocking();

  if (blockedSites.length > 0) {
    chrome.tabs.query({ windowType: "normal" }, (tabs) => {
      if (chrome.runtime.lastError) return;
      (tabs || []).forEach((tab) => {
        if (!tab.url || tab.url.startsWith("chrome://")) return;
        if (isBlockedUrl(tab.url, blockedSites)) {
          chrome.tabs.reload(tab.id);
        }
      });
    });
  }

  updateBadge();
  notify(hard
    ? `Hard Focus ON — locked for ${durationMinutes} min`
    : `Focus Mode ON — ${durationMinutes} min`
  );

  if (hard) {
    pomodoroTimer = setTimeout(() => stopFocus(true), durationMs);
  }

  syncBlockedSitesInBackground();
}

async function stopFocus(force) {
  if (!force && hardFocusActive && Date.now() < focusLockUntil) {
    notify("Hard focus is active — cannot stop until time is up");
    return;
  }

  clearTimeout(pomodoroTimer);

  focusModeOn     = false;
  hardFocusActive = false;
  focusLockUntil  = 0;

  await chrome.storage.local.set({
    focusMode:       false,
    hardFocusActive: false,
    focusLockUntil:  0
  });

  await disableBlocking();

  const extId = chrome.runtime.id;
  chrome.tabs.query({ windowType: "normal" }, (tabs) => {
    if (chrome.runtime.lastError) return;
    (tabs || []).forEach((tab) => {
      if (tab.url && tab.url.includes(extId) && tab.url.includes("blocked.html")) {
        chrome.tabs.goBack(tab.id, () => { void chrome.runtime.lastError; });
      }
    });
  });

  updateBadge();
  notify("Focus Mode OFF — sites unblocked");
}

/* =========================================================
   BACKGROUND SERVER SYNC FOR BLOCKED SITES
========================================================= */
async function syncBlockedSitesInBackground() {
  const token = await loadAuthToken();
  if (!token) return;
  try {
    const res = await fetch(`${BG_API_BASE}/blocked-sites`, {
      headers: getAuthHeaders(),
      signal:  AbortSignal.timeout(10000)
    });
    if (!res.ok) return;
    const serverSites = await res.json();
    if (!Array.isArray(serverSites) || serverSites.length === 0) return;

    const local  = await getBlockedSites();
    const merged = [...new Set([...serverSites, ...local])].sort();
    await new Promise((r) => chrome.storage.local.set({ [blockedSitesKey()]: merged }, r));

    if (focusModeOn) await enableBlocking();
  } catch (err) {
    console.warn("syncBlockedSitesInBackground failed:", err.message);
  }
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const now = Date.now();

    if (msg.type === "GOOGLE_AUTH") {
      try {
        if (!chrome.identity) { sendResponse({ success: false, error: "chrome.identity not available" }); return; }
        const accessToken = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!token)              reject(new Error("No token returned"));
            else                          resolve(token);
          });
        });
        const res  = await fetch(`${BG_API_BASE}/auth/google`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.token) {
          await new Promise((r) => chrome.storage.local.set({
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
      const duration = (!msg.duration || msg.duration < 5) ? 25 : msg.duration;
      await startFocus(duration, !!msg.hard);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "FOCUS_OFF") {
      await stopFocus(false);
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "GET_FOCUS_STATUS") {
      sendResponse({
        status:    focusModeOn,
        locked:    hardFocusActive && now < focusLockUntil,
        remaining: Math.max(0, focusLockUntil - now)
      });
      return;
    }

    if (msg.type === "ADD_BLOCK_SITE") {
      if (focusModeOn) {
        const blockedSites = await enableBlocking();
        chrome.tabs.query({ windowType: "normal" }, (tabs) => {
          if (chrome.runtime.lastError) return;
          (tabs || []).forEach((tab) => {
            if (!tab.url || tab.url.startsWith("chrome://")) return;
            if (isBlockedUrl(tab.url, blockedSites)) chrome.tabs.reload(tab.id);
          });
        });
      }
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "REMOVE_BLOCK_SITE") {
      if (focusModeOn) await enableBlocking();
      sendResponse({ success: true });
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
      clearTimeout(pomodoroTimer);
      focusModeOn     = false;
      hardFocusActive = false;
      focusLockUntil  = 0;

      const bsKey  = blockedSitesKey();
      const catKey = `catCustomizations_${getUserId()}`;

      authToken        = null;
      categoryMappings = {};
      updateBadge();
      await disableBlocking();
      chrome.storage.local.remove([
        "authToken", "lastValidated", "userInfo",
        bsKey,
        "focusMode", "hardFocusActive", "focusLockUntil",
        catKey, "_sw_heartbeat"
      ]);
      sendResponse({ success: true });
      return;
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(restoreState);
chrome.runtime.onInstalled.addListener(restoreState);

async function restoreState() {
  await loadAuthToken();

  const data = await new Promise((resolve) =>
    chrome.storage.local.get(["focusMode", "hardFocusActive", "focusLockUntil"], resolve)
  );

  const now         = Date.now();
  const wasOn       = !!data.focusMode;
  const wasHard     = !!data.hardFocusActive;
  const lockUntil   = data.focusLockUntil || 0;
  const hardExpired = wasHard && now >= lockUntil;

  if (wasOn && !(wasHard && hardExpired)) {
    focusModeOn     = true;
    hardFocusActive = wasHard && now < lockUntil;
    focusLockUntil  = lockUntil;

    await enableBlocking();

    if (wasHard && now < lockUntil) {
      pomodoroTimer = setTimeout(() => stopFocus(true), lockUntil - now);
    }
    console.log("[Focus] Restored: focus ON", wasHard ? `locked until ${new Date(lockUntil).toLocaleTimeString()}` : "");
  } else {
    focusModeOn     = false;
    hardFocusActive = false;
    focusLockUntil  = 0;
    await chrome.storage.local.set({ focusMode: false, hardFocusActive: false, focusLockUntil: 0 });
    await disableBlocking();
    console.log("[Focus] Restored: focus OFF");
  }

  updateBadge();

  syncCategoriesFromServer().catch(console.error);
  syncBlockedSitesInBackground().catch(console.error);

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs?.[0]?.url) return;
    const d = getDomain(tabs[0].url);
    if (d) currentDomain = d;
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.authToken) {
    loadAuthToken().then(() => syncCategoriesFromServer());
  }
});