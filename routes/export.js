'use strict';

const express   = require('express');
const { getDb } = require('../db/database');

const router = express.Router();
const uid = (req) => req.session.userId;

/* ── GET /api/export/page/:id ────────────────────────────── */
/* Returns all data needed to reconstruct the page client-side for export */
router.get('/page/:id', (req, res) => {
  const db = getDb();
  const page = db.prepare(`
    SELECT p.* FROM pages p
    JOIN notebooks n ON n.id = p.notebook_id
    WHERE p.id = ? AND n.user_id = ?
  `).get(req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });

  const layers  = db.prepare('SELECT * FROM layers WHERE page_id = ? ORDER BY sort_order').all(page.id);
  const strokes = db.prepare('SELECT * FROM strokes WHERE page_id = ? ORDER BY sort_order').all(page.id);
  const images  = db.prepare('SELECT * FROM page_images WHERE page_id = ? ORDER BY sort_order').all(page.id);

  strokes.forEach(s => {
    try { s.points = JSON.parse(s.points); } catch { s.points = []; }
    try { s.bbox   = s.bbox  ? JSON.parse(s.bbox)  : null; } catch { s.bbox = null; }
    try { s.extra  = s.extra ? JSON.parse(s.extra) : null; } catch { s.extra = null; }
  });

  res.json({ page, layers, strokes, images });
});

module.exports = router;
