import express, { type Request, type Response } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Color, Game, MoveRecord, PlayerRef, PlayerStats, PositionAnalysis, Tournament } from "../shared/types";
import { MODELS, DEFAULT_BROADCASTER, modelLabel } from "../shared/models";
import { PERSONALITIES, personalityById, riskRule } from "../shared/personalities";
import { DATA, PORT, PUBLIC_MODE, ROOT } from "./paths";
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
  seatIsHuman,
  seatKeysFor,
  submitTurn,
  tick,
  touch,
} from "./game";
import { humanSide, isHuman } from "../shared/naming";
import { broadcasterEvents, postgameBrief, pregameBrief, turnBrief } from "./briefing";
import { directorLaunch, launchSpec } from "./prompts";
import { directorBrief, needsDirection, validatePlan } from "./director";
import { directorDone, jobsFor, MUSIC_DIR, musicTracks, startRender, VIDEO_DIR, videosFor, type RenderFormat } from "./render";
import { roundRobin } from "./schedule";
import { summonAvailable, triggerOrchestrator } from "./summon";
import { gameToPgn } from "./pgn";
import { loadOpenings } from "./openings";
import { Engine, SupersededError } from "./engine";
import { CLASSIFIER_VERSION, classifyMove, terminalScore } from "./classify";
import { newRules, randomChess960, variantOf, type Variant } from "../shared/rules";
import { createViewer, crowd, flushPredictions, leaderboard, predict, PredictionError, renameViewer, scoresChanged, setGameSource, viewerInfo } from "./predictions";
import { acceptSeq, ingest, mirrorPublicStatus, syncAck, mirrorChanged as mirrorChangedLobby, mirrorConfig, mirrorStatus, startMirror } from "./mirror";

loadAll();
setGameSource(() => games.values());
// The public mirror only shows what the local server sends it: no engine, no agents, no clock.
if (!PUBLIC_MODE) startLocal();

function startLocal() {
  rebuildRatings();
  loadOpenings();
  engine.start();
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
  startMirror();
}

const app = express();
if (PUBLIC_MODE) {
  // Behind Railway's proxy, so rate limits see the viewer's address rather than the proxy's.
  app.set("trust proxy", 1);
  // Express otherwise ignores case and trailing slashes when routing; the guard below must see paths exactly as the router does.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
}

/* ------------------------------ the public, read-only site ------------------------------ */

// Viewers may only predict (and, with the mirror's secret, the local server may sync). Everything that
// creates games, launches agents, renders or reveals local paths stays on the local server.
const PUBLIC_POSTS = [/^\/api\/games\/[^/]+\/predict$/, /^\/api\/viewers(\/[^/]+)?$/, /^\/api\/mirror\/sync$/, /^\/api\/explore$/];
const PUBLIC_GET_BLOCKED = [/\/launch$/, /\/director-launch$/, /\/render$/, /^\/api\/music/];
// The local site's prediction panel talks to the public mirror directly, so its crowd endpoints allow any origin.
const CROWD = /^\/api\/(games\/[^/]+\/(crowd|crowd\/stream|predict)|viewers(\/[^/]+)?|predictors)$/;
app.use((req, res, next) => {
  if (!PUBLIC_MODE) return next();
  const p = req.path;
  if (!p.toLowerCase().startsWith("/api")) return next(); // the site itself
  // Every API path and id is lower-case (once decoded: ids arrive as e.g. %40, %3A); anything else is an
  // attempt to slip past the rules below. The rules themselves test the raw path, exactly as the router matches it.
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return void res.status(400).json({ error: "Bad path." });
  }
  if (decoded !== decoded.toLowerCase() || !p.startsWith("/api/")) return void res.status(404).json({ error: "Not found." });
  const m = req.method;
  const allowed = m === "GET" || m === "HEAD" ? !PUBLIC_GET_BLOCKED.some((r) => r.test(p)) : m === "OPTIONS" ? CROWD.test(p) : m === "POST" && PUBLIC_POSTS.some((r) => r.test(p));
  if (!allowed) return void res.status(403).json({ error: "This is the read-only public site." });
  if (CROWD.test(p)) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (m === "OPTIONS") return void res.status(204).end();
  }
  next();
});
/** Defence in depth on every route that changes local state: the public site never runs it, whatever the path looked like. */
const localOnly = (_req: Request, res: Response, next: () => void) => (PUBLIC_MODE ? void res.status(403).json({ error: "This is the read-only public site." }) : next());

