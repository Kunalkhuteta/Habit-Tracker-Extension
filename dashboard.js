let timeChartInstance = null;

setInterval(loadDashboard, 10000);

/* =========================
   UTILS
========================= */
function formatTime(ms) {
  if (typeof ms !== "number" || isNaN(ms)) return "0 sec";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min` : `${seconds} sec`;
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

    document.getElementById("productivityScore").textContent =
      calculateProductivity(categoryTime);

    const ul = document.getElementById("topSites");
    ul.innerHTML = "";

    Object.entries(siteMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([site, time]) => {
        const li = document.createElement("li");
        li.textContent = `${site} → ${formatTime(time)}`;
        ul.appendChild(li);
      });

    renderChart(categoryTime);
  });
  requestAnimationFrame(() => {
    renderChart(categoryTime);
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.focusMode || changes.focusLockUntil)) {
    chrome.runtime.sendMessage(
      { type: "GET_FOCUS_STATUS" },
      res => updateFocusButtons(res?.status, res?.locked)
    );
  }
});

/* =========================
   CHART
========================= */
function renderChart(categoryTime) {
  const canvas = document.getElementById("timeChart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");
  if (timeChartInstance) timeChartInstance.destroy();

  timeChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Learning", "Distraction", "Development", "Other"],
      datasets: [{
        label: "Time (minutes)",
        data: [
          Math.floor(categoryTime.Learning / 60000),
          Math.floor(categoryTime.Distraction / 60000),
          Math.floor(categoryTime.Development / 60000),
          Math.floor(categoryTime.Other / 60000)
        ]
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false
    }
  });
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
   FOCUS MODE UI (NO LOGIC)
========================= */
function updateFocusButtons(isOn, locked = false) {
  document.getElementById("startFocus").disabled = isOn;
  document.getElementById("stopFocus").disabled = !isOn || locked;

  document.getElementById("focusBtn").textContent =
    locked ? "FOCUS LOCKED" : isOn ? "FOCUS MODE ON" : "FOCUS MODE OFF";
}

function initFocusControls() {
  // Normal focus → no prompt, starts immediately
  document.getElementById("startFocus").addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "FOCUS_ON",
      duration: 25, // default 25 min, or any fixed value for normal focus
      hard: false
    });
  });

  // Hard focus → prompt for duration
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

  // Stop focus → stops normal immediately, or hard if allowed
  document.getElementById("stopFocus").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "FOCUS_OFF" });
  });

  // Focus toggle button in popup
  document.getElementById("focusBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "GET_FOCUS_STATUS" }, res => {
      if (res?.locked) {
        alert("Hard focus active, cannot toggle");
        return;
      }

      if (!res?.status) {
        document.getElementById("startFocus").click();
      } else {
        document.getElementById("stopFocus").click();
      }
    });
  });

  // Initialize button states
  chrome.runtime.sendMessage(
    { type: "GET_FOCUS_STATUS" },
    res => updateFocusButtons(res?.status, res?.locked)
  );
}

/* =====================
   INIT
======================== */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("rangeSelect")
    ?.addEventListener("change", loadDashboard);

  document.getElementById("refreshBtn")
    ?.addEventListener("click", loadDashboard);

  document.getElementById("exportJsonBtn")
    ?.addEventListener("click", () => {
      chrome.storage.local.get(["timeData"], (res) => {
        downloadFile(
          JSON.stringify(res.timeData || {}, null, 2),
          "productivity-data.json",
          "application/json"
        );
      });
    });

  document.getElementById("exportCsvBtn")
    ?.addEventListener("click", () => {
      chrome.storage.local.get(["timeData"], (res) => {
        const timeData = res.timeData || {};
        let csv = "Date,Website,Category,Time(ms)\n";
        for (const date in timeData) {
          for (const site in timeData[date]) {
            const e = timeData[date][site];
            csv += `${date},${site},${e.category},${e.time}\n`;
          }
        }
        downloadFile(csv, "productivity-data.csv", "text/csv");
      });
    });

  initFocusControls();
  loadDashboard();
});

document.getElementById("openDashboard").addEventListener("click", () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("dashboard.html"),
    type: "popup",
    width: Math.floor(screen.width / 2),   // half of your screen width
    height: Math.floor(screen.height / 2)  // half of your screen height
  });
});

