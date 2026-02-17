// server.js
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import crypto from "crypto";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

// ==================== EMAIL CONFIGURATION ====================
const transporter = nodemailer.createTransport({
  service: "gmail", // or your email service
  auth: {
    user: process.env.EMAIL_USER || "khutetakunal@gmail.com",
    pass: process.env.EMAIL_PASSWORD || "kunalop09"
  }
});

// ==================== MONGODB CONNECTION ====================
mongoose.connect("mongodb+srv://d8softtradeinfotech_db_user:vm3ygevJHMa8HyIK@focus-mode.qigx8zn.mongodb.net/")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));


const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  email: { type: String, default: null },
  otpHash: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastValidated: { type: Date, default: Date.now }
});

const blockedSiteSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  site: { type: String, required: true }
});
blockedSiteSchema.index({ userId: 1, site: 1 }, { unique: true });

const categoryMappingSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  domain: { type: String, required: true },
  category: {
    type: String,
    enum: ["Learning", "Development", "Distraction", "Other"],
    required: true
  },
  updatedAt: { type: Date, default: Date.now }
});
categoryMappingSchema.index({ userId: 1, domain: 1 }, { unique: true });

const reflectionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true },
  distractions: { type: String, default: "" },
  wentWell: { type: String, default: "" },
  improvements: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
reflectionSchema.index({ userId: 1, date: 1 }, { unique: true });

const preferencesSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true },
  theme: { type: String, enum: ["light", "dark"], default: "light" },
  accentColor: {
    type: String,
    enum: ["green", "blue", "purple", "red", "orange"],
    default: "blue"
  },
  updatedAt: { type: Date, default: Date.now }
});

// ==================== MODELS ====================
const User = mongoose.model("User", userSchema);
const BlockedSite = mongoose.model("BlockedSite", blockedSiteSchema);
const CategoryMapping = mongoose.model("CategoryMapping", categoryMappingSchema);
const Reflection = mongoose.model("Reflection", reflectionSchema);
const Preferences = mongoose.model("Preferences", preferencesSchema);

// ==================== UTILITY FUNCTIONS ====================

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashOTP(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

async function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: process.env.EMAIL_USER || "your-email@gmail.com",
    to: email,
    subject: "Focus Tracker - Token Recovery OTP",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Focus Tracker - Token Recovery</h2>
        <p>Your One-Time Password (OTP) for token recovery is:</p>
        <h1 style="background: #f1f5f9; padding: 20px; text-align: center; letter-spacing: 5px; color: #1e293b;">
          ${otp}
        </h1>
        <p style="color: #64748b; font-size: 14px;">This OTP will expire in 5 minutes.</p>
        <p style="color: #64748b; font-size: 14px;">If you didn't request this, please ignore this email.</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    return true;
  } catch (error) {
    console.error("Email send error:", error);
    return false;
  }
}

// ==================== AUTH MIDDLEWARE ====================
async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  try {
    const user = await User.findOne({ userId: token });

    if (!user) {
      return res.status(403).json({ error: "Invalid token" });
    }

    req.userId = user.userId;
    req.userEmail = user.email;
    next();
  } catch (error) {
    return res.status(500).json({ error: "Authentication failed" });
  }
}

// ==================== AUTH ROUTES ====================

// Activate new token
app.post("/auth/activate-token", async (req, res) => {
  const { email } = req.body;

  try {
    const token = generateToken();

    await User.create({
      userId: token,
      email: email ? email.toLowerCase() : null,
      createdAt: new Date(),
      lastValidated: new Date()
    });

    await Preferences.create({
      userId: token,
      theme: "light",
      accentColor: "blue"
    });

    res.json({
      success: true,
      token,
      message: "Token generated successfully. Store it safely!"
    });
  } catch (error) {
    console.error("Token activation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Validate token
app.post("/auth/validate-token", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: "Token required" });
  }

  try {
    const user = await User.findOne({ userId: token });

    if (!user) {
      return res.status(403).json({ valid: false, error: "Invalid token" });
    }

    user.lastValidated = new Date();
    await user.save();

    res.json({
      valid: true,
      hasEmail: !!user.email,
      message: "Token validated successfully"
    });
  } catch (error) {
    console.error("Token validation error:", error);
    res.status(500).json({ error: "Validation failed" });
  }
});

// Request OTP for token recovery
app.post("/auth/request-otp", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    const otp = generateOTP();
    const otpHash = hashOTP(otp);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000);

    user.otpHash = otpHash;
    user.otpExpiry = otpExpiry;
    await user.save();

    const emailSent = await sendOTPEmail(email, otp);

    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send OTP email" });
    }

    res.json({ success: true, message: "OTP sent to your email" });
  } catch (error) {
    console.error("OTP request error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// BUG FIX: OTP verification - was calling updateMany({ userId: user.userId })
// AFTER setting user.userId = newToken, so it searched for newToken (which
// doesn't exist yet in related collections) instead of the old token.
// Fixed by capturing the old userId BEFORE changing it.
app.post("/auth/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP required" });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({ error: "No account found" });
    }

    if (!user.otpHash || !user.otpExpiry) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }

    const otpHash = hashOTP(otp);
    if (otpHash !== user.otpHash) {
      return res.status(403).json({ error: "Invalid OTP" });
    }

    // ✅ CRITICAL: Capture the OLD userId BEFORE changing it
    const oldUserId = user.userId;
    const newToken = generateToken();

    // Update all related collections with old userId → new token
    await Promise.all([
      BlockedSite.updateMany(
        { userId: oldUserId },
        { $set: { userId: newToken } }
      ),
      CategoryMapping.updateMany(
        { userId: oldUserId },
        { $set: { userId: newToken } }
      ),
      Reflection.updateMany(
        { userId: oldUserId },
        { $set: { userId: newToken } }
      ),
      Preferences.updateMany(
        { userId: oldUserId },
        { $set: { userId: newToken } }
      )
    ]);

    // Now update the user document itself
    user.userId = newToken;
    user.otpHash = null;
    user.otpExpiry = null;
    user.lastValidated = new Date();
    await user.save();

    res.json({
      success: true,
      token: newToken,
      message: "New token generated successfully. Store it safely!"
    });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ==================== LOGOUT ROUTE ====================
