import path, { dirname } from 'path';
import fs from 'fs-extra';
import prompts from 'prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { InitOptions } from '../types.js';

// ESM polyfill for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function initCmd(name: string, opts: InitOptions) {
  const root = process.cwd();
  const projectDir = path.resolve(root, name);
  const template = opts.template || 'react-ts';

  console.log(chalk.cyan(`\n📦 Creating new React Client app: ${chalk.bold(name)}`));

  // 1️⃣ Check if directory exists
  if (fs.existsSync(projectDir)) {
    const res = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: chalk.yellow(`Directory "${name}" already exists. Overwrite?`),
      initial: false,
    });
    if (!res.overwrite) {
      console.log(chalk.red('❌ Operation cancelled.'));
      process.exit(1);
    }
    await fs.remove(projectDir);
  }

  await fs.ensureDir(projectDir);

  // 2️⃣ Locate template
  // Look for templates folder relative to this file, or in the package root
  let templateDir = path.resolve(__dirname, '../../../templates', template);
  if (!fs.existsSync(templateDir)) {
    // Fallback for different build/install structures
    templateDir = path.resolve(__dirname, '../../templates', template);
  }
  
  if (!fs.existsSync(templateDir)) {
    console.error(chalk.red(`❌ Template not found: ${template}`));
    console.error(chalk.gray(`Search path: ${templateDir}`));
    process.exit(1);
  }

  // 3️⃣ Copy template
  console.log(chalk.gray(`\n📁 Copying template: ${template}...`));
  await fs.copy(templateDir, projectDir);

  // 4️⃣ Update package.json to include react-client as a devDependency
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = await fs.readJson(pkgPath);
      
      // Get current react-client version
      const rootRepoPkgPath = path.resolve(__dirname, '../../../package.json');
      const distRepoPkgPath = path.resolve(__dirname, '../../package.json');
      let currentVersion = 'latest';
      let isLocalDev = false;
      let repoRoot = '';
      
      if (fs.existsSync(rootRepoPkgPath)) {
        const rootPkg = await fs.readJson(rootRepoPkgPath);
        currentVersion = rootPkg.version;
        if (rootPkg.name === 'react-client') {
          isLocalDev = true;
          repoRoot = path.dirname(rootRepoPkgPath);
        }
      } else if (fs.existsSync(distRepoPkgPath)) {
        const distPkg = await fs.readJson(distRepoPkgPath);
        currentVersion = distPkg.version;
        if (distPkg.name === 'react-client') {
          isLocalDev = true;
          repoRoot = path.dirname(distRepoPkgPath);
        }
      }

      pkg.devDependencies = pkg.devDependencies || {};
      
      // If we are in local dev, use a relative file: dependency so npm install works
      if (isLocalDev && repoRoot) {
        const relativePath = path.relative(projectDir, repoRoot);
        pkg.devDependencies['react-client'] = `file:${relativePath}`;
        console.log(chalk.blue(`🏠 Local development detected, using relative path for react-client.`));
      } else {
        pkg.devDependencies['react-client'] = `^${currentVersion}`;
      }
      
      // Ensure react-refresh is present as it's required for dev mode HMR
      if (!pkg.dependencies?.['react-refresh'] && !pkg.devDependencies?.['react-refresh']) {
        pkg.devDependencies['react-refresh'] = '^0.14.0';
      }
      
      // update name to user's choice
      pkg.name = name;

      await fs.writeJson(pkgPath, pkg, { spaces: 2 });
      console.log(chalk.green(`📝 Updated package.json with react-client v${currentVersion}`));
    } catch (err) {
      console.warn(chalk.yellow(`⚠️ Could not update package.json: ${(err as Error).message}`));
    }
  }

  // 5️⃣ Optionally create react-client.config.js (not .ts)
  if (opts.withConfig) {
    const configPath = path.join(projectDir, 'react-client.config.js');
    if (!fs.existsSync(configPath)) {
      const configContent = `// react-client.config.js
import { defineConfig } from 'react-client/config';

export default defineConfig({
  // 🧭 Root directory for the app
  root: '.',

  // ⚡ Dev server settings
  server: {
    port: 2202,
  },

  // 🏗️ Build options
  build: {
    outDir: '.react-client/build',
  },

  // 💡 Add plugins, aliases, etc.
});
`;
      await fs.writeFile(configPath, configContent, 'utf8');
      console.log(chalk.green('📝 Created react-client.config.js'));
    }
  }

  // 6️⃣ Initialize git repo
  try {
    execSync('git init', { cwd: projectDir, stdio: 'ignore' });
    console.log(chalk.gray('🔧 Initialized Git repository.'));
  } catch {
    console.warn(chalk.yellow('⚠️ Git init failed (skipping).'));
  }

  // 7️⃣ Install dependencies
  const pkgManager = /yarn/.test(process.env.npm_execpath || '') ? 'yarn' : 'npm';
  console.log(chalk.gray(`\n📦 Installing dependencies using ${pkgManager}...`));

  try {
    execSync(`${pkgManager} install`, { cwd: projectDir, stdio: 'inherit' });
  } catch {
    console.warn(chalk.yellow('⚠️ Dependency installation failed, please run manually.'));
  }

  // 8️⃣ Completion message
  console.log();
  console.log(chalk.green('✅ Project setup complete!'));
  console.log(chalk.cyan(`\nNext steps:`));
  console.log(chalk.gray(`  cd ${name}`));
  console.log(chalk.gray(`  ${pkgManager === 'yarn' ? 'yarn dev' : 'npm run dev'}`));
  console.log();
  console.log(chalk.dim('Happy coding! ⚡'));
}
