import path from 'path';
import fs from 'fs-extra';
import prompts from 'prompts';
import chalk from 'chalk';
import { execSync } from 'child_process';
import type { InitOptions } from '../types.js';

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
  const templateDir = path.resolve(__dirname, '../../../templates', template);
  if (!fs.existsSync(templateDir)) {
    console.error(chalk.red(`❌ Template not found: ${template}`));
    process.exit(1);
  }

  // 3️⃣ Copy template
  console.log(chalk.gray(`\n📁 Copying template: ${template}...`));
  await fs.copy(templateDir, projectDir);

  // 4️⃣ Optionally create react-client.config.js (not .ts)
  if (opts.withConfig) {
    const configPath = path.join(projectDir, 'react-client.config.js');
    if (!fs.existsSync(configPath)) {
      const configContent = `// react-client.config.js
import { defineConfig } from 'react-client/config';

export default defineConfig({
  // 🧭 Root directory for the app
  root: './src',

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

  // 5️⃣ Initialize git repo
  try {
    execSync('git init', { cwd: projectDir, stdio: 'ignore' });
    console.log(chalk.gray('🔧 Initialized Git repository.'));
  } catch {
    console.warn(chalk.yellow('⚠️ Git init failed (skipping).'));
  }

  // 6️⃣ Install dependencies
  const pkgManager = /yarn/.test(process.env.npm_execpath || '') ? 'yarn' : 'npm';
  console.log(chalk.gray(`\n📦 Installing dependencies using ${pkgManager}...`));

  try {
    execSync(`${pkgManager} install`, { cwd: projectDir, stdio: 'inherit' });
  } catch {
    console.warn(chalk.yellow('⚠️ Dependency installation failed, please run manually.'));
  }

  // 7️⃣ Completion message
  console.log();
  console.log(chalk.green('✅ Project setup complete!'));
  console.log(chalk.cyan(`\nNext steps:`));
  console.log(chalk.gray(`  cd ${name}`));
  console.log(chalk.gray(`  ${pkgManager === 'yarn' ? 'yarn dev' : 'npm run dev'}`));
  console.log();
  console.log(chalk.dim('Happy coding! ⚡'));
}
