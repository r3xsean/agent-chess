# Agent Chess

A local chess.com-style arena where AI agents (Claude, Codex) play each other, think out loud on every move, show their calculations (click a line to watch it played on the board), get a live Stockfish game review (Brilliant → Blunder, accuracy, estimated rating), give pre- and post-game interviews, keep a journal across games, and get commentated live by a broadcaster agent. Games can be standard chess or Chess960, players can have a personality or play as themselves, ratings are Glicko-2, and a read-only public mirror lets anyone watch and predict.

## Run it

```powershell
cd C:\Users\User\agent-chess
.\start.ps1            # builds the UI and starts the server
```

Then open http://127.0.0.1:5170.

## Play a game

1. Click **New game**, pick a model, effort and personality for each side (**No personality** is the control group: the model plays as itself), optionally turn on **Chess960** (random or chosen start position 0–959), and turn the broadcaster on or off.
2. Copy the phrase it shows (e.g. `summon chess game gk12ab34`) into your Claude chat in T3 Code. Claude follows `.claude/skills/agent-chess/SKILL.md`: it delegates White, Black and the broadcaster as child tasks and supervises them.
3. Watch on the board. Tabs: **Thinking** (commentary, self-eval vs engine, calculation lines), **Moves**, **Studio** (interviews and the broadcaster's commentary), **Review** (eval graph, accuracy, classifications), **Predict** (call the result, guess the next move).

Tournaments: **Tournament** → add players (model × effort × personality) → copy `run chess tournament <id>` into chat. Games run round-robin, as many at once as the players fill (half of them, rounded down), and no model is ever in two rated games at the same time, in or out of the tournament (unrated games don't count, so a model playing a casual unrated game can still play its tournament games); pass `boards` when creating one through the API to play fewer at once (`boards: 1` for one at a time). Ratings update after every game, unless the tournament (or a single game, or a game against an agent) was set up with **Rated** off: an unrated game changes no rating and no leaderboard record. A Chess960 tournament gives each pairing its own start position (the return game of a double round-robin replays it with colours swapped).

**Ratings** are [Glicko-2](https://www.glicko.net/glicko/glicko2.pdf), one rating period per game (as on lichess), rebuilt from the game history at every start. The leaderboard shows each rating with its deviation; above ±110 it's marked provisional (`?`).

## What the agents see

Only what a human sees on chess.com: the board (text diagram from their side, plus a piece list), FEN, last move, check, captured pieces and material count, the last ten moves, and draw offers. No legal-move list, no engine. Illegal moves are rejected with just "Illegal move." and shown to the audience. Fair play is enforced by prompt (agents have a shell, so they could in principle cheat).

A turn is one command: the move goes in as JSON on standard input, and the command waits (up to 5 minutes) and prints whatever needs the agent next, so a player never spends a step on a separate `wait` or on writing a file. Every model step re-reads the agent's whole conversation, so fewer steps is most of what a game costs. The post-game interview, journal and lessons go in together (`postgame`); the broadcaster's `say` waits on for the next events the same way, and quiet moves reach it three at a time (or after 90 s), with any big moment at once.

## Layout

| Path | What |
| --- | --- |
| `server/` | Express server: game state, agent API, Stockfish, classification, Glicko-2, predictions, public mirror, PGN |
| `cli/chess.mjs` | The only interface agents use (`wait`, `move`, `interview`, `postgame`, `bc-wait`, `say`, …) |
| `web/` | React + chessground UI |
| `shared/` | Types, rules (chess.js for standard, chessops for Chess960), personalities, model list, eval math |
| `vendor/` | Stockfish 19, lichess opening book, sound effects (git-ignored except openings and sfx) |
| `data/` | Games, players, journals, lessons, predictions (git-ignored) |

Environment knobs: `PORT` (5170), `ENGINE_DEPTH` (22), `ENGINE_MAX_MS` (12000), `ENGINE_THREADS` (8).

## Viewer predictions

Every live game has a **🔮 Predict** tab. Viewers call the result until move 10 (10 points if right) and guess each next move by playing it on the board (3 points per correct guess). Viewers are anonymous (a random id kept in the browser) with an editable name; the lobby shows the top predictors. Points are always worked out from the games, so nothing is scored twice.

## The public site

The public site is a read-only mirror of this one, running the same server with `PUBLIC_MODE=1` (see `Dockerfile`; it's deployed on Railway with a volume at `/data`). Games are still played here: the local server pushes every change to the mirror, and the mirror lets anyone watch, browse players, memory and agents (with their personalities), and make predictions. It runs no engine, agents or renders, refuses everything else that writes, and rate-limits viewers.

To connect the local server to a mirror, create `data/mirror.json`:

```json
{ "url": "https://agent-chess-production.up.railway.app", "secret": "<the mirror's MIRROR_SECRET>" }
```

(or set `MIRROR_URL` and `MIRROR_SECRET`). On start it sends everything, then each change within a couple of seconds, retrying if the mirror is unreachable. With a mirror configured, the local site's prediction tab talks to the mirror too, so local and public viewers share one crowd. On the public site the viewer's analysis board shows the engine only for positions the games already analysed.

## Video replays

Any finished game can be exported as a video: 16:9 for YouTube and 9:16 for TikTok. Click 🎬 on the game page to preview it in the browser (space to play, ←/→ to skip). To render MP4s:

```powershell
npm run video -- <gameId>            # both formats → <id>-youtube.mp4, <id>-tiktok.mp4 in the game's folder
npm run video -- <gameId> --format portrait --music path\to\track.mp3
```

Each game's videos get their own folder under `data/videos/`, named for the day and the players, with the game id at the end: `2026-10-17 GPT-6 Astra vs Opus 5.5 (g7lto2a464)/`. The files in it keep the id too (`g7lto2a464-youtube.mp4`). Videos rendered before this were all in `data/videos/` itself; the server moves them into their game's folder when it starts.

**What's in it:**
- The board, eval bar and each player's clock.
- Move verdicts, and the engine's preferred move and line.
- The eval chart, with each player's own evaluation.
- Illegal move attempts, draw offers and resignations.
- The best line from each pre- and post-game interview.
- On misjudged moments, what the mover thought next to what the engine says.
- The series between the two models ("Revenge match · Opus leads 2–0").

The video slows down only for the key moments. On those, the mover's own words appear in a speech bubble before the move (`--thoughts off` skips them), and the banner shows how long they thought. A thought never covers the board. In the YouTube cut it's a bright bubble under the move list that opens to fit the line, the list making room and the panel dimming while the game stops for it, and closes after. In the short, a thought takes the space above the board.

Between the key moments, the players keep talking with **asides**: short lines from their commentary, spoken in their voice (15% quicker than the other lines, time-stretched with the pitch kept) while the moves play on. They look like what they are, comments in an annotated game. Each is a dark row in the move list under the move it's from, behind a rule in the speaker's colour. It folds open as it's said and scrolls up with the list as moves come, so it never reads as a stop. The YouTube cut has all of them. The short has the ones the director marks for it, in place of the eval chart. The director opens with a short exchange of asides, so the opening has the two of them talking. A move with an illegal attempt gets one too (usually the player owning up to it), said while the rejected move is on the board. An aside is said as its move lands, never before, and the board plays on under it. So asides are lines that stay true while the board moves on: a plan, a verdict, a worry, a read on the opponent. They're never about the move itself. A thought about a single move is a moment, where the game stops for it. An aside that runs into the next moment holds the board until it's said. When the director submits a plan, the server times both cuts, estimating how long each line takes to say. It sends the plan back with every stretch where nothing is said for more than 20 seconds (12 in the short), unless the director marks the stretch as quiet on purpose because nothing said there lasts beyond its own move. The plan's readback flags asides that name a move or a capture, so the director checks they still hold. A quiet move holds for as long as the next player took to think, compared with the game's other quiet moves, with their clock running through the hold: a 2-minute think lingers and a quick reply flies by, while the total length stays about the same.

**Who picks the key moments:** after the game, the broadcaster turns director. It reads the whole game and picks those moments, plus the interview lines (`server/director.ts`). It also picks a cold open (the videos start on the payoff, then rewind), chapter titles, the YouTube title, the TikTok caption and the thumbnail. It also draws on the board what each quote talks about, the way a streamer draws while talking through a position: moves as arrows (green for the player's side, red for the opponent's), a piece's attacks and defences as thinner arrows, and squares as rings. A line is drawn the way it's imagined: a piece that moves again goes on from where it landed, and a fork is drawn from the square the knight lands on. Each arrow snaps in as its words are said, and those words light up in the bubble. One idea builds up at a time and wipes as the next one starts (or its sentence ends), and an idea that ends on the move being played stays up until the piece goes. Moves a player looks back on are drawn from where they were played. For every word that names a square, a move or a piece, the director says what it points at (a ref); those words light up in the bubble as they're said, and everything takes its colour from what it points at on the board as the player imagines it: green for the speaker's pieces and moves, red for the opponent's, amber for an empty square, with the engine's pick in blue. The server checks every ref against the board (the piece the words name is really there, it's drawn in that idea, no word is left out) and sends the plan back with every problem; a plan that passes is read back to the director in words (each lit word and drawing, what it points at and its colour) to `confirm` or fix. `npm run test:marks` checks the drawing and lighting on positions from a real game. The timing comes from ElevenLabs' word timestamps; clips recorded before those existed are timed by their length. Its plan is saved with the game. For a game that finished without a plan, an orchestrator can launch a director from `GET /api/games/<id>/director-launch` (admin token). Add `?redo=1` to replace an existing plan. Without a plan, a fallback rule picks the moments from the engine's verdicts.

With the YouTube render come `<id>-youtube.txt` (title, caption, description with chapters) and `<id>-thumb.png`, and with each cut its subtitles (`<id>-youtube.srt`, `<id>-tiktok.srt`); the TikTok cut also leaves `<id>-tiktok-cover.png`. The render panel shows them with copy buttons.

**Voices:** in a directed video, each model speaks its own lines (quotes, asides, interview lines) in its own ElevenLabs voice (`shared/voices.ts`), with the director's delivery ("smug", "stunned") as an audio tag. Set `ELEVENLABS_API_KEY` in your environment. Lines are recorded when you render, cached under `data/voice/`, and never recorded twice. The director's plan is limited to an amount of speech that always fits, and nothing is recorded unless the account's remaining balance can be checked and covers it. If any line can't be voiced (no key, balance unknown or too low, an ElevenLabs error), the render stops and says why rather than going out half-silent. Retrying reuses what's already recorded. To render without voices on purpose, tick "Without voices" (or pass `--voices off`). The TikTok cut plays the voices slightly faster.

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
- [chessground](https://github.com/lichess-org/chessground) and [chessops](https://github.com/niklasf/chessops) (GPL-3.0-or-later), and [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause).
- [Stockfish](https://stockfishchess.org) (GPL-3.0), downloaded separately into `vendor/`.
- [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0) for opening names and book moves.
- [Kenney](https://kenney.nl) Impact Sounds, Interface Sounds and Music Jingles (CC0) for the video's sound effects.
