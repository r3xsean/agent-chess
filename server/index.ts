import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Color, Game, MoveRecord, PlayerRef, PositionAnalysis, Tournament } from "../shared/types";
import { MODELS, DEFAULT_BROADCASTER, modelLabel } from "../shared/models";
import { PERSONALITIES, personalityById, riskRule } from "../shared/personalities";
import { DATA, PORT, ROOT } from "./paths";
import { adminToken, flushAll, games, loadAll, players, readJournal, readLessons, writeLessons, saveGameNow, saveTournament, saveTournamentNow, seatKeys, tournaments } from "./store";
import {
  ActionError,
  acceptDraw,
  analyzeGame,
  board,
  bus,
  createGame,
  engine,
  rebuildRatings,
  resign,
  say,
  submitInterview,
  submitJournal,
  submitLessons,
  playerFinished,
  submitTurn,
  tick,
  touch,
} from "./game";
import { broadcasterEvents, postgameBrief, pregameBrief, turnBrief } from "./briefing";
import { directorLaunch, launchSpec } from "./prompts";
import { directorBrief, needsDirection, validatePlan } from "./director";
import { roundRobin } from "./schedule";
import { summonAvailable, triggerOrchestrator } from "./summon";
import { gameToPgn } from "./pgn";
import { loadOpenings } from "./openings";
import { startTts, stopTts } from "./tts";
import { Engine, SupersededError } from "./engine";
import { CLASSIFIER_VERSION, classifyMove, terminalScore } from "./classify";
import { Chess } from "chess.js";

loadAll();
rebuildRatings();
loadOpenings();
engine.start();
startTts();
for (const g of games.values()) {
  // Retry anything the engine failed on last time.
  let retry = false;
  for (const [fen, a] of Object.entries(g.analysis)) if (a.failed) (delete g.analysis[fen], (retry = true));
  for (const m of g.moves) if (m.analysis?.unavailable) (delete m.analysis, (retry = true));
  // Classification rules changed since these verdicts were stored: re-classify from the saved engine analysis.
  if ((g.classifierVersion ?? 1) < CLASSIFIER_VERSION) {
    for (const m of g.moves) delete m.analysis;
    g.classifierVersion = CLASSIFIER_VERSION;
    retry = true;
    touch(g);
  }
  if (retry) g.review = null;
  if (!g.review || g.moves.some((m) => !m.analysis)) analyzeGame(g);
}
setInterval(tick, 1000);

const app = express();
app.use(express.json({ limit: "1mb" }));

/* ------------------------------ helpers ------------------------------ */

function playerRef(input: { model?: string; effort?: string; personality?: string }): PlayerRef {
  const m = MODELS.find((x) => x.model === input.model);
  if (!m) throw new ActionError(`Unknown model: ${input.model}`);
  const effort = m.efforts.includes(String(input.effort)) ? String(input.effort) : m.defaultEffort;
  const personality = PERSONALITIES.some((p) => p.id === input.personality) ? String(input.personality) : PERSONALITIES[0].id;
  return {
    id: `${m.model}@${effort}:${personality}`,
    provider: m.provider,
    model: m.model,
    modelLabel: m.label,
    effort,
    personality,
  };
}

function broadcasterConfig(input: any): Game["broadcaster"] {
  if (!input || input.enabled === false) return null;
  const m = MODELS.find((x) => x.model === input.model) ?? MODELS.find((x) => x.model === DEFAULT_BROADCASTER.model)!;
  return { enabled: true, provider: m.provider, model: m.model, effort: input.effort ?? DEFAULT_BROADCASTER.effort };
}

const handle =
  (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e instanceof ActionError)) console.error(e);
      if (!res.headersSent) res.status(e instanceof ActionError ? 400 : 500).json({ error: msg });
    }
  };

/** Endpoints that reveal seat keys need the orchestrator token (data/admin-token.txt). */
const isAdmin = (req: Request) => req.get("x-admin-token") === adminToken;
function requireAdmin(req: Request) {
  if (!isAdmin(req)) throw new ActionError("This endpoint needs the x-admin-token header (see data/admin-token.txt).");
}

function getGame(id: string): Game {
  const g = games.get(id);
  if (!g) throw new ActionError(`No such game: ${id}`);
  return g;
}

function gameSummary(g: Game) {
  return {
    id: g.id,
    createdAt: g.createdAt,
    white: g.white,
    black: g.black,
    phase: g.phase,
    result: g.result,
    termination: g.termination,
    plies: g.moves.length,
    opening: g.opening,
    tournamentId: g.tournamentId,
    accuracy: g.review ? { w: g.review.w.accuracy, b: g.review.b.accuracy } : null,
  };
}

function sse(req: Request, res: Response, event: string, payload: () => unknown) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  let timer: NodeJS.Timeout | null = null;
  const send = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      res.write(`data: ${JSON.stringify(payload())}\n\n`);
    }, 100);
  };
  res.write(`data: ${JSON.stringify(payload())}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  bus.on(event, send);
  req.on("close", () => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    bus.off(event, send);
  });
}

/* ------------------------------ public API ------------------------------ */

app.get(
  "/api/meta",
  handle(() => ({ models: MODELS, personalities: PERSONALITIES, defaultBroadcaster: DEFAULT_BROADCASTER, summonAvailable: summonAvailable() })),
);

/* ------------------------------ summoning agents through T3 ------------------------------ */

const SUMMON_COOLDOWN_MS = 10 * 60_000;

// The website's "Summon agents" button: wakes a T3 orchestrator thread via the webhook.
app.post(
  "/api/games/:id/summon",
  handle(async (req) => {
    const g = getGame(String(req.params.id));
    if (g.phase === "finished") throw new ActionError("This game is already over.");
    const recently = g.summonRequestedAt && Date.now() - g.summonRequestedAt < SUMMON_COOLDOWN_MS;
    if (recently && !req.body?.force) return { ok: true, already: true, requestedAt: g.summonRequestedAt };
    await triggerOrchestrator({ action: "start-game", gameId: g.id }).catch((e) => {
      throw new ActionError(e.message);
    });
    g.summonRequestedAt = Date.now();
    saveGameNow(g);
    touch(g);
    return { ok: true, requestedAt: g.summonRequestedAt };
  }),
);

// The orchestrator records each seat it delegated, so another run never launches it twice.
app.post(
  "/api/games/:id/launched",
  handle((req) => {
    requireAdmin(req);
    const g = getGame(String(req.params.id));
    const seat = String(req.body?.seat);
    if (!["w", "b", "x"].includes(seat)) throw new ActionError('seat must be "w", "b" or "x"');
    g.launched = { ...g.launched, [seat]: Date.now() };
    saveGameNow(g);
    touch(g);
    return { ok: true, launched: g.launched };
  }),
);

// "Start tournament" from the website: auto-run every pairing in turn.
app.post(
  "/api/tournaments/:id/start",
  handle(async (req) => {
    const t = tournaments.get(String(req.params.id));
    if (!t) throw new ActionError("No such tournament");
    if (t.status === "finished") throw new ActionError("This tournament is already finished.");
    const live = t.pairings.find((p) => p.gameId && games.get(p.gameId)?.phase !== "finished");
    t.autoRun = true;
    saveTournamentNow(t);
    bus.emit("lobby");
    if (live) return { ok: true, alreadyRunning: live.gameId };
    await triggerOrchestrator({ action: "tournament-next", tournamentId: t.id }).catch((e) => {
      throw new ActionError(e.message);
    });
    return { ok: true };
  }),
);

const lobby = () => ({
  games: [...games.values()].sort((a, b) => b.createdAt - a.createdAt).map(gameSummary),
  players: Object.values(players).sort((a, b) => b.rating - a.rating),
  tournaments: [...tournaments.values()].sort((a, b) => b.createdAt - a.createdAt),
});
app.get("/api/lobby", handle(lobby));
app.get("/api/lobby/stream", (req, res) => sse(req, res, "lobby", lobby));

app.post(
  "/api/games",
  handle((req) => {
    const white = playerRef(req.body.white ?? {});
    const black = playerRef(req.body.black ?? {});
    if (white.id === black.id) throw new ActionError("Both seats are the same player (model, effort and personality). Change one of them.");
    const g = createGame({ white, black, broadcaster: broadcasterConfig(req.body.broadcaster), learning: req.body.learning !== false });
    return isAdmin(req) ? { game: g, launch: launchSpec(g) } : { game: g };
  }),
);
app.get("/api/games/:id", handle((req) => getGame(String(req.params.id))));
app.get("/api/games/:id/stream", (req, res) => {
  const g = games.get(String(req.params.id));
  if (!g) return void res.status(404).end();
  sse(req, res, `game:${g.id}`, () => g);
});
app.get(
  "/api/games/:id/launch",
  handle((req) => {
    requireAdmin(req);
    return launchSpec(getGame(String(req.params.id)));
  }),
);
// A finished game with no video plan yet (e.g. from before directors existed): a one-off director task.
app.get(
  "/api/games/:id/director-launch",
  handle((req) => {
    requireAdmin(req);
    const g = getGame(String(req.params.id));
    if (g.phase !== "finished") throw new ActionError("The game isn't finished yet; its broadcaster plans the video at the end.");
    // ?redo=1 throws the current plan away so a new director can make another.
    if (req.query.redo && g.video) {
      delete g.video;
      saveGameNow(g);
      touch(g);
    }
    return directorLaunch(g, typeof req.query.effort === "string" ? req.query.effort : undefined);
  }),
);
app.get(
  "/api/games/:id/agents",
  handle((req) => {
    const g = getGame(String(req.params.id));
    const now = Date.now();
    const ago = (r: Color | "x") => (g.seen[r] ? Math.round((now - g.seen[r]!) / 1000) : null);
    const playerDone = (c: Color) => g.phase === "finished" || playerFinished(g, c);
    return {
      phase: g.phase,
      result: g.result,
      seats: {
        white: { secondsSinceSeen: ago("w"), done: playerDone("w") },
        black: { secondsSinceSeen: ago("b"), done: playerDone("b") },
        broadcaster: g.broadcaster?.enabled ? { secondsSinceSeen: ago("x"), done: g.phase === "finished" && !needsDirection(g) } : null,
      },
    };
  }),
);
app.post(
  "/api/games/:id/abort",
  handle((req) => {
    requireAdmin(req);
    const g = getGame(String(req.params.id));
    if (g.phase === "finished") return { ok: true };
    g.phase = "finished";
    g.termination = g.result ? g.termination : "aborted";
    touch(g);
    return { ok: true };
  }),
);
app.get("/api/games/:id/pgn", (req, res) => {
  const g = games.get(String(req.params.id));
  if (!g) return void res.status(404).end();
  res.setHeader("content-type", "application/x-chess-pgn");
  res.setHeader("content-disposition", `attachment; filename="${g.id}.pgn"`);
  res.send(gameToPgn(g));
});

app.get(
  "/api/players/:id",
  handle((req) => {
    const id = String(req.params.id);
    const p = players[id];
    if (!p) throw new ActionError("No such player");
    return {
      player: p,
      journal: readJournal(id),
      games: [...games.values()].filter((g) => g.white.id === id || g.black.id === id).sort((a, b) => b.createdAt - a.createdAt).map(gameSummary),
    };
  }),
);

/* ------------------------------ lessons (per model) ------------------------------ */

const knownModel = (m: string) => {
  if (!MODELS.some((x) => x.model === m)) throw new ActionError(`Unknown model: ${m}`);
  return m;
};
app.get("/api/lessons/:model", handle((req) => readLessons(knownModel(String(req.params.model)))));
app.post(
  "/api/lessons/:model/reset",
  handle((req) => {
    const model = knownModel(String(req.params.model));
    // History is kept; the active playbook starts over.
    return writeLessons(model, "", null);
  }),
);

/** Everything the players remember: each model's lessons plus every player's journal, grouped by model. */
app.get(
  "/api/memory",
  handle(() => {
    const models = new Set(Object.values(players).map((p) => p.ref.model));
    for (const m of MODELS) if (readLessons(m.model).version > 0) models.add(m.model);
    return [...models]
      .map((model) => {
        const ps = Object.values(players)
          .filter((p) => p.ref.model === model)
          .sort((a, b) => b.rating - a.rating)
          .map((p) => ({ player: p, journal: readJournal(p.id) }));
        return { model, label: MODELS.find((m) => m.model === model)?.label ?? model, lessons: readLessons(model), players: ps };
      })
      .sort((a, b) => (b.lessons.updatedAt ?? 0) - (a.lessons.updatedAt ?? 0) || b.players.length - a.players.length);
  }),
);

/** Every personality with its record across models. */
app.get(
  "/api/personalities",
  handle(() =>
    PERSONALITIES.map((p) => {
      const ps = Object.values(players).filter((x) => x.ref.personality === p.id);
      const total = ps.reduce((a, x) => ({ games: a.games + x.games, wins: a.wins + x.wins, draws: a.draws + x.draws, losses: a.losses + x.losses }), {
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
      });
      return {
        personality: p,
        riskRule: riskRule(p),
        record: total,
        players: ps.sort((a, b) => b.rating - a.rating),
      };
    }),
  ),
);

/* ------------------------------ tournaments ------------------------------ */

app.post(
  "/api/tournaments",
  handle((req) => {
    const refs: PlayerRef[] = (req.body.players ?? []).map(playerRef);
    const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
    if (unique.length < 2) throw new ActionError("A tournament needs at least two different players.");
    const t: Tournament = {
      id: `t${Date.now().toString(36).slice(-6)}`,
      name: String(req.body.name || "Agent Invitational"),
      createdAt: Date.now(),
      players: unique,
      doubleRound: !!req.body.doubleRound,
      broadcaster: broadcasterConfig(req.body.broadcaster),
      learning: req.body.learning !== false,
      pairings: roundRobin(unique.map((r) => r.id), !!req.body.doubleRound),
      status: "running",
    };
    tournaments.set(t.id, t);
    saveTournamentNow(t);
    bus.emit("lobby");
    return t;
  }),
);
app.get(
  "/api/tournaments/:id",
  handle((req) => {
    const t = tournaments.get(String(req.params.id));
    if (!t) throw new ActionError("No such tournament");
    return { tournament: t, games: t.pairings.map((p) => (p.gameId ? gameSummary(games.get(p.gameId)!) : null)) };
  }),
);
app.post(
  "/api/tournaments/:id/next",
  handle((req) => {
    requireAdmin(req);
    const t = tournaments.get(String(req.params.id));
    if (!t) throw new ActionError("No such tournament");
    const live = t.pairings.find((p) => p.gameId && games.get(p.gameId)?.phase !== "finished");
    if (live) return { game: games.get(live.gameId!), launch: launchSpec(games.get(live.gameId!)!), alreadyRunning: true };
    const next = t.pairings.find((p) => !p.gameId);
    if (!next) {
      t.status = "finished";
      saveTournament(t);
      return { finished: true };
    }
    const byId = new Map(t.players.map((p) => [p.id, p]));
    const g = createGame({ white: byId.get(next.white)!, black: byId.get(next.black)!, broadcaster: t.broadcaster, tournamentId: t.id, learning: t.learning !== false });
    next.gameId = g.id;
    saveTournamentNow(t);
    return { game: g, launch: launchSpec(g) };
  }),
);

/* ------------------------------ agent API (used by cli/chess.mjs) ------------------------------ */

const WAIT_MS = 45_000;

function seat(key: string) {
  const s = seatKeys[key];
  if (!s) throw new ActionError("Unknown --key. Use the exact key from your instructions.");
  const g = getGame(s.gameId);
  g.seen[s.role] = Date.now();
  return { g, role: s.role };
}

/** What a player should do right now, or null if it must wait. */
function playerTodo(g: Game, c: Color): string | null {
  switch (g.phase) {
    case "pregame":
      return g.interviews.pre[c] ? null : pregameBrief(g, c);
    case "playing":
      return board(g).turn() === c ? turnBrief(g, c) : null;
    case "postgame":
      if (!g.review) return null;
      if (playerFinished(g, c)) return "DONE — thanks for playing! Your task is complete; you can stop now.";
      return postgameBrief(g, c);
    case "finished":
      return "DONE — the game is over. Your task is complete; you can stop now.";
  }
}

function waitingReason(g: Game, c: Color) {
  if (g.phase === "pregame") return "waiting for the other player's interview and the broadcaster's introduction";
  if (g.phase === "playing") return `your opponent is thinking (move ${Math.ceil((g.moves.length + 1) / 2)})`;
  if (g.phase === "postgame") return "the engine is finishing its review";
  return "";
}

/**
 * Long-poll until `check` returns something. `check` must be side-effect free: it runs inside
 * game-change events, so mutating the game from it would re-trigger itself.
 */
function waitUntil<T>(g: Game, check: () => T | null, res: Response): Promise<T | null> {
  return new Promise((resolve) => {
    const now = check();
    if (now) return resolve(now);
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bus.off(`game:${g.id}`, onChange);
      res.off("close", onClose);
      resolve(v);
    };
    const onChange = () => {
      const v = check();
      if (v) finish(v);
    };
    // The response closing before we've written means the CLI went away.
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), WAIT_MS);
    bus.on(`game:${g.id}`, onChange);
    res.on("close", onClose);
  });
}

/** Broadcaster batches awaiting acknowledgment from the CLI (in memory; a restart just redelivers). */
const bcAcks = new Map<string, { gameId: string; ids: string[]; done: boolean }>();

function readText(body: any) {
  return String(body?.text ?? "");
}

app.post(
  "/api/agent/:cmd",
  handle(async (req, res) => {
    const cmd = String(req.params.cmd);
    const { g, role } = seat(String(req.body?.key ?? ""));
    const text = (t: string) => res.type("text/plain").send(t);
    if (role === "x") {
      if (cmd === "bc-wait") {
        const pending = () => {
          const fresh = broadcasterEvents(g).filter((e) => !g.bcDelivered.includes(e.id));
          if (fresh.length) return { kind: "events" as const, fresh };
          // Once the show is over, the broadcaster plans the replay video before signing off.
          if (g.phase === "finished" && needsDirection(g)) return { kind: "direct" as const, fresh };
          if (g.phase === "finished") return { kind: "done" as const, fresh };
          return null;
        };
        const out = await waitUntil(g, pending, res);
        if (!out) return text("WAITING — nothing new yet. Run `bc-wait` again.");
        if (out.kind === "direct") return text(directorBrief(g));
        // Events count as consumed only when the CLI acknowledges them after printing (bc-ack);
        // an unacknowledged batch is simply delivered again on the next bc-wait.
        const ack = randomBytes(6).toString("hex");
        bcAcks.set(ack, { gameId: g.id, ids: out.fresh.map((e) => e.id), done: out.kind === "done" });
        res.setHeader("x-ack", ack);
        if (out.kind === "done") return text("DONE — the broadcast is over. Your task is complete; you can stop now.");
        return text(out.fresh.map((e) => e.text).join("\n\n") + "\n\n(Now `say` something about this.)");
      }
      if (cmd === "bc-ack") {
        const a = bcAcks.get(String(req.body?.ack ?? ""));
        if (!a || a.gameId !== g.id) return text("OK");
        bcAcks.delete(String(req.body.ack));
        for (const id of a.ids) if (!g.bcDelivered.includes(id)) g.bcDelivered.push(id);
        if (a.done) g.broadcasterDone = true;
        touch(g);
        return text("OK");
      }
      if (cmd === "say") {
        if (g.phase === "finished" && g.broadcasterDone) throw new ActionError("The broadcast is over.");
        const line = say(g, readText(req.body));
        return text(`OK — segment ${line.id} is on air. Run \`bc-wait\` for more.`);
      }
      if (cmd === "direct") {
        if (g.phase !== "finished") throw new ActionError("The video plan comes after the game — keep commentating.");
        g.video = validatePlan(g, req.body?.plan);
        saveGameNow(g);
        touch(g);
        return text(`OK — video plan saved (${g.video.moments.length} moments). Run \`bc-wait\`.`);
      }
      throw new ActionError(`Unknown broadcaster command: ${cmd}. Use bc-wait, say or direct.`);
    }

    const c = role as Color;
    switch (cmd) {
      case "wait": {
        const out = await waitUntil(g, () => playerTodo(g, c), res);
        return text(out ?? `WAITING — ${waitingReason(g, c)}. Run \`wait\` again.`);
      }
      case "status":
        return text(g.phase === "playing" ? turnBrief(g, c) : playerTodo(g, c) ?? `WAITING — ${waitingReason(g, c)}.`);
      case "move": {
        const rec = submitTurn(g, c, req.body.turn ?? {});
        const lines = rec.lines.length ? ` Lines recorded: ${rec.lines.length}.` : "";
        const over = g.result ? ` The game is over: ${g.result} (${g.termination}). Run \`wait\`.` : " Run `wait` for your opponent's reply.";
        return text(`OK — played ${rec.san}.${lines}${over}`);
      }
      case "accept-draw":
        acceptDraw(g, c);
        return text("OK — draw agreed. Run `wait` for the post-game.");
      case "resign":
        resign(g, c);
        return text("OK — you resigned. Run `wait` for the post-game.");
      case "interview":
        submitInterview(g, c, readText(req.body));
        return text("OK — interview recorded. Run `wait`.");
      case "lessons":
        submitLessons(g, c, readText(req.body));
        return text("OK — lessons saved. Run `wait`.");
      case "journal":
        submitJournal(g, c, readText(req.body));
        return text("OK — journal saved. Run `wait`.");
      default:
        throw new ActionError(`Unknown command: ${cmd}`);
    }
  }),
);

