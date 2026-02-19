/* dashboard.js — Focus Tracker (FIXED)
   Key fixes:
   1. Category API uses /categories endpoint (matches server.js)
   2. Category editor correctly POSTs {domain, category} pairs
   3. startTicker tracks all time (no idle pause)
   4. Saves work correctly, errors show as toasts
*/

const API = typeof API_BASE !== "undefined" ? API_BASE : "https://habit-tracker-extension.onrender.com";

let authToken     = null;
let currentTheme  = "light";
let currentAccent = "indigo";
let serverCategories = [];
let userCategories   = [];
let timeChartInst = null;
let allWeeklyData = [];
let showingAll    = false;
let editingCatId    = null;
let editDomains     = [];
let originalDomains = [];
let emojiPickerOpen = false;
let editColor       = "#22c55e"; // tracks current color picker value in editor
let catCustomizations = {};      // persisted per-category overrides: { Learning: { color, emoji }, ... }

const BUILTIN_CATS = [
  { id: "Learning",    name: "Learning",    emoji: "📚", color: "#22c55e" },
  { id: "Development", name: "Development", emoji: "💻", color: "#3b82f6" },
  { id: "Distraction", name: "Distraction", emoji: "⚠️",  color: "#ef4444" },
  { id: "Other",       name: "Other",       emoji: "📦", color: "#f97316" },
];

async function loadAuthToken() {
  return new Promise(r => chrome.storage.local.get(["authToken"], d => { authToken = d.authToken||null; r(authToken); }));
}
const hdrs = () => authToken
  ? { "Content-Type":"application/json", Authorization:`Bearer ${authToken}` }
  : { "Content-Type":"application/json" };

document.addEventListener("DOMContentLoaded", async () => {
  await loadAuthToken();
  if (!authToken) { location.href = "auth.html"; return; }
  await loadPreferences();
  await loadCatCustomizations();   // load saved colors/emojis before building categories
  await loadUserCategories();
  renderStatCards();
  initEventListeners();
  initFocusControls();
  renderFromStorage();
  loadBlockedSites();
  loadReflection();
  loadWeeklySummary();
  startTicker();
  buildEmojiGrid();
});

/* ─── CAT CUSTOMIZATIONS (colors/emojis stored locally) ─── */
async function loadCatCustomizations() {
  return new Promise(resolve => {
    chrome.storage.local.get(["catCustomizations"], res => {
      void chrome.runtime.lastError;
      catCustomizations = res.catCustomizations || {};
      resolve();
    });
  });
}

