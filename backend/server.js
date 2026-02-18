// server.js — Focus Tracker backend
// NEW in this version:
//   - UserCategory schema: per-user categories with name, emoji, color, domains
//   - Default categories seeded on first login/signup (isolated per user)
//   - Full CRUD: GET/POST/PUT/DELETE /user-categories
//   - CategoryMapping removed — domains now stored inside UserCategory.domains[]
//   - All category lookups return user-specific data

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
app.set("trust proxy", 1);

const { MONGODB_URI, EMAIL_USER, EMAIL_PASSWORD, GOOGLE_CLIENT_ID, JWT_SECRET, ALLOWED_ORIGINS, PORT = 5000 } = process.env;

// ── CORS ──
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : ["http://localhost:5000","http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith("chrome-extension://"))
      return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true
}));
app.use(express.json({ limit: "10kb" }));

// ── RATE LIMITS ──
app.use("/auth", rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: "Too many attempts. Try in 15 min." } }));
app.use("/",     rateLimit({ windowMs: 60*1000,    max: 200 }));

// ── MONGODB ──
mongoose.connect(MONGODB_URI || "mongodb://localhost:27017/focus-tracker")
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB:", err));

// ── EMAIL ──
let transporter = null;
if (EMAIL_USER && EMAIL_PASSWORD) {
  try {
    transporter = nodemailer.createTransport({ service:"gmail", auth:{ user:EMAIL_USER, pass:EMAIL_PASSWORD.replace(/\s/g,"") } });
    console.log("✅ Email ready");
  } catch (e) { console.error("❌ Email:", e.message); }
}

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ═══════════════════════════════════════════════════════
//  SCHEMAS
// ═══════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  email:            { type:String, unique:true, sparse:true, lowercase:true },
  passwordHash:     { type:String, default:null },
  googleId:         { type:String, unique:true, sparse:true },
  displayName:      { type:String, default:"" },
  avatar:           { type:String, default:"" },
  authMethod:       { type:String, enum:["email","google","both"], default:"email" },
  isVerified:       { type:Boolean, default:false },
  verifyToken:      { type:String, default:null },
  resetToken:       { type:String, default:null },
  resetTokenExpiry: { type:Date, default:null },
  createdAt:        { type:Date, default:Date.now },
  lastLoginAt:      { type:Date, default:Date.now }
});

// PER-USER CATEGORIES — replaces flat CategoryMapping
// Each user gets their own isolated category list.
// domains[] stores which domains map to this category.
const userCategorySchema = new mongoose.Schema({
  userId:   { type:mongoose.Schema.Types.ObjectId, ref:"User", required:true },
  id:       { type:String, required:true },      // slug: "learning", "my-work", etc.
  name:     { type:String, required:true },       // display name
  emoji:    { type:String, default:"📁" },
  color:    { type:String, default:"#6366f1" },   // hex
  isSystem: { type:Boolean, default:false },      // system cats can't be deleted
  order:    { type:Number, default:99 },
  domains:  [String],                             // ["github.com","gitlab.com"]
  updatedAt:{ type:Date, default:Date.now }
});
userCategorySchema.index({ userId:1, id:1 }, { unique:true });

const blockedSiteSchema = new mongoose.Schema({
  userId: { type:mongoose.Schema.Types.ObjectId, ref:"User", required:true },
  site:   { type:String, required:true }
});
blockedSiteSchema.index({ userId:1, site:1 }, { unique:true });

const reflectionSchema = new mongoose.Schema({
  userId:       { type:mongoose.Schema.Types.ObjectId, ref:"User", required:true },
  date:         { type:String, required:true },
  distractions: { type:String, default:"" },
  wentWell:     { type:String, default:"" },
  improvements: { type:String, default:"" },
  createdAt:    { type:Date, default:Date.now }
});
reflectionSchema.index({ userId:1, date:1 }, { unique:true });

