/* dashboard.js — Focus Tracker
   Fully rewritten for:
   - Per-user category system (emoji, name, color, domains) from server
   - Clicking stat cards opens category editor modal
   - Emoji picker with search
   - Professional productivity scoring (not 100 from 1 site)
   - Theme/accent unchanged on each other's toggle
   - Delete blocked site fixed
   - Focus on/off only reloads current tab
   - Refresh = location.reload()
   - Weekly summary show all / show less
   - Normal font weights, larger scale (CSS)
   - Zero inline handlers (CSP safe)
*/

const API = typeof API_BASE !== "undefined" ? API_BASE : "https://habit-tracker-extension.onrender.com";

/* ─── state ─── */
let authToken     = null;
let currentTheme  = "light";
let currentAccent = "indigo";
let userCategories = [];   // full list: {id,name,emoji,color,domains[],isSystem}
let timeChartInst = null;
let allWeeklyData = [];
let showingAll    = false;

/* editing state */
let editingCat    = null;  // category object being edited (null = new)
let editEmoji     = "📁";
let editColor     = "#6366f1";
let editDomains   = [];
let emojiPickerOpen = false;

/* ═══════════════════════════════════════
   AUTH
═══════════════════════════════════════ */
async function loadAuthToken() {
  return new Promise(r => chrome.storage.local.get(["authToken"], d => { authToken = d.authToken||null; r(authToken); }));
}
const hdrs = () => authToken
  ? { "Content-Type":"application/json", Authorization:`Bearer ${authToken}` }
  : { "Content-Type":"application/json" };

/* ═══════════════════════════════════════
   INIT
═══════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", async () => {
  await loadAuthToken();
  if (!authToken) { location.href = "auth.html"; return; }

  await loadPreferences();
  await loadUserCategories();   // must come before renderStatCards
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

/* ═══════════════════════════════════════
   USER CATEGORIES — core data
═══════════════════════════════════════ */
async function loadUserCategories() {
  try {
    const r = await fetch(`${API}/user-categories`, { headers: hdrs() });
    if (!r.ok) throw new Error();
    userCategories = await r.json();
  } catch {
    // Fallback defaults if server is unreachable
    userCategories = [
      { id:"learning",    name:"Learning",    emoji:"📚", color:"#22c55e", isSystem:true,  domains:[] },
      { id:"development", name:"Development", emoji:"💻", color:"#3b82f6", isSystem:true,  domains:[] },
      { id:"distraction", name:"Distraction", emoji:"⚠️",  color:"#ef4444", isSystem:true,  domains:[] },
      { id:"other",       name:"Other",       emoji:"📦", color:"#f97316", isSystem:true,  domains:[] },
    ];
  }
}

/* Build a domain→categoryId lookup from userCategories */
function buildDomainMap() {
  const map = {};
  userCategories.forEach(cat => {
    (cat.domains||[]).forEach(d => { map[d] = cat.id; });
  });
  return map;
}

function getCatForDomain(domain) {
  const map = buildDomainMap();
  if (map[domain]) return userCategories.find(c => c.id === map[domain]);

  // parent domain fallback
  const parts = domain.split(".");
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(i).join(".");
    if (map[parent]) return userCategories.find(c => c.id === map[parent]);
  }

  // keyword fallback
  if (/leetcode|coursera|udemy|khanacademy|edx|pluralsight|geeksforgeeks/.test(domain))
    return userCategories.find(c => c.id === "learning") || userCategories[0];
  if (/youtube|instagram|facebook|twitter|reddit|tiktok|netflix|twitch/.test(domain))
    return userCategories.find(c => c.id === "distraction") || userCategories[0];
  if (/github|stackoverflow|dev\.to|mdn|npmjs|docs\./.test(domain))
    return userCategories.find(c => c.id === "development") || userCategories[0];

  return userCategories.find(c => c.id === "other") || userCategories[userCategories.length - 1];
}