// Clears server-side lastValidated so the token still exists but is marked stale.
// The extension handles local storage cleanup via the LOGOUT message to background.js.
app.post("/auth/logout", authenticateToken, async (req, res) => {
  try {
    await User.updateOne(
      { userId: req.userId },
      { $set: { lastValidated: null } }
    );
    res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Logout failed" });
  }
});

// ==================== BLOCKED SITES ====================
app.get("/blocked-sites", authenticateToken, async (req, res) => {
  try {
    const sites = await BlockedSite.find({ userId: req.userId }, { _id: 0, site: 1 });
    res.json(sites.map(s => s.site));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/blocked-sites", authenticateToken, async (req, res) => {
  const { site } = req.body;
  if (!site) return res.status(400).json({ error: "No site provided" });

  // Robust normalization: handles bare domains, full URLs, paths, query strings
  function normalizeDomainServer(raw) {
    let s = raw.trim().toLowerCase();
    if (!s.startsWith("http://") && !s.startsWith("https://")) {
      s = "https://" + s;
    }
    try {
      return new URL(s).hostname.replace(/^www\./, "");
    } catch {
      return raw.trim().toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .split("?")[0]
        .split(":")[0]; // remove port
    }
  }

  const normalized = normalizeDomainServer(site);

  if (!normalized || normalized.length < 2) {
    return res.status(400).json({ error: "Invalid site URL" });
  }

  try {
    await BlockedSite.updateOne(
      { userId: req.userId, site: normalized },
      { $set: { userId: req.userId, site: normalized } },
      { upsert: true }
    );
    res.json({ success: true, site: normalized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/blocked-sites/:site", authenticateToken, async (req, res) => {
  const siteParam = decodeURIComponent(req.params.site);
  if (!siteParam) return res.status(400).json({ error: "No site provided" });

  const normalized = siteParam
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    await BlockedSite.deleteOne({ userId: req.userId, site: normalized });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CATEGORY MAPPINGS ====================
app.get("/categories", authenticateToken, async (req, res) => {
  try {
    const mappings = await CategoryMapping.find(
      { userId: req.userId },
      { _id: 0, domain: 1, category: 1 }
    );
    res.json(mappings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/categories", authenticateToken, async (req, res) => {
  const { domain, category } = req.body;

  if (!domain || !category) {
    return res.status(400).json({ error: "Domain and category required" });
  }

  const validCategories = ["Learning", "Development", "Distraction", "Other"];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: "Invalid category" });
  }

  const normalized = domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  if (!normalized) {
    return res.status(400).json({ error: "Invalid domain" });
  }

  try {
    await CategoryMapping.updateOne(
      { userId: req.userId, domain: normalized },
      {
        $set: {
          userId: req.userId,
          domain: normalized,
          category,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    res.json({ success: true, domain: normalized, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/categories/:domain", authenticateToken, async (req, res) => {
  const domain = decodeURIComponent(req.params.domain);
  try {
    await CategoryMapping.deleteOne({ userId: req.userId, domain });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== REFLECTIONS ====================
app.get("/reflections", authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const query = { userId: req.userId };

    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const reflections = await Reflection.find(query).sort({ date: -1 });
    res.json(reflections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/reflections/:date", authenticateToken, async (req, res) => {
  try {
    const reflection = await Reflection.findOne({
      userId: req.userId,
      date: req.params.date
    });
    res.json(reflection || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reflections", authenticateToken, async (req, res) => {
  const { date, distractions, wentWell, improvements } = req.body;

  if (!date) {
    return res.status(400).json({ error: "Date required" });
  }

  try {
    await Reflection.updateOne(
      { userId: req.userId, date },
      {
        $set: {
          userId: req.userId,
          date,
          distractions: distractions || "",
          wentWell: wentWell || "",
          improvements: improvements || "",
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PREFERENCES ====================
app.get("/preferences", authenticateToken, async (req, res) => {
  try {
    let prefs = await Preferences.findOne({ userId: req.userId });

    if (!prefs) {
      prefs = await Preferences.create({
        userId: req.userId,
        theme: "light",
        accentColor: "blue"
      });
    }

    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/preferences", authenticateToken, async (req, res) => {
  const { theme, accentColor } = req.body;

  try {
    await Preferences.updateOne(
      { userId: req.userId },
      {
        $set: {
          theme: theme || "light",
          accentColor: accentColor || "blue",
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SERVER ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
