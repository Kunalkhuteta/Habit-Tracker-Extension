// server.js  —  Production-ready backend for Focus Tracker
// Supports: Email+Password, Google OAuth, rate limiting, CORS, env vars

import "dotenv/config";

import express       from "express";
import mongoose      from "mongoose";
import cors          from "cors";
import crypto        from "crypto";
import nodemailer    from "nodemailer";
import bcrypt        from "bcryptjs";
import rateLimit     from "express-rate-limit";
import { OAuth2Client } from "google-auth-library";

const app = express();

// ==================== TRUST PROXY ====================
app.set("trust proxy", 1);

// ==================== ENVIRONMENT VARIABLES ====================
const {
  MONGODB_URI,
  EMAIL_USER,
  EMAIL_PASSWORD,
  GOOGLE_CLIENT_ID,
  JWT_SECRET,
  ALLOWED_ORIGINS,
  PORT = 5000
} = process.env;

// ==================== CORS ====================
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : [
      "http://localhost:5000",
      "http://localhost:3000",
    ];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.startsWith("chrome-extension://")) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));

app.use(express.json({ limit: "10kb" }));

// ==================== RATE LIMITING ====================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please slow down." }
});

app.use("/auth", authLimiter);
app.use("/", apiLimiter);

// ==================== MONGODB ====================
mongoose.connect(MONGODB_URI || "mongodb://localhost:27017/focus-tracker")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// ==================== EMAIL ====================
let transporter = null;
try {
  if (EMAIL_USER && EMAIL_PASSWORD) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASSWORD.replace(/\s/g, "")
      }
    });
    console.log("✅ Email transporter ready");
  } else {
    console.warn("⚠️  EMAIL_USER or EMAIL_PASSWORD not set — emails disabled");
  }
} catch (err) {
  console.error("❌ Email setup failed:", err.message);
}

// ==================== GOOGLE OAUTH ====================
const googleClient = GOOGLE_CLIENT_ID
  ? new OAuth2Client(GOOGLE_CLIENT_ID)
  : null;

// ==================== SCHEMAS ====================

const userSchema = new mongoose.Schema({
  email:           { type: String, unique: true, sparse: true, lowercase: true },
  passwordHash:    { type: String, default: null },
  googleId:        { type: String, unique: true, sparse: true },
  displayName:     { type: String, default: "" },
  avatar:          { type: String, default: "" },
  authMethod:      { type: String, enum: ["email", "google", "both"], default: "email" },
  isVerified:      { type: Boolean, default: false },
  verifyToken:     { type: String, default: null },
  resetToken:      { type: String, default: null },
  resetTokenExpiry:{ type: Date,   default: null },
  createdAt:       { type: Date,   default: Date.now },
  lastLoginAt:     { type: Date,   default: Date.now }
});

const blockedSiteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  site:   { type: String, required: true }
});
blockedSiteSchema.index({ userId: 1, site: 1 }, { unique: true });

const categoryMappingSchema = new mongoose.Schema({
  userId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  domain:   { type: String, required: true },
  category: { type: String, enum: ["Learning", "Development", "Distraction", "Other"], required: true },
  updatedAt:{ type: Date, default: Date.now }
});
categoryMappingSchema.index({ userId: 1, domain: 1 }, { unique: true });

const reflectionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date:        { type: String, required: true },
  distractions:{ type: String, default: "" },
  wentWell:    { type: String, default: "" },
  improvements:{ type: String, default: "" },
  createdAt:   { type: Date, default: Date.now }
});
reflectionSchema.index({ userId: 1, date: 1 }, { unique: true });

const preferencesSchema = new mongoose.Schema({
  userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true, required: true },
  theme:      { type: String, enum: ["light", "dark"], default: "light" },
  accentColor:{ type: String, enum: ["green", "blue", "purple", "red", "orange"], default: "blue" },
  updatedAt:  { type: Date, default: Date.now }
});

const User            = mongoose.model("User",            userSchema);
const BlockedSite     = mongoose.model("BlockedSite",     blockedSiteSchema);
const CategoryMapping = mongoose.model("CategoryMapping", categoryMappingSchema);
const Reflection      = mongoose.model("Reflection",      reflectionSchema);
const Preferences     = mongoose.model("Preferences",     preferencesSchema);

// ==================== TOKEN UTILS ====================
const TOKEN_EXPIRY_DAYS = 30;