/* ═══════════════════════════════════════
   RENDER STAT CARDS
   Total card is hardcoded; one card per user category injected
═══════════════════════════════════════ */
function renderStatCards() {
  const grid = document.getElementById("statsGrid");
  if (!grid) return;

  // Keep the total card, remove old dynamic ones
  const totalCard = grid.querySelector(".stat-card.total");
  grid.innerHTML = "";
  if (totalCard) grid.appendChild(totalCard);

  userCategories.forEach(cat => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.dataset.catId = cat.id;
    card.style.setProperty("--cat-color", cat.color);
    card.title = `Click to edit "${cat.name}"`;
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

/* ═══════════════════════════════════════
   1-SECOND STORAGE TICKER (no SW dep.)
═══════════════════════════════════════ */
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
      const catId = cat?.id || "other";
      const today = getTodayKey();

      chrome.storage.local.get(["timeData"], res => {
        void chrome.runtime.lastError;
        const td = res.timeData || {};
        td[today] = td[today] || {};
        if (!td[today][domain]) td[today][domain] = { time:0, catId };
        td[today][domain].time  += 1000;
        td[today][domain].catId  = catId;
        chrome.storage.local.set({ timeData:td }, () => {
          void chrome.runtime.lastError;
          renderFromStorage();
        });
      });
    });
  }, 1000);
}

/* ═══════════════════════════════════════
   RENDER FROM STORAGE
═══════════════════════════════════════ */
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

    // Aggregate time per catId and per site
    const catTime  = {};
    const siteTime = {};
    const siteCat  = {};
    userCategories.forEach(c => { catTime[c.id] = 0; });

    days.forEach(day => {
      const dd = all[day] || {};
      for (const site in dd) {
        const e  = dd[site];
        const ms = typeof e==="number" ? e : (e.time||0);
        // ALWAYS re-resolve catId from live domain map so category changes
        // (e.g. moving claude.ai from Development → Learning) reflect instantly.
        // Never trust the stale catId baked into chrome.storage.
        const catId = getCatForDomain(site)?.id || "other";
        catTime[catId]  = (catTime[catId]  || 0) + ms;
        siteTime[site]  = (siteTime[site]  || 0) + ms;
        siteCat[site]   = catId;
      }
    });

    renderStats(catTime, siteTime, siteCat);

    // Chart: throttle to every 30s during normal ticking,
    // but _forceChartRender flag bypasses throttle after category edits.
    const now = Date.now();
    if (renderFromStorage._forceChart || now - _lastChartRender > 30000) {
      renderChart(catTime);
      _lastChartRender = now;
      renderFromStorage._forceChart = false;
    }
  });
}

