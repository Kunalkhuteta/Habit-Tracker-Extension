// server.js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect("mongodb+srv://d8softtradeinfotech_db_user:vm3ygevJHMa8HyIK@focus-mode.qigx8zn.mongodb.net/")
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));

// Schema for blocked sites
const blockedSiteSchema = new mongoose.Schema({
  site: { type: String, unique: true }
});

const BlockedSite = mongoose.model("BlockedSite", blockedSiteSchema);

// Get all blocked sites
app.get("/blocked-sites", async (req, res) => {
  const sites = await BlockedSite.find({}, { _id: 0, site: 1 });
  res.json(sites.map(s => s.site));
});

// Add a new blocked site
app.post("/blocked-sites", async (req, res) => {
  const { site } = req.body;
  if (!site) return res.status(400).json({ success: false, error: "No site provided" });

  const normalized = site.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  try {
    await BlockedSite.updateOne({ site: normalized }, { site: normalized }, { upsert: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a blocked site
app.delete("/blocked-sites/:site", async (req, res) => {
  const siteParam = req.params.site;
  if (!siteParam) return res.status(400).json({ success: false, error: "No site provided" });

  const normalized = siteParam.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

  try {
    await BlockedSite.deleteOne({ site: normalized });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(5000, () => console.log("Server running on http://localhost:5000"));