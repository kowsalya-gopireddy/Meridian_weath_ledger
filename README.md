# Meridian Wealth Ledger v4

Node.js + Express + MongoDB. Encrypted data, managed sessions, budgets, charts, export.

## Run locally
1. Start MongoDB (or use Atlas). 2. `cp .env.example .env` and fill the three values.
3. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. `npm install && npm start` -> http://localhost:3000

## Security model
- Category, note and amount are encrypted (AES-256-GCM, per-user key derived from ENCRYPTION_KEY) before they reach MongoDB.
- Passwords: bcrypt. Sessions: server-side, revocable, HttpOnly SameSite=Strict cookie.
- Lockout, rate limits, NoSQL-injection filtering, strict input validation, CSP and security headers.
- Audit log (90 days), change password, sign out all devices, delete account, auto sign-out after 15 min idle.
- Keep ENCRYPTION_KEY safe and backed up: lose it and the encrypted data is unrecoverable.

## Deploy (Render + Atlas)
Push to GitHub -> Render Blueprint -> set MONGODB_URI and ENCRYPTION_KEY in the dashboard (JWT_SECRET is auto-generated).