// The mirror's inbox has its own (large) body limit, and checks the secret before reading a byte of the body.
const smallJson = express.json({ limit: "1mb" });
app.use((req, res, next) => (req.path === "/api/mirror/sync" ? next() : smallJson(req, res, next)));

/** A sliding-window limit per client address and bucket. */
const hits = new Map<string, number[]>();
function rateLimit(req: Request, bucket: string, max: number, windowMs: number) {
  const key = `${bucket}|${req.ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) throw new ActionError("Slow down a little — too many requests.");
  recent.push(now);
  hits.set(key, recent);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k);
}, 600_000).unref();

/* ------------------------------ live streams ------------------------------ */

// Server-sent events hold a connection open each, so the public site caps them per address and overall,
// and drops a viewer whose connection has stopped reading rather than buffering for them forever.
const MAX_STREAMS = 3000;
const MAX_STREAMS_PER_IP = 24;
const streamsByIp = new Map<string, number>();
let streams = 0;

/** Admit a stream (or refuse it with 429). Returns a writer that gives up on stalled readers. */
function openStream(req: Request, res: Response): ((data: string) => void) | null {
  const ip = req.ip ?? "?";
  if (PUBLIC_MODE && (streams >= MAX_STREAMS || (streamsByIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP)) {
    res.status(429).json({ error: "Too many live connections." });
    return null;
  }
  streams++;
  streamsByIp.set(ip, (streamsByIp.get(ip) ?? 0) + 1);
  let closed = false;
  const release = () => {
    if (closed) return;
    closed = true;
    streams--;
    const n = (streamsByIp.get(ip) ?? 1) - 1;
    if (n > 0) streamsByIp.set(ip, n);
    else streamsByIp.delete(ip);
  };
  res.on("close", release);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  return (data: string) => {
    if (closed) return;
    if (res.writableLength > 1_000_000) return void res.destroy(); // a reader this far behind isn't reading
    res.write(data);
  };
}

/** One serialisation per change, shared by every stream of the same thing: keyed by how many changes it has seen. */
const revisions = new Map<string, { rev: number; subscribers: number; bump: () => void }>();
const serialized = new Map<string, { rev: number; data: string }>();
/** Count changes to an event while anyone streams it; the returned function unsubscribes (freeing it with the last). */
function trackRevisions(event: string): () => void {
  let r = revisions.get(event);
  if (!r) {
    const entry = { rev: 0, subscribers: 0, bump: () => entry.rev++ };
    r = entry;
    revisions.set(event, r);
    // Registered before any stream's own listener, so a stream always serialises the newest revision.
    bus.prependListener(event, r.bump);
  }
  r.subscribers++;
  const tracked = r;
  return () => {
    if (--tracked.subscribers > 0) return;
    bus.off(event, tracked.bump);
    revisions.delete(event);
    serialized.delete(event);
  };
}
function shared(event: string, payload: () => unknown): string {
  const rev = revisions.get(event)?.rev ?? 0;
  const hit = serialized.get(event);
  if (hit && hit.rev === rev) return hit.data;
  const data = `data: ${JSON.stringify(payload())}\n\n`;
  serialized.set(event, { rev, data });
  return data;
}
/* ------------------------------ helpers ------------------------------ */

function humanRef(name: unknown): PlayerRef {
  const label = String(name ?? "").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24) || "Human";
  return { id: `human:${label.toLowerCase()}`, provider: "human", model: "human", modelLabel: label, effort: "", personality: "human" };
}

function playerRef(input: { model?: string; effort?: string; personality?: string; human?: boolean; name?: string }): PlayerRef {
  if (input.human) return humanRef(input.name);
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

/** The Chess960 choice from a request: off, a random start position, or a given one (0–959). */
function chess960Choice(v: unknown): number | undefined {
  if (v === undefined || v === null || v === false || v === "") return undefined;
  if (v === true || v === "random") return randomChess960();
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 959) throw new ActionError("A Chess960 start position is a number from 0 to 959.");
  return n;
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
  const write = openStream(req, res);
  if (!write) return;
  const untrack = trackRevisions(event);
  let timer: NodeJS.Timeout | null = null;
  const send = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      write(shared(event, payload));
    }, 100);
  };
  write(shared(event, payload));
  const ping = setInterval(() => write(": ping\n\n"), 20000);
  bus.on(event, send);
  req.on("close", () => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    bus.off(event, send);
    untrack();
  });
}

/* ------------------------------ public API ------------------------------ */

app.get(
  "/api/meta",
  handle(() => ({
    models: MODELS,
    personalities: PERSONALITIES,
    defaultBroadcaster: DEFAULT_BROADCASTER,
    summonAvailable: !PUBLIC_MODE && summonAvailable(),
    publicMode: PUBLIC_MODE,
    // Where viewers' predictions live: the public mirror when there is one, so local and public viewers share them.
    crowdBase: PUBLIC_MODE ? "" : (mirrorConfig()?.url ?? ""),
    publicUrl: PUBLIC_MODE ? null : (mirrorConfig()?.url ?? null),
    mirror: PUBLIC_MODE ? null : mirrorStatus(),
  })),
);

/* ------------------------------ viewer predictions ------------------------------ */

const crowdHandle =
  (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) =>
    handle(() => {
      try {
        return fn(req, res);
      } catch (e) {
        throw e instanceof PredictionError ? new ActionError(e.message) : e;
      }
    })(req, res);

app.post(
  "/api/viewers",
  crowdHandle((req) => {
    rateLimit(req, "viewer", 10, 3_600_000);
    return viewerInfo(createViewer(req.body?.name).id);
  }),
);
app.get("/api/viewers/:id", crowdHandle((req) => viewerInfo(String(req.params.id))));
app.post(
  "/api/viewers/:id",
  crowdHandle((req) => {
    rateLimit(req, "rename", 20, 3_600_000);
    renameViewer(String(req.params.id), req.body?.name);
    return viewerInfo(String(req.params.id));
  }),
);
app.get("/api/predictors", crowdHandle(() => leaderboard()));
app.get("/api/games/:id/crowd", crowdHandle((req) => crowd(getGame(String(req.params.id)), String(req.query.viewer ?? ""))));
app.post(
  "/api/games/:id/predict",
  crowdHandle((req) => {
    rateLimit(req, "predict", 60, 60_000);
    const g = getGame(String(req.params.id));
    predict(g, req.body?.viewer, req.body?.kind, req.body?.pick);
    bus.emit(`crowd:${g.id}`);
    return crowd(g, String(req.body?.viewer ?? ""));
  }),
);
// Live crowd: re-sent when anyone predicts, and when the game moves on (guesses lock, results score).
app.get("/api/games/:id/crowd/stream", (req, res) => {
  const g = games.get(String(req.params.id));
  if (!g) return void res.status(404).end();
  const viewer = String(req.query.viewer ?? "");
  const out = openStream(req, res);
  if (!out) return;
  let timer: NodeJS.Timeout | null = null;
  const write = () => out(`data: ${JSON.stringify(crowd(games.get(g.id) ?? g, viewer))}\n\n`);
  const send = () => {
    if (!timer) timer = setTimeout(() => ((timer = null), write()), 400);
  };
  write();
  const ping = setInterval(() => out(": ping\n\n"), 20000);
  bus.on(`crowd:${g.id}`, send);
  bus.on(`game:${g.id}`, send);
  req.on("close", () => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    bus.off(`crowd:${g.id}`, send);
    bus.off(`game:${g.id}`, send);
  });
});

/* ------------------------------ the mirror's inbox ------------------------------ */

// Lets the local server notice a mirror whose storage was replaced (its epoch changes), even when idle.
app.get("/api/mirror/status", handle(() => (PUBLIC_MODE ? mirrorPublicStatus() : { epoch: null })));

const MIRROR_SECRET = process.env.MIRROR_SECRET ?? "";
function mirrorAuthorized(req: Request) {
  if (!PUBLIC_MODE || MIRROR_SECRET.length < 32) return false;
  const got = Buffer.from(req.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${MIRROR_SECRET}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
let syncing = false;
app.post(
  "/api/mirror/sync",
  (req, res, next) => {
    if (!mirrorAuthorized(req)) return void res.status(403).json({ error: "Not allowed." });
    // Batches are applied strictly one at a time (the sender also only sends one at a time).
    if (syncing) return void res.status(409).json({ error: "Another sync is in progress." });
    syncing = true;
    res.on("close", () => (syncing = false));
    next();
  },
  express.json({ limit: "200mb" }),
  handle((req) => {
    const batch = req.body ?? {};
    if (!acceptSeq(batch.seq)) return syncAck({ stale: true });
    const changed = ingest(batch);
    scoresChanged();
    for (const id of changed) {
      const g = games.get(id);
      if (g) bus.emit(`game:${id}`, g);
    }
    bus.emit("lobby");
    return syncAck({ games: changed.length });
  }),
);

/* ------------------------------ summoning agents through T3 ------------------------------ */

const SUMMON_COOLDOWN_MS = 10 * 60_000;

// The website's "Summon agents" button: wakes a T3 orchestrator thread via the webhook.
app.post(
  "/api/games/:id/summon",
  localOnly,
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
  localOnly,
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
  localOnly,
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
  localOnly,
  handle((req) => {
    const white = playerRef(req.body.white ?? {});
    const black = playerRef(req.body.black ?? {});
    if (isHuman(white) && isHuman(black)) throw new ActionError("Pick an agent for one of the seats — this is for playing against an agent.");
    if (white.id === black.id) throw new ActionError("Both seats are the same player (model, effort and personality). Change one of them.");
    const g = createGame({ white, black, broadcaster: broadcasterConfig(req.body.broadcaster), learning: req.body.learning !== false, chess960: chess960Choice(req.body.chess960) });
    // Whoever sets up a game against an agent gets that seat's key: the browser plays with it.
    const human = humanSide(g);
    const humanKey = human ? seatKeysFor(g.id)[human] : undefined;
    return isAdmin(req) ? { game: g, launch: launchSpec(g), humanKey } : { game: g, humanKey };
  }),
);
app.get("/api/games/:id", handle((req) => getGame(String(req.params.id))));
app.get("/api/games/:id/stream", (req, res) => {
  const g = games.get(String(req.params.id));
  if (!g) return void res.status(404).end();
  sse(req, res, `game:${g.id}`, () => games.get(g.id) ?? g);
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
    // A human seat is played from the website: nothing for an orchestrator to launch or revive.
    const seatInfo = (c: Color) => (seatIsHuman(g, c) ? { human: true, done: true } : { secondsSinceSeen: ago(c), done: playerDone(c) });
    return {
      phase: g.phase,
      result: g.result,
      seats: {
        white: seatInfo("w"),
        black: seatInfo("b"),
        broadcaster: g.broadcaster?.enabled ? { secondsSinceSeen: ago("x"), done: g.phase === "finished" && !needsDirection(g) } : null,
      },
    };
  }),
);
app.post(
  "/api/games/:id/abort",
  localOnly,
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
  localOnly,
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
    const models = new Set(Object.values(players).filter((p) => !isHuman(p.ref)).map((p) => p.ref.model));
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

const recordOf = (ps: PlayerStats[]) =>
  ps.reduce((a, x) => ({ games: a.games + x.games, wins: a.wins + x.wins, draws: a.draws + x.draws, losses: a.losses + x.losses }), { games: 0, wins: 0, draws: 0, losses: 0 });

/** Every model that has played, with its record and, under it, every personality (played ones first, best rating first). */
app.get(
  "/api/agents",
  handle(() => {
    const byModel = new Map<string, PlayerStats[]>();
    for (const p of Object.values(players)) if (!isHuman(p.ref)) byModel.set(p.ref.model, [...(byModel.get(p.ref.model) ?? []), p]);
    return [...byModel]
      .map(([model, ps]) => {
        const personalities = PERSONALITIES.map((persona) => {
          const mine = ps.filter((x) => x.ref.personality === persona.id).sort((a, b) => b.rating - a.rating);
          return { personality: persona, riskRule: riskRule(persona), record: recordOf(mine), players: mine };
        }).sort((a, b) => (b.players[0]?.rating ?? -Infinity) - (a.players[0]?.rating ?? -Infinity));
        return {
          model,
          label: MODELS.find((m) => m.model === model)?.label ?? ps[0].ref.modelLabel,
          provider: ps[0].ref.provider,
          record: recordOf(ps),
          best: ps.reduce((a, b) => (b.rating > a.rating ? b : a)),
          personalities,
        };
      })
      .sort((a, b) => b.best.rating - a.best.rating);
  }),
);

/* ------------------------------ tournaments ------------------------------ */

app.post(
  "/api/tournaments",
  localOnly,
  handle((req) => {
    const refs: PlayerRef[] = (req.body.players ?? []).map(playerRef);
    if (refs.some(isHuman)) throw new ActionError("Tournaments are for agents; play an agent yourself from New game.");
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
    if (req.body.chess960) {
      // Every pairing gets its own start position; in a double round-robin the return game replays it with colours swapped.
      t.chess960 = true;
      const byPair = new Map<string, number>();
      for (const p of t.pairings) {
        const key = [p.white, p.black].sort().join("|");
        if (!byPair.has(key)) byPair.set(key, randomChess960());
        p.chess960 = byPair.get(key);
      }
    }
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
  localOnly,
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
    const g = createGame({ white: byId.get(next.white)!, black: byId.get(next.black)!, broadcaster: t.broadcaster, tournamentId: t.id, learning: t.learning !== false, chess960: next.chess960 });
    next.gameId = g.id;
    saveTournamentNow(t);
    return { game: g, launch: launchSpec(g) };
  }),
);

/* ------------------------------ a human at the board (the website) ------------------------------ */

// Body: { key, action: "move" | "resign" | "accept-draw", move?, offerDraw? }. The key is the human seat's,
// handed to the browser that created the game, so the agent (or anyone else) can't move for them.
app.post(
  "/api/games/:id/play",
  localOnly,
  handle((req) => {
    const g = getGame(String(req.params.id));
    const s = seatKeys[String(req.body?.key ?? "")];
    if (!s || s.gameId !== g.id || s.role === "x" || !seatIsHuman(g, s.role)) throw new ActionError("This browser isn't seated in this game.");
    const c = s.role;
    g.seen[c] = Date.now();
    const action = String(req.body?.action ?? "");
    if (action === "move") {
      const rec = submitTurn(g, c, { move: String(req.body?.move ?? ""), commentary: "", eval: "", offerDraw: !!req.body?.offerDraw });
      return { ok: true, san: rec.san };
    }
    if (action === "resign") return resign(g, c), { ok: true };
    if (action === "accept-draw") return acceptDraw(g, c), { ok: true };
    throw new ActionError('action must be "move", "resign" or "accept-draw".');
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
  localOnly,
  handle(async (req, res) => {
    const cmd = String(req.params.cmd);
    const { g, role } = seat(String(req.body?.key ?? ""));
    const text = (t: string) => res.type("text/plain").send(t);
    if (role === "x") {
      if (cmd === "bc-wait") {
        const pending = () => {
          const fresh = broadcasterEvents(g).filter((e) => !g.bcDelivered.includes(e.id));
          // Once the show is over, the broadcaster plans the replay video before signing off. A standalone
          // director (a game without a broadcaster) goes straight to its brief, not the old event feed.
          if (g.phase === "finished" && needsDirection(g)) return { kind: "direct" as const, fresh };
          if (g.phase === "finished" && g.broadcasterDone) return { kind: "done" as const, fresh };
          if (fresh.length) return { kind: "events" as const, fresh };
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
        directorDone(g.id);
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

app.use("/videos", express.static(VIDEO_DIR));
// The site plays the same sound effects as the videos.
const SFX_DIR = path.join(ROOT, "vendor", "sfx");
app.use("/sfx", express.static(SFX_DIR, { maxAge: "1d" }));
app.get(
  "/api/sfx",
  handle(() => (existsSync(SFX_DIR) ? readdirSync(SFX_DIR).filter((n) => /\.(ogg|wav|mp3)$/i.test(n)).sort() : [])),
);

/* ------------------------------ video renders ------------------------------ */

const renderState = (id: string) => {
  const g = getGame(id);
  return { jobs: jobsFor(id), videos: videosFor(id), music: musicTracks(), directed: !!g.video, summonAvailable: summonAvailable() };
};
app.get("/api/games/:id/render", handle((req) => renderState(String(req.params.id))));
app.post(
  "/api/games/:id/render",
  localOnly,
  handle(async (req) => {
    const id = String(req.params.id);
    const want = req.body?.formats;
    const formats = (Array.isArray(want) ? want : ["landscape", "portrait"]).filter((f: string): f is RenderFormat => f === "landscape" || f === "portrait");
    if (!formats.length) throw new ActionError('formats must include "landscape" and/or "portrait".');
    await startRender(id, formats, req.body?.music ? String(req.body.music) : null).catch((e) => {
      throw new ActionError(e.message);
    });
    return renderState(id);
  }),
);
// Show a finished video in Explorer / Finder.
app.post(
  "/api/games/:id/videos/open",
  localOnly,
  handle((req) => {
    const v = videosFor(String(req.params.id))[0];
    const target = v ? path.join(VIDEO_DIR, v.file) : VIDEO_DIR;
    const [cmd, args] =
      process.platform === "win32" ? ["explorer.exe", [`/select,${target}`]] : process.platform === "darwin" ? ["open", ["-R", target]] : ["xdg-open", [path.dirname(target)]];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  }),
);
// Add a background-music track (raw upload; the file name comes in a header).
app.post(
  "/api/music",
  localOnly,
  express.raw({ type: "*/*", limit: "200mb" }),
  handle((req) => {
    const name = path.basename(decodeURIComponent(String(req.headers["x-filename"] ?? ""))).replace(/[^\w.\- ()]/g, "_");
    if (!/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(name)) throw new ActionError("Upload an audio file: mp3, m4a, aac, wav, ogg or flac.");
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new ActionError("The upload was empty.");
    mkdirSync(MUSIC_DIR, { recursive: true });
    writeFileSync(path.join(MUSIC_DIR, name), req.body);
    return { ok: true, name, music: musicTracks() };
  }),
);
/* ------------------------- viewer's analysis board ------------------------- */

// The viewer's own analysis board runs on a second, lighter Stockfish so it never waits behind the
// games' review queue. Only the newest request matters: a new position cancels the one in progress.
const explorer = new Engine({ label: "explorer", depth: 20, maxMs: 3000, threads: 4, hashMb: 128 });
if (!PUBLIC_MODE) explorer.start();

/** The public site runs no engine: positions the games already analysed still show, others come back offline. */
class EngineOffline extends Error {}
const exploreCache = new Map<string, PositionAnalysis>();

/** A position's analysis: game over, already known (cache or any game's review), or a fresh explorer search. */
async function analyzeExplore(fen: string, variant: Variant): Promise<PositionAnalysis> {
  const term = terminalScore(fen);
  if (term) return { depth: 0, score: term, pv: [] };
  // Castling is written differently in the two variants, so their analyses are kept apart.
  const key = `${variant}|${fen}`;
  const hit = exploreCache.get(key);
  if (hit) return hit;
  for (const g of games.values()) {
    const a = variantOf(g) === variant ? g.analysis[fen] : undefined;
    if (a && !a.failed && a.depth > 0) return a;
  }
  if (PUBLIC_MODE) throw new EngineOffline();
  explorer.supersede();
  const a = await explorer.analyze(fen, variant);
  if (!a.failed) {
    exploreCache.set(key, a);
    if (exploreCache.size > 5000) exploreCache.delete(exploreCache.keys().next().value!);
  }
  return a;
}

const parseFen = (fen: unknown, variant: Variant) => {
  try {
    return newRules(String(fen ?? ""), variant);
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
    if (PUBLIC_MODE) rateLimit(req, "explore", 120, 60_000);
    const variant: Variant = req.body?.variant === "chess960" ? "chess960" : "standard";
    const fen = parseFen(req.body?.fen, variant).fen();
    const mv = req.body?.move;
    try {
      if (!mv) return await analyzeExplore(fen, variant);
      const c = parseFen(mv.fenBefore, variant);
      const uci = String(mv.uci ?? "");
      let played;
      try {
        played = c.move(uci);
      } catch {
        throw new ActionError("Illegal move.");
      }
      if (c.fen() !== fen) throw new ActionError("That move doesn't lead to this position.");
      const before = await analyzeExplore(played.before, variant);
      const after = await analyzeExplore(fen, variant);
      if (before.failed || after.failed) return after;
      const record = { color: played.color, uci: played.uci, san: played.san, from: played.from, to: played.to, fenBefore: played.before, fenAfter: fen } as MoveRecord;
      const p = mv.prev;
      const prev = p
        ? ({ to: String(p.to), san: String(p.san), analysis: p.winBefore != null ? { winBefore: Number(p.winBefore), winAfter: Number(p.winAfter) } : undefined } as MoveRecord)
        : undefined;
      return { ...after, move: classifyMove(record, before, after.score, prev, !!mv.bookSoFar, variant) };
    } catch (e) {
      if (e instanceof SupersededError) return { superseded: true };
      if (e instanceof EngineOffline) return { offline: true };
      throw e;
    }
  }),
);

const dist = path.join(ROOT, "dist");
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.send(readFileSync(path.join(dist, "index.html"), "utf8")));
}

// Locally the agent API must never be reachable from the network; the public mirror has to be.
const HOST = PUBLIC_MODE ? "0.0.0.0" : "127.0.0.1";
const server = app.listen(PORT, HOST, () => console.log(`[agent-chess] http://${HOST}:${PORT}${PUBLIC_MODE ? " (public read-only mirror)" : ""}`));
bus.on("lobby", () => mirrorChangedLobby());

function shutdown() {
  flushAll();
  flushPredictions();
  engine.stop();
  explorer.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
