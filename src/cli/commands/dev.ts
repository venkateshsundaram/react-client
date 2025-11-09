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

// 🧠 Browser polyfills for Node built-ins
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

// List of NPM packages required for polyfills
const POLYFILL_PACKAGES = [
  'buffer',
  'process',
  'path-browserify',
  'browserify-fs',
  'os-browserify',
  'stream-browserify',
  'util',
  'url',
  'assert',
  'crypto-browserify',
  'events',
  'constants-browserify',
  'querystring-es3',
  'browserify-zlib',
];

export default async function dev() {
  const root = process.cwd();
  const userConfig = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port || 5173;
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  await fs.ensureDir(cacheDir);

  // Detect entry file
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'];
  const entry = possibleEntries.map((p) => path.join(appRoot, p)).find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ No entry found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }
  const indexHtml = path.join(appRoot, 'index.html');

  // Detect available port
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

  // 🧩 Auto-install react-refresh
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

  // 🧩 Auto-install missing polyfill packages
  const missingPolyfills = POLYFILL_PACKAGES.filter((pkg) => {
    try {
      require.resolve(pkg, { paths: [appRoot] });
      return false;
    } catch {
      return true;
    }
  });

  if (missingPolyfills.length > 0) {
    console.log(chalk.yellow('⚙️ Installing missing polyfill packages...'));
    console.log(chalk.gray('📦 ' + missingPolyfills.join(', ')));
    try {
      execSync(`npm install ${missingPolyfills.join(' ')} --no-audit --no-fund --silent`, {
        cwd: appRoot,
        stdio: 'inherit',
      });
      console.log(chalk.green('✅ Polyfills installed successfully.'));
    } catch (err) {
      console.error(chalk.red('❌ Failed to install polyfills automatically.'));
      console.error(err);
      process.exit(1);
    }
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
  const transformCache = new Map<string, string>();

  // 🧱 Polyfilled module builder
  async function buildModuleWithSafeWrapper(id: string): Promise<string> {
    const cacheFile = path.join(cacheDir, id.replace(/\//g, '_') + '.js');
    if (await fs.pathExists(cacheFile)) return fs.readFile(cacheFile, 'utf8');

    // 🧠 Polyfill detection
    const polyId = NODE_POLYFILLS[id];
    if (polyId) {
      console.log(chalk.gray(`🧩 Using polyfill for ${id}: ${polyId}`));
      const result = await esbuild.build({
        entryPoints: [require.resolve(polyId, { paths: [appRoot] })],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
        write: false,
      });
      const polyCode = result.outputFiles[0].text;
      await fs.writeFile(cacheFile, polyCode, 'utf8');
      return polyCode;
    }

    // 🧱 Normal dependency
    let entryPath: string | null = null;
    try {
      entryPath = require.resolve(id, { paths: [appRoot] });
    } catch {
      const base = id.split('/')[0];
      try {
        entryPath = require.resolve(base, { paths: [appRoot] });
      } catch {
        entryPath = null;
      }
    }

    if (!entryPath) throw new Error(`Module ${id} not found (resolve failed)`);

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2020',
      write: false,
    });

    const originalCode = result.outputFiles[0].text;
    const isSubpath = id.includes('/');
    let finalCode = originalCode;

    if (isSubpath) {
      const base = id.split('/')[0];
      finalCode += `
        // --- react-client auto wrapper for subpath: ${id}
        import * as __base from '/@modules/${base}';
        export const __rc_dynamic = __base;
        export default __base.default || __base;
      `;
    }

    await fs.writeFile(cacheFile, finalCode, 'utf8');
    return finalCode;
  }

  // --- /@modules/
  app.use('/@modules/', async (req, res, next) => {
    const id = req.url?.replace(/^\/(@modules\/)?/, '');
    if (!id) return next();
    try {
      const code = await buildModuleWithSafeWrapper(id);
      res.setHeader('Content-Type', 'application/javascript');
      res.end(code);
    } catch (err) {
      const e = err as Error;
      console.error(chalk.red(`❌ Failed to load module ${id}: ${e.message}`));
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${e.message}`);
    }
  });

  // --- Universal transform for all project files
  app.use(async (req, res, next) => {
    const urlPath = decodeURIComponent(req.url!.split('?')[0]);
    if (urlPath.includes('node_modules')) return next();

    let filePath = path.join(appRoot, urlPath);
    const possibleExts = ['', '.tsx', '.ts', '.jsx', '.js', '.css'];
    for (const ext of possibleExts) {
      if (await fs.pathExists(filePath + ext)) {
        filePath += ext;
        break;
      }
    }

    if (!(await fs.pathExists(filePath))) return next();

    try {
      let code = await fs.readFile(filePath, 'utf8');

      // Rewrite bare imports
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_m, dep) => `import("/@modules/${dep}")`,
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

  // --- index.html + overlay + HMR
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
              position: fixed; inset: 0; background: rgba(0,0,0,0.9);
              color: #ff5555; font-family: monospace;
              padding: 2rem; overflow:auto; z-index: 999999;
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

  chokidar.watch(appRoot, { ignoreInitial: true }).on('change', async (file) => {
    if (file.includes('node_modules') || file.includes('.react-client')) return;
    console.log(chalk.yellow(`🔄 Changed: ${file}`));
    transformCache.delete(file);
    for (const p of plugins)
      await p.onHotUpdate?.(file, { broadcast: (msg: HMRMessage) => broadcaster.broadcast(msg) });
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
    if (port !== defaultPort)
      console.log(chalk.yellow(`⚠️ Using alternate port (default ${defaultPort} occupied)`));
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    broadcaster.close();
    process.exit(0);
  });
}
