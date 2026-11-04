// Meridian Wealth Ledger – Express + MongoDB, with encrypted data and managed sessions
if (require("fs").existsSync(".env")) {
  for (const l of require("fs").readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");
const crypto = require("crypto");
const path = require("path");
const { encryptJson, decryptJson } = require("./lib/crypto");
const totp = require("./lib/totp");
const QRCode = require("qrcode");

const PROD = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const TYPES = ["income", "expense", "asset", "liability"];
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const AUTH_LIMIT = Number(process.env.AUTH_RATE_LIMIT) || 10;

if (!MONGODB_URI) { console.error("MONGODB_URI is required (see .env.example)"); process.exit(1); }
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error("JWT_SECRET is required in production"); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[dev] Random JWT secret in use; logins reset on restart.");
}

// ---------- Models ----------
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);
const { Schema } = mongoose;

const User = mongoose.model("User", new Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  failedLogins: { type: Number, default: 0 },
  lockUntil: Date,
  budgetsEnc: String, // encrypted JSON { category: amountMinor }
  goalsEnc: String,   // encrypted JSON [ {id,name,targetMinor,savedMinor} ]
  totpEnc: String,    // encrypted authenticator secret
  totpEnabled: { type: Boolean, default: false },
  totpLastStep: { type: Number, default: 0 },
  recoveryHashes: [String],
}, { timestamps: true }));

// Sensitive fields (category, note, amount) live encrypted in `data`; date and type stay queryable.
const entrySchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true },
  type: { type: String, enum: TYPES, required: true },
  data: { type: String, required: true },
}, { timestamps: true });
entrySchema.index({ user: 1, date: -1 });
const Entry = mongoose.model("Entry", entrySchema);

const Session = mongoose.model("Session", new Schema({
  user: { type: Schema.Types.ObjectId, required: true, index: true },
  username: String,
  sid: { type: String, required: true, unique: true },
  ip: String, ua: String,
  expiresAt: { type: Date, index: { expires: 0 } },
}, { timestamps: true }));

const Audit = mongoose.model("Audit", new Schema({
  user: { type: Schema.Types.ObjectId, index: true },
  event: String, ip: String, ua: String,
  createdAt: { type: Date, default: Date.now, expires: 90 * 24 * 3600 }, // auto-delete after 90 days
}));
const audit = (req, user, event) =>
  Audit.create({ user, event, ip: req.ip, ua: String(req.get("user-agent") || "").slice(0, 120) }).catch(() => {});

// ---------- App + security middleware ----------
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
const jsonSmall = express.json({ limit: "10kb" });
app.use((req, res, next) => (req.path === "/api/entries/import" ? next() : jsonSmall(req, res, next)));
app.use(mongoSanitize());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const limiter = (limit, windowMs = 15 * 60 * 1000, message) =>
  rateLimit({ windowMs, limit, standardHeaders: true, legacyHeaders: false, ...(message && { message: { error: message } }) });
const apiLimiter = limiter(300);
const authLimiter = limiter(AUTH_LIMIT, undefined, "Too many attempts. Please try again in 15 minutes.");
const sensitiveLimiter = limiter(AUTH_LIMIT, undefined, "Too many attempts. Please try again in 15 minutes.");
const exportLimiter = limiter(10, 60 * 60 * 1000, "Too many exports. Try again later.");
app.use("/api", apiLimiter);
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store"); // never cache private data
  if (["POST", "PUT"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "Content-Type must be application/json" });
  next();
});
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const str = (v) => (typeof v === "string" ? v : "");

// ---------- Validation ----------
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
function parseAmount(raw, allowZero = false) {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!AMOUNT_RE.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const minor = Number(i) * 100 + Number(f.padEnd(2, "0"));
  return minor > 0 || allowZero ? minor : null;
}
function validDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const AMOUNT_MSG = "Amount must be a positive number like 1500 or 1500.50 (letters and symbols are not allowed).";
function validateEntry(b = {}) {
  const fields = {};
  const amountMinor = parseAmount(b.amount);
  if (amountMinor === null) fields.amount = AMOUNT_MSG;
  if (!validDate(b.date)) fields.date = "Enter a valid date.";
  if (!TYPES.includes(b.type)) fields.type = "Choose income, expense, asset or liability.";
  const category = str(b.category).trim();
  if (!category || category.length > 50) fields.category = "Category is required (max 50 characters).";
  const description = str(b.description).trim();
  if (description.length > 200) fields.description = "Max 200 characters.";
  return { fields, value: { amountMinor, date: b.date, type: b.type, category, description } };
}
function pwError(pw) {
  if (pw.length < 8 || pw.length > 72) return "Password must be 8-72 characters.";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Use both letters and numbers.";
  return null;
}

