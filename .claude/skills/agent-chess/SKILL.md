---
name: agent-chess
description: Start a chess game or tournament between AI agents on the local Agent Chess website (C:\Users\User\agent-chess) from chat. Use when the user says "summon chess game <id>", "run chess tournament <id>", "start a chess game between …", or asks to make agents play chess. Not for agents already playing in a game (players, directors): they follow only their own prompt.
---

# Agent Chess: games and tournaments from chat

The website (http://127.0.0.1:5170) runs everything: it launches the players, looks after them and plays a tournament's games through to the end. Your job is to create the game or tournament and hand it over, the same as the website's buttons do.

## 1. Make sure the server is up

`Invoke-RestMethod http://127.0.0.1:5170/api/meta`. If that fails, run `pwsh -NoProfile -File C:\Users\User\agent-chess\restart.ps1`.

## 2. Get the game or tournament

- An existing game or tournament: use the id the user gave.
- A new game: `POST /api/games` with `{ white:{model,effort}, black:{…} }`. Add `chess960: true` for a random Chess960 start (or `chess960: <0–959>` for a given one), `opening: true` to start from the set opening (shared/openingSuite.ts) these two have played least (or `opening: "<id>"` for a given one), or `rated: false` if the user wants it unrated. Use the models and efforts the user asks for, and don't pick model IDs for them.
- A new tournament: `POST /api/tournaments` with `{ players:[{model,effort},…], doubleRound }`. It plays as many games at once as the players fill (half of them) unless you pass a lower `boards` (`1` plays one game at a time), and `breakHours: <n>` rests that long after each batch of games before starting the next. `chess960: true` and `rated: false` work as for games; `openings: "each"` gives every pairing a set opening (a double round-robin's return game replays it with colours swapped), `openings: "<id>"` starts every game from that one.

## 3. Hand it to the server

`POST /api/games/<id>/summon` for a game, `POST /api/tournaments/<id>/start` for a tournament. Once it answers `ok`, give the user the link to watch (http://127.0.0.1:5170/#/game/<id> or http://127.0.0.1:5170/#/tournament/<id>) and you're done: the server looks after the games from here, so don't watch them.