async function saveCatCustomizations() {
  return new Promise(resolve => {
    chrome.storage.local.set({ catCustomizations }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/* ─── CATEGORIES ─── */
async function loadUserCategories() {
  try {
    const r = await fetch(`${API}/categories`, { headers: hdrs() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    serverCategories = await r.json();
  } catch (e) {
    console.error("Failed to load categories:", e);
    serverCategories = [];
  }

  // Build builtin categories with any saved customizations applied
  const builtins = BUILTIN_CATS.map(cat => {
    const custom = catCustomizations[cat.id] || {};
    return {
      ...cat,
      color:   custom.color || cat.color,
      emoji:   custom.emoji || cat.emoji,
      domains: serverCategories.filter(m => m.category === cat.id).map(m => m.domain)
    };
  });

  // Build custom (user-created) categories from catCustomizations
  // These are entries in catCustomizations whose key is NOT a builtin id
  const builtinIds = new Set(BUILTIN_CATS.map(b => b.id));
  const customCats = Object.entries(catCustomizations)
    .filter(([id]) => !builtinIds.has(id))
    .map(([id, custom]) => ({
      id,
      name:    custom.name  || id,
      emoji:   custom.emoji || "📁",
      color:   custom.color || "#6366f1",
      isCustom: true,
      domains: serverCategories.filter(m => m.category === id).map(m => m.domain)
    }));

  userCategories = [...builtins, ...customCats];
}

function buildDomainMap() {
  const map = {};
  serverCategories.forEach(m => { if (m.domain && m.category) map[m.domain] = m.category; });
  return map;
}

function getCatForDomain(domain) {
  const map = buildDomainMap();
  const normalized = domain.toLowerCase().replace(/^www\./, "");
  if (map[normalized]) return userCategories.find(c => c.id === map[normalized]);
  const parts = normalized.split(".");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(i).join(".");
    if (map[parent]) return userCategories.find(c => c.id === map[parent]);
  }
  if (/leetcode|coursera|udemy|khanacademy|edx|pluralsight|geeksforgeeks/.test(normalized))
    return userCategories.find(c => c.id === "Learning");
  if (/youtube|instagram|facebook|twitter|reddit|tiktok|netflix|twitch/.test(normalized))
    return userCategories.find(c => c.id === "Distraction");
  if (/github|stackoverflow|dev\.to|mdn|npmjs|docs\./.test(normalized))
    return userCategories.find(c => c.id === "Development");
  return userCategories.find(c => c.id === "Other") || userCategories[userCategories.length - 1];
}

/* ─── STAT CARDS ─── */
function renderStatCards() {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;
  const totalCard = grid.querySelector(".stat-card.total");
  grid.innerHTML = "";
  if (totalCard) grid.appendChild(totalCard);
  userCategories.forEach(cat => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.dataset.catId = cat.id;
    card.style.setProperty("--cat-color", cat.color);
    card.title = `Click to manage "${cat.name}" sites`;
    card.innerHTML = `
      <span class="stat-emoji">${cat.emoji}</span>
      <div class="stat-info">
        <span class="stat-value" id="catTime-${cat.id}">—</span>
        <span class="stat-label">${cat.name}</span>
      </div>
      <span class="stat-edit-hint">edit</span>
    `;
    card.addEventListener("click", () => openCatEditor(cat));
    grid.appendChild(card);
  });
}

/* ─── TICKER ─── */
function getTodayKey() { return new Date().toISOString().split("T")[0]; }

function startTicker() {
  setInterval(() => {
    if ((document.getElementById("rangeSelect")?.value||"today") !== "today") return;
    chrome.tabs.query({ active:true, lastFocusedWindow:true }, tabs => {
      void chrome.runtime.lastError;
      if (!tabs?.length || !tabs[0]?.url) return;
      const url = tabs[0].url;
      if (!url.startsWith("http://") && !url.startsWith("https://")) return;
      let domain;
      try { domain = new URL(url).hostname.replace(/^www\./,""); } catch { return; }
      if (!domain) return;
      const cat   = getCatForDomain(domain);
      const catId = cat?.id || "Other";
      const today = getTodayKey();
      chrome.storage.local.get(["timeData"], res => {
        void chrome.runtime.lastError;
        const td = res.timeData || {};
        td[today] = td[today] || {};
        if (!td[today][domain]) td[today][domain] = { time:0, category: catId };
        td[today][domain].time     += 1000;
        td[today][domain].category  = catId;
        chrome.storage.local.set({ timeData:td }, () => {
          void chrome.runtime.lastError;
          renderFromStorage();
        });
      });
    });
  }, 1000);
}

/* ─── RENDER ─── */
function getDateKey(offset=0) {
  const d = new Date(); d.setDate(d.getDate()-offset);
  return d.toISOString().split("T")[0];
}

let _lastChartRender = 0;

function renderFromStorage() {
  const range = document.getElementById("rangeSelect")?.value || "today";
  chrome.storage.local.get(["timeData"], res => {
    void chrome.runtime.lastError;
    const raw = res.timeData || {};
    const isDate = Object.keys(raw).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    const all  = isDate ? raw : { [getDateKey(0)]: raw };
    let days = [];
    if      (range==="today")     days = [getDateKey(0)];
    else if (range==="yesterday") days = [getDateKey(1)];
    else if (range==="7days")     days = Array.from({length:7},(_,i)=>getDateKey(i));
    else if (range==="30days")    days = Array.from({length:30},(_,i)=>getDateKey(i));
    const catTime  = {};
    const siteTime = {};
    const siteCat  = {};
    userCategories.forEach(c => { catTime[c.id] = 0; });
    days.forEach(day => {
      const dd = all[day] || {};
      for (const site in dd) {
        const e  = dd[site];
        const ms = typeof e==="number" ? e : (e.time||0);
        const catId = getCatForDomain(site)?.id || "Other";
        catTime[catId]  = (catTime[catId]  || 0) + ms;
        siteTime[site]  = (siteTime[site]  || 0) + ms;
        siteCat[site]   = catId;
      }
    });
    renderStats(catTime, siteTime, siteCat);
    const now = Date.now();
    if (renderFromStorage._forceChart || now - _lastChartRender > 30000) {
      renderChart(catTime);
      _lastChartRender = now;
      renderFromStorage._forceChart = false;
    }
  });
}

/* ─── STATS ─── */
function renderStats(catTime, siteTime, siteCat) {
  const total = Object.values(catTime).reduce((a,b)=>a+b,0);
  const el = id => document.getElementById(id);
  if (el("totalTime")) el("totalTime").textContent = fmt(total);
  userCategories.forEach(cat => {
    const el2 = document.getElementById(`catTime-${cat.id}`);
    if (el2) el2.textContent = fmt(catTime[cat.id]||0);
  });
  const score = calcScore(catTime, total);
  if (el("productivityScore")) el("productivityScore").textContent = score < 0 ? "—" : score;
  if (el("scoreMood"))  el("scoreMood").textContent  = score < 0 ? "Start browsing" : scoreMood(score);
  if (el("scoreDesc"))  el("scoreDesc").textContent  = score < 0 ? "to see your score" : scoreDesc(score, total);
  const ul = el("topSites");
  if (!ul) return;
  ul.innerHTML = "";
  const sorted = Object.entries(siteTime).filter(([,t])=>t>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if (!sorted.length) {
    ul.innerHTML = `<li style="padding:12px 6px;color:var(--text-3);font-size:14px;">No data yet — browse some sites!</li>`;
    return;
  }
  const maxMs = sorted[0][1];
  sorted.forEach(([site, ms]) => {
    const cat = userCategories.find(c => c.id === (siteCat[site]||"Other"));
    const pct = maxMs > 0 ? Math.round((ms/maxMs)*100) : 0;
    const li  = document.createElement("li");
    li.innerHTML = `
      <span class="site-name" title="${site}">${site}</span>
      <div class="site-bar-wrap"><div class="site-bar" style="width:${pct}%;background:${cat?.color||'var(--accent)'}"></div></div>
      <span class="site-time">${fmt(ms)}</span>
    `;
    ul.appendChild(li);
  });
}

function calcScore(catTime, totalMs) {
  if (!totalMs || totalMs < 5 * 60 * 1000) return -1;
  const productive  = (catTime["Learning"] || 0) + (catTime["Development"] || 0);
  const distracting = catTime["Distraction"] || 0;
  const neutral     = catTime["Other"] || 0;
  let raw = ((productive/totalMs)*100) - ((distracting/totalMs)*60) + ((neutral/totalMs)*20);
  raw = Math.max(0, Math.min(100, raw));
  const conf = Math.min(totalMs/60000,60)/60;
  return Math.round(raw*conf + 45*(1-conf));
}
function scoreMood(s) {
  if (s>=85) return "Excellent day"; if (s>=70) return "Strong session";
  if (s>=55) return "Good progress"; if (s>=40) return "Balanced";
  if (s>=25) return "Distracted"; return "Off track";
}
function scoreDesc(score, total) {
  const hrs = (total/3600000).toFixed(1);
  if (score>=70) return `${hrs}h tracked · keep going`;
  if (score>=40) return `${hrs}h tracked · more learning helps`;
  return `${hrs}h tracked · time to refocus`;
}

/* ─── CHART ─── */
function renderChart(catTime) {
  const canvas = document.getElementById("timeChart");
  if (!canvas) return;
  const entries = userCategories
    .map(cat => ({ cat, ms: catTime[cat.id] || 0 }))
    .filter(e => e.ms > 0).sort((a,b) => b.ms - a.ms);
  const ctx = canvas.getContext("2d");
  if (timeChartInst) { timeChartInst.destroy(); timeChartInst = null; }
  if (!entries.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isDark = document.body.getAttribute("data-theme") === "dark";
    ctx.fillStyle = isDark ? "#5c5650" : "#a8a29e";
    ctx.textAlign = "center";
    ctx.font = "14px 'Instrument Sans', sans-serif";
    ctx.fillText("No data yet — start browsing", canvas.width/2, canvas.height/2);
    return;
  }
  if (typeof Chart === "undefined") return;
  const isDark  = document.body.getAttribute("data-theme") === "dark";
  const gridCol = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const textCol = isDark ? "#9c9490" : "#78716c";
  const labels     = entries.map(e => `${e.cat.emoji}  ${e.cat.name}`);
  const dataValues = entries.map(e => Math.round(e.ms/60000*10)/10);
  const bgColors   = entries.map(e => e.cat.color + "22");
  const bdColors   = entries.map(e => e.cat.color);
  timeChartInst = new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ data: dataValues, backgroundColor: bgColors, borderColor: bdColors, borderWidth: 2, borderRadius: 8, borderSkipped: false }] },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: true,
      animation: { duration: 400, easing: "easeOutQuart" },
      plugins: { legend: { display: false }, tooltip: {
        backgroundColor: isDark ? "#22252a" : "#fff", titleColor: isDark ? "#f2ede8" : "#1c1917",
        bodyColor: isDark ? "#9c9490" : "#78716c", borderColor: isDark ? "#2a2c2e" : "#e0dbd4",
        borderWidth: 1, padding: 12, cornerRadius: 10,
        callbacks: {
          title: items => items[0].label.replace(/^.\s+/,"").trim(),
          label: item  => `  ${fmtMin(item.raw)}  (${fmt(entries[item.dataIndex].ms)})`
        }
      }},
      scales: {
        x: { grid: { color: gridCol, drawBorder: false }, ticks: { color: textCol, font: { size:11 }, callback: v => fmtMin(v) }, border: { display: false } },
        y: { grid: { display: false, drawBorder: false }, ticks: { color: isDark ? "#f2ede8" : "#1c1917", font: { size:13 }, padding: 8 }, border: { display: false } }
      }
    },
    plugins: [{ id:"barLabels", afterDatasetsDraw(chart) {
      const { ctx:c, scales: { x } } = chart;
      dataValues.forEach((val,i) => {
        const meta = chart.getDatasetMeta(0).data[i];
        c.save(); c.font = "500 11px monospace"; c.fillStyle = bdColors[i];
        c.textAlign = "left"; c.textBaseline = "middle";
        c.fillText(fmt(entries[i].ms), x.getPixelForValue(val)+6, meta.y);
        c.restore();
      });
    }}]
  });
}
function fmtMin(mins) { return mins>=60 ? `${(mins/60).toFixed(1)}h` : `${Math.round(mins)}m`; }

