#!/usr/bin/env node
/**
 * React Client CLI (Vite-like)
 * ---------------------------------------
 * Supports commands: init, dev, build, preview
 * ESM-safe, works with NodeNext and global installs.
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import initCmd from './commands/init.js';
import devCmd from './commands/dev.js';
import buildCmd from './commands/build.js';
import previewCmd from './commands/preview.js';

// Resolve __dirname safely in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamically load version from package.json
const pkgPath = path.resolve(__dirname, '../../package.json');
const pkg = fs.existsSync(pkgPath)
  ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  : { version: '0.0.0' };

// 🧠 Banner Display
function showBanner(cmd?: string) {
  const title = chalk.bold.cyan('⚡ React Client');
  const version = chalk.gray(`v${pkg.version}`);
  const tagline = chalk.dim('Fast esbuild-based React CLI with HMR & Overlay');
  const line = chalk.gray('──────────────────────────────────────────────────────────────');

  console.log(`\n${title} ${version}`);
  console.log(tagline);
  console.log(line);

  switch (cmd) {
    case 'init':
      console.log(chalk.cyan('📦 Initializing new React project...\n'));
      break;
    case 'dev':
      console.log(chalk.green('🚀 Starting development server...\n'));
      break;
    case 'build':
      console.log(chalk.yellow('🏗️  Building for production...\n'));
      break;
    case 'preview':
      console.log(chalk.blue('🌐 Starting production preview server...\n'));
      break;
    default:
      console.log();
  }
}

// CLI Setup
const program = new Command();

program
  .name('react-client')
  .description('react-client CLI – lightweight React toolkit for fast builds & dev server')
  .version(pkg.version, '-v, --version', 'display version information');

// Commands
program
  .command('init <name>')
  .option('-t, --template <template>', 'choose a template', 'react-ts')
  .option('--with-config', 'create a config file')
  .description('initialize a new React project')
  .action(async (name: string, opts) => {
    showBanner('init');
    await initCmd(name, opts);
  });

program
  .command('dev')
  .description('start development server (with React Fast Refresh)')
  .action(async () => {
    showBanner('dev');
    await devCmd();
  });

program
  .command('build')
  .description('build production assets')
  .action(async () => {
    showBanner('build');
    await buildCmd();
  });

program
  .command('preview')
  .description('preview production build')
  .action(async () => {
    showBanner('preview');
    await previewCmd();
  });

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red('❌ Invalid command:'), program.args.join(' '));
  console.log();
  program.outputHelp();
  process.exit(1);
});

// Entry Point (ESM-safe)
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length <= 2) {
    console.clear();
    showBanner();
    program.outputHelp();
  } else {
    program.parse(process.argv);
  }
}

export default program;
