import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('docs');
const previewMode = !process.argv.includes('--production');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let data, type = 'application/json; charset=utf-8';
    if (url.pathname === '/config.json' && previewMode) data = JSON.stringify({ owner: '', repo: '', branch: 'main', path: 'checklist.json', localPreview: true });
    else if (url.pathname === '/__local/checklist.json' && previewMode) data = await fs.readFile('private-data/checklist.json');
    else {
      const target = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      data = await fs.readFile(target); type = types[path.extname(target)] || 'application/octet-stream';
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? '' : data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:4173/'));
