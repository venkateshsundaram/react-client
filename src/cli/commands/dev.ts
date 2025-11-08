import esbuild from 'esbuild';
import connect from 'connect';
import http from 'http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import { loadReactClientConfig } from '../../utils/loadConfig';
import open from 'open';
import { execSync } from 'child_process';
import chalk from 'chalk';

interface HMRMessage {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
}

export default async function dev() {
  const root = process.cwd();

  // 🧩 Load config
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const outDir = path.join(appRoot, userConfig.build?.outDir || '.react-client/dev');

  // 🧠 Detect entry (main.tsx / main.jsx)
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));

  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  const indexHtml = path.join(appRoot, 'index.html');
  await fs.ensureDir(outDir);

  // 🧠 Detect available port
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

  // ⚡ Auto-install + resolve react-refresh runtime
  function safeResolveReactRefresh(): string {
    try {
      return require.resolve('react-refresh/runtime');
    } catch {
      console.warn(chalk.yellow('⚠️ react-refresh not found — attempting to install...'));
      try {
        execSync('npm install react-refresh --no-audit --no-fund --silent', {
          cwd: root,
          stdio: 'inherit',
        });
        console.log(chalk.green('✅ react-refresh installed successfully.'));
        return require.resolve('react-refresh/runtime');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(msg);
        console.error(chalk.red('❌ Failed to install react-refresh automatically.'));
        console.error('Please run: npm install react-refresh');
        process.exit(1);
      }
    }
  }

  const reactRefreshRuntime = safeResolveReactRefresh();

  // 🧠 Dependency Graph + Transform Cache
  const deps = new Map<string, Set<string>>(); // dependency → importers
  const transformCache = new Map<string, string>();

  async function resolveFile(basePath: string): Promise<string | null> {
    if (await fs.pathExists(basePath)) return basePath;
    const exts = ['.tsx', '.ts', '.jsx', '.js'];
    for (const ext of exts) {
      const candidate = basePath + ext;
      if (await fs.pathExists(candidate)) return candidate;
    }
    return null;
  }

  // 🌐 connect server
  const app = connect();

  // 🛡 Security headers
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  // 1️⃣ Serve react-refresh runtime with browser shim
  app.use('/@react-refresh', async (_req, res) => {
    const runtime = await fs.readFile(reactRefreshRuntime, 'utf8');
    const shim = `
      window.process = window.process || { env: { NODE_ENV: 'development' } };
      window.module = { exports: {} };
      window.global = window;
      window.require = () => window.module.exports;
    `;
    res.setHeader('Content-Type', 'application/javascript');
    res.end(shim + '\n' + runtime);
  });

  // 2️⃣ Serve bare modules dynamically (/@modules/)
  app.use('/@modules/', async (req, res, next) => {
    let id = req.url?.replace(/^\/@modules\//, '');
    if (!id) return next();
    id = id.replace(/^\/+/, ''); // normalize

    try {
      const entry = require.resolve(id, { paths: [appRoot] });
      const out = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
      });
      res.setHeader('Content-Type', 'application/javascript');
      res.end(out.outputFiles[0].text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to resolve module ${id}:`, msg);
      res.writeHead(500);
      res.end(`// Could not resolve module ${id}`);
    }
  });

  // 3️⃣ Serve /src/* files — with caching, deps tracking, and HMR
  app.use(async (req, res, next) => {
    if (!req.url || !req.url.startsWith('/src/')) return next();

    try {
      const requestPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(appRoot, requestPath);

      const resolvedFile = await resolveFile(filePath);
      if (!resolvedFile) return next();

      if (transformCache.has(resolvedFile)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(transformCache.get(resolvedFile)!);
        return;
      }

      let code = await fs.readFile(resolvedFile, 'utf8');
      const ext = path.extname(resolvedFile).toLowerCase();

      // 🪄 Rewrite bare imports → /@modules/
      code = code.replace(
        /from\s+['"]((?![\.\/])[a-zA-Z0-9@/_-]+)['"]/g,
        (_m, dep) => `from "/@modules/${dep}"`,
      );

      // 🧩 Track dependencies (relative imports)
      const importRegex = /from\s+['"](\.\/[^'"]+|\.{2}\/[^'"]+)['"]/g;
      let match;
      while ((match = importRegex.exec(code)) !== null) {
        const rel = match[1];
        const importer = path.relative(appRoot, resolvedFile);
        const importedFile = path.resolve(path.dirname(resolvedFile), rel);
        const depFile = (await resolveFile(importedFile)) ?? importedFile;
        if (!deps.has(depFile)) deps.set(depFile, new Set());
        deps.get(depFile)!.add(importer);
      }

      let loader: esbuild.Loader = 'js';
      if (ext === '.ts') loader = 'ts';
      else if (ext === '.tsx') loader = 'tsx';
      else if (ext === '.jsx') loader = 'jsx';

      const transformed = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        sourcefile: req.url,
        target: 'es2020',
        jsxFactory: 'React.createElement',
        jsxFragment: 'React.Fragment',
      });

      transformCache.set(resolvedFile, transformed.code);

      res.setHeader('Content-Type', 'application/javascript');
      res.end(transformed.code);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error serving /src file:', msg);
      res.writeHead(500);
      res.end(`// Error: ${msg}`);
    }
  });

  // 4️⃣ Serve index.html (inject React Refresh + HMR client + overlay)
  app.use(async (req, res, next) => {
    if (req.url === '/' || req.url === '/index.html') {
      if (!fs.existsSync(indexHtml)) {
        res.writeHead(404);
        res.end('index.html not found');
        return;
      }

      let html = await fs.readFile(indexHtml, 'utf8');
      html = html.replace(
        '</body>',
        `
        <script>
          // 🧩 Lightweight Error Overlay
          (() => {
            const style = document.createElement('style');
            style.textContent = \`
              .rc-overlay {
                position: fixed;
                top: 0; left: 0;
                width: 100vw; height: 100vh;
                background: rgba(0, 0, 0, 0.92);
                color: #ff5555;
                font-family: monospace;
                padding: 2rem;
                overflow: auto;
                z-index: 999999;
                white-space: pre-wrap;
              }
              .rc-overlay h2 {
                color: #ff7575;
                font-size: 1.2rem;
                margin-bottom: 1rem;
              }
            \`;
            document.head.appendChild(style);

            window.showErrorOverlay = (err) => {
              window.clearErrorOverlay?.();
              const overlay = document.createElement('div');
              overlay.className = 'rc-overlay';
              overlay.innerHTML = '<h2>🚨 React Client Error</h2>' + 
                (err.message || err.error || err) + '\\n\\n' + (err.stack || '');
              document.body.appendChild(overlay);
              window.__reactClientOverlay = overlay;
            };

            window.clearErrorOverlay = () => {
              const overlay = window.__reactClientOverlay;
              if (overlay) overlay.remove();
              window.__reactClientOverlay = null;
            };
          })();
        </script>

        <script type="module">
          import "/@react-refresh";
          const ws = new WebSocket("ws://" + location.host);
          ws.onmessage = async (e) => {
            const msg = JSON.parse(e.data);
            if (msg.type === "error") {
              console.error(msg);
              return window.showErrorOverlay?.(msg);
            }
            if (msg.type === "update") {
              try {
                await import(msg.path + "?t=" + Date.now());
                window.clearErrorOverlay?.();
                window.$RefreshRuntime?.performReactRefresh?.();
              } catch (err) {
                window.showErrorOverlay?.(err);
              }
            }
            if (msg.type === "reload") location.reload();
          };
        </script>
        </body>`,
      );

      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    } else next();
  });

  // 🔁 HMR with dependency graph
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (data: HMRMessage) => {
    const json = JSON.stringify(data);
    wss.clients.forEach((c) => c.readyState === 1 && c.send(json));
  };

  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', async (file) => {
    console.log(`🔄 File changed: ${file}`);

    transformCache.delete(file);
    broadcast({ type: 'update', path: '/' + path.relative(appRoot, file).replace(/\\/g, '/') });

    // Propagate updates to dependents
    const visited = new Set<string>();
    const queue = [file];
    while (queue.length > 0) {
      const dep = queue.pop()!;
      const importers = deps.get(dep);
      if (!importers) continue;

      for (const importer of importers) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        console.log(chalk.yellow(`↪️  Updating importer: ${importer}`));
        transformCache.delete(path.join(appRoot, importer));
        broadcast({ type: 'update', path: '/' + importer.replace(/\\/g, '/') });
        queue.push(path.join(appRoot, importer));
      }
    }
  });

  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.cyan.bold('\n🚀 React Client Dev Server'));
    console.log(chalk.gray('───────────────────────────────'));
    console.log(chalk.green(`⚡ Running at: ${url}`));
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', async () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    server.close();
    process.exit(0);
  });
}