const preferencesSchema = new mongoose.Schema({
  userId:      { type:mongoose.Schema.Types.ObjectId, ref:"User", unique:true, required:true },
  theme:       { type:String, enum:["light","dark"], default:"light" },
  accentColor: { type:String, default:"blue" },
  updatedAt:   { type:Date, default:Date.now }
});

const User        = mongoose.model("User",        userSchema);
const UserCat     = mongoose.model("UserCategory", userCategorySchema);
const BlockedSite = mongoose.model("BlockedSite", blockedSiteSchema);
const Reflection  = mongoose.model("Reflection",  reflectionSchema);
const Preferences = mongoose.model("Preferences", preferencesSchema);

// ═══════════════════════════════════════════════════════
//  DEFAULT CATEGORIES (seeded per user on first signup/login)
// ═══════════════════════════════════════════════════════
const DEFAULT_CATEGORIES = [
  { id:"learning",    name:"Learning",    emoji:"📚", color:"#22c55e", isSystem:true,  order:0, domains:["leetcode.com","coursera.org","udemy.com","khanacademy.org","edx.org","pluralsight.com","geeksforgeeks.org"] },
  { id:"development", name:"Development", emoji:"💻", color:"#3b82f6", isSystem:true,  order:1, domains:["github.com","stackoverflow.com","dev.to","npmjs.com","docs.python.org","developer.mozilla.org"] },
  { id:"distraction", name:"Distraction", emoji:"⚠️", color:"#ef4444", isSystem:true,  order:2, domains:["youtube.com","instagram.com","facebook.com","twitter.com","reddit.com","tiktok.com","netflix.com","twitch.tv"] },
  { id:"other",       name:"Other",       emoji:"📦", color:"#f97316", isSystem:true,  order:3, domains:[] },
];

async function seedDefaultCategories(userId) {
  const existing = await UserCat.countDocuments({ userId });
  if (existing > 0) return; // already seeded
  const docs = DEFAULT_CATEGORIES.map(c => ({ ...c, userId }));
  await UserCat.insertMany(docs).catch(() => {}); // ignore dup errors
  console.log(`✅ Seeded default categories for user ${userId}`);
}

// ═══════════════════════════════════════════════════════
//  TOKEN UTILS
// ═══════════════════════════════════════════════════════
const TOKEN_DAYS = 30;

function createAuthToken(userId) {
  const expiry  = Date.now() + TOKEN_DAYS * 86400000;
  const payload = Buffer.from(`${userId}.${expiry}`).toString("base64url");
  const secret  = JWT_SECRET || "change-in-production";
  const sig     = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyAuthToken(token) {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const secret   = JWT_SECRET || "change-in-production";
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    if (sig !== expected) return null;
    const [userId, expiry] = Buffer.from(payload, "base64url").toString().split(".");
    if (Date.now() > parseInt(expiry)) return null;
    return userId;
  } catch { return null; }
}

function generateOTP() { return crypto.randomInt(100000, 999999).toString(); }
function hashOTP(otp)  { return crypto.createHash("sha256").update(otp).digest("hex"); }

// ── EMAIL HELPERS ──
const PROD_URL = process.env.PROD_URL || `http://localhost:${PORT}`;

async function sendVerificationEmail(email, token) {
  if (!transporter) return;
  await transporter.sendMail({
    from: `"Focus Tracker" <${EMAIL_USER}>`,
    to: email,
    subject: "Verify your Focus Tracker account",
    html: `<div style="font-family:Arial;max-width:600px;margin:0 auto"><h2 style="color:#3b82f6">⏱️ Welcome!</h2><p>Click to verify your email:</p><a href="${PROD_URL}/auth/verify-email?token=${token}" style="display:inline-block;padding:14px 28px;background:#3b82f6;color:white;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a><p style="color:#64748b;font-size:13px">Expires in 24h.</p></div>`
  });
}

