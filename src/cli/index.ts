#!/usr/bin/env node
import { Command } from 'commander';
import initCmd from './commands/init';
import generateCmd from './commands/generate';
import devCmd from './commands/dev';
import buildCmd from './commands/build';
import buildSsrCmd from './commands/build.ssr';
import previewCmd from './commands/preview';
const program = new Command();
program.name('react-client').version('1.0.0').description('react-client CLI');
program
  .command('init <name>')
  .option('-t,--template <template>', 'template', 'react-ts')
  .option('--with-config', 'create config')
  .action((name, opts) => initCmd(name, opts));
program
  .command('generate <kind> <name>')
  .option('-p,--path <path>', 'path')
  .option('--no-ts', 'generate JS')
  .option('-f,--force', 'force')
  .action((k, n, o) => generateCmd(k, n, o));
program
  .command('dev')
  .description('start dev server')
  .action(() => devCmd());
program
  .command('build')
  .description('build app')
  .action(() => buildCmd());
program
  .command('build:ssr')
  .description('build ssr')
  .action(() => buildSsrCmd());
program
  .command('preview')
  .description('preview build')
  .action(() => previewCmd());
// Only parse argv when executed directly as a CLI, not when imported by tests or other code.
if (require.main === module) {
  program.parse(process.argv);
}
export default program;
