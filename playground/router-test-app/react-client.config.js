// react-client.config.js
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
