const API = typeof API_BASE !== "undefined" ? API_BASE : "https://habit-tracker-extension.onrender.com";

let authToken     = null;
let currentTheme  = "light";
let currentAccent = "indigo";
let serverCategories  = [];   // domain→category mappings from /categories
let customCatMeta     = [];   // user custom category metadata from /custom-categories
let userCategories    = [];   // merged list shown in UI
let timeChartInst = null;
let allWeeklyData = [];
let showingAll    = false;
let editingCatId    = null;
let editDomains     = [];
let originalDomains = [];
let emojiPickerOpen = false;
let editColor       = "#22c55e";

// catCustomizations is only used as a local cache so the UI feels instant.
// Real source of truth for custom cat metadata is MongoDB (/custom-categories).
let catCustomizations = {};

const BUILTIN_CATS = [
  { id: "Learning",    name: "Learning",    emoji: "📚", color: "#22c55e" },
  { id: "Development", name: "Development", emoji: "💻", color: "#3b82f6" },
  { id: "Distraction", name: "Distraction", emoji: "⚠️",  color: "#ef4444" },
  { id: "Other",       name: "Other",       emoji: "📦", color: "#f97316" },
];
const BUILTIN_IDS = new Set(BUILTIN_CATS.map(b => b.id));

async function loadAuthToken() {
  return new Promise(r => chrome.storage.local.get(["authToken"], d => { authToken = d.authToken||null; r(authToken); }));
}
const hdrs = () => authToken
  ? { "Content-Type":"application/json", Authorization:`Bearer ${authToken}` }
  : { "Content-Type":"application/json" };

let _authRedirecting = false;
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if ((res.status === 401 || res.status === 403) && !_authRedirecting) {
    _authRedirecting = true;
    let serverMsg = "";
    try { const d = await res.clone().json(); serverMsg = d.error || ""; } catch {}
    console.warn(`[Auth] ${res.status} on ${url} — ${serverMsg || "token invalid"}`);
    await new Promise(r => chrome.storage.local.remove(["authToken","lastValidated"], r));
    toast("Session expired — please sign in again", "err");
    setTimeout(() => { location.href = "auth.html"; }, 900);
    return new Response(JSON.stringify({ error: "Session expired" }), {
      status: res.status,
      headers: { "Content-Type": "application/json" }
    });
  }
  return res;
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadAuthToken();
  if (!authToken) { location.href = "auth.html"; return; }

  try {
    const probe = await Promise.race([
      apiFetch(`${API}/auth/me`, { headers: hdrs() }),
      new Promise(r => setTimeout(() => r({ status: 0 }), 4000))
    ]);
    if (_authRedirecting) return;
    if (probe.status && probe.status !== 200 && probe.status !== 0) return;
  } catch {}

  await loadPreferences();
  await loadUserCategories();   // loads both server domain-mappings AND custom cat metadata
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

function getUserId() {
  if (!authToken) return "default";
  try {
    const payload = authToken.split(".")[0];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.split(".")[0];
  } catch { return authToken.slice(0, 16); }
}

function getTimeDataKey()     { return `timeData_${getUserId()}`; }
function getBlockedSitesKey() { return `blockedSites_${getUserId()}`; }

/* ─── CATEGORIES — load from MongoDB ─── */
async function loadUserCategories() {
  // Load domain mappings + custom category metadata in parallel
  const [domainRes, customRes] = await Promise.allSettled([
    apiFetch(`${API}/categories`,       { headers: hdrs() }),
    apiFetch(`${API}/custom-categories`,{ headers: hdrs() }),
  ]);

  serverCategories = [];
  if (domainRes.status === "fulfilled" && domainRes.value.ok) {
    try { serverCategories = await domainRes.value.json(); } catch {}
  }

  customCatMeta = [];
  if (customRes.status === "fulfilled" && customRes.value.ok) {
    try { customCatMeta = await customRes.value.json(); } catch {}
  }

  _rebuildUserCategories();
}

function _rebuildUserCategories() {
  // Builtin cats — use any customization from customCatMeta for overrides
  const builtinOverrides = {};
  customCatMeta.forEach(c => { if (BUILTIN_IDS.has(c.catId)) builtinOverrides[c.catId] = c; });

  const builtins = BUILTIN_CATS.map(cat => {
    const ov = builtinOverrides[cat.id] || {};
    return {
      ...cat,
      color:   ov.color || cat.color,
      emoji:   ov.emoji || cat.emoji,
      // domains come from serverCategories (domain→category mappings)
      domains: serverCategories.filter(m => m.category === cat.id).map(m => m.domain)
    };
  });

  // Custom (user-created) cats from /custom-categories
  const customCats = customCatMeta
    .filter(c => !BUILTIN_IDS.has(c.catId))
    .map(c => ({
      id:       c.catId,
      name:     c.name,
      emoji:    c.emoji || "📁",
      color:    c.color || "#6366f1",
      isCustom: true,
      // Domains for custom cats also come from serverCategories (we now save them there)
      domains:  serverCategories.filter(m => m.category === c.catId).map(m => m.domain)
    }));

  userCategories = [...builtins, ...customCats];

  // Update local cache so background.js SYNC_CATEGORIES can pick these up
  // (background.js fetches /categories which now stores custom cat domains too)
  chrome.runtime.sendMessage({ type: "SYNC_CATEGORIES" }, () => void chrome.runtime.lastError);
}

function buildDomainMap() {
  const map = {};
  serverCategories.forEach(m => { if (m.domain && m.category) map[m.domain] = m.category; });
  return map;
}

