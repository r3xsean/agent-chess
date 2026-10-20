# Build the UI and start the Agent Chess server (Stockfish starts with it), in the foreground.
# To restart the background server instead (stopping the running one first), run restart.ps1.
Set-Location $PSScriptRoot
npx vite build
node node_modules/tsx/dist/cli.mjs server/index.ts
