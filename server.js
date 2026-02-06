
// server.js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect("mongodb+srv://d8softtradeinfotech_db_user:vm3ygevJHMa8HyIK@focus-mode.qigx8zn.mongodb.net/")

  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ==================== SCHEMAS ====================

// Blocked Sites
const blockedSiteSchema = new mongoose.Schema({
  site: { type: String, unique: true, required: true }
});

// Category Mappings (user-customizable)
const categoryMappingSchema = new mongoose.Schema({
  userId: { type: String, default: "default" },
  domain: { type: String, required: true },
  category: { 
    type: String, 
    enum: ["Learning", "Development", "Distraction", "Other"],
    required: true 
  },
  updatedAt: { type: Date, default: Date.now }
});

// Daily Reflections
const reflectionSchema = new mongoose.Schema({
  userId: { type: String, default: "default" },
  date: { type: String, required: true }, // YYYY-MM-DD
  distractions: { type: String, default: "" },
  wentWell: { type: String, default: "" },
  improvements: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

// User Preferences (theme, colors, etc.)
const preferencesSchema = new mongoose.Schema({
  userId: { type: String, default: "default", unique: true },
  theme: { type: String, enum: ["light", "dark"], default: "light" },
  accentColor: { 
    type: String, 
    enum: ["green", "blue", "purple", "red", "orange"], 
    default: "blue" 
  },
  updatedAt: { type: Date, default: Date.now }
});

// ==================== MODELS ====================
const BlockedSite = mongoose.model("BlockedSite", blockedSiteSchema);
const CategoryMapping = mongoose.model("CategoryMapping", categoryMappingSchema);
const Reflection = mongoose.model("Reflection", reflectionSchema);
const Preferences = mongoose.model("Preferences", preferencesSchema);

// ==================== ROUTES ====================

// ============ BLOCKED SITES ============
app.get("/blocked-sites", async (req, res) => {
  try {
    const sites = await BlockedSite.find({}, { _id: 0, site: 1 });
    res.json(sites.map(s => s.site));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/blocked-sites", async (req, res) => {
  const { site } = req.body;
  if (!site) return res.status(400).json({ error: "No site provided" });

  const normalized = site.toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    await BlockedSite.updateOne(
      { site: normalized }, 
      { site: normalized }, 
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/blocked-sites/:site", async (req, res) => {
  const siteParam = req.params.site;
  if (!siteParam) return res.status(400).json({ error: "No site provided" });

  const normalized = siteParam.toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    await BlockedSite.deleteOne({ site: normalized });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CATEGORY MAPPINGS ============
app.get("/categories", async (req, res) => {
  try {
    const mappings = await CategoryMapping.find({});
    res.json(mappings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/categories", async (req, res) => {
  const { domain, category } = req.body;
  
  if (!domain || !category) {
    return res.status(400).json({ error: "Domain and category required" });
  }

  const validCategories = ["Learning", "Development", "Distraction", "Other"];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  try {
    await CategoryMapping.updateOne(
      { domain },
      { domain, category, updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/categories/:domain", async (req, res) => {
  try {
    await CategoryMapping.deleteOne({ domain: req.params.domain });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ REFLECTIONS ============
app.get("/reflections", async (req, res) => {
  const { startDate, endDate } = req.query;
  
  try {
    let query = {};
    
    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }
    
    const reflections = await Reflection.find(query).sort({ date: -1 });
    res.json(reflections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/reflections/:date", async (req, res) => {
  try {
    const reflection = await Reflection.findOne({ date: req.params.date });
    res.json(reflection || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reflections", async (req, res) => {
  const { date, distractions, wentWell, improvements } = req.body;
  
  if (!date) {
    return res.status(400).json({ error: "Date required" });
  }

  try {
    await Reflection.updateOne(
      { date },
      { 
        date, 
        distractions: distractions || "",
        wentWell: wentWell || "",
        improvements: improvements || "",
        createdAt: new Date()
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PREFERENCES ============
app.get("/preferences", async (req, res) => {
  try {
    let prefs = await Preferences.findOne({ userId: "default" });
    
    if (!prefs) {
      prefs = await Preferences.create({
        userId: "default",
        theme: "light",
        accentColor: "blue"
      });
    }
    
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/preferences", async (req, res) => {
  const { theme, accentColor } = req.body;
  
  try {
    await Preferences.updateOne(
      { userId: "default" },
      { 
        theme: theme || "light",
        accentColor: accentColor || "blue",
        updatedAt: new Date()
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SERVER ====================
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});