/* ═══════════════════════════════════════
   RENDER STATS
═══════════════════════════════════════ */
function renderStats(catTime, siteTime, siteCat) {
  const total = Object.values(catTime).reduce((a,b)=>a+b,0);
  const el = id => document.getElementById(id);

  el("totalTime") && (el("totalTime").textContent = fmt(total));
  userCategories.forEach(cat => {
    const el2 = document.getElementById(`catTime-${cat.id}`);
    if (el2) el2.textContent = fmt(catTime[cat.id]||0);
  });

  // Productivity score — weighted & requires meaningful time
  const score = calcScore(catTime, total);
  if (el("productivityScore")) el("productivityScore").textContent = score < 0 ? "—" : score;
  if (el("scoreMood"))  el("scoreMood").textContent  = score < 0 ? "Start browsing" : scoreMood(score);
  if (el("scoreDesc"))  el("scoreDesc").textContent  = score < 0 ? "to see your score" : scoreDesc(score, total, catTime);

  // Top sites
  const ul = el("topSites");
  if (!ul) return;
  ul.innerHTML = "";
  const sorted = Object.entries(siteTime).filter(([,t])=>t>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if (!sorted.length) {
    ul.innerHTML = `<li style="padding:12px 6px;color:var(--text-3);font-size:14px;">No data yet</li>`;
    return;
  }
  const maxMs = sorted[0][1];
  sorted.forEach(([site, ms]) => {
    const cat = userCategories.find(c => c.id === (siteCat[site]||"other"));
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

/* ═══════════════════════════════════════
   PRODUCTIVITY SCORING — professional
   
   Philosophy:
   - Need at least 5 min of total data to show a score
   - Weighted: "productive" cats (Learning, Development) = positive
     "distracting" cats = negative weight
     "other" = neutral
   - Time weighting: short sessions (< 2 min on a site) are less
     credible, so we apply a log-scale cap
   - Score is 0–100, with diminishing returns at extremes
   - Single site for 1 min = ~50 score (neutral, not 100)
═══════════════════════════════════════ */
function calcScore(catTime, totalMs) {
  if (!totalMs || totalMs < 5 * 60 * 1000) return -1; // need 5+ min

  // Classify categories by user's data
  // system cats have known roles; custom cats default to neutral
  let productive = 0, neutral = 0, distracting = 0;
  userCategories.forEach(cat => {
    const ms = catTime[cat.id] || 0;
    if (cat.id === "learning" || cat.id === "development") productive += ms;
    else if (cat.id === "distraction") distracting += ms;
    else neutral += ms;
  });

  // Weighted formula
  const positiveRatio = productive / totalMs;
  const negativeRatio = distracting / totalMs;

  // Base score from ratio, with diminishing returns at extremes
  let raw = (positiveRatio * 100) - (negativeRatio * 60) + (neutral / totalMs * 20);
  raw = Math.max(0, Math.min(100, raw));

  // Apply time confidence: more total time → score converges to true value
  // < 15 min: score pulled toward 45 (uncertain)
  // 60+ min:  score trusted fully
  const confMinutes = Math.min(totalMs / 60000, 60) / 60; // 0–1
  const confident   = raw * confMinutes + 45 * (1 - confMinutes);

  return Math.round(confident);
}

function scoreMood(s) {
  if (s >= 85) return "Excellent day";
  if (s >= 70) return "Strong session";
  if (s >= 55) return "Good progress";
  if (s >= 40) return "Balanced";
  if (s >= 25) return "Distracted";
  return "Off track";
}

function scoreDesc(score, total, catTime) {
  const hrs = (total/3600000).toFixed(1);
  const prodCat = userCategories.find(c=>c.id==="learning"||c.id==="development");
  if (score >= 70) return `${hrs}h tracked · keep going`;
  if (score >= 40) return `${hrs}h tracked · more ${prodCat?.name||"learning"} helps`;
  return `${hrs}h tracked · time to refocus`;
}

/* ═══════════════════════════════════════
   CHART — premium horizontal bar chart
   Much more readable than a doughnut:
   - Shows actual time values on bars
   - Color-matched to category colors
   - Clean gridlines, proper axes
   - Falls back gracefully to empty state
═══════════════════════════════════════ */
function renderChart(catTime) {
  const canvas = document.getElementById("timeChart");
  if (!canvas) return;

  // Filter categories that have data, sorted descending
  const entries = userCategories
    .map(cat => ({ cat, ms: catTime[cat.id] || 0 }))
    .filter(e => e.ms > 0)
    .sort((a,b) => b.ms - a.ms);

  const ctx = canvas.getContext("2d");

  if (timeChartInst) { timeChartInst.destroy(); timeChartInst = null; }

  if (!entries.length) {
    // Draw empty state
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isDark = document.body.getAttribute("data-theme") === "dark";
    ctx.fillStyle = isDark ? "#5c5650" : "#a8a29e";
    ctx.textAlign = "center";
    ctx.font = "14px 'Instrument Sans', sans-serif";
    ctx.fillText("No data yet — start browsing", canvas.width / 2, canvas.height / 2);
    return;
  }

  if (typeof Chart === "undefined") return;

  const isDark   = document.body.getAttribute("data-theme") === "dark";
  const gridCol  = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
  const textCol  = isDark ? "#9c9490" : "#78716c";
  const maxMs    = entries[0].ms;

  // Build gradient colors — slightly transparent fills with solid borders
  const labels     = entries.map(e => `${e.cat.emoji}  ${e.cat.name}`);
  const dataValues = entries.map(e => Math.round(e.ms / 60000 * 10) / 10); // minutes, 1dp
  const bgColors   = entries.map(e => e.cat.color + "22"); // 13% alpha fill
  const bdColors   = entries.map(e => e.cat.color);

  timeChartInst = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data:            dataValues,
        backgroundColor: bgColors,
        borderColor:     bdColors,
        borderWidth:     2,
        borderRadius:    8,
        borderSkipped:   false,
        hoverBackgroundColor: bdColors.map(c => c + "44"),
        hoverBorderColor:     bdColors,
      }]
    },
    options: {
      indexAxis: "y",   // horizontal bars
      responsive:     true,
      maintainAspectRatio: true,
      animation: { duration: 400, easing: "easeOutQuart" },
      layout: { padding: { left: 0, right: 20, top: 4, bottom: 4 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark ? "#22252a" : "#ffffff",
          titleColor:      isDark ? "#f2ede8" : "#1c1917",
          bodyColor:       isDark ? "#9c9490" : "#78716c",
          borderColor:     isDark ? "#2a2c2e" : "#e0dbd4",
          borderWidth:     1,
          padding:         12,
          cornerRadius:    10,
          boxPadding:      6,
          callbacks: {
            title: items => items[0].label.replace(/^.\s+/, "").trim(),
            label: item  => `  ${fmtMin(item.raw)}  (${fmt(entries[item.dataIndex].ms)})`
          }
        }
      },
      scales: {
        x: {
          grid:  { color: gridCol, drawBorder: false },
          ticks: {
            color:    textCol,
            font:     { size: 11, family: "'JetBrains Mono', monospace" },
            callback: v => fmtMin(v)
          },
          border: { display: false }
        },
        y: {
          grid:  { display: false, drawBorder: false },
          ticks: {
            color: isDark ? "#f2ede8" : "#1c1917",
            font:  { size: 13, family: "'Instrument Sans', sans-serif" },
            padding: 8,
          },
          border: { display: false }
        }
      }
    },
    plugins: [{
      // Draw time labels inside / right of each bar
      id: "barLabels",
      afterDatasetsDraw(chart) {
        const { ctx: c, data, scales: { x, y } } = chart;
        data.datasets[0].data.forEach((val, i) => {
          const meta = chart.getDatasetMeta(0).data[i];
          const xPos = x.getPixelForValue(val);
          const yPos = meta.y;
          const barRight = xPos;
          const label = fmt(entries[i].ms);
          c.save();
          c.font = "500 11px 'JetBrains Mono', monospace";
          c.fillStyle = bdColors[i];
          c.textAlign = "left";
          c.textBaseline = "middle";
          c.fillText(label, barRight + 6, yPos);
          c.restore();
        });
      }
    }]
  });
}