async function sendPasswordResetEmail(email, otp) {
  if (!transporter) throw new Error("Email not configured");
  await transporter.sendMail({
    from: `"Focus Tracker" <${EMAIL_USER}>`,
    to: email,
    subject: "Reset your Focus Tracker password",
    html: `<div style="font-family:Arial;max-width:600px;margin:0 auto"><h2 style="color:#3b82f6">⏱️ Password Reset</h2><p>Your 6-digit code:</p><h1 style="background:#f1f5f9;padding:20px;text-align:center;letter-spacing:8px;color:#1e293b;border-radius:8px">${otp}</h1><p style="color:#64748b;font-size:13px">Expires in 10 min.</p></div>`
  });
}

// ── AUTH MIDDLEWARE ──
async function auth(req, res, next) {
  const token  = req.headers["authorization"]?.split(" ")[1];
  if (!token)  return res.status(401).json({ error: "Login required" });
  const userId = verifyAuthToken(token);
  if (!userId) return res.status(403).json({ error: "Session expired" });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(403).json({ error: "Account not found" });
    req.userId = user._id; req.userEmail = user.email; next();
  } catch { res.status(500).json({ error: "Auth error" }); }
}

async function ensurePreferences(userId) {
  const e = await Preferences.findOne({ userId });
  if (!e) await Preferences.create({ userId, theme:"light", accentColor:"blue" });
}

// ═══════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════

app.post("/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password)    return res.status(400).json({ error: "Email and password required" });
  if (password.length < 8)    return res.status(400).json({ error: "Password must be 8+ characters" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Invalid email" });
  try {
    if (await User.findOne({ email: email.toLowerCase() }))
      return res.status(409).json({ error: "Email already registered" });
    const passwordHash = await bcrypt.hash(password, 12);
    const verifyToken  = crypto.randomBytes(32).toString("hex");
    const user = await User.create({
      email: email.toLowerCase(), passwordHash,
      displayName: name || email.split("@")[0],
      authMethod: "email", isVerified: false, verifyToken
    });
    await ensurePreferences(user._id);
    await seedDefaultCategories(user._id);
    if (transporter) {
      sendVerificationEmail(email, verifyToken).catch(e => console.error("Verify email failed:", e.message));
    } else {
      user.isVerified = true; user.verifyToken = null; await user.save();
    }
    const token = createAuthToken(user._id.toString());
    res.json({ success:true, token, user:{ email:user.email, name:user.displayName, isVerified:user.isVerified },
      message: EMAIL_USER ? "Check email to verify." : "Account created!" });
  } catch (e) { console.error("Signup:", e); res.status(500).json({ error: "Failed to create account" }); }
});

app.get("/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Invalid link");
  try {
    const user = await User.findOne({ verifyToken: token });
    if (!user) return res.status(400).send("Link expired or already used");
    user.isVerified = true; user.verifyToken = null; await user.save();
    res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px"><h2 style="color:#22c55e">✅ Verified!</h2><p>You can close this tab.</p></body></html>`);
  } catch { res.status(500).send("Verification failed"); }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash) return res.status(401).json({ error: "Incorrect email or password" });
    if (!await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: "Incorrect email or password" });
    user.lastLoginAt = new Date(); await user.save();
    await ensurePreferences(user._id);
    await seedDefaultCategories(user._id);
    const token = createAuthToken(user._id.toString());
    res.json({ success:true, token, user:{ email:user.email, name:user.displayName, isVerified:user.isVerified } });
  } catch (e) { console.error("Login:", e); res.status(500).json({ error: "Login failed" }); }
});

