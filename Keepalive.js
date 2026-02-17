/* =========================================================
   KEEPALIVE.JS
   
   MV3 service workers are killed by Chrome after 30 seconds
   of inactivity. This module uses TWO strategies together:

   1. chrome.alarms (every 25s) — wakes the worker back up
      immediately if Chrome killed it. Alarms are the ONLY
      official API that can resurrect a dead service worker.

   2. Storage heartbeat (every 20s) — while the worker IS
      alive, writing to storage resets Chrome's idle timer,
      preventing it from being killed in the first place.

   Import this at the TOP of background.js:
     importScripts('keepalive.js');
   
   Or just paste the contents at the top of background.js.
========================================================= */

const KEEPALIVE_ALARM_NAME = "focus-tracker-keepalive";
const HEARTBEAT_INTERVAL_MS = 20 * 1000; // 20 seconds
const ALARM_INTERVAL_MINUTES = 0.4;      // ~24 seconds (Chrome min is 0 in MV3 for alarms)

let heartbeatTimer = null;

/* ---------------------------------------------------------
   HEARTBEAT — keeps worker alive while it's running
   Writing to chrome.storage resets the 30s idle timer.
--------------------------------------------------------- */
function startHeartbeat() {
  if (heartbeatTimer) return; // Already running

  heartbeatTimer = setInterval(() => {
    chrome.storage.local.set({ "_sw_heartbeat": Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/* ---------------------------------------------------------
   ALARM — resurrects the worker after Chrome kills it.
   Even if the worker is dead, alarms fire and Chrome
   wakes it back up to handle the alarm event.
--------------------------------------------------------- */
async function registerKeepaliveAlarm() {
  // Check if alarm already exists to avoid duplicate registration
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM_NAME);
  
  if (!existing) {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
      delayInMinutes: ALARM_INTERVAL_MINUTES,
      periodInMinutes: ALARM_INTERVAL_MINUTES
    });
    console.log("✅ Keepalive alarm registered");
  }
}

// When the alarm fires, the service worker is awake.
// Restart the heartbeat so it stays alive for the next cycle.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM_NAME) {
    startHeartbeat();
    // Write to storage to immediately reset the idle timer
    chrome.storage.local.set({ "_sw_heartbeat": Date.now() });
  }
});

/* ---------------------------------------------------------
   INIT — call this once when the service worker starts.
   Both the alarm and heartbeat begin immediately.
--------------------------------------------------------- */
function initKeepalive() {
  startHeartbeat();
  registerKeepaliveAlarm();
}

// Auto-init when this script is loaded
initKeepalive();