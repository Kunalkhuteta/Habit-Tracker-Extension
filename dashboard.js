let chartInstance = null;

function formatTime(ms) {
  if (typeof ms !== "number" || isNaN(ms)) return "0 sec";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} min` : `${seconds} sec`;
}

// 🔴 ALWAYS flush current tab before reading data
chrome.runtime.sendMessage({ action: "flushCurrentTab" }, () => {
  chrome.storage.local.get(["timeData"], (res) => {
    const timeData = res.timeData || {};

    let totalTime = 0;
    let categoryTime = {
      Learning: 0,
      Distraction: 0,
      Development: 0,
      Other: 0
    };

    let topSites = [];

    for (const site in timeData) {
      const entry = timeData[site];
      const time = Number(entry?.time ?? 0);
      const category = entry?.category ?? "Other";

      totalTime += time;

      if (!categoryTime.hasOwnProperty(category)) {
        categoryTime.Other += time;
      } else {
        categoryTime[category] += time;
      }

      topSites.push({ site, time });
    }

    // Sort top sites
    topSites.sort((a, b) => b.time - a.time);
    topSites = topSites.slice(0, 5);

    // Update UI
    document.getElementById("totalTime").textContent = formatTime(totalTime);
    document.getElementById("learningTime").textContent = formatTime(categoryTime.Learning);
    document.getElementById("distractionTime").textContent = formatTime(categoryTime.Distraction);
    document.getElementById("developmentTime").textContent = formatTime(categoryTime.Development);
    document.getElementById("otherTime").textContent = formatTime(categoryTime.Other);

    const ul = document.getElementById("topSites");
    ul.innerHTML = "";
    topSites.forEach(item => {
      const li = document.createElement("li");
      li.textContent = `${item.site} → ${formatTime(item.time)}`;
      ul.appendChild(li);
    });

    renderChart(categoryTime);
  });
});

function renderChart(categoryTime) {
  const ctx = document.getElementById("timeChart").getContext("2d");

  // 🔴 DESTROY PREVIOUS CHART
  if (timeChartInstance) {
    timeChartInstance.destroy();
  }

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

chrome.runtime.sendMessage({ action: "flushCurrentTab" }, () => {
  if (chrome.runtime.lastError) {
    console.warn("Flush skipped:", chrome.runtime.lastError.message);
  }

  chrome.storage.local.get(["timeData"], (res) => {
    // rest of your dashboard logic
  });
});
