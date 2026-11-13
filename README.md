# JobAppFrnd

সরকারি চাকরি প্রস্তুতি — বন্ধুদের জন্য অ্যাপ।

- User app: `/` — Register/Login (mobile+password), Study Timer (ring + 30-min goal), Leaderboard (podium Top 3), PDF Room (direct PDF upload + Drive link), Books, Profile
- Admin app: `/admin` — Login Render env `ADMIN_USER` / `ADMIN_PASS` দিয়ে সেট করা (GitHub-এ পাসওয়ার্ড রাখা হয় না), Notice post, Book add, PDF upload, Document add, Friend add/remove
- UI: Study Tracker-এর মতো dark premium design — glass card, gradient, colorful animation; সব লেখা বাংলায়।

## Database — Turso
Tables: `users`, `notices`, `books`, `docs`, `pdf_files` (PDF BLOB — Render restart-এও মুছবে না) — server.js চালু হলেই auto-create হয়।
PDF upload: `POST /api/pdfs` (multipart, max 10 MB, PDF only) → `GET /api/pdfs/:id/file` দিয়ে পড়া/ডাউনলোড।

Render env vars:
- `TURSO_DATABASE_URL` = `libsql://jobappfrnd-xxxx.turso.io`
- `TURSO_AUTH_TOKEN` = Turso token
- `ADMIN_USER` / `ADMIN_PASS`

Local run: `npm install && npm start` → http://localhost:3000 (Turso env না থাকলে `local.db` ব্যবহার হবে)
