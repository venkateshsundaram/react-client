# ⚡ react-client

[![npm](https://img.shields.io/npm/v/react-client.svg)](https://www.npmjs.com/package/react-client)
[![npm](https://img.shields.io/npm/dt/react-client.svg)](https://npm-stat.com/charts.html?package=react-client)
[![GitHub issues](https://img.shields.io/github/issues/venkateshsundaram/react-client.svg)](https://github.com/venkateshsundaram/react-client/issues)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**react-client** is a lightweight, ultra-fast CLI and runtime for building React applications. Built for speed, it focuses on providing an instant development experience without the overhead of traditional bundlers.

---

## 🚀 Why react-client?

- 💨 **Instant Startup**: No more waiting for slow bundles. Start your dev server in milliseconds.
- 🔄 **State-Preserving HMR**: React Fast Refresh keeps your application state across code changes.
- 🎨 **Beautiful Error Overlay**: High-fidelity, syntax-highlighted error overlay with clickable file links.
- 🗺️ **Source Map Support**: Runtime errors map directly back to your original source code.
- 🔌 **Plug & Play**: Designed to work out of the box with zero configuration, yet highly extensible.

---

## 📋 Table of Contents

- [Quick Start](#-quick-start)
- [Available Templates](#-available-templates)
- [CLI Command Reference](#-cli-command-reference)
- [Configuration Reference](#-configuration-reference)
- [Core Features](#-core-features)
- [Local Development](#-local-development)
- [Contributing](#-contributing)
- [License](#-license)

---

## ⚡ Quick Start

Create and launch your first app in seconds:

```bash
# install globally
npm install -g react-client

# initialize your project
react-client init my-app --template react-ts

# start developing
cd my-app
npm install
npm run dev
```

Your app will be live at `http://localhost:2202`!

---

## 🧰 Available Templates

Choose from a variety of pre-configured templates to jumpstart your project:

| Template | Description | Tech Stack |
| :--- | :--- | :--- |
| `react` | Basic JavaScript setup | JS, React 18 |
| `react-ts` | TypeScript-first setup | TS, React 18 |
| `react-tailwind` | JS with Tailwind CSS | JS, React, Tailwind |
| `react-tailwind-ts` | TS with Tailwind CSS | TS, React, Tailwind |

> [!TIP]
> Use the `--template` flag with `init` to specify your preferred starting point.

---

## 🛠️ CLI Command Reference

### `init <project-name>`
Scaffold a new React application.

- `--template <name>`: Choose a template (default: `react-ts`).
- `--with-config`: Generate a `react-client.config.js` file.

### `dev`
Start the development server with Hot Module Replacement (HMR).

- Uses port `2202` by default (auto-detects and prompts if occupied).
- Features on-the-fly esbuild transformations.

### `build`
Bundle your application for production.

- Optimized output in `.react-client/build` (default).
- Incremental rebuild support.

### `preview`
Serve your production build locally for final verification.

---

## ⚙️ Configuration Reference

For more advanced control, generate a configuration file:

```bash
react-client init myapp --with-config
```

### `react-client.config.js`

```javascript
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

  // 🔌 Plugins
  plugins: [],
});
```

| Property | Description | Default |
| :--- | :--- | :--- |
| `root` | The application's root directory | `.` |
| `server.port` | The dev server port | `2202` |
| `build.outDir` | Production build output directory | `.react-client/build` |
| `plugins` | Array of react-client plugins | `[]` |

---

## 💎 Core Features

### 🔄 React Fast Refresh
Experience true Hot Module Replacement that preserves your component state during development. No more manual page reloads when you fix a bug.

### 💥 Interactive Error Overlay
When something goes wrong, you get a beautiful, clear overlay.
- **Syntax Highlighting**: Easily read the problematic code.
- **Click-to-Open**: File links open directly in VS Code (`vscode://file/...`).
- **Mapped Stacks**: Errors point to your original TSX/JSX lines, not the bundled output.

### ⚡ esbuild Powered
We use esbuild for lightning-fast compilation, ensuring that even large applications stay responsive during development.

---

## 🧪 Local Development

To contribute or test locally:

1. Clone the repository
2. Build the project: `npm run build`
3. Link globally: `npm link`
4. Test in a separate folder:
   ```bash
   mkdir test-app && cd test-app
   react-client init demo
   ```

---

## 🤝 Contributing

We welcome all contributions! Whether it's adding new templates, fixing bugs, or improving documentation.

Please check our [Contributing Guide](./CONTRIBUTING.md) to get started.

---

## 💬 Feedback

Found an issue or have a feature request?
👉 [Open an issue on GitHub](https://github.com/venkateshsundaram/react-client/issues)

---

## 🪪 License

**MIT Licensed** © [Venkatesh Sundaram](https://github.com/venkateshsundaram)

