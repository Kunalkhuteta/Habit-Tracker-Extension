/* =========================================================
   popup.js
   - Reads theme + accentColor from storage → applies same
     data-theme / data-accent attributes as dashboard so the
     popup is always pixel-identical to whatever the user set
   - Hard Focus uses an in-popup time picker (no native prompt)
   - timeData read from user-scoped key to avoid cross-account leaks
========================================================= */

/* ── Formatting ── */
function formatTime(ms) {
  if (!ms || ms <= 0) return "0m";
  const mins  = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return mins > 0 ? `${mins}m` : "<1m";
}

/* ── Per-user storage key helpers ── */
let _cachedToken = null;

async function getAuthToken() {
  if (_cachedToken) return _cachedToken;
  return new Promise(r => chrome.storage.local.get(["authToken"], d => {
    _cachedToken = d.authToken || null; r(_cachedToken);
  }));
}

function getUserId(token) {
  if (!token) return "default";
  try {
    const payload = token.split(".")[0];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split(".")[0];
  } catch { return token.slice(0, 16); }
}

function timeDataKey(token) { return `timeData_${getUserId(token)}`; }

/* =========================================================
   THEME SYNC
   Reads the same keys dashboard.js writes (theme, accentColor)
   and applies data-theme / data-accent to <html> so every
   CSS variable resolves identically to the dashboard.
========================================================= */
function applyTheme(theme, accent) {
  const html = document.documentElement;
  if (theme === "dark") html.setAttribute("data-theme", "dark");
  else                  html.removeAttribute("data-theme");
  if (accent) html.setAttribute("data-accent", accent);
  else        html.removeAttribute("data-accent");

  // also update the range slider fill which needs to be set inline
  updateSliderFill();
}

function loadAndApplyTheme() {
  chrome.storage.local.get(["theme", "accentColor"], d => {
    applyTheme(d.theme || "light", d.accentColor || "indigo");
  });
}

/* ── Range slider fill (CSS can't do this natively cross-browser) ── */
function updateSliderFill() {
  const slider = document.getElementById("durationSlider");
  if (!slider) return;
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  // read computed accent from CSS var
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim() || "#4f46e5";
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg-sunken").trim() || "#e8e4de";
  slider.style.background =
    `linear-gradient(to right, ${accent} 0%, ${accent} ${pct}%, ${bg} ${pct}%, ${bg} 100%)`;
}

/* =========================================================
   QUICK STATS
========================================================= */
async function loadQuickStats() {
  const token = await getAuthToken();
  const key   = timeDataKey(token);
  chrome.storage.local.get([key], res => {
    const today    = new Date().toISOString().split("T")[0];
    const dayData  = res[key]?.[today] || {};
    const catTime  = { Learning: 0, Distraction: 0, Development: 0, Other: 0 };

    for (const site in dayData) {
      const e    = dayData[site];
      const t    = typeof e === "number" ? e : (e.time || 0);
      const cat  = (typeof e === "object" && e.category) ? e.category : "Other";
      catTime[cat] = (catTime[cat] || 0) + t;
    }

    const total      = Object.values(catTime).reduce((a, b) => a + b, 0);
    const productive = (catTime.Learning || 0) + (catTime.Development || 0);
    const negative   = catTime.Distraction || 0;
    const denom      = productive + negative;
    const score      = denom === 0 ? 0 : Math.round((productive / denom) * 100);

    document.getElementById("totalTime").textContent        = formatTime(total);
    document.getElementById("productivityScore").textContent = score + "%";
  });
}

/* =========================================================
   FOCUS STATE UI
========================================================= */
function updateFocusUI(isOn, locked = false, remainingMs = 0) {
  const startBtn  = document.getElementById("startFocus");
  const stopBtn   = document.getElementById("stopFocus");
  const hardBtn   = document.getElementById("hardFocus");
  const stateBar  = document.getElementById("focusStateBar");
  const icon      = document.getElementById("focusStateIcon");
  const title     = document.getElementById("focusBtn");
  const sub       = document.getElementById("focusSubtext");
  const badge     = document.getElementById("focusBadge");
  const livePill  = document.getElementById("statusIndicator");
  const liveLabel = document.getElementById("liveLabel");
  const lockBnr   = document.getElementById("lockedBanner");

  startBtn.disabled = isOn;
  hardBtn.disabled  = isOn;
  stopBtn.disabled  = !isOn || locked;

  stateBar.classList.toggle("active", isOn && !locked);
  stateBar.classList.toggle("locked", locked);

  if (locked) {
    const mins = Math.ceil(remainingMs / 60000);
    icon.textContent  = "\uD83D\uDD12";
    title.textContent = "Hard Focus";
    sub.textContent   = `${mins}m remaining`;
    badge.textContent = "LOCKED";
    badge.className   = "state-badge err";
  } else if (isOn) {
    icon.textContent  = "\u2705";
    title.textContent = "Focus Mode";
    sub.textContent   = "Active \u2014 sites blocked";
    badge.textContent = "ON";
    badge.className   = "state-badge on";
  } else {
    icon.textContent  = "\u26AA";
    title.textContent = "Focus Mode";
    sub.textContent   = "Not active";
    badge.textContent = "OFF";
    badge.className   = "state-badge";
  }

  if (livePill)  livePill.classList.toggle("on", isOn);
  if (liveLabel) liveLabel.textContent = locked ? "Locked" : isOn ? "Active" : "Idle";
  if (lockBnr)   lockBnr.classList.toggle("show", locked);
}

