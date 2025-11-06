#!/usr/bin/env bash
set -e
echo "Local checks for react-client"
echo "1) Ensure Node 20+"
echo "2) npm install"
echo "3) npm run compile (if you have TS)"
echo "4) Scaffold sample app: node dist/cli/index.js init sample-ssr --template react-ssr --with-config"
echo "5) Build SSR: cd sample-ssr && npm install && node /path/to/react-client/dist/cli/index.js build:ssr"
