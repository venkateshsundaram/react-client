import esbuild from 'esbuild';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadReactClientConfig } from '../../utils/loadConfig.js';

export default async function build() {
  const root = process.cwd();
  const config = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, config.root || '.');
  const outDir = path.join(appRoot, config.build?.outDir || 'dist');

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
      entryNames: '[name]',
    });

    // Post-process index.html to point to the bundled JS/CSS
    const htmlPath = path.join(outDir, 'index.html');
    if (await fs.pathExists(htmlPath)) {
      let html = await fs.readFile(htmlPath, 'utf8');

      // Replace common entry script paths with the production bundle
      // We use [^"]* to allow subdirectories like /src/main.tsx
      const scriptRegex = /<script\s+type="module"\s+src="\/[^"]*main\.[jt]sx?"><\/script>/gi;
      html = html.replace(scriptRegex, '<script type="module" src="/main.js"></script>');

      // Inject CSS bundle if it exists
      const cssPath = path.join(outDir, 'main.css');
      if (await fs.pathExists(cssPath)) {
        if (!html.includes('main.css')) {
          html = html.replace('</head>', '  <link rel="stylesheet" href="/main.css">\n  </head>');
        }
      }

      await fs.writeFile(htmlPath, html, 'utf8');
    }

    console.log(chalk.green(`✅ Build completed successfully!`));
    console.log(chalk.gray(`Output directory: ${outDir}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('❌ Build failed:', msg);
    process.exit(1);
  }
}
