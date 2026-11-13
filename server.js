// JobAppFrnd - server.js
// User app (/) + Admin app (/admin) + Turso (libSQL) backend
// Env vars on Render:
//   TURSO_DATABASE_URL  - libsql://jobappfrnd-xxxx.turso.io  (from Turso dashboard)
//   TURSO_AUTH_TOKEN    - Turso database token
//   ADMIN_USER          - default: admin
//   ADMIN_PASS          - default: 1234  (Render e giye bodle nio!)
// Local test e env na thakle file:local.db use hobe.
const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

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
    mobile TEXT NOT NULL UNIQUE,
    pass TEXT NOT NULL,
    study_seconds INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  console.log('DB ready:', process.env.TURSO_DATABASE_URL ? 'Turso' : 'local file');
}

function publicUser(row) {
  return { id: row.id, name: row.name, mobile: row.mobile, studySeconds: row.study_seconds };
}

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'JobAppFrnd', db: process.env.TURSO_DATABASE_URL ? 'turso' : 'local' }));

// ---- Auth: user ----
app.post('/api/register', async (req, res) => {
  try {
    const { name, mobile, pass } = req.body || {};
    if (!name || !mobile || !pass) return res.status(400).json({ error: 'সবগুলো ঘর পূরণ করুন!' });
    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE mobile = ?', args: [String(mobile).trim()] });
    if (existing.rows.length) return res.status(400).json({ error: 'এই নাম্বারে একাউন্ট আছে!' });
    await db.execute({ sql: 'INSERT INTO users (name, mobile, pass) VALUES (?, ?, ?)', args: [String(name).trim(), String(mobile).trim(), String(pass)] });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { mobile, pass } = req.body || {};
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE mobile = ? AND pass = ?', args: [String(mobile || '').trim(), String(pass || '')] });
    if (!r.rows.length) return res.status(401).json({ error: 'মোবাইল নাম্বার বা পাসওয়ার্ড ভুল!' });
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
    const [notices, users, docs, books] = await Promise.all([
      db.execute('SELECT * FROM notices ORDER BY id DESC'),
      db.execute('SELECT id, name, mobile, study_seconds FROM users ORDER BY study_seconds DESC'),
      db.execute('SELECT * FROM docs ORDER BY id DESC'),
      db.execute('SELECT * FROM books ORDER BY id DESC'),
    ]);
    res.json({
      notices: notices.rows.map(r => r.text),
      users: users.rows.map(publicUser),
      docs: docs.rows.map(r => ({ id: r.id, title: r.title, link: r.link, addedBy: r.added_by })),
      books: books.rows.map(r => ({ id: r.id, title: r.title, author: r.author, link: r.link })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ---- Study timer save ----
app.post('/api/study/add', async (req, res) => {
  try {
    const { mobile, seconds } = req.body || {};
    const secs = parseInt(seconds, 10);
    if (!mobile || !secs || secs <= 0) return res.status(400).json({ error: 'Invalid' });
    await db.execute({ sql: 'UPDATE users SET study_seconds = study_seconds + ? WHERE mobile = ?', args: [secs, String(mobile).trim()] });
    const r = await db.execute({ sql: 'SELECT * FROM users WHERE mobile = ?', args: [String(mobile).trim()] });
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

// ---- Admin: users list / remove ----
app.get('/api/admin/users', async (req, res) => {
  try {
    const r = await db.execute('SELECT id, name, mobile, study_seconds FROM users ORDER BY id DESC');
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
