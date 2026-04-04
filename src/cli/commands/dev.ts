/**
 * dev.ts — dev server for react-client
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
import connect from 'connect';
import type { NextHandleFunction } from 'connect';

import http from 'http';
import chokidar from 'chokidar';
import detectPort from 'detect-port';
import prompts from 'prompts';
import path from 'path';
import fs from 'fs-extra';
import open from 'open';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { BroadcastManager } from '../../server/broadcastManager.js';
import type { ReactClientPlugin, ReactClientUserConfig } from '../../types/plugin';
import { createRequire } from 'module';

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

import { loadReactClientConfig } from '../../utils/loadConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const require = createRequire(import.meta.url);

type HMRMessage = {
  type: 'update' | 'error' | 'reload';
  path?: string;
  message?: string;
  stack?: string;
};
const RUNTIME_OVERLAY_ROUTE = '/@runtime/overlay';
function jsContentType() {
  return 'application/javascript; charset=utf-8';
}
/**
 * Resolve any bare import id robustly:
 * 1. try require.resolve(id)
 * 2. try require.resolve(`${pkg}/${subpath}`)
 * 3. try package.json exports field
 * 4. try common fallback candidates
 */
async function resolveModuleEntry(id: string, root: string): Promise<string> {
  // quick resolution
  try {
    return require.resolve(id, { paths: [root] });
  } catch {
    // continue
  }
  // split package root and subpath
  const parts = id.split('/');
  const pkgRoot = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subPath = parts.slice(pkgRoot.startsWith('@') ? 2 : 1).join('/');
  let pkgJsonPath: string;
  try {
    pkgJsonPath = require.resolve(`${pkgRoot}/package.json`, { paths: [root] });
  } catch {
    // No need to keep unused variable 'err'
    throw new Error(`Package not found: ${pkgRoot}`);
  }
  const pkgDir = path.dirname(pkgJsonPath);
  // Explicitly type pkgJson to avoid 'any'
  let pkgJson: Record<string, unknown> = {};
  try {
    const pkgContent = await fs.readFile(pkgJsonPath, 'utf8');
    pkgJson = JSON.parse(pkgContent) as Record<string, unknown>;
  } catch {
    // ignore parse or read errors gracefully
  }
  // If exports field exists, try to look up subpath (type-safe, supports conditional exports)
  if (pkgJson.exports) {
    const exportsField = pkgJson.exports as unknown;
    // If exports is a plain string -> it's the entry
    if (typeof exportsField === 'string') {
      if (!subPath) return path.resolve(pkgDir, exportsField);
    } else if (exportsField && typeof exportsField === 'object') {
      // Normalize to a record so we can index it safely
      const exportsMap = exportsField as Record<string, unknown>;
      // Try candidates in order: explicit subpath, index, fallback
      const keyCandidates: string[] = [];
      if (subPath) {
        keyCandidates.push(`./${subPath}`, `./${subPath}.js`, `./${subPath}.mjs`);
      }
      keyCandidates.push('.', './index.js', './index.mjs');
      for (const key of keyCandidates) {
        if (!(key in exportsMap)) continue;
        const entry = exportsMap[key];
        // entry may be string or object like { import: "...", require: "..." }
        let target: string | undefined;
        if (typeof entry === 'string') {
          target = entry;
        } else if (entry && typeof entry === 'object') {
          const entryObj = entry as Record<string, unknown>;
          // Prefer "import" field for ESM consumers, then "default", then any string-ish value
          if (typeof entryObj.import === 'string') target = entryObj.import;
          else if (typeof entryObj.default === 'string') target = entryObj.default;
          else {
            // If the entry object itself is a conditional map (like {"node": "...", "browser": "..."}),
            // attempt to pick any string value present.
            for (const k of Object.keys(entryObj)) {
              if (typeof entryObj[k] === 'string') {
                target = entryObj[k] as string;
                break;
              }
            }
          }
        }
        if (!target || typeof target !== 'string') continue;
        // Normalize relative paths in exports (remove leading ./)
        const normalized = target.replace(/^\.\//, '');
        const abs: string = path.isAbsolute(normalized)
          ? normalized
          : path.resolve(pkgDir, normalized);
        if (await fs.pathExists(abs)) {
          return abs;
        }
      }
    }
  }
  // Try resolved subpath directly (pkg/subpath)
  if (subPath) {
    try {
      const candidate = require.resolve(`${pkgRoot}/${subPath}`, { paths: [root] });
      return candidate;
    } catch {
      // fallback to searching common candidates under package dir
      const candPaths = [
        path.join(pkgDir, subPath),
        path.join(pkgDir, subPath + '.js'),
        path.join(pkgDir, subPath + '.mjs'),
        path.join(pkgDir, subPath, 'index.js'),
        path.join(pkgDir, subPath, 'index.mjs'),
      ];
      for (const c of candPaths) {
        if (await fs.pathExists(c)) return c;
      }
    }
  }
  // Try package's main/module/browser fields safely (typed as string)
  const candidateFields: (string | undefined)[] = [
    typeof pkgJson.module === 'string' ? pkgJson.module : undefined,
    typeof pkgJson.browser === 'string' ? pkgJson.browser : undefined,
    typeof pkgJson.main === 'string' ? pkgJson.main : undefined,
  ];
  for (const field of candidateFields) {
    if (!field) continue;
    const abs = path.isAbsolute(field) ? field : path.resolve(pkgDir, field);
    if (await fs.pathExists(abs)) return abs;
  }
  throw new Error(`Could not resolve module entry for ${id}`);
}
/**
 * Wrap the built module for subpath imports:
 * For requests like "/@modules/react-dom/client" — we bundle the resolved file
 * and return it. If the user requested the package root instead, the resolved
 * bundle is returned directly.
 *
 * No hardcoded special cases.
 */
function normalizeCacheKey(id: string) {
  return id.replace(/[\\/]/g, '_');
}
export default async function dev(): Promise<void> {
  const root = process.cwd();
  const userConfig = (await loadReactClientConfig(root)) as ReactClientUserConfig;
  const appRoot = path.resolve(root, userConfig.root || '.');
  const defaultPort = Number(process.env.PORT) || userConfig.server?.port || 2202;

  // cache dir for prebundled deps
  const cacheDir = path.join(appRoot, '.react-client', 'deps');
  await fs.ensureDir(cacheDir);

  // Detect entry (main.tsx / main.jsx)
  const paths = [
    path.join(appRoot, 'src/main.tsx'),
    path.join(appRoot, 'src/main.jsx'),
    path.join(appRoot, 'main.tsx'),
    path.join(appRoot, 'main.jsx'),
  ];
  const entry = paths.find((p) => fs.existsSync(p));
  if (!entry) {
    console.error(chalk.red('❌ Entry not found: main.tsx or main.jsx in app root or src/'));
    process.exit(1);
  }
  // Detect index.html and public dir
  let publicDir = path.join(appRoot, 'public');
  if (!fs.existsSync(publicDir)) {
    publicDir = path.join(root, 'public');
    if (!fs.existsSync(publicDir)) {
      // Create empty if missing, but usually templates provide it
      await fs.ensureDir(publicDir);
    }
  }
  const indexHtml = path.join(publicDir, 'index.html');

  // Select port
  const availablePort = await detectPort(defaultPort);
  const port = availablePort;
  if (availablePort !== defaultPort) {
    console.log(chalk.yellow(`\n⚠️ Port ${defaultPort} is occupied. Using ${availablePort} instead.`));
  }

  // Ensure react-refresh runtime available (used by many templates)
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
      console.warn(
        chalk.yellow('⚠️ automatic install of react-refresh failed; continuing without it.'),
      );
    }
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
    {
      name: 'react-refresh',
      async onTransform(code, id) {
        if (id.match(/\.[tj]sx$/)) {
          // In ESM, we can't easily put statements before imports.
          // We'll rely on the global hook injected in index.html.
          const relativePath = '/' + path.relative(appRoot, id);
          const hmrBoilerplate = `
            if (window.__REFRESH_RUNTIME__ && window.__GET_HOT_CONTEXT__) {
              const ___hot = window.__GET_HOT_CONTEXT__(${JSON.stringify(relativePath)});
              if (___hot) {
                window.$RefreshReg$ = (type, id) => {
                  window.__REFRESH_RUNTIME__.register(type, ${JSON.stringify(relativePath)} + " " + id);
                };
                window.$RefreshSig$ = () => window.__REFRESH_RUNTIME__.createSignatureFunctionForTransform();
              }
            }
          `;
          const modBoilerplate = `
            if (window.__RC_HMR_STATE__) {
              const ___mod = window.__RC_HMR_STATE__.modules[${JSON.stringify(relativePath)}];
              if (___mod && ___mod.cb) {
                if (typeof ___mod.cb === 'function') ___mod.cb();
              }
            }
          `;
          return `${code}\n${hmrBoilerplate}\n${modBoilerplate}`;
        }
        return code;
      },
    }
  ];
  const userPlugins = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
  const plugins: ReactClientPlugin[] = [...corePlugins, ...userPlugins];

  // App + caches
  const app = connect();
  const transformCache = new Map<string, string>();
  // Helper: recursively analyze dependency graph for prebundling (bare imports)
  // --- Dependency Analysis & Prebundling ---
  async function analyzeGraph(file: string, seen = new Set<string>()): Promise<Set<string>> {
    const deps = new Set<string>();
    const visitedFiles = new Set<string>();

    async function walk(f: string) {
      if (visitedFiles.has(f)) return;
      visitedFiles.add(f);

      try {
        const code = await fs.readFile(f, 'utf8');
        const matches = [
          ...code.matchAll(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g),
          ...code.matchAll(/\bimport\(['"]([^'".\/][^'"]*)['"]\)/g),
          ...code.matchAll(/\brequire\(['"]([^'".\/][^'"]*)['"]\)/g),
        ];

        for (const m of matches) {
          const dep = m[1];
          if (!dep || dep.startsWith('.') || dep.startsWith('/')) continue;
          if (!deps.has(dep)) {
            deps.add(dep);
            try {
              const resolved = require.resolve(dep, { paths: [appRoot] });
              if (resolved.includes('node_modules')) {
                await walk(resolved);
              }
            } catch {
              // skip unresolvable
            }
          }
        }
      } catch {
        // skip missing files
      }
    }

    await walk(file);
    return deps;
  }

  // Helper: esbuild plugin to rewrite bare imports in dependency bundles to /@modules/
  const dependencyBundlePlugin: esbuild.Plugin = {
    name: 'dependency-bundle-plugin',
    setup(build) {
      // Intercept any bare import (not starting with . or /) that is NOT the entry point
      build.onResolve({ filter: /^[^.\/]/ }, (args) => {
        // If this is the initial entry point, don't externalize it
        if (args.kind === 'entry-point') return null;

        // Otherwise, externalize and point to /@modules/
        return {
          path: `/@modules/${args.path}`,
          external: true,
        };
      });
    },
  };

  // Prebundle dependencies into cache dir using code-splitting
  async function prebundleDeps(deps: Set<string>): Promise<void> {
    if (!deps.size) return;

    const entryPoints: Record<string, string> = {};
    const depsArray = [...deps];
    
    // Create a temp directory for proxy files
    const proxyDir = path.join(appRoot, '.react-client', 'proxies');
    await fs.ensureDir(proxyDir);

    for (const dep of depsArray) {
      try {
        const resolved = require.resolve(dep, { paths: [appRoot] });
        const key = normalizeCacheKey(dep);
        const proxyPath = path.join(proxyDir, `${key}.js`);
        const resolvedPath = JSON.stringify(resolved);
        
        let proxyCode = '';
        
        // Precision Proxy: hardcoded exports for most critical React dependencies
        const reactKeys = ['useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue', 'useDeferredValue', 'useTransition', 'useId', 'useInsertionEffect', 'useSyncExternalStore', 'createElement', 'createContext', 'createRef', 'forwardRef', 'memo', 'lazy', 'Suspense', 'Fragment', 'Profiler', 'StrictMode', 'Children', 'Component', 'PureComponent', 'cloneElement', 'isValidElement', 'createFactory', 'version', 'startTransition'];
        const reactDomClientKeys = ['createRoot', 'hydrateRoot'];
        const reactDomKeys = ['render', 'hydrate', 'unmountComponentAtNode', 'findDOMNode', 'createPortal', 'version', 'flushSync'];
        const jsxRuntimeKeys = ['jsx', 'jsxs', 'Fragment'];

        if (dep === 'react') {
          proxyCode = `import * as m from ${resolvedPath}; export const { ${reactKeys.join(', ')} } = m; export default (m.default || m);`;
        } else if (dep === 'react-dom/client') {
          proxyCode = `import * as m from ${resolvedPath}; export const { ${reactDomClientKeys.join(', ')} } = m; export default (m.default || m);`;
        } else if (dep === 'react-dom') {
          proxyCode = `import * as m from ${resolvedPath}; export const { ${reactDomKeys.join(', ')} } = m; export default (m.default || m);`;
        } else if (dep === 'react/jsx-runtime' || dep === 'react/jsx-dev-runtime') {
          proxyCode = `import * as m from ${resolvedPath}; export const { ${jsxRuntimeKeys.join(', ')} } = m; export default (m.default || m);`;
        } else {
          try {
            // Dynamic Proxy Generation for other deps
            const m = require(resolved);
            const keys = Object.keys(m).filter(k => k !== 'default' && k !== '__esModule');
            if (keys.length > 0) {
              proxyCode = `import * as m from ${resolvedPath}; export const { ${keys.join(', ')} } = m; export default (m.default || m);`;
            } else {
              proxyCode = `import _default from ${resolvedPath}; export default _default;`;
            }
          } catch {
            proxyCode = `export * from ${resolvedPath}; import _default from ${resolvedPath}; export default _default;`;
          }
        }
        
        await fs.writeFile(proxyPath, proxyCode, 'utf8');
        entryPoints[key] = proxyPath;
      } catch (err) {
        console.warn(chalk.yellow(`⚠️ Could not resolve ${dep}: ${(err as Error).message}`));
      }
    }

    if (Object.keys(entryPoints).length === 0) return;

    console.log(chalk.cyan('📦 Prebundling dependencies with precision proxies...'));

    try {
      await esbuild.build({
        entryPoints,
        bundle: true,
        splitting: true, // Re-enable splitting for shared dependency chunks
        format: 'esm',
        outdir: cacheDir,
        platform: 'browser',
        target: ['es2020'],
        minify: false,
        plugins: [], // NO external plugins during prebundle, let esbuild manage the graph
        define: {
          'process.env.NODE_ENV': '"development"',
        },
        logLevel: 'error',
      });
      
      // Cleanup proxy dir after build
      await fs.remove(proxyDir).catch(() => {});
      console.log(chalk.green('✅ Prebundling complete.'));
    } catch (err) {
      console.error(chalk.red(`❌ Prebundling failed: ${(err as Error).message}`));
    }
  }

  // Build initial prebundle graph from entry
  const depsSet = await analyzeGraph(entry);
  // Ensure react/jsx-runtime is prebundled if used
  depsSet.add('react/jsx-runtime');
  await prebundleDeps(depsSet);

  // Watch package.json for changes to re-prebundle
  const pkgPath = path.join(appRoot, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    chokidar.watch(pkgPath).on('change', async () => {
      console.log(chalk.yellow('📦 package.json changed — rebuilding prebundle...'));
      const newDeps = await analyzeGraph(entry);
      newDeps.add('react/jsx-runtime');
      await prebundleDeps(newDeps);
    });
  }
  // --- Serve /@modules/<dep> (prebundled or on-demand esbuild bundle)
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    
    // Serve React Refresh runtime
    if (url === '/@react-refresh') {
      res.setHeader('Content-Type', jsContentType());
      try {
        const runtimePath = require.resolve('react-refresh/runtime');
        // Bundle it to ESM for the browser
        const bundled = await esbuild.build({
          entryPoints: [runtimePath],
          bundle: true,
          format: 'iife',
          globalName: '__REFRESH_RUNTIME__',
          write: false,
          minify: true,
          define: {
            'process.env.NODE_ENV': '"development"',
          },
        });
        const runtimeCode = bundled.outputFiles?.[0]?.text ?? '';
        return res.end(`
          const prevRefreshReg = window.$RefreshReg$;
          const prevRefreshSig = window.$RefreshSig$;
          ${runtimeCode}
          window.$RefreshReg$ = prevRefreshReg;
          window.$RefreshSig$ = prevRefreshSig;
          export default window.__REFRESH_RUNTIME__;
        `);
      } catch (err) {
        res.writeHead(500);
        return res.end(`// react-refresh runtime error: ${(err as Error).message}`);
      }
    }

    if (!url.startsWith('/@modules/')) return next();
    const id = url.replace(/^\/@modules\//, '');
    if (!id) {
      res.writeHead(400);
      return res.end('// invalid module');
    }

    try {
      // 1. Check if it's a file in the cache directory (prebundled or shared chunk)
      // Chunks might be requested via /@modules/dep/chunk-xxx.js or just /@modules/chunk-xxx.js
      const idBase = path.basename(id);
      const cacheFile = id.endsWith('.js') 
        ? path.join(cacheDir, id) 
        : path.join(cacheDir, normalizeCacheKey(id) + '.js');
      const cacheFileAlternative = path.join(cacheDir, idBase);
      
      let foundCacheFile = '';
      if (await fs.pathExists(cacheFile)) {
        foundCacheFile = cacheFile;
      } else if (await fs.pathExists(cacheFileAlternative)) {
        foundCacheFile = cacheFileAlternative;
      }

      if (foundCacheFile) {
        res.setHeader('Content-Type', jsContentType());
        return res.end(await fs.readFile(foundCacheFile, 'utf8'));
      }

      // 2. Resolve the actual entry file for bare imports
      const entryFile = await resolveModuleEntry(id, appRoot);
      const result = await esbuild.build({
        entryPoints: [entryFile],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        write: false,
        target: ['es2020'],
        jsx: 'automatic',
        // Critical: use dependencyBundlePlugin to ensure sub-deps are rewritten to /@modules/
        plugins: [dependencyBundlePlugin],
        define: {
          'process.env.NODE_ENV': '"development"',
        },
      });
      const output = result.outputFiles?.[0]?.text ?? '';
      // Write cache and respond
      await fs.writeFile(cacheFile, output, 'utf8');
      res.setHeader('Content-Type', jsContentType());
      res.end(output);
    } catch (err) {
      res.writeHead(500);
      res.end(`// Failed to resolve module ${id}: ${(err as Error).message}`);
    }
  }) as NextHandleFunction);

  // --- Serve runtime overlay (inline, no external dependencies)
  const OVERLAY_RUNTIME = `
const overlayId = "__rc_error_overlay__";
(function(){ 
  const style = document.createElement("style");
  style.textContent = \`
    #\${overlayId}{position:fixed;inset:0;background:rgba(0,0,0,0.9);color:#fff;font-family:Menlo,Consolas,monospace;font-size:14px;z-index:999999;overflow:auto;padding:24px;}
    #\${overlayId} h2{color:#ff6b6b;margin-bottom:16px;}
    #\${overlayId} pre{background:rgba(255,255,255,0.06);padding:12px;border-radius:6px;overflow:auto;}
    .frame-file{color:#ffa500;cursor:pointer;font-weight:bold;margin-bottom:4px;}
    .line-number{opacity:0.6;margin-right:10px;display:inline-block;width:2em;text-align:right;}
  \`;
  document.head.appendChild(style);
  async function mapStackFrame(frame){
    const m = frame.match(/(\\/src\\/[^\s:]+):(\\d+):(\\d+)/);
    if(!m) return frame;
    const [,file,line,col] = m;
    try{
      const resp = await fetch(\`/@source-map?file=\${file}&line=\${line}&column=\${col}\`);
      if(!resp.ok) return frame;
      const pos = await resp.json();
      if(pos.source) return pos;
    }catch(e){}
    return frame;
  }
  function highlightSimple(s){
    return s.replace(/(const|let|var|function|return|import|from|export|class|new|await|async|if|else|for|while|try|catch|throw)/g,'<span style="color:#ffb86c">$1</span>');
  }
  async function renderOverlay(err){
    const overlay = document.getElementById(overlayId) || document.body.appendChild(Object.assign(document.createElement("div"),{id:overlayId}));
    overlay.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = "🔥 " + (err.message || "Error");
    overlay.appendChild(title);
    const frames = (err.stack||"").split("\\n").filter(l => /src\\//.test(l));
    for(const frame of frames){
      const mapped = await mapStackFrame(frame);
      if(typeof mapped === "string") continue;
      const frameEl = document.createElement("div");
      const link = document.createElement("div");
      link.className = "frame-file";
      link.textContent = \`\${mapped.source||mapped.file}:\${mapped.line}:\${mapped.column}\`;
      link.onclick = ()=>window.open("vscode://file/"+(mapped.source||mapped.file)+":"+mapped.line);
      frameEl.appendChild(link);
      if(mapped.snippet){
        const pre = document.createElement("pre");
        pre.innerHTML = highlightSimple(mapped.snippet);
        frameEl.appendChild(pre);
      }
      overlay.appendChild(frameEl);
    }
  }
  window.showErrorOverlay = (err)=>renderOverlay(err);
  window.clearErrorOverlay = ()=>document.getElementById(overlayId)?.remove();
  window.addEventListener("error", e => window.showErrorOverlay?.(e.error || e));
  window.addEventListener("unhandledrejection", e => window.showErrorOverlay?.(e.reason || e));
})();
`;

  app.use((async (req, res, next) => {
    if (req.url === '/@runtime/overlay') {
      res.setHeader('Content-Type', jsContentType());
      return res.end(OVERLAY_RUNTIME);
    }
    next();
  }) as NextHandleFunction);

  // --- minimal /@source-map: return snippet around requested line of original source file
  app.use((async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/@source-map')) return next();
    try {
      const parsed = new URL(req.url ?? '', `http://localhost:${port}`);
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
      res.end(JSON.stringify({ source: filePath, line: lineNum, column: 0, snippet }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }) as NextHandleFunction);

  // --- Serve public/ files as static assets
  app.use((async (req, res, next) => {
    const raw = decodeURIComponent((req.url ?? '').split('?')[0]);
    const publicFile = path.join(publicDir, raw.replace(/^\//, ''));
    if (await fs.pathExists(publicFile) && !(await fs.stat(publicFile)).isDirectory()) {
      const ext = path.extname(publicFile).toLowerCase();
      // Simple content type map
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const content = await fs.readFile(publicFile);
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.setHeader('Content-Length', content.length);
      return res.end(content);
    }
    next();
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

      // run plugin transforms
      for (const p of plugins) {
        if (p.onTransform) {
          const out = await p.onTransform(code, found);
          if (typeof out === 'string') code = out;
        }
      }

      const ext = path.extname(found).toLowerCase();
      const loader: esbuild.Loader =
        ext === '.ts' ? 'ts' : ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'js';
      const result = await esbuild.transform(code, {
        loader,
        sourcemap: 'inline',
        target: ['es2020'],
        jsx: 'automatic',
      });

      let transformedCode = result.code;
      
      // Inject HMR/Refresh boilerplate (ESM-Safe: use global accessors and append logic)
      const modulePath = '/' + path.relative(appRoot, found).replace(/\\/g, '/');
      
      // 1. Replace import.meta.hot with a global context accessor (safe anywhere in ESM)
      transformedCode = transformedCode.replace(/import\.meta\.hot/g, `window.__GET_HOT_CONTEXT__?.(${JSON.stringify(modulePath)})`);
      
      // rewrite bare imports -> /@modules/<dep>
      transformedCode = transformedCode
        .replace(/\bfrom\s+['"]([^'".\/][^'"]*)['"]/g, (_m, dep) => `from "/@modules/${dep}"`)
        .replace(
          /\bimport\(['"]([^'".\/][^'"]*)['"]\)/g,
          (_m, dep) => `import("/@modules/${dep}")`,
        )
        .replace(
          /^(import\s+['"])([^'".\/][^'"]*)(['"])/gm,
          (_m, start, dep, end) => `${start}/@modules/${dep}${end}`,
        )
        .replace(
          /^(export\s+\*\s+from\s+['"])([^'".\/][^'"]*)(['"])/gm,
          (_m, start, dep, end) => `${start}/@modules/${dep}${end}`,
        );

      transformCache.set(found, transformedCode);
      res.setHeader('Content-Type', jsContentType());
      res.end(transformedCode);
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
      // React Refresh Preamble for index.html
      const reactRefreshPreamble = `
<script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__REFRESH_RUNTIME__ = RefreshRuntime;
</script>
<script type="module" src="/@runtime/overlay"></script>
<script type="module">
  window.__RC_HMR_STATE__ = { modules: {} };
  window.__GET_HOT_CONTEXT__ = (id) => {
    return window.__RC_HMR_STATE__.modules[id] || (window.__RC_HMR_STATE__.modules[id] = {
      id,
      accept: (cb) => { window.__RC_HMR_STATE__.modules[id].cb = cb || true; }
    });
  };
  const ws = new WebSocket("ws://" + location.host);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "reload") location.reload();
    if (msg.type === "error") window.showErrorOverlay?.(msg);
    if (msg.type === "update") {
      window.clearErrorOverlay?.();
      const mod = window.__RC_HMR_STATE__.modules[msg.path];
      if (mod && mod.cb) {
        import(msg.path + "?t=" + Date.now()).then(() => {
          if (typeof mod.cb === 'function') mod.cb();
          // Trigger Fast Refresh after module update
          if (window.__REFRESH_RUNTIME__) {
            window.__REFRESH_RUNTIME__.performReactRefresh();
          }
        });
      } else {
        location.reload();
      }
    }
  };
</script>`.trim();
      // Inject preamble at the top of <body>
      const newHtml = html.replace('<body>', `<body>\n${reactRefreshPreamble}`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(newHtml);
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
          await p.onHotUpdate(file, {
            // plugin only needs broadcast in most cases
            broadcast: (msg: HMRMessage) => {
              broadcaster.broadcast(msg);
            },
          } as unknown as { broadcast: (m: HMRMessage) => void });
        } catch (err) {
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
      try {
        await open(url);
      } catch {
        // ignore open errors
      }
    }
  });

  // graceful shutdown
  const shutdown = async () => {
    console.log(chalk.red('\n🛑 Shutting down dev server...'));
    try {
      await watcher.close();
      broadcaster.close();
      server.close();
    } catch (err) {
      console.error(chalk.red('⚠️ Error during shutdown:'), (err as Error).message);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
