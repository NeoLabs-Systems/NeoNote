'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const bcrypt   = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'noteeneo.db');

let _db;
function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    /* ── Users ─────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE COLLATE NOCASE,
      username      TEXT    UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      display_name  TEXT,
      avatar_color  TEXT    DEFAULT '#6366f1',
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Notebooks ──────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS notebooks (
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT    NOT NULL DEFAULT 'Untitled Notebook',
      cover_color TEXT    NOT NULL DEFAULT '#6366f1',
      cover_style TEXT    NOT NULL DEFAULT 'solid',   /* solid | gradient | pattern */
      icon        TEXT    NOT NULL DEFAULT '📓',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      pinned      INTEGER NOT NULL DEFAULT 0,
      archived    INTEGER NOT NULL DEFAULT 0,
      page_count  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Notebook tags ──────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS notebook_tags (
      notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      tag         TEXT NOT NULL,
      PRIMARY KEY (notebook_id, tag)
    );

    /* ── Pages ──────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS pages (
      id           TEXT    PRIMARY KEY,
      notebook_id  TEXT    NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      title        TEXT,
      template     TEXT    NOT NULL DEFAULT 'blank',  /* blank|lined|dotted|grid|music|cornell|hex */
      template_color TEXT  NOT NULL DEFAULT '#ffffff10',
      bg_color     TEXT    NOT NULL DEFAULT 'default',
      width        INTEGER NOT NULL DEFAULT 1404,     /* pts, A4 landscape equiv */
      height       INTEGER NOT NULL DEFAULT 1872,     /* pts, A4 */
      thumbnail    TEXT,                              /* base64 PNG */
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Layers ─────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS layers (
      id          TEXT    PRIMARY KEY,
      page_id     TEXT    NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL DEFAULT 'Layer 1',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      visible     INTEGER NOT NULL DEFAULT 1,
      locked      INTEGER NOT NULL DEFAULT 0,
      opacity     REAL    NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Strokes ────────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS strokes (
      id          TEXT    PRIMARY KEY,
      layer_id    TEXT    NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
      page_id     TEXT    NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      tool        TEXT    NOT NULL DEFAULT 'pen',   /* pen|pencil|marker|highlighter|eraser|text|shape */
      color       TEXT    NOT NULL DEFAULT '#000000',
      width       REAL    NOT NULL DEFAULT 2.0,
      opacity     REAL    NOT NULL DEFAULT 1.0,
      blend_mode  TEXT    NOT NULL DEFAULT 'source-over',
      points      TEXT    NOT NULL DEFAULT '[]',    /* JSON: [{x,y,p,t}] pressure 0-1 */
      bbox        TEXT,                             /* JSON: {x,y,w,h} */
      extra       TEXT,                             /* JSON: tool-specific: {text, shape, font, …} */
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── Images embedded on page ────────────────────────────── */
    CREATE TABLE IF NOT EXISTS page_images (
      id          TEXT    PRIMARY KEY,
      page_id     TEXT    NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      layer_id    TEXT    NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
      data        TEXT    NOT NULL,                 /* base64 data URL */
      x           REAL    NOT NULL DEFAULT 0,
      y           REAL    NOT NULL DEFAULT 0,
      width       REAL    NOT NULL DEFAULT 200,
      height      REAL    NOT NULL DEFAULT 200,
      rotation    REAL    NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    /* ── User settings ──────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme       TEXT    NOT NULL DEFAULT 'dark',
      default_pen_color   TEXT NOT NULL DEFAULT '#000000',
      default_pen_width   REAL NOT NULL DEFAULT 2.5,
      palm_rejection       INTEGER NOT NULL DEFAULT 1,
      pressure_enabled     INTEGER NOT NULL DEFAULT 1,
      auto_save_interval   INTEGER NOT NULL DEFAULT 5,
      show_page_numbers    INTEGER NOT NULL DEFAULT 1,
      haptic_feedback      INTEGER NOT NULL DEFAULT 1,
      extra                TEXT                     /* JSON blob for future settings */
    );

    /* ── Indices ─────────────────────────────────────────────── */
    CREATE INDEX IF NOT EXISTS idx_notebooks_user    ON notebooks(user_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_pages_notebook    ON pages(notebook_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_strokes_layer     ON strokes(layer_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_strokes_page      ON strokes(page_id);
    CREATE INDEX IF NOT EXISTS idx_layers_page       ON layers(page_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_page_images_page  ON page_images(page_id, sort_order);
  `);

  /* ── Migrate: add email column if missing (existing DBs) ─── */
  const cols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
  if (!cols.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    /* Copy username into email for existing accounts */
    db.exec("UPDATE users SET email = username WHERE email IS NULL");
    console.log('[db] Migrated: added email column to users');
  }

  /* ── Seed default admin if no users exist ─────────────────── */
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const hash = bcrypt.hashSync('noteeneo', 10);
    db.prepare(`
      INSERT INTO users (email, username, password_hash, display_name)
      VALUES (?, ?, ?, ?)
    `).run('admin@noteeneo.app', 'admin', hash, 'Admin');
    console.log('[db] Created default user: admin@noteeneo.app / noteeneo');
  }

  console.log('[db] SQLite database ready →', DB_PATH);
}

module.exports = { getDb, initDb };