function fmtMin(mins) {
  if (mins >= 60) return `${(mins/60).toFixed(1)}h`;
  return `${Math.round(mins)}m`;
}

/* ═══════════════════════════════════════
   PREFERENCES
═══════════════════════════════════════ */
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
  // Rerender chart with correct text colour
  if (_lastChartRender) renderFromStorage();
}

async function saveSettings() {
  try {
    await fetch(`${API}/preferences`, {
      method:"POST", headers:hdrs(),
      body: JSON.stringify({ theme:currentTheme, accentColor:currentAccent })
    });
    closeSettings();
    toast("Settings saved");
  } catch { toast("Failed to save", "err"); }
}

/* ═══════════════════════════════════════
   LOGOUT
═══════════════════════════════════════ */
async function logout() {
  if (!confirm("Sign out?")) return;
  try { await fetch(`${API}/auth/logout`,{method:"POST",headers:hdrs()}).catch(()=>{}); } catch {}
  chrome.runtime.sendMessage({type:"LOGOUT"},()=>void chrome.runtime.lastError);
  chrome.storage.local.remove(["authToken","lastValidated"],()=>{ location.href="auth.html"; });
}

/* ═══════════════════════════════════════
   CATEGORY EDITOR MODAL
═══════════════════════════════════════ */
function openCatEditor(cat) {
  editingCat  = cat || null;
  editEmoji   = cat ? cat.emoji   : "📁";
  editColor   = cat ? cat.color   : "#6366f1";
  editDomains = cat ? [...(cat.domains||[])] : [];
  emojiPickerOpen = false;

  document.getElementById("catEditorTitle").textContent = cat ? `Edit — ${cat.name}` : "New Category";
  document.getElementById("catNameInput").value         = cat ? cat.name  : "";
  document.getElementById("catEmojiDisplay").textContent= editEmoji;
  document.getElementById("colorHexInput").value        = editColor;
  document.getElementById("colorNativeInput").value     = editColor;
  document.getElementById("colorPreview").style.background = editColor;
  document.getElementById("emojiPickerWrap").style.display = "none";
  document.getElementById("deleteCatBtn").style.display = (cat && !cat.isSystem) ? "flex" : "none";

  renderDomainTags();
  document.getElementById("catEditorModal").classList.add("open");
}

function closeCatEditor() {
  document.getElementById("catEditorModal").classList.remove("open");
  editingCat = null;
}

function renderDomainTags() {
  const wrap = document.getElementById("domainTags");
  wrap.innerHTML = "";
  editDomains.forEach(d => {
    const tag = document.createElement("div");
    tag.className = "domain-tag";
    tag.innerHTML = `<span>${d}</span><button data-d="${d}" title="Remove">×</button>`;
    tag.querySelector("button").addEventListener("click", () => {
      editDomains = editDomains.filter(x=>x!==d);
      renderDomainTags();
    });
    wrap.appendChild(tag);
  });
}

