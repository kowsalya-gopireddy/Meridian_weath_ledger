// Time-based one-time passwords (RFC 6238) using only Node's crypto.
const crypto = require("crypto");
const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function b32enc(buf) {
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
function b32dec(s) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", b32dec(secret)).update(buf).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, "0");
}
const generateSecret = () => b32enc(crypto.randomBytes(20));
// Returns the matching 30-second step (allowing +/-1 step of clock drift) or null.
function verify(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30000);
  let hit = null;
  for (const d of [0, -1, 1]) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step + d)), Buffer.from(code))) hit = step + d;
  }
  return hit;
}
const otpauthUrl = (secret, user) =>
  `otpauth://totp/Meridian:${encodeURIComponent(user)}?secret=${secret}&issuer=Meridian&algorithm=SHA1&digits=6&period=30`;

module.exports = { generateSecret, verify, otpauthUrl, hotp };