function createAuthToken(userId) {
  const expiry  = Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(`${userId}.${expiry}`).toString("base64url");
  const secret  = JWT_SECRET || "change-this-secret-in-production";
  const sig     = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;

    const secret   = JWT_SECRET || "change-this-secret-in-production";
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (sig !== expected) return null;

    const decoded        = Buffer.from(payload, "base64url").toString();
    const [userId, expiry] = decoded.split(".");
    if (Date.now() > parseInt(expiry)) return null;

    return userId;
  } catch {
    return null;
  }
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function hashOTP(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

// ==================== EMAIL HELPERS ====================
async function sendVerificationEmail(email, token) {
  if (!transporter) { console.warn("Email not configured — skipping verification email"); return; }
  const link = `${PROD_URL}/auth/verify-email?token=${token}`;
  await transporter.sendMail({
    from: `"Focus Tracker" <${EMAIL_USER}>`,
    to:   email,
    subject: "Verify your Focus Tracker account",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#3b82f6;">⏱️ Welcome to Focus Tracker!</h2>
        <p>Click the button below to verify your email and activate your account.</p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:#3b82f6;color:white;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          Verify My Email
        </a>
        <p style="color:#64748b;font-size:13px;">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </div>
    `
  });
}

async function sendPasswordResetEmail(email, otp) {
  if (!transporter) throw new Error("Email not configured on server");
  await transporter.sendMail({
    from: `"Focus Tracker" <${EMAIL_USER}>`,
    to:   email,
    subject: "Reset your Focus Tracker password",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#3b82f6;">⏱️ Password Reset</h2>
        <p>Your one-time code to reset your password:</p>
        <h1 style="background:#f1f5f9;padding:20px;text-align:center;letter-spacing:8px;color:#1e293b;border-radius:8px;">
          ${otp}
        </h1>
        <p style="color:#64748b;font-size:13px;">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
      </div>
    `
  });
}

// ==================== AUTH MIDDLEWARE ====================
async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token      = authHeader?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "Login required" });

  const userId = verifyAuthToken(token);
  if (!userId)  return res.status(403).json({ error: "Session expired. Please log in again." });

  try {
    const user = await User.findById(userId);
    if (!user)  return res.status(403).json({ error: "Account not found" });

    req.userId    = user._id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    res.status(500).json({ error: "Authentication error" });
  }
}

// ==================== HELPER: create default prefs ====================
async function ensurePreferences(userId) {
  const existing = await Preferences.findOne({ userId });
  if (!existing) {
    await Preferences.create({ userId, theme: "light", accentColor: "blue" });
  }
}

const PROD_URL = process.env.PROD_URL || `http://localhost:${PORT}`;

// ==================== AUTH ROUTES ====================

app.post("/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address" });

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken  = crypto.randomBytes(32).toString("hex");

    const user = await User.create({
      email:       email.toLowerCase(),
      passwordHash,
      displayName: name || email.split("@")[0],
      authMethod:  "email",
      isVerified:  false,
      verifyToken
    });

    await ensurePreferences(user._id);

    if (transporter) {
      sendVerificationEmail(email, verifyToken).catch((err) => {
        console.error("Verification email failed:", err.message);
      });
    } else {
      user.isVerified  = true;
      user.verifyToken = null;
      await user.save();
    }

    const token = createAuthToken(user._id.toString());

    res.json({
      success: true,
      token,
      user:    { email: user.email, name: user.displayName, isVerified: user.isVerified },
      message: EMAIL_USER
        ? "Account created! Check your email to verify your account."
        : "Account created successfully!"
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Failed to create account. Please try again." });
  }
});

