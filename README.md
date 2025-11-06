[![npm](https://img.shields.io/npm/v/react-client.svg)](https://www.npmjs.com/package/react-client)
[![npm](https://img.shields.io/npm/dt/react-client.svg)](https://npm-stat.com/charts.html?package=react-client)
[![GitHub issues](https://img.shields.io/github/issues/venkateshsundaram/react-client.svg)](https://github.com/venkateshsundaram/react-client/issues)

react-client is a lightweight CLI and runtime for building React apps with fast iteration. It is designed to be esbuild-based, Node-native, and modular like Vite/Next.js while remaining minimal.

## Table of Contents
- [Installation](#installation)
- [Wiki](#wiki)
- [Available templates](#available-templates)
- [Features supported by the CLI](#features-supported-by-the-cli)
- [Template specifics](#template-specifics)
   * [react-ssr-ts](#react-ssr-ts)
   * [react-tailwind-ts](#react-tailwind-ts)
- [How the CLI wires features](#how-the-cli-wires-features)
- [Local testing checklist](#local-testing-checklist)
- [Troubleshooting](#troubleshooting)
- [Extending & Contributing](#extending-contributing)
- [Contributing](#contributing)
- [Publishing](#publishing)
- [Feedbacks and Issues](#feedbacks-and-issues)
- [License](#license)

## Installation

The React-client package lives in npm.

To install the latest stable version, run the following command:

```bash
npm install -g react-client
react-client init myapp --template react-ts
cd myapp
npm run dev
```

## Wiki

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/venkateshsundaram/react-client)

## Available templates

- react — JavaScript SPA
- react-ts — TypeScript SPA
- react-ssr — JavaScript SSR app
- react-ssr-ts — TypeScript SSR app
- react-tailwind — JavaScript + Tailwind
- react-tailwind-ts — TypeScript + Tailwind

## Features supported by the CLI

- React Fast Refresh: HMR that preserves component state
- PostCSS/Tailwind auto-injection and setup for Tailwind templates
- CSS Modules support with hashing and AST-based import rewriting
- Asset hashing and manifest generation for SSR runtime lookups
- Plugin hook system (configResolved, transform, buildEnd)
- Generators: component/route/test scaffolding
- SSR runtime with server that consults manifest.json

## Template specifics

### react-ssr-ts

- `src/entry-client.tsx` — client hydration entry
- `src/entry-server.tsx` — server rendering entry (exports `render(url)`)
- `src/pages/` — route components
- `index.html` — template used by build system
- `package.json` lists devDependencies required for local testing (esbuild, react-refresh)

### react-tailwind-ts

- `postcss.config.cjs` and `tailwind.config.cjs` included
- `src/index.css` with Tailwind directives
- `package.json` includes tailwind/postcss devDependencies (install locally in the app)

## How the CLI wires features

1. **HMR & React Refresh**: dev plugin injects `import '/@react-refresh-shim'` into files that import React. During build, the CLI attempts to `require.resolve('react-refresh/runtime')` and copy it into the client vendor folder to be included in bundles.
2. **CSS Modules**: build step uses `postcss-modules` to produce JSON class maps and then uses `es-module-lexer` + `magic-string` to rewrite `.module.css` import specifiers to the hashed filenames emitted by the bundler.
3. **Manifest**: after building, the CLI hashes outputs and writes `client/manifest.json` mapping original -> hashed filenames. The SSR server uses this manifest to serve correct hashed assets and update HTML script tags dynamically.
4. **PostCSS/Tailwind**: if `postcss.config.cjs` or `tailwind.config.cjs` exists in the project, the build process runs `npx postcss` to process CSS and includes the output in the final client bundle.

## Local testing checklist

1. Node 20+ installed.
2. Scaffold a new app using the CLI `init` command pointing to these templates.
3. `npm install` in the new app to get dependencies.
4. Run `node /path/to/react-client/dist/cli/index.js dev` for HMR-enabled dev server, or `build:ssr` to produce SSR build and run `node dist/server/server.js` to preview.

## Troubleshooting

- If `react-refresh/runtime` isn't found during build, install in the environment running the CLI:
  ```bash
  npm install --save-dev react-refresh
  ```
- For PostCSS/Tailwind errors, ensure tailwind & postcss installed in the target app:
  ```bash
  npm install --save-dev tailwindcss postcss autoprefixer
  ```
- For AST rewriting, ensure `es-module-lexer` and `magic-string` are installed where the CLI runs:
  ```bash
  npm install --save-dev es-module-lexer magic-string
  ```

## Extending & Contributing

- Add plugins under `src/plugins` with `configResolved` and `transform` hooks.
- Tests: add Jest configurations inside templates and include `test` npm scripts.

## Contributing

Development of react-client happens in the open on GitHub, and we are grateful to the community for contributing bugfixes and improvements. Read below to learn how you can take part in improving react-client.

- [Contributing Guide](./CONTRIBUTING.md)

## Publishing

Before pushing your changes to Github, make sure that `version` in `package.json` is changed to newest version. Then run `npm install` for synchronize it to `package-lock.json` and `pnpm install` for synchronize it to `pnpm-lock.yaml`

## Feedbacks and Issues

Feel free to open issues if you found any feedback or issues on `react-client`. And feel free if you want to contribute too! 😄

## License

React-client is [MIT licensed](./LICENSE).
