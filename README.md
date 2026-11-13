# JobAppFrnd

সরকারি চাকরি প্রস্তুতি — বন্ধুদের জন্য অ্যাপ।

- User app: `/` — Register/Login (mobile+password), Study Timer, Leaderboard, PDF Room (Docs), Books, Profile
- Admin app: `/admin` — Login `admin` / `1234` (Render env `ADMIN_USER` / `ADMIN_PASS` দিয়ে বদলাও), Notice post, Book add, Document add, Friend add/remove

## Database — Turso
Tables: `users`, `notices`, `books`, `docs` — server.js চালু হলেই auto-create হয়।

Render env vars:
- `TURSO_DATABASE_URL` = `libsql://jobappfrnd-xxxx.turso.io`
- `TURSO_AUTH_TOKEN` = Turso token
- `ADMIN_USER` / `ADMIN_PASS`

Local run: `npm install && npm start` → http://localhost:3000 (Turso env না থাকলে `local.db` ব্যবহার হবে)