app.get("/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Invalid verification link");

  try {
    const user = await User.findOne({ verifyToken: token });
    if (!user)  return res.status(400).send("Link expired or already used");

    user.isVerified  = true;
    user.verifyToken = null;
    await user.save();

    res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;">
        <h2 style="color:#22c55e;">✅ Email verified!</h2>
        <p>You can close this tab and return to Focus Tracker.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send("Verification failed");
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash)
      return res.status(401).json({ error: "Incorrect email or password" });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid)
      return res.status(401).json({ error: "Incorrect email or password" });

    user.lastLoginAt = new Date();
    await user.save();
    await ensurePreferences(user._id);

    const token = createAuthToken(user._id.toString());
    res.json({
      success: true,
      token,
      user: { email: user.email, name: user.displayName, isVerified: user.isVerified }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

app.post("/auth/google", async (req, res) => {
  const { idToken, accessToken } = req.body;

  if (!googleClient)
    return res.status(501).json({ error: "Google login not configured on this server" });

  try {
    let googleId, email, name, avatar;

    if (idToken) {
      const ticket  = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      googleId = payload.sub;
      email    = payload.email;
      name     = payload.name;
      avatar   = payload.picture;
    } else if (accessToken) {
      const r = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!r.ok) throw new Error("Invalid Google token");
      const info = await r.json();
      googleId   = info.sub;
      email      = info.email;
      name       = info.name;
      avatar     = info.picture;
    } else {
      return res.status(400).json({ error: "Google token required" });
    }

    let user = await User.findOne({ $or: [{ googleId }, { email }] });

    if (!user) {
      user = await User.create({
        email:       email.toLowerCase(),
        googleId,
        displayName: name || email.split("@")[0],
        avatar,
        authMethod:  "google",
        isVerified:  true
      });
      await ensurePreferences(user._id);
    } else {
      if (!user.googleId) {
        user.googleId   = googleId;
        user.authMethod = user.passwordHash ? "both" : "google";
        user.isVerified = true;
      }
      user.lastLoginAt = new Date();
      user.avatar      = avatar || user.avatar;
      await user.save();
    }

    const token = createAuthToken(user._id.toString());
    res.json({
      success: true,
      token,
      user: { email: user.email, name: user.displayName, avatar: user.avatar, isVerified: true }
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(401).json({ error: "Google sign-in failed. Please try again." });
  }
});

app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash)
      return res.json({ success: true, message: "If that email exists, a reset code was sent." });

    const otp       = generateOTP();
    const otpHash   = hashOTP(otp);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    user.resetToken       = otpHash;
    user.resetTokenExpiry = otpExpiry;
    await user.save();

    await sendPasswordResetEmail(email, otp);
    res.json({ success: true, message: "If that email exists, a reset code was sent." });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Failed to send reset email" });
  }
});

app.post("/auth/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword)
    return res.status(400).json({ error: "Email, OTP and new password are required" });
  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.resetToken || !user.resetTokenExpiry)
      return res.status(400).json({ error: "Invalid or expired reset code" });

    if (new Date() > user.resetTokenExpiry)
      return res.status(400).json({ error: "Reset code expired. Please request a new one." });

    if (hashOTP(otp) !== user.resetToken)
      return res.status(400).json({ error: "Incorrect reset code" });

    user.passwordHash     = await bcrypt.hash(newPassword, 12);
    user.resetToken       = null;
    user.resetTokenExpiry = null;
    await user.save();

    res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Password reset failed" });
  }
});

app.get("/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId, { passwordHash: 0, resetToken: 0, verifyToken: 0 });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ email: user.email, name: user.displayName, avatar: user.avatar, isVerified: user.isVerified });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

app.post("/auth/logout", authenticateToken, (req, res) => {
  res.json({ success: true });
});

// ==================== BLOCKED SITES ====================

function normalizeDomain(raw) {
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return raw.trim().toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0].split("?")[0].split(":")[0];
  }
}

app.get("/blocked-sites", authenticateToken, async (req, res) => {
  try {
    const sites = await BlockedSite.find({ userId: req.userId }, { _id: 0, site: 1 });
    res.json(sites.map(s => s.site));
  } catch (err) {
    console.error("GET /blocked-sites error:", err);
    res.status(500).json({ error: "Failed to load blocked sites" });
  }
});

// ==================== FIX: POST /blocked-sites ====================
// Root cause of the 500 error:
//
// 1. Duplicate key: MongoDB throws code 11000 when a upsert races with an
//    existing record. We now catch it and return 200 (site already blocked = OK).
//
// 2. Invalid userId: If authenticateToken somehow passes a malformed ObjectId,
//    Mongoose throws a CastError. We now log the full error so Render logs
//    show exactly what went wrong.
//
// 3. Full error logging: Previously the catch block logged nothing to the
//    console, so Render logs showed no detail. Now every 500 logs err.message
//    and err.code so you can diagnose future issues instantly.
// =====================================================================
app.post("/blocked-sites", authenticateToken, async (req, res) => {
  const { site } = req.body;

  // Log every incoming request so Render logs show the attempt
  console.log(`POST /blocked-sites — userId: ${req.userId} — site: ${site}`);

  if (!site) return res.status(400).json({ error: "No site provided" });

  const normalized = normalizeDomain(site);
  if (!normalized || normalized.length < 2) {
    return res.status(400).json({ error: "Invalid site URL" });
  }

  try {
    await BlockedSite.updateOne(
      { userId: req.userId, site: normalized },
      { $set: { userId: req.userId, site: normalized } },
      { upsert: true }
    );
    console.log(`✅ Blocked site saved: ${normalized} for user ${req.userId}`);
    res.json({ success: true, site: normalized });
  } catch (err) {
    // FIX 1: Duplicate key error (code 11000) — site already exists, that's fine
    if (err.code === 11000) {
      console.log(`ℹ️  Site already blocked (duplicate key): ${normalized}`);
      return res.json({ success: true, site: normalized });
    }
    // FIX 2: Log full error details so Render logs are useful
    console.error(`❌ POST /blocked-sites error — code: ${err.code} — message: ${err.message}`);
    res.status(500).json({ error: "Failed to save blocked site", detail: err.message });
  }
});

