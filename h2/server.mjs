// Scope 1.6 H2: stdlib HTTP server for the harness page. Serves page/ and the source WAVs
// from <out>/sources, and stores uploads under <out>/runs/<run>/:
//   POST /chunk?run&seq   -> chunk-0000.bin ...   (append mode)
//   POST /segment?run&seq -> segment-0000.bin ... (segmented mode)
//   POST /fullresend?run  -> fullresend.bin       (client-built Blob of all chunks, C4)
//   POST /done?run        -> info.json
// Usage: node server.mjs --out <dir> [--port 8616]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const OUT = path.resolve(option('out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'h2')));
const PORT = Number(option('port', process.env.H2_PORT || 8616));
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'page');
const SAFE = /^[A-Za-z0-9._-]{1,120}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wav': 'audio/wav' };

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size > 50 * 1024 * 1024) reject(new Error('body too large'));
      parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!SAFE.test(name)) return send(res, 404, 'not found');
      const file = name.endsWith('.wav') ? path.join(OUT, 'sources', name) : path.join(PAGE, name);
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(name)] || 'application/octet-stream');
    }
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');
    const run = url.searchParams.get('run') || '';
    if (!SAFE.test(run)) return send(res, 400, 'bad run id');
    const dir = path.join(OUT, 'runs', run);
    fs.mkdirSync(dir, { recursive: true });
    const body = await readBody(req);
    const seq = String(Number(url.searchParams.get('seq') || 0)).padStart(4, '0');
    const target = {
      '/chunk': `chunk-${seq}.bin`,
      '/segment': `segment-${seq}.bin`,
      '/fullresend': 'fullresend.bin',
      '/done': 'info.json'
    }[url.pathname];
    if (!target) return send(res, 404, 'not found');
    fs.writeFileSync(path.join(dir, target), body);
    return send(res, 200, 'ok');
  } catch (error) {
    return send(res, 500, String(error.message));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`h2 server on http://127.0.0.1:${PORT} out=${OUT}`));
