/* =========================================================
   KEEPALIVE — Must be the very first thing that runs.

   MV3 service workers are killed by Chrome after 30 seconds
   of inactivity. Two strategies run together:

   1. chrome.alarms (every ~25s): Wakes the worker back up
      even after Chrome has already killed it. This is the
      ONLY official way to resurrect a dead service worker.

   2. Storage heartbeat (every 20s): While the worker is
      alive, writing to chrome.storage resets the 30s idle
      timer so Chrome doesn't kill it in the first place.
========================================================= */
const KEEPALIVE_ALARM   = "focus-tracker-keepalive";
const HEARTBEAT_MS      = 20_000;   // 20 seconds
const ALARM_INTERVAL    = 0.4;      // minutes (~24 seconds)

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

// When alarm fires (even after worker was killed), restart heartbeat
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    startHeartbeat();
    chrome.storage.local.set({ _sw_heartbeat: Date.now() });
  }
});

// Start both strategies immediately on worker boot
startHeartbeat();
registerKeepaliveAlarm();

/* =========================================================
   GLOBAL STATE
   
   IMPORTANT: Service workers can be killed and restarted at
   any time. All in-memory variables reset to their defaults
   on each restart. Critical state (focusMode, focusLockUntil,
   authToken) is always read from chrome.storage, never trusted
   from in-memory variables alone.
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

// Category mappings from server (rebuilt on every worker boot via syncCategoriesFromServer)
let categoryMappings = {};

// Authentication token (always reloaded from storage, never hardcoded)
let authToken = null;

/* =========================================================
   UTILS
========================================================= */

