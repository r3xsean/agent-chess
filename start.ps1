# Build the UI and start the Agent Chess server (Stockfish starts with it).
Set-Location $PSScriptRoot
npx vite build
node node_modules/tsx/dist/cli.mjs server/index.ts
