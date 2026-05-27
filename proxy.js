const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = process.env.PORT         || 3001;
const PROXY_SECRET = process.env.PROXY_SECRET || ''; // set this in your env for security

// ── Simple in-memory rate limiter (per IP, sliding window) ───────────────
const _rateLimiter = new Map();
const RATE_WINDOW_MS  = 60 * 1000; // 1 minute window
const RATE_LIMIT_REQS = 60;        // max 60 requests per minute per IP

function isRateLimited(ip) {
  const now = Date.now();
  let record = _rateLimiter.get(ip);
  if (!record || now - record.windowStart > RATE_WINDOW_MS) {
    record = { windowStart: now, count: 0 };
    _rateLimiter.set(ip, record);
  }
  record.count++;
  if (record.count > RATE_LIMIT_REQS) return true;
  // Prune old entries periodically (prevent unbounded growth)
  if (_rateLimiter.size > 10000) {
    for (const [k, v] of _rateLimiter) {
      if (now - v.windowStart > RATE_WINDOW_MS) _rateLimiter.delete(k);
    }
  }
  return false;
}


// ── Persistent room store (SQLite via better-sqlite3) ─────────────────────
// Falls back to in-memory JSON if better-sqlite3 not available (cold start)
let db = null;
let roomsMemory = {}; // fallback

