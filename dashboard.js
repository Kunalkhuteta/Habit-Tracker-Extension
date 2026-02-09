let timeChartInstance = null;
let currentTheme = "light";
let currentAccent = "blue";
let authToken = null;

/* =========================
   AUTHENTICATION
========================= */
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
    console.error("No auth token available");
    // Redirect to auth page
    window.location.href = "auth.html";
    return { "Content-Type": "application/json" };
  }
  
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`
  };
}

/* =========================
   INITIALIZATION
========================= */
document.addEventListener("DOMContentLoaded", async () => {
  // Load auth token first
  await loadAuthToken();
  
  if (!authToken) {
    window.location.href = "auth.html";
    return;
  }
  
  await loadPreferences();
  await loadCategories();
  
  initEventListeners();
  initFocusControls();
  
  loadDashboard();
  loadReflection();
  loadWeeklySummary();
  
  setInterval(loadDashboard, 10000);
});

/* =========================
   PREFERENCES & THEME
========================= */
async function loadPreferences() {
  try {
    const res = await fetch("http://localhost:5000/preferences", {
      headers: getAuthHeaders()
    });
    const prefs = await res.json();
    
    currentTheme = prefs.theme || "light";
    currentAccent = prefs.accentColor || "blue";
    
    applyTheme(currentTheme, currentAccent);
  } catch (err) {
    console.error("Failed to load preferences:", err);
  }
}

function applyTheme(theme, accent) {
  document.body.setAttribute("data-theme", theme);
  document.body.setAttribute("data-accent", accent);
  
  document.getElementById("themeSelect").value = theme;
  
  // Highlight active color
  document.querySelectorAll(".color-option").forEach(btn => {
    btn.classList.remove("active");
    if (btn.dataset.color === accent) {
      btn.classList.add("active");
    }
  });
}

async function saveSettings() {
  const theme = document.getElementById("themeSelect").value;
  const accent = document.querySelector(".color-option.active")?.dataset.color || "blue";
  
  try {
    await fetch("http://localhost:5000/preferences", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ theme, accentColor: accent })
    });
    
    currentTheme = theme;
    currentAccent = accent;
    applyTheme(theme, accent);
    
    closeSettings();
    showNotification("Settings saved!", "success");
  } catch (err) {
    console.error("Failed to save settings:", err);
    showNotification("Failed to save settings", "error");
  }
}

function showNotification(message, type = "success") {
  const notification = document.createElement("div");
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 16px 24px;
    background: ${type === "success" ? "#22c55e" : "#ef4444"};
    color: white;
    border-radius: 12px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 10000;
    animation: slideIn 0.3s ease;
  `;
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = "slideOut 0.3s ease";
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

/* =========================
   CATEGORY MANAGEMENT
========================= */
async function loadCategories() {
  try {
    const res = await fetch("http://localhost:5000/categories", {
      headers: getAuthHeaders()
    });
    const categories = await res.json();
    
    const list = document.getElementById("categoryList");
    list.innerHTML = "";
    
    categories.forEach(cat => {
      const li = document.createElement("li");
      
      const info = document.createElement("div");
      info.style.display = "flex";
      info.style.gap = "10px";
      info.style.alignItems = "center";
      
      const domain = document.createElement("span");
      domain.className = "domain";
      domain.textContent = cat.domain;
      
      const badge = document.createElement("span");
      badge.className = "category-badge";
      badge.textContent = cat.category;
      badge.style.background = getCategoryColor(cat.category);
      badge.style.color = "white";
      
      info.appendChild(domain);
      info.appendChild(badge);
      
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "❌";
      deleteBtn.onclick = () => deleteCategory(cat.domain);
      
      li.appendChild(info);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to load categories:", err);
  }
}

function getCategoryColor(category) {
  const colors = {
    "Learning": "#22c55e",
    "Development": "#3b82f6",
    "Distraction": "#ef4444",
    "Other": "#f97316"
  };
  return colors[category] || "#94a3b8";
}

async function addCategory() {
  const domain = document.getElementById("categoryDomain").value.trim();
  const category = document.getElementById("categorySelect").value;
  
  if (!domain) {
    showNotification("Please enter a domain", "error");
    return;
  }
  
  try {
    await fetch("http://localhost:5000/categories", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ domain, category })
    });
    
    document.getElementById("categoryDomain").value = "";
    
    // Trigger background sync
    chrome.runtime.sendMessage({ type: "SYNC_CATEGORIES" });
    
    await loadCategories();
    showNotification("Category added!", "success");
  } catch (err) {
    console.error("Failed to add category:", err);
    showNotification("Failed to add category", "error");
  }
}

