import http from 'http';
import fs from 'fs';
import path from 'path';
export default async function preview() {
  const out = path.join(process.cwd(), 'dist');
  if (!fs.existsSync(out)) {
    console.error('dist not found, run build');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    let url = req.url?.split('?')[0] || '/';
    if (url === '/') url = '/index.html';
    const f = path.join(out, url);
    if (fs.existsSync(f)) {
      res.writeHead(200);
      res.end(fs.readFileSync(f));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });
  server.listen(5000, () => console.log('Preview running at http://localhost:5000'));
}
