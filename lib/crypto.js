// Field-level encryption: AES-256-GCM with a separate key per user (HKDF from a master key).
const crypto = require("crypto");

const raw = process.env.ENCRYPTION_KEY || "";
let MASTER;
if (/^[0-9a-f]{64}$/i.test(raw)) MASTER = Buffer.from(raw, "hex");
else if (raw.length >= 32) MASTER = crypto.createHash("sha256").update(raw).digest();
else {
  console.error('ENCRYPTION_KEY is missing or too short. Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const keys = new Map();
function keyFor(uid) {
  const id = String(uid);
  let k = keys.get(id);
  if (!k) {
    if (keys.size > 1000) keys.clear();
    k = Buffer.from(crypto.hkdfSync("sha256", MASTER, Buffer.alloc(0), "meridian-user:" + id, 32));
    keys.set(id, k);
  }
  return k;
}

function encryptJson(uid, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFor(uid), iv);
  c.setAAD(Buffer.from(String(uid))); // binds ciphertext to its owner
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

function decryptJson(uid, s) {
  const [v, iv, tag, ct] = String(s).split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor(uid), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(String(uid)));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"));
}

module.exports = { encryptJson, decryptJson };