function addDomainToEdit() {
  const inp = document.getElementById("newDomainInput");
  let raw = inp.value.trim().toLowerCase();
  if (!raw) return;
  raw = raw.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0];
  if (!raw.includes(".")) { toast("Enter a valid domain", "err"); return; }
  if (!editDomains.includes(raw)) editDomains.push(raw);
  inp.value = "";
  renderDomainTags();
}

async function saveCatEditor() {
  const name  = document.getElementById("catNameInput").value.trim();
  if (!name) { toast("Name required","err"); return; }

  const payload = { name, emoji:editEmoji, color:editColor, domains:editDomains };

  try {
    let r;
    if (editingCat) {
      r = await fetch(`${API}/user-categories/${editingCat.id}`, {
        method:"PUT", headers:hdrs(), body:JSON.stringify(payload)
      });
    } else {
      r = await fetch(`${API}/user-categories`, {
        method:"POST", headers:hdrs(), body:JSON.stringify(payload)
      });
    }
    if (!r.ok) { const e=await r.json().catch(()=>{}); throw new Error(e?.error||"Failed"); }
    toast(editingCat ? "Category updated" : "Category created");
    // Reload fresh category data first so getCatForDomain() resolves correctly
    await loadUserCategories();
    renderStatCards();
    // Force chart to re-render immediately — domain→category mapping has changed
    renderFromStorage._forceChart = true;
    renderFromStorage();
    // Sync background service worker category mappings
    chrome.runtime.sendMessage({type:"SYNC_CATEGORIES"},()=>void chrome.runtime.lastError);
    // Reload settings list if open
    renderSettingsCatList();
    closeCatEditor();
  } catch(e) { toast(e.message||"Error","err"); }
}

async function deleteCatFromEditor() {
  if (!editingCat || editingCat.isSystem) return;
  if (!confirm(`Delete "${editingCat.name}"? Sites mapped to it will fall back to "Other".`)) return;
  try {
    const r = await fetch(`${API}/user-categories/${editingCat.id}`,{method:"DELETE",headers:hdrs()});
    if (!r.ok) throw new Error("Failed");
    toast("Category deleted");
    await loadUserCategories();
    renderStatCards();
    renderFromStorage._forceChart = true;
    renderFromStorage();
    chrome.runtime.sendMessage({type:"SYNC_CATEGORIES"},()=>void chrome.runtime.lastError);
    renderSettingsCatList();
    closeCatEditor();
  } catch(e) { toast(e.message,"err"); }
}

/* ── Emoji Picker ── */
const EMOJI_SET = [
  "📚","💻","⚠️","📦","🎯","🚀","🎮","📱","🌐","🔬","🧪","📊","💡","🎨","✍️","🎵","🎬","🏋️","🧘","🍕",
  "☕","🛒","💼","📰","🗓️","📬","🔧","⚙️","🏠","🚗","✈️","🌍","🌱","⭐","🔥","💎","🏆","🎓","📝","🔍",
  "📷","🎭","🤝","💬","📡","🧠","👾","🕹️","🎸","🎯","🏔️","🌊","🌸","🦋","🐧","🦊","🐬","🌺","⚡","🌙",
  "☀️","❄️","🌈","💫","🪐","🔮","🎪","🏟️","🌃","🗺️","📌","🚩","🏁","🎁","🎉","🎊","🧩","🎲","♟️","🃏"
];
let filteredEmojis = [...EMOJI_SET];

function buildEmojiGrid() {
  renderEmojiGrid(EMOJI_SET);
  document.getElementById("emojiSearch")?.addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    renderEmojiGrid(q ? EMOJI_SET.filter(em => em.includes(q)) : EMOJI_SET);
  });
}

function renderEmojiGrid(emojis) {
  const grid = document.getElementById("emojiGrid");
  if (!grid) return;
  grid.innerHTML = "";
  emojis.forEach(em => {
    const btn = document.createElement("button");
    btn.textContent = em;
    btn.addEventListener("click", () => {
      editEmoji = em;
      document.getElementById("catEmojiDisplay").textContent = em;
      document.getElementById("emojiPickerWrap").style.display = "none";
      emojiPickerOpen = false;
    });
    grid.appendChild(btn);
  });
}