function normalizeDomain(domain) {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

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

// BUG FIX: getCategory now first checks live categoryMappings from server
// before falling back to hardcoded logic. Previously the hardcoded fallback
// always fired and overrode user-defined mappings.
function getCategory(domain) {
  if (!domain) return "Other";

  const normalized = normalizeDomain(domain);

  // Exact match from server mappings
  if (categoryMappings[normalized]) {
    return categoryMappings[normalized];
  }

  // Parent domain match (e.g. music.youtube.com → youtube.com mapping)
  const parts = normalized.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (categoryMappings[parent]) {
      return categoryMappings[parent];
    }
  }

  // Root key match (youtube.com → "youtube")
  const root = parts[0];
  if (categoryMappings[root]) {
    return categoryMappings[root];
  }

  // Fallback hardcoded logic (only when no server mapping exists)
  if (
    normalized.includes("leetcode") ||
    normalized.includes("geeksforgeeks") ||
    normalized.includes("coursera") ||
    normalized.includes("udemy") ||
    normalized.includes("khanacademy") ||
    normalized.includes("edx") ||
    normalized.includes("pluralsight")
  ) {
    return "Learning";
  }

  if (
    normalized.includes("youtube") ||
    normalized.includes("instagram") ||
    normalized.includes("facebook") ||
    normalized.includes("twitter") ||
    normalized.includes("reddit") ||
    normalized.includes("tiktok") ||
    normalized.includes("netflix") ||
    normalized.includes("twitch")
  ) {
    return "Distraction";
  }

  if (
    normalized.includes("github") ||
    normalized.includes("stackoverflow") ||
    normalized.includes("dev.to") ||
    normalized.includes("medium") ||
    normalized.includes("docs.") ||
    normalized.includes("mdn") ||
    normalized.includes("npmjs")
  ) {
    return "Development";
  }

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
  if (!authToken) {
    console.warn("No auth token available");
    return { "Content-Type": "application/json" };
  }

  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`
  };
}

/* =========================================================
   TIME TRACKING
========================================================= */
function trackOneSecond() {
  if (!currentDomain || isIdle || !chromeFocused) return;
  bufferTime[currentDomain] = (bufferTime[currentDomain] || 0) + 1000;
}

// BUG FIX: flushBufferToStorage was calling chrome.storage.local.get with a
// non-async callback and then using await inside it — this caused the await
// to be ignored (can't await inside a non-async callback). Fixed by reading
// storage with a Promise wrapper and using a proper async flow.
async function flushBufferToStorage() {
  if (Object.keys(bufferTime).length === 0) return;

  const today = getTodayKey();
  const captured = { ...bufferTime };
  bufferTime = {};

  const timeData = await new Promise((resolve) => {
    chrome.storage.local.get(["timeData"], (res) => {
      resolve(res.timeData || {});
    });
  });

  timeData[today] = timeData[today] || {};

  for (const domain in captured) {
    // getCategory is now synchronous (uses in-memory categoryMappings)
    const category = getCategory(domain);

    if (!timeData[today][domain]) {
      timeData[today][domain] = { time: 0, category };
    }

    timeData[today][domain].time += captured[domain];
    // Always keep category up to date with latest server mappings
    timeData[today][domain].category = getCategory(domain);
  }

  chrome.storage.local.set({ timeData });
}

setInterval(trackOneSecond, 1000);
setInterval(flushBufferToStorage, 10000);

/* =========================================================
   CATEGORY SYNC FROM SERVER
========================================================= */
async function syncCategoriesFromServer() {
  const token = await loadAuthToken();

  if (!token) {
    console.warn("Cannot sync categories: No auth token");
    return;
  }

  try {
    const response = await fetch(`${BG_API_BASE}/categories`, {
      headers: getAuthHeaders()
    });

    if (!response.ok) {
      console.error("Failed to sync categories:", response.status);
      return;
    }

    const mappings = await response.json();

    // BUG FIX: Rebuild categoryMappings completely on each sync so deleted
    // entries are also removed from the in-memory map.
    categoryMappings = {};
    if (Array.isArray(mappings)) {
      mappings.forEach((m) => {
        const normalized = normalizeDomain(m.domain);
        categoryMappings[normalized] = m.category;
      });
    }

    console.log("✅ Categories synced:", categoryMappings);
  } catch (err) {
    console.error("❌ Failed to sync categories:", err);
  }
}

// Sync categories on startup and every 30 minutes
loadAuthToken().then(() => {
  syncCategoriesFromServer();
  setInterval(syncCategoriesFromServer, 1800000); // 30 minutes
});

/* =========================================================
   TAB & IDLE EVENTS
========================================================= */
chrome.tabs.onActivated.addListener((info) => {
  chrome.tabs.get(info.tabId, (tab) => {
    if (tab && tab.url) {
      currentDomain = getDomain(tab.url);
    }
  });
});

chrome.tabs.onUpdated.addListener((_, changeInfo, tab) => {
  if (changeInfo.url) {
    // Only update if this is the active tab
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id === tab.id) {
        currentDomain = getDomain(changeInfo.url);
      }
    });
  }
});

chrome.windows.onFocusChanged.addListener((id) => {
  chromeFocused = id !== chrome.windows.WINDOW_ID_NONE;
  if (!chromeFocused) isIdle = true;
});

chrome.idle.onStateChanged.addListener((state) => {
  isIdle = state !== "active";
  if (!chromeFocused) isIdle = true;
});

// Set initial active tab on startup
chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
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
  const token = await loadAuthToken();

  if (!token) {
    console.warn("Cannot fetch blocked sites: No auth token");
    return [];
  }

  try {
    const res = await fetch(`${BG_API_BASE}/blocked-sites`, {
      headers: getAuthHeaders()
    });

    if (!res.ok) {
      console.error("Failed to fetch blocked sites:", res.status);
      return [];
    }

    const sites = await res.json();
    return Array.isArray(sites) ? sites : [];
  } catch (err) {
    console.error("Failed to fetch blocked sites:", err);
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

  if (!focusData.focusMode) {
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

  const removeIds = Array.from({ length: MAX_RULES }, (_, i) => BASE_RULE_ID + i);

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: rules
  });
}

function isBlockedUrl(url, blockedSites) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return blockedSites.some(
      (site) => hostname === site || hostname.endsWith("." + site)
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

  // Reload any currently-open blocked tabs
  chrome.tabs.query({ windowType: "normal" }, async (tabs) => {
    const blockedSites = await fetchBlockedSites();
    tabs.forEach((tab) => {
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
    notify("Hard focus active — cannot stop yet");
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

// API base for background.js — service workers cannot use <script src="config.js">
// Change to your Render URL for production:
// ↓↓↓ MUST MATCH config.js RENDER_URL exactly ↓↓↓
const BG_API_BASE = "https://habit-tracker-extension.onrender.com";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const now = Date.now();

    // ── GOOGLE AUTH ──
    // Uses getAuthToken — works when manifest.json has:
    //   "identity" permission + "oauth2": { "client_id": "YOUR_REAL_ID..." }
    // The client_id in manifest.json MUST be a "Chrome Extension" type
    // created in Google Cloud Console with your extension ID.
    if (msg.type === "GOOGLE_AUTH") {
      console.log("[GOOGLE_AUTH] Step 1: Message received");

      try {
        if (!chrome.identity) {
          sendResponse({ success: false, error: "chrome.identity not available. Check manifest has identity permission." });
          return;
        }
        console.log("[GOOGLE_AUTH] Step 2: Calling getAuthToken...");

        // Get Google access token — Chrome handles the sign-in popup
        const accessToken = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
              console.error("[GOOGLE_AUTH] getAuthToken error:", chrome.runtime.lastError.message);
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!token) {
              reject(new Error("No token returned — check oauth2.client_id in manifest.json"));
            } else {
              console.log("[GOOGLE_AUTH] Step 3: Got access token ✓");
              resolve(token);
            }
          });
        });

        // Send token to our server to verify + create/login user
        console.log("[GOOGLE_AUTH] Step 4: Sending token to server...");
        const res  = await fetch(`${BG_API_BASE}/auth/google`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ accessToken })
        });
        const data = await res.json().catch(() => ({}));
        console.log("[GOOGLE_AUTH] Step 5: Server response:", res.status, data);

        if (res.ok && data.token) {
          await new Promise(resolve => chrome.storage.local.set({
            authToken:     data.token,
            userInfo:      data.user,
            lastValidated: new Date().toISOString().split("T")[0]
          }, resolve));
          await loadAuthToken();
          await syncCategoriesFromServer();
          console.log("[GOOGLE_AUTH] ✅ Success");
          sendResponse({ success: true, token: data.token, user: data.user });
        } else {
          console.error("[GOOGLE_AUTH] Server rejected:", data.error);
          sendResponse({ success: false, error: data.error || "Server rejected Google token" });
        }

      } catch (err) {
        console.error("[GOOGLE_AUTH] ❌", err.message);
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === "FOCUS_ON") {
      const duration = (!msg.duration || msg.duration < 5) ? 25 : msg.duration;
      await startFocus(duration, !!msg.hard);
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
      await loadAuthToken();

      if (!authToken) {
        sendResponse({ success: false, error: "Not authenticated" });
        return;
      }

      try {
        const res = await fetch(`${BG_API_BASE}/blocked-sites`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify({ site: msg.site })
        });

        if (!res.ok) {
          const err = await res.json();
          sendResponse({ success: false, error: err.error || "Server error" });
          return;
        }

        await applyBlockedSitesRulesIfFocusOn();

        // BUG FIX: Also reload currently-open blocked tabs after adding a new site
        const blockedSites = await fetchBlockedSites();
        chrome.tabs.query({ windowType: "normal" }, (tabs) => {
          tabs.forEach((tab) => {
            if (!tab.url || tab.url.startsWith("chrome://")) return;
            if (isBlockedUrl(tab.url, blockedSites)) {
              chrome.tabs.reload(tab.id);
            }
          });
        });

        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
      return;
    }

    if (msg.type === "REMOVE_BLOCK_SITE") {
      await loadAuthToken();

      if (!authToken) {
        sendResponse({ success: false, error: "Not authenticated" });
        return;
      }

      try {
        const res = await fetch(
          `${BG_API_BASE}/blocked-sites/${encodeURIComponent(msg.site)}`,
          { method: "DELETE", headers: getAuthHeaders() }
        );

        if (!res.ok) {
          sendResponse({ success: false, error: "Server error" });
          return;
        }

        await applyBlockedSitesRulesIfFocusOn();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
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

  return true; // Keep message channel open for async response
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
    const locked = data.focusLockUntil && data.focusLockUntil > now;
    const remainingMs = Math.max(0, (data.focusLockUntil || 0) - now);
    const remainingMinutes = Math.ceil(remainingMs / 60000) || 25;
    startFocus(remainingMinutes, locked);
  } else {
    stopFocus(true);
  }

  // Sync categories on startup
  await loadAuthToken();
  await syncCategoriesFromServer();
}

// Listen for auth token changes in storage (e.g., login from auth.html)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.authToken) {
    loadAuthToken().then(() => {
      syncCategoriesFromServer();
    });
  }
});