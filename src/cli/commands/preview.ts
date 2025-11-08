import connect from 'connect';
import serveStatic from 'serve-static';
import http from 'http';
import path from 'path';
import detectPort from 'detect-port';
import prompts from 'prompts';
import chalk from 'chalk';
import open from 'open';
import fs from 'fs-extra';
import { loadReactClientConfig } from '../../utils/loadConfig';

export default async function preview() {
  const root = process.cwd();
  const config = await loadReactClientConfig(root);
  const appRoot = path.resolve(root, config.root || '.');
  const outDir = path.join(appRoot, config.build?.outDir || '.react-client/build');
  const defaultPort = config.server?.port || 5173;

  if (!fs.existsSync(outDir)) {
    console.error(chalk.red(`❌ Build output not found at: ${outDir}`));
    console.log(chalk.gray('Please run `react-client build` first.'));
    process.exit(1);
  }

  const availablePort = await detectPort(defaultPort);
  let port = availablePort;

  if (availablePort !== defaultPort) {
    const res = await prompts({
      type: 'confirm',
      name: 'useNewPort',
      message: `Port ${defaultPort} is occupied. Use ${availablePort} instead?`,
      initial: true,
    });
    if (!res.useNewPort) {
      console.log(chalk.red('🛑 Preview server cancelled.'));
      process.exit(0);
    }
  }

  const app = connect();
  app.use(serveStatic(outDir));

  const server = http.createServer(app);
  server.listen(port, async () => {
    const url = `http://localhost:${port}`;
    console.log(chalk.green(`\n🌐 Preview server running at ${url}`));
    if (port !== defaultPort) {
      console.log(chalk.yellow(`⚠️ Using alternate port (default ${defaultPort} was occupied).`));
    }
    await open(url, { newInstance: true });
  });

  process.on('SIGINT', () => {
    console.log(chalk.red('\n🛑 Shutting down preview server...'));
    server.close();
    process.exit(0);
  });
}
