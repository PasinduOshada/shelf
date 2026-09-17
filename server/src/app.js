import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UPLOADS_DIR, CLIENT_DIST, ensureDirs } from './paths.js';
import libraryRoutes from './routes/library.js';
import insightRoutes from './routes/insights.js';
import organizeRoutes from './routes/organize.js';
import mediaRoutes from './routes/media.js';
import extraRoutes from './routes/extras.js';
import imageRoutes from './routes/images.js';
import { setDefaultResultOrder } from 'node:dns';

// Prefer IPv4 for outgoing connections. With Node's default ordering, fetches to
// api.themoviedb.org failed with ECONNRESET 3/3 on a real home connection while
// ipv4first succeeded 3/3 (curl worked over both families). Only a preference:
// IPv6-only networks still connect over IPv6. Runs at import, so it covers both
// the web server and the Electron host before any request is made.
setDefaultResultOrder('ipv4first');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
for (const h of (process.env.SHELF_ALLOWED_HOSTS || '').split(',')) if (h.trim()) LOCAL_HOSTS.add(h.trim().toLowerCase());

function hostnameOf(value) {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function localOnly(req, res, next) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host || ''))) {
    return res.status(403).json({ error: 'Shelf only accepts requests from this computer' });
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !LOCAL_HOSTS.has(hostnameOf(origin))) {
    return res.status(403).json({ error: 'Cross-site requests are not allowed' });
  }
  next();
}

// Everything the page needs comes from this server; nothing may be loaded from
// or sent to anywhere else, and the page may not be framed.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

/** Build the app without listening, so Electron can host it on any port. */
export function createApp() {
  ensureDirs();
  const app = express();

  // Shelf can move files and start programs, so it only answers this computer.
  // No CORS headers (the UI is same-origin), and the Host/Origin checks stop a
  // web page from reaching the API through DNS rebinding or a cross-site POST.
  app.use(localOnly);
  app.use(securityHeaders);
  app.use(express.json({ limit: '2mb' }));

  app.use('/uploads', express.static(UPLOADS_DIR, {
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));

  // TMDB artwork through a local cache, so posters survive going offline.
  app.use('/img', imageRoutes);

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'shelf' }));
  app.use('/api', libraryRoutes);
  app.use('/api', insightRoutes);
  app.use('/api', organizeRoutes);
  app.use('/api', mediaRoutes);
  app.use('/api', extraRoutes);

  // Serve the built SPA when it exists (production / desktop).
  // Express 5 rejects a bare '*' route, so the fallback is plain middleware.
  if (existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      if (/^\/(api|uploads|img)(\/|$)/.test(req.path)) return next();
      res.sendFile(join(CLIENT_DIST, 'index.html'));
    });
  }

  app.use((err, _req, res, _next) => {
    // Multer rejects oversized uploads before the route sees them.
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That file is too large (64 MB at most)' });
    }
    if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(413).json({ error: 'Too many files at once (5 at most)' });
    }
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  });

  return app;
}