async function deleteCategory(domain) {
  try {
    await fetch(`http://localhost:5000/categories/${encodeURIComponent(domain)}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    
    chrome.runtime.sendMessage({ type: "SYNC_CATEGORIES" });
    
    await loadCategories();
    showNotification("Category removed!", "success");
  } catch (err) {
    console.error("Failed to delete category:", err);
  }
}

/* =========================
   DAILY REFLECTION
========================= */
function getTodayKey() {
  return new Date().toISOString().split("T")[0];
}

async function loadReflection() {
  const today = getTodayKey();
  
  try {
    const res = await fetch(`http://localhost:5000/reflections/${today}`, {
      headers: getAuthHeaders()
    });
    const reflection = await res.json();
    
    if (reflection && reflection.date) {
      document.getElementById("reflectionDistractions").value = 
        reflection.distractions || "";
      document.getElementById("reflectionWentWell").value = 
        reflection.wentWell || "";
      document.getElementById("reflectionImprovements").value = 
        reflection.improvements || "";
    }
  } catch (err) {
    console.error("Failed to load reflection:", err);
  }
}

async function saveReflection() {
  const today = getTodayKey();
  const distractions = document.getElementById("reflectionDistractions").value;
  const wentWell = document.getElementById("reflectionWentWell").value;
  const improvements = document.getElementById("reflectionImprovements").value;
  
  try {
    await fetch("http://localhost:5000/reflections", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({
        date: today,
        distractions,
        wentWell,
        improvements
      })
    });
    
    const savedMsg = document.getElementById("reflectionSaved");
    savedMsg.style.display = "block";
    
    setTimeout(() => {
      savedMsg.style.display = "none";
    }, 3000);
    
    showNotification("Reflection saved!", "success");
  } catch (err) {
    console.error("Failed to save reflection:", err);
    showNotification("Failed to save reflection", "error");
  }
}

/* =========================
   WEEKLY SUMMARY
========================= */
async function loadWeeklySummary() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  
  const startDate = weekAgo.toISOString().split("T")[0];
  const endDate = today.toISOString().split("T")[0];
  
  try {
    const res = await fetch(
      `http://localhost:5000/reflections?startDate=${startDate}&endDate=${endDate}`,
      { headers: getAuthHeaders() }
    );
    const reflections = await res.json();
    
    const container = document.getElementById("weeklySummary");
    
    if (!reflections || reflections.length === 0) {
      container.innerHTML = `
        <p class="loading-text">No reflections yet. Start journaling!</p>
      `;
      return;
    }
    
    container.innerHTML = "";
    
    reflections.slice(0, 5).forEach(ref => {
      const item = document.createElement("div");
      item.className = "summary-item";
      
      const date = document.createElement("div");
      date.className = "summary-date";
      date.textContent = formatDate(ref.date);
      
      const content = document.createElement("div");
      content.style.fontSize = "13px";
      content.style.color = "var(--text-secondary)";
      content.innerHTML = `
        ${ref.wentWell ? `✅ ${ref.wentWell.substring(0, 80)}...` : ""}
        ${ref.distractions ? `<br>⚠️ ${ref.distractions.substring(0, 60)}...` : ""}
      `;
      
      item.appendChild(date);
      item.appendChild(content);
      container.appendChild(item);
    });
  } catch (err) {
    console.error("Failed to load weekly summary:", err);
  }
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { 
    month: "short", 
    day: "numeric" 
  });
}