function initDb() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'rooms.db');
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL DEFAULT '',
        blob TEXT NOT NULL DEFAULT '{}'
      );
      -- Migration: add expires_at column if it doesn't exist (safe to run on existing DBs)
    `);
    try {
      db.exec("ALTER TABLE rooms ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''");
    } catch(e) { /* column already exists — safe to ignore */ }
    console.log('SQLite ready at', dbPath);
  } catch (e) {
    console.warn('better-sqlite3 not available — using in-memory store (data will not survive restarts):', e.message);
    db = null;
  }
}
initDb();

// ── Room store API ────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/1/0 ambiguity
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function roomCreate() {
  let code;
  for (let i = 0; i < 20; i++) {
    code = generateCode();
    if (!roomGet(code)) break;
  }
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30-min join window
  if (db) {
    db.prepare('INSERT INTO rooms (code, created_at, updated_at, expires_at, blob) VALUES (?, ?, ?, ?, ?)')
      .run(code, now, now, expiresAt, '{}');
  } else {
    roomsMemory[code] = { createdAt: now, updatedAt: now, expiresAt, blob: {} };
  }
  return { code, createdAt: now, updatedAt: now, expiresAt, blob: {} };
}

function roomGet(code) {
  if (db) {
    const row = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
    if (!row) return null;
    return { code: row.code, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at || '', blob: JSON.parse(row.blob) };
  }
  const r = roomsMemory[code];
  return r ? { code, ...r } : null;
}

function roomPatch(code, patch, clientUpdatedAt) {
  const room = roomGet(code);
  if (!room) return null;
  // Last-write-wins with timestamp guard: reject if client is older than 2s behind current
  if (clientUpdatedAt && room.updatedAt) {
    const clientTs = new Date(clientUpdatedAt).getTime();
    const serverTs = new Date(room.updatedAt).getTime();
    // Allow if client is within 5s of server (clock skew tolerance)
    if (clientTs < serverTs - 5000) {
      return { conflict: true, updatedAt: room.updatedAt, blob: room.blob };
    }
  }
  // Shallow-merge patch into blob, but NEVER clobber the other partner's prefs silo
  const merged = { ...room.blob };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'prefs') {
      // Deep-merge prefs: only overwrite the sub-key that's present in patch
      merged.prefs = { ...(merged.prefs || {}) };
      for (const [role, rolePrefs] of Object.entries(v)) {
        merged.prefs[role] = rolePrefs; // each device only ever sends its own role
      }
    } else {
      merged[k] = v;
    }
  }
  const now = new Date().toISOString();
  if (db) {
    db.prepare('UPDATE rooms SET blob = ?, updated_at = ? WHERE code = ?')
      .run(JSON.stringify(merged), now, code);
  } else {
    roomsMemory[code] = { createdAt: room.createdAt, updatedAt: now, expiresAt: room.expiresAt || '', blob: merged };
  }
  return { code, createdAt: room.createdAt, updatedAt: now, blob: merged };
}

// ── Privacy filter: strip the other partner's raw prefs before sending ────
function filterBlobForRole(blob, myRole) {
  if (!blob || !blob.prefs) return blob;
  const filtered = { ...blob };
  const otherRole = myRole === 'A' ? 'B' : 'A';
  filtered.prefs = { ...(blob.prefs || {}) };
  // Remove other partner's raw prefs — send only mutual matches
  if (filtered.prefs[otherRole]) {
    delete filtered.prefs[otherRole];
  }
  // Only compute and inject mutualMatches if the other partner's prefs silo exists
  // If themPrefs is empty (partner hasn't submitted yet), leave mutualMatches absent
  // so the client can distinguish "no match" from "partner not ready"
  if (blob.prefs && blob.prefs[otherRole] && Object.keys(blob.prefs[otherRole]).length > 0) {
    const myPrefs   = blob.prefs[myRole]   || {};
    const themPrefs = blob.prefs[otherRole];
    const mutualMatches = {};
    for (const [k, v] of Object.entries(myPrefs)) {
      const theirV = themPrefs[k];
      if (!theirV || theirV === 'no' || v === 'no') continue;
      const levels = { fav: 3, like: 2, int: 1, partner: 0 };
      const myLevel   = levels[v]      ?? -1;
      const themLevel = levels[theirV] ?? -1;
      if (myLevel >= 0 && themLevel >= 0) {
        mutualMatches[k] = myLevel <= themLevel ? v : theirV;
      }
    }
    filtered.mutualMatches = mutualMatches;
  }
  // If partner prefs not yet present, mutualMatches is absent — client shows "Nearly there"
  return filtered;
}

// ── Serve the Spark app HTML ──────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'index.html');
let HTML;
try { HTML = fs.readFileSync(HTML_PATH, 'utf8'); } catch { HTML = '<h1>index.html not found</h1>'; }

// ── Request router ────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // Serve the app
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // CORS headers for all API routes
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, x-api-key, anthropic-version, x-spark-role');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  // ── Health check — for Render free-tier keep-alive (UptimeRobot etc) ─
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // ── Room routes ───────────────────────────────────────────────────────
  // POST /room/create
  if (req.method === 'POST' && url === '/room/create') {
    const room = roomCreate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: room.code, updatedAt: room.updatedAt }));
    return;
  }

  // POST /room/join  { code }
  if (req.method === 'POST' && url === '/room/join') {
    readBody(req, body => {
      let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const room = roomGet((parsed.code || '').toUpperCase().trim());
      if (!room) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Room not found — check the code and try again.' }));
      } else if (room.expiresAt && new Date(room.expiresAt) < new Date()) {
        // Code has expired — room still exists (linked devices can still sync) but new joins are blocked
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'This code has expired. Ask your partner to create a new space.' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: room.code, updatedAt: room.updatedAt }));
      }
    });
    return;
  }

  // GET /room/:code
  const getMatch = url.match(/^\/room\/([A-Z0-9]{10})$/);
  if (req.method === 'GET' && getMatch) {
    const room = roomGet(getMatch[1]);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Room not found' }));
      return;
    }
    const myRole = (req.headers['x-spark-role'] || '').toUpperCase();
    const filtered = (myRole === 'A' || myRole === 'B')
      ? filterBlobForRole(room.blob, myRole)
      : room.blob;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: room.code, updatedAt: room.updatedAt, blob: filtered }));
    return;
  }

  // POST /room/:code  { patch, updatedAt }
  const patchMatch = url.match(/^\/room\/([A-Z0-9]{10})$/);
  if (req.method === 'POST' && patchMatch) {
    readBody(req, body => {
      let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
      const result = roomPatch(patchMatch[1], parsed.patch || {}, parsed.updatedAt);
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Room not found' }));
        return;
      }
      if (result.conflict) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conflict: true, updatedAt: result.updatedAt, blob: result.blob }));
        return;
      }
      const myRole = (req.headers['x-spark-role'] || '').toUpperCase();
      const filtered = (myRole === 'A' || myRole === 'B')
        ? filterBlobForRole(result.blob, myRole)
        : result.blob;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: result.code, updatedAt: result.updatedAt, blob: filtered }));
    });
    return;
  }

  // ── Anthropic proxy ───────────────────────────────────────────────────
  if (req.method !== 'POST' && url !== '/v1/messages') {
    res.writeHead(req.method === 'GET' ? 404 : 405);
    res.end('Not found');
    return;
  }
  if (url !== '/v1/messages') {
    res.writeHead(404); res.end('Not found'); return;
  }

  // Shared secret check — if PROXY_SECRET is set, require x-spark-token header
  if (PROXY_SECRET) {
    const token = req.headers['x-spark-token'] || '';
    if (token !== PROXY_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden.' } }));
      return;
    }
  }

  // Rate limiting
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  if (isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Too many requests — slow down.' } }));
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'] || '';
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No API key. Set ANTHROPIC_API_KEY in environment variables.' } }));
    return;
  }

  readBody(req, body => {
    const upstream = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, upRes => {
      res.writeHead(upRes.statusCode, {
        'Content-Type': upRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      upRes.pipe(res);
    });
    upstream.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    upstream.write(body);
    upstream.end();
  });
});

const MAX_BODY_BYTES = 65536; // 64 KB — prevents memory exhaustion

function readBody(req, cb) {
  let body = '';
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => cb(body));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spark running on port ${PORT}`);
});
