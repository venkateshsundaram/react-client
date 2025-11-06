import fs from 'fs-extra';
import path from 'path';
import { pascalCase } from '../../utils/string';

type GenerateOptions = {
  ts?: boolean;
  'no-ts'?: boolean;
  path?: string;
  force?: boolean;
};

export default async function generate(kind: string, name: string, opts: GenerateOptions = {}) {
  const root = process.cwd();
  const useTS = opts.ts !== false && opts['no-ts'] !== true;
  if (kind === 'component') {
    const pascal = pascalCase(name);
    const dir = path.join(root, opts.path || 'src/components');
    await fs.ensureDir(dir);
    const ext = useTS ? 'tsx' : 'jsx';
    const compPath = path.join(dir, `${pascal}.${ext}`);
    const css = path.join(dir, `${pascal}.module.css`);
    await fs.writeFile(
      compPath,
      `import React from 'react';\nimport styles from './${pascal}.module.css';\nexport default function ${pascal}(){ return <div className={styles.root}>${pascal}</div>; }\n`,
    );
    await fs.writeFile(css, `.root{display:block}`);
    console.log('Created component', compPath);
    return;
  }
  if (kind === 'route') {
    const parts = name.replace(/^\//, '').split('/').filter(Boolean);
    const pages = path.join(root, 'src', 'pages', ...parts.slice(0, -1));
    await fs.ensureDir(pages);
    const last = parts[parts.length - 1] || 'index';
    const file = path.join(pages, last + '.' + (useTS ? 'tsx' : 'jsx'));
    if (await fs.pathExists(file)) {
      console.error('Route exists');
      return;
    }
    const compName = pascalCase(parts.join('-') || 'IndexPage');
    const content = `import React from 'react';\nexport default function ${compName}(){ return (<div style={{padding:20}}><h1>${compName}</h1></div>); }\n`;
    await fs.writeFile(file, content, 'utf8');
    console.log('Created route', file);
    return;
  }
  console.log('Unknown generator', kind);
}
