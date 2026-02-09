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

// ==================== SCHEMAS ====================

// User Schema (Token-based authentication)
const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true, required: true }, // This is the token
  email: { type: String, default: null }, // Optional
  otpHash: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastValidated: { type: Date, default: Date.now }
});

// Blocked Sites (linked to user)
const blockedSiteSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  site: { type: String, required: true }
});
blockedSiteSchema.index({ userId: 1, site: 1 }, { unique: true });

// Category Mappings
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

// Daily Reflections
const reflectionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  distractions: { type: String, default: "" },
  wentWell: { type: String, default: "" },
  improvements: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});
reflectionSchema.index({ userId: 1, date: 1 }, { unique: true });

// User Preferences
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

// Generate secure random token
function generateToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 character hex string
}

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Hash OTP for storage
function hashOTP(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// Send OTP via email
async function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: process.env.EMAIL_USER || "khutetakunal@gmail.com",
    to: email,
    subject: "Focus Tracker - Password Recovery OTP",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3b82f6;">Focus Tracker - Token Recovery</h2>
        <p>Your One-Time Password (OTP) for token recovery is:</p>
        <h1 style="background: #f1f5f9; padding: 20px; text-align: center; letter-spacing: 5px; color: #1e293b;">
          ${otp}
        </h1>
        <p style="color: #64748b; font-size: 14px;">
          This OTP will expire in 5 minutes.
        </p>
        <p style="color: #64748b; font-size: 14px;">
          If you didn't request this, please ignore this email.
        </p>
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
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }

  try {
    const user = await User.findOne({ userId: token });
    
    if (!user) {
      return res.status(403).json({ error: "Invalid token" });
    }

    // Attach userId to request
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
    // Generate new token
    const token = generateToken();

    // Create user with token
    const user = await User.create({
      userId: token,
      email: email || null,
      createdAt: new Date(),
      lastValidated: new Date()
    });

    // Create default preferences
    await Preferences.create({
      userId: token,
      theme: "light",
      accentColor: "blue"
    });

    res.json({ 
      success: true,
      token: token,
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
      return res.status(403).json({ 
        valid: false, 
        error: "Invalid token" 
      });
    }

    // Update last validated time
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

    // Generate OTP
    const otp = generateOTP();
    const otpHash = hashOTP(otp);
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Store hashed OTP
    user.otpHash = otpHash;
    user.otpExpiry = otpExpiry;
    await user.save();

    // Send OTP via email
    const emailSent = await sendOTPEmail(email, otp);

    if (!emailSent) {
      return res.status(500).json({ error: "Failed to send OTP email" });
    }

    res.json({ 
      success: true,
      message: "OTP sent to your email"
    });
  } catch (error) {
    console.error("OTP request error:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// Verify OTP and generate new token
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

    // Check if OTP exists and hasn't expired
    if (!user.otpHash || !user.otpExpiry) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }

    // Verify OTP
    const otpHash = hashOTP(otp);
    if (otpHash !== user.otpHash) {
      return res.status(403).json({ error: "Invalid OTP" });
    }

    // Generate new token
    const newToken = generateToken();

    // Update user with new token and clear OTP
    user.userId = newToken;
    user.otpHash = null;
    user.otpExpiry = null;
    user.lastValidated = new Date();
    await user.save();

    // Update all related data with new userId
    await Promise.all([
      BlockedSite.updateMany(
        { userId: user.userId },
        { $set: { userId: newToken } }
      ),
      CategoryMapping.updateMany(
        { userId: user.userId },
        { $set: { userId: newToken } }
      ),
      Reflection.updateMany(
        { userId: user.userId },
        { $set: { userId: newToken } }
      ),
      Preferences.updateMany(
        { userId: user.userId },
        { $set: { userId: newToken } }
      )
    ]);

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

// ==================== PROTECTED ROUTES ====================

// ============ BLOCKED SITES ============
app.get("/blocked-sites", authenticateToken, async (req, res) => {
  try {
    const sites = await BlockedSite.find(
      { userId: req.userId }, 
      { _id: 0, site: 1 }
    );
    res.json(sites.map(s => s.site));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/blocked-sites", authenticateToken, async (req, res) => {
  const { site } = req.body;
  if (!site) return res.status(400).json({ error: "No site provided" });

  const normalized = site.toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    await BlockedSite.updateOne(
      { userId: req.userId, site: normalized }, 
      { userId: req.userId, site: normalized }, 
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/blocked-sites/:site", authenticateToken, async (req, res) => {
  const siteParam = req.params.site;
  if (!siteParam) return res.status(400).json({ error: "No site provided" });

  const normalized = siteParam.toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];

  try {
    await BlockedSite.deleteOne({ 
      userId: req.userId, 
      site: normalized 
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ CATEGORY MAPPINGS ============
app.get("/categories", authenticateToken, async (req, res) => {
  try {
    const mappings = await CategoryMapping.find({ userId: req.userId });
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

  try {
    const normalized = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0];

    await CategoryMapping.updateOne(
      { userId: req.userId, domain: normalized },
      { 
        userId: req.userId, 
        domain: normalized, 
        category, 
        updatedAt: new Date() 
      },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/categories/:domain", authenticateToken, async (req, res) => {
  try {
    await CategoryMapping.deleteOne({ 
      userId: req.userId, 
      domain: req.params.domain 
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ REFLECTIONS ============
app.get("/reflections", authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  
  try {
    let query = { userId: req.userId };
    
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
        userId: req.userId,
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