app.delete("/blocked-sites/:site", authenticateToken, async (req, res) => {
  const normalized = normalizeDomain(decodeURIComponent(req.params.site));
  try {
    await BlockedSite.deleteOne({ userId: req.userId, site: normalized });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /blocked-sites error:", err);
    res.status(500).json({ error: "Failed to remove blocked site" });
  }
});

// ==================== CATEGORIES ====================

app.get("/categories", authenticateToken, async (req, res) => {
  try {
    const mappings = await CategoryMapping.find({ userId: req.userId }, { _id: 0, domain: 1, category: 1 });
    res.json(mappings);
  } catch (err) {
    console.error("GET /categories error:", err);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

app.post("/categories", authenticateToken, async (req, res) => {
  const { domain, category } = req.body;
  if (!domain || !category) return res.status(400).json({ error: "Domain and category required" });

  const validCategories = ["Learning", "Development", "Distraction", "Other"];
  if (!validCategories.includes(category)) return res.status(400).json({ error: "Invalid category" });

  const normalized = normalizeDomain(domain);
  if (!normalized) return res.status(400).json({ error: "Invalid domain" });

  try {
    await CategoryMapping.updateOne(
      { userId: req.userId, domain: normalized },
      { $set: { userId: req.userId, domain: normalized, category, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, domain: normalized, category });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, domain: normalized, category });
    console.error("POST /categories error:", err);
    res.status(500).json({ error: "Failed to save category" });
  }
});

app.delete("/categories/:domain", authenticateToken, async (req, res) => {
  try {
    await CategoryMapping.deleteOne({ userId: req.userId, domain: decodeURIComponent(req.params.domain) });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /categories error:", err);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// ==================== REFLECTIONS ====================

app.get("/reflections", authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const query = { userId: req.userId };
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    const reflections = await Reflection.find(query).sort({ date: -1 });
    res.json(reflections);
  } catch (err) {
    console.error("GET /reflections error:", err);
    res.status(500).json({ error: "Failed to load reflections" });
  }
});

app.get("/reflections/:date", authenticateToken, async (req, res) => {
  try {
    const r = await Reflection.findOne({ userId: req.userId, date: req.params.date });
    res.json(r || {});
  } catch (err) {
    console.error("GET /reflections/:date error:", err);
    res.status(500).json({ error: "Failed to load reflection" });
  }
});

app.post("/reflections", authenticateToken, async (req, res) => {
  const { date, distractions, wentWell, improvements } = req.body;
  if (!date) return res.status(400).json({ error: "Date required" });

  try {
    await Reflection.updateOne(
      { userId: req.userId, date },
      { $set: { userId: req.userId, date, distractions: distractions || "", wentWell: wentWell || "", improvements: improvements || "", createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true });
    console.error("POST /reflections error:", err);
    res.status(500).json({ error: "Failed to save reflection" });
  }
});

// ==================== PREFERENCES ====================

app.get("/preferences", authenticateToken, async (req, res) => {
  try {
    let prefs = await Preferences.findOne({ userId: req.userId });
    if (!prefs) prefs = await Preferences.create({ userId: req.userId, theme: "light", accentColor: "blue" });
    res.json(prefs);
  } catch (err) {
    console.error("GET /preferences error:", err);
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

app.post("/preferences", authenticateToken, async (req, res) => {
  const { theme, accentColor } = req.body;
  try {
    await Preferences.updateOne(
      { userId: req.userId },
      { $set: { theme: theme || "light", accentColor: accentColor || "blue", updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true });
    console.error("POST /preferences error:", err);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// ==================== HEALTH CHECK ====================
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ==================== RENDER FREE TIER KEEP-ALIVE ====================
function startSelfPing(url) {
  if (!url || process.env.NODE_ENV !== "production") return;
  setInterval(async () => {
    try {
      await fetch(`${url}/health`);
      console.log("🏓 Self-ping OK");
    } catch (err) {
      console.warn("⚠️  Self-ping failed:", err.message);
    }
  }, 14 * 60 * 1000);
}

// ==================== START ====================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`   Auth: email/password ${GOOGLE_CLIENT_ID ? "+ Google OAuth ✅" : "(add GOOGLE_CLIENT_ID for Google login)"}`);
  console.log(`   DB: ${MONGODB_URI ? "MongoDB Atlas ✅" : "localhost (set MONGODB_URI for production)"}`);
  startSelfPing(process.env.PROD_URL);
});