// `npm run web` -- build the web client and serve it at http://localhost:5173.
//
// For trying the browser/Android client in a desktop browser (the device
// toolbar in DevTools is a fair phone). localhost on purpose: it is a secure
// context, which getUserMedia needs -- the same page served over plain HTTP
// from another address could not open a microphone at all.
//
//   npm run web               build, then serve on 5173
//   npm run web -- 8000       another port

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

require('./build-web.js');

const ROOT = path.join(__dirname, '..', 'www');
const PORT = Number(process.argv[2]) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[web] http://localhost:${PORT}`);
  });
