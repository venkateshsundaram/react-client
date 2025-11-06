import fs from 'fs-extra';
import path from 'path';

type InitOptions = {
  template?: string;
  withConfig?: boolean;
};

export default async function init(name: string, opts: InitOptions = {}) {
  const root = path.resolve(process.cwd(), name);
  const template = opts.template || 'react-ts';
  await fs.ensureDir(root);
  // Resolve templates directory by walking up from __dirname until we find a
  // `templates` folder. This handles different install layouts (local dev,
  // global install, packaged dist) transparently.
  let cur = __dirname;
  let tplDir: string | null = null;
  while (true) {
    const candidate = path.join(cur, 'templates');
    if (fs.existsSync(candidate)) {
      tplDir = candidate;
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break; // reached filesystem root
    cur = parent;
  }
  if (!tplDir) {
    console.error('Templates directory not found in package layout');
    process.exit(1);
  }
  const tpl = path.join(tplDir, template);
  if (!fs.existsSync(tpl)) {
    console.error('Template not found:', template);
    process.exit(1);
  }
  await fs.copy(tpl, root);
  // If the template contains a package.json, update its name field to the
  // user provided project name so the scaffolded project has the correct
  // package identity.
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const raw = await fs.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      // Use the final directory name as the package name so users can pass
      // either a simple name ("myapp") or a path ("/abs/path/myapp").
      pkg.name = path.basename(root);
      // If template marks package private, leave it as-is; do not force publish.
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } catch (err) {
      // Non-fatal: log and continue
      console.warn('Warning: could not update package.json name for template:', err);
    }
  }
  if (opts.withConfig) {
    const cfg = "import { defineConfig } from 'react-client';\nexport default defineConfig({});\n";
    await fs.writeFile(path.join(root, 'react-client.config.ts'), cfg, 'utf8');
  }
  console.log('Project created at', root);
}