// ---------- Sessions & auth ----------
const COOKIE = { httpOnly: true, sameSite: "strict", secure: PROD, maxAge: 7 * 24 * 3600 * 1000, path: "/" };
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

async function signIn(req, res, user) {
  const sid = crypto.randomBytes(24).toString("base64url");
  await Session.create({ user: user._id, username: user.username, sid, ip: req.ip,
    ua: String(req.get("user-agent") || "").slice(0, 200), expiresAt: new Date(Date.now() + COOKIE.maxAge) });
  res.cookie("token", jwt.sign({ id: user._id, sid }, JWT_SECRET, { expiresIn: "7d" }), COOKIE);
}
const clearCookie = (res) => res.clearCookie("token", { ...COOKIE, maxAge: undefined });

const requireAuth = wrap(async (req, res, next) => {
  const deny = () => res.status(401).json({ error: "Please log in." });
  let p;
  try { p = jwt.verify(req.cookies.token || "", JWT_SECRET); } catch { return deny(); }
  if (!mongoose.isValidObjectId(p.id) || typeof p.sid !== "string") return deny();
  const s = await Session.findOne({ sid: p.sid, user: p.id }).lean(); // revoked sessions stop working at once
  if (!s) return deny();
  req.user = { id: s.user, username: s.username, sid: s.sid };
  next();
});

app.post("/api/auth/register", authLimiter, wrap(async (req, res) => {
  const username = str(req.body?.username).trim().toLowerCase();
  const password = str(req.body?.password);
  const fields = {};
  if (!/^[a-z0-9_]{3,30}$/.test(username)) fields.username = "3-30 characters: letters, numbers or underscore.";
  const pe = pwError(password); if (pe) fields.password = pe;
  if (Object.keys(fields).length) return res.status(400).json({ error: "Validation failed", fields });
  try {
    const user = await User.create({ username, passwordHash: await bcrypt.hash(password, 12) });
    await signIn(req, res, user);
    audit(req, user._id, "register");
    res.status(201).json({ username });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: "That username is already taken.", fields: { username: "Already taken." } });
    throw e;
  }
}));

async function recordFailure(req, user, ev = "login_failed") {
  user.failedLogins += 1;
  if (user.failedLogins >= MAX_FAILS) { user.lockUntil = new Date(Date.now() + LOCK_MS); user.failedLogins = 0; ev = "account_locked"; }
  await user.save(); audit(req, user._id, ev);
}
const hashRecovery = (c) => crypto.createHash("sha256").update(String(c).replace(/[\s-]/g, "").toLowerCase()).digest("hex");
// Accepts a 6-digit authenticator code (one use per time step) or a one-time recovery code.
function secondFactorOk(user, code) {
  if (/^\d{6}$/.test(code)) {
    let secret;
    try { secret = decryptJson(user._id, user.totpEnc).secret; } catch { return false; }
    const step = totp.verify(secret, code);
    if (step !== null && step > user.totpLastStep) { user.totpLastStep = step; return true; } // blocks replay
    return false;
  }
  const i = user.recoveryHashes.indexOf(hashRecovery(code));
  if (i >= 0) { user.recoveryHashes.splice(i, 1); return true; }
  return false;
}

app.post("/api/auth/login", authLimiter, wrap(async (req, res) => {
  const username = str(req.body?.username).trim().toLowerCase();
  const password = str(req.body?.password);
  const user = await User.findOne({ username });
  const locked = user && user.lockUntil && user.lockUntil > Date.now();
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  const generic = { error: "Invalid username or password (or account temporarily locked)." };
  if (!user || locked) return res.status(401).json(generic);
  if (!ok) { await recordFailure(req, user); return res.status(401).json(generic); }
  if (user.totpEnabled) {
    const code = str(req.body?.code).trim();
    if (!code) return res.json({ requires2fa: true });
    if (!secondFactorOk(user, code)) {
      await recordFailure(req, user, "2fa_failed");
      return res.status(401).json({ error: "That code is not valid. Try again or use a recovery code.", requires2fa: true });
    }
  }
  user.failedLogins = 0; user.lockUntil = undefined; await user.save();
  await signIn(req, res, user); audit(req, user._id, "login_success");
  res.json({ username: user.username });
}));

