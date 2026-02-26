'use strict';

require('dotenv').config();

const express       = require('express');
const path          = require('path');
const helmet        = require('helmet');
const session       = require('express-session');
const SQLiteStore   = require('connect-sqlite3')(session);
const rateLimit     = require('express-rate-limit');

const { requireAuth, requireNoAuth } = require('./middleware/auth');
const authRoutes      = require('./routes/auth');
const notebookRoutes  = require('./routes/notebooks');
const pageRoutes      = require('./routes/pages');
const strokeRoutes    = require('./routes/strokes');
const exportRoutes    = require('./routes/export');
const settingsRoutes  = require('./routes/settings');

const { initDb } = require('./db/database');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

/* ── Database ───────────────────────────────────────────────────────────── */
initDb();

/* ── Security ───────────────────────────────────────────────────────────── */
const isProduction = process.env.NODE_ENV === 'production';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:       ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
      objectSrc:     ["'none'"],
      frameSrc:      ["'none'"],
      frameAncestors:["'none'"],
      /* Only upgrade insecure requests in production (where HTTPS is available).
         Without this, browsers on plain HTTP (e.g. Tailscale) will try to
         upgrade every asset request to HTTPS and fail to load CSS / JS. */
      upgradeInsecureRequests: isProduction ? [] : null,
    }
  },
  /* Disable HSTS on non-production — it would permanently force HTTPS for the
     Tailscale hostname in the browser, breaking plain-HTTP local access. */
  hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false
}));

/*
 * TRUST_PROXY env var controls whether Express should trust the proxy.
 * - If TRUST_PROXY is explicitly set to "0" or "false", proxy trusting is disabled (more compatible with local setups).
 * - Otherwise (unset or any other value), trust proxy is enabled (1).
 */
const _trustProxyEnv = String(process.env.TRUST_PROXY || '').toLowerCase();
const trustProxyEnabled = !(_trustProxyEnv === '0' || _trustProxyEnv === 'false');
if (trustProxyEnabled) {
  app.set('trust proxy', 1);
  console.log('[config] TRUST_PROXY enabled (trust proxy = 1)');
} else {
  app.set('trust proxy', false);
  console.log('[config] TRUST_PROXY disabled via env (trust proxy = false)');
}
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: false, limit: '4mb' }));

/* ── Session ────────────────────────────────────────────────────────────── */
if (!process.env.SESSION_SECRET) {
  console.warn('[WARN] SESSION_SECRET not set – using insecure default.');
}
const sessionStore = new SQLiteStore({
  db: 'sessions.db',
  dir: path.join(__dirname, 'data'),
  table: 'sessions'
});
app.use(session({
  name: 'neonote.sid',
  secret: process.env.SESSION_SECRET || 'neonote-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

/* ── Static ─────────────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ── Rate limiter ───────────────────────────────────────────────────────── */
const _rlTrustProxy = trustProxyEnabled; /* use same flag for rate-limit validation */
app.use('/api', rateLimit({
  windowMs: 60_000,
  max: 500,
  validate: { trustProxy: _rlTrustProxy }
}));

/* ── Page routes ────────────────────────────────────────────────────────── */
app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/app');
  res.redirect('/login');
});
app.get('/login',  requireNoAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/app',    requireAuth,   (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── API ────────────────────────────────────────────────────────────────── */
app.use('/api/auth',      authRoutes);
app.use('/api/notebooks', requireAuth, notebookRoutes);
app.use('/api/pages',     requireAuth, pageRoutes);
app.use('/api/strokes',   requireAuth, strokeRoutes);
app.use('/api/export',    requireAuth, exportRoutes);
app.use('/api/settings',  requireAuth, settingsRoutes);

/* ── Error handler ──────────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n  ✦ NeoNote running at  http://localhost:${PORT}`);
  console.log(`  ✦ Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
