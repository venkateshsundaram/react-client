import path, { dirname } from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import prompts from 'prompts';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { pascalCase } from '../../utils/string.js';

// ESM polyfill
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function getProjectContext() {
  const root = process.cwd();
  const srcDir = path.resolve(root, 'src');

  if (!fs.existsSync(srcDir)) {
    console.error(
      chalk.red('❌ Error: Could not find "src" directory. Make sure you are in the project root.'),
    );
    process.exit(1);
  }

  const isTS =
    fs.existsSync(path.resolve(root, 'tsconfig.json')) ||
    fs.readdirSync(srcDir).some((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const ext = isTS ? 'tsx' : 'jsx';

  return { root, srcDir, isTS, ext };
}

export async function route(name: string) {
  const { root, srcDir, isTS, ext } = await getProjectContext();
  const pagesDir = path.resolve(srcDir, 'pages');
  const componentName = pascalCase(name);
  const routePath = `/${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  const pageFile = path.resolve(pagesDir, `${componentName}.${ext}`);

  // 1️⃣ Create pages directory if it doesn't exist
  await fs.ensureDir(pagesDir);

  // 2️⃣ Check if component already exists
  if (fs.existsSync(pageFile)) {
    console.error(chalk.red(`❌ Error: Page "${componentName}" already exists at ${pageFile}`));
    process.exit(1);
  }

  // 3️⃣ Generate the component
  const componentContent = `import React from 'react';

export default function ${componentName}() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>${componentName} Page</h1>
      <p>This is the ${componentName} route.</p>
    </div>
  );
}
`;
  await fs.writeFile(pageFile, componentContent, 'utf8');
  console.log(
    chalk.green(
      `\n📄 Generated page component: ${chalk.bold(`src/pages/${componentName}.${ext}`)}`,
    ),
  );

  // 4️⃣ Handle react-router-dom
  const pkgPath = path.resolve(root, 'package.json');
  const pkg = await fs.readJson(pkgPath);
  const hasRouter =
    pkg.dependencies?.['react-router-dom'] || pkg.devDependencies?.['react-router-dom'];

  if (!hasRouter) {
    const res = await prompts({
      type: 'confirm',
      name: 'install',
      message: chalk.yellow(
        'react-router-dom is not installed. Would you like to install it and set up routing?',
      ),
      initial: true,
    });

    if (res.install) {
      console.log(chalk.gray('📦 Installing react-router-dom...'));
      const pkgManager = /yarn/.test(process.env.npm_execpath || '') ? 'yarn' : 'npm';
      try {
        execSync(`${pkgManager} ${pkgManager === 'yarn' ? 'add' : 'install'} react-router-dom`, {
          cwd: root,
          stdio: 'inherit',
        });
        console.log(chalk.green('✅ Installed react-router-dom.'));
        await setupInitialRouter(root, srcDir, isTS, componentName);
      } catch {
        console.error(
          chalk.red('❌ Failed to install react-router-dom. Please install it manually.'),
        );
      }
    } else {
      console.log(
        chalk.yellow('\n⚠️ Skipping router setup. You will need to manually register the route.'),
      );
    }
  } else {
    // Try to register the route in App.tsx/jsx
    await registerRoute(root, srcDir, isTS, componentName, routePath);
  }
}

async function setupInitialRouter(root: string, srcDir: string, isTS: boolean, firstPage: string) {
  const ext = isTS ? 'tsx' : 'jsx';
  const mainFile = path.resolve(srcDir, `main.${ext}`);
  const appFile = path.resolve(srcDir, `App.${ext}`);

  console.log(chalk.gray('🔧 Setting up initial routing structure...'));

  // Update main.tsx/jsx to include BrowserRouter
  if (fs.existsSync(mainFile)) {
    let mainContent = await fs.readFile(mainFile, 'utf8');
    if (!mainContent.includes('BrowserRouter')) {
      mainContent = `import { BrowserRouter } from 'react-router-dom';\n` + mainContent;
      // Wrap App with BrowserRouter
      mainContent = mainContent.replace(
        /<App\s*\/>/g,
        '<BrowserRouter>\n      <App />\n    </BrowserRouter>',
      );
      await fs.writeFile(mainFile, mainContent, 'utf8');
      console.log(chalk.green(`✅ Wrapped App with BrowserRouter in src/main.${ext}`));
    }
  }

  // Update App.tsx/jsx to basic Routes structure
  const appContent = `import React from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import ${firstPage} from './pages/${firstPage}';
import './App.css';

export default function App() {
  return (
    <div className="app-container">
      <nav style={{ padding: '1rem', borderBottom: '1px solid #ccc', marginBottom: '1rem' }}>
        <Link to="/" style={{ marginRight: '1rem' }}>Home</Link>
        <Link to="/${firstPage.toLowerCase()}">${firstPage}</Link>
      </nav>

      <Routes>
        <Route path="/" element={
          <div style={{ padding: '2rem' }}>
            <h1>Welcome to React Client</h1>
            <p>Get started by editing <code>src/App.${ext}</code></p>
          </div>
        } />
        <Route path="/${firstPage.toLowerCase()}" element={<${firstPage} />} />
      </Routes>
    </div>
  );
}
`;
  await fs.writeFile(appFile, appContent, 'utf8');
  console.log(chalk.green(`✅ Initialized src/App.${ext} with Routes structure.`));
}

async function registerRoute(
  root: string,
  srcDir: string,
  isTS: boolean,
  componentName: string,
  routePath: string,
) {
  const ext = isTS ? 'tsx' : 'jsx';
  const appFile = path.resolve(srcDir, `App.${ext}`);

  if (!fs.existsSync(appFile)) {
    console.warn(
      chalk.yellow(`\n⚠️ Could not find src/App.${ext}. Please register the route manually.`),
    );
    return;
  }

  let appContent = await fs.readFile(appFile, 'utf8');

  // Check if Routes is used
  if (!appContent.includes('<Routes>')) {
    console.warn(
      chalk.yellow(`\n⚠️ <Routes> not found in App.${ext}. Please register the route manually.`),
    );
    console.log(
      chalk.gray(
        `Draft code:\nimport ${componentName} from './pages/${componentName}';\n<Route path="${routePath}" element={<${componentName} />} />`,
      ),
    );
    return;
  }

  // Add import
  const importStatement = `import ${componentName} from './pages/${componentName}';\n`;
  if (!appContent.includes(`from './pages/${componentName}'`)) {
    // Insert at the top after other imports
    const lines = appContent.split('\n');
    let lastImportIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('import')) lastImportIndex = i;
    }
    lines.splice(lastImportIndex + 1, 0, importStatement.trim());
    appContent = lines.join('\n');
  }

  // Add navigation link if a nav exists
  if (appContent.includes('</nav>')) {
    if (!appContent.includes(`to="${routePath}"`)) {
      appContent = appContent.replace(
        /(\n\s+)<\/nav>/,
        `$1  <Link to="${routePath}" style={{ marginRight: '1rem' }}>${componentName}</Link>$1</nav>`,
      );
    }
  }

  // Add Route
  if (!appContent.includes(`element={<${componentName} />`)) {
    appContent = appContent.replace(
      /(\n\s+)<\/Routes>/,
      `$1  <Route path="${routePath}" element={<${componentName} />} />$1</Routes>`,
    );
    await fs.writeFile(appFile, appContent, 'utf8');
    console.log(chalk.green(`✅ Registered route "${routePath}" in src/App.${ext}`));
  } else {
    console.log(chalk.yellow(`\n⚠️ Route for ${componentName} already seems to be registered.`));
  }
}

export async function component(name: string) {
  const { srcDir, isTS, ext } = await getProjectContext();
  const componentsDir = path.resolve(srcDir, 'components');
  const componentName = pascalCase(name);
  const componentFile = path.resolve(componentsDir, `${componentName}.${ext}`);

  // 1️⃣ Create components directory if it doesn't exist
  await fs.ensureDir(componentsDir);

  // 2️⃣ Check if component already exists
  if (fs.existsSync(componentFile)) {
    console.error(
      chalk.red(`❌ Error: Component "${componentName}" already exists at ${componentFile}`),
    );
    process.exit(1);
  }

  // 3️⃣ Generate the component
  const componentContent = `import React from 'react';

${
  isTS
    ? `export interface ${componentName}Props {
  children?: React.ReactNode;
}

`
    : ''
}export default function ${componentName}(${
    isTS ? `{ children }: ${componentName}Props` : '{ children }'
  }) {
  return (
    <div className="${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}">
      {children || '${componentName} component'}
    </div>
  );
}
`;
  await fs.writeFile(componentFile, componentContent, 'utf8');
  console.log(
    chalk.green(
      `\n📄 Generated component: ${chalk.bold(`src/components/${componentName}.${ext}`)}`,
    ),
  );
}

export default {
  route,
  component,
};
