const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
function createServer() {
  return http.createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let name;
    try { name = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400); return res.end('Bad request'); }
    if (name === '/') name = '/index.html';
    const file = path.resolve(ROOT, '.' + name);
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 4175);
  const server = createServer();
  server.on('error', err => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another value (for example 4176).` : err.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`JarcTech Ticket: http://localhost:${port}`));
}
module.exports = { createServer };