app.post("/auth/google", async (req, res) => {
  const { idToken, accessToken } = req.body;
  if (!googleClient) return res.status(501).json({ error: "Google login not configured" });
  try {
    let googleId, email, name, avatar;
    if (idToken) {
      const payload = (await googleClient.verifyIdToken({ idToken, audience:GOOGLE_CLIENT_ID })).getPayload();
      ({ sub:googleId, email, name, picture:avatar } = payload);
    } else if (accessToken) {
      const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers:{ Authorization:`Bearer ${accessToken}` } });
      if (!r.ok) throw new Error("Invalid Google token");
      ({ sub:googleId, email, name, picture:avatar } = await r.json());
    } else return res.status(400).json({ error: "Token required" });

    let user = await User.findOne({ $or:[{ googleId },{ email }] });
    if (!user) {
      user = await User.create({ email:email.toLowerCase(), googleId, displayName:name||email.split("@")[0], avatar, authMethod:"google", isVerified:true });
      await ensurePreferences(user._id);
      await seedDefaultCategories(user._id);
    } else {
      if (!user.googleId) { user.googleId = googleId; user.authMethod = user.passwordHash?"both":"google"; user.isVerified=true; }
      user.lastLoginAt = new Date(); user.avatar = avatar||user.avatar; await user.save();
      await seedDefaultCategories(user._id);
    }
    const token = createAuthToken(user._id.toString());
    res.json({ success:true, token, user:{ email:user.email, name:user.displayName, avatar:user.avatar, isVerified:true } });
  } catch (e) { console.error("Google auth:", e); res.status(401).json({ error: "Google sign-in failed" }); }
});

app.post("/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.passwordHash) return res.json({ success:true, message:"If that email exists, a reset code was sent." });
    const otp = generateOTP();
    user.resetToken = hashOTP(otp); user.resetTokenExpiry = new Date(Date.now()+600000); await user.save();
    await sendPasswordResetEmail(email, otp);
    res.json({ success:true, message:"Reset code sent." });
  } catch (e) { console.error("Forgot PW:", e); res.status(500).json({ error: "Failed to send reset email" }); }
});

app.post("/auth/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email||!otp||!newPassword) return res.status(400).json({ error: "All fields required" });
  if (newPassword.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user||!user.resetToken||!user.resetTokenExpiry) return res.status(400).json({ error: "Invalid or expired code" });
    if (new Date() > user.resetTokenExpiry) return res.status(400).json({ error: "Code expired" });
    if (hashOTP(otp) !== user.resetToken) return res.status(400).json({ error: "Incorrect code" });
    user.passwordHash = await bcrypt.hash(newPassword, 12); user.resetToken=null; user.resetTokenExpiry=null; await user.save();
    res.json({ success:true, message:"Password reset. You can now log in." });
  } catch (e) { console.error("Reset PW:", e); res.status(500).json({ error: "Reset failed" }); }
});

app.get("/auth/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId, { passwordHash:0, resetToken:0, verifyToken:0 });
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({ email:user.email, name:user.displayName, avatar:user.avatar, isVerified:user.isVerified });
  } catch { res.status(500).json({ error: "Failed" }); }
});

app.post("/auth/logout", auth, (req, res) => res.json({ success:true }));

// ═══════════════════════════════════════════════════════
//  USER CATEGORIES (new — replaces /categories)
//  GET    /user-categories              — list all for user
//  POST   /user-categories              — create new
//  PUT    /user-categories/:id          — edit (name/emoji/color/domains)
//  DELETE /user-categories/:id          — delete (non-system only)
//  POST   /user-categories/:id/domains  — add domain mapping
//  DELETE /user-categories/:id/domains/:domain — remove domain
// ═══════════════════════════════════════════════════════

app.get("/user-categories", auth, async (req, res) => {
  try {
    const cats = await UserCat.find({ userId:req.userId }).sort({ order:1, createdAt:1 });
    res.json(cats);
  } catch (e) { console.error("GET /user-categories:", e); res.status(500).json({ error:"Failed" }); }
});

app.post("/user-categories", auth, async (req, res) => {
  const { name, emoji, color, domains } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:"Name required" });
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "-" + Date.now();
  try {
    const cat = await UserCat.create({
      userId: req.userId, id, name:name.trim(),
      emoji:  emoji  || "📁",
      color:  color  || "#6366f1",
      domains: Array.isArray(domains) ? domains.map(d=>d.toLowerCase().trim()) : [],
      isSystem: false, order: 99
    });
    res.json({ success:true, category:cat });
  } catch (e) {
    if (e.code===11000) return res.status(409).json({ error:"Category ID conflict, try a different name" });
    console.error("POST /user-categories:", e); res.status(500).json({ error:"Failed" });
  }
});