function getCatForDomain(domain) {
  const map = buildDomainMap();
  const n = domain.toLowerCase().replace(/^www\./, "");
  if (map[n]) return userCategories.find(c => c.id === map[n]);
  const parts = n.split(".");
  for (let i = 1; i < parts.length; i++) {
    const p = parts.slice(i).join(".");
    if (map[p]) return userCategories.find(c => c.id === map[p]);
  }
  if (/leetcode|coursera|udemy|khanacademy|edx|pluralsight|geeksforgeeks/.test(n))
    return userCategories.find(c => c.id === "Learning");
  if (/youtube|instagram|facebook|twitter|reddit|tiktok|netflix|twitch/.test(n))
    return userCategories.find(c => c.id === "Distraction");
  if (/github|stackoverflow|dev\.to|mdn|npmjs|docs\./.test(n))
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
      const key   = getTimeDataKey();
      chrome.storage.local.get([key], res => {
        void chrome.runtime.lastError;
        const td = res[key] || {};
        td[today] = td[today] || {};
        if (!td[today][domain]) td[today][domain] = { time:0, category: catId };
        td[today][domain].time     += 1000;
        td[today][domain].category  = catId;
        chrome.storage.local.set({ [key]:td }, () => {
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
  const key   = getTimeDataKey();
  chrome.storage.local.get([key], res => {
    void chrome.runtime.lastError;
    const raw  = res[key] || {};
    const isDate = Object.keys(raw).some(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
    const all  = isDate ? raw : { [getDateKey(0)]: raw };
    let days = [];
    if      (range==="today")     days = [getDateKey(0)];
    else if (range==="yesterday") days = [getDateKey(1)];
    else if (range==="7days")     days = Array.from({length:7},(_,i)=>getDateKey(i));
    else if (range==="30days")    days = Array.from({length:30},(_,i)=>getDateKey(i));
    const catTime={}, siteTime={}, siteCat={};
    userCategories.forEach(c => { catTime[c.id] = 0; });
    days.forEach(day => {
      const dd = all[day] || {};
      for (const site in dd) {
        const e   = dd[site];
        const ms  = typeof e==="number" ? e : (e.time||0);
        const cid = getCatForDomain(site)?.id || "Other";
        catTime[cid]  = (catTime[cid]  || 0) + ms;
        siteTime[site] = (siteTime[site] || 0) + ms;
        siteCat[site]  = cid;
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
  const badge = document.getElementById("chartTotalBadge");
  if (badge) {
    if (total>0){ badge.textContent=fmt(total)+" total"; badge.style.display=""; }
    else badge.style.display="none";
  }
  userCategories.forEach(cat => {
    const e2 = document.getElementById(`catTime-${cat.id}`);
    if (e2) e2.textContent = fmt(catTime[cat.id]||0);
  });
  const score = calcScore(catTime, total);
  if (el("productivityScore")) el("productivityScore").textContent = score<0?"—":score;
  if (el("scoreMood")) el("scoreMood").textContent = score<0?"Start browsing":scoreMood(score);
  if (el("scoreDesc")) el("scoreDesc").textContent = score<0?"to see your score":scoreDesc(score, total);
  const ul = el("topSites");
  if (!ul) return;
  ul.innerHTML = "";
  const sorted = Object.entries(siteTime).filter(([,t])=>t>0).sort((a,b)=>b[1]-a[1]).slice(0,8);
  if (!sorted.length) {
    ul.innerHTML=`<li style="padding:12px 6px;color:var(--text-3);font-size:14px;">No data yet — browse some sites!</li>`;
    return;
  }
  const maxMs = sorted[0][1];
  sorted.forEach(([site,ms]) => {
    const cat = userCategories.find(c => c.id===(siteCat[site]||"Other"));
    const pct = maxMs>0?Math.round((ms/maxMs)*100):0;
    const li  = document.createElement("li");
    li.innerHTML=`<span class="site-name" title="${site}">${site}</span><div class="site-bar-wrap"><div class="site-bar" style="width:${pct}%;background:${cat?.color||'var(--accent)'}"></div></div><span class="site-time">${fmt(ms)}</span>`;
    ul.appendChild(li);
  });
}

function calcScore(catTime, totalMs) {
  if (!totalMs||totalMs<5*60*1000) return -1;
  const prod = (catTime["Learning"]||0)+(catTime["Development"]||0);
  const dist = catTime["Distraction"]||0;
  const neut = catTime["Other"]||0;
  let raw = ((prod/totalMs)*100)-((dist/totalMs)*60)+((neut/totalMs)*20);
  raw = Math.max(0,Math.min(100,raw));
  const conf = Math.min(totalMs/60000,60)/60;
  return Math.round(raw*conf+45*(1-conf));
}
function scoreMood(s){ if(s>=85)return"Excellent day";if(s>=70)return"Strong session";if(s>=55)return"Good progress";if(s>=40)return"Balanced";if(s>=25)return"Distracted";return"Off track"; }
function scoreDesc(score,total){ const hrs=(total/3600000).toFixed(1); if(score>=70)return`${hrs}h tracked · keep going`;if(score>=40)return`${hrs}h tracked · more learning helps`;return`${hrs}h tracked · time to refocus`; }

/* ─── CHART ─── */
function renderChart(catTime) {
  const container = document.getElementById("chartContainer");
  const canvas    = document.getElementById("timeChart");
  if (!canvas||!container) return;
  const entries = userCategories.map(cat=>({cat,ms:catTime[cat.id]||0})).filter(e=>e.ms>0).sort((a,b)=>b.ms-a.ms);
  if (timeChartInst){ timeChartInst.destroy(); timeChartInst=null; }
  const isDark = document.body.getAttribute("data-theme")==="dark";
  let emptyEl = container.querySelector(".chart-empty");
  if (!entries.length) {
    canvas.style.display="none";
    if (!emptyEl){ emptyEl=document.createElement("div"); emptyEl.className="chart-empty"; container.appendChild(emptyEl); }
    emptyEl.style.display="flex";
    emptyEl.innerHTML=`<div class="chart-empty-icon">📊</div><div class="chart-empty-text">No data yet</div><div class="chart-empty-sub">Start browsing to see your breakdown</div>`;
    return;
  }
  if (emptyEl) emptyEl.style.display="none";
  canvas.style.display="block";
  if (typeof Chart==="undefined") return;
  const ROW_H=44,PAD_V=24,totalH=entries.length*ROW_H+PAD_V;
  container.style.height=totalH+"px"; canvas.style.height=totalH+"px";
  canvas.height=totalH*(window.devicePixelRatio||1);
  const gridCol=isDark?"rgba(255,255,255,0.05)":"rgba(0,0,0,0.05)";
  const labelCol=isDark?"#d6d0ca":"#44403c";
  const mutedCol=isDark?"#5c5650":"#a8a29e";
  const totalMs=entries.reduce((s,e)=>s+e.ms,0);
  const dataValues=entries.map(e=>Math.round(e.ms/60000*10)/10);
  const bgColors=entries.map(e=>e.cat.color+"28");
  const bdColors=entries.map(e=>e.cat.color);
  const barLabelPlugin={
    id:"barLabels",
    afterDatasetsDraw(chart){
      const{ctx:c,scales:{x}}=chart;
      entries.forEach((entry,i)=>{
        const bar=chart.getDatasetMeta(0).data[i]; if(!bar)return;
        const barRight=x.getPixelForValue(dataValues[i]);
        const pct=totalMs>0?Math.round((entry.ms/totalMs)*100):0;
        const timeStr=fmt(entry.ms);
        c.save();
        c.font="500 11px 'JetBrains Mono',monospace"; c.fillStyle=bdColors[i]; c.textAlign="left"; c.textBaseline="middle";
        c.fillText(timeStr,barRight+8,bar.y);
        const tw=c.measureText(timeStr).width;
        c.font="400 10px 'JetBrains Mono',monospace"; c.fillStyle=mutedCol;
        c.fillText(`${pct}%`,barRight+8+tw+6,bar.y);
        c.restore();
      });
    }
  };
  const widestLabel=entries.reduce((max,e,i)=>{
    const t=fmt(e.ms),pct=Math.round((e.ms/totalMs)*100)+"%";
    return Math.max(max,(t.length+1+pct.length)*6.6+16);
  },60);
  timeChartInst=new Chart(canvas.getContext("2d"),{
    type:"bar",
    data:{
      labels:entries.map(e=>`${e.cat.emoji}  ${e.cat.name}`),
      datasets:[{data:dataValues,backgroundColor:bgColors,borderColor:bdColors,borderWidth:2,borderRadius:6,borderSkipped:false,clip:false}]
    },
    options:{
      indexAxis:"y",responsive:true,maintainAspectRatio:false,
      animation:{duration:500,easing:"easeOutCubic"},
      layout:{padding:{right:widestLabel,top:4,bottom:4}},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:isDark?"#1f2022":"#ffffff",titleColor:isDark?"#f2ede8":"#1c1917",
          bodyColor:isDark?"#9c9490":"#78716c",borderColor:isDark?"#2a2c2e":"#e0dbd4",
          borderWidth:1,padding:14,cornerRadius:10,displayColors:false,
          callbacks:{
            title:items=>`${entries[items[0].dataIndex].cat.emoji}  ${entries[items[0].dataIndex].cat.name}`,
            label:item=>{const i=item.dataIndex,pct=totalMs>0?Math.round((entries[i].ms/totalMs)*100):0;return`  ${fmt(entries[i].ms)}  ·  ${pct}% of total`;}
          }
        }
      },
      scales:{
        x:{grid:{color:gridCol,drawBorder:false},border:{display:false},ticks:{color:mutedCol,font:{size:10,family:"'JetBrains Mono',monospace"},maxTicksLimit:5,callback:v=>fmtMin(v)}},
        y:{grid:{display:false,drawBorder:false},border:{display:false},ticks:{color:labelCol,font:{size:13,family:"'Instrument Sans',sans-serif",weight:"500"},padding:6}}
      }
    },
    plugins:[barLabelPlugin]
  });
}
function fmtMin(mins){ return mins>=60?`${(mins/60).toFixed(1)}h`:`${Math.round(mins)}m`; }

/* ─── PREFS ─── */
async function loadPreferences() {
  try {
    const r = await apiFetch(`${API}/preferences`,{headers:hdrs()});
    if (!r.ok) throw new Error();
    const p = await r.json();
    currentTheme=p.theme||"light"; currentAccent=p.accentColor||"indigo";
  } catch { currentTheme="light"; currentAccent="indigo"; }
  applyTheme(currentTheme,currentAccent);
}
function applyTheme(theme,accent) {
  document.body.setAttribute("data-theme",theme);
  document.body.setAttribute("data-accent",accent);
  currentTheme=theme; currentAccent=accent;
  const ts=document.getElementById("themeSelect"); if(ts) ts.value=theme;
  document.querySelectorAll(".swatch").forEach(b=>b.classList.toggle("on",b.dataset.color===accent));
  chrome.storage.local.set({theme,accentColor:accent});
}
async function saveSettings() {
  try {
    await apiFetch(`${API}/preferences`,{method:"POST",headers:hdrs(),body:JSON.stringify({theme:currentTheme,accentColor:currentAccent})});
    closeSettings(); toast("Settings saved");
  } catch { toast("Failed to save","err"); }
}

/* ─── LOGOUT ─── */
async function logout() {
  if (!confirm("Sign out?")) return;
  const bsKey = getBlockedSitesKey();
  try { await apiFetch(`${API}/auth/logout`,{method:"POST",headers:hdrs()}).catch(()=>{}); } catch {}
  chrome.runtime.sendMessage({type:"LOGOUT"},()=>void chrome.runtime.lastError);
  chrome.storage.local.remove(["authToken","lastValidated","userInfo",bsKey],()=>{ location.href="auth.html"; });
}

/* ─── CATEGORY EDITOR ─── */
let isNewCat = false;

function openNewCatEditor() {
  isNewCat=true; editingCatId=null; editDomains=[]; originalDomains=[]; emojiPickerOpen=false; editColor="#6366f1";
  const title=document.getElementById("catEditorTitle"); if(title) title.textContent="➕ New Category";
  const ed=document.getElementById("catEmojiDisplay"); if(ed) ed.textContent="📁";
  const cp=document.getElementById("colorPreview"); if(cp) cp.style.background=editColor;
  const hi=document.getElementById("colorHexInput"); if(hi) hi.value=editColor;
  const ni=document.getElementById("colorNativeInput"); if(ni) ni.value=editColor;
  const nm=document.getElementById("catNameInput");
  if(nm){ nm.value=""; nm.readOnly=false; nm.style.opacity="1"; nm.placeholder="Category name…"; nm.focus(); }
  const db=document.getElementById("deleteCatBtn"); if(db) db.style.display="none";
  const ew=document.getElementById("emojiPickerWrap"); if(ew) ew.style.display="none";
  renderDomainTags();
  document.getElementById("catEditorModal").classList.add("open");
}

function openCatEditor(cat) {
  isNewCat=false; editingCatId=cat.id; editDomains=[...(cat.domains||[])]; originalDomains=[...(cat.domains||[])]; emojiPickerOpen=false; editColor=cat.color;
  const title=document.getElementById("catEditorTitle"); if(title) title.textContent=`${cat.emoji} ${cat.name} — Edit`;
  const ed=document.getElementById("catEmojiDisplay"); if(ed) ed.textContent=cat.emoji;
  const cp=document.getElementById("colorPreview"); if(cp) cp.style.background=cat.color;
  const hi=document.getElementById("colorHexInput"); if(hi) hi.value=cat.color;
  const ni=document.getElementById("colorNativeInput"); if(ni) ni.value=cat.color;
  const nm=document.getElementById("catNameInput");
  const isBuiltin=BUILTIN_IDS.has(cat.id);
  if(nm){ nm.value=cat.name; nm.readOnly=isBuiltin; nm.style.opacity=isBuiltin?"0.6":"1"; }
  const db=document.getElementById("deleteCatBtn"); if(db) db.style.display=isBuiltin?"none":"flex";
  const ew=document.getElementById("emojiPickerWrap"); if(ew) ew.style.display="none";
  renderDomainTags();
  document.getElementById("catEditorModal").classList.add("open");
}

function closeCatEditor() {
  document.getElementById("catEditorModal").classList.remove("open");
  editingCatId=null; originalDomains=[]; isNewCat=false;
}

async function deleteCatFromEditor() {
  if (!editingCatId) return;
  const cat=userCategories.find(c=>c.id===editingCatId);
  if (!cat||!cat.isCustom){ toast("Cannot delete built-in categories","err"); return; }
  if (!confirm(`Delete "${cat.name}"? All its domain mappings will be removed.`)) return;

  try {
    // Delete from MongoDB — server will also delete all domain mappings
    const r=await apiFetch(`${API}/custom-categories/${encodeURIComponent(editingCatId)}`,{method:"DELETE",headers:hdrs()});
    if (!r.ok) throw new Error("Server error");
    toast(`"${cat.name}" deleted`);
    await loadUserCategories();
    renderStatCards();
    renderFromStorage._forceChart=true;
    renderFromStorage();
    renderSettingsCatList();
    closeCatEditor();
    openSettings();
  } catch(e) {
    toast("Failed to delete: "+e.message,"err");
  }
}

function renderDomainTags() {
  const wrap=document.getElementById("domainTags"); if(!wrap) return;
  wrap.innerHTML="";
  editDomains.forEach(d=>{
    const tag=document.createElement("div"); tag.className="domain-tag";
    tag.innerHTML=`<span>${d}</span><button data-d="${d}" title="Remove">×</button>`;
    tag.querySelector("button").addEventListener("click",()=>{ editDomains=editDomains.filter(x=>x!==d); renderDomainTags(); });
    wrap.appendChild(tag);
  });
}

function addDomainToEdit() {
  const inp=document.getElementById("newDomainInput"); if(!inp) return;
  let raw=inp.value.trim().toLowerCase();
  if(!raw) return;
  raw=raw.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0];
  if(!raw.includes(".")){ toast("Enter a valid domain (e.g. youtube.com)","err"); return; }
  if(!editDomains.includes(raw)) editDomains.push(raw);
  inp.value=""; renderDomainTags();
}

/* ─── SAVE CAT EDITOR — stores everything in MongoDB ─── */
async function saveCatEditor() {
  const emojiDisplay=document.getElementById("catEmojiDisplay");
  const nameInput=document.getElementById("catNameInput");
  const currentEmoji=emojiDisplay?.textContent?.trim()||"📁";
  const currentName=nameInput?.value?.trim();
  if(!currentName){ toast("Category name is required","err"); nameInput?.focus(); return; }

  let catId=editingCatId;
  const isBuiltin=BUILTIN_IDS.has(catId||"");

  if(isNewCat){
    const taken=[...BUILTIN_CATS,...userCategories].some(c=>c.name.toLowerCase()===currentName.toLowerCase());
    if(taken){ toast(`"${currentName}" already exists`,"err"); return; }
    catId=currentName;
  }

  let hasError=false;

  // ── Step 1: Save category metadata to MongoDB (/custom-categories) ──
  // This saves name/emoji/color for ALL categories (builtins too, as overrides)
  // For builtins we save the override. For custom cats we save the full record.
  try {
    const r=await apiFetch(`${API}/custom-categories`,{
      method:"POST", headers:hdrs(),
      body:JSON.stringify({ catId, name:currentName, emoji:currentEmoji, color:editColor })
    });
    if(!r.ok){ const e=await r.json().catch(()=>{}); toast(`Failed to save category: ${e?.error||r.status}`,"err"); hasError=true; }
  } catch { toast("Error saving category metadata","err"); hasError=true; }

  // ── Step 2: Sync domain mappings to MongoDB (/categories) ──
  // Now that server accepts any category string, custom cat domains work too
  const toAdd    = isNewCat ? editDomains : editDomains.filter(d=>!originalDomains.includes(d));
  const toRemove = isNewCat ? []          : originalDomains.filter(d=>!editDomains.includes(d));

  for(const domain of toAdd){
    try{
      const r=await apiFetch(`${API}/categories`,{
        method:"POST", headers:hdrs(),
        body:JSON.stringify({domain, category:catId})
      });
      if(!r.ok){ const e=await r.json().catch(()=>{}); toast(`Failed to add ${domain}: ${e?.error||r.status}`,"err"); hasError=true; }
    } catch { toast(`Error adding ${domain}`,"err"); hasError=true; }
  }

  for(const domain of toRemove){
    try{
      const r=await apiFetch(`${API}/categories/${encodeURIComponent(domain)}`,{method:"DELETE",headers:hdrs()});
      if(!r.ok){ toast(`Failed to remove ${domain}`,"err"); hasError=true; }
    } catch { toast(`Error removing ${domain}`,"err"); hasError=true; }
  }

  if(!hasError) toast(isNewCat?`"${currentName}" created ✓`:"Category saved ✓");

  // ── Step 3: Reload everything from server ──
  await loadUserCategories();
  renderStatCards();
  renderFromStorage._forceChart=true;
  renderFromStorage();
  chrome.runtime.sendMessage({type:"SYNC_CATEGORIES"},()=>void chrome.runtime.lastError);
  renderSettingsCatList();
  closeCatEditor();
}

/* ─── EMOJI PICKER ─── */
const EMOJI_SET=["📚","💻","⚠️","📦","🎯","🚀","🎮","📱","🌐","🔬","🧪","📊","💡","🎨","✍️","🎵","🎬","🏋️","🧘","🍕","☕","🛒","💼","📰","🗓️","📬","🔧","⚙️","🏠","🚗","✈️"];

function buildEmojiGrid() {
  const grid=document.getElementById("emojiGrid"); if(!grid) return;
  EMOJI_SET.forEach(em=>{
    const btn=document.createElement("button"); btn.textContent=em;
    btn.addEventListener("click",()=>{
      const d=document.getElementById("catEmojiDisplay"); if(d) d.textContent=em;
      const w=document.getElementById("emojiPickerWrap"); if(w) w.style.display="none";
      emojiPickerOpen=false;
    });
    grid.appendChild(btn);
  });
}

/* ─── SETTINGS CAT LIST ─── */
function renderSettingsCatList() {
  const ul=document.getElementById("settingsCatList"); if(!ul) return;
  ul.innerHTML="";
  userCategories.forEach(cat=>{
    const isCustom=cat.isCustom||false;
    const li=document.createElement("li"); li.className="cat-list-item";
    li.innerHTML=`
      <span class="cat-icon">${cat.emoji}</span>
      <div class="cat-meta"><span class="cat-name">${cat.name}</span><span class="cat-domain-count">${cat.domains?.length||0} domain${(cat.domains?.length||0)===1?"":"s"}</span></div>
      <div class="cat-color-dot" style="background:${cat.color};width:12px;height:12px;border-radius:50%;flex-shrink:0;"></div>
      <span class="${isCustom?'cat-custom-badge':'cat-system-badge'}" style="font-size:10px;padding:2px 6px;border-radius:10px;background:${isCustom?'#e0e7ff':'#f1f5f9'};color:${isCustom?'#6366f1':'#64748b'};">${isCustom?"custom":"system"}</span>
      <span class="cat-edit-arrow" style="color:var(--text-3);font-size:18px;">›</span>
    `;
    li.style.cssText="display:flex;align-items:center;gap:10px;padding:10px 4px;cursor:pointer;border-bottom:1px solid var(--border);";
    li.addEventListener("click",()=>{ closeSettings(); openCatEditor(cat); });
    ul.appendChild(li);
  });
}

/* ─── BLOCKED SITES ─── */
async function loadBlockedSites() {
  const list=document.getElementById("blockedSitesList"); if(!list) return;
  list.innerHTML=`<li class="blocked-loading"><span>Loading…</span></li>`;
  try{
    const bsKey=getBlockedSitesKey();
    const [bRes,fRes,localData]=await Promise.all([
      apiFetch(`${API}/blocked-sites`,{headers:hdrs()}),
      new Promise(res=>chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"},r=>{void chrome.runtime.lastError;res(r||{status:false});})),
      new Promise(res=>chrome.storage.local.get([bsKey],d=>{void chrome.runtime.lastError;res(d[bsKey]||[]);}))
    ]);
    let serverSites=[];
    if(bRes.ok){ serverSites=await bRes.json(); if(!Array.isArray(serverSites)) serverSites=[]; }
    const allSites=[...new Set([...serverSites,...(Array.isArray(localData)?localData:[])])].sort();
    const focusOn=fRes.status||false;
    list.innerHTML="";
    if(!allSites.length){ list.innerHTML=`<li class="blocked-empty"><span class="blocked-empty-icon">🌐</span><span>No blocked sites yet</span></li>`; return; }
    allSites.forEach(site=>{
      const li=document.createElement("li"); li.className="blocked-site-row";
      const span=document.createElement("span"); span.className="blocked-site-name"; span.textContent=site;
      const btn=document.createElement("button"); btn.className="blocked-del-btn";
      btn.innerHTML=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      btn.disabled=focusOn; btn.title=focusOn?"Stop focus first":`Remove ${site}`;
      if(focusOn) btn.style.opacity="0.35";
      btn.addEventListener("click",()=>delBlockedSite(site));
      li.appendChild(span); li.appendChild(btn); list.appendChild(li);
    });
  } catch(err){ console.error("loadBlockedSites:",err); list.innerHTML=`<li class="blocked-error"><span>Failed to load — check connection</span></li>`; }
}

function normSite(raw){
  let s=raw.trim().toLowerCase();
  if(!s.startsWith("http://")&&!s.startsWith("https://")) s="https://"+s;
  try{ return new URL(s).hostname.replace(/^www\./,""); }
  catch{ return raw.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0]; }
}

async function delBlockedSite(site){
  const bsKey=getBlockedSitesKey();
  try{
    const r=await apiFetch(`${API}/blocked-sites/${encodeURIComponent(site)}`,{method:"DELETE",headers:hdrs()});
    await new Promise(resolve=>{
      chrome.storage.local.get([bsKey],d=>{
        void chrome.runtime.lastError;
        const local=(d[bsKey]||[]).filter(s=>s!==site);
        chrome.storage.local.set({[bsKey]:local},()=>{void chrome.runtime.lastError;resolve();});
      });
    });
    if(!r.ok&&r.status!==404) throw new Error(`Server error ${r.status}`);
    chrome.runtime.sendMessage({type:"REMOVE_BLOCK_SITE",site},()=>void chrome.runtime.lastError);
    toast(`${site} removed`); loadBlockedSites();
  } catch(err){ toast(`Failed to remove: ${err.message}`,"err"); }
}

async function addBlockedSite(){
  const inp=document.getElementById("blockSiteInput");
  const btn=document.getElementById("addBlockSite");
  const raw=inp?.value.trim();
  if(!raw){ toast("Enter a domain","err"); return; }
  const nd=normSite(raw);
  if(!nd||!nd.includes(".")){ toast("Enter a valid domain","err"); return; }
  await loadAuthToken();
  if(btn){ btn.disabled=true; btn.textContent="…"; }
  const bsKey=getBlockedSitesKey();
  try{
    const r=await apiFetch(`${API}/blocked-sites`,{method:"POST",headers:hdrs(),body:JSON.stringify({site:nd})});
    if(!r.ok){ const e=await r.json().catch(()=>{}); throw new Error(e?.error||`Error ${r.status}`); }
    await new Promise(resolve=>{
      chrome.storage.local.get([bsKey],d=>{
        void chrome.runtime.lastError;
        const local=d[bsKey]||[];
        if(!local.includes(nd)) local.push(nd);
        chrome.storage.local.set({[bsKey]:local},()=>{void chrome.runtime.lastError;resolve();});
      });
    });
    if(inp) inp.value="";
    toast(`${nd} blocked ✓`);
    chrome.runtime.sendMessage({type:"ADD_BLOCK_SITE",site:nd},()=>void chrome.runtime.lastError);
    loadBlockedSites();
  } catch(e){ toast(e.message||"Failed","err"); }
  finally{ if(btn){ btn.disabled=false; btn.textContent="Block"; } }
}

/* ─── FOCUS ─── */
function updateFocusUI(on,locked){
  document.getElementById("statusDot")?.classList.toggle("on",on);
  const lbl=document.getElementById("focusLabel");
  if(lbl) lbl.textContent=locked?"Hard Focus — Locked":on?"On":"Off";
  const s=document.getElementById("startFocus"),h=document.getElementById("hardFocus"),x=document.getElementById("stopFocus");
  if(s) s.disabled=on; if(h) h.disabled=on; if(x) x.disabled=!on||locked;
}

function reloadCurrentIfBlocked(){
  const bsKey=getBlockedSitesKey();
  Promise.all([
    apiFetch(`${API}/blocked-sites`,{headers:hdrs()}).then(r=>r.json()).catch(()=>[]),
    new Promise(r=>chrome.storage.local.get([bsKey],d=>{void chrome.runtime.lastError;r(d[bsKey]||[]);}))
  ]).then(([ss,ls])=>{
    const blocked=[...new Set([...ss,...ls])];
    if(!blocked.length) return;
    chrome.tabs.query({windowType:"normal"},tabs=>{
      void chrome.runtime.lastError; if(!tabs?.length) return;
      tabs.forEach(tab=>{
        if(!tab?.url) return;
        try{ const h=new URL(tab.url).hostname.replace(/^www\./,""); if(blocked.some(s=>h===s||h.endsWith("."+s))) chrome.tabs.reload(tab.id); }catch{}
      });
    });
  }).catch(()=>{});
}

function initFocusControls(){
  document.getElementById("startFocus")?.addEventListener("click",()=>{
    chrome.runtime.sendMessage({type:"FOCUS_ON",duration:25,hard:false},res=>{
      void chrome.runtime.lastError;
      if(res?.success){toast("Focus on — 25 min");updateFocusUI(true,false);reloadCurrentIfBlocked();}
      else toast(res?.error||"Could not start","err");
    });
  });
  document.getElementById("hardFocus")?.addEventListener("click",()=>{
    const m=parseInt(prompt("Hard Focus duration (min, min 5):","25"),10);
    if(!m||m<5){toast("Min 5 minutes","err");return;}
    chrome.runtime.sendMessage({type:"FOCUS_ON",duration:m,hard:true},res=>{
      void chrome.runtime.lastError;
      if(res?.success){toast(`Hard focus — ${m} min, locked`);updateFocusUI(true,true);reloadCurrentIfBlocked();}
      else toast(res?.error||"Could not start","err");
    });
  });
  document.getElementById("stopFocus")?.addEventListener("click",()=>{
    chrome.runtime.sendMessage({type:"FOCUS_OFF"},res=>{
      void chrome.runtime.lastError;
      if(res?.success){toast("Focus off");updateFocusUI(false,false);}
      else toast(res?.error||"Could not stop","err");
    });
  });
  chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"},res=>{void chrome.runtime.lastError;if(res)updateFocusUI(res.status,res.locked);});
}

/* ─── REFLECTION ─── */
async function loadReflection(){
  try{
    const r=await apiFetch(`${API}/reflections/${getTodayKey()}`,{headers:hdrs()});
    if(!r.ok) return;
    const d=await r.json();
    if(d?.date){
      const f=id=>document.getElementById(id);
      if(f("reflectionDistractions")) f("reflectionDistractions").value=d.distractions||"";
      if(f("reflectionWentWell"))     f("reflectionWentWell").value=d.wentWell||"";
      if(f("reflectionImprovements")) f("reflectionImprovements").value=d.improvements||"";
    }
  }catch{}
}

async function saveReflection(){
  try{
    const r=await apiFetch(`${API}/reflections`,{
      method:"POST",headers:hdrs(),
      body:JSON.stringify({
        date:getTodayKey(),
        distractions:document.getElementById("reflectionDistractions")?.value,
        wentWell:document.getElementById("reflectionWentWell")?.value,
        improvements:document.getElementById("reflectionImprovements")?.value,
      })
    });
    if(!r.ok) throw new Error();
    const chip=document.getElementById("reflectionSaved");
    if(chip){chip.style.display="block";setTimeout(()=>chip.style.display="none",3000);}
    toast("Reflection saved");
  }catch{toast("Failed to save","err");}
}

/* ─── WEEKLY ─── */
async function loadWeeklySummary(){
  const today=new Date(),wago=new Date(today);
  wago.setDate(wago.getDate()-7);
  try{
    const r=await apiFetch(`${API}/reflections?startDate=${wago.toISOString().split("T")[0]}&endDate=${today.toISOString().split("T")[0]}`,{headers:hdrs()});
    allWeeklyData=r.ok?await r.json():[];
    renderWeekly();
  }catch{const el=document.getElementById("weeklySummary");if(el)el.innerHTML=`<p class="empty-text">Could not load</p>`;}
}

function renderWeekly(){
  const cont=document.getElementById("weeklySummary"),allBox=document.getElementById("summaryAll"),btn=document.getElementById("showAllBtn");
  if(!cont) return;
  if(!allWeeklyData.length){cont.innerHTML=`<p class="empty-text">No reflections yet</p>`;if(btn)btn.style.display="none";return;}
  cont.innerHTML="";
  const entries=document.createElement("div");entries.className="summary-entries";
  [allWeeklyData[0]].forEach(r=>entries.appendChild(makeSummaryEl(r)));
  cont.appendChild(entries);
  if(!btn)return;
  if(allWeeklyData.length<=1){btn.style.display="none";return;}
  btn.style.display="block";
  btn.textContent=showingAll?"Show less":`Show all ${allWeeklyData.length} entries`;
  if(allBox){allBox.innerHTML="";if(showingAll){allWeeklyData.slice(1).forEach(r=>allBox.appendChild(makeSummaryEl(r)));allBox.classList.add("open");}else allBox.classList.remove("open");}
}

function makeSummaryEl(ref){
  const item=document.createElement("div");item.className="summary-item";
  const date=document.createElement("div");date.className="summary-date";
  date.textContent=new Date(ref.date+"T00:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
  const text=document.createElement("div");text.className="summary-text";
  const parts=[];
  if(ref.wentWell) parts.push(`+ ${ref.wentWell.slice(0,90)}${ref.wentWell.length>90?"…":""}`);
  if(ref.distractions) parts.push(`- ${ref.distractions.slice(0,70)}${ref.distractions.length>70?"…":""}`);
  text.textContent=parts.join(" · ");
  item.appendChild(date);item.appendChild(text);
  return item;
}

/* ─── EXPORT ─── */
function dl(content,name,type){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name;a.click();URL.revokeObjectURL(a.href);
}

/* ─── MODALS ─── */
function openSettings(){renderSettingsCatList();document.getElementById("settingsModal").classList.add("open");}
function closeSettings(){document.getElementById("settingsModal").classList.remove("open");}

/* ─── TOAST ─── */
function toast(msg,type="ok"){
  const c=document.getElementById("toastContainer"); if(!c) return;
  const t=document.createElement("div");t.className=`toast ${type}`;t.textContent=msg;
  c.appendChild(t);
  setTimeout(()=>{t.style.opacity="0";t.style.transition="opacity .3s";setTimeout(()=>t.remove(),350);},2800);
}

/* ─── UTILS ─── */
function fmt(ms){
  if(!ms||ms<=0) return"0 sec";
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m} min`;return`${s} sec`;
}

/* ─── EVENTS ─── */
function initEventListeners(){
  document.getElementById("settingsBtn")?.addEventListener("click",openSettings);
  document.getElementById("refreshBtn")?.addEventListener("click",()=>location.reload());
  document.getElementById("closeSettings")?.addEventListener("click",closeSettings);
  document.getElementById("settingsModal")?.addEventListener("click",e=>{if(e.target===document.getElementById("settingsModal"))closeSettings();});
  document.getElementById("saveSettingsBtn")?.addEventListener("click",saveSettings);
  document.getElementById("logoutBtn")?.addEventListener("click",logout);
  document.getElementById("themeSelect")?.addEventListener("change",e=>applyTheme(e.target.value,currentAccent));
  document.querySelectorAll(".swatch").forEach(b=>b.addEventListener("click",()=>applyTheme(currentTheme,b.dataset.color)));
  document.getElementById("addCatBtn")?.addEventListener("click",()=>{closeSettings();openNewCatEditor();});
  document.getElementById("closeCatEditor")?.addEventListener("click",closeCatEditor);
  document.getElementById("catEditorModal")?.addEventListener("click",e=>{if(e.target===document.getElementById("catEditorModal"))closeCatEditor();});
  document.getElementById("cancelCatEditor")?.addEventListener("click",closeCatEditor);
  document.getElementById("saveCatBtn")?.addEventListener("click",saveCatEditor);
  document.getElementById("deleteCatBtn")?.addEventListener("click",deleteCatFromEditor);
  document.getElementById("emojiPickerBtn")?.addEventListener("click",()=>{
    emojiPickerOpen=!emojiPickerOpen;
    const w=document.getElementById("emojiPickerWrap");if(w)w.style.display=emojiPickerOpen?"block":"none";
  });
  document.getElementById("addDomainBtn")?.addEventListener("click",addDomainToEdit);
  document.getElementById("newDomainInput")?.addEventListener("keypress",e=>{if(e.key==="Enter")addDomainToEdit();});
  document.getElementById("colorNativeInput")?.addEventListener("input",e=>{
    editColor=e.target.value;
    const h=document.getElementById("colorHexInput");if(h)h.value=editColor;
    const p=document.getElementById("colorPreview");if(p)p.style.background=editColor;
  });
  document.getElementById("colorHexInput")?.addEventListener("input",e=>{
    const v=e.target.value.trim();
    if(/^#[0-9a-fA-F]{6}$/.test(v)){
      editColor=v;
      const n=document.getElementById("colorNativeInput");if(n)n.value=v;
      const p=document.getElementById("colorPreview");if(p)p.style.background=v;
    }
  });
  document.getElementById("addBlockSite")?.addEventListener("click",addBlockedSite);
  document.getElementById("blockSiteInput")?.addEventListener("keypress",e=>{if(e.key==="Enter")addBlockedSite();});
  document.getElementById("saveReflection")?.addEventListener("click",saveReflection);
  document.getElementById("rangeSelect")?.addEventListener("change",()=>{_lastChartRender=0;renderFromStorage();});
  document.getElementById("showAllBtn")?.addEventListener("click",()=>{showingAll=!showingAll;renderWeekly();});
  document.getElementById("exportJsonBtn")?.addEventListener("click",()=>{
    const key=getTimeDataKey();
    chrome.storage.local.get([key],res=>dl(JSON.stringify(res[key]||{},null,2),`focus-${getTodayKey()}.json`,"application/json"));
  });
  document.getElementById("exportCsvBtn")?.addEventListener("click",()=>{
    const key=getTimeDataKey();
    chrome.storage.local.get([key],res=>{
      const d=res[key]||{};let csv="Date,Website,Category,Time(ms),Time(min)\n";
      for(const date in d)for(const site in d[date]){
        const e=d[date][site],ms=typeof e==="number"?e:(e.time||0),cat=typeof e==="object"?(e.category||"Other"):"Other";
        csv+=`${date},${site},${cat},${ms},${(ms/60000).toFixed(1)}\n`;
      }
      dl(csv,`focus-${getTodayKey()}.csv`,"text/csv");
    });
  });
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==="local"&&(changes.focusMode||changes.focusLockUntil)){
      chrome.runtime.sendMessage({type:"GET_FOCUS_STATUS"},res=>{void chrome.runtime.lastError;if(res)updateFocusUI(res.status,res.locked);});
      loadBlockedSites();
    }
  });
}