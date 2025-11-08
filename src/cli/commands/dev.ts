import esbuild from 'esbuild';
import connect from 'connect';
import http from 'http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
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

  const entry = path.join(appRoot, 'src', 'main.tsx');
  const indexHtml = path.join(appRoot, 'index.html');

  if (!fs.existsSync(entry)) {
    console.error(chalk.red('❌ Entry not found: src/main.tsx'));
    process.exit(1);
  }

  await fs.ensureDir(outDir);

  // 🧠 Detect open port
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

  // 🏗️ esbuild context
  const ctx = await esbuild.context({
    entryPoints: [entry],
    bundle: true,
    sourcemap: true,
    outdir: outDir,
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.jsx': 'jsx' },
  });

  await ctx.watch();

  // 🌐 connect server
  const app = connect();

  // 🛡 Security headers
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  // 1️⃣ Serve react-refresh runtime with browser-safe shim
  app.use('/@react-refresh', async (_req, res) => {
    const runtime = await fs.readFile(reactRefreshRuntime, 'utf8');
    const shim = `
      // React Refresh browser shims
      window.process = window.process || { env: { NODE_ENV: 'development' } };
      window.module = { exports: {} };
      window.global = window; // ensure global scope for refresh
    `;
    res.setHeader('Content-Type', 'application/javascript');
    res.end(shim + '\n' + runtime);
  });

  // 2️⃣ Serve PrismJS (for code frame overlay)
  app.use('/@prismjs', async (_req, res) => {
    const prismPath = require.resolve('prismjs/prism.js');
    const css = await fs.readFile(require.resolve('prismjs/themes/prism-tomorrow.css'), 'utf8');
    const js = await fs.readFile(prismPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript');
    res.end(`
      (function(){
        const style = document.createElement('style');
        style.textContent = \`${css}\`;
        document.head.appendChild(style);
        ${js}
      })();
    `);
  });

  // 3️⃣ Source map resolver (for overlay stack trace)
  app.use('/@source-map', async (req, res) => {
    const url = new URL(req.url ?? '', `http://localhost:${port}`);
    const file = url.searchParams.get('file');
    const line = Number(url.searchParams.get('line'));
    const column = Number(url.searchParams.get('column'));
    if (!file) {
      res.writeHead(400);
      res.end('Missing ?file parameter');
      return;
    }

    const mapPath = path.join(outDir, file + '.map');
    if (!fs.existsSync(mapPath)) {
      res.writeHead(404);
      res.end('Map not found');
      return;
    }

    try {
      const mapJson = JSON.parse(await fs.readFile(mapPath, 'utf8'));
      const traceMap = new TraceMap(mapJson);
      const pos = originalPositionFor(traceMap, { line, column });
      if (!pos.source) {
        res.writeHead(404);
        res.end('Source not found');
        return;
      }

      const absSource = path.resolve(outDir, '../', pos.source);
      let snippet = '';
      if (await fs.pathExists(absSource)) {
        const lines = (await fs.readFile(absSource, 'utf8')).split('\n');
        const start = Math.max((pos.line || 1) - 3, 0);
        const end = Math.min(lines.length, (pos.line || 1) + 2);
        snippet = lines
          .slice(start, end)
          .map(
            (l, i) =>
              `<span class="line-number">${start + i + 1}</span> ${l
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')}`,
          )
          .join('\\n');
      }

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...pos, snippet }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
    }
  });

  // 4️⃣ Serve HTML and inject overlay + HMR
  app.use(async (req, res, next) => {
    if (req.url === '/' || req.url === '/index.html') {
      if (!fs.existsSync(indexHtml)) {
        res.writeHead(404);
        res.end('index.html not found');
        return;
      }

      let html = await fs.readFile(indexHtml, 'utf8');

      // Ensure main entry reference
      html = html.replace(/<script[^>]*src="\/bundle\.js"[^>]*><\/script>/, '');
      html = html.replace(
        '</body>',
        `
        <script type="module" src="/main.js"></script>
        <script type="module">
          import "/@react-refresh";
          import "/@prismjs";
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

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  const broadcast = (data: HMRMessage) => {
    const json = JSON.stringify(data);
    wss.clients.forEach((c) => c.readyState === 1 && c.send(json));
  };

  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', async (file) => {
    try {
      console.log(`🔄 Rebuilding: ${file}`);
      await ctx.rebuild();
      broadcast({ type: 'update', path: '/' + path.relative(appRoot, file).replace(/\\/g, '/') });
    } catch (err: unknown) {
      if (err instanceof Error) {
        broadcast({ type: 'error', message: err.message, stack: err.stack });
      } else {
        broadcast({ type: 'error', message: String(err) });
      }
    }
  });

  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.green(`\n⚡ Dev Server running at ${url}`));
    if (port !== defaultPort)
      console.log(chalk.yellow(`⚠️ Using alternate port (default ${defaultPort} was occupied).`));
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', async () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    await ctx.dispose();
    server.close();
    process.exit(0);
  });
}
