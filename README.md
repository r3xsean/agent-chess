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

Environment knobs: `PORT` (5170), `ENGINE_DEPTH` (22), `ENGINE_MAX_MS` (12000), `ENGINE_THREADS` (8), `PIPER_VOICE` (`en_US-ryan-high`).

## Video replays

Any finished game can be exported as a video: 16:9 for YouTube and 9:16 for TikTok. Click 🎬 on the game page to preview it in the browser (space to play, ←/→ to skip). To render MP4s:

```powershell
npm run video -- <gameId>            # both formats → data/videos/<id>-youtube.mp4, <id>-tiktok.mp4
npm run video -- <gameId> --format portrait --music path\to\track.mp3
```

**What's in it:**
- The board, eval bar and each player's clock.
- Move verdicts, and the engine's preferred move and line.
- The eval chart, with each player's own evaluation.
- Illegal move attempts, draw offers and resignations.
- The best line from each pre- and post-game interview.

The video slows down only for the key moments. On those, the mover's own words appear as a speech bubble before the move (`--thoughts off` skips them), and the banner shows how long they thought.

**Who picks the key moments:** after the game, the broadcaster turns director. It reads the whole game and picks those moments, plus the interview lines (`server/director.ts`). Its plan is saved with the game. For a game that finished without a plan, an orchestrator can launch a director from `GET /api/games/<id>/director-launch` (admin token). Add `?redo=1` to replace an existing plan. Without a plan, a fallback rule picks the moments from the engine's verdicts.

The broadcaster's own lines aren't in the video. They trail the moves they describe, so they'd be out of sync.

**Sound:**
- Sound effects come from `vendor/sfx/`: Kenney's CC0 packs, named `<event>_<n>.ogg`.
- Music comes from `--music`, or the first track in `vendor/music/` (git-ignored), and dips under the effects. `--audio-only` redoes just the sound of an existing render.

**Requirements:** the renderer drives headless Chrome (or Edge) and needs `ffmpeg` on the PATH.

## Move classification

Moves are rated by how much of the mover's winning chances they give up, using the same bands chess.com publishes for its expected-points model: Best (nothing lost), Excellent (up to 2%), Good (up to 5%), Inaccuracy (up to 10%), Mistake (up to 20%), Blunder (more). **Brilliant** and **Great** follow [WintrChess](https://github.com/WintrCat/wintrchess)'s rules (`server/wintr.ts`): a Brilliant is a sound piece sacrifice whose capture doesn't simply hand material back, played when you wouldn't be completely winning anyway; a Great is the only move that keeps the advantage. `scripts/test-brilliant.mjs` checks them against Morphy's Opera Game and the Légal trap.

## License

Agent Chess is free software under the [GNU General Public License v3.0 or later](LICENSE).

Credits:
- [WintrChess](https://github.com/WintrCat/wintrchess) by WintrCat (GPL-3.0) — Brilliant/Great detection in `server/wintr.ts` is adapted from its reporter.
- [chessground](https://github.com/lichess-org/chessground) (GPL-3.0-or-later) and [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause).
- [Stockfish](https://stockfishchess.org) (GPL-3.0), downloaded separately into `vendor/`.
- [Piper](https://github.com/OHF-Voice/piper1-gpl) text-to-speech (GPL-3.0-or-later), downloaded separately into `vendor/`.
- [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0) for opening names and book moves.
- [Kenney](https://kenney.nl) Impact Sounds, Interface Sounds and Music Jingles (CC0) for the video's sound effects.