/* =========================
   UTILS
========================= */
function formatTime(ms) {
  if (typeof ms !== "number" || isNaN(ms)) return "0 sec";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} sec`;
}

function getDateKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().split("T")[0];
}

function calculateProductivity(categoryTime) {
  const productive =
    (categoryTime.Learning || 0) + (categoryTime.Development || 0);
  const negative = categoryTime.Distraction || 0;
  const total = productive + negative;
  return total === 0 ? 0 : Math.round((productive / total) * 100);
}

function getProductivityMessage(score) {
  if (score >= 80) return "🔥 Excellent work!";
  if (score >= 60) return "👍 Good progress!";
  if (score >= 40) return "💪 Keep pushing!";
  if (score >= 20) return "⚠️ Stay focused!";
  return "🎯 Time to refocus!";
}

/* =========================
   DASHBOARD
========================= */
function loadDashboard() {
  document.getElementById("totalTime").textContent = "Updating...";
  const range = document.getElementById("rangeSelect")?.value || "today";

  chrome.storage.local.get(["timeData"], (res) => {
    const rawData = res.timeData || {};
    const isDateBased = Object.keys(rawData)[0]?.includes("-");
    const allData = isDateBased ? rawData : { [getDateKey(0)]: rawData };

    let days = [];
    if (range === "today") days = [getDateKey(0)];
    if (range === "yesterday") days = [getDateKey(1)];
    if (range === "7days")
      days = Array.from({ length: 7 }, (_, i) => getDateKey(i));
    if (range === "30days")
      days = Array.from({ length: 30 }, (_, i) => getDateKey(i));

    const categoryTime = {
      Learning: 0,
      Distraction: 0,
      Development: 0,
      Other: 0
    };

    const siteMap = {};

    days.forEach(day => {
      const dayData = allData[day] || {};
      for (const site in dayData) {
        const entry = dayData[site];
        const time = entry.time || 0;
        const category = entry.category || "Other";
        categoryTime[category] += time;
        siteMap[site] = (siteMap[site] || 0) + time;
      }
    });

    const totalTime = Object.values(categoryTime)
      .reduce((a, b) => a + b, 0);

    document.getElementById("totalTime").textContent =
      formatTime(totalTime);
    document.getElementById("learningTime").textContent =
      formatTime(categoryTime.Learning);
    document.getElementById("distractionTime").textContent =
      formatTime(categoryTime.Distraction);
    document.getElementById("developmentTime").textContent =
      formatTime(categoryTime.Development);
    document.getElementById("otherTime").textContent =
      formatTime(categoryTime.Other);

    const score = calculateProductivity(categoryTime);
    document.getElementById("productivityScore").textContent = score;
    document.getElementById("scoreDesc").textContent = getProductivityMessage(score);

    const ul = document.getElementById("topSites");
    ul.innerHTML = "";

    Object.entries(siteMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([site, time]) => {
        const li = document.createElement("li");
        li.innerHTML = `
          <span>${site}</span>
          <span style="font-weight:600;">${formatTime(time)}</span>
        `;
        ul.appendChild(li);
      });

    renderChart(categoryTime);
  });
}

/* =========================
   CHART
========================= */
function renderChart(categoryTime) {
  const canvas = document.getElementById("timeChart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");
  if (timeChartInstance) timeChartInstance.destroy();

  timeChartInstance = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["📚 Learning", "⚠️ Distraction", "💻 Development", "📦 Other"],
      datasets: [{
        label: "Time (minutes)",
        data: [
          Math.floor(categoryTime.Learning / 60000),
          Math.floor(categoryTime.Distraction / 60000),
          Math.floor(categoryTime.Development / 60000),
          Math.floor(categoryTime.Other / 60000)
        ],
        backgroundColor: [
          "#22c55e",
          "#ef4444",
          "#3b82f6",
          "#f97316"
        ],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            padding: 15,
            font: { size: 13 }
          }
        }
      }
    }
  });
}

/* =========================
   FOCUS MODE
========================= */
function updateFocusButtons(isOn, locked = false) {
  const startBtn = document.getElementById("startFocus");
  const stopBtn = document.getElementById("stopFocus");
  const focusBtn = document.getElementById("focusBtn");
  const statusInd = document.querySelector(".status-indicator");
  
  startBtn.disabled = isOn;
  stopBtn.disabled = !isOn || locked;
  
  focusBtn.textContent = locked ? "FOCUS LOCKED" : 
                         isOn ? "FOCUS MODE ON" : "FOCUS MODE OFF";
  
  if (isOn) {
    statusInd.classList.add("active");
  } else {
    statusInd.classList.remove("active");
  }
}

function initFocusControls() {
  document.getElementById("startFocus").addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "FOCUS_ON",
      duration: 25,
      hard: false
    });
  });

  document.getElementById("hardFocus").addEventListener("click", () => {
    const input = prompt("Hard Focus duration (minutes, min 5):", "25");
    const minutes = parseInt(input, 10);

    if (isNaN(minutes) || minutes < 5) {
      alert("Minimum hard focus time is 5 minutes");
      return;
    }

    chrome.runtime.sendMessage({
      type: "FOCUS_ON",
      duration: minutes,
      hard: true
    });
  });

  document.getElementById("stopFocus").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "FOCUS_OFF" });
  });

  chrome.runtime.sendMessage(
    { type: "GET_FOCUS_STATUS" },
    res => updateFocusButtons(res?.status, res?.locked)
  );
}

/* =========================
   BLOCKED SITES
========================= */
async function loadBlockedSites() {
  try {
    const res = await fetch("http://localhost:5000/blocked-sites", {
      headers: getAuthHeaders()
    });
    const sites = await res.json();

    chrome.runtime.sendMessage({ type: "GET_FOCUS_STATUS" }, (statusRes) => {
      const focusOn = statusRes?.status || false;

      const list = document.getElementById("blockedSitesList");
      list.innerHTML = "";
      
      sites.forEach(site => {
        const li = document.createElement("li");
        
        const span = document.createElement("span");
        span.textContent = site;

        const removeBtn = document.createElement("button");
        removeBtn.textContent = "❌";
        removeBtn.disabled = focusOn;
        removeBtn.title = focusOn ? "Cannot remove while Focus Mode is ON" : "Remove site";

        removeBtn.addEventListener("click", async () => {
          if (focusOn) return;

          try {
            await fetch(`http://localhost:5000/blocked-sites/${encodeURIComponent(site)}`, {
              method: "DELETE",
              headers: getAuthHeaders()
            });
            loadBlockedSites();
          } catch (err) {
            console.error("Failed to remove site", err);
          }
        });

        li.appendChild(span);
        li.appendChild(removeBtn);
        list.appendChild(li);
      });
    });
  } catch (err) {
    console.error("Failed to load blocked sites", err);
  }
}

