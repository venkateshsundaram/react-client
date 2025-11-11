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

  const entry = path.join(appRoot, 'src', 'main.tsx');
  if (!fs.existsSync(entry)) {
    console.error(chalk.red('❌ Entry not found: src/main.tsx'));
    process.exit(1);
  }

  await fs.ensureDir(outDir);

  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      sourcemap: true,
      outdir: outDir,
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.jsx': 'jsx' },
    });

    console.log(chalk.green(`✅ Build completed successfully!`));
    console.log(chalk.gray(`Output directory: ${outDir}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Build failed:', msg);
    process.exit(1);
  }
}
