import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadReactClientConfig } from '../../utils/loadConfig';

export default async function buildSsr() {
  const root = process.cwd();
  const config = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, config.root || '.');
  const outDir = path.join(appRoot, config.build?.outDir || '.react-client/ssr');

  console.log(chalk.cyan(`\n🧱 Building SSR bundle...`));
  console.log(chalk.gray(`Root: ${appRoot}`));
  console.log(chalk.gray(`Output: ${outDir}\n`));

  const entry = path.join(appRoot, 'src', 'server.tsx');
  if (!fs.existsSync(entry)) {
    console.error(chalk.red('❌ SSR entry not found: src/server.tsx'));
    process.exit(1);
  }

  await fs.ensureDir(outDir);

  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      external: ['react', 'react-dom'],
      outdir: outDir,
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.ts': 'ts', '.tsx': 'tsx' },
    });

    console.log(chalk.green(`✅ SSR build completed successfully!`));
    console.log(chalk.gray(`Output directory: ${outDir}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ SSR build failed:', msg);
    process.exit(1);
  }
}
