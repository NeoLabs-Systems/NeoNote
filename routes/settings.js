'use strict';

const express   = require('express');
const { getDb } = require('../db/database');

const router = express.Router();
const uid = (req) => req.session.userId;

/* ── GET /api/settings ───────────────────────────────────── */
router.get('/', (req, res) => {
  const db  = getDb();
  let s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(uid(req));
  if (!s) {
    db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(uid(req));
    s = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(uid(req));
  }
  try { s.extra = s.extra ? JSON.parse(s.extra) : {}; } catch { s.extra = {}; }
  res.json(s);
});

/* ── PATCH /api/settings ─────────────────────────────────── */
router.patch('/', (req, res) => {
  const db  = getDb();
  db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(uid(req));
  const { theme, defaultPenColor, defaultPenWidth, palmRejection, pressureEnabled, autoSaveInterval, showPageNumbers, hapticFeedback, extra } = req.body;
  db.prepare(`
    UPDATE user_settings
    SET theme               = COALESCE(?, theme),
        default_pen_color   = COALESCE(?, default_pen_color),
        default_pen_width   = COALESCE(?, default_pen_width),
        palm_rejection      = COALESCE(?, palm_rejection),
        pressure_enabled    = COALESCE(?, pressure_enabled),
        auto_save_interval  = COALESCE(?, auto_save_interval),
        show_page_numbers   = COALESCE(?, show_page_numbers),
        haptic_feedback     = COALESCE(?, haptic_feedback),
        extra               = COALESCE(?, extra)
    WHERE user_id = ?
  `).run(
    theme ?? null,
    defaultPenColor ?? null,
    defaultPenWidth ?? null,
    palmRejection != null ? (palmRejection ? 1 : 0) : null,
    pressureEnabled != null ? (pressureEnabled ? 1 : 0) : null,
    autoSaveInterval ?? null,
    showPageNumbers != null ? (showPageNumbers ? 1 : 0) : null,
    hapticFeedback != null ? (hapticFeedback ? 1 : 0) : null,
    extra ? JSON.stringify(extra) : null,
    uid(req)
  );
  res.json({ ok: true });
});

module.exports = router;
