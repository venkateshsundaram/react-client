/**
 * 🚀 React Client Dev Server — Final Version
 * ------------------------------------------
 * ✅ Local overlay-runtime.js (Prism + stack mapping)
 * ✅ Dynamic /@runtime/overlay-runtime.js alias
 * ✅ Automatic HTML injection for overlay + HMR
 * ✅ Prebundle cache (.react-client/deps)
 * ✅ CSS HMR, relative & bare import handling
 * ✅ Favicon & public assets serving
 */

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
import zlib from 'zlib';
import crypto from 'crypto';
import { loadReactClientConfig } from '../../utils/loadConfig';
import { BroadcastManager } from '../../server/broadcastManager';
import type { ReactClientPlugin } from '../../types/plugin';

const computeHash = (content: string | Buffer): string =>
  crypto.createHash('sha1').update(content).digest('hex');

const getMimeType = (file: string): string => {
  const ext = path.extname(file).toLowerCase();
  const mime: Record<string, string> = {
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
  };
  return mime[ext] || 'application/octet-stream';
};

export default async function dev(): Promise<void> {
  const root = process.cwd();
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  const pkgFile = path.join(appRoot, 'package.json');
  const indexHtml = path.join(appRoot, 'index.html');
  await fs.ensureDir(cacheDir);

  // ✅ Detect entry
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  // ✅ Detect free port
  const port = await detectPort(defaultPort);
  if (port !== defaultPort) {
    const res = await prompts({
      type: 'confirm',
      name: 'useNewPort',
      message: `Port ${defaultPort} is occupied. Use ${port} instead?`,
      initial: true,
    });
    if (!res.useNewPort) process.exit(0);
  }

  // ✅ Ensure react-refresh
  try {
    require.resolve('react-refresh/runtime');
  } catch {
    console.log(chalk.yellow('Installing react-refresh...'));
    execSync('npm i react-refresh --silent', { cwd: root, stdio: 'inherit' });
  }

  // ✅ Core + user plugins
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

  const app = connect();
  const server = http.createServer(app);
  const broadcaster = new BroadcastManager(server);
  const transformCache = new Map<string, string>();

  // 🧱 Persistent prebundle cache
  async function prebundleDeps(): Promise<void> {
    if (!(await fs.pathExists(pkgFile))) return;
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    if (!deps.length) return;

    const hash = computeHash(JSON.stringify(deps));
    const metaFile = path.join(cacheDir, '_meta.json');
    let prevHash: string | null = null;
    if (await fs.pathExists(metaFile)) prevHash = (await fs.readJSON(metaFile)).hash;
    if (prevHash === hash) return;

    console.log(chalk.cyan('📦 Rebuilding prebundle cache...'));
    await Promise.all(
      deps.map(async (dep) => {
        try {
          const entryPath = require.resolve(dep, { paths: [appRoot] });
          const outFile = path.join(cacheDir, dep + '.js');
          await esbuild.build({
            entryPoints: [entryPath],
            bundle: true,
            platform: 'browser',
            format: 'esm',
            target: 'es2020',
            outfile: outFile,
            write: true,
          });
          const content = await fs.readFile(outFile);
          await fs.writeFile(outFile + '.gz', zlib.gzipSync(content));
          await fs.writeFile(outFile + '.br', zlib.brotliCompressSync(content));
          console.log(chalk.green(`✅ Cached ${dep}`));
        } catch (e) {
          const err = e as Error;
          console.warn(chalk.yellow(`⚠️ Skipped ${dep}: ${err.message}`));
        }
      }),
    );
    await fs.writeJSON(metaFile, { hash });
  }
  await prebundleDeps();
  chokidar.watch(pkgFile).on('change', prebundleDeps);

  // 🧩 Serve local overlay runtime
  app.use('/@runtime/overlay-runtime.js', async (req, res) => {
    const overlayPath = path.join(appRoot, 'src/runtime/overlay-runtime.js');

    try {
      if (!(await fs.pathExists(overlayPath))) {
        res.writeHead(404);
        return res.end(`// Overlay runtime not found: ${overlayPath}`);
      }

      let code = await fs.readFile(overlayPath, 'utf8');

      // Transform bare imports → /@modules/*
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_m, dep) => `import("/@modules/${dep}")`,
        );

      const result = await esbuild.transform(code, {
        loader: 'js',
        sourcemap: 'inline',
        target: 'es2020',
      });

      res.setHeader('Content-Type', 'application/javascript');
      res.end(result.code);
    } catch (err) {
      const e = err as Error;
      console.error(chalk.red(`❌ Failed to load overlay runtime: ${e.message}`));
      res.writeHead(500);
      res.end(`// Failed to load overlay runtime: ${e.message}`);
    }
  });

  // 🧠 Serve /@modules/
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/(@modules\/)?/, '');
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

      const code = result.outputFiles[0].text;
      await fs.writeFile(cacheFile, code, 'utf8');
      res.setHeader('Content-Type', 'application/javascript');
      res.end(code);
    } catch (e) {
      const err = e as Error;
      console.error(chalk.red(`❌ Failed to load module ${id}: ${err.message}`));
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${err.message}`);
    }
  });

  // 🧩 Serve /src/ and .css files dynamically
  app.use(async (req, res, next) => {
    if (!req.url || (!req.url.startsWith('/src/') && !req.url.endsWith('.css'))) return next();

    const rawPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(appRoot, rawPath);
    const possibleExts = ['', '.tsx', '.ts', '.jsx', '.js'];
    let resolvedPath: string | null = null;

    for (const ext of possibleExts) {
      const candidate = filePath + ext;
      if (await fs.pathExists(candidate)) {
        resolvedPath = candidate;
        break;
      }
    }

    if (!resolvedPath) {
      res.writeHead(404);
      return res.end(`// File not found: ${filePath}`);
    }

    try {
      let code = await fs.readFile(resolvedPath, 'utf8');

      // Rewrite bare imports → /@modules/*
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_m, dep) => `import("/@modules/${dep}")`,
        );

      for (const p of plugins) if (p.onTransform) code = await p.onTransform(code, resolvedPath);

      const ext = path.extname(resolvedPath);
      let loader: esbuild.Loader = 'js';
      if (ext === '.ts') loader = 'ts';
      else if (ext === '.tsx') loader = 'tsx';
      else if (ext === '.jsx') loader = 'jsx';

      const result = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        target: 'es2020',
      });

      res.setHeader('Content-Type', 'application/javascript');
      res.end(result.code);
    } catch (err) {
      const e = err as Error;
      console.error(chalk.red(`⚠️ Transform failed: ${e.message}`));
      res.writeHead(500);
      res.end(`// Error: ${e.message}`);
    }
  });

  // 🖼️ Serve static assets (favicon + public)
  app.use(async (req, res, next) => {
    if (!req.url) return next();
    const publicDir = path.join(appRoot, 'public');
    const targetFile = path.join(publicDir, decodeURIComponent(req.url.split('?')[0]));
    if (!(await fs.pathExists(targetFile))) return next();
    const stat = await fs.stat(targetFile);
    if (!stat.isFile()) return next();
    res.setHeader('Content-Type', getMimeType(targetFile));
    fs.createReadStream(targetFile).pipe(res);
  });

  // 🧩 Serve index.html + overlay + HMR
  app.use(async (req, res, next) => {
    if (req.url !== '/' && req.url !== '/index.html') return next();
    if (!(await fs.pathExists(indexHtml))) {
      res.writeHead(404);
      return res.end('index.html not found');
    }

    let html = await fs.readFile(indexHtml, 'utf8');
    html = html.replace(
      '</body>',
      `
      <script type="module" src="/@runtime/overlay-runtime.js"></script>
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

  // ♻️ Watchers
  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', (file) => {
    console.log(chalk.yellow(`🔄 Changed: ${file}`));
    transformCache.delete(file);
    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });

  chokidar
    .watch(path.join(appRoot, 'src/runtime/overlay-runtime.js'), { ignoreInitial: true })
    .on('change', () => {
      console.log(chalk.magenta('♻️ Overlay runtime updated — reloading browser...'));
      broadcaster.broadcast({ type: 'reload' });
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