function refreshFocusStatus() {
  chrome.runtime.sendMessage({ type: "GET_FOCUS_STATUS" }, res => {
    if (res) updateFocusUI(res.status, res.locked, res.remaining);
  });
}


  //  TIME PICKER (replaces native prompt)

let pickerMinutes = 25;

function updatePickerDisplay(mins) {
  pickerMinutes = mins;

  const numEl   = document.getElementById("pickerNum");
  const endEl   = document.getElementById("pickerEndTime");
  const curEl   = document.getElementById("sliderCur");
  const slider  = document.getElementById("durationSlider");

  if (numEl) numEl.textContent = mins;
  if (curEl) curEl.textContent = mins >= 60
    ? `${Math.floor(mins/60)}h ${mins%60 > 0 ? (mins%60)+"m" : ""}`.trim()
    : `${mins} min`;

  // show end time
  if (endEl) {
    const end = new Date(Date.now() + mins * 60000);
    endEl.textContent = "Until " + end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // sync slider without triggering its own event
  if (slider && parseInt(slider.value) !== mins) slider.value = mins;

  // sync preset selection
  document.querySelectorAll(".preset").forEach(p => {
    p.classList.toggle("sel", parseInt(p.dataset.min) === mins);
  });

  updateSliderFill();
}

function openPicker() {
  const picker = document.getElementById("timePicker");
  if (!picker) return;
  picker.classList.add("open");
  updatePickerDisplay(pickerMinutes);
  // scroll into view if needed
  picker.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closePicker() {
  const picker = document.getElementById("timePicker");
  if (picker) picker.classList.remove("open");
}

/* =========================================================
   MAIN INIT
========================================================= */
document.addEventListener("DOMContentLoaded", () => {

  // 1. Apply theme immediately (before auth check, avoids flash)
  loadAndApplyTheme();

  // 2. Auth gate
  chrome.storage.local.get(["authToken"], async data => {
    if (!data.authToken) {
      chrome.windows.create({ url: chrome.runtime.getURL("auth.html"), type: "popup", width: 460, height: 620 });
      window.close();
      return;
    }

    _cachedToken = data.authToken;
    loadQuickStats();
    refreshFocusStatus();

    /* ── Start Focus (25 min soft) ── */
    document.getElementById("startFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_ON", duration: 25, hard: false },
        res => { if (res?.success) refreshFocusStatus(); });
    });

    /* ── Hard Focus → open themed time picker ── */
    document.getElementById("hardFocus").addEventListener("click", () => {
      const picker = document.getElementById("timePicker");
      if (picker && picker.classList.contains("open")) closePicker();
      else openPicker();
    });

    /* ── Picker: preset chips ── */
    document.querySelectorAll(".preset").forEach(chip => {
      chip.addEventListener("click", () => {
        updatePickerDisplay(parseInt(chip.dataset.min));
      });
    });

    /* ── Picker: slider ── */
    const slider = document.getElementById("durationSlider");
    if (slider) {
      slider.addEventListener("input", () => {
        updatePickerDisplay(parseInt(slider.value));
      });
    }

    /* ── Picker: cancel ── */
    document.getElementById("pickerCancel").addEventListener("click", closePicker);

    /* ── Picker: confirm → send hard focus ── */
    document.getElementById("pickerConfirm").addEventListener("click", () => {
      if (pickerMinutes < 5) return;
      closePicker();
      chrome.runtime.sendMessage({ type: "FOCUS_ON", duration: pickerMinutes, hard: true },
        res => { if (res?.success) refreshFocusStatus(); });
    });

    /* ── Stop Focus ── */
    document.getElementById("stopFocus").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "FOCUS_OFF" },
        res => { if (res?.success) refreshFocusStatus(); });
    });

    /* ── Open Dashboard ── */
    document.getElementById("openDashboard").addEventListener("click", () => {
      chrome.windows.create({ url: chrome.runtime.getURL("dashboard.html"), type: "popup", width: 1400, height: 900 });
    });

    /* ── Live storage listener ── */
    const scopedKey = timeDataKey(_cachedToken);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Re-apply theme if user changes it in the dashboard while popup is open
      if (changes.theme || changes.accentColor) {
        chrome.storage.local.get(["theme", "accentColor"], d => {
          applyTheme(d.theme || "light", d.accentColor || "indigo");
        });
      }
      if (changes.focusMode || changes.focusLockUntil) refreshFocusStatus();
      if (changes[scopedKey]) loadQuickStats();
    });
  });
});