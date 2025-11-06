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
  const tpl = path.join(__dirname, '../../templates', template);
  if (!fs.existsSync(tpl)) {
    console.error('Template not found:', template);
    process.exit(1);
  }
  await fs.copy(tpl, root);
  if (opts.withConfig) {
    const cfg = "import { defineConfig } from 'react-client';\nexport default defineConfig({});\n";
    await fs.writeFile(path.join(root, 'react-client.config.ts'), cfg, 'utf8');
  }
  console.log('Project created at', root);
}
