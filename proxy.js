const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3001;

// Serve the Spark app HTML
const HTML_PATH = path.join(__dirname, 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

const server = http.createServer((req, res) => {

  // ── Serve the app ──────────────────────────────────────────────────────
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // ── CORS headers for all API routes ───────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST')    { res.writeHead(405); res.end('Method not allowed'); return; }
  if (req.url !== '/v1/messages') { res.writeHead(404); res.end('Not found'); return; }

  // ── Proxy to Anthropic ─────────────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY || req.headers['x-api-key'] || '';
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'No API key. Set ANTHROPIC_API_KEY in Railway Variables.' }
    }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spark running on port ${PORT}`);
});