app.post("/api/auth/logout", requireAuth, wrap(async (req, res) => {
  await Session.deleteOne({ sid: req.user.sid });
  clearCookie(res); audit(req, req.user.id, "logout");
  res.json({ ok: true });
}));
app.post("/api/auth/logout-all", requireAuth, wrap(async (req, res) => {
  await Session.deleteMany({ user: req.user.id });
  clearCookie(res); audit(req, req.user.id, "logout_all");
  res.json({ ok: true });
}));
app.get("/api/me", requireAuth, (req, res) => res.json({ username: req.user.username }));

app.post("/api/auth/change-password", sensitiveLimiter, requireAuth, wrap(async (req, res) => {
  const cur = str(req.body?.currentPassword), next = str(req.body?.newPassword);
  const user = await User.findById(req.user.id);
  if (!user || !(await bcrypt.compare(cur, user.passwordHash))) {
    return res.status(400).json({ error: "Current password is incorrect.", fields: { currentPassword: "Incorrect password." } });
  }
  const pe = pwError(next);
  if (pe) return res.status(400).json({ error: "Validation failed", fields: { newPassword: pe } });
  if (next === cur) return res.status(400).json({ error: "Validation failed", fields: { newPassword: "Choose a different password." } });
  user.passwordHash = await bcrypt.hash(next, 12); await user.save();
  await Session.deleteMany({ user: user._id });   // sign out everywhere...
  await signIn(req, res, user);                    // ...then keep this device signed in
  audit(req, user._id, "password_changed");
  res.json({ ok: true });
}));

app.post("/api/account/delete", sensitiveLimiter, requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user || !(await bcrypt.compare(str(req.body?.password), user.passwordHash))) {
    return res.status(400).json({ error: "Password is incorrect.", fields: { password: "Incorrect password." } });
  }
  await Promise.all([Entry.deleteMany({ user: user._id }), Session.deleteMany({ user: user._id }), Audit.deleteMany({ user: user._id }), User.deleteOne({ _id: user._id })]);
  clearCookie(res);
  res.json({ deleted: true });
}));

// ---------- Security info ----------
function uaLabel(ua = "") {
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const o = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "device";
  return `${b} on ${o}`;
}
app.get("/api/sessions", requireAuth, wrap(async (req, res) => {
  const rows = await Session.find({ user: req.user.id }).sort({ createdAt: -1 }).lean();
  res.json(rows.map((s) => ({ id: s._id, device: uaLabel(s.ua), ip: s.ip, createdAt: s.createdAt, current: s.sid === req.user.sid })));
}));
app.delete("/api/sessions/:id", requireAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Session not found." });
  const r = await Session.deleteOne({ _id: req.params.id, user: req.user.id });
  if (!r.deletedCount) return res.status(404).json({ error: "Session not found." });
  audit(req, req.user.id, "session_revoked");
  res.json({ ok: true });
}));
app.get("/api/security/log", requireAuth, wrap(async (req, res) => {
  const rows = await Audit.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(20).lean();
  res.json(rows.map((a) => ({ event: a.event, ip: a.ip, at: a.createdAt, device: uaLabel(a.ua) })));
}));

// ---------- Ledger ----------
const toApi = (e) => {
  const d = decryptJson(e.user, e.data);
  return { id: e._id, date: e.date, type: e.type, category: d.category, description: d.description, amount: d.amountMinor / 100 };
};
async function loadEntries(uid) {
  const rows = await Entry.find({ user: uid }).sort({ date: -1, _id: -1 }).limit(5000).lean();
  const out = [];
  for (const e of rows) { try { out.push(toApi(e)); } catch { console.error("Could not decrypt entry", String(e._id)); } } // tampered rows are skipped
  return out;
}
const sealed = (uid, v) => encryptJson(uid, { category: v.category, description: v.description, amountMinor: v.amountMinor });

app.get("/health", (_req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ok: mongoose.connection.readyState === 1 }));
app.get("/api/entries", requireAuth, wrap(async (req, res) => res.json(await loadEntries(req.user.id))));

app.post("/api/entries", requireAuth, wrap(async (req, res) => {
  const { fields, value } = validateEntry(req.body);
  if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the highlighted fields.", fields });
  const e = await Entry.create({ user: req.user.id, date: value.date, type: value.type, data: sealed(req.user.id, value) });
  res.status(201).json(toApi(e));
}));

