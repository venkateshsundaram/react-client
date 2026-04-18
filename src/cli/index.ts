#!/usr/bin/env node
// test comment for husky
import { dirname, resolve } from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import { fileURLToPath, pathToFileURL } from 'url';

import initCmd from './commands/init.js';
import type { InitOptions } from './types';
import devCmd from './commands/dev.js';
import buildCmd from './commands/build.js';
import previewCmd from './commands/preview.js';
import generateCmd from './commands/generate.js';

// Polyfill for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load package.json version dynamically
const pkgPath = resolve(__dirname, '../../package.json');
const isMainModule =
  process.argv[1] &&
  (pathToFileURL(process.argv[1]).href === import.meta.url ||
    pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url);

const pkg = fs.existsSync(pkgPath)
  ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  : { version: '0.0.0' };

// 🧠 Fancy startup banner
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
    case 'generate':
      console.log(chalk.magenta('✨ Generating scaffold...\n'));
      break;
    default:
      console.log();
  }
}

// 🧩 Commander setup
const program = new Command();

program
  .name('react-client')
  .description('react-client CLI – A lightweight React toolkit for fast builds & dev server')
  .version(pkg.version, '-v, --version', 'display version information');

// ------------------------------------------------------
// CLI Commands
// ------------------------------------------------------

program
  .command('init <name>')
  .option('-t, --template <template>', 'choose a template', 'react-ts')
  .option('--with-config', 'create a config file')
  .description('initialize a new React project')
  .action((name: string, opts: InitOptions) => {
    showBanner('init');
    initCmd(name, opts);
  });

program
  .command('dev')
  .description('start dev server (with React Fast Refresh)')
  .action(() => {
    showBanner('dev');
    devCmd();
  });

program
  .command('build')
  .description('build production assets')
  .action(() => {
    showBanner('build');
    buildCmd();
  });

program
  .command('preview')
  .description('preview production build')
  .action(() => {
    showBanner('preview');
    previewCmd();
  });

const generate = program
  .command('generate')
  .description('generate project scaffolds (route, component, etc.)');

generate
  .command('route <name>')
  .description('generate a new route with react-router-dom')
  .action((name: string) => {
    showBanner('generate');
    generateCmd.route(name);
  });

generate
  .command('component <name>')
  .description('generate a new React component')
  .action((name: string) => {
    showBanner('generate');
    generateCmd.component(name);
  });

// ------------------------------------------------------
// Default / Unknown command handling
// ------------------------------------------------------
program.on('command:*', () => {
  console.error(chalk.red('❌ Invalid command:'), program.args.join(' '));
  console.log();
  program.outputHelp();
  process.exit(1);
});

// ------------------------------------------------------
// Entry point
// ------------------------------------------------------
if (isMainModule) {
  if (process.argv.length <= 2) {
    console.clear();
    showBanner();
    program.outputHelp();
  } else {
    program.parse(process.argv);
  }
}
export default program;
