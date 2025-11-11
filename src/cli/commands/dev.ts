// src/cli/commands/dev.ts
/**
 * dev.ts — Vite-like dev server for react-client (updated)
 *
 * - resolves package export fields & subpaths (resolveModuleEntry)
 * - prebundles deps into .react-client/deps
 * - serves /@modules/<dep> (prebundled or on-demand esbuild bundle)
 * - serves /src/* with esbuild transform + inline sourcemap
 * - serves local overlay runtime at /@runtime/overlay if src/runtime/overlay-runtime.js exists
 * - /@source-map returns a snippet for overlay mapping
 * - HMR broadcast via BroadcastManager (ws)
 * - plugin system: onTransform, onHotUpdate, onServe, onServerStart
 */

import esbuild from 'esbuild';
import connect, { type NextHandleFunction } from 'connect';
import http from 'http';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import open from 'open';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { loadReactClientConfig } from '../../utils/loadConfig.js';
import { BroadcastManager, type BroadcastMessage } from '../../server/broadcastManager.js';
import type {
  ReactClientPlugin,
  ReactClientUserConfig,
  PluginHotUpdateContext,
  DevServerContext,
} from '../../types/plugin';

type HMRMessage = BroadcastMessage & {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
};

const RUNTIME_OVERLAY_ROUTE = '/@runtime/overlay';

function jsContentType(): string {
  return 'application/javascript; charset=utf-8';
}

/**
 * Resolve a package entry robustly:
 * - try require.resolve(id)
 * - try package.json exports field + subpath resolution
 * - fallback to common fields (module/main/browser)
 */
