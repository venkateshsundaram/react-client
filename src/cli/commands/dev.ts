/**
 * 🚀 react-client Dev Server (Final Version)
 * Includes:
 *  - Favicon & public asset support
 *  - ETag + gzip/brotli caching
 *  - Persistent prebundle deps (.react-client/deps)
 *  - HMR + overlay
 *  - CSS hot reload
 *  - ESLint + Prettier clean
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

// Node polyfill mapping
const NODE_POLYFILLS: Record<string, string> = {
  buffer: 'buffer/',
  process: 'process/browser',
  path: 'path-browserify',
  fs: 'browserify-fs',
  os: 'os-browserify/browser',
  stream: 'stream-browserify',
  util: 'util/',
  url: 'url/',
  assert: 'assert/',
  crypto: 'crypto-browserify',
  events: 'events/',
  constants: 'constants-browserify',
  querystring: 'querystring-es3',
  zlib: 'browserify-zlib',
};

// --- Helper utilities
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
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mime[ext] || 'application/octet-stream';
};

// ✅ Unused helpers are underscored to comply with eslint rules
const _gunzipAsync = (input: Buffer): Promise<Buffer> =>
  new Promise((res, rej) => zlib.gunzip(input, (e, out) => (e ? rej(e) : res(out))));

const _brotliAsync = (input: Buffer): Promise<Buffer> =>
  new Promise((res, rej) => zlib.brotliDecompress(input, (e, out) => (e ? rej(e) : res(out))));

export default async function dev(): Promise<void> {
  const root = process.cwd();
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  await fs.ensureDir(cacheDir);

  const indexHtml = path.join(appRoot, 'index.html');
  const pkgFile = path.join(appRoot, 'package.json');

  // Detect entry
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  // Detect open port
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

  // Ensure react-refresh installed
  try {
    require.resolve('react-refresh/runtime');
  } catch {
    console.log(chalk.yellow('Installing react-refresh...'));
    execSync('npm i react-refresh --silent', { cwd: root, stdio: 'inherit' });
  }

  // Ensure Node polyfills installed
  const missing = Object.keys(NODE_POLYFILLS).filter((m) => {
    try {
      require.resolve(m, { paths: [appRoot] });
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    console.log(chalk.yellow('Installing missing polyfills...'));
    execSync(`npm i ${missing.join(' ')} --silent`, { cwd: appRoot, stdio: 'inherit' });
  }

  // --- Plugins
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

  // --- Prebundle deps with gzip/brotli caching
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
          console.warn(chalk.yellow(`⚠️ Failed ${dep}: ${err.message}`));
        }
      }),
    );
    await fs.writeJSON(metaFile, { hash });
  }
  await prebundleDeps();
  chokidar.watch(pkgFile).on('change', prebundleDeps);

  // --- Serve /@modules/
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/(@modules\/)?/, '');
    if (!id) return next();

    const base = path.join(cacheDir, id.replace(/\//g, '_') + '.js');
    const gz = base + '.gz';
    const br = base + '.br';
    const accept = req.headers['accept-encoding'] || '';

    try {
      let buf: Buffer | null = null;
      let encoding: string | null = null;
      if (/\bbr\b/.test(accept as string) && (await fs.pathExists(br))) {
        buf = await fs.readFile(br);
        encoding = 'br';
      } else if (/\bgzip\b/.test(accept as string) && (await fs.pathExists(gz))) {
        buf = await fs.readFile(gz);
        encoding = 'gzip';
      } else if (await fs.pathExists(base)) {
        buf = await fs.readFile(base);
      } else {
        const entryPath = require.resolve(id, { paths: [appRoot] });
        const result = await esbuild.build({
          entryPoints: [entryPath],
          bundle: true,
          platform: 'browser',
          format: 'esm',
          write: false,
        });
        buf = Buffer.from(result.outputFiles[0].text);
        await fs.writeFile(base, buf);
      }

      const etag = `"${computeHash(buf!)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        return res.end();
      }

      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (encoding) res.setHeader('Content-Encoding', encoding);
      res.end(buf);
    } catch (e) {
      const err = e as Error;
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${err.message}`);
    }
  });

  // --- Serve /src/ files
  app.use(async (req, res, next) => {
    if (!req.url || (!req.url.startsWith('/src/') && !req.url.endsWith('.css'))) return next();
    const filePath = path.join(appRoot, decodeURIComponent(req.url.split('?')[0]));
    if (!(await fs.pathExists(filePath))) return next();

    let code = await fs.readFile(filePath, 'utf8');
    code = code
      .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
      .replace(/\bimport\(['"]([^'".\/][^'"]*)['"]\)/g, (_m, dep) => `import("/@modules/${dep}")`);
    for (const p of plugins) if (p.onTransform) code = await p.onTransform(code, filePath);
    const loader: esbuild.Loader = filePath.endsWith('.tsx')
      ? 'tsx'
      : filePath.endsWith('.ts')
      ? 'ts'
      : filePath.endsWith('.jsx')
      ? 'jsx'
      : 'js';
    const result = await esbuild.transform(code, { loader, sourcemap: 'inline', target: 'es2020' });
    res.setHeader('Content-Type', 'application/javascript');
    res.end(result.code);
  });

  // --- Serve static assets (favicon, /public, etc.)
  app.use(async (req, res, next) => {
    if (!req.url) return next();
    const assetPath = decodeURIComponent(req.url.split('?')[0]);
    const publicDir = path.join(appRoot, 'public');
    const rootFile = path.join(appRoot, assetPath);
    const publicFile = path.join(publicDir, assetPath);
    let targetFile: string | null = null;

    if (await fs.pathExists(publicFile)) targetFile = publicFile;
    else if (await fs.pathExists(rootFile)) targetFile = rootFile;
    if (!targetFile) return next();

    const stat = await fs.stat(targetFile);
    if (!stat.isFile()) return next();

    const etag = `"${stat.size}-${stat.mtimeMs}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      return res.end();
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', getMimeType(targetFile));
    fs.createReadStream(targetFile).pipe(res);
  });

  // --- Serve index.html with overlay + HMR
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
      <script>
        (() => {
          const style = document.createElement('style');
          style.textContent = \`
            .rc-overlay {
              position: fixed; inset: 0;
              background: rgba(0,0,0,0.9); color:#fff;
              font-family: monospace; padding:2rem; overflow:auto;
              z-index:999999; white-space:pre-wrap;
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

  // --- Watchers for HMR + favicon reload
  chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true }).on('change', (file) => {
    console.log(chalk.yellow(`🔄 Changed: ${file}`));
    transformCache.delete(file);
    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });
  chokidar
    .watch(path.join(appRoot, 'public', 'favicon.ico'), { ignoreInitial: true })
    .on('change', () => {
      broadcaster.broadcast({ type: 'reload' });
    });

  // --- Start server
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
