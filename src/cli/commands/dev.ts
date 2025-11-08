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

  // 🧩 Load user config
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const outDir = path.join(appRoot, userConfig.build?.outDir || '.react-client/dev');

  // ✅ Dynamically detect entry (main.tsx or main.jsx)
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));

  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  const indexHtml = path.join(appRoot, 'index.html');
  await fs.ensureDir(outDir);

  // ⚙️ Detect open port
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

  // 🏗️ Create esbuild context
  const ctx = await esbuild.context({
    entryPoints: [entry],
    bundle: true,
    sourcemap: true,
    outdir: outDir,
    define: { 'process.env.NODE_ENV': '"development"' },
    loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'jsx', '.jsx': 'jsx' },
    entryNames: '[name]',
    assetNames: 'assets/[name]',
  });

  await ctx.watch();

  console.log(chalk.gray('📦 Watching and building dev bundle...'));
  console.log(chalk.gray('   Output dir:'), chalk.blue(outDir));
  console.log(chalk.gray('   Entry file:'), chalk.yellow(entry));

  // 🌐 Connect server setup
  const app = connect();

  // 🛡 Security headers
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
  });

  // 🧠 In-memory cache for /@modules
  const moduleCache = new Map<string, string>();

  // 1️⃣ Serve react-refresh runtime with safe browser shim
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

  // 2️⃣ Bare module resolver with memory cache
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/@modules\//, '');
    if (!id) return next();

    if (moduleCache.has(id)) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(moduleCache.get(id));
      return;
    }

    try {
      const entryPath = require.resolve(id, { paths: [appRoot] });
      const out = await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
      });

      const code = out.outputFiles[0].text;
      moduleCache.set(id, code); // ✅ cache module
      res.setHeader('Content-Type', 'application/javascript');
      res.end(code);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to resolve module ${id}: ${msg}`));
      res.writeHead(500);
      res.end(`// Could not resolve module ${id}`);
    }
  });

  // 3️⃣ Serve /src/* files — on-the-fly transform + bare import rewrite
  app.use(async (req, res, next) => {
    if (!req.url || !req.url.startsWith('/src/')) return next();

    try {
      const filePath = path.join(appRoot, decodeURIComponent(req.url.split('?')[0]));
      if (!(await fs.pathExists(filePath))) return next();

      let code = await fs.readFile(filePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();

      // 🪄 Rewrite bare imports → /@modules/
      code = code.replace(
        /from\s+['"]([^'".\/][^'"]*)['"]/g,
        (_match, dep) => `from "/@modules/${dep}"`,
      );

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

      res.setHeader('Content-Type', 'application/javascript');
      res.end(transformed.code);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error serving /src file:', msg);
      res.writeHead(500);
      res.end(`// Error: ${msg}`);
    }
  });

  // 4️⃣ Serve index.html with injected refresh + HMR
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
    } else {
      const filePath = path.join(outDir, req.url || '');
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath);
        res.setHeader('Content-Type', 'application/javascript');
        res.end(content);
      } else next();
    }
  });

  // 🔁 HMR WebSocket server
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

  // 🟢 Start server
  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.cyan.bold(`\n🚀 React Client Dev Server`));
    console.log(chalk.gray('───────────────────────────────'));
    console.log(chalk.green(`⚡ Running at: ${url}`));
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', async () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    await ctx.dispose();
    server.close();
    process.exit(0);
  });
}
