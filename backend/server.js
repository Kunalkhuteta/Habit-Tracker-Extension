// server.js — Focus Tracker backend
// Production-ready: Email+Password, Google OAuth (web popup, all browsers),
// JWT auth, rate limiting, security headers, input validation

import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { OAuth2Client } from "google-auth-library";


// ─────────────────────────────────────────────
// ENV VALIDATION — crash fast on missing secrets
// ─────────────────────────────────────────────
const {
  MONGODB_URI,
  EMAIL_USER,
  EMAIL_PASSWORD,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  JWT_SECRET,
  ALLOWED_ORIGINS,
  PROD_URL,
  PORT = 5000,
} = process.env;

if (!JWT_SECRET) {
  console.error("❌ FATAL: JWT_SECRET is not set.");
  console.error('   Run: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  process.exit(1);
}

// PROD_URL must be set in production so Google OAuth redirect_uri is deterministic
if (process.env.NODE_ENV === "production" && !PROD_URL) {
  console.warn("⚠️  PROD_URL not set — Google OAuth may use wrong redirect_uri on Render.");
}

// ─────────────────────────────────────────────
// EXPRESS SETUP
// ─────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1); // Required on Render/Heroku — trusts X-Forwarded-* headers


// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
const defaultOrigins = [
  "http://localhost:5000",
  "http://localhost:3000",
  "https://habit-tracker-extension.onrender.com",

];
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : defaultOrigins;

app.use(cors({
  origin(origin, cb) {
    // No origin = same-origin request or server-to-server — allow
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Browser extensions have their own protocol origins — always allow
    if (
      origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://") ||
      origin.startsWith("ms-browser-extension://")
    ) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: "10kb" }));

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));


// ─────────────────────────────────────────────
// SECURITY HEADERS
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  next();
});

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
// Separate limiters per sensitive route so one route can't
// exhaust the budget of another (e.g. login spam blocking forgot-password)
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Too many attempts. Please wait 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 25,
  message: { error: "Too many attempts. Please wait 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  message: { error: "Too many requests. Please slow down." },
});

// Apply per-route: tightest limits on password/OTP routes
app.use("/auth/forgot-password", strictLimiter);
app.use("/auth/reset-password", strictLimiter);
app.use("/auth/signup", authLimiter);
app.use("/auth/login", authLimiter);
app.use("/auth", authLimiter); // catch-all for remaining /auth routes
app.use("/", apiLimiter);

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
mongoose
  .connect(MONGODB_URI || "mongodb://localhost:27017/focus-tracker")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err.message));

// ─────────────────────────────────────────────
// EMAIL (Brevo API)
// ─────────────────────────────────────────────
import { BrevoClient } from "@getbrevo/brevo";

let brevo = null;
if (process.env.BREVO_API_KEY) {
  brevo = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });
  console.log("✅ Brevo mailer initialized");
} else {
  console.warn("⚠️  BREVO_API_KEY not set — email features disabled");
}


// ─────────────────────────────────────────────
// GOOGLE OAUTH CLIENT
// ─────────────────────────────────────────────
const googleClient = (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)
  ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  : null;

if (GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_SECRET) {
  console.warn("⚠️  GOOGLE_CLIENT_SECRET not set — Google OAuth will fail at code exchange");
}

// ─────────────────────────────────────────────
// SCHEMAS & MODELS
// ─────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: null },
  googleId: { type: String, unique: true, sparse: true },
  displayName: { type: String, default: "", maxlength: 64 },
  avatar: { type: String, default: "" },
  authMethod: { type: String, enum: ["email", "google", "both"], default: "email" },
  isVerified: { type: Boolean, default: false },
  verifyToken: { type: String, default: null, select: false },
  resetToken: { type: String, default: null, select: false },
  resetTokenExpiry: { type: Date, default: null, select: false },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
});

const blockedSiteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  site: { type: String, required: true, maxlength: 253 },
});
blockedSiteSchema.index({ userId: 1, site: 1 }, { unique: true });

const categoryMappingSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  domain: { type: String, required: true, maxlength: 253 },
  category: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now },
});
categoryMappingSchema.index({ userId: 1, domain: 1 }, { unique: true });

const reflectionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true, maxlength: 10 },
  distractions: { type: String, default: "", maxlength: 2000 },
  wentWell: { type: String, default: "", maxlength: 2000 },
  improvements: { type: String, default: "", maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});
reflectionSchema.index({ userId: 1, date: 1 }, { unique: true });

const preferencesSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", unique: true, sparse: true, required: true },
  theme: { type: String, enum: ["light", "dark"], default: "light" },
  accentColor: { type: String, enum: ["green", "blue", "purple", "red", "orange", "indigo"], default: "indigo" },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const BlockedSite = mongoose.model("BlockedSite", blockedSiteSchema);
const CategoryMapping = mongoose.model("CategoryMapping", categoryMappingSchema);
const Reflection = mongoose.model("Reflection", reflectionSchema);
const Preferences = mongoose.model("Preferences", preferencesSchema);


const customCategorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  catId: { type: String, required: true, maxlength: 64 },  // used as category value in mappings
  name: { type: String, required: true, maxlength: 64 },
  emoji: { type: String, default: "📁", maxlength: 8 },
  color: { type: String, default: "#6366f1", maxlength: 9 },
  updatedAt: { type: Date, default: Date.now },
});
customCategorySchema.index({ userId: 1, catId: 1 }, { unique: true });
const CustomCategory = mongoose.model("CustomCategory", customCategorySchema);

// ─────────────────────────────────────────────
// INDEX REPAIR (runs once on DB open)
// ─────────────────────────────────────────────
async function repairIndexes() {
  try {
    const db = mongoose.connection.db;

    async function dropIfNonSparse(col, idxName) {
      try {
        const list = await db.collection(col).indexes();
        const bad = list.find(i => i.name === idxName && !i.sparse);
        if (bad) {
          await db.collection(col).dropIndex(idxName);
          console.log(`✅ Fixed index: ${col}.${idxName}`);
        }
      } catch (e) {
        if (e.codeName !== "NamespaceNotFound") console.warn(`⚠️  Index check ${col}.${idxName}:`, e.message);
      }
    }

    await Promise.all([
      dropIfNonSparse("users", "email_1"),
      dropIfNonSparse("users", "googleId_1"),
      dropIfNonSparse("preferences", "userId_1"),
    ]);

    await Promise.all([
      User.syncIndexes(),
      BlockedSite.syncIndexes(),
      CategoryMapping.syncIndexes(),
      Reflection.syncIndexes(),
      Preferences.syncIndexes(),
      CustomCategory.syncIndexes(),
    ]);

    console.log("✅ All indexes in sync");
  } catch (err) {
    console.error("❌ Index repair error:", err.message);
  }
}

mongoose.connection.once("open", repairIndexes);

// ─────────────────────────────────────────────
// TOKEN UTILS
// ─────────────────────────────────────────────
const TOKEN_EXPIRY_DAYS = 30;