app.put("/user-categories/:id", auth, async (req, res) => {
  const { name, emoji, color, domains, order } = req.body;
  try {
    const cat = await UserCat.findOne({ userId:req.userId, id:req.params.id });
    if (!cat) return res.status(404).json({ error:"Not found" });
    if (name)   cat.name   = name.trim();
    if (emoji)  cat.emoji  = emoji;
    if (color)  cat.color  = color;
    if (domains !== undefined) cat.domains = Array.isArray(domains) ? domains.map(d=>d.toLowerCase().trim()) : [];
    if (order   !== undefined) cat.order   = order;
    cat.updatedAt = new Date();
    await cat.save();
    res.json({ success:true, category:cat });
  } catch (e) { console.error("PUT /user-categories:", e); res.status(500).json({ error:"Failed" }); }
});

app.delete("/user-categories/:id", auth, async (req, res) => {
  try {
    const cat = await UserCat.findOne({ userId:req.userId, id:req.params.id });
    if (!cat)           return res.status(404).json({ error:"Not found" });
    if (cat.isSystem)   return res.status(400).json({ error:"Cannot delete system categories" });
    await cat.deleteOne();
    res.json({ success:true });
  } catch (e) { console.error("DELETE /user-categories:", e); res.status(500).json({ error:"Failed" }); }
});

// Add a domain to a category
app.post("/user-categories/:id/domains", auth, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error:"Domain required" });
  const nd = normalizeDomain(domain);
  try {
    // Remove domain from any other category first (domain can only belong to one)
    await UserCat.updateMany({ userId:req.userId }, { $pull:{ domains:nd } });
    const cat = await UserCat.findOneAndUpdate(
      { userId:req.userId, id:req.params.id },
      { $addToSet:{ domains:nd }, $set:{ updatedAt:new Date() } },
      { new:true }
    );
    if (!cat) return res.status(404).json({ error:"Not found" });
    res.json({ success:true, category:cat });
  } catch (e) { console.error("POST /user-categories/:id/domains:", e); res.status(500).json({ error:"Failed" }); }
});

// Remove a domain from a category
app.delete("/user-categories/:id/domains/:domain", auth, async (req, res) => {
  const nd = normalizeDomain(decodeURIComponent(req.params.domain));
  try {
    await UserCat.updateOne({ userId:req.userId, id:req.params.id }, { $pull:{ domains:nd } });
    res.json({ success:true });
  } catch (e) { console.error("DELETE /user-categories/:id/domains:", e); res.status(500).json({ error:"Failed" }); }
});

// ── Legacy /categories endpoint — returns flat mapping format for background.js ──
app.get("/categories", auth, async (req, res) => {
  try {
    const cats = await UserCat.find({ userId:req.userId });
    const flat = [];
    cats.forEach(cat => {
      cat.domains.forEach(domain => {
        flat.push({ domain, category:cat.id, name:cat.name, emoji:cat.emoji, color:cat.color });
      });
    });
    res.json(flat);
  } catch { res.status(500).json({ error:"Failed" }); }
});

// ═══════════════════════════════════════════════════════
//  BLOCKED SITES
// ═══════════════════════════════════════════════════════
function normalizeDomain(raw) {
  let s = (raw||"").trim().toLowerCase();
  if (!s.startsWith("http://")&&!s.startsWith("https://")) s="https://"+s;
  try { return new URL(s).hostname.replace(/^www\./,""); }
  catch { return raw.trim().toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].split("?")[0].split(":")[0]; }
}

app.get("/blocked-sites", auth, async (req, res) => {
  try {
    const sites = await BlockedSite.find({ userId:req.userId }, { _id:0, site:1 });
    res.json(sites.map(s=>s.site));
  } catch (e) { console.error("GET /blocked-sites:", e); res.status(500).json({ error:"Failed" }); }
});

