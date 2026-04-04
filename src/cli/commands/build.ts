import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadReactClientConfig } from '../../utils/loadConfig.js';

export default async function build() {
  const root = process.cwd();
  const config = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, config.root || '.');
  const outDir = path.join(appRoot, config.build?.outDir || '.react-client/build');

  console.log(chalk.cyan(`\n🏗️ Building project...`));
  console.log(chalk.gray(`Root: ${appRoot}`));
  console.log(chalk.gray(`Output: ${outDir}\n`));

  // Detect entry (main.tsx / main.jsx)
  const paths = [
    path.join(appRoot, 'src/main.tsx'),
    path.join(appRoot, 'src/main.jsx'),
    path.join(appRoot, 'main.tsx'),
    path.join(appRoot, 'main.jsx'),
  ];
  const entry = paths.find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ Entry not found: main.tsx or main.jsx in app root or src/'));
    process.exit(1);
  }

  await fs.ensureDir(outDir);

  // Copy public folder contents to outDir
  let publicDir = path.join(appRoot, 'public');
  if (!fs.existsSync(publicDir)) {
    publicDir = path.join(root, 'public');
  }
  if (await fs.pathExists(publicDir)) {
    await fs.copy(publicDir, outDir);
  }

  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      sourcemap: true,
      outdir: outDir,
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.jsx': 'jsx' },
      jsx: 'automatic',
    });

    console.log(chalk.green(`✅ Build completed successfully!`));
    console.log(chalk.gray(`Output directory: ${outDir}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Build failed:', msg);
    process.exit(1);
  }
}