/* ─── PREFS ─── */
async function loadPreferences() {
  try {
    const r = await fetch(`${API}/preferences`, { headers: hdrs() });
    if (!r.ok) throw new Error();
    const p = await r.json();
    currentTheme  = p.theme       || "light";
    currentAccent = p.accentColor || "indigo";
  } catch { currentTheme="light"; currentAccent="indigo"; }
  applyTheme(currentTheme, currentAccent);
}
function applyTheme(theme, accent) {
  document.body.setAttribute("data-theme",  theme);
  document.body.setAttribute("data-accent", accent);
  currentTheme  = theme;
  currentAccent = accent;
  const ts = document.getElementById("themeSelect");
  if (ts) ts.value = theme;
  document.querySelectorAll(".swatch").forEach(b => b.classList.toggle("on", b.dataset.color===accent));
}
async function saveSettings() {
  try {
    await fetch(`${API}/preferences`, { method:"POST", headers:hdrs(), body: JSON.stringify({ theme:currentTheme, accentColor:currentAccent }) });
    closeSettings(); toast("Settings saved");
  } catch { toast("Failed to save", "err"); }
}

/* ─── LOGOUT ─── */
async function logout() {
  if (!confirm("Sign out?")) return;
  try { await fetch(`${API}/auth/logout`,{method:"POST",headers:hdrs()}).catch(()=>{}); } catch {}
  chrome.runtime.sendMessage({type:"LOGOUT"},()=>void chrome.runtime.lastError);
  chrome.storage.local.remove(["authToken","lastValidated"],()=>{ location.href="auth.html"; });
}