/* ------------------------------ static ------------------------------ */

app.use("/audio", express.static(path.join(DATA, "audio"), { maxAge: "1h" }));
/* ------------------------- viewer's analysis board ------------------------- */

// The viewer's own analysis board runs on a second, lighter Stockfish so it never waits behind the
// games' review queue. Only the newest request matters: a new position cancels the one in progress.
const explorer = new Engine({ label: "explorer", depth: 20, maxMs: 3000, threads: 4, hashMb: 128 });
explorer.start();
const exploreCache = new Map<string, PositionAnalysis>();

/** A position's analysis: game over, already known (cache or any game's review), or a fresh explorer search. */
async function analyzeExplore(fen: string): Promise<PositionAnalysis> {
  const term = terminalScore(fen);
  if (term) return { depth: 0, score: term, pv: [] };
  const hit = exploreCache.get(fen);
  if (hit) return hit;
  for (const g of games.values()) {
    const a = g.analysis[fen];
    if (a && !a.failed && a.depth > 0) return a;
  }
  explorer.supersede();
  const a = await explorer.analyze(fen);
  if (!a.failed) {
    exploreCache.set(fen, a);
    if (exploreCache.size > 5000) exploreCache.delete(exploreCache.keys().next().value!);
  }
  return a;
}

const parseFen = (fen: unknown) => {
  try {
    return new Chess(String(fen ?? ""));
  } catch {
    throw new ActionError("Invalid FEN.");
  }
};

