// JobAppFrnd - server.js
// User app (/) + Admin app (/admin) + Turso (libSQL) backend
// Signup/login: Gmail + OTP (Study Tracker er moto, Brevo diye OTP jay)
// Env vars on Render:
//   TURSO_DATABASE_URL  - libsql://jobappfrnd-xxxx.turso.io  (from Turso dashboard)
//   TURSO_AUTH_TOKEN    - Turso database token
//   ADMIN_USER          - default: admin
//   ADMIN_PASS          - default: 1234  (Render e giye bodle nio!)
//   EMAIL_PROVIDER      - 'brevo' (live) / na dile demo (OTP pathano hoy na)
//   BREVO_API_KEY       - Brevo API key (Study Tracker er tai use kora jay)
//   BREVO_FROM          - sender, e.g. 'JobAppFrnd <tomar-verified-email@gmail.com>'
// Local test e env na thakle file:local.db use hobe.
const express = require('express');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@libsql/client');

// PDF upload: memory storage, max 10 MB, PDF only.
// Note: files are stored as BLOB in Turso (pdf_files table) so they survive
// Render restarts — Render's disk is ephemeral, Turso is not.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
    else cb(new Error('শুধু PDF ফাইল আপলোড করা যায়!'));
  },
});

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '1234';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    mobile TEXT UNIQUE,
    pass TEXT NOT NULL,
    study_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Purono DB (mobile-only) theke migration: email column na thakle table rebuild
  const cols = await db.execute('PRAGMA table_info(users)');
  const hasEmail = cols.rows.some(r => r.name === 'email');
  if (!hasEmail) {
    await db.execute('ALTER TABLE users RENAME TO users_old');
    await db.execute(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      mobile TEXT UNIQUE,
      pass TEXT NOT NULL,
      study_seconds INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.execute(`INSERT INTO users (id, name, email, mobile, pass, study_seconds, created_at)
      SELECT id, name, NULL, mobile, pass, study_seconds, created_at FROM users_old`);
    await db.execute('DROP TABLE users_old');
    console.log('Migrated users table: email column added');
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS otp_codes (
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (email, purpose)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT 'সাধারণ',
    link TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    added_by TEXT NOT NULL DEFAULT 'Admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pdf_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/pdf',
    size INTEGER NOT NULL DEFAULT 0,
    data BLOB NOT NULL,
    added_by TEXT NOT NULL DEFAULT 'Admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  console.log('DB ready:', process.env.TURSO_DATABASE_URL ? 'Turso' : 'local file');
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email || '', mobile: row.mobile || '', studySeconds: row.study_seconds };
}

// ---- Email OTP (Study Tracker er otp.js er moto, Brevo diye) ----
const OTP_TTL = 10 * 60; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN = 60; // seconds

function nowSec() { return Math.floor(Date.now() / 1000); }
function genOtpCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
function normalizeEmail(raw) { return String(raw || '').trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120; }
// OTP te Bangla (০-৯) ba Arabic (٠-٩) digit likhleo cholbe — English digit e bodle neoa hoy
function normalizeOtpDigits(s) {
  return String(s || '')
    .replace(/[০-৯]/g, d => '০১২৩৪৫৬৭৮৯'.indexOf(d))
    .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[\s-]/g, '');
}