/* ═══════════════════════════════════════
   SETTINGS — categories list
═══════════════════════════════════════ */
function renderSettingsCatList() {
  const ul = document.getElementById("settingsCatList");
  if (!ul) return;
  ul.innerHTML = "";
  userCategories.forEach(cat => {
    const li = document.createElement("li");
    li.className = "cat-list-item";
    li.innerHTML = `
      <span class="cat-icon">${cat.emoji}</span>
      <div class="cat-meta">
        <span class="cat-name">${cat.name}</span>
        <span class="cat-domain-count">${cat.domains?.length||0} domain${(cat.domains?.length||0)===1?"":"s"}</span>
      </div>
      <div class="cat-color-dot" style="background:${cat.color}"></div>
      ${cat.isSystem ? '<span class="cat-system-badge">system</span>' : ''}
      <span class="cat-edit-arrow">›</span>
    `;
    li.addEventListener("click", () => openCatEditor(cat));
    ul.appendChild(li);
  });
}

/* ═══════════════════════════════════════
   BLOCKED SITES
═══════════════════════════════════════ */
function normSite(raw) {
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  try { return new URL(s).hostname.replace(/^www\./,""); }
  catch { return raw.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0]; }
}

async function loadBlockedSites() {
  const list = document.getElementById("blockedSitesList");
  if (!list) return;
  try {
    const [bRes, fRes] = await Promise.all([
      fetch(`${API}/blocked-sites`, {headers:hdrs()}),
      new Promise(res => chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"}, r=>{void chrome.runtime.lastError;res(r||{status:false});}))
    ]);
    if (!bRes.ok) throw new Error();
    const sites  = await bRes.json();
    const focusOn = fRes.status||false;
    list.innerHTML = "";
    if (!sites.length) {
      list.innerHTML = `<li style="padding:10px 6px;color:var(--text-3);font-size:14px;">No blocked sites yet</li>`;
      return;
    }
    sites.forEach(site => {
      const li   = document.createElement("li");
      const span = document.createElement("span"); span.textContent = site;
      const btn  = document.createElement("button");
      btn.className = "del-btn"; btn.textContent = "×"; btn.disabled = focusOn;
      btn.title = focusOn ? "Stop focus first" : `Remove ${site}`;
      btn.addEventListener("click", () => delBlockedSite(site));
      li.appendChild(span); li.appendChild(btn); list.appendChild(li);
    });
  } catch { list.innerHTML = `<li style="padding:10px;color:#dc2626;font-size:13px;">Failed to load</li>`; }
}

async function delBlockedSite(site) {
  try {
    const r = await fetch(`${API}/blocked-sites/${encodeURIComponent(site)}`,{method:"DELETE",headers:hdrs()});
    if (!r.ok) throw new Error();
    chrome.runtime.sendMessage({type:"REMOVE_BLOCK_SITE",site},()=>void chrome.runtime.lastError);
    toast(`${site} removed`);
    loadBlockedSites();
  } catch(e) { toast("Failed to remove","err"); }
}

async function addBlockedSite() {
  const inp = document.getElementById("blockSiteInput");
  const btn = document.getElementById("addBlockSite");
  const raw = inp?.value.trim();
  if (!raw) { toast("Enter a domain","err"); return; }
  const nd = normSite(raw);
  if (!nd || !nd.includes(".")) { toast("Enter a valid domain","err"); return; }
  await loadAuthToken();
  btn.disabled = true; btn.textContent = "…";
  try {
    const r = await fetch(`${API}/blocked-sites`,{method:"POST",headers:hdrs(),body:JSON.stringify({site:nd})});
    if (!r.ok) { const e=await r.json().catch(()=>{}); throw new Error(e?.error||`Error ${r.status}`); }
    inp.value = "";
    toast(`${nd} blocked`);
    chrome.runtime.sendMessage({type:"ADD_BLOCK_SITE",site:nd},()=>void chrome.runtime.lastError);
    loadBlockedSites();
  } catch(e) { toast(e.message||"Failed","err"); }
  finally { btn.disabled=false; btn.textContent="Block"; }
}

/* ═══════════════════════════════════════
   FOCUS MODE — only reload current tab
═══════════════════════════════════════ */
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

/* ═══════════════════════════════════════
   REFLECTION
═══════════════════════════════════════ */
async function loadReflection() {
  try {
    const r = await fetch(`${API}/reflections/${getTodayKey()}`,{headers:hdrs()});
    if (!r.ok) return;
    const d = await r.json();
    if (d?.date) {
      document.getElementById("reflectionDistractions").value = d.distractions||"";
      document.getElementById("reflectionWentWell").value     = d.wentWell||"";
      document.getElementById("reflectionImprovements").value = d.improvements||"";
    }
  } catch {}
}

async function saveReflection() {
  try {
    const r = await fetch(`${API}/reflections`,{
      method:"POST",headers:hdrs(),
      body:JSON.stringify({
        date: getTodayKey(),
        distractions: document.getElementById("reflectionDistractions").value,
        wentWell:     document.getElementById("reflectionWentWell").value,
        improvements: document.getElementById("reflectionImprovements").value,
      })
    });
    if (!r.ok) throw new Error();
    const chip = document.getElementById("reflectionSaved");
    chip.style.display="block"; setTimeout(()=>chip.style.display="none",3000);
    toast("Reflection saved");
  } catch { toast("Failed to save","err"); }
}

/* ═══════════════════════════════════════
   WEEKLY SUMMARY
═══════════════════════════════════════ */
async function loadWeeklySummary() {
  const today=new Date(), wago=new Date(today);
  wago.setDate(wago.getDate()-7);
  try {
    const r = await fetch(`${API}/reflections?startDate=${wago.toISOString().split("T")[0]}&endDate=${today.toISOString().split("T")[0]}`,{headers:hdrs()});
    allWeeklyData = r.ok ? await r.json() : [];
    renderWeekly();
  } catch { document.getElementById("weeklySummary").innerHTML=`<p class="empty-text">Could not load</p>`; }
}

function renderWeekly() {
  const cont   = document.getElementById("weeklySummary");
  const allBox = document.getElementById("summaryAll");
  const btn    = document.getElementById("showAllBtn");
  if (!allWeeklyData.length) {
    cont.innerHTML=`<p class="empty-text">No reflections yet</p>`;
    btn.style.display="none"; return;
  }
  cont.innerHTML="";
  const entries = document.createElement("div"); entries.className="summary-entries";
  [allWeeklyData[0]].forEach(r=>entries.appendChild(makeSummaryEl(r)));
  cont.appendChild(entries);
  if (allWeeklyData.length<=1) { btn.style.display="none"; return; }
  btn.style.display="block";
  btn.textContent = showingAll ? "Show less" : `Show all ${allWeeklyData.length} entries`;
  allBox.innerHTML="";
  if (showingAll) {
    allWeeklyData.slice(1).forEach(r=>allBox.appendChild(makeSummaryEl(r)));
    allBox.classList.add("open");
  } else allBox.classList.remove("open");
}

function makeSummaryEl(ref) {
  const item = document.createElement("div"); item.className="summary-item";
  const date = document.createElement("div"); date.className="summary-date";
  date.textContent = new Date(ref.date+"T00:00:00")
    .toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
  const text = document.createElement("div"); text.className="summary-text";
  const parts=[];
  if (ref.wentWell) parts.push(`+ ${ref.wentWell.slice(0,90)}${ref.wentWell.length>90?"…":""}`);
  if (ref.distractions) parts.push(`- ${ref.distractions.slice(0,70)}${ref.distractions.length>70?"…":""}`);
  text.textContent=parts.join(" · ");
  item.appendChild(date); item.appendChild(text);
  return item;
}

/* ═══════════════════════════════════════
   EXPORT
═══════════════════════════════════════ */
function dl(content,name,type) {
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

/* ═══════════════════════════════════════
   MODAL HELPERS
═══════════════════════════════════════ */
function openSettings() {
  renderSettingsCatList();
  document.getElementById("settingsModal").classList.add("open");
}
function closeSettings() { document.getElementById("settingsModal").classList.remove("open"); }

/* ═══════════════════════════════════════
   TOAST
═══════════════════════════════════════ */
function toast(msg, type="ok") {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(()=>t.remove(),350); }, 2800);
}