/* ─── CATEGORY EDITOR ─── */

// isNewCat = true when creating a fresh category (not one of the 4 builtins)
let isNewCat = false;

function openNewCatEditor() {
  isNewCat        = true;
  editingCatId    = null;
  editDomains     = [];
  originalDomains = [];
  emojiPickerOpen = false;
  editColor       = "#6366f1";

  const title = document.getElementById("catEditorTitle");
  if (title) title.textContent = "➕ New Category";

  const emojiDisplay = document.getElementById("catEmojiDisplay");
  if (emojiDisplay) emojiDisplay.textContent = "📁";

  const colorPreview = document.getElementById("colorPreview");
  if (colorPreview) colorPreview.style.background = editColor;

  const hexInput = document.getElementById("colorHexInput");
  if (hexInput) hexInput.value = editColor;
  const nativeInput = document.getElementById("colorNativeInput");
  if (nativeInput) nativeInput.value = editColor;

  const nameInput = document.getElementById("catNameInput");
  if (nameInput) { nameInput.value = ""; nameInput.readOnly = false; nameInput.style.opacity = "1"; nameInput.placeholder = "Category name…"; nameInput.focus(); }

  const deleteBtn = document.getElementById("deleteCatBtn");
  if (deleteBtn) deleteBtn.style.display = "none";

  const emojiWrap = document.getElementById("emojiPickerWrap");
  if (emojiWrap) emojiWrap.style.display = "none";

  renderDomainTags();
  document.getElementById("catEditorModal").classList.add("open");
}

function openCatEditor(cat) {
  isNewCat        = false;
  editingCatId    = cat.id;
  editDomains     = [...(cat.domains || [])];
  originalDomains = [...(cat.domains || [])];
  emojiPickerOpen = false;
  editColor       = cat.color;

  const title = document.getElementById("catEditorTitle");
  if (title) title.textContent = `${cat.emoji} ${cat.name} — Edit`;

  const emojiDisplay = document.getElementById("catEmojiDisplay");
  if (emojiDisplay) emojiDisplay.textContent = cat.emoji;

  const colorPreview = document.getElementById("colorPreview");
  if (colorPreview) colorPreview.style.background = cat.color;

  const hexInput = document.getElementById("colorHexInput");
  if (hexInput) hexInput.value = cat.color;
  const nativeInput = document.getElementById("colorNativeInput");
  if (nativeInput) nativeInput.value = cat.color;

  const nameInput = document.getElementById("catNameInput");
  const isBuiltin = BUILTIN_CATS.some(b => b.id === cat.id);
  if (nameInput) {
    nameInput.value    = cat.name;
    nameInput.readOnly = isBuiltin;
    nameInput.style.opacity = isBuiltin ? "0.6" : "1";
  }

  const deleteBtn = document.getElementById("deleteCatBtn");
  // Only show delete for custom (non-builtin) categories
  if (deleteBtn) deleteBtn.style.display = isBuiltin ? "none" : "flex";

  const emojiWrap = document.getElementById("emojiPickerWrap");
  if (emojiWrap) emojiWrap.style.display = "none";

  renderDomainTags();
  document.getElementById("catEditorModal").classList.add("open");
}

function closeCatEditor() {
  document.getElementById("catEditorModal").classList.remove("open");
  editingCatId = null; originalDomains = []; isNewCat = false;
}

async function deleteCatFromEditor() {
  if (!editingCatId) return;
  const cat = userCategories.find(c => c.id === editingCatId);
  if (!cat || !cat.isCustom) { toast("Cannot delete built-in categories","err"); return; }
  if (!confirm(`Delete "${cat.name}"? All its domain mappings will be removed.`)) return;

  // Delete all domain mappings from server
  let hasError = false;
  for (const domain of (cat.domains || [])) {
    try {
      await fetch(`${API}/categories/${encodeURIComponent(domain)}`, { method:"DELETE", headers:hdrs() });
    } catch { hasError = true; }
  }

  // Remove from catCustomizations
  delete catCustomizations[editingCatId];
  await saveCatCustomizations();

  if (!hasError) toast(`"${cat.name}" deleted`);
  await loadCatCustomizations();
  await loadUserCategories();
  renderStatCards();
  renderFromStorage._forceChart = true;
  renderFromStorage();
  renderSettingsCatList();
  closeCatEditor();
  openSettings();
}

function renderDomainTags() {
  const wrap = document.getElementById("domainTags");
  if (!wrap) return;
  wrap.innerHTML = "";
  editDomains.forEach(d => {
    const tag = document.createElement("div");
    tag.className = "domain-tag";
    tag.innerHTML = `<span>${d}</span><button data-d="${d}" title="Remove">×</button>`;
    tag.querySelector("button").addEventListener("click", () => {
      editDomains = editDomains.filter(x => x !== d);
      renderDomainTags();
    });
    wrap.appendChild(tag);
  });
}

function addDomainToEdit() {
  const inp = document.getElementById("newDomainInput");
  if (!inp) return;
  let raw = inp.value.trim().toLowerCase();
  if (!raw) return;
  raw = raw.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0];
  if (!raw.includes(".")) { toast("Enter a valid domain (e.g. youtube.com)", "err"); return; }
  if (!editDomains.includes(raw)) editDomains.push(raw);
  inp.value = "";
  renderDomainTags();
}

/* FIX: saveCatEditor handles both NEW category creation and editing existing ones.
   New categories are stored as catCustomizations with a generated ID.
   Domains are saved to server as POST /categories {domain, category: newName}. */
async function saveCatEditor() {
  const emojiDisplay = document.getElementById("catEmojiDisplay");
  const nameInput    = document.getElementById("catNameInput");
  const currentEmoji = emojiDisplay?.textContent?.trim() || "📁";
  const currentName  = nameInput?.value?.trim();

  if (!currentName) { toast("Category name is required","err"); nameInput?.focus(); return; }

  let catId = editingCatId;

  if (isNewCat) {
    // For new categories: use the name as the ID (server stores category as a string)
    // Validate name isn't already taken
    const taken = [...BUILTIN_CATS, ...userCategories].some(c => c.name.toLowerCase() === currentName.toLowerCase());
    if (taken) { toast(`"${currentName}" already exists`,"err"); return; }
    catId = currentName; // server uses category name as the value
  }

  const toAdd    = isNewCat ? editDomains : editDomains.filter(d => !originalDomains.includes(d));
  const toRemove = isNewCat ? []          : originalDomains.filter(d => !editDomains.includes(d));
  let hasError   = false;

  // Save domain mappings to server
  for (const domain of toAdd) {
    try {
      const r = await fetch(`${API}/categories`, {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ domain, category: catId })
      });
      if (!r.ok) { const e=await r.json().catch(()=>{}); toast(`Failed to add ${domain}: ${e?.error||r.status}`,"err"); hasError=true; }
    } catch { toast(`Error adding ${domain}`,"err"); hasError=true; }
  }

  for (const domain of toRemove) {
    try {
      const r = await fetch(`${API}/categories/${encodeURIComponent(domain)}`, { method:"DELETE", headers:hdrs() });
      if (!r.ok) { toast(`Failed to remove ${domain}`,"err"); hasError=true; }
    } catch { toast(`Error removing ${domain}`,"err"); hasError=true; }
  }

  // Save color + emoji + name in catCustomizations (local storage)
  catCustomizations[catId] = {
    name:  currentName,
    emoji: currentEmoji,
    color: editColor,
  };
  await saveCatCustomizations();

  if (!hasError) toast(isNewCat ? `"${currentName}" created ✓` : "Category saved ✓");

  await loadCatCustomizations();
  await loadUserCategories();
  renderStatCards();
  renderFromStorage._forceChart = true;
  renderFromStorage();
  chrome.runtime.sendMessage({type:"SYNC_CATEGORIES"}, ()=>void chrome.runtime.lastError);
  renderSettingsCatList();
  closeCatEditor();
}

/* ─── EMOJI PICKER ─── */
const EMOJI_SET = ["📚","💻","⚠️","📦","🎯","🚀","🎮","📱","🌐","🔬","🧪","📊","💡","🎨","✍️","🎵","🎬","🏋️","🧘","🍕","☕","🛒","💼","📰","🗓️","📬","🔧","⚙️","🏠","🚗","✈️"];

function buildEmojiGrid() {
  const grid = document.getElementById("emojiGrid");
  if (!grid) return;
  EMOJI_SET.forEach(em => {
    const btn = document.createElement("button");
    btn.textContent = em;
    btn.addEventListener("click", () => {
      const d = document.getElementById("catEmojiDisplay");
      if (d) d.textContent = em;
      const w = document.getElementById("emojiPickerWrap");
      if (w) w.style.display = "none";
      emojiPickerOpen = false;
    });
    grid.appendChild(btn);
  });
}