async function sendOtpEmail(to, code) {
  const provider = (process.env.EMAIL_PROVIDER || 'demo').toLowerCase();
  if (provider !== 'brevo') return { provider, sent: false };
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY env var missing');
  const from = process.env.BREVO_FROM || 'JobAppFrnd <no-reply@example.com>';
  const m = String(from).match(/^(.*)<([^<>]+)>$/);
  const sender = m
    ? { email: m[2].trim(), ...(m[1].trim() ? { name: m[1].trim().replace(/^["']|["']$/g, '') } : {}) }
    : { email: String(from).trim() };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender,
        to: [{ email: to }],
        subject: 'JobAppFrnd — Gmail যাচাই কোড',
        textContent: 'তোমার JobAppFrnd যাচাই কোড: ' + code + '\n\nএই কোড ১০ মিনিটের জন্য কার্যকর। তুমি না চাইলে এই মেইল উপেক্ষা করো।',
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('Brevo error ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 120));
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Brevo request timed out');
    throw err;
  } finally { clearTimeout(timer); }
  return { provider: 'brevo', sent: true };
}

async function requestEmailOtp(rawEmail, purpose) {
  const email = normalizeEmail(rawEmail);
  if (!validEmail(email)) { const e = new Error('সঠিক Gmail ঠিকানা দিন!'); e.status = 400; throw e; }
  if (!['signup'].includes(purpose)) purpose = 'signup';
  const existing = await db.execute({ sql: 'SELECT * FROM otp_codes WHERE email = ? AND purpose = ?', args: [email, purpose] });
  if (existing.rows.length && nowSec() - (existing.rows[0].expires_at - OTP_TTL) < OTP_RESEND_COOLDOWN) {
    const e = new Error('আবার OTP পেতে একটু অপেক্ষা করো!'); e.status = 429; throw e;
  }
  const code = genOtpCode();
  await db.execute({
    sql: `INSERT INTO otp_codes (email, purpose, code, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(email, purpose) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`,
    args: [email, purpose, code, nowSec() + OTP_TTL],
  });
  const provider = (process.env.EMAIL_PROVIDER || 'demo').toLowerCase();
  let delivered = false;
  try {
    const r = await sendOtpEmail(email, code);
    delivered = r.sent;
  } catch (err) {
    console.error('[otp] email failed:', err.message);
    if (provider !== 'demo') {
      const e = new Error('মেইল পাঠানো যায়নি (' + String(err.message).slice(0, 140) + ')'); e.status = 502; throw e;
    }
  }
  const demo = provider === 'demo';
  const allowDemoCode = process.env.ALLOW_DEMO_OTP === '1';
  return { email, purpose, delivered, demo, ...(demo && allowDemoCode ? { demo_code: code } : {}) };
}

async function verifyEmailOtp(rawEmail, code, purpose) {
  const email = normalizeEmail(rawEmail);
  const row = await db.execute({ sql: 'SELECT * FROM otp_codes WHERE email = ? AND purpose = ?', args: [email, purpose] });
  if (!row.rows.length) { const e = new Error('এই Gmail এর জন্য কোনো OTP চাওয়া হয়নি!'); e.status = 400; throw e; }
  const r = row.rows[0];
  if (nowSec() > r.expires_at) {
    await db.execute({ sql: 'DELETE FROM otp_codes WHERE email = ? AND purpose = ?', args: [email, purpose] });
    const e = new Error('OTP এর মেয়াদ শেষ! নতুন OTP নাও।'); e.status = 400; throw e;
  }
  if (r.attempts >= OTP_MAX_ATTEMPTS) {
    await db.execute({ sql: 'DELETE FROM otp_codes WHERE email = ? AND purpose = ?', args: [email, purpose] });
    const e = new Error('অনেকবার ভুল হয়েছে! নতুন OTP নাও।'); e.status = 429; throw e;
  }
  if (normalizeOtpDigits(code) !== r.code) {
    await db.execute({ sql: 'UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?', args: [email, purpose] });
    const e = new Error('ভুল OTP! আবার চেষ্টা করো।'); e.status = 400; throw e;
  }
  await db.execute({ sql: 'DELETE FROM otp_codes WHERE email = ? AND purpose = ?', args: [email, purpose] });
  return email;
}

// Meyad-uttirno OTP 10 min por por muche fela
setInterval(async () => {
  try { await db.execute({ sql: 'DELETE FROM otp_codes WHERE expires_at < ?', args: [nowSec()] }); }
  catch (e) { console.error('[otp] cleanup:', e.message); }
}, 10 * 60 * 1000);

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'JobAppFrnd', db: process.env.TURSO_DATABASE_URL ? 'turso' : 'local' }));

// ---- Auth: Gmail + OTP signup (Study Tracker er moto) ----
// POST /api/auth/signup/request-otp { email, mobile? } — Gmail e 6 sonkhar OTP jabe
app.post('/api/auth/signup/request-otp', async (req, res) => {
  try {
    const email = normalizeEmail((req.body || {}).email);
    if (!validEmail(email)) return res.status(400).json({ error: 'সঠিক Gmail ঠিকানা দিন!' });
    const mobile = String((req.body || {}).mobile || '').trim();
    const taken = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
    if (taken.rows.length) return res.status(400).json({ error: 'এই Gmail দিয়ে একাউন্ট আছে! লগইন করো।' });
    if (mobile) {
      const takenM = await db.execute({ sql: 'SELECT id FROM users WHERE mobile = ?', args: [mobile] });
      if (takenM.rows.length) return res.status(400).json({ error: 'এই নাম্বারে একাউন্ট আছে!' });
    }
    const out = await requestEmailOtp(email, 'signup');
    res.json({ ok: true, email: out.email, delivered: out.delivered, ...(out.demo_code ? { demo: true, demo_code: out.demo_code } : {}) });
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
});

// POST /api/auth/signup/verify { email, code, name, pass, mobile? } — OTP millei account hobe
app.post('/api/auth/signup/verify', async (req, res) => {
  try {
    const { name, pass } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'নাম লিখুন!' });
    if (!pass || String(pass).length < 4) return res.status(400).json({ error: 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে!' });
    const mobile = String((req.body || {}).mobile || '').trim() || null;
    const email = await verifyEmailOtp(req.body.email, req.body.code, 'signup');
    const taken = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
    if (taken.rows.length) return res.status(400).json({ error: 'এই Gmail দিয়ে একাউন্ট আছে! লগইন করো।' });
    if (mobile) {
      const takenM = await db.execute({ sql: 'SELECT id FROM users WHERE mobile = ?', args: [mobile] });
      if (takenM.rows.length) return res.status(400).json({ error: 'এই নাম্বারে একাউন্ট আছে!' });
    }
    const ins = await db.execute({ sql: 'INSERT INTO users (name, email, mobile, pass) VALUES (?, ?, ?, ?)', args: [String(name).trim(), email, mobile, String(pass)] });
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [Number(ins.lastInsertRowid)] });
    res.json({ ok: true, user: publicUser(r.rows[0]) });
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || 'Server error' }); }
});