function createAuthToken(userId) {
  const expiry = Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(`${userId}.${expiry}`).toString("base64url");
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(payload).digest("hex");
    // Constant-time comparison — prevents timing attacks
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 1) return null;
    const userId = decoded.slice(0, lastDot);
    const expiry = parseInt(decoded.slice(lastDot + 1), 10);
    if (!userId || !expiry || Date.now() > expiry) return null;
    return userId;
  } catch {
    return null;
  }
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}
function hashOTP(otp) {
  return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

// ─────────────────────────────────────────────
// URL HELPER
// Derives the server's public base URL.
// PROD_URL env var wins — falls back to request headers on Render.
// ─────────────────────────────────────────────
function getServerBase(req) {
  if (PROD_URL) return PROD_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return `${proto}://${host}`;
}

// ─────────────────────────────────────────────
// INPUT HELPERS
// ─────────────────────────────────────────────
function sanitizeName(raw, fallback) {
  return (raw || fallback || "User")
    .replace(/[<>"'`]/g, "")
    .trim()
    .slice(0, 64) || "User";
}

function normalizeDomain(raw) {
  let s = String(raw).trim().toLowerCase();
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return s
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("/")[0].split("?")[0].split(":")[0];
  }
}

// ─────────────────────────────────────────────
// EMAIL HELPERS
// ─────────────────────────────────────────────
const BASE_URL = PROD_URL || `http://localhost:${PORT}`;

async function sendVerificationEmail(email, token) {
  if (!brevo) return;
  const link = `${BASE_URL}/auth/verify-email?token=${token}`;
  await brevo.transactionalEmails.sendTransacEmail({
    to: [{ email }],
    sender: { email: EMAIL_USER || "noreply@focustracker.com", name: "Focus Tracker" },
    subject: "Verify your Focus Tracker account",
    htmlContent: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#4f46e5;">⏱️ Welcome to Focus Tracker!</h2>
        <p>Click the button below to verify your email.</p>
        <a href="${link}" style="display:inline-block;padding:14px 28px;background:#4f46e5;color:#fff;
           border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">
          Verify My Email
        </a>
        <p style="color:#64748b;font-size:13px;">Link expires in 24 hours. If you didn't sign up, ignore this email.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(email, otp, userId) {
  if (!brevo) throw new Error("Email service not configured");

  // Optionally look up user's preferred theme/accent for the email link
  let theme = "light", accent = "indigo";
  if (userId) {
    try {
      const prefs = await Preferences.findOne({ userId });
      if (prefs) { theme = prefs.theme || "light"; accent = prefs.accentColor || "indigo"; }
    } catch { /* non-fatal */ }
  }

  const resetPageBase = process.env.RESET_PAGE_URL || BASE_URL;
  const resetUrl = `${resetPageBase}/reset-password.html`
    + `?otp=${encodeURIComponent(otp)}`
    + `&email=${encodeURIComponent(email)}`
    + `&theme=${encodeURIComponent(theme)}`
    + `&accent=${encodeURIComponent(accent)}`;

  await brevo.transactionalEmails.sendTransacEmail({
    to: [{ email }],
    sender: { email: EMAIL_USER || "noreply@focustracker.com", name: "Focus Tracker" },
    subject: "Reset your Focus Tracker password",
    htmlContent: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Reset your password</title></head>
<body style="margin:0;padding:0;background:#f5f3ef;font-family:'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ef;padding:40px 16px;">
<tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#fdfcfa;border:1px solid #e0dbd4;border-radius:20px;overflow:hidden;box-shadow:0 16px 40px rgba(28,25,23,.1);">

  <!-- Accent bar -->
  <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);height:3px;font-size:0;">&nbsp;</td></tr>

  <!-- Header -->
  <tr><td style="padding:32px 36px 22px;">
    <table cellpadding="0" cellspacing="0">
      <tr>
        <td style="width:42px;height:42px;background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:11px;text-align:center;vertical-align:middle;font-size:20px;">⏱️</td>
        <td style="padding-left:11px;">
          <div style="font-size:17px;color:#1c1917;">Focus <strong>Tracker</strong></div>
          <div style="font-size:11px;color:#a8a29e;margin-top:1px;">Password reset request</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:0 36px 32px;">
    <h1 style="font-size:24px;color:#1c1917;margin:0 0 10px;font-weight:400;font-style:italic;font-family:Georgia,serif;letter-spacing:-.2px;line-height:1.25;">
      Reset your <strong style="font-style:normal;">password</strong>
    </h1>
    <p style="font-size:14.5px;color:#57534e;margin:0 0 26px;line-height:1.65;">
      Someone requested a password reset for <strong>${email}</strong>. Click the button below to set a new password. The link expires in <strong>10 minutes</strong>.
    </p>

    <!-- CTA -->
    <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);border-radius:10px;">
          <a href="${resetUrl}" style="display:inline-block;padding:14px 30px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:.01em;">
            Reset my password &rarr;
          </a>
        </td>
      </tr>
    </table>

    <!-- Divider -->
    <div style="border-top:1px solid #e0dbd4;margin:0 0 22px;"></div>

    <!-- OTP fallback -->
    <p style="font-size:12.5px;color:#a8a29e;margin:0 0 12px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;">
      Or enter this code in the extension
    </p>
    <div style="background:#ede9e3;border-radius:12px;padding:20px;margin-bottom:22px;text-align:center;">
      <div style="font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:12px;color:#1c1917;line-height:1;">${otp}</div>
      <div style="font-size:11px;color:#a8a29e;margin-top:8px;">Valid for 10 minutes</div>
    </div>

    <!-- URL fallback -->
    <div style="background:#f5f3ef;border:1px solid #e0dbd4;border-radius:8px;padding:13px;margin-bottom:22px;">
      <div style="font-size:11px;color:#a8a29e;margin-bottom:5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">Button not working? Copy this link:</div>
      <a href="${resetUrl}" style="font-size:11.5px;color:#4f46e5;word-break:break-all;font-family:'Courier New',monospace;text-decoration:none;">${resetUrl}</a>
    </div>

    <p style="font-size:12.5px;color:#a8a29e;margin:0;line-height:1.6;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:18px 36px 26px;border-top:1px solid #e0dbd4;text-align:center;">
    <p style="font-size:11.5px;color:#a8a29e;margin:0;line-height:1.6;">
      Focus Tracker &middot; Your productivity companion<br>
      This is an automated message &mdash; please do not reply.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
    `,
  });
}

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers["authorization"];
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required" });

  const userId = verifyAuthToken(token);
  if (!userId) return res.status(403).json({ error: "Session expired. Please log in again." });

  try {
    const user = await User.findById(userId).select("-passwordHash -resetToken -verifyToken -resetTokenExpiry");
    if (!user) return res.status(403).json({ error: "Account not found. Please log in again." });
    req.userId = user._id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    res.status(500).json({ error: "Authentication error" });
  }
}

async function ensurePreferences(userId) {
  try {
    await Preferences.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, theme: "light", accentColor: "indigo" } },
      { upsert: true, new: false }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
}

// ─────────────────────────────────────────────
// GOOGLE OAUTH POPUP HTML
// Closes the popup window and sends the JWT (or error) back
// to the opener (auth page) via postMessage.
// ─────────────────────────────────────────────
function buildPopupHTML(token, user, error) {
  const payload = JSON.stringify(
    token
      ? { type: "FOCUS_TRACKER_AUTH", token, user }
      : { type: "FOCUS_TRACKER_AUTH", error: error || "Sign-in failed" }
  );

  // Extension pages have a null origin — we MUST use "*" here.
  // This is safe because the message type "FOCUS_TRACKER_AUTH" is namespaced
  // and auth.js only processes messages with exactly that type.
  const script = `
(function() {
  function send() {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(${payload}, "*");
      }
    } catch (e) {
      console.warn("postMessage failed:", e);
    }
    // Small delay so opener can process before window closes
    setTimeout(function() { window.close(); }, 500);
  }
  // Try immediately, then retry once in case opener isn't ready
  if (document.readyState === "complete") { send(); }
  else { window.addEventListener("load", send); }
})();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${token ? "Signing in…" : "Sign-in failed"}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
      background: #f5f3ef; color: #57534e;
    }
    .box { text-align: center; padding: 32px; }
    .icon { font-size: 40px; margin-bottom: 16px; }
    .title { font-size: 16px; font-weight: 600; color: #1c1917; margin-bottom: 6px; }
    .sub   { font-size: 13px; color: #a8a29e; }
    .spinner {
      width: 40px; height: 40px;
      border: 3px solid #e0dbd4; border-top-color: #4f46e5;
      border-radius: 50%; animation: spin 0.7s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    ${token
      ? `<div class="spinner"></div>
         <div class="title">Signing you in…</div>
         <div class="sub">This window will close automatically.</div>`
      : `<div class="icon">⚠️</div>
         <div class="title">Sign-in failed</div>
         <div class="sub">${error || "Please close this window and try again."}</div>`
    }
  </div>
  <script>${script}</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// SHARED: find-or-create user from Google profile
// ─────────────────────────────────────────────
async function findOrCreateGoogleUser({ googleId, email, name, avatar }) {
  let user = await User.findOne({ $or: [{ googleId }, { email: email.toLowerCase() }] });
  if (!user) {
    user = await User.create({
      email: email.toLowerCase(),
      googleId,
      displayName: sanitizeName(name, email.split("@")[0]),
      avatar: avatar || "",
      authMethod: "google",
      isVerified: true,
    });
    await ensurePreferences(user._id);
  } else {
    if (!user.googleId) {
      user.googleId = googleId;
      user.isVerified = true;
      user.authMethod = user.passwordHash ? "both" : "google";
    }
    user.lastLoginAt = new Date();
    if (avatar) user.avatar = avatar;
    await user.save();
  }
  return user;
}

// ─────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────

// POST /auth/signup
app.post("/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || typeof email !== "string" || email.length > 254)
    return res.status(400).json({ error: "Valid email is required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Invalid email address" });
  if (!password || typeof password !== "string")
    return res.status(400).json({ error: "Password is required" });
  if (password.length < 8 || password.length > 128)
    return res.status(400).json({ error: "Password must be 8–128 characters" });
  if (name && (typeof name !== "string" || name.length > 64))
    return res.status(400).json({ error: "Name must be under 64 characters" });

  try {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken = crypto.randomBytes(32).toString("hex");

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash,
      displayName: sanitizeName(name, email.split("@")[0]),
      authMethod: "email",
      isVerified: false,
      verifyToken,
    });

    await ensurePreferences(user._id);

    if (transporter) {
      sendVerificationEmail(email, verifyToken).catch(e =>
        console.error("Verification email failed:", e.message)
      );
    } else {
      user.isVerified = true;
      user.verifyToken = null;
      await user.save();
    }

    const token = createAuthToken(user._id.toString());
    res.status(201).json({
      success: true,
      token,
      user: { email: user.email, name: user.displayName, isVerified: user.isVerified },
      message: transporter
        ? "Account created! Check your email to verify."
        : "Account created successfully!",
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ error: "Failed to create account. Please try again." });
  }
});

// GET /auth/verify-email
app.get("/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== "string")
    return res.status(400).send("Invalid verification link");
  try {
    const user = await User.findOne({ verifyToken: token }).select("+verifyToken");
    if (!user) return res.status(400).send("Link expired or already used");
    user.isVerified = true;
    user.verifyToken = null;
    await user.save();
    res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Verified</title></head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px;">
  <h2 style="color:#16a34a;">✅ Email verified!</h2>
  <p>You can close this tab and return to Focus Tracker.</p>
</body></html>`);
  } catch {
    res.status(500).send("Verification failed. Please try again.");
  }
});

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || typeof email !== "string" || email.length > 254)
    return res.status(400).json({ error: "Valid email is required" });
  if (!password || typeof password !== "string" || password.length > 128)
    return res.status(400).json({ error: "Password is required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() }).select("+passwordHash");
    // Same error message whether user not found or wrong password — prevents email enumeration
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
      user: { email: user.email, name: user.displayName, isVerified: user.isVerified },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /auth/google — chrome.identity fallback (Chrome extension native flow)
app.post("/auth/google", async (req, res) => {
  if (!googleClient)
    return res.status(501).json({ error: "Google login not configured" });

  const { idToken, accessToken } = req.body;
  try {
    let googleId, email, name, avatar;

    if (idToken) {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID,
      });
      const p = ticket.getPayload();
      googleId = p.sub; email = p.email; name = p.name; avatar = p.picture;
    } else if (accessToken) {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error("Google userinfo request failed");
      const p = await r.json();
      googleId = p.sub; email = p.email; name = p.name; avatar = p.picture;
    } else {
      return res.status(400).json({ error: "Google token required" });
    }

    if (!email) throw new Error("Google did not return an email");

    const user = await findOrCreateGoogleUser({ googleId, email, name, avatar });
    const token = createAuthToken(user._id.toString());
    res.json({
      success: true,
      token,
      user: { email: user.email, name: user.displayName, avatar: user.avatar, isVerified: true },
    });
  } catch (err) {
    console.error("Google auth (identity) error:", err.message);
    res.status(401).json({ error: "Google sign-in failed. Please try again." });
  }
});

// GET /auth/google/popup — opens Google consent screen in the popup window
app.get("/auth/google/popup", (req, res) => {
  if (!googleClient) {
    return res.status(501).send(buildPopupHTML(null, null,
      "Google sign-in is not configured on this server."));
  }

  const base = getServerBase(req);
  const callbackUri = `${base}/auth/google/callback`;

  // Encode the exact callbackUri into state — /callback reads it back
  // so both sides use the byte-for-byte same redirect_uri (Google requires this)
  const state = Buffer.from(JSON.stringify({ cb: callbackUri })).toString("base64url");

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: callbackUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state,
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /auth/google/callback — Google redirects here after user approves
app.get("/auth/google/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error || !code) {
    const msg = error === "access_denied"
      ? "Google sign-in was cancelled"
      : (error || "Sign-in failed — no authorisation code received");
    return res.send(buildPopupHTML(null, null, msg));
  }

  if (!googleClient) {
    return res.send(buildPopupHTML(null, null, "Google OAuth is not configured"));
  }

  try {
    // Recover exact redirect_uri from state (must match what /popup sent)
    let callbackUri;
    try {
      const decoded = JSON.parse(Buffer.from(state || "", "base64url").toString("utf8"));
      callbackUri = decoded?.cb;
    } catch { /* fall through */ }
    if (!callbackUri) {
      callbackUri = `${getServerBase(req)}/auth/google/callback`;
    }

    // Exchange code for tokens
    const { tokens } = await googleClient.getToken({ code, redirect_uri: callbackUri });
    if (!tokens.id_token) throw new Error("No id_token in Google response");

    // Verify and extract profile
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const { sub: googleId, email, name, picture: avatar } = p;
    if (!email) throw new Error("Google did not return an email");

    const user = await findOrCreateGoogleUser({ googleId, email, name, avatar });
    const token = createAuthToken(user._id.toString());

    res.send(buildPopupHTML(token, {
      email: user.email,
      name: user.displayName,
      avatar: user.avatar,
      isVerified: true,
    }));
  } catch (err) {
    console.error("Google callback error:", err.message);
    res.send(buildPopupHTML(null, null,
      "Sign-in failed. Please close this window and try again."));
  }
});

// GET /auth/google/debug — dev only, blocked in production
app.get("/auth/google/debug", (req, res) => {
  if (process.env.NODE_ENV === "production")
    return res.status(404).json({ error: "Not found" });
  const base = getServerBase(req);
  res.json({
    google_configured: !!googleClient,
    redirect_uri: `${base}/auth/google/callback`,
    prod_url_env: PROD_URL || "(not set)",
    note: "Disabled in production",
  });
});

// POST /auth/forgot-password
app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== "string" || email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Valid email is required" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() })
      .select("+resetToken +resetTokenExpiry +passwordHash");

    // Generic response whether user exists or not — prevents email enumeration
    if (!user) {
      return res.json({ success: true, message: "If that email exists, a reset code was sent." });
    }

    // Google-only account — no password to reset
    if (!user.passwordHash) {
      return res.status(400).json({
        error: "This account uses Google Sign-In. Click 'Continue with Google' to log in — there is no password to reset.",
      });
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.resetToken = hashOTP(otp);
    user.resetTokenExpiry = otpExpiry;
    await user.save();

    await sendPasswordResetEmail(email, otp, user._id);
    console.log("✅ Password reset email sent");

    res.json({ success: true, message: "Reset code sent! Check your inbox." });
  } catch (err) {
    console.error("Forgot password error:", err.message);
    res.status(500).json({ error: "Failed to send reset email. Please try again." });
  }
});

// POST /auth/reset-password
app.post("/auth/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || typeof email !== "string" || email.length > 254)
    return res.status(400).json({ error: "Valid email is required" });
  if (!otp || typeof otp !== "string" || !/^\d{6}$/.test(otp))
    return res.status(400).json({ error: "Enter the 6-digit code from your email" });
  if (!newPassword || typeof newPassword !== "string" ||
    newPassword.length < 8 || newPassword.length > 128)
    return res.status(400).json({ error: "Password must be 8–128 characters" });

  try {
    const user = await User.findOne({ email: email.toLowerCase() })
      .select("+resetToken +resetTokenExpiry +passwordHash");

    if (!user || !user.resetToken || !user.resetTokenExpiry)
      return res.status(400).json({ error: "Invalid or expired reset code" });
    if (new Date() > user.resetTokenExpiry)
      return res.status(400).json({ error: "Reset code expired. Please request a new one." });
    if (hashOTP(otp) !== user.resetToken)
      return res.status(400).json({ error: "Incorrect reset code" });

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await user.save();

    res.json({ success: true, message: "Password reset! You can now sign in." });
  } catch (err) {
    console.error("Reset password error:", err.message);
    res.status(500).json({ error: "Password reset failed. Please try again." });
  }
});

// GET /auth/me
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({
      email: user.email,
      name: user.displayName,
      avatar: user.avatar,
      isVerified: user.isVerified,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// POST /auth/logout
app.post("/auth/logout", requireAuth, (req, res) => {
  // Tokens are stateless — client clears its own storage
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────
// BLOCKED SITES
// ─────────────────────────────────────────────────────────────────────
app.get("/blocked-sites", requireAuth, async (req, res) => {
  try {
    const sites = await BlockedSite.find({ userId: req.userId }, { _id: 0, site: 1 });
    res.json(sites.map(s => s.site));
  } catch (err) {
    console.error("GET /blocked-sites:", err.message);
    res.status(500).json({ error: "Failed to load blocked sites" });
  }
});

app.post("/blocked-sites", requireAuth, async (req, res) => {
  const { site } = req.body;
  if (!site || typeof site !== "string" || site.length > 253)
    return res.status(400).json({ error: "Valid site URL required" });

  const normalized = normalizeDomain(site);
  if (!normalized || normalized.length < 4 || !normalized.includes("."))
    return res.status(400).json({ error: "Invalid domain" });

  try {
    await BlockedSite.updateOne(
      { userId: req.userId, site: normalized },
      { $set: { userId: req.userId, site: normalized } },
      { upsert: true }
    );
    res.json({ success: true, site: normalized });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, site: normalized });
    console.error("POST /blocked-sites:", err.message);
    res.status(500).json({ error: "Failed to save blocked site" });
  }
});

app.delete("/blocked-sites/:site", requireAuth, async (req, res) => {
  try {
    const normalized = normalizeDomain(decodeURIComponent(req.params.site));
    await BlockedSite.deleteOne({ userId: req.userId, site: normalized });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /blocked-sites:", err.message);
    res.status(500).json({ error: "Failed to remove blocked site" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────────────────────────────────
const VALID_CATEGORIES = ["Learning", "Development", "Distraction", "Other"];

app.get("/categories", requireAuth, async (req, res) => {
  try {
    const mappings = await CategoryMapping.find(
      { userId: req.userId },
      { _id: 0, domain: 1, category: 1 }
    );
    res.json(mappings);
  } catch (err) {
    console.error("GET /categories:", err.message);
    res.status(500).json({ error: "Failed to load categories" });
  }
});

app.post("/categories", requireAuth, async (req, res) => {
  const { domain, category } = req.body;

  if (!domain || typeof domain !== "string" || domain.length > 253)
    return res.status(400).json({ error: "Valid domain required" });
  if (!category || typeof category !== "string" || category.trim().length === 0)
    return res.status(400).json({ error: "Category name is required" });
  if (category.length > 64)
    return res.status(400).json({ error: "Category name must be 64 characters or fewer" });

  const sanitizedCategory = category.trim();
  const normalized = normalizeDomain(domain);
  if (!normalized || !normalized.includes("."))
    return res.status(400).json({ error: "Invalid domain" });

  try {
    await CategoryMapping.updateOne(
      { userId: req.userId, domain: normalized },
      { $set: { userId: req.userId, domain: normalized, category: sanitizedCategory, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true, domain: normalized, category: sanitizedCategory });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true, domain: normalized, category: sanitizedCategory });
    console.error("POST /categories:", err.message);
    res.status(500).json({ error: "Failed to save category" });
  }
});


app.delete("/categories/:domain", requireAuth, async (req, res) => {
  try {
    const normalized = normalizeDomain(decodeURIComponent(req.params.domain));
    await CategoryMapping.deleteOne({ userId: req.userId, domain: normalized });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /categories:", err.message);
    res.status(500).json({ error: "Failed to delete category" });
  }
});

// GET /custom-categories — return all custom categories for this user
app.get("/custom-categories", requireAuth, async (req, res) => {
  try {
    const cats = await CustomCategory.find(
      { userId: req.userId },
      { _id: 0, catId: 1, name: 1, emoji: 1, color: 1 }
    );
    res.json(cats);
  } catch (err) {
    console.error("GET /custom-categories:", err.message);
    res.status(500).json({ error: "Failed to load custom categories" });
  }
});

// POST /custom-categories — create or update a custom category
app.post("/custom-categories", requireAuth, async (req, res) => {
  const { catId, name, emoji, color } = req.body;

  if (!catId || typeof catId !== "string" || catId.trim().length === 0 || catId.length > 64)
    return res.status(400).json({ error: "Valid catId required (max 64 chars)" });
  if (!name || typeof name !== "string" || name.trim().length === 0 || name.length > 64)
    return res.status(400).json({ error: "Valid name required" });
  if (emoji && (typeof emoji !== "string" || emoji.length > 8))
    return res.status(400).json({ error: "Invalid emoji" });
  if (color && (typeof color !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(color)))
    return res.status(400).json({ error: "Invalid color (must be hex like #6366f1)" });

  try {
    await CustomCategory.updateOne(
      { userId: req.userId, catId: catId.trim() },
      {
        $set: {
          userId: req.userId,
          catId: catId.trim(),
          name: name.trim(),
          emoji: emoji || "📁",
          color: color || "#6366f1",
          updatedAt: new Date(),
        }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true });
    console.error("POST /custom-categories:", err.message);
    res.status(500).json({ error: "Failed to save custom category" });
  }
});

// DELETE /custom-categories/:catId — delete a custom category + all its domain mappings
app.delete("/custom-categories/:catId", requireAuth, async (req, res) => {
  try {
    const catId = decodeURIComponent(req.params.catId).trim();
    // Remove the category metadata
    await CustomCategory.deleteOne({ userId: req.userId, catId });
    // Remove all domain mappings that pointed to this category
    await CategoryMapping.deleteMany({ userId: req.userId, category: catId });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /custom-categories:", err.message);
    res.status(500).json({ error: "Failed to delete custom category" });
  }
});


// ─────────────────────────────────────────────────────────────────────
// REFLECTIONS
// ─────────────────────────────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

app.get("/reflections", requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const query = { userId: req.userId };
    if (startDate && endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate)) {
      query.date = { $gte: startDate, $lte: endDate };
    }
    const reflections = await Reflection.find(query).sort({ date: -1 });
    res.json(reflections);
  } catch (err) {
    console.error("GET /reflections:", err.message);
    res.status(500).json({ error: "Failed to load reflections" });
  }
});

app.get("/reflections/:date", requireAuth, async (req, res) => {
  if (!DATE_RE.test(req.params.date))
    return res.status(400).json({ error: "Invalid date format (YYYY-MM-DD)" });
  try {
    const r = await Reflection.findOne({ userId: req.userId, date: req.params.date });
    res.json(r || {});
  } catch (err) {
    console.error("GET /reflections/:date:", err.message);
    res.status(500).json({ error: "Failed to load reflection" });
  }
});

app.post("/reflections", requireAuth, async (req, res) => {
  const { date, distractions, wentWell, improvements } = req.body;
  if (!date || !DATE_RE.test(date))
    return res.status(400).json({ error: "Valid date required (YYYY-MM-DD)" });

  const clamp = (s) => typeof s === "string" ? s.slice(0, 2000) : "";

  try {
    await Reflection.updateOne(
      { userId: req.userId, date },
      {
        $set: {
          userId: req.userId, date,
          distractions: clamp(distractions),
          wentWell: clamp(wentWell),
          improvements: clamp(improvements),
          createdAt: new Date(),
        }
      },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true });
    console.error("POST /reflections:", err.message);
    res.status(500).json({ error: "Failed to save reflection" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PREFERENCES
// ─────────────────────────────────────────────────────────────────────
app.get("/preferences", requireAuth, async (req, res) => {
  try {
    let prefs = await Preferences.findOne({ userId: req.userId });
    if (!prefs) {
      prefs = await Preferences.create({ userId: req.userId, theme: "light", accentColor: "indigo" });
    }
    res.json({ theme: prefs.theme, accentColor: prefs.accentColor });
  } catch (err) {
    console.error("GET /preferences:", err.message);
    res.status(500).json({ error: "Failed to load preferences" });
  }
});

app.post("/preferences", requireAuth, async (req, res) => {
  const { theme, accentColor } = req.body;
  const validThemes = ["light", "dark"];
  const validAccents = ["green", "blue", "purple", "red", "orange", "indigo"];

  const safeTheme = validThemes.includes(theme) ? theme : "light";
  const safeAccent = validAccents.includes(accentColor) ? accentColor : "indigo";

  try {
    await Preferences.updateOne(
      { userId: req.userId },
      { $set: { theme: safeTheme, accentColor: safeAccent, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 11000) return res.json({ success: true });
    console.error("POST /preferences:", err.message);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    email: brevo ? "configured" : "disabled",
    google: googleClient ? "configured" : "not configured",
  });
});

// ─────────────────────────────────────────────────────────────────────
// KEEP-ALIVE (Render free tier — prevents cold starts)
// Pings /health every 14 minutes to keep the dyno awake.
// Only runs in production.
// ─────────────────────────────────────────────────────────────────────
function startKeepAlive() {
  if (process.env.NODE_ENV !== "production" || !PROD_URL) return;
  const url = `${PROD_URL.replace(/\/+$/, "")}/health`;
  setInterval(async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) console.warn("⚠️  Keep-alive ping returned:", r.status);
    } catch (err) {
      console.warn("⚠️  Keep-alive ping failed:", err.message);
    }
  }, 14 * 60 * 1000); // 14 minutes
  console.log(`🏓 Keep-alive enabled → ${url} (every 14 min)`);
}

// ─────────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Focus Tracker server running on port ${PORT}`);
  console.log(`   Environment : ${process.env.NODE_ENV || "development"}`);
  console.log(`   Database    : ${MONGODB_URI ? "MongoDB Atlas" : "localhost"}`);
  console.log(`   Email       : ${brevo ? EMAIL_USER : "disabled"}`);
  console.log(`   Google OAuth: ${googleClient ? "enabled" : "disabled (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)"}`);
  console.log(`   Public URL  : ${PROD_URL || "(not set — derived from request headers)"}\n`);
  startKeepAlive();
});