/* ─── SETTINGS CAT LIST ─── */
function renderSettingsCatList() {
  const ul = document.getElementById("settingsCatList");
  if (!ul) return;
  ul.innerHTML = "";
  userCategories.forEach(cat => {
    const isCustom = cat.isCustom || false;
    const li = document.createElement("li");
    li.className = "cat-list-item";
    li.innerHTML = `
      <span class="cat-icon">${cat.emoji}</span>
      <div class="cat-meta">
        <span class="cat-name">${cat.name}</span>
        <span class="cat-domain-count">${cat.domains?.length||0} domain${(cat.domains?.length||0)===1?"":"s"}</span>
      </div>
      <div class="cat-color-dot" style="background:${cat.color};width:12px;height:12px;border-radius:50%;flex-shrink:0;"></div>
      <span class="${isCustom ? 'cat-custom-badge' : 'cat-system-badge'}" style="font-size:10px;padding:2px 6px;border-radius:10px;background:${isCustom?'#e0e7ff':'#f1f5f9'};color:${isCustom?'#6366f1':'#64748b'};">${isCustom?"custom":"system"}</span>
      <span class="cat-edit-arrow" style="color:var(--text-3,#9ca3af);font-size:18px;">›</span>
    `;
    li.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px 4px;cursor:pointer;border-bottom:1px solid var(--border,#f1f5f9);";
    li.addEventListener("click", () => { closeSettings(); openCatEditor(cat); });
    ul.appendChild(li);
  });
}

/* ─── BLOCKED SITES ─── 
   FIX: Merges sites from the server API AND from chrome.storage.local
   so that any site blocked locally (before sync, or while offline) 
   also shows up in the list. Both sources are deduplicated. */
async function loadBlockedSites() {
  const list = document.getElementById("blockedSitesList");
  if (!list) return;
  list.innerHTML = `<li style="padding:10px 6px;color:var(--text-3);font-size:13px;">Loading…</li>`;
  try {
    // Fetch from server and get focus status in parallel
    const [bRes, fRes, localData] = await Promise.all([
      fetch(`${API}/blocked-sites`, {headers:hdrs()}),
      new Promise(res => chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"}, r=>{void chrome.runtime.lastError;res(r||{status:false});})),
      // Also load any locally cached blocked sites from chrome.storage
      new Promise(res => chrome.storage.local.get(["blockedSites"], d=>{ void chrome.runtime.lastError; res(d.blockedSites||[]); }))
    ]);

    let serverSites = [];
    if (bRes.ok) {
      serverSites = await bRes.json();
      if (!Array.isArray(serverSites)) serverSites = [];
    }

    // Merge server + local, deduplicate
    const allSites = [...new Set([...serverSites, ...(Array.isArray(localData) ? localData : [])])].sort();
    const focusOn  = fRes.status || false;

    list.innerHTML = "";
    if (!allSites.length) {
      list.innerHTML = `<li style="padding:10px 6px;color:var(--text-3);font-size:14px;">No blocked sites yet</li>`;
      return;
    }
    allSites.forEach(site => {
      const li   = document.createElement("li");
      // Ensure li is flex row so button stays inline and never overflows
      li.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border,#e5e7eb);min-width:0;";
      const span = document.createElement("span");
      span.textContent = site;
      span.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;";
      const btn  = document.createElement("button");
      btn.className = "del-btn";
      btn.textContent = "×";
      btn.disabled = focusOn;
      btn.style.cssText = "flex-shrink:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border:none;background:var(--danger-bg,#fee2e2);color:var(--danger,#dc2626);border-radius:4px;cursor:pointer;font-size:16px;line-height:1;padding:0;";
      btn.title = focusOn ? "Stop focus first" : `Remove ${site}`;
      if (focusOn) btn.style.opacity = "0.4";
      btn.addEventListener("click", () => delBlockedSite(site));
      li.appendChild(span); li.appendChild(btn); list.appendChild(li);
    });
  } catch (err) {
    console.error("loadBlockedSites error:", err);
    list.innerHTML = `<li style="padding:10px;color:#dc2626;font-size:13px;">Failed to load — check connection</li>`;
  }
}

function normSite(raw) {
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  try { return new URL(s).hostname.replace(/^www\./,""); }
  catch { return raw.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0]; }
}

async function delBlockedSite(site) {
  try {
    // Remove from server
    const r = await fetch(`${API}/blocked-sites/${encodeURIComponent(site)}`,{method:"DELETE",headers:hdrs()});
    // Also remove from local storage regardless of server result
    await new Promise(resolve => {
      chrome.storage.local.get(["blockedSites"], d => {
        void chrome.runtime.lastError;
        const local = (d.blockedSites || []).filter(s => s !== site);
        chrome.storage.local.set({ blockedSites: local }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });
    if (!r.ok && r.status !== 404) throw new Error(`Server error ${r.status}`);
    chrome.runtime.sendMessage({type:"REMOVE_BLOCK_SITE",site},()=>void chrome.runtime.lastError);
    toast(`${site} removed`); loadBlockedSites();
  } catch (err) { toast(`Failed to remove: ${err.message}`,"err"); }
}

async function addBlockedSite() {
  const inp = document.getElementById("blockSiteInput");
  const btn = document.getElementById("addBlockSite");
  const raw = inp?.value.trim();
  if (!raw) { toast("Enter a domain","err"); return; }
  const nd = normSite(raw);
  if (!nd || !nd.includes(".")) { toast("Enter a valid domain","err"); return; }
  await loadAuthToken();
  if (btn) { btn.disabled=true; btn.textContent="…"; }
  try {
    // Save to server
    const r = await fetch(`${API}/blocked-sites`,{method:"POST",headers:hdrs(),body:JSON.stringify({site:nd})});
    if (!r.ok) { const e=await r.json().catch(()=>{}); throw new Error(e?.error||`Error ${r.status}`); }
    // Also save to local storage so it shows even when offline
    await new Promise(resolve => {
      chrome.storage.local.get(["blockedSites"], d => {
        void chrome.runtime.lastError;
        const local = d.blockedSites || [];
        if (!local.includes(nd)) local.push(nd);
        chrome.storage.local.set({ blockedSites: local }, () => { void chrome.runtime.lastError; resolve(); });
      });
    });
    if (inp) inp.value="";
    toast(`${nd} blocked`);
    chrome.runtime.sendMessage({type:"ADD_BLOCK_SITE",site:nd},()=>void chrome.runtime.lastError);
    loadBlockedSites();
  } catch(e) { toast(e.message||"Failed","err"); }
  finally { if (btn) { btn.disabled=false; btn.textContent="Block"; } }
}

/* ─── FOCUS ─── */
function updateFocusUI(on, locked) {
  document.getElementById("statusDot")?.classList.toggle("on", on);
  const lbl = document.getElementById("focusLabel");
  if (lbl) lbl.textContent = locked ? "Hard Focus — Locked" : on ? "On" : "Off";
  const startBtn = document.getElementById("startFocus");
  const hardBtn  = document.getElementById("hardFocus");
  const stopBtn  = document.getElementById("stopFocus");
  if (startBtn) startBtn.disabled = on;
  if (hardBtn)  hardBtn.disabled  = on;
  if (stopBtn)  stopBtn.disabled  = !on || locked;
}

function reloadCurrentIfBlocked() {
  fetch(`${API}/blocked-sites`,{headers:hdrs()}).then(r=>r.json()).then(blocked => {
    if (!blocked.length) return;
    chrome.tabs.query({active:true,lastFocusedWindow:true}, tabs=>{
      void chrome.runtime.lastError;
      if (!tabs?.length||!tabs[0]?.url) return;
      try {
        const host = new URL(tabs[0].url).hostname.replace(/^www\./,"");
        if (blocked.some(s=>host===s||host.endsWith("."+s))) chrome.tabs.reload(tabs[0].id);
      } catch {}
    });
  }).catch(()=>{});
}

function initFocusControls() {
  document.getElementById("startFocus")?.addEventListener("click",()=>{
    chrome.runtime.sendMessage({type:"FOCUS_ON",duration:25,hard:false}, res=>{
      void chrome.runtime.lastError;
      if (res?.success) { toast("Focus on — 25 min"); updateFocusUI(true,false); reloadCurrentIfBlocked(); }
      else toast(res?.error||"Could not start","err");
    });
  });
  document.getElementById("hardFocus")?.addEventListener("click",()=>{
    const m = parseInt(prompt("Hard Focus duration (min, min 5):","25"),10);
    if (!m||m<5) { toast("Min 5 minutes","err"); return; }
    chrome.runtime.sendMessage({type:"FOCUS_ON",duration:m,hard:true}, res=>{
      void chrome.runtime.lastError;
      if (res?.success) { toast(`Hard focus — ${m} min, locked`); updateFocusUI(true,true); reloadCurrentIfBlocked(); }
      else toast(res?.error||"Could not start","err");
    });
  });
  document.getElementById("stopFocus")?.addEventListener("click",()=>{
    chrome.runtime.sendMessage({type:"FOCUS_OFF"}, res=>{
      void chrome.runtime.lastError;
      if (res?.success) { toast("Focus off"); updateFocusUI(false,false); }
      else toast(res?.error||"Could not stop","err");
    });
  });
  chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"}, res=>{
    void chrome.runtime.lastError;
    if (res) updateFocusUI(res.status, res.locked);
  });
}

/* ─── REFLECTION ─── */
async function loadReflection() {
  try {
    const r = await fetch(`${API}/reflections/${getTodayKey()}`,{headers:hdrs()});
    if (!r.ok) return;
    const d = await r.json();
    if (d?.date) {
      const f = id => document.getElementById(id);
      if (f("reflectionDistractions")) f("reflectionDistractions").value = d.distractions||"";
      if (f("reflectionWentWell"))     f("reflectionWentWell").value     = d.wentWell||"";
      if (f("reflectionImprovements")) f("reflectionImprovements").value = d.improvements||"";
    }
  } catch {}
}

async function saveReflection() {
  try {
    const r = await fetch(`${API}/reflections`,{
      method:"POST",headers:hdrs(),
      body:JSON.stringify({
        date: getTodayKey(),
        distractions: document.getElementById("reflectionDistractions")?.value,
        wentWell:     document.getElementById("reflectionWentWell")?.value,
        improvements: document.getElementById("reflectionImprovements")?.value,
      })
    });
    if (!r.ok) throw new Error();
    const chip = document.getElementById("reflectionSaved");
    if (chip) { chip.style.display="block"; setTimeout(()=>chip.style.display="none",3000); }
    toast("Reflection saved");
  } catch { toast("Failed to save","err"); }
}

/* ─── WEEKLY ─── */
async function loadWeeklySummary() {
  const today=new Date(), wago=new Date(today);
  wago.setDate(wago.getDate()-7);
  try {
    const r = await fetch(`${API}/reflections?startDate=${wago.toISOString().split("T")[0]}&endDate=${today.toISOString().split("T")[0]}`,{headers:hdrs()});
    allWeeklyData = r.ok ? await r.json() : [];
    renderWeekly();
  } catch { const el=document.getElementById("weeklySummary"); if(el) el.innerHTML=`<p class="empty-text">Could not load</p>`; }
}

function renderWeekly() {
  const cont=document.getElementById("weeklySummary");
  const allBox=document.getElementById("summaryAll");
  const btn=document.getElementById("showAllBtn");
  if (!cont) return;
  if (!allWeeklyData.length) { cont.innerHTML=`<p class="empty-text">No reflections yet</p>`; if(btn) btn.style.display="none"; return; }
  cont.innerHTML="";
  const entries=document.createElement("div"); entries.className="summary-entries";
  [allWeeklyData[0]].forEach(r=>entries.appendChild(makeSummaryEl(r)));
  cont.appendChild(entries);
  if (!btn) return;
  if (allWeeklyData.length<=1) { btn.style.display="none"; return; }
  btn.style.display="block";
  btn.textContent = showingAll ? "Show less" : `Show all ${allWeeklyData.length} entries`;
  if (allBox) {
    allBox.innerHTML="";
    if (showingAll) { allWeeklyData.slice(1).forEach(r=>allBox.appendChild(makeSummaryEl(r))); allBox.classList.add("open"); }
    else allBox.classList.remove("open");
  }
}

function makeSummaryEl(ref) {
  const item=document.createElement("div"); item.className="summary-item";
  const date=document.createElement("div"); date.className="summary-date";
  date.textContent=new Date(ref.date+"T00:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
  const text=document.createElement("div"); text.className="summary-text";
  const parts=[];
  if (ref.wentWell) parts.push(`+ ${ref.wentWell.slice(0,90)}${ref.wentWell.length>90?"…":""}`);
  if (ref.distractions) parts.push(`- ${ref.distractions.slice(0,70)}${ref.distractions.length>70?"…":""}`);
  text.textContent=parts.join(" · ");
  item.appendChild(date); item.appendChild(text);
  return item;
}

/* ─── EXPORT ─── */
function dl(content,name,type) {
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

/* ─── MODALS ─── */
function openSettings() { renderSettingsCatList(); document.getElementById("settingsModal").classList.add("open"); }
function closeSettings() { document.getElementById("settingsModal").classList.remove("open"); }

/* ─── TOAST ─── */
function toast(msg, type="ok") {
  const c=document.getElementById("toastContainer");
  if (!c) return;
  const t=document.createElement("div"); t.className=`toast ${type}`; t.textContent=msg;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(()=>t.remove(),350); },2800);
}

/* ─── UTILS ─── */
function fmt(ms) {
  if (!ms||ms<=0) return "0 sec";
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m`; if (m>0) return `${m} min`; return `${s} sec`;
}

/* ─── EVENTS ─── */
function initEventListeners() {
  document.getElementById("settingsBtn")?.addEventListener("click", openSettings);
  document.getElementById("refreshBtn")?.addEventListener("click",  ()=>location.reload());
  document.getElementById("closeSettings")?.addEventListener("click", closeSettings);
  document.getElementById("settingsModal")?.addEventListener("click", e=>{ if(e.target===document.getElementById("settingsModal")) closeSettings(); });
  document.getElementById("saveSettingsBtn")?.addEventListener("click", saveSettings);
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
  document.getElementById("themeSelect")?.addEventListener("change", e=>applyTheme(e.target.value, currentAccent));
  document.querySelectorAll(".swatch").forEach(b=>b.addEventListener("click",()=>applyTheme(currentTheme,b.dataset.color)));

  // ── ADD CATEGORY button in settings ──
  document.getElementById("addCatBtn")?.addEventListener("click", () => {
    closeSettings();
    openNewCatEditor();
  });

  document.getElementById("closeCatEditor")?.addEventListener("click", closeCatEditor);
  document.getElementById("catEditorModal")?.addEventListener("click", e=>{ if(e.target===document.getElementById("catEditorModal")) closeCatEditor(); });
  document.getElementById("cancelCatEditor")?.addEventListener("click", closeCatEditor);
  document.getElementById("saveCatBtn")?.addEventListener("click", saveCatEditor);
  document.getElementById("deleteCatBtn")?.addEventListener("click", deleteCatFromEditor);
  document.getElementById("emojiPickerBtn")?.addEventListener("click",()=>{
    emojiPickerOpen=!emojiPickerOpen;
    const w=document.getElementById("emojiPickerWrap"); if(w) w.style.display=emojiPickerOpen?"block":"none";
  });
  document.getElementById("addDomainBtn")?.addEventListener("click", addDomainToEdit);
  document.getElementById("newDomainInput")?.addEventListener("keypress", e=>{ if(e.key==="Enter") addDomainToEdit(); });
  document.getElementById("colorNativeInput")?.addEventListener("input", e=>{
    editColor = e.target.value;
    const h=document.getElementById("colorHexInput"); if(h) h.value=editColor;
    const p=document.getElementById("colorPreview"); if(p) p.style.background=editColor;
  });
  document.getElementById("colorHexInput")?.addEventListener("input", e=>{
    const v=e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      editColor = v;
      const n=document.getElementById("colorNativeInput"); if(n) n.value=v;
      const p=document.getElementById("colorPreview"); if(p) p.style.background=v;
    }
  });

  document.getElementById("addBlockSite")?.addEventListener("click", addBlockedSite);
  document.getElementById("blockSiteInput")?.addEventListener("keypress",e=>{ if(e.key==="Enter") addBlockedSite(); });
  document.getElementById("saveReflection")?.addEventListener("click", saveReflection);
  document.getElementById("rangeSelect")?.addEventListener("change", ()=>{ _lastChartRender=0; renderFromStorage(); });
  document.getElementById("showAllBtn")?.addEventListener("click",()=>{ showingAll=!showingAll; renderWeekly(); });
  document.getElementById("exportJsonBtn")?.addEventListener("click",()=>{
    chrome.storage.local.get(["timeData"],res=>dl(JSON.stringify(res.timeData||{},null,2),`focus-${getTodayKey()}.json`,"application/json"));
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click",()=>{
    chrome.storage.local.get(["timeData"],res=>{
      const d=res.timeData||{}; let csv="Date,Website,Category,Time(ms),Time(min)\n";
      for(const date in d) for(const site in d[date]){
        const e=d[date][site],ms=typeof e==="number"?e:(e.time||0),cat=typeof e==="object"?(e.category||"Other"):"Other";
        csv+=`${date},${site},${cat},${ms},${(ms/60000).toFixed(1)}\n`;
      }
      dl(csv,`focus-${getTodayKey()}.csv`,"text/csv");
    });
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==="local"&&(changes.focusMode||changes.focusLockUntil)){
      chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"},res=>{
        void chrome.runtime.lastError; if(res) updateFocusUI(res.status,res.locked);
      });
      loadBlockedSites();
    }
  });
}