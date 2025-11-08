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
  await fs.ensureDir(cacheDir);

  // Detect entry dynamically (main.tsx or main.jsx)
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  const indexHtml = path.join(appRoot, 'index.html');

  // Detect open port
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

  // ⚡ React-refresh runtime auto install
  function safeResolveReactRefresh(): string {
    try {
      return require.resolve('react-refresh/runtime');
    } catch {
      console.warn(chalk.yellow('⚠️ react-refresh not found — installing...'));
      execSync('npm install react-refresh --no-audit --no-fund --silent', {
        cwd: root,
        stdio: 'inherit',
      });
      return require.resolve('react-refresh/runtime');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _reactRefreshRuntime = safeResolveReactRefresh();

  // --- Plugins (core + user)
  const corePlugins: ReactClientPlugin[] = [
    {
      name: 'css-hmr',
      async onTransform(code: string, id: string): Promise<string> {
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

  // 🧱 Connect app
  const app = connect();
  const transformCache = new Map<string, string>();

  // --- Prebundle persistent deps
  async function prebundleDeps(): Promise<void> {
    const pkgFile = path.join(appRoot, 'package.json');
    if (!fs.existsSync(pkgFile)) return;

    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    const deps = Object.keys(pkg.dependencies || {});
    if (!deps.length) return;

    const cached = await fs.readdir(cacheDir);
    const missing = deps.filter((d) => !cached.includes(d + '.js'));
    if (!missing.length) return;

    console.log(chalk.cyan('📦 Prebundling:'), missing.join(', '));
    for (const dep of missing) {
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(chalk.yellow(`⚠️ Skipped ${dep}: ${msg}`));
      }
    }
  }
  await prebundleDeps();

  // --- Serve prebundled modules
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/@modules\//, '');
    if (!id) return next();

    try {
      const cacheFile = path.join(cacheDir, id.replace(/\//g, '_') + '.js');
      if (await fs.pathExists(cacheFile)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(await fs.readFile(cacheFile));
      }

      const entryPath = require.resolve(id, { paths: [appRoot] });
      const result = await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
        write: false,
      });

      let code = result.outputFiles[0].text;
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${msg}`);
    }
  });

  // --- Serve /src files dynamically
  app.use(async (req, res, next) => {
    if (!req.url || (!req.url.startsWith('/src/') && !req.url.endsWith('.css'))) return next();
    const filePath = path.join(appRoot, decodeURIComponent(req.url.split('?')[0]));
    if (!(await fs.pathExists(filePath))) return next();

    try {
      if (transformCache.has(filePath)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(transformCache.get(filePath)!);
      }

      let code = await fs.readFile(filePath, 'utf8');

      // 🧩 Rewrite bare imports (react, react-dom, etc.) to /@modules/*
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_match, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_match, dep) => `import("/@modules/${dep}")`,
        );

      // Run plugin transforms
      for (const p of plugins) {
        if (p.onTransform) code = await p.onTransform(code, filePath);
      }

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(`// Error: ${msg}`);
    }
  });

  // --- Serve index.html with overlay + HMR client
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

  // --- WebSocket + HMR via BroadcastManager
  const server = http.createServer(app);
  const broadcaster = new BroadcastManager(server);

  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', async (file) => {
    console.log(chalk.yellow(`🔄 Changed: ${file}`));
    transformCache.delete(file);

    for (const p of plugins) {
      p.onHotUpdate?.(file, {
        broadcast: (msg: HMRMessage) => broadcaster.broadcast(msg),
      });
    }

    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });

  // 🚀 Launch
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
