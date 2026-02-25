'use strict';

const express   = require('express');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db/database');

const router = express.Router();
const uid = (req) => req.session.userId;

/* ── helper: verify notebook belongs to user ──────────────── */
function ownedNotebook(db, notebookId, userId) {
  return db.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?').get(notebookId, userId);
}

/* ── helper: verify page belongs to user ─────────────────── */
function ownedPage(db, pageId, userId) {
  return db.prepare(`
    SELECT p.id, p.notebook_id FROM pages p
    JOIN notebooks n ON n.id = p.notebook_id
    WHERE p.id = ? AND n.user_id = ?
  `).get(pageId, userId);
}

/* ── GET /api/pages?notebook=<id> ────────────────────────── */
router.get('/', (req, res) => {
  const { notebook } = req.query;
  if (!notebook) return res.status(400).json({ error: 'notebook param required.' });
  const db = getDb();
  if (!ownedNotebook(db, notebook, uid(req))) return res.status(404).json({ error: 'Notebook not found.' });
  const pages = db.prepare(`
    SELECT id, notebook_id, sort_order, title, template, template_color, bg_color,
           width, height, thumbnail, created_at, updated_at
    FROM pages WHERE notebook_id = ? ORDER BY sort_order
  `).all(notebook);
  res.json(pages);
});

/* ── POST /api/pages ─────────────────────────────────────── */
router.post('/', (req, res) => {
  const db  = getDb();
  const { notebookId, title, template = 'blank', templateColor = '#ffffff10', bgColor = 'default', width = 1404, height = 1872, afterPageId } = req.body;
  if (!notebookId) return res.status(400).json({ error: 'notebookId required.' });
  if (!ownedNotebook(db, notebookId, uid(req))) return res.status(404).json({ error: 'Notebook not found.' });

  /* Determine sort_order */
  let newOrder;
  if (afterPageId) {
    const pg = db.prepare('SELECT sort_order FROM pages WHERE id = ? AND notebook_id = ?').get(afterPageId, notebookId);
    newOrder = pg ? pg.sort_order + 1 : 9999;
    db.prepare('UPDATE pages SET sort_order = sort_order + 1 WHERE notebook_id = ? AND sort_order >= ?').run(notebookId, newOrder);
  } else {
    newOrder = (db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM pages WHERE notebook_id = ?').get(notebookId).m) + 1;
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO pages (id, notebook_id, sort_order, title, template, template_color, bg_color, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, notebookId, newOrder, title || null, template, templateColor, bgColor, width, height);

  /* Default layers */
  db.prepare('INSERT INTO layers (id, page_id, name, sort_order) VALUES (?, ?, ?, ?)').run(uuid(), id, 'Background', 0);
  db.prepare('INSERT INTO layers (id, page_id, name, sort_order) VALUES (?, ?, ?, ?)').run(uuid(), id, 'Layer 1', 1);

  db.prepare('UPDATE notebooks SET page_count = (SELECT COUNT(*) FROM pages WHERE notebook_id = ?), updated_at = unixepoch() WHERE id = ?').run(notebookId, notebookId);

  res.status(201).json(db.prepare('SELECT * FROM pages WHERE id = ?').get(id));
});

/* ── GET /api/pages/:id ──────────────────────────────────── */
router.get('/:id', (req, res) => {
  const db   = getDb();
  const page = ownedPage(db, req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });
  const full = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  const layers = db.prepare('SELECT * FROM layers WHERE page_id = ? ORDER BY sort_order').all(req.params.id);
  res.json({ ...full, layers });
});

/* ── PATCH /api/pages/:id ────────────────────────────────── */
router.patch('/:id', (req, res) => {
  const db   = getDb();
  const page = ownedPage(db, req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });
  const { title, template, templateColor, bgColor, thumbnail } = req.body;
  db.prepare(`
    UPDATE pages
    SET title          = COALESCE(?, title),
        template       = COALESCE(?, template),
        template_color = COALESCE(?, template_color),
        bg_color       = COALESCE(?, bg_color),
        thumbnail      = COALESCE(?, thumbnail),
        updated_at     = unixepoch()
    WHERE id = ?
  `).run(title ?? null, template ?? null, templateColor ?? null, bgColor ?? null, thumbnail ?? null, req.params.id);
  res.json({ ok: true });
});

/* ── DELETE /api/pages/:id ───────────────────────────────── */
router.delete('/:id', (req, res) => {
  const db   = getDb();
  const page = ownedPage(db, req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });

  const nbId = page.notebook_id;
  db.prepare('DELETE FROM pages WHERE id = ?').run(req.params.id);
  db.prepare('UPDATE notebooks SET page_count = (SELECT COUNT(*) FROM pages WHERE notebook_id = ?), updated_at = unixepoch() WHERE id = ?').run(nbId, nbId);
  res.json({ ok: true });
});

