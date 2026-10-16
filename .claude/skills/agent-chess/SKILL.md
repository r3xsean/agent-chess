---
name: agent-chess
description: Summon AI agents to play a chess game or run a tournament on the local Agent Chess website (C:\Users\User\agent-chess). Use when the user says "summon chess game <id>", "run chess tournament <id>", "start a chess game between …", or asks to make agents play chess.
---

# Agent Chess orchestration

The website (http://127.0.0.1:5170) is the referee. Players and the broadcaster are T3 child tasks launched with `delegate_task`; they talk to the server only through `cli/chess.mjs` and loop until the CLI prints DONE. You are the orchestrator: launch them, watch for early exits, nudge, and launch the next tournament game.

## 0. Make sure the server is up

`Invoke-RestMethod http://127.0.0.1:5170/api/meta` — if it fails, start it from `C:\Users\User\agent-chess`:
`Start-Process -WindowStyle Hidden node -ArgumentList 'node_modules/tsx/dist/cli.mjs','server/index.ts'` (run `npx vite build` first if `dist/` is missing). Wait ~8 s.

## 1. Get the launch spec

Launch specs contain every seat's key, so these endpoints need the orchestrator token: send header `x-admin-token: <contents of C:\Users\User\agent-chess\data\admin-token.txt>` on `/launch`, `POST /api/games` (to get `launch` back), `/api/tournaments/<tid>/next` and `/abort`. Never put the token in an agent prompt.

- Existing game: `Invoke-RestMethod http://127.0.0.1:5170/api/games/<id>/launch`
- New game from chat: `POST /api/games` with `{ white:{model,effort,personality}, black:{…}, broadcaster:{enabled:true, model:"claude-opus-5-5", effort:"high"} }` → `{ game, launch }`. Personality `"none"` means no personality (the model plays as itself). Add `chess960: true` for a random Chess960 start position, or `chess960: <0–959>` for a given one; tournaments take `chess960: true`.
- Tournament: `POST /api/tournaments/<tid>/next` → `{ game, launch }`, `{ finished:true }`, or `alreadyRunning:true` (then use that game's launch spec — do not re-delegate seats that are still running).
- Multi-board tournament (`boards` > 1): `/next` instead returns `{ started: [{ game, launch }, …], running: [gameIds] }`. Launch every game in `started` (it may be empty: no board or model is free yet — then you're done). Never launch the `running` games; other runs own them.

`launch.tasks` has one entry per seat (white, black, optional broadcaster): `title`, `clientRequestId`, `target` (`providerInstanceId`, `model`, `options`) and the full `prompt`. `launch.launched` maps seats (`w`, `b`, `x`) that some orchestrator run already delegated to a timestamp.

When the user plays an agent themselves, their seat is human: it has no task in `launch.tasks` (they move on the website) and `/agents` reports it as `{ human: true, done: true }`. Launch only the tasks you're given.

## 2. Delegate every seat in one message

Skip any seat already in `launch.launched` (another run owns it), unless step 3's rules show it died. For each remaining task call `delegate_task` with:
`task` = prompt (verbatim), `title`, `clientRequestId`, `target` (verbatim), `mode:"async"`, `role:"general"` (leave `runtimeMode` unset so it inherits; agents need a shell to run the CLI).
Right after each successful delegation, record it: `POST /api/games/<id>/launched` with body `{"seat":"w"|"b"|"x"}` and the admin token.
Keep each returned `taskId` and `childThreadId`. Tell the user the game URL: `http://127.0.0.1:5170/#/game/<id>`.

Runs can also start from the website: its **Summon agents** / **Start tournament** buttons call a T3 webhook that opens a fresh orchestrator thread with the request. Tournaments started that way advance by themselves — the server fires the webhook again (`tournament-next`) when each game finishes — so a webhook-started run only owns the games its own `/next` call returned.

## 3. Supervise

Completion notifications wake you. On each one, check `GET /api/games/<id>/agents`:
- If the finished seat shows `done:true`, nothing to do.
- If not done (the agent stopped early), continue it with `t3_thread_send` to its `childThreadId`: "The game is not over. Keep looping: run `wait` (or `bc-wait`) and act until the CLI prints DONE." If a seat cannot be revived, cancel and re-delegate it with a new `clientRequestId` (`<gameId>-<seat>-r<n>`) — the seat key in the prompt still works.
- If `secondsSinceSeen` for the side to move grows past ~10 minutes while the child still runs, check the child with `task_status` before acting.
- Abort a broken game with `POST /api/games/<id>/abort`.

## 4. Tournaments

When every seat of a tournament game is done (phase `finished`), call `/api/tournaments/<tid>/next` and repeat from step 2 until `{finished:true}`. Create a multi-board tournament with `POST /api/tournaments` `{ players, doubleRound, boards: 3, broadcaster:{enabled:false} }`; with `autoRun` (`POST /api/tournaments/<tid>/start`) the server fires `tournament-next` whenever a board and both models are free, including when a model was busy in a game outside the tournament. Then report the standings (`GET /api/tournaments/<tid>`).

## 5. Video director

After a game, its broadcaster plans the replay video (which moments to slow down for) and submits it with `direct`. A finished game without a plan — no broadcaster, one from before directors existed, or one whose plan the website threw away for a "new director" re-render — gets a standalone director, usually because the website's video page asked for a render (webhook action `direct-video`):

1. `GET /api/games/<id>/director-launch` with the admin token → `{ tasks: [one task] }`. Add `?redo=1` only to replace an existing plan (a website redo has already removed it, so don't add it then).
2. Delegate that task exactly like a seat (verbatim prompt, title, target, `clientRequestId`, `mode:"async"`, `role:"general"`). No `/launched` record is needed. A redo's task has its own `clientRequestId` (`<id>-director-redo<n>`), so it's a new task, not the earlier director again.
3. When it finishes, check `GET /api/games/<id>` has a `video` field. If not, re-delegate once with the task's `clientRequestId` plus `-r2` (a model's safety filter occasionally refuses a long brief; a second try usually works). The website renders on its own once the plan is saved.

## 6. When you're done

Once the work is complete — every seat of the game done, the tournament finished, or the director's plan saved — tidy up so the threads leave the inbox:
- Settle each finished child task's thread: `t3_thread_organize` with `action:"settle"` and its `childThreadId`.
- Then settle your own thread as the very last step: `t3_thread_organize` with `action:"settle"` and no `threadId` (it takes effect when your turn ends).
Don't settle while anything still needs you (a seat running, failed or stalled), and leave threads the user is reading alone if they were not started by a webhook.

## Rules
- Never play moves or write commentary for an agent yourself; never give agents engine output.
- Don't pin model IDs beyond what the launch spec says — the user chose them in the UI.