app.post("/blocked-sites", auth, async (req, res) => {
  const { site } = req.body;
  console.log(`POST /blocked-sites — user:${req.userId} site:${site}`);
  if (!site) return res.status(400).json({ error:"Site required" });
  const nd = normalizeDomain(site);
  if (!nd||nd.length<2) return res.status(400).json({ error:"Invalid site" });
  try {
    await BlockedSite.updateOne({ userId:req.userId, site:nd }, { $set:{ userId:req.userId, site:nd } }, { upsert:true });
    console.log(`✅ Blocked: ${nd}`);
    res.json({ success:true, site:nd });
  } catch (e) {
    if (e.code===11000) return res.json({ success:true, site:nd });
    console.error(`❌ /blocked-sites: ${e.message}`); res.status(500).json({ error:"Failed" });
  }
});

app.delete("/blocked-sites/:site", auth, async (req, res) => {
  const nd = normalizeDomain(decodeURIComponent(req.params.site));
  try { await BlockedSite.deleteOne({ userId:req.userId, site:nd }); res.json({ success:true }); }
  catch (e) { console.error("DELETE /blocked-sites:", e); res.status(500).json({ error:"Failed" }); }
});

// ═══════════════════════════════════════════════════════
//  REFLECTIONS
// ═══════════════════════════════════════════════════════
app.get("/reflections", auth, async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const q = { userId:req.userId };
    if (startDate&&endDate) q.date = { $gte:startDate, $lte:endDate };
    res.json(await Reflection.find(q).sort({ date:-1 }));
  } catch { res.status(500).json({ error:"Failed" }); }
});

app.get("/reflections/:date", auth, async (req, res) => {
  try { res.json(await Reflection.findOne({ userId:req.userId, date:req.params.date }) || {}); }
  catch { res.status(500).json({ error:"Failed" }); }
});

app.post("/reflections", auth, async (req, res) => {
  const { date, distractions, wentWell, improvements } = req.body;
  if (!date) return res.status(400).json({ error:"Date required" });
  try {
    await Reflection.updateOne(
      { userId:req.userId, date },
      { $set:{ userId:req.userId, date, distractions:distractions||"", wentWell:wentWell||"", improvements:improvements||"", createdAt:new Date() } },
      { upsert:true }
    );
    res.json({ success:true });
  } catch (e) {
    if (e.code===11000) return res.json({ success:true });
    res.status(500).json({ error:"Failed" });
  }
});

// ═══════════════════════════════════════════════════════
//  PREFERENCES
// ═══════════════════════════════════════════════════════
app.get("/preferences", auth, async (req, res) => {
  try {
    let p = await Preferences.findOne({ userId:req.userId });
    if (!p) p = await Preferences.create({ userId:req.userId, theme:"light", accentColor:"blue" });
    res.json(p);
  } catch { res.status(500).json({ error:"Failed" }); }
});

app.post("/preferences", auth, async (req, res) => {
  const { theme, accentColor } = req.body;
  try {
    await Preferences.updateOne({ userId:req.userId }, { $set:{ theme:theme||"light", accentColor:accentColor||"blue", updatedAt:new Date() } }, { upsert:true });
    res.json({ success:true });
  } catch (e) {
    if (e.code===11000) return res.json({ success:true });
    res.status(500).json({ error:"Failed" });
  }
});

// ── HEALTH ──
app.get("/health", (req, res) => res.json({ status:"ok", ts:new Date().toISOString() }));

function startSelfPing(url) {
  if (!url||process.env.NODE_ENV!=="production") return;
  setInterval(async()=>{
    try { await fetch(`${url}/health`); console.log("🏓 ping OK"); }
    catch(e) { console.warn("⚠️ ping failed:", e.message); }
  }, 14*60*1000);
}

app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  startSelfPing(process.env.PROD_URL);
});