import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
function hash(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}
export default async function buildSsr() {
  const root = process.cwd();
  const clientEntry = path.join(root, 'src', 'entry-client.tsx');
  const serverEntry = path.join(root, 'src', 'entry-server.tsx');
  if (!fs.existsSync(clientEntry) || !fs.existsSync(serverEntry)) {
    console.error('SSR entries missing');
    process.exit(1);
  }
  const out = path.join(root, 'dist');
  await fs.remove(out);
  const clientResult = await esbuild.build({
    entryPoints: [clientEntry],
    bundle: true,
    outdir: path.join(out, 'client'),
    metafile: true,
    minify: true,
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.js': 'jsx',
      '.jsx': 'jsx',
      '.png': 'file',
      '.jpg': 'file',
      '.svg': 'file',
    },
  });
  const _serverResult = await esbuild.build({
    entryPoints: [serverEntry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(out, 'server', 'entry-server.js'),
    external: ['react', 'react-dom'],
  });
  const manifest: Record<string, string> = {};
  for (const outPath in clientResult.metafile.outputs) {
    if (!outPath.startsWith('client/')) continue;
    const abs = path.join(out, outPath);
    if (!fs.existsSync(abs)) continue;
    const data = await fs.readFile(abs);
    const h = hash(data);
    const rel = outPath.replace(/^client\//, '');
    const ext = path.extname(rel);
    const hashed = rel.replace(ext, '.' + h + ext);
    await fs.ensureDir(path.join(out, 'client', path.dirname(hashed)));
    await fs.move(abs, path.join(out, 'client', hashed));
    manifest[rel] = hashed;
  }
  await fs.writeFile(
    path.join(out, 'client', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  const runtime = `const http = require('http');const fs = require('fs');const path=require('path');const { render } = require('./entry-server.js');const clientDir = path.join(__dirname,'..','client');const manifest = JSON.parse(fs.readFileSync(path.join(clientDir,'manifest.json'),'utf8'));const PORT = process.env.PORT||3000;const server = http.createServer(async (req,res)=>{ try{ if(req.url && req.url.startsWith('/client/')){ const rel = req.url.replace('/client/',''); const mapped = manifest[rel] || rel; const p = path.join(clientDir, mapped); if(fs.existsSync(p)) { res.writeHead(200); res.end(fs.readFileSync(p)); return; } } const htmlPath = path.join(clientDir,'index.html'); let html = '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/client/bundle.js"></script></body></html>'; if(fs.existsSync(htmlPath)) html = fs.readFileSync(htmlPath,'utf8'); const content = await render(req.url||'/'); const outHtml = html.replace('<div id="root"></div>','<div id="root">'+content+'</div>'); res.writeHead(200,{'Content-Type':'text/html'}); res.end(outHtml);}catch(e){ console.error(e); res.writeHead(500); res.end('SSR error');}});server.listen(PORT,()=>console.log('SSR server running on port '+PORT));`;
  await fs.ensureDir(path.join(out, 'server'));
  await fs.writeFile(path.join(out, 'server', 'server.js'), runtime, 'utf8');
  console.log('SSR build complete at', out);
}