/* ── POST /api/pages/:id/reorder ─────────────────────────── */
router.post('/:id/reorder', (req, res) => {
  const db   = getDb();
  const page = ownedPage(db, req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be array of page IDs.' });
  const upd = db.prepare('UPDATE pages SET sort_order = ? WHERE id = ? AND notebook_id = ?');
  db.transaction(() => order.forEach((pid, i) => upd.run(i, pid, page.notebook_id)))();
  res.json({ ok: true });
});

/* ── POST /api/pages/:id/duplicate ──────────────────────── */
router.post('/:id/duplicate', (req, res) => {
  const db   = getDb();
  const page = ownedPage(db, req.params.id, uid(req));
  if (!page) return res.status(404).json({ error: 'Not found.' });
  const src  = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  const newId = uuid();
  const newOrder = src.sort_order + 1;
  db.prepare('UPDATE pages SET sort_order = sort_order + 1 WHERE notebook_id = ? AND sort_order > ?').run(src.notebook_id, src.sort_order);
  db.prepare(`
    INSERT INTO pages (id, notebook_id, sort_order, title, template, template_color, bg_color, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, src.notebook_id, newOrder, src.title ? src.title + ' (copy)' : null, src.template, src.template_color, src.bg_color, src.width, src.height);

  /* duplicate layers & strokes */
  const srcLayers = db.prepare('SELECT * FROM layers WHERE page_id = ? ORDER BY sort_order').all(req.params.id);
  const layerMap  = {};
  srcLayers.forEach(l => {
    const newLayerId = uuid();
    layerMap[l.id]   = newLayerId;
    db.prepare('INSERT INTO layers (id, page_id, name, sort_order, visible, locked, opacity) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newLayerId, newId, l.name, l.sort_order, l.visible, l.locked, l.opacity);
  });
  const srcStrokes = db.prepare('SELECT * FROM strokes WHERE page_id = ?').all(req.params.id);
  srcStrokes.forEach(s => {
    db.prepare(`
      INSERT INTO strokes (id, layer_id, page_id, tool, color, width, opacity, blend_mode, points, bbox, extra, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), layerMap[s.layer_id] || s.layer_id, newId, s.tool, s.color, s.width, s.opacity, s.blend_mode, s.points, s.bbox, s.extra, s.sort_order);
  });

  db.prepare('UPDATE notebooks SET page_count = (SELECT COUNT(*) FROM pages WHERE notebook_id = ?), updated_at = unixepoch() WHERE id = ?').run(src.notebook_id, src.notebook_id);
  res.status(201).json(db.prepare('SELECT * FROM pages WHERE id = ?').get(newId));
});

/* ── LAYERS ─────────────────────────────────────────────── */

/* GET /api/pages/:id/layers */
router.get('/:id/layers', (req, res) => {
  const db   = getDb();
  if (!ownedPage(db, req.params.id, uid(req))) return res.status(404).json({ error: 'Not found.' });
  res.json(db.prepare('SELECT * FROM layers WHERE page_id = ? ORDER BY sort_order').all(req.params.id));
});

/* POST /api/pages/:id/layers */
router.post('/:id/layers', (req, res) => {
  const db   = getDb();
  if (!ownedPage(db, req.params.id, uid(req))) return res.status(404).json({ error: 'Not found.' });
  const { name = 'Layer', visible = 1, opacity = 1.0 } = req.body;
  const maxOrd = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM layers WHERE page_id = ?').get(req.params.id).m;
  const id = uuid();
  db.prepare('INSERT INTO layers (id, page_id, name, sort_order, visible, opacity) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.params.id, name, maxOrd + 1, visible ? 1 : 0, opacity);
  res.status(201).json(db.prepare('SELECT * FROM layers WHERE id = ?').get(id));
});

/* PATCH /api/pages/:pageId/layers/:layerId */
router.patch('/:pageId/layers/:layerId', (req, res) => {
  const db = getDb();
  if (!ownedPage(db, req.params.pageId, uid(req))) return res.status(404).json({ error: 'Not found.' });
  const { name, visible, locked, opacity, sortOrder } = req.body;
  db.prepare(`
    UPDATE layers
    SET name       = COALESCE(?, name),
        visible    = COALESCE(?, visible),
        locked     = COALESCE(?, locked),
        opacity    = COALESCE(?, opacity),
        sort_order = COALESCE(?, sort_order)
    WHERE id = ? AND page_id = ?
  `).run(name ?? null, visible != null ? (visible ? 1 : 0) : null, locked != null ? (locked ? 1 : 0) : null,
         opacity ?? null, sortOrder ?? null, req.params.layerId, req.params.pageId);
  res.json({ ok: true });
});

/* DELETE /api/pages/:pageId/layers/:layerId */
router.delete('/:pageId/layers/:layerId', (req, res) => {
  const db = getDb();
  if (!ownedPage(db, req.params.pageId, uid(req))) return res.status(404).json({ error: 'Not found.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM layers WHERE page_id = ?').get(req.params.pageId).n;
  if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last layer.' });
  db.prepare('DELETE FROM layers WHERE id = ? AND page_id = ?').run(req.params.layerId, req.params.pageId);
  res.json({ ok: true });
});

module.exports = router;
