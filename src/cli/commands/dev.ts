/**
 * dev.ts — Vite-like dev server for react-client
 *
 * - prebundles deps into .react-client/deps
 * - serves /@modules/<dep>
 * - serves /src/* with esbuild transform & inline sourcemap
 * - /@source-map returns a snippet for overlay mapping
 * - HMR broadcast via BroadcastManager (ws)
 *
 * Keep this file linted & typed. Avoids manual react-dom/client hacks.
 */

import esbuild from 'esbuild';
import connect, { NextHandleFunction } from 'connect';
import http from 'http';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import open from 'open';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadReactClientConfig } from '../../utils/loadConfig';
import { BroadcastManager } from '../../server/broadcastManager';
import type { ReactClientPlugin, ReactClientUserConfig } from '../../types/plugin';

type HMRMessage = {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
};

export default async function dev(): Promise<void> {
  const root = process.cwd();
  const userConfig = (await loadReactClientConfig(root)) as ReactClientUserConfig;
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port ?? 2202;

  // cache dir for prebundled deps
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  await fs.ensureDir(cacheDir);

  // Detect entry (main.tsx / main.jsx)
  const possible = ['src/main.tsx', 'src/main.jsx'].map((p) => path.join(appRoot, p));
  const entry = possible.find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ Entry not found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }
  const indexHtml = path.join(appRoot, 'index.html');

  // Select port
  const availablePort = await detectPort(defaultPort);
  const port = availablePort;
  if (availablePort !== defaultPort) {
    const response = await prompts({
      type: 'confirm',
      name: 'useNewPort',
      message: `Port ${defaultPort} is occupied. Use ${availablePort} instead?`,
      initial: true,
    });
    if (!response.useNewPort) {
      console.log('🛑 Dev server cancelled.');
      process.exit(0);
    }
  }

  // Ensure react-refresh runtime available (used by many templates)
  try {
    require.resolve('react-refresh/runtime');
  } catch {
    console.warn(chalk.yellow('⚠️ react-refresh not found — installing react-refresh...'));
    execSync('npm install react-refresh --no-audit --no-fund --silent', {
      cwd: appRoot,
      stdio: 'inherit',
    });
  }

  // Plugin system (core + user)
  const corePlugins: ReactClientPlugin[] = [
    {
      name: 'css-hmr',
      async onTransform(code, id) {
        if (id.endsWith('.css')) {
          const escaped = JSON.stringify(code);
          return `
            const css = ${escaped};
            const style = document.createElement("style");
            style.textContent = css;
            document.head.appendChild(style);
            import.meta.hot?.accept();
          `;
        }
        return code;
      },
    },
  ];
  const userPlugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
  const plugins: ReactClientPlugin[] = [...corePlugins, ...userPlugins];

  // App + caches
  const app = connect();
  const transformCache = new Map<string, string>();

  // Helper: recursively analyze dependency graph for prebundling (bare imports)
  async function analyzeGraph(file: string, seen = new Set<string>()): Promise<Set<string>> {
    if (seen.has(file)) return seen;
    seen.add(file);
    try {
      const code = await fs.readFile(file, 'utf8');
      const matches = [
        ...code.matchAll(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g),
        ...code.matchAll(/\bimport\(['"]([^'".\/][^'"]*)['"]\)/g),
      ];
      for (const m of matches) {
        const dep = m[1];
        if (!dep || dep.startsWith('.') || dep.startsWith('/')) continue;
        try {
          const resolved = require.resolve(dep, { paths: [appRoot] });
          await analyzeGraph(resolved, seen);
        } catch {
          // bare dependency (node_modules) - track name
          seen.add(dep);
        }
      }
    } catch {
      // ignore unreadable files
    }
    return seen;
  }

  // Prebundle dependencies into cache dir (parallel)
  async function prebundleDeps(deps: Set<string>): Promise<void> {
    if (!deps.size) return;
    const existingFiles = await fs.readdir(cacheDir);
    const existing = new Set(existingFiles.map((f) => f.replace(/\.js$/, '')));
    const missing = [...deps].filter((d) => !existing.has(d));
    if (!missing.length) return;

    console.log(chalk.cyan('📦 Prebundling:'), missing.join(', '));
    await Promise.all(
      missing.map(async (dep) => {
        try {
          const entryPoint = require.resolve(dep, { paths: [appRoot] });
          const outFile = path.join(cacheDir, dep.replace(/\//g, '_') + '.js');
          await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            platform: 'browser',
            format: 'esm',
            outfile: outFile,
            write: true,
            target: ['es2020'],
          });
          console.log(chalk.green(`✅ Cached ${dep}`));
        } catch (err) {
          console.warn(chalk.yellow(`⚠️ Skipped ${dep}: ${(err as Error).message}`));
        }
      }),
    );
  }

  // Build initial prebundle graph from entry
  const depsSet = await analyzeGraph(entry);
  await prebundleDeps(depsSet);

  // Watch package.json for changes to re-prebundle
  const pkgPath = path.join(appRoot, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    chokidar.watch(pkgPath).on('change', async () => {
      console.log(chalk.yellow('📦 package.json changed — rebuilding prebundle...'));
      const newDeps = await analyzeGraph(entry);
      await prebundleDeps(newDeps);
    });
  }

  // --- Serve /@modules/<dep> (prebundled or on-demand esbuild bundle)
  app.use(async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/@modules/')) return next();

    const id = url.replace(/^\/@modules\//, '');
    if (!id) {
      res.writeHead(400);
      return res.end('// invalid module');
    }

    try {
      const cacheFile = path.join(cacheDir, id.replace(/[\\/]/g, '_') + '.js');
      if (await fs.pathExists(cacheFile)) {
        res.setHeader('Content-Type', 'application/javascript');
        return res.end(await fs.readFile(cacheFile, 'utf8'));
      }

      // 🧠 Handle subpath imports correctly (like react-dom/client)
      let entryFile: string | null = null;

      try {
        entryFile = require.resolve(id, { paths: [appRoot] });
      } catch {
        const parts = id.split('/');
        const pkgRoot = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        const subPath = parts.slice(pkgRoot.startsWith('@') ? 2 : 1).join('/');
        const pkgJsonPath = require.resolve(`${pkgRoot}/package.json`, { paths: [appRoot] });
        const pkgDir = path.dirname(pkgJsonPath);

        // Special case: react-dom/client
        if (pkgRoot === 'react-dom' && subPath === 'client') {
          entryFile = path.join(pkgDir, 'client.js');
        } else {
          const candidates = [
            path.join(pkgDir, subPath),
            path.join(pkgDir, subPath, 'index.js'),
            path.join(pkgDir, subPath + '.js'),
            path.join(pkgDir, subPath + '.mjs'),
          ];
          for (const f of candidates) {
            if (await fs.pathExists(f)) {
              entryFile = f;
              break;
            }
          }
        }
      }

      if (!entryFile) throw new Error(`Cannot resolve module: ${id}`);

      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        write: false,
        target: ['es2020'],
      });

      const output = result.outputFiles?.[0]?.text ?? '';
      await fs.writeFile(cacheFile, output, 'utf8');

      res.setHeader('Content-Type', 'application/javascript');
      res.end(output);
    } catch (err) {
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${(err as Error).message}`);
    }
  });

  app.use(async (req, res, next) => {
    if (req.url?.startsWith('/@prismjs')) {
      const prismPath = require.resolve('prismjs', { paths: [appRoot] });
      const code = await fs.readFile(prismPath, 'utf8');
      res.setHeader('Content-Type', 'application/javascript');
      return res.end(code);
    }
    next();
  });

  // --- Serve runtime overlay (local file) so overlay-runtime.js is loaded automatically
  // --- Serve runtime overlay (inline in dev server)
  const OVERLAY_RUNTIME = `
import "/@prismjs";

const overlayId = "__rc_error_overlay__";

const style = document.createElement("style");
style.textContent = \`
  #\${overlayId} {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.9);
    color: #fff;
    font-family: Menlo, Consolas, monospace;
    font-size: 14px;
    z-index: 999999;
    overflow: auto;
    padding: 24px;
    animation: fadeIn 0.2s ease-out;
  }
  @keyframes fadeIn { from {opacity: 0;} to {opacity: 1;} }
  #\${overlayId} h2 { color: #ff6b6b; margin-bottom: 16px; }
  #\${overlayId} pre { background: rgba(255,255,255,0.1); padding: 12px; border-radius: 6px; }
  #\${overlayId} a { color: #9cf; text-decoration: underline; }
  #\${overlayId} .frame { margin: 12px 0; }
  #\${overlayId} .frame-file { color: #ffa500; cursor: pointer; font-weight: bold; margin-bottom: 4px; }
  .line-number { opacity: 0.5; margin-right: 10px; }
\`;
document.head.appendChild(style);

async function mapStackFrame(frame) {
  const m = frame.match(/(\\/src\\/[^\s:]+):(\\d+):(\\d+)/);
  if (!m) return frame;
  const [, file, line, col] = m;
  const resp = await fetch(\`/@source-map?file=\${file}&line=\${line}&column=\${col}\`);
  if (!resp.ok) return frame;
  const pos = await resp.json();
  if (pos.source) {
    return {
      file: pos.source,
      line: pos.line,
      column: pos.column,
      snippet: pos.snippet || ""
    };
  }
  return frame;
}

async function renderOverlay(err) {
  const overlay =
    document.getElementById(overlayId) ||
    document.body.appendChild(Object.assign(document.createElement("div"), { id: overlayId }));
  overlay.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "🔥 " + (err.message || "Error");
  overlay.appendChild(title);

  const frames = (err.stack || "").split("\\n").filter(l => /src\\//.test(l));
  for (const frame of frames) {
    const mapped = await mapStackFrame(frame);
    if (typeof mapped === "string") continue;
    const frameEl = document.createElement("div");
    frameEl.className = "frame";

    const link = document.createElement("div");
    link.className = "frame-file";
    link.textContent = \`\${mapped.file}:\${mapped.line}:\${mapped.column}\`;
    link.onclick = () =>
      window.open("vscode://file/" + location.origin.replace("http://", "") + mapped.file + ":" + mapped.line);
    frameEl.appendChild(link);

    if (mapped.snippet) {
      const pre = document.createElement("pre");
      pre.classList.add("language-jsx");
      pre.innerHTML = Prism.highlight(mapped.snippet, Prism.languages.jsx, "jsx");
      frameEl.appendChild(pre);
    }

    overlay.appendChild(frameEl);
  }
}

window.showErrorOverlay = (err) => renderOverlay(err);
window.clearErrorOverlay = () => document.getElementById(overlayId)?.remove();
`;

  app.use(async (req, res, next) => {
    if (req.url === '/@runtime/overlay') {
      res.setHeader('Content-Type', 'application/javascript');
      return res.end(OVERLAY_RUNTIME);
    }
    next();
  });

  // --- minimal /@source-map: return snippet around requested line of original source file
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/@source-map')) return next();
    // expected query: ?file=/src/xyz.tsx&line=12&column=3
    try {
      const full = req.url ?? '';
      const parsed = new URL(full, `http://localhost:${port}`);
      const file = parsed.searchParams.get('file') ?? '';
      const lineStr = parsed.searchParams.get('line') ?? '0';
      const lineNum = Number(lineStr) || 0;
      if (!file) {
        res.writeHead(400);
        return res.end('{}');
      }
      const filePath = path.join(appRoot, file.startsWith('/') ? file.slice(1) : file);
      if (!(await fs.pathExists(filePath))) {
        res.writeHead(404);
        return res.end('{}');
      }
      const src = await fs.readFile(filePath, 'utf8');
      const lines = src.split(/\r?\n/);
      const start = Math.max(0, lineNum - 3 - 1);
      const end = Math.min(lines.length, lineNum + 2);
      const snippet = lines
        .slice(start, end)
        .map((l, i) => {
          const ln = start + i + 1;
          return `<span class="line-number">${ln}</span> ${l
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}`;
        })
        .join('\n');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ source: file, line: lineNum, column: 0, snippet }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }) as NextHandleFunction);

  // --- Serve /src/* files (on-the-fly transform + bare import rewrite)
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/src/') && !url.endsWith('.css')) return next();

    const raw = decodeURIComponent((req.url ?? '').split('?')[0]);
    const filePath = path.join(appRoot, raw.replace(/^\//, ''));
    // Try file extensions if not exact file
    const exts = ['', '.tsx', '.ts', '.jsx', '.js', '.css'];
    let found = '';
    for (const ext of exts) {
      if (await fs.pathExists(filePath + ext)) {
        found = filePath + ext;
        break;
      }
    }
    if (!found) return next();

    try {
      let code = await fs.readFile(found, 'utf8');

      // rewrite bare imports -> /@modules/<dep>
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_m, dep) => `import("/@modules/${dep}")`,
        );

      // run plugin transforms
      for (const p of plugins) {
        if (p.onTransform) {
          // plugin may return transformed code
          // keep typed as string
          // eslint-disable-next-line no-await-in-loop
          const out = await p.onTransform(code, found);
          if (typeof out === 'string') code = out;
        }
      }

      // choose loader by extension
      const ext = path.extname(found).toLowerCase();
      const loader: esbuild.Loader =
        ext === '.ts' ? 'ts' : ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'js';

      const result = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        target: ['es2020'],
      });

      transformCache.set(found, result.code);
      res.setHeader('Content-Type', 'application/javascript');
      res.end(result.code);
    } catch (err) {
      const e = err as Error;
      res.writeHead(500);
      res.end(`// transform error: ${e.message}`);
    }
  }) as NextHandleFunction);

  // --- Serve index.html with overlay + HMR client injection
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (url !== '/' && url !== '/index.html') return next();
    if (!(await fs.pathExists(indexHtml))) {
      res.writeHead(404);
      return res.end('index.html not found');
    }
    try {
      let html = await fs.readFile(indexHtml, 'utf8');
      // inject overlay runtime and HMR client if not already present
      if (!html.includes('/@runtime/overlay')) {
        html = html.replace(
          '</body>',
          `\n<script type="module" src="/@runtime/overlay"></script>\n<script type="module">
  const ws = new WebSocket("ws://" + location.host);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "reload") location.reload();
    if (msg.type === "error") window.showErrorOverlay?.(msg);
    if (msg.type === "update") {
      window.clearErrorOverlay?.();
      import(msg.path + "?t=" + Date.now());
    }
  };
</script>\n</body>`,
        );
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`// html read error: ${(err as Error).message}`);
    }
  }) as NextHandleFunction);

  // --- HMR WebSocket server
  const server = http.createServer(app);
  const broadcaster = new BroadcastManager(server);

  // Watch files and trigger plugin onHotUpdate + broadcast HMR message
  const watcher = chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true });
  watcher.on('change', async (file) => {
    transformCache.delete(file);
    // plugin hook onHotUpdate optionally
    for (const p of plugins) {
      if (p.onHotUpdate) {
        try {
          // allow plugin to broadcast via a simple function
          // plugin gets { broadcast }
          // plugin signature: onHotUpdate(file, { broadcast })
          // eslint-disable-next-line no-await-in-loop
          await p.onHotUpdate(file, {
            broadcast: (msg: HMRMessage) => {
              broadcaster.broadcast(msg);
            },
          } as unknown as { broadcast: (m: HMRMessage) => void });
        } catch (err) {
          // plugin errors shouldn't crash server
          // eslint-disable-next-line no-console
          console.warn('plugin onHotUpdate error:', (err as Error).message);
        }
      }
    }

    // default: broadcast update for changed file
    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });

  // start server
  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.cyan.bold('\n🚀 React Client Dev Server'));
    console.log(chalk.green(`⚡ Running at: ${url}`));
    if (userConfig.server?.open !== false) {
      // open default browser
      try {
        await open(url);
      } catch {
        // ignore open errors
      }
    }
  });

  // graceful shutdown
  process.on('SIGINT', async () => {
    console.log(chalk.red('\n🛑 Shutting down...'));
    watcher.close();
    broadcaster.close();
    server.close();
    process.exit(0);
  });
}
