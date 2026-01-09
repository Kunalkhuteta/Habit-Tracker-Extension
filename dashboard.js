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
    (categoryTime.Learning || 0) +
    (categoryTime.Development || 0);

  const negative = categoryTime.Distraction || 0;
  const total = productive + negative;

  if (total === 0) return 0;
  return Math.round((productive / total) * 100);
}

/* =========================
   DASHBOARD
========================= */
function loadDashboard() {
  const range = document.getElementById("rangeSelect")?.value || "today";

  // SAFE sendMessage (won't error if background ignores it)
  try {
    chrome.runtime.sendMessage({ action: "flushCurrentTab" });
  } catch (_) {}

  chrome.storage.local.get(["timeData"], (res) => {
    const rawData = res.timeData || {};
    const isDateBased = Object.keys(rawData)[0]?.includes("-");
    const allData = isDateBased ? rawData : { [getDateKey(0)]: rawData };

    let days = [];
    if (range === "today") days = [getDateKey(0)];
    if (range === "yesterday") days = [getDateKey(1)];
    if (range === "7days")
      days = Array.from({ length: 7 }, (_, i) => getDateKey(i));

    let categoryTime = {
      Learning: 0,
      Distraction: 0,
      Development: 0,
      Other: 0
    };

    let siteMap = {};

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

    const totalTime = Object.values(categoryTime).reduce((a, b) => a + b, 0);

    document.getElementById("totalTime").textContent = formatTime(totalTime);
    document.getElementById("learningTime").textContent = formatTime(categoryTime.Learning);
    document.getElementById("distractionTime").textContent = formatTime(categoryTime.Distraction);
    document.getElementById("developmentTime").textContent = formatTime(categoryTime.Development);
    document.getElementById("otherTime").textContent = formatTime(categoryTime.Other);

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
   INIT
========================= */
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

  loadDashboard(); // ✅ SAFE initial load
});
