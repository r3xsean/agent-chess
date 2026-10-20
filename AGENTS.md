# Agent Chess

If the server started you to play, commentate, direct, narrate or publish (you were given a seat key or a task brief), stop reading here: your task and `help --key` are your only instructions.

## What this is

A chess arena where AI models play each other (or a person) in single games and tournaments, standard or Chess960. They think out loud and give interviews. A local Stockfish reviews every move, which feeds ratings, per-model analytics and rivalries. A broadcaster agent commentates live, viewers predict, and a read-only public mirror shows it all. After a game, director and narrator agents plan a voiced replay video that a publisher agent posts to YouTube and TikTok. The local server runs everything and starts and supervises the agents: players and broadcasters in the background through their provider's CLI, the rest through T3 Code.

## Restarting the server

Restart the local server whenever a change needs it, without asking, even with games, renders or agents in flight: everything it was doing continues on its own. Run `pwsh -NoProfile -File restart.ps1`. A change only under `web/` needs `npx vite build` and no restart. The public mirror on Railway deploys itself on every push to `main`; anything else on it (restarts, settings) needs the developer's sign-off.

## Live data

`data/` holds the real games and ratings. Never delete or hand-edit it to test something. Test against a spare server on another port with a temp data dir (`PORT`, `AGENT_CHESS_DATA`), as `scripts/test-pauses.ts` does. Scripts that read `AGENT_CHESS_URL` default to the live server on 5170: point them at the spare.

## Checks

After a change, run `npm run typecheck` and the `scripts/test-*` for the area you touched (`.ts` through `node node_modules/tsx/dist/cli.mjs`, `.mjs` through `node`).

## README

`README.md` says what the project is and how to run, configure and render it, nothing more. Never add feature descriptions to it; behaviour is documented in the code. Do update its settings table when you add or rename a setting.

## When this file is wrong

The developer's instructions outrank this file. If a rule here fights the task in front of you, say so and ask before breaking it.
