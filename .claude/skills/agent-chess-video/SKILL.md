---
name: agent-chess-video
description: Get a finished Agent Chess game's replay video planned (its video director), or its videos published to YouTube/TikTok, from chat. Use when the user says "direct the video for game <id>", "redo game <id>'s video plan", "new titles/thumbnails for game <id>", "publish game <id>", or similar about Agent Chess (C:\Users\User\agent-chess) videos. Not for a director or publisher agent already at work: they follow only their own prompt.
---

# Agent Chess: video director and publishing from chat

The website (http://127.0.0.1:5170) starts every video agent itself and looks after it: don't delegate or launch one yourself. `direct` needs the header `x-admin-token: <contents of C:\Users\User\agent-chess\data\admin-token.txt>`. If the server isn't up (`Invoke-RestMethod http://127.0.0.1:5170/api/meta` fails), start it as the `agent-chess` skill says.

## The video director

For a finished game with no video plan: `POST /api/games/<id>/direct` with `{}`. To replace an existing plan, send `{ "redo": true }`. It answers `{ "started": true }`, or `{ "started": false, "note": "…" }` with why not: tell the user which. Once the plan is saved, the user renders the video from the game's video page.

The plan comes with several YouTube titles, TikTok captions and thumbnails, which the user picks from on the video page. For new ones on a planned game, leaving the rest of the plan as it is: `POST /api/games/<id>/repackage` with `{}`. It answers the same way as `direct`. Once they're in, they're on the video page and their thumbnails are made by themselves.

## Publishing

Publishing starts on the website. The user presses **Publish** on the game's video page and picks the platforms and visibility. That click is their go-ahead, and the website starts the publisher by itself. If the user asks you to publish, send them to `http://127.0.0.1:5170/#/game/<id>/video`.