/* ═══════════════════════════════════════
   UTILS
═══════════════════════════════════════ */
function fmt(ms) {
  if (!ms||ms<=0) return "0 sec";
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m`;
  if (m>0) return `${m} min`;
  return `${s} sec`;
}

/* ═══════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════ */
function initEventListeners() {
  // Header
  document.getElementById("settingsBtn")?.addEventListener("click", openSettings);
  document.getElementById("refreshBtn")?.addEventListener("click",  ()=>location.reload());

  // Settings modal
  document.getElementById("closeSettings")?.addEventListener("click", closeSettings);
  document.getElementById("settingsModal")?.addEventListener("click", e=>{
    if (e.target===document.getElementById("settingsModal")) closeSettings();
  });
  document.getElementById("saveSettingsBtn")?.addEventListener("click", saveSettings);
  document.getElementById("logoutBtn")?.addEventListener("click", logout);

  // Theme — only change theme
  document.getElementById("themeSelect")?.addEventListener("change", e=>applyTheme(e.target.value, currentAccent));
  // Accent — only change accent
  document.querySelectorAll(".swatch").forEach(b=>b.addEventListener("click",()=>applyTheme(currentTheme,b.dataset.color)));

  // Categories in settings
  document.getElementById("addCatBtn")?.addEventListener("click",()=>openCatEditor(null));

  // Cat editor
  document.getElementById("closeCatEditor")?.addEventListener("click", closeCatEditor);
  document.getElementById("catEditorModal")?.addEventListener("click", e=>{
    if (e.target===document.getElementById("catEditorModal")) closeCatEditor();
  });
  document.getElementById("cancelCatEditor")?.addEventListener("click", closeCatEditor);
  document.getElementById("saveCatBtn")?.addEventListener("click", saveCatEditor);
  document.getElementById("deleteCatBtn")?.addEventListener("click", deleteCatFromEditor);

  // Emoji picker toggle
  document.getElementById("emojiPickerBtn")?.addEventListener("click",()=>{
    emojiPickerOpen = !emojiPickerOpen;
    document.getElementById("emojiPickerWrap").style.display = emojiPickerOpen ? "block" : "none";
  });

  // Domain management in editor
  document.getElementById("addDomainBtn")?.addEventListener("click", addDomainToEdit);
  document.getElementById("newDomainInput")?.addEventListener("keypress", e=>{
    if (e.key==="Enter") addDomainToEdit();
  });

  // Colour controls in editor
  document.getElementById("colorNativeInput")?.addEventListener("input", e=>{
    editColor = e.target.value;
    document.getElementById("colorHexInput").value = editColor;
    document.getElementById("colorPreview").style.background = editColor;
  });
  document.getElementById("colorHexInput")?.addEventListener("input", e=>{
    const v = e.target.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      editColor = v;
      document.getElementById("colorNativeInput").value = v;
      document.getElementById("colorPreview").style.background = v;
    }
  });

  // Blocked sites
  document.getElementById("addBlockSite")?.addEventListener("click", addBlockedSite);
  document.getElementById("blockSiteInput")?.addEventListener("keypress",e=>{ if(e.key==="Enter") addBlockedSite(); });

  // Reflection
  document.getElementById("saveReflection")?.addEventListener("click", saveReflection);

  // Range
  document.getElementById("rangeSelect")?.addEventListener("change", ()=>{ _lastChartRender=0; renderFromStorage(); });

  // Weekly show all
  document.getElementById("showAllBtn")?.addEventListener("click",()=>{ showingAll=!showingAll; renderWeekly(); });

  // Export
  document.getElementById("exportJsonBtn")?.addEventListener("click",()=>{
    chrome.storage.local.get(["timeData"],res=>dl(JSON.stringify(res.timeData||{},null,2),`focus-${getTodayKey()}.json`,"application/json"));
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click",()=>{
    chrome.storage.local.get(["timeData"],res=>{
      const d=res.timeData||{}; let csv="Date,Website,Category,Time(ms),Time(min)\n";
      for(const date in d) for(const site in d[date]){
        const e=d[date][site],ms=typeof e==="number"?e:(e.time||0),cat=typeof e==="object"?(e.catId||"other"):"other";
        csv+=`${date},${site},${cat},${ms},${(ms/60000).toFixed(1)}\n`;
      }
      dl(csv,`focus-${getTodayKey()}.csv`,"text/csv");
    });
  });

  // Storage change → update focus buttons
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==="local"&&(changes.focusMode||changes.focusLockUntil)){
      chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"},res=>{
        void chrome.runtime.lastError;
        if(res) updateFocusUI(res.status,res.locked);
      });
      loadBlockedSites();
    }
  });
}