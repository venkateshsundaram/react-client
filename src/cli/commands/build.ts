import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import { execSync } from 'child_process';
import crypto from 'crypto';
function hash(buf: Buffer) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}
export default async function build() {
  const root = process.cwd();
  const entry = path.join(root, 'src', 'main.tsx');
  const out = path.join(root, 'dist');
  await fs.remove(out);
  const result = await esbuild.build({
    entryPoints: [entry],
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
  const postcssConfig = path.join(root, 'postcss.config.cjs');
  if (fs.existsSync(postcssConfig)) {
    try {
      execSync(
        'npx postcss ' + path.join(out, 'client', '*.css') + ' -d ' + path.join(out, 'client'),
      );
    } catch (e) {
      console.warn('PostCSS failed', e && e.message);
    }
  }
  const manifest: Record<string, string> = {};
  for (const outPath in result.metafile.outputs) {
    const abs = path.join(root, outPath);
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
  console.log('Built client to', path.join(out, 'client'));
}
