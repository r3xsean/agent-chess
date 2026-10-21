---
name: agent-chess
description: Start a chess game or tournament between AI agents on the local Agent Chess website (C:\Users\User\agent-chess) from chat, as their orchestrator. Use when the user says "summon chess game <id>", "run chess tournament <id>", "start a chess game between …", or asks to make agents play chess. Not for agents already playing in a game (players, directors): they follow only their own prompt.
---

# Agent Chess: games and tournaments from chat

The website (http://127.0.0.1:5170) is the referee. You are the orchestrator: the server writes your brief for each job (the agents to launch, with their prompts, and how to look after them), and you follow it. Every request below needs the header `x-admin-token: <contents of C:\Users\User\agent-chess\data\admin-token.txt>`. Never put the token in an agent's prompt.

## 1. Make sure the server is up

`Invoke-RestMethod http://127.0.0.1:5170/api/meta`. If that fails, start it from `C:\Users\User\agent-chess`: `Start-Process -WindowStyle Hidden node -ArgumentList 'node_modules/tsx/dist/cli.mjs','server/index.ts'` (run `npx vite build` first if `dist/` is missing), then wait about 8 s.

## 2. Get the game or tournament

- An existing game or tournament: use the id the user gave.
- A new game: `POST /api/games` with `{ white:{model,effort}, black:{…} }`. Add `chess960: true` for a random Chess960 start (or `chess960: <0–959>` for a given one), `opening: true` to start from the set opening (shared/openingSuite.ts) these two have played least (or `opening: "<id>"` for a given one), or `rated: false` if the user wants it unrated. Use the models and efforts the user asks for, and don't pick model IDs for them.
- A new tournament: `POST /api/tournaments` with `{ players:[{model,effort},…], doubleRound }`. It plays as many games at once as the players fill (half of them) unless you pass a lower `boards` (`1` plays one game at a time). `chess960: true` and `rated: false` work as for games; `openings: "each"` gives every pairing a set opening (a double round-robin's return game replays it with colours swapped), `openings: "<id>"` starts every game from that one.

## 3. Get your brief and follow it

`POST /api/orchestrator/brief` with `{ "action": "start-game", "gameId": "<id>", "source": "chat" }`, or `{ "action": "tournament-next", "tournamentId": "<id>", "source": "chat" }` for a tournament. It returns plain text with the tasks to delegate and every step after: launching, supervising, and when you're done. A game's video director is never started on its own: only when the user asks for one. Do exactly what it says.

For a tournament, the brief says how to carry on to the next games, whether the website runs it by itself or you call `tournament-next` again.
