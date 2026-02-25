'use strict';

const express   = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/database');

const router = express.Router();
const uid = (req) => req.session.userId;

/* ── Helper: touch notebook updated_at + page_count ───────── */
function touchNotebook(db, id) {
  db.prepare(`
    UPDATE notebooks
    SET updated_at = unixepoch(),
        page_count = (SELECT COUNT(*) FROM pages WHERE notebook_id = ?)
    WHERE id = ?
  `).run(id, id);
}

/* ── GET /api/notebooks ──────────────────────────────────── */
router.get('/', (req, res) => {
  const db  = getDb();
  const { archived = '0', q } = req.query;
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT n.*, GROUP_CONCAT(t.tag, ',') AS tags
      FROM notebooks n
      LEFT JOIN notebook_tags t ON t.notebook_id = n.id
      WHERE n.user_id = ? AND n.archived = ?
        AND (n.title LIKE ? OR t.tag LIKE ?)
      GROUP BY n.id ORDER BY n.pinned DESC, n.sort_order, n.updated_at DESC
    `).all(uid(req), archived === '1' ? 1 : 0, `%${q}%`, `%${q}%`);
  } else {
    rows = db.prepare(`
      SELECT n.*, GROUP_CONCAT(t.tag, ',') AS tags
      FROM notebooks n
      LEFT JOIN notebook_tags t ON t.notebook_id = n.id
      WHERE n.user_id = ? AND n.archived = ?
      GROUP BY n.id ORDER BY n.pinned DESC, n.sort_order, n.updated_at DESC
    `).all(uid(req), archived === '1' ? 1 : 0);
  }
  rows.forEach(r => { r.tags = r.tags ? r.tags.split(',') : []; });
  res.json(rows);
});

/* ── POST /api/notebooks ─────────────────────────────────── */
router.post('/', (req, res) => {
  const db  = getDb();
  const { title = 'Untitled Notebook', coverColor = '#6366f1', coverStyle = 'solid', icon = '📓' } = req.body;
  const id  = uuid();
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM notebooks WHERE user_id = ?').get(uid(req)).m;
  db.prepare(`
    INSERT INTO notebooks (id, user_id, title, cover_color, cover_style, icon, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, uid(req), title, coverColor, coverStyle, icon, maxOrder + 1);

  /* create a first default page */
  const pageId  = uuid();
  const layerId = uuid();
  db.prepare(`INSERT INTO pages (id, notebook_id, sort_order) VALUES (?, ?, 0)`).run(pageId, id);
  db.prepare(`INSERT INTO layers (id, page_id, name, sort_order) VALUES (?, ?, 'Background', 0)`).run(uuid(), pageId);
  db.prepare(`INSERT INTO layers (id, page_id, name, sort_order) VALUES (?, ?, 'Layer 1', 1)`).run(layerId, pageId);
  touchNotebook(db, id);

  const nb = db.prepare('SELECT * FROM notebooks WHERE id = ?').get(id);
  res.status(201).json({ ...nb, tags: [] });
});

/* ── GET /api/notebooks/:id ──────────────────────────────── */
router.get('/:id', (req, res) => {
  const db = getDb();
  const nb = db.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ?').get(req.params.id, uid(req));
  if (!nb) return res.status(404).json({ error: 'Not found.' });
  const tags = db.prepare('SELECT tag FROM notebook_tags WHERE notebook_id = ?').all(nb.id).map(r => r.tag);
  res.json({ ...nb, tags });
});

/* ── PATCH /api/notebooks/:id ──────────────────────────────── */
router.patch('/:id', (req, res) => {
  const db = getDb();
  const nb = db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(req.params.id, uid(req));
  if (!nb) return res.status(404).json({ error: 'Not found.' });

  const { title, coverColor, coverStyle, icon, pinned, archived, tags } = req.body;
  db.prepare(`
    UPDATE notebooks
    SET title        = COALESCE(?, title),
        cover_color  = COALESCE(?, cover_color),
        cover_style  = COALESCE(?, cover_style),
        icon         = COALESCE(?, icon),
        pinned       = COALESCE(?, pinned),
        archived     = COALESCE(?, archived),
        updated_at   = unixepoch()
    WHERE id = ?
  `).run(title ?? null, coverColor ?? null, coverStyle ?? null, icon ?? null,
         pinned != null ? (pinned ? 1 : 0) : null,
         archived != null ? (archived ? 1 : 0) : null,
         nb.id);

  if (Array.isArray(tags)) {
    db.prepare('DELETE FROM notebook_tags WHERE notebook_id = ?').run(nb.id);
    const ins = db.prepare('INSERT OR IGNORE INTO notebook_tags (notebook_id, tag) VALUES (?, ?)');
    tags.forEach(t => ins.run(nb.id, t.trim()));
  }

  res.json({ ok: true });
});

/* ── DELETE /api/notebooks/:id ──────────────────────────────── */
router.delete('/:id', (req, res) => {
  const db = getDb();
  const info = db.prepare('DELETE FROM notebooks WHERE id = ? AND user_id = ?').run(req.params.id, uid(req));
  if (info.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
});

/* ── POST /api/notebooks/:id/reorder ──────────────────────── */
router.post('/:id/reorder', (req, res) => {
  const db = getDb();
  const { order } = req.body; /* array of notebook IDs in desired order */
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array.' });
  const upd = db.prepare('UPDATE notebooks SET sort_order = ? WHERE id = ? AND user_id = ?');
  db.transaction(() => order.forEach((id, i) => upd.run(i, id, uid(req))))();
  res.json({ ok: true });
});

/* ── GET /api/notebooks/:id/tags (all tags for user) ─────── */
router.get('/:id/tags', (req, res) => {
  const db = getDb();
  const tags = db.prepare(`
    SELECT DISTINCT t.tag FROM notebook_tags t
    JOIN notebooks n ON n.id = t.notebook_id
    WHERE n.user_id = ?
    ORDER BY t.tag
  `).all(uid(req)).map(r => r.tag);
  res.json(tags);
});

module.exports = router;
