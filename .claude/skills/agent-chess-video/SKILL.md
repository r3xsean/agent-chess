---
name: agent-chess-video
description: Get a finished Agent Chess game's replay video planned (its video director), or its videos published to YouTube/TikTok, from chat, as the orchestrator. Use when the user says "direct the video for game <id>", "redo game <id>'s video plan", "new titles/thumbnails for game <id>", "publish game <id>", or similar about Agent Chess (C:\Users\User\agent-chess) videos. Not for a director or publisher agent already at work: they follow only their own prompt.
---

# Agent Chess: video director and publishing from chat

The website (http://127.0.0.1:5170) writes your brief for each job: the agent to launch, with its prompt, and what to do after. Every request below needs the header `x-admin-token: <contents of C:\Users\User\agent-chess\data\admin-token.txt>`. Never put the token in an agent's prompt. If the server isn't up (`Invoke-RestMethod http://127.0.0.1:5170/api/meta` fails), start it as the `agent-chess` skill says.

## The video director

For a finished game with no video plan: `POST /api/games/<id>/direct` with `{}`. To replace an existing plan, send `{ "redo": true }`. The website starts the director itself, in its own T3 thread, and looks after it: don't delegate or launch one yourself. It answers `{ "started": true }`, or `{ "started": false, "note": "…" }` with why not: tell the user which. Once the plan is saved, the user renders the video from the game's video page.

The plan comes with several YouTube titles, TikTok captions and thumbnails, which the user picks from on the video page. For new ones on a planned game, leaving the rest of the plan as it is, `GET /api/games/<id>/packaging-launch` and delegate its one task with `delegate_task` (its `title`, `clientRequestId` and `target` exactly as given, `prompt` as `task`, `mode: "async"`, `role: "general"`). When it's done, its options are on the video page and their thumbnails are made by themselves.

## Publishing

Publishing starts on the website. The user presses **Publish** on the game's video page and picks the platforms and visibility. That click is their go-ahead, and the website starts the publisher by itself. If the user asks you to publish, send them to `http://127.0.0.1:5170/#/game/<id>/video`, unless a request is already waiting (the page shows it as requested). In that case get the brief with `{ "action": "publish", "gameId": "<id>", "source": "chat" }` and follow it exactly. Never launch a second publisher for the same request: it could post twice.