/* =========================
   EXPORT
========================= */
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   MODAL
========================= */
function openSettings() {
  document.getElementById("settingsModal").classList.add("active");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.remove("active");
}

/* =========================
   EVENT LISTENERS
========================= */
function initEventListeners() {
  // Settings
  document.getElementById("settingsBtn")?.addEventListener("click", openSettings);
  document.querySelector(".close-btn")?.addEventListener("click", closeSettings);
  
  // Theme
  document.getElementById("themeSelect")?.addEventListener("change", (e) => {
    applyTheme(e.target.value, currentAccent);
  });
  
  // Color options
  document.querySelectorAll(".color-option").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".color-option").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      applyTheme(currentTheme, btn.dataset.color);
    });
  });
  
  // Categories
  document.getElementById("addCategoryBtn")?.addEventListener("click", addCategory);
  
  // Reflection
  document.getElementById("saveReflection")?.addEventListener("click", saveReflection);
  
  // Dashboard
  document.getElementById("rangeSelect")?.addEventListener("change", loadDashboard);
  document.getElementById("refreshBtn")?.addEventListener("click", loadDashboard);
  
  // Blocked sites
  document.getElementById("addBlockSite")?.addEventListener("click", () => {
    const input = document.getElementById("blockSiteInput");
    const site = input.value.trim();
    if (!site) return;

    chrome.runtime.sendMessage({ type: "ADD_BLOCK_SITE", site }, res => {
      if (res?.success) {
        input.value = "";
        loadBlockedSites();
      }
    });
  });
  
  // Export
  document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
    chrome.storage.local.get(["timeData"], (res) => {
      downloadFile(
        JSON.stringify(res.timeData || {}, null, 2),
        "focus-tracker-data.json",
        "application/json"
      );
    });
  });

  document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
    chrome.storage.local.get(["timeData"], (res) => {
      const timeData = res.timeData || {};
      let csv = "Date,Website,Category,Time(ms)\n";
      for (const date in timeData) {
        for (const site in timeData[date]) {
          const e = timeData[date][site];
          csv += `${date},${site},${e.category},${e.time}\n`;
        }
      }
      downloadFile(csv, "focus-tracker-data.csv", "text/csv");
    });
  });
  
  // Load blocked sites
  loadBlockedSites();
  
  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.focusMode || changes.focusLockUntil)) {
      chrome.runtime.sendMessage(
        { type: "GET_FOCUS_STATUS" },
        res => updateFocusButtons(res?.status, res?.locked)
      );
    }
  });
}