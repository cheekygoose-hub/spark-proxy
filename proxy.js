const http  = require('http');
const https = require('https');

// Railway injects PORT automatically — fallback to 3001 for local use
const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST')    { res.writeHead(405); res.end('Method not allowed'); return; }
  if (req.url !== '/v1/messages') { res.writeHead(404); res.end('Not found'); return; }

  // Key: env var (set in Railway dashboard) takes priority, then app header
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

// Must bind 0.0.0.0 on Railway (not 127.0.0.1)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spark proxy listening on port ${PORT}`);
});