async function resolveModuleEntry(id: string, root: string): Promise<string> {
  // quick path
  try {
    return require.resolve(id, { paths: [root] });
  } catch {
    // continue
  }

  // split package root and possible subpath
  const parts = id.split('/');
  const pkgRoot = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subPath = parts.slice(pkgRoot.startsWith('@') ? 2 : 1).join('/');

  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${pkgRoot}/package.json`, { paths: [root] });
  } catch {
    throw new Error(`Package not found: ${pkgRoot}`);
  }

  const pkgDir = path.dirname(pkgJsonPath);
  let pkgJson: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    pkgJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  // handle "exports"
  if (pkgJson.exports) {
    const exportsField = pkgJson.exports as unknown;

    if (typeof exportsField === 'string') {
      if (!subPath) {
        const candidate = path.resolve(pkgDir, exportsField);
        if (await fs.pathExists(candidate)) return candidate;
      }
    } else if (exportsField && typeof exportsField === 'object') {
      const exportsMap = exportsField as Record<string, unknown>;
      const candidates: string[] = [];
      if (subPath) {
        candidates.push(`./${subPath}`, `./${subPath}.js`, `./${subPath}.mjs`);
      }
      candidates.push('.', './index.js', './index.mjs');

      for (const key of candidates) {
        if (!(key in exportsMap)) continue;
        const entry = exportsMap[key];
        let target: string | undefined;
        if (typeof entry === 'string') target = entry;
        else if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          if (typeof obj.import === 'string') target = obj.import;
          else if (typeof obj.default === 'string') target = obj.default;
          else {
            for (const k of Object.keys(obj)) {
              if (typeof obj[k] === 'string') {
                target = obj[k] as string;
                break;
              }
            }
          }
        }
        if (!target) continue;
        const normalized = target.replace(/^\.\//, '');
        const abs = path.isAbsolute(normalized) ? normalized : path.resolve(pkgDir, normalized);
        if (await fs.pathExists(abs)) return abs;
      }
    }
  }

  // try package subpath resolution
  if (subPath) {
    try {
      return require.resolve(`${pkgRoot}/${subPath}`, { paths: [root] });
    } catch {
      // check common candidates under package dir
      const cand = [
        path.join(pkgDir, subPath),
        path.join(pkgDir, `${subPath}.js`),
        path.join(pkgDir, `${subPath}.mjs`),
        path.join(pkgDir, subPath, 'index.js'),
        path.join(pkgDir, subPath, 'index.mjs'),
      ];
      for (const c of cand) {
        if (await fs.pathExists(c)) return c;
      }
    }
  }

  // check common package fields
  const maybeFields: (string | undefined)[] = [
    typeof pkgJson.module === 'string' ? (pkgJson.module as string) : undefined,
    typeof pkgJson.browser === 'string' ? (pkgJson.browser as string) : undefined,
    typeof pkgJson.main === 'string' ? (pkgJson.main as string) : undefined,
  ];
  for (const f of maybeFields) {
    if (!f) continue;
    const abs = path.isAbsolute(f) ? f : path.resolve(pkgDir, f);
    if (await fs.pathExists(abs)) return abs;
  }

  throw new Error(`Could not resolve module entry for "${id}"`);
}

function normalizeCacheKey(id: string): string {
  return id.replace(/[\\/]/g, '_');
}

export default async function dev(): Promise<void> {
  const root = process.cwd();
  const userConfig = (await loadReactClientConfig(root)) as ReactClientUserConfig;
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = userConfig.server?.port ?? 2202;
  const cacheDir = path.join(appRoot, '.react-client', 'deps');

  await fs.ensureDir(cacheDir);

  // Detect entry
  const possibleEntries = ['src/main.tsx', 'src/main.jsx'].map((p) => path.join(appRoot, p));
  const entry = possibleEntries.find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ Entry not found: src/main.tsx or src/main.jsx'));
    process.exit(1);
  }

  const indexHtml = path.join(appRoot, 'index.html');

  // Port selection
  const availablePort = await detectPort(defaultPort);
  const port = availablePort;
  if (availablePort !== defaultPort) {
    const res = await prompts({
      type: 'confirm',
      name: 'useNewPort',
      message: `Port ${defaultPort} is occupied. Use ${availablePort} instead?`,
      initial: true,
    });
    if (!res.useNewPort) process.exit(0);
  }

  // ensure react-refresh runtime present (templates often import it)
  try {
    require.resolve('react-refresh/runtime');
  } catch {
    console.warn(chalk.yellow('⚠️ react-refresh not found — installing react-refresh...'));
    try {
      execSync('npm install react-refresh --no-audit --no-fund --silent', {
        cwd: appRoot,
        stdio: 'inherit',
      });
    } catch {
      console.warn(chalk.yellow('⚠️ auto-install failed — please install react-refresh manually.'));
    }
  }

  // Core plugin(s)
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
            if (import.meta.hot) import.meta.hot.accept();
          `;
        }
        return code;
      },
    },
  ];
  const userPlugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
  const plugins: ReactClientPlugin[] = [...corePlugins, ...userPlugins];

  // app + caches
  const app = connect();
  const transformCache = new Map<string, string>();

  // dependency analyzer for prebundling
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
          seen.add(dep);
        }
      }
    } catch {
      // ignore
    }
    return seen;
  }

  async function prebundleDeps(deps: Set<string>): Promise<void> {
    if (!deps.size) return;
    const cached = new Set((await fs.readdir(cacheDir)).map((f) => f.replace(/\.js$/, '')));
    const missing = [...deps].filter((d) => !cached.has(d.replace(/\//g, '_')));
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

  // initial prebundle
  const depsSet = await analyzeGraph(entry);
  await prebundleDeps(depsSet);

  // re-prebundle on package.json change
  const pkgPath = path.join(appRoot, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    chokidar.watch(pkgPath).on('change', async () => {
      console.log(chalk.yellow('📦 package.json changed — rebuilding prebundle...'));
      const newDeps = await analyzeGraph(entry);
      await prebundleDeps(newDeps);
    });
  }

  // --- Serve /@modules/
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/@modules/')) return next();
    const id = url.replace(/^\/@modules\//, '');
    if (!id) {
      res.writeHead(400);
      return res.end('// invalid module');
    }

    try {
      const cacheFile = path.join(cacheDir, normalizeCacheKey(id) + '.js');
      if (await fs.pathExists(cacheFile)) {
        res.setHeader('Content-Type', jsContentType());
        return res.end(await fs.readFile(cacheFile, 'utf8'));
      }

      // Resolve real entry (handles exports + subpaths)
      const entryFile = await resolveModuleEntry(id, appRoot);

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
      res.setHeader('Content-Type', jsContentType());
      res.end(output);
    } catch (err) {
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${(err as Error).message}`);
    }
  }) as NextHandleFunction);

  // --- Serve overlay runtime: prefer local src/runtime/overlay-runtime.js else inline fallback
  const localOverlayPath = path.join(appRoot, 'src', 'runtime', 'overlay-runtime.js');
  app.use(async (req, res, next) => {
    if (req.url !== RUNTIME_OVERLAY_ROUTE) return next();
    try {
      if (await fs.pathExists(localOverlayPath)) {
        res.setHeader('Content-Type', jsContentType());
        return res.end(await fs.readFile(localOverlayPath, 'utf8'));
      }
      // Inline fallback runtime (minimal)
      const inlineRuntime = `
/* Inline overlay fallback (auto-generated) */
${(() => {
        return `
const overlayId = "__rc_error_overlay__";
(function(){
  const style = document.createElement('style');
  style.textContent = \`
    #\${overlayId}{position:fixed;inset:0;background:rgba(0,0,0,0.9);color:#fff;font-family:Menlo,Consolas,monospace;font-size:14px;z-index:999999;overflow:auto;padding:24px;}
    #\${overlayId} h2{color:#ff6b6b;margin-bottom:16px;}
    .frame-file{color:#ffa500;cursor:pointer;font-weight:bold;margin-bottom:4px;}
    .line-number{opacity:0.6;margin-right:10px;display:inline-block;width:2em;text-align:right;}
  \`;
  document.head.appendChild(style);
  async function mapStackFrame(frame){
    const m = frame.match(/(\\/src\\/[^\s:]+):(\\d+):(\\d+)/);
    if(!m) return frame;
    const [,file,line] = m;
    try{
      const resp = await fetch(\`/@source-map?file=\${file}&line=\${line}\`);
      if(!resp.ok) return frame;
      const pos = await resp.json();
      if(pos.source) return pos;
    }catch(e){}
    return frame;
  }
  async function renderOverlay(err){
    const overlay = document.getElementById(overlayId) || document.body.appendChild(Object.assign(document.createElement("div"),{id:overlayId}));
    overlay.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "🔥 " + (err.message || "Error");
    overlay.appendChild(title);
    const frames = (err.stack||"").split("\\n").filter(l=>/src\\//.test(l));
    for(const f of frames){
      const mapped = await mapStackFrame(f);
      if(typeof mapped === 'string') continue;
      const link = document.createElement("div");
      link.className = "frame-file";
      link.textContent = \`\${mapped.source||mapped.file}:\${mapped.line}:\${mapped.column}\`;
      overlay.appendChild(link);
      if(mapped.snippet){
        const pre = document.createElement("pre");
        pre.innerHTML = mapped.snippet;
        overlay.appendChild(pre);
      }
    }
  }
  window.showErrorOverlay = (err)=>renderOverlay(err);
  window.clearErrorOverlay = ()=>document.getElementById(overlayId)?.remove();
  window.addEventListener("error", e=>window.showErrorOverlay?.(e.error||e));
  window.addEventListener("unhandledrejection", e=>window.showErrorOverlay?.(e.reason||e));
})();
`;
      })()}
`;
      res.setHeader('Content-Type', jsContentType());
      return res.end(inlineRuntime);
    } catch (err) {
      res.writeHead(500);
      res.end(`// overlay serve error: ${(err as Error).message}`);
    }
  });

  // --- /@source-map: return snippet around requested line
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/@source-map')) return next();
    try {
      const parsed = new URL(url, `http://localhost:${port}`);
      const file = parsed.searchParams.get('file') ?? '';
      const lineNum = Number(parsed.searchParams.get('line') ?? '0') || 0;
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
          return `<span class="line-number">${ln}</span> ${l.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`;
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
    const filePathBase = path.join(appRoot, raw.replace(/^\//, ''));
    const exts = ['', '.tsx', '.ts', '.jsx', '.js', '.css'];
    let found = '';
    for (const ext of exts) {
      if (await fs.pathExists(filePathBase + ext)) {
        found = filePathBase + ext;
        break;
      }
    }
    if (!found) return next();

    try {
      // cached transform
      if (transformCache.has(found)) {
        res.setHeader('Content-Type', jsContentType());
        res.end(transformCache.get(found)!);
        return;
      }

      let code = await fs.readFile(found, 'utf8');

      // rewrite bare imports to /@modules/*
      code = code
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(/\bimport\(['"]([^'".\/][^'"]*)['"]\)/g, (_m, dep) => `import("/@modules/${dep}")`);

      // plugin transforms
      for (const p of plugins) {
        if (p.onTransform) {
          // allow plugin transform to return string
          // eslint-disable-next-line no-await-in-loop
          const out = await p.onTransform(code, found);
          if (typeof out === 'string') code = out;
        }
      }

      // loader
      const ext = path.extname(found).toLowerCase();
      const loader: esbuild.Loader = ext === '.ts' ? 'ts' : ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'js';

      const result = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        target: ['es2020'],
      });

      transformCache.set(found, result.code);
      res.setHeader('Content-Type', jsContentType());
      res.end(result.code);
    } catch (err) {
      const e = err as Error;
      res.writeHead(500);
      res.end(`// transform error: ${e.message}`);
    }
  }) as NextHandleFunction);

  // --- Serve index.html and inject overlay + HMR client (if not already)
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (url !== '/' && url !== '/index.html') return next();
    if (!(await fs.pathExists(indexHtml))) {
      res.writeHead(404);
      return res.end('index.html not found');
    }
    try {
      let html = await fs.readFile(indexHtml, 'utf8');

      if (!html.includes(RUNTIME_OVERLAY_ROUTE)) {
        html = html.replace(
          '</body>',
          `\n<script type="module" src="${RUNTIME_OVERLAY_ROUTE}"></script>\n<script type="module">
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

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(`// html read error: ${(err as Error).message}`);
    }
  }) as NextHandleFunction);

  // HMR WebSocket + BroadcastManager
  const server = http.createServer(app);
  const broadcaster = new BroadcastManager(server);

  // Watcher for src — plugin onHotUpdate + broadcast update
  const watcher = chokidar.watch(path.join(appRoot, 'src'), { ignoreInitial: true });
  watcher.on('change', async (file) => {
    transformCache.delete(file);

    for (const p of plugins) {
      if (p.onHotUpdate) {
        try {
          // plugin receives broadcast helper
          // cast to PluginHotUpdateContext (safe wrapper)
          // eslint-disable-next-line no-await-in-loop
          await p.onHotUpdate(file, {
            broadcast: (m: HMRMessage) => {
              broadcaster.broadcast(m);
            },
          } as PluginHotUpdateContext);
        } catch (err) {
          // log plugin error but continue
          // eslint-disable-next-line no-console
          console.warn('plugin onHotUpdate error:', (err as Error).message);
        }
      }
    }

    broadcaster.broadcast({
      type: 'update',
      path: '/' + path.relative(appRoot, file).replace(/\\/g, '/'),
    });
  });

  // start server
  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.cyan.bold('\n🚀 React Client Dev Server'));
    console.log(chalk.gray('──────────────────────────────'));
    console.log(chalk.green(`⚡ Running at: ${url}`));

    // open if not explicitly disabled. using safe cast to allow unknown shape of userConfig.server
    const shouldOpen = ((userConfig as unknown) as { server?: { open?: boolean } }).server?.open !== false;
    if (shouldOpen) {
      try {
        await open(url);
      } catch {
        /* ignore */
      }
    }

    const ctx: DevServerContext = {
      root: appRoot,
      outDir: cacheDir,
      app,
      wss: broadcaster.wss,
      httpServer: server,
      broadcast: (m: BroadcastMessage) => broadcaster.broadcast(m),
    };

    // plugin serve/start hooks
    for (const p of plugins) {
      if (p.onServe) {
        await p.onServe(ctx);
      }
      if (p.onServerStart) {
        await p.onServerStart(ctx);
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
