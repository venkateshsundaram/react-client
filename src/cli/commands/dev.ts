import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
export default async function dev() {
  const root = process.cwd();
  const entry = path.join(root, 'src', 'main.tsx');
  if (!fs.existsSync(entry)) {
    console.error('Entry not found: src/main.tsx');
    process.exit(1);
  }
  const outdir = path.join(root, '.react-client', 'dev');
  await fs.ensureDir(outdir);
  const ctx = await esbuild.context({
    entryPoints: [entry],
    bundle: true,
    sourcemap: true,
    outdir,
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.jsx': 'jsx' },
  });
  await ctx.watch();
  await ctx.serve({ servedir: outdir, port: 5173 });
}