/**
 * Body: { fen, move? }. With `move` ({ fenBefore, uci, bookSoFar, prev? }), the move that led to `fen`
 * is also rated exactly like a game move (brilliant … blunder).
 */
app.post(
  "/api/explore",
  handle(async (req) => {
    const fen = parseFen(req.body?.fen).fen();
    const mv = req.body?.move;
    try {
      if (!mv) return await analyzeExplore(fen);
      const c = parseFen(mv.fenBefore);
      const uci = String(mv.uci ?? "");
      let played;
      try {
        played = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        throw new ActionError("Illegal move.");
      }
      if (c.fen() !== fen) throw new ActionError("That move doesn't lead to this position.");
      const before = await analyzeExplore(played.before);
      const after = await analyzeExplore(fen);
      if (before.failed || after.failed) return after;
      const record = { color: played.color, uci, san: played.san, from: played.from, to: played.to, fenBefore: played.before, fenAfter: fen } as MoveRecord;
      const p = mv.prev;
      const prev = p
        ? ({ to: String(p.to), san: String(p.san), analysis: p.winBefore != null ? { winBefore: Number(p.winBefore), winAfter: Number(p.winAfter) } : undefined } as MoveRecord)
        : undefined;
      return { ...after, move: classifyMove(record, before, after.score, prev, !!mv.bookSoFar) };
    } catch (e) {
      if (e instanceof SupersededError) return { superseded: true };
      throw e;
    }
  }),
);

const dist = path.join(ROOT, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|audio).*/, (_req, res) => res.send(readFileSync(path.join(dist, "index.html"), "utf8")));
}

const server = app.listen(PORT, "127.0.0.1", () => console.log(`[agent-chess] http://127.0.0.1:${PORT}`));

function shutdown() {
  flushAll();
  engine.stop();
  explorer.stop();
  stopTts();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