app.put("/api/entries/:id", requireAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Entry not found." });
  const { fields, value } = validateEntry(req.body);
  if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the highlighted fields.", fields });
  const e = await Entry.findOneAndUpdate({ _id: req.params.id, user: req.user.id },
    { date: value.date, type: value.type, data: sealed(req.user.id, value) }, { new: true }).lean();
  if (!e) return res.status(404).json({ error: "Entry not found." });
  res.json(toApi(e));
}));

app.delete("/api/entries/:id", requireAuth, wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Entry not found." });
  const r = await Entry.deleteOne({ _id: req.params.id, user: req.user.id });
  if (!r.deletedCount) return res.status(404).json({ error: "Entry not found." });
  res.json({ deleted: true });
}));

// ---------- Budgets (stored encrypted) ----------
app.get("/api/budgets", requireAuth, wrap(async (req, res) => {
  const u = await User.findById(req.user.id).select("budgetsEnc").lean();
  let b = {};
  if (u?.budgetsEnc) { try { b = decryptJson(req.user.id, u.budgetsEnc); } catch { b = {}; } }
  res.json({ budgets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v / 100])) });
}));
app.put("/api/budgets", requireAuth, wrap(async (req, res) => {
  const input = req.body?.budgets;
  if (!input || typeof input !== "object" || Array.isArray(input)) return res.status(400).json({ error: "Invalid budgets." });
  const keys = Object.keys(input);
  if (keys.length > 30) return res.status(400).json({ error: "You can set at most 30 budgets." });
  const clean = {};
  for (const k of keys) {
    const cat = k.trim(), minor = parseAmount(input[k]);
    if (!cat || cat.length > 50) return res.status(400).json({ error: "Category is required (max 50 characters).", fields: { category: "Invalid category." } });
    if (minor === null) return res.status(400).json({ error: AMOUNT_MSG, fields: { limit: AMOUNT_MSG } });
    clean[cat] = minor;
  }
  await User.updateOne({ _id: req.user.id }, { budgetsEnc: encryptJson(req.user.id, clean) });
  res.json({ budgets: Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, v / 100])) });
}));

// ---------- Export ----------
const csvCell = (v) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // blocks spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
app.get("/api/export", requireAuth, exportLimiter, wrap(async (req, res) => {
  const list = await loadEntries(req.user.id);
  audit(req, req.user.id, "data_export");
  if (req.query.format === "json") {
    res.set("Content-Disposition", 'attachment; filename="meridian-export.json"');
    return res.json(list.map(({ id, ...rest }) => rest));
  }
  const lines = ["date,type,category,description,amount"].concat(list.map((e) => [e.date, e.type, e.category, e.description, e.amount.toFixed(2)].map(csvCell).join(",")));
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="meridian-export.csv"' });
  res.send(lines.join("\n"));
}));

// ---------- Two-factor authentication ----------
const makeRecoveryCodes = () => Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString("hex"); return h.slice(0, 5) + "-" + h.slice(5); });

app.get("/api/2fa/status", requireAuth, wrap(async (req, res) => {
  const u = await User.findById(req.user.id).select("totpEnabled recoveryHashes").lean();
  res.json({ enabled: !!u?.totpEnabled, recoveryLeft: u?.recoveryHashes?.length || 0 });
}));
app.post("/api/2fa/setup", sensitiveLimiter, requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (user.totpEnabled) return res.status(400).json({ error: "Two-factor authentication is already on." });
  const secret = totp.generateSecret();
  user.totpEnc = encryptJson(user._id, { secret }); await user.save(); // stored encrypted; inactive until confirmed
  res.json({ secret, qr: await QRCode.toDataURL(totp.otpauthUrl(secret, user.username), { margin: 1, width: 220 }) });
}));
app.post("/api/2fa/enable", sensitiveLimiter, requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.id), code = str(req.body?.code).trim();
  if (user.totpEnabled || !user.totpEnc) return res.status(400).json({ error: "Start the setup first." });
  let step = null;
  try { step = totp.verify(decryptJson(user._id, user.totpEnc).secret, code); } catch {}
  if (step === null) return res.status(400).json({ error: "That code is not correct.", fields: { code: "That code is not correct. Check your authenticator app." } });
  const codes = makeRecoveryCodes();
  user.totpEnabled = true; user.totpLastStep = step; user.recoveryHashes = codes.map(hashRecovery); await user.save();
  audit(req, user._id, "2fa_enabled");
  res.json({ recoveryCodes: codes }); // shown once; only hashes are stored
}));
app.post("/api/2fa/disable", sensitiveLimiter, requireAuth, wrap(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user.totpEnabled) return res.status(400).json({ error: "Two-factor authentication is not on." });
  if (!(await bcrypt.compare(str(req.body?.password), user.passwordHash))) return res.status(400).json({ error: "Password is incorrect.", fields: { password: "Incorrect password." } });
  if (!secondFactorOk(user, str(req.body?.code).trim())) return res.status(400).json({ error: "That code is not valid.", fields: { code: "Enter a current code or a recovery code." } });
  user.totpEnabled = false; user.totpEnc = undefined; user.recoveryHashes = []; user.totpLastStep = 0; await user.save();
  audit(req, user._id, "2fa_disabled");
  res.json({ ok: true });
}));

