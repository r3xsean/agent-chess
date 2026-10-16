# Agent Chess

A local chess.com-style arena where AI agents (Claude, Codex) play each other, think out loud on every move, show their calculations (click a line to watch it played on the board), get a live Stockfish game review (Brilliant → Blunder, accuracy, estimated rating), give pre- and post-game interviews, keep a journal across games, and get commentated live by a broadcaster agent with Piper text-to-speech.

## Run it

```powershell
cd C:\Users\User\agent-chess
.\start.ps1            # builds the UI and starts the server
```

Then open http://127.0.0.1:5170.

## Play a game

1. Click **New game**, pick a model, effort and personality for each side, and turn the broadcaster on or off.
2. Copy the phrase it shows (e.g. `summon chess game gk12ab34`) into your Claude chat in T3 Code. Claude follows `.claude/skills/agent-chess/SKILL.md`: it delegates White, Black and the broadcaster as child tasks and supervises them.
3. Watch on the board. Tabs: **Thinking** (commentary, self-eval vs engine, calculation lines), **Moves**, **Studio** (interviews and broadcaster, with voice), **Review** (eval graph, accuracy, classifications).

Tournaments: **Tournament** → add players (model × effort × personality) → copy `run chess tournament <id>` into chat. Games run one at a time, round-robin; ratings update after every game.

## What the agents see

Only what a human sees on chess.com: the board (text diagram + PNG image from their side), FEN, last move, check, captured pieces and material count, the move list, and draw offers. No legal-move list, no engine. Illegal moves are rejected with just "Illegal move." and shown to the audience. Fair play is enforced by prompt (agents have a shell, so they could in principle cheat).

## Layout

| Path | What |
| --- | --- |
| `server/` | Express server: game state, agent API, Stockfish, classification, Piper TTS, PGN |
| `cli/chess.mjs` | The only interface agents use (`wait`, `move`, `interview`, `journal`, `bc-wait`, `say`, …) |
| `web/` | React + chessground UI |
| `shared/` | Types, personalities, model list, eval math |
| `vendor/` | Stockfish 19, Piper venv + voice, lichess opening book (git-ignored except openings) |
| `data/` | Games, players, journals, audio (git-ignored) |

Environment knobs: `PORT` (5170), `ENGINE_DEPTH` (18), `ENGINE_THREADS` (4), `PIPER_VOICE` (`en_US-ryan-high`).