// ---- Auth: admin theke bondhu add (Gmail diye login korbe tai email lagbe) ----
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, mobile, pass } = req.body || {};
    if (!name || !pass) return res.status(400).json({ error: 'সবগুলো ঘর পূরণ করুন!' });
    const em = normalizeEmail(email || '');
    if (!validEmail(em)) return res.status(400).json({ error: 'সঠিক Gmail ঠিকানা দিন!' });
    const mo = String(mobile || '').trim() || null;
    const existingE = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [em] });
    if (existingE.rows.length) return res.status(400).json({ error: 'এই Gmail দিয়ে একাউন্ট আছে!' });
    if (mo) {
      const existingM = await db.execute({ sql: 'SELECT id FROM users WHERE mobile = ?', args: [mo] });
      if (existingM.rows.length) return res.status(400).json({ error: 'এই নাম্বারে একাউন্ট আছে!' });
    }
    await db.execute({ sql: 'INSERT INTO users (name, email, mobile, pass) VALUES (?, ?, ?, ?)', args: [String(name).trim(), em, mo, String(pass)] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Login: Gmail (@ thakle) ba purono mobile — duitai cholbe
app.post('/api/login', async (req, res) => {
  try {
    const { email, mobile, pass } = req.body || {};
    const id = String(email || mobile || '').trim();
    if (!id || !pass) return res.status(400).json({ error: 'Gmail/মোবাইল আর পাসওয়ার্ড দিন!' });
    let r;
    if (id.includes('@')) r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ? AND pass = ?', args: [normalizeEmail(id), String(pass)] });
    else r = await db.execute({ sql: 'SELECT * FROM users WHERE mobile = ? AND pass = ?', args: [id, String(pass)] });
    if (!r.rows.length) return res.status(401).json({ error: 'Gmail/মোবাইল বা পাসওয়ার্ড ভুল!' });
    res.json({ ok: true, user: publicUser(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Session restore (refresh/logout fix): email ba mobile diye validate ----
app.get('/api/session', async (req, res) => {
  try {
    const email = normalizeEmail(req.query.email || '');
    const mobile = String(req.query.mobile || '').trim();
    let r;
    if (email) r = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    else if (mobile) r = await db.execute({ sql: 'SELECT * FROM users WHERE mobile = ?', args: [mobile] });
    else return res.status(400).json({ error: 'email/mobile needed' });
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: publicUser(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Admin login ----
app.post('/api/admin/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (String(user || '').trim() === ADMIN_USER && String(pass || '') === ADMIN_PASS) return res.json({ ok: true });
  res.status(401).json({ error: 'ভুল ইউজারনেম বা পাসওয়ার্ড!' });
});

// ---- Combined data for user app ----
app.get('/api/data', async (req, res) => {
  try {
    const [notices, users, docs, books, pdfs] = await Promise.all([
      db.execute('SELECT * FROM notices ORDER BY id DESC'),
      db.execute('SELECT id, name, email, mobile, study_seconds FROM users ORDER BY study_seconds DESC'),
      db.execute('SELECT * FROM docs ORDER BY id DESC'),
      db.execute('SELECT * FROM books ORDER BY id DESC'),
      db.execute('SELECT id, title, filename, size, added_by FROM pdf_files ORDER BY id DESC'),
    ]);
    res.json({
      notices: notices.rows.map(r => r.text),
      users: users.rows.map(publicUser),
      docs: docs.rows.map(r => ({ id: r.id, title: r.title, link: r.link, addedBy: r.added_by })),
      books: books.rows.map(r => ({ id: r.id, title: r.title, author: r.author, link: r.link })),
      pdfs: pdfs.rows.map(r => ({ id: r.id, title: r.title, filename: r.filename, size: r.size, addedBy: r.added_by })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Study timer save (email ba mobile — jeta ache seta diye) ----
app.post('/api/study/add', async (req, res) => {
  try {
    const { mobile, email, seconds } = req.body || {};
    const secs = parseInt(seconds, 10);
    const em = normalizeEmail(email || '');
    const mo = String(mobile || '').trim();
    if ((!em && !mo) || !secs || secs <= 0) return res.status(400).json({ error: 'Invalid' });
    if (em) await db.execute({ sql: 'UPDATE users SET study_seconds = study_seconds + ? WHERE email = ?', args: [secs, em] });
    else await db.execute({ sql: 'UPDATE users SET study_seconds = study_seconds + ? WHERE mobile = ?', args: [secs, mo] });
    const r = em
      ? await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [em] })
      : await db.execute({ sql: 'SELECT * FROM users WHERE mobile = ?', args: [mo] });
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: publicUser(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Notices / Books / Docs (create) ----
app.post('/api/notices', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'নোটিশ লিখুন!' });
    await db.execute({ sql: 'INSERT INTO notices (text) VALUES (?)', args: [String(text).trim()] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/books', async (req, res) => {
  try {
    const { title, author, link } = req.body || {};
    if (!title || !link) return res.status(400).json({ error: 'বইয়ের নাম ও লিংক দিন!' });
    await db.execute({ sql: 'INSERT INTO books (title, author, link) VALUES (?, ?, ?)', args: [String(title).trim(), String(author || 'সাধারণ').trim(), String(link).trim()] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/docs', async (req, res) => {
  try {
    const { title, link, addedBy } = req.body || {};
    if (!title || !link) return res.status(400).json({ error: 'নাম ও লিংক দিন!' });
    await db.execute({ sql: 'INSERT INTO docs (title, link, added_by) VALUES (?, ?, ?)', args: [String(title).trim(), String(link).trim(), String(addedBy || 'Admin')] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- PDF files: direct upload (stored as BLOB in Turso) ----
app.post('/api/pdfs', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'ফাইল ১০ MB এর বেশি হতে পারবে না!' : (err.message || 'আপলোড হয়নি!');
      return res.status(400).json({ error: msg });
    }
    try {
      const title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'পিডিএফের নাম লিখুন!' });
      if (!req.file) return res.status(400).json({ error: 'একটা PDF ফাইল বেছে নিন!' });
      const r = await db.execute({
        sql: 'INSERT INTO pdf_files (title, filename, mime, size, data, added_by) VALUES (?, ?, ?, ?, ?, ?)',
        args: [title, req.file.originalname, req.file.mimetype || 'application/pdf', req.file.size, req.file.buffer, String(req.body.addedBy || 'Admin')],
      });
      res.json({ ok: true, pdf: { id: Number(r.lastInsertRowid), title, filename: req.file.originalname, size: req.file.size } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'সার্ভার সমস্যা হয়েছে!' }); }
  });
});

app.get('/api/pdfs/:id/file', async (req, res) => {
  try {
    const r = await db.execute({ sql: 'SELECT filename, mime, data FROM pdf_files WHERE id = ?', args: [req.params.id] });
    if (!r.rows.length) return res.status(404).send('PDF পাওয়া যায়নি!');
    const row = r.rows[0];
    const buf = Buffer.from(row.data);
    res.setHeader('Content-Type', row.mime || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(row.filename || 'file.pdf').replace(/"/g, '') + '"');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) { console.error(e); res.status(500).send('সার্ভার সমস্যা হয়েছে!'); }
});

// ---- Admin manage: list notices + delete notices/books/docs/pdfs ----
app.get('/api/notices', async (req, res) => {
  try {
    const r = await db.execute('SELECT id, text FROM notices ORDER BY id DESC');
    res.json({ notices: r.rows.map(x => ({ id: x.id, text: x.text })) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/notices/:id', async (req, res) => {
  try { await db.execute({ sql: 'DELETE FROM notices WHERE id = ?', args: [req.params.id] }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/books/:id', async (req, res) => {
  try { await db.execute({ sql: 'DELETE FROM books WHERE id = ?', args: [req.params.id] }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/docs/:id', async (req, res) => {
  try { await db.execute({ sql: 'DELETE FROM docs WHERE id = ?', args: [req.params.id] }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/pdfs/:id', async (req, res) => {
  try { await db.execute({ sql: 'DELETE FROM pdf_files WHERE id = ?', args: [req.params.id] }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Admin: users list / remove ----
app.get('/api/admin/users', async (req, res) => {
  try {
    const r = await db.execute('SELECT id, name, email, mobile, study_seconds FROM users ORDER BY id DESC');
    res.json({ users: r.rows.map(publicUser) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Pages
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, () => console.log('JobAppFrnd running on port ' + PORT));
}).catch(e => { console.error('DB init failed', e); process.exit(1); });
