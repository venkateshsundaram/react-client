import path from "path";
import fs from "fs-extra";
import { pathToFileURL } from "url";
import chalk from "chalk";

export interface ReactClientConfig {
  root?: string;
  server?: { port?: number };
  build?: { outDir?: string };
  [key: string]: any;
}

/**
 * Dynamically load react-client.config.(js|mjs|ts)
 * from the user project, not the CLI’s own folder.
 */
export async function loadReactClientConfig(cwd: string): Promise<ReactClientConfig> {
  let projectRoot = cwd;

  try {
    // 🧭 Detect if running inside react-client source repo
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      if (pkgJson.name === "react-client") {
        // Running CLI locally — auto-switch into example project (if found)
        const myappPath = path.join(cwd, "myapp");
        if (fs.existsSync(myappPath)) {
          console.log(chalk.gray("🧩 Detected local CLI environment, using ./myapp as root."));
          projectRoot = myappPath;
        }
      }
    }

    // 🔍 Possible config file names (prefer .js for Node compatibility)
    const filenames = [
      "react-client.config.js",
      "react-client.config.mjs",
      "react-client.config.ts"
    ];

    let configFile: string | null = null;
    for (const name of filenames) {
      const file = path.join(projectRoot, name);
      if (fs.existsSync(file)) {
        configFile = file;
        break;
      }
    }

    if (!configFile) {
      console.log(chalk.gray("ℹ️ No react-client.config.js found, using defaults."));
      return {};
    }

    // 🧩 Import dynamically using file://
    const fileUrl = pathToFileURL(configFile).href;

    // If TypeScript file, try to compile it temporarily using esbuild
    if (configFile.endsWith(".ts")) {
      const esbuild = await import("esbuild");
      const outFile = path.join(projectRoot, ".react-client.temp.config.js");
      await esbuild.build({
        entryPoints: [configFile],
        outfile: outFile,
        format: "esm",
        platform: "node",
        bundle: true,
        write: true,
      });
      const mod = await import(pathToFileURL(outFile).href);
      await fs.remove(outFile);
      console.log(chalk.green(`🧩 Loaded config from ${path.basename(configFile)}`));
      return mod.default || mod;
    }

    // Normal .js or .mjs import
    const mod = await import(fileUrl);
    console.log(chalk.green(`🧩 Loaded config from ${path.basename(configFile)}`));
    return mod.default || mod;
  } catch (err: any) {
    console.error(chalk.red(`❌ Failed to load react-client.config: ${err.message}`));
    return {};
  }
}
