'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDb } = require('../db/database');

const router = express.Router();

/* POST /api/auth/login */
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const db = getDb();
  /* Accept email address OR plain username */
  const lookup = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(lookup, lookup);
  if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  req.session.userId = user.id;
  req.session.userEmail = user.email;
  res.json({ ok: true, user: { id: user.id, email: user.email, displayName: user.display_name, avatarColor: user.avatar_color } });
});

/* POST /api/auth/logout */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* POST /api/auth/register */
router.post('/register', (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  const hash     = bcrypt.hashSync(password, 10);
  const username = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
  const stmt = db.prepare('INSERT INTO users (email, username, password_hash, display_name) VALUES (?, ?, ?, ?)');
  const info  = stmt.run(email.trim().toLowerCase(), username, hash, displayName || username);
  req.session.userId    = info.lastInsertRowid;
  req.session.userEmail = email.trim().toLowerCase();
  res.status(201).json({ ok: true });
});

/* GET /api/auth/me */
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorised' });
  const db   = getDb();
  const user = db.prepare('SELECT id, email, username, display_name, avatar_color, created_at FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ id: user.id, email: user.email, username: user.username, displayName: user.display_name, avatarColor: user.avatar_color, createdAt: user.created_at });
});

/* PATCH /api/auth/me */
router.patch('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorised' });
  const { displayName, avatarColor, email, currentPassword, newPassword } = req.body;
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required.' });
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) return res.status(401).json({ error: 'Wrong current password.' });
    const hash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = unixepoch() WHERE id = ?').run(hash, user.id);
  }

  if (email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.trim().toLowerCase(), user.id);
    if (conflict) return res.status(409).json({ error: 'Email already in use.' });
  }

  db.prepare(`
    UPDATE users SET display_name = COALESCE(?, display_name),
                     avatar_color = COALESCE(?, avatar_color),
                     email        = COALESCE(?, email),
                     updated_at   = unixepoch()
    WHERE id = ?
  `).run(displayName || null, avatarColor || null, email ? email.trim().toLowerCase() : null, user.id);

  res.json({ ok: true });
});

module.exports = router;
