function formatTime(ms) {
  if (typeof ms !== "number" || isNaN(ms)) return "0 sec";

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);

  return minutes > 0 ? `${minutes} min` : `${seconds} sec`;
}

document.getElementById("show").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    { action: "flushCurrentTab" },
    () => {
      // Ignore runtime.lastError safely
      chrome.storage.local.get(["timeData"], (data) => {
        const output = document.getElementById("output");
        output.textContent = "";

        const timeData = data.timeData || {};

        for (const site in timeData) {
          const entry = timeData[site] || {};
          const time = entry.time ?? 0;
          const category = entry.category ?? "Other";

          output.textContent +=
            `${site}\n  Time: ${formatTime(time)} | Category: ${category}\n\n`;
        }
      });
    }
  );
});