// ---------- Savings goals (stored encrypted) ----------
async function loadGoals(uid) {
  const u = await User.findById(uid).select("goalsEnc").lean();
  if (!u?.goalsEnc) return [];
  try { return decryptJson(uid, u.goalsEnc); } catch { return []; }
}
const saveGoals = (uid, g) => User.updateOne({ _id: uid }, { goalsEnc: encryptJson(uid, g) });
const goalApi = (g) => ({ id: g.id, name: g.name, target: g.targetMinor / 100, saved: g.savedMinor / 100 });
function validateGoal(b = {}) {
  const fields = {}, name = str(b.name).trim();
  if (!name || name.length > 50) fields.name = "Give your goal a name (max 50 characters).";
  const targetMinor = parseAmount(b.target); if (targetMinor === null) fields.target = AMOUNT_MSG;
  const savedMinor = parseAmount(b.saved === undefined || b.saved === "" ? "0" : b.saved, true); if (savedMinor === null) fields.saved = AMOUNT_MSG;
  return { fields, value: { name, targetMinor, savedMinor } };
}
app.get("/api/goals", requireAuth, wrap(async (req, res) => res.json({ goals: (await loadGoals(req.user.id)).map(goalApi) })));
app.post("/api/goals", requireAuth, wrap(async (req, res) => {
  const list = await loadGoals(req.user.id);
  if (list.length >= 20) return res.status(400).json({ error: "You can keep up to 20 goals." });
  const { fields, value } = validateGoal(req.body);
  if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the highlighted fields.", fields });
  const g = { id: crypto.randomBytes(6).toString("hex"), ...value };
  await saveGoals(req.user.id, [...list, g]);
  res.status(201).json(goalApi(g));
}));
app.put("/api/goals/:id", requireAuth, wrap(async (req, res) => {
  const list = await loadGoals(req.user.id), i = list.findIndex((g) => g.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Goal not found." });
  const { fields, value } = validateGoal(req.body);
  if (Object.keys(fields).length) return res.status(400).json({ error: "Please fix the highlighted fields.", fields });
  list[i] = { id: list[i].id, ...value };
  await saveGoals(req.user.id, list);
  res.json(goalApi(list[i]));
}));
app.delete("/api/goals/:id", requireAuth, wrap(async (req, res) => {
  const list = await loadGoals(req.user.id), next = list.filter((g) => g.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: "Goal not found." });
  await saveGoals(req.user.id, next);
  res.json({ deleted: true });
}));

// ---------- CSV import (rows are validated one by one) ----------
app.post("/api/entries/import", requireAuth, express.json({ limit: "300kb" }), mongoSanitize(), wrap(async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) return res.status(400).json({ error: "Send between 1 and 500 rows at a time." });
  if ((await Entry.countDocuments({ user: req.user.id })) + rows.length > 5000) return res.status(400).json({ error: "Importing this would pass the 5,000 entry limit." });
  const docs = [], errors = [];
  rows.forEach((r, i) => {
    const { fields, value } = validateEntry(r && typeof r === "object" ? r : {});
    const bad = Object.values(fields)[0];
    if (bad) { if (errors.length < 20) errors.push({ row: i + 1, message: bad }); return; }
    docs.push({ user: req.user.id, date: value.date, type: value.type, data: sealed(req.user.id, value) });
  });
  if (docs.length) await Entry.insertMany(docs);
  audit(req, req.user.id, "data_import");
  res.json({ imported: docs.length, skipped: rows.length - docs.length, errors });
}));

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That request is too large." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => app.listen(PORT, () => console.log(`Meridian Wealth Ledger on port ${PORT}`)))
  .catch((e) => { console.error("MongoDB connection failed:", e.message); process.exit(1); });
