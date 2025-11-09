import esbuild from 'esbuild';
import connect from 'connect';
import http from 'http';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import open from 'open';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { loadReactClientConfig } from '../../utils/loadConfig';
import { BroadcastManager, HMRMessage } from '../../server/broadcastManager';
import type { ReactClientPlugin } from '../../types/plugin';

export default async function dev() {
  const root = process.cwd();
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  const pkgFile = path.join(appRoot, 'package.json');
  await fs.ensureDir(cacheDir);

  // Detect entry
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  const indexHtml = path.join(appRoot, 'index.html');

  // Detect port
  const availablePort = await detectPort(defaultPort);
  const port = availablePort;
  if (availablePort !== defaultPort) {
    const res = await prompts({
      type: 'confirm',
      name: 'useNewPort',
      message: `Port ${defaultPort} is occupied. Use ${availablePort} instead?`,
      initial: true,
    });
    if (!res.useNewPort) {
      console.log('🛑 Dev server cancelled.');
      process.exit(0);
    }
  }

  // Ensure react-refresh installed
  try {
    require.resolve('react-refresh/runtime');
  } catch {
    console.warn(chalk.yellow('⚠️ react-refresh not found — installing...'));
    execSync('npm install react-refresh --no-audit --no-fund --silent', {
      cwd: root,
      stdio: 'inherit',
    });
    console.log(chalk.green('✅ react-refresh installed successfully.'));
  }

  // Core plugin: CSS HMR
  const corePlugins: ReactClientPlugin[] = [
    {
      name: 'css-hmr',
      async onTransform(code, id) {
        if (id.endsWith('.css')) {
          const escaped = JSON.stringify(code);
          return `
            const css = ${escaped};
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
            import.meta.hot && import.meta.hot.accept();
          `;
        }
        return code;
      },
    },
  ];
  const userPlugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
  const plugins: ReactClientPlugin[] = [...corePlugins, ...userPlugins];

  // Connect app
  const app = connect();
  const transformCache = new Map<string, string>();

  // 🧠 Prewarm: analyze imports before first run
  async function analyzeImports(entryFile: string): Promise<string[]> {
    const entryCode = await fs.readFile(entryFile, 'utf8');
    const importMatches = [
      ...entryCode.matchAll(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g),
      ...entryCode.matchAll(/\bimport\(['"]([^'".\/][^'"]*)['"]\)/g),
    ];
    const deps = [...new Set(importMatches.map((m) => m[1]))];
    console.log(chalk.gray(`🧩 Found ${deps.length} direct imports:`), deps.join(', '));
    return deps;
  }

  // 📦 Smart prebundle cache
  async function prebundleDeps(deps: string[]) {
    if (!deps.length) return;
    const cached = (await fs.readdir(cacheDir)).map((f) => f.replace('.js', ''));
    const missing = deps.filter((d) => !cached.includes(d));

    if (!missing.length) {
      console.log(chalk.green('✅ All dependencies already prebundled.'));
      return;
    }

    console.log(chalk.cyan('📦 Prebundling:'), missing.join(', '));
    await Promise.all(
      missing.map(async (dep) => {
        try {
          const entryPath = require.resolve(dep, { paths: [appRoot] });
          const outFile = path.join(cacheDir, dep + '.js');
          await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            platform: 'browser',
            format: 'esm',
            outfile: outFile,
            write: true,
            target: 'es2020',
          });
          console.log(chalk.green(`✅ Cached ${dep}`));
        } catch (err) {
          const e = err as Error;
          console.warn(chalk.yellow(`⚠️ Skipped ${dep}: ${e.message}`));
        }
      }),
    );
  }

  // 🧩 Smart rebuild trigger when package.json changes
  chokidar.watch(pkgFile).on('change', async () => {
    console.log(chalk.yellow('📦 Detected package.json change — rebuilding prebundles...'));
    const deps = await analyzeImports(entry);
    await prebundleDeps(deps);
  });

  // Initial prewarm
  const initialDeps = await analyzeImports(entry);
  await prebundleDeps(initialDeps);

  // --- Serve prebundled / node_modules
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/(@modules\/)?/, '');
    if (!id) return next();

    try {
      const cacheFile = path.join(cacheDir, id.replace(/\//g, '_') + '.js');
      if (await fs.pathExists(cacheFile)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(await fs.readFile(cacheFile));
      }

      let entryPath: string | null = null;
      try {
        entryPath = require.resolve(id, { paths: [path.join(appRoot, 'node_modules')] });
      } catch {
        if (id === 'react') entryPath = require.resolve('react');
        else if (id === 'react-dom' || id === 'react-dom/client')
          entryPath = require.resolve('react-dom');
      }

      if (!entryPath) throw new Error(`Module ${id} not found.`);

      const result = await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
        write: false,
      });

      let code = result.outputFiles[0].text;

      // Fix for react-dom/client exports
      if (id === 'react-dom/client') {
        code += `
          import * as ReactDOMClient from '/@modules/react-dom';
          export const createRoot = ReactDOMClient.createRoot || ReactDOMClient.default?.createRoot;
          export default ReactDOMClient.default || ReactDOMClient;
        `;
      }

      await fs.writeFile(cacheFile, code, 'utf8');
      res.setHeader('Content-Type', 'application/javascript');
      res.end(code);
    } catch (err) {
      const e = err as Error;
      console.error(chalk.red(`❌ Failed to load module ${id}: ${e.message}`));
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${e.message}`);
    }
  });

  // --- Serve src files + HMR
  app.use(async (req, res, next) => {
    if (!req.url || (!req.url.startsWith('/src/') && !req.url.endsWith('.css'))) return next();
    const rawPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(appRoot, rawPath);

    const possibleExts = ['', '.tsx', '.ts', '.jsx', '.js'];
    for (const ext of possibleExts) {
      if (await fs.pathExists(filePath + ext)) {
        filePath += ext;
        break;
      }
    }

    if (!(await fs.pathExists(filePath))) return next();

    try {
      let code = await fs.readFile(filePath, 'utf8');
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_match, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_match, dep) => `import("/@modules/${dep}")`,
        );

      for (const p of plugins) if (p.onTransform) code = await p.onTransform(code, filePath);

      const ext = path.extname(filePath);
      let loader: esbuild.Loader = 'js';
      if (ext === '.ts') loader = 'ts';
      else if (ext === '.tsx') loader = 'tsx';
      else if (ext === '.jsx') loader = 'jsx';

      const result = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        target: 'es2020',
      });

      transformCache.set(filePath, result.code);
      res.setHeader('Content-Type', 'application/javascript');
      res.end(result.code);
    } catch (err) {
      const e = err as Error;
      console.error(chalk.red(`⚠️ Transform failed: ${e.message}`));
      res.writeHead(500);
      res.end(`// Error: ${e.message}`);
    }
  });

  // --- index.html + overlay
  app.use(async (req, res, next) => {
    if (req.url !== '/' && req.url !== '/index.html') return next();
    if (!fs.existsSync(indexHtml)) {
      res.writeHead(404);
      return res.end('index.html not found');
    }

    let html = await fs.readFile(indexHtml, 'utf8');
    html = html.replace(
      '</body>',
      `
      <script>
        (() => {
          const style = document.createElement('style');
          style.textContent = \`
            .rc-overlay {
              position: fixed; top: 0; left: 0; width: 100%; height: 100%;
              background: rgba(0,0,0,0.9); color: #ff5555;
              font-family: monospace; padding: 2rem; overflow:auto; z-index: 999999;
            }
          \`;
          document.head.appendChild(style);
          window.showErrorOverlay = (err) => {
            window.clearErrorOverlay?.();
            const el = document.createElement('div');
            el.className = 'rc-overlay';
            el.innerHTML = '<h2>🚨 Error</h2><pre>' + (err.message || err) + '</pre>';
            document.body.appendChild(el);
            window.__overlay = el;
          };
          window.clearErrorOverlay = () => window.__overlay?.remove();
        })();
      </script>
      <script type="module">
        const ws = new WebSocket("ws://" + location.host);
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "reload") location.reload();
          if (msg.type === "error") return window.showErrorOverlay?.(msg);
          if (msg.type === "update") {
            window.clearErrorOverlay?.();
            import(msg.path + "?t=" + Date.now());
          }
        };
      </script>
      </body>`,
    );

    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });

  // --- WebSocket + HMR
  const server = http.createServer(app);
  const broadcaster = new BroadcastManager(server);

  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', async (file) => {
    console.log(chalk.yellow(`🔄 Changed: ${file}`));
    transformCache.delete(file);
    for (const p of plugins) {
      await p.onHotUpdate?.(file, { broadcast: (msg: HMRMessage) => broadcaster.broadcast(msg) });
    }
    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });

  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.cyan.bold('\n🚀 React Client Dev Server'));
    console.log(chalk.gray('──────────────────────────────'));
    console.log(chalk.green(`⚡ Running at: ${url}`));
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    broadcaster.close();
    process.exit(0);
  });
}
