'use strict';

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  /* req.path is stripped of the mount prefix, so use originalUrl to detect API calls */
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorised' });
  res.redirect('/login');
}

function requireNoAuth(req, res, next) {
  if (!req.session?.userId) return next();
  res.redirect('/app');
}

module.exports = { requireAuth, requireNoAuth };
