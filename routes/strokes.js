'use strict';

const express   = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/database');

const router = express.Router();
const uid = (req) => req.session.userId;

/* ── helper: verify page belongs to user ─────────────────── */
function ownedPage(db, pageId, userId) {
  return db.prepare(`
    SELECT p.id FROM pages p
    JOIN notebooks n ON n.id = p.notebook_id
    WHERE p.id = ? AND n.user_id = ?
  `).get(pageId, userId);
}

/* ── GET /api/strokes?page=<id>[&layer=<id>] ─────────────── */
router.get('/', (req, res) => {
  const { page, layer } = req.query;
  if (!page) return res.status(400).json({ error: 'page param required.' });
  const db = getDb();
  if (!ownedPage(db, page, uid(req))) return res.status(404).json({ error: 'Page not found.' });

  let rows;
  if (layer) {
    rows = db.prepare('SELECT * FROM strokes WHERE page_id = ? AND layer_id = ? ORDER BY sort_order').all(page, layer);
  } else {
    rows = db.prepare('SELECT * FROM strokes WHERE page_id = ? ORDER BY sort_order').all(page);
  }
  /* parse JSON fields */
  rows.forEach(r => {
    try { r.points = JSON.parse(r.points); } catch { r.points = []; }
    try { r.bbox   = r.bbox  ? JSON.parse(r.bbox)  : null; } catch { r.bbox = null; }
    try { r.extra  = r.extra ? JSON.parse(r.extra) : null; } catch { r.extra = null; }
  });
  res.json(rows);
});

/* ── GET /api/strokes/images?page=<id> ────────────────────── */
router.get('/images', (req, res) => {
  const { page } = req.query;
  if (!page) return res.status(400).json({ error: 'page param required.' });
  const db = getDb();
  if (!ownedPage(db, page, uid(req))) return res.status(404).json({ error: 'Page not found.' });
  res.json(db.prepare('SELECT * FROM page_images WHERE page_id = ? ORDER BY sort_order').all(page));
});

/* ── POST /api/strokes ───────────────────────────────────── */
router.post('/', (req, res) => {
  const db  = getDb();
  const { pageId, layerId, tool = 'pen', color = '#000000', width = 2, opacity = 1, blendMode = 'source-over', points = [], bbox = null, extra = null } = req.body;
  if (!pageId || !layerId) return res.status(400).json({ error: 'pageId and layerId required.' });
  if (!ownedPage(db, pageId, uid(req))) return res.status(404).json({ error: 'Page not found.' });

  const maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM strokes WHERE page_id = ?').get(pageId).m;
  const id = uuid();
  db.prepare(`
    INSERT INTO strokes (id, layer_id, page_id, tool, color, width, opacity, blend_mode, points, bbox, extra, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, layerId, pageId, tool, color, width, opacity, blendMode,
         JSON.stringify(points), bbox ? JSON.stringify(bbox) : null, extra ? JSON.stringify(extra) : null, maxOrd + 1);

  db.prepare('UPDATE pages SET updated_at = unixepoch() WHERE id = ?').run(pageId);
  res.status(201).json({ id });
});

/* ── POST /api/strokes/batch ─────────────────────────────── */
/* Save multiple strokes at once (bulk) */
router.post('/batch', (req, res) => {
  const db  = getDb();
  const { pageId, layerId, strokes } = req.body;
  if (!pageId || !layerId || !Array.isArray(strokes)) return res.status(400).json({ error: 'pageId, layerId, strokes required.' });
  if (!ownedPage(db, pageId, uid(req))) return res.status(404).json({ error: 'Page not found.' });

  let maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM strokes WHERE page_id = ?').get(pageId).m;
  const ins  = db.prepare(`
    INSERT OR REPLACE INTO strokes (id, layer_id, page_id, tool, color, width, opacity, blend_mode, points, bbox, extra, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ids = db.transaction(() => strokes.map(s => {
    const id = s.id || uuid();
    ins.run(id, layerId, pageId, s.tool || 'pen', s.color || '#000000', s.width || 2, s.opacity ?? 1, s.blendMode || 'source-over',
            JSON.stringify(s.points || []), s.bbox ? JSON.stringify(s.bbox) : null, s.extra ? JSON.stringify(s.extra) : null, ++maxOrd);
    return id;
  }))();
  db.prepare('UPDATE pages SET updated_at = unixepoch() WHERE id = ?').run(pageId);
  res.status(201).json({ ids });
});

/* ── DELETE /api/strokes ─────────────────────────────────── (by list of IDs) */
router.delete('/', (req, res) => {
  const db  = getDb();
  const { ids, pageId } = req.body;
  if (!Array.isArray(ids) || !pageId) return res.status(400).json({ error: 'ids array and pageId required.' });
  if (!ownedPage(db, pageId, uid(req))) return res.status(404).json({ error: 'Page not found.' });
  const del = db.prepare('DELETE FROM strokes WHERE id = ? AND page_id = ?');
  db.transaction(() => ids.forEach(id => del.run(id, pageId)))();
  db.prepare('UPDATE pages SET updated_at = unixepoch() WHERE id = ?').run(pageId);
  res.json({ ok: true, deleted: ids.length });
});

/* ── DELETE /api/strokes/page/:pageId ────────────────────── (clear page) */
router.delete('/page/:pageId', (req, res) => {
  const db = getDb();
  if (!ownedPage(db, req.params.pageId, uid(req))) return res.status(404).json({ error: 'Page not found.' });
  const { layerId } = req.query;
  if (layerId) {
    db.prepare('DELETE FROM strokes WHERE page_id = ? AND layer_id = ?').run(req.params.pageId, layerId);
  } else {
    db.prepare('DELETE FROM strokes WHERE page_id = ?').run(req.params.pageId);
  }
  db.prepare('UPDATE pages SET updated_at = unixepoch() WHERE id = ?').run(req.params.pageId);
  res.json({ ok: true });
});

/* ── POST /api/strokes/images ────────────────────────────── */
router.post('/images', (req, res) => {
  const db = getDb();
  const { pageId, layerId, data, x = 0, y = 0, width = 200, height = 200, rotation = 0 } = req.body;
  if (!pageId || !layerId || !data) return res.status(400).json({ error: 'pageId, layerId, data required.' });
  if (!ownedPage(db, pageId, uid(req))) return res.status(404).json({ error: 'Page not found.' });
  const maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM page_images WHERE page_id = ?').get(pageId).m;
  const id = uuid();
  db.prepare('INSERT INTO page_images (id, page_id, layer_id, data, x, y, width, height, rotation, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, pageId, layerId, data, x, y, width, height, rotation, maxOrd + 1);
  res.status(201).json({ id });
});

/* ── PATCH /api/strokes/images/:id ──────────────────────── */
router.patch('/images/:id', (req, res) => {
  const db = getDb();
  const { x, y, width, height, rotation } = req.body;
  db.prepare(`
    UPDATE page_images
    SET x = COALESCE(?, x), y = COALESCE(?, y),
        width = COALESCE(?, width), height = COALESCE(?, height),
        rotation = COALESCE(?, rotation)
    WHERE id = ?
  `).run(x ?? null, y ?? null, width ?? null, height ?? null, rotation ?? null, req.params.id);
  res.json({ ok: true });
});

/* ── DELETE /api/strokes/images/:id ─────────────────────── */
router.delete('/images/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM page_images WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
