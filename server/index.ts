import express, { type Request, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { resumeThinkingClock } from "../shared/thinkingClock";
import { migratePause, pauseGame } from "./pauses";
import { startUsageLimitWatcher } from "./usageLimits";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { Color, Game, MoveRecord, PlayerRef, PlayerStats, PositionAnalysis, PublishPlatform, SeatRole, Tournament, VideoPlan } from "../shared/types";
import { MODELS, DEFAULT_BROADCASTER, modelLabel } from "../shared/models";
import { PERSONALITIES, personalityById, riskRule } from "../shared/personalities";
import { DATA, PORT, PUBLIC_MODE, ROOT } from "./paths";
import { adminToken, agentDir, flushAll, games, loadAll, players, readJournal, readLessons, writeLessons, saveGameNow, saveTournamentNow, seatKeys, tournaments } from "./store";
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
  seatClaimed,
  claimSeats,
  startablePairings,
  boardsOf,
  isRated,
  submitTurn,
  tick,
  touch,
} from "./game";
import { humanSide, isHuman } from "../shared/naming";
import { broadcasterEvents, postgameBrief, pregameBrief, turnBrief } from "./briefing";
import { directorLaunch, launchSpec, packagingLaunch, seatTask } from "./prompts";
import { launchGame, startTournament, watch } from "./launcher";
import { applyNarration, directorBrief, investigationNotes, narratedReadback, narrateBrief, needsDirection, packagingBrief, packagingChoices, packagingReadback, planReadback, validatePlan } from "./director";
import { deepenLines, linesPrepared, linesProgress, linesReady } from "./lineDepth";
import { dropThumbOptions, jobsFor,MUSIC_DIR, musicTracks, packagingFor, startRender, VIDEO_DIR, videosFor, type RenderFormat } from "./render";
import { autoDirectorDone, directorThreadBusy, directorThreadCommand, directorThreadState, isDirectorThreadKey, openDirectorThread } from "./directorThread";
import { videoApproved, videoRevision } from "./videoApproval";
import { rivalry } from "./rivalry";
import { gameFolder, gameVideoDir, migrateFlatVideos, videoPath } from "./videoFiles";
import { VOICE_DIR, voiceManifest } from "./voice";
import { roundRobin } from "./schedule";
import { summonAvailable } from "./summon";
import { orchestratorBrief, tournamentNext } from "./orchestrator";
import { PROBE_COMMANDS, probeCommand } from "./probe";
import { editUploadText, pickPackaging, publishLaunch, publishState, recordPublished, requestPublish, setPackagingOptions } from "./publish";
import { gameToPgn } from "./pgn";
import { analyticsRows, modelAnalytics } from "./analytics";
import type { AnalyticsScope } from "../shared/analytics";
import { loadOpenings } from "./openings";
import { Engine, SupersededError } from "./engine";
import { CLASSIFIER_VERSION, classifyMove, reviewSide, terminalScore } from "./classify";
import { newRules, randomChess960, variantOf, type Variant } from "../shared/rules";
import { createViewer, crowd, flushPredictions, leaderboard, predict, PredictionError, renameViewer, scoresChanged, setGameSource, viewerInfo } from "./predictions";
import { acceptSeq, ingest, mirrorPublicStatus, syncAck, mirrorChanged as mirrorChangedLobby, mirrorConfig, mirrorStatus, startMirror } from "./mirror";

loadAll();
// Videos rendered before games had their own folders move into them.
const movedVideos = migrateFlatVideos();
if (movedVideos) console.log(`[videos] moved ${movedVideos} file${movedVideos === 1 ? "" : "s"} into per-game folders`);
setGameSource(() => games.values());
// The public mirror only shows what the local server sends it: no engine, no agents, no clock.
if (!PUBLIC_MODE) startLocal();

function startLocal() {
  for (const g of games.values()) migratePause(g);
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
    // A review is a pure summary of the verdicts, so stored ones are refreshed to the current scoring.
    if (g.review) {
      const review = { w: reviewSide(g, "w"), b: reviewSide(g, "b") };
      if (JSON.stringify(review) !== JSON.stringify(g.review)) (g.review = review), touch(g);
    }
    if (!g.review || g.moves.some((m) => !m.analysis)) analyzeGame(g);
  }
  setInterval(tick, 1000);
  setInterval(watch, 5000);
  startUsageLimitWatcher(() => games.values(), (g) => { saveGameNow(g); touch(g); });
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
const PUBLIC_GET_BLOCKED = [/\/launch$/, /\/director-launch$/, /\/packaging-launch$/,/\/publish-launch$/, /\/render$/, /\/voice$/, /\/director-thread$/, /^\/api\/music/];
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
    clockPause: g.clockPause,
    result: g.result,
    termination: g.termination,
    plies: g.moves.length,
    opening: g.opening,
    tournamentId: g.tournamentId,
    rated: isRated(g),
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

// The website's "Summon agents" button: starts the game's agents through the T3 webhooks.
app.post(
  "/api/games/:id/summon",
  localOnly,
  handle(async (req) => {
    const g = getGame(String(req.params.id));
    if (g.phase === "finished") throw new ActionError("This game is already over.");
    const recently = g.summonRequestedAt && Date.now() - g.summonRequestedAt < SUMMON_COOLDOWN_MS;
    if (recently && !req.body?.force) return { ok: true, already: true, requestedAt: g.summonRequestedAt };
    await launchGame(g).catch((e) => {
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
    if (!["w", "b", "x", "d"].includes(seat)) throw new ActionError('seat must be "w", "b", "x" or "d"');
    // A seat its brief already handed out keeps that time, so its agent turning up since still counts.
    if (!seatClaimed(g, seat as SeatRole)) claimSeats(g, [seat as SeatRole]);
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
    // Several boards: start whatever can go now; anything blocked starts as boards and models free up.
    if (boardsOf(t) > 1 && !startablePairings(t).length) return { ok: true, waiting: true };
    if (boardsOf(t) <= 1 && live) return { ok: true, alreadyRunning: live.gameId };
    await startTournament(t).catch((e) => {
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
    const g = createGame({ white, black, broadcaster: broadcasterConfig(req.body.broadcaster), learning: req.body.learning !== false, rated: req.body.rated !== false, chess960: chess960Choice(req.body.chess960) });
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
      // The last director's and narrator's working files move aside (kept, under previous/), so the new ones
      // start from their briefs, not from the old plan and narration.
      for (const seat of ["d", "n"]) {
        const dir = agentDir(g.id, seat);
        const old = readdirSync(dir).filter((f) => f !== "previous");
        if (!old.length) continue;
        const to = path.join(dir, "previous", new Date().toISOString().replace(/[:.]/g, "-"));
        mkdirSync(to, { recursive: true });
        for (const f of old) renameSync(path.join(dir, f), path.join(to, f));
      }
      delete g.video;
      if (g.launched) delete g.launched.d;
      g.videoRedos = (g.videoRedos ?? 0) + 1;
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
    const ago = (r: SeatRole) => (g.seen[r] ? Math.round((now - g.seen[r]!) / 1000) : null);
    const playerDone = (c: Color) => g.phase === "finished" || playerFinished(g, c);
    // A human seat is played from the website: nothing for an orchestrator to launch or revive.
    const seatInfo = (c: Color) => (seatIsHuman(g, c) ? { human: true, done: true } : { secondsSinceSeen: ago(c), done: playerDone(c) });
    return {
      phase: g.phase,
      clockPause: g.clockPause,
      result: g.result,
      seats: {
        white: seatInfo("w"),
        black: seatInfo("b"),
        broadcaster: g.broadcaster?.enabled ? { secondsSinceSeen: ago("x"), done: g.phase === "finished" } : null,
        // The video director comes after the game: done once the plan is saved (or there's nothing to plan).
        // The video director comes after the game: done once the plan is saved and its narrator has seen the narration through.
        director: g.phase === "finished" && (g.broadcaster?.enabled || g.launched?.d) ? { secondsSinceSeen: ago("d"), done: !needsDirection(g) && autoDirectorDone(g) } : null,
      },
    };
  }),
);
app.post(
  "/api/games/:id/clock",
  localOnly,
  handle((req) => {
    requireAdmin(req);
    const g = getGame(String(req.params.id));
    if (g.phase === "finished") throw new ActionError("The game is finished.");
    if (req.body?.action === "pause") {
      const at = req.body.at ?? Date.now();
      if (typeof at !== "number" || !Number.isFinite(at)) throw new ActionError("Invalid pause time.");
      const code = String(req.body.code ?? "manual");
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(code)) throw new ActionError("Invalid pause reason code.");
      const seats = req.body.seats;
      if (code === "usage_limit" && (!Array.isArray(seats) || !seats.length || seats.some((c: unknown) => c !== "w" && c !== "b"))) throw new ActionError("Usage pauses need affected seats (w/b).");
      const resetAt = req.body.resetAt;
      if (resetAt !== undefined && (typeof resetAt !== "number" || !Number.isFinite(resetAt))) throw new ActionError("Invalid reset time.");
      pauseGame(g, { at: Math.max(g.createdAt, at), code, reason: String(req.body.reason ?? "Paused by the operator").trim().slice(0, 200) || "Paused by the operator", ...(code === "usage_limit" ? { seats: [...new Set<Color>(seats)] } : {}), resetAt });
    } else if (req.body?.action === "resume") {
      // Explicitly resuming also dismisses previously observed failures, including across restarts.
      g.lastAgentActionAt = { w: Date.now(), b: Date.now() };
      resumeThinkingClock(g);
    }
    else throw new ActionError("Use action pause or resume.");
    saveGameNow(g);
    touch(g);
    return { ok: true, clockPause: g.clockPause ?? null };
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
    delete g.clockPause;
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

/** The Agents tab: every model's row of the comparison table, and one model's full analytics (?scope=rated: rated games only). */
const analyticsScope = (req: Request): AnalyticsScope => (req.query.scope === "rated" ? "rated" : "all");
app.get("/api/analytics", handle((req) => analyticsRows(analyticsScope(req))));
app.get(
  "/api/analytics/:model",
  handle((req) => {
    const a = modelAnalytics(String(req.params.model), analyticsScope(req));
    if (!a) throw new ActionError("No games for this model yet");
    return a;
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
      rated: req.body.rated !== false,
      pairings: roundRobin(unique.map((r) => r.id), !!req.body.doubleRound),
      status: "running",
    };
    // Left out, boards means as many games at once as the players can fill; 1 plays them one at a time.
    if (req.body.boards != null) t.boards = Math.floor(Number(req.body.boards)) || 1;
    t.breakHours = parseBreakHours(req.body.breakHours ?? 0);
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
function parseBreakHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8760)
    throw new ActionError("Break hours must be a number between 0 and 8760.");
  return value;
}

app.post(
  "/api/tournaments/:id/settings",
  localOnly,
  handle((req) => {
    const t = tournaments.get(String(req.params.id));
    if (!t) throw new ActionError("No such tournament");
    const hours = parseBreakHours(req.body.breakHours ?? t.breakHours ?? 0);
    const boards = req.body.boards ?? t.boards;
    if (boards != null && (typeof boards !== "number" || !Number.isInteger(boards) || boards < 1))
      throw new ActionError("Boards must be a positive integer.");
    t.breakHours = hours;
    t.boards = boards;
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
    const res = tournamentNext(t);
    if ("finished" in res) return res;
    // Several boards: only the new games come back, so each orchestrator run launches only what it started.
    if (boardsOf(t) > 1) return { started: res.games.map((g) => ({ game: g, launch: launchSpec(g) })), running: res.running };
    const g = res.games[0];
    if (!g) return { waiting: true, started: [], running: res.running };
    return { game: g, launch: launchSpec(g), ...(res.alreadyRunning ? { alreadyRunning: true } : {}) };
  }),
);

// What one orchestrator run has to do (the T3 webhook's prompt just says to fetch this): the steps for its
// action alone, with the tasks to delegate in it. Body: { action, gameId?, tournamentId?, source?: "chat" }.
app.post(
  "/api/orchestrator/brief",
  localOnly,
  handle((req, res) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const brief = orchestratorBrief(String(b.action ?? ""), { gameId: b.gameId || undefined, tournamentId: b.tournamentId || undefined }, b.source === "chat" ? "chat" : "webhook");
    res.type("text/plain").send(brief);
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
    if (!s || s.gameId !== g.id || (s.role !== "w" && s.role !== "b") || !seatIsHuman(g, s.role)) throw new ActionError("This browser isn't seated in this game.");
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

/**
 * How long a call blocks for the next thing to do. Every model step re-reads the agent's whole
 * conversation, so a WAITING reply is expensive: keep them rare. The CLI allows 330 s, and agents
 * are asked for a 360 s shell timeout.
 */
const WAIT_MS = 300_000;

function seat(key: string) {
  const s = seatKeys[key];
  if (!s) throw new ActionError("Unknown --key. Use the exact key from your instructions. If it worked before, your seat was handed to a new agent after you went quiet: stop now, your task is over.");
  const g = getGame(s.gameId);
  g.seen[s.role] = Date.now();
  return { g, role: s.role };
}

/** What a player should do right now, or null if it must wait. */
function playerTodo(g: Game, c: Color): string | null {
  if (g.clockPause && g.clockPause.code !== "usage_limit") return null;
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

/**
 * The post-game in one call: interview, journal and lessons. Parts already done are skipped, so after
 * a rejection the player can send the same JSON again with the bad part fixed.
 */
function submitPostgame(g: Game, c: Color, input: any): string {
  // A retry of one that went through (its shell timed out mid-wait) just carries on.
  if ((g.phase === "postgame" || g.phase === "finished") && !postgameMissing(g, c).length) return "OK — your post-game is already in.";
  if (g.phase !== "postgame") throw new ActionError("`postgame` is for after the game.");
  if (!input || typeof input !== "object") throw new ActionError('Send a JSON object: { "interview": "…", "journal": "…", "lessons": "…" }.');
  const parts = [
    // Lessons first: they have the strictest checks, so a rejection there leaves nothing half-done.
    { key: "lessons", todo: !!g.options?.learning && !g.lessonsDone?.[c], save: (t: string) => submitLessons(g, c, t) },
    { key: "interview", todo: !g.interviews.post[c], save: (t: string) => submitInterview(g, c, t) },
    { key: "journal", todo: !g.journalDone[c], save: (t: string) => submitJournal(g, c, t) },
  ].filter((p) => p.todo && typeof input[p.key] === "string" && input[p.key].trim());
  if (!parts.length) throw new ActionError(`Nothing to save: include what's still to do (${postgameMissing(g, c).join(", ") || "nothing"}).`);
  const saved: string[] = [];
  for (const p of parts) {
    try {
      p.save(input[p.key]);
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
      throw new ActionError(`"${p.key}" was not saved: ${e.message}${saved.length ? ` (${saved.join(" and ")} saved — send the JSON again with "${p.key}" fixed).` : ""}`);
    }
    saved.push(p.key);
  }
  const missing = postgameMissing(g, c);
  return `OK — saved ${saved.join(", ")}.${missing.length ? ` Still missing: ${missing.join(", ")}.` : ""}`;
}

const postgameMissing = (g: Game, c: Color) =>
  [!g.interviews.post[c] && "interview", !g.journalDone[c] && "journal", !!g.options?.learning && !g.lessonsDone?.[c] && "lessons"].filter(Boolean) as string[];

function waitingReason(g: Game, c: Color) {
  if (g.clockPause) return `game paused: ${g.clockPause.reason}`;
  if (g.phase === "pregame") return "waiting for the other player's interview and the broadcaster's introduction";
  if (g.phase === "playing") return `your opponent is thinking (move ${Math.ceil((g.moves.length + 1) / 2)})`;
  if (g.phase === "postgame") return "the engine is finishing its review";
  return "";
}

/**
 * Long-poll until `check` returns something. `check` must be side-effect free: it runs inside
 * game-change events, so mutating the game from it would re-trigger itself. `recheckMs` also runs
 * it on a timer, for a check that depends on the clock.
 */
function waitUntil<T>(g: Game, check: () => T | null, res: Response, recheckMs?: number): Promise<T | null> {
  return new Promise((resolve) => {
    const now = check();
    if (now) return resolve(now);
    let done = false;
    const finish = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
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
    const ticker = recheckMs ? setInterval(onChange, recheckMs) : undefined;
    bus.on(`game:${g.id}`, onChange);
    res.on("close", onClose);
  });
}

/** Broadcaster batches awaiting acknowledgment from the CLI (in memory; a restart just redelivers). */
const bcAcks = new Map<string, { gameId: string; ids: string[]; done: boolean }>();

function readText(body: any) {
  return String(body?.text ?? "");
}

const PLAYER_COMMANDS = `  wait                 block until something needs you and print it
  move -               submit your move (JSON on standard input: move, commentary, eval, lines, offerDraw)
  accept-draw          accept your opponent's draw offer
  resign               resign the game
  interview -          answer the pre-game interview (text on standard input, or --text "...")
  postgame -           after the game: everything it asks for in one JSON object
  status               print the current position again`;
/** What `help` (and an unknown command) shows each seat: its own commands and nothing else. */
const SEAT_COMMANDS: Record<SeatRole, string> = {
  w: PLAYER_COMMANDS,
  b: PLAYER_COMMANDS,
  x: `  bc-wait              block until there are new events and print them
  say -                put one segment on air (text on standard input, or --text "..."), then wait for the next events`,
  d: `  brief                print the video director brief
  direct <plan.json>   submit your video plan; it's read back to you
  confirm              save the plan once its readback is right
  narrate-brief        once the plan is saved: the brief for the narration over its engine lines
  narrate <file>       submit the narration; it's saved and read back to you
  packaging-brief      once the plan is saved: the brief for new titles, captions and thumbnails
  packaging <file>     submit them; they're saved for the user to pick from
${PROBE_COMMANDS}`,
};

/** Video plans that passed the checks, read back to their director and waiting for `confirm`. */
const planDrafts = new Map<string, VideoPlan>();

/** Quiet moves wait for company, so the broadcaster covers a few in one segment instead of one step per move. */
const BC_BATCH_MOVES = 3;
const BC_HOLD_MS = 90_000;
const BC_BIG = new Set(["brilliant", "great", "mistake", "miss", "blunder"]);
function bcHold(g: Game, fresh: { id: string; ts: number }[]) {
  if (g.phase !== "playing" || fresh.length >= BC_BATCH_MOVES || fresh.some((e) => !e.id.startsWith("move-"))) return false;
  const moves = fresh.map((e) => g.moves[Number(e.id.slice(5)) - 1]);
  if (moves.some((m) => !m || m.illegalAttempts.length || m.offeredDraw || BC_BIG.has(m.analysis?.classification ?? ""))) return false;
  return Date.now() - Math.min(...fresh.map((e) => e.ts)) < BC_HOLD_MS;
}

app.post(
  "/api/agent/:cmd",
  localOnly,
  handle(async (req, res) => {
    const cmd = String(req.params.cmd);
    const key = String(req.body?.key ?? "");
    if (isDirectorThreadKey(key)) return res.type("text/plain").send(await directorThreadCommand(key, cmd, req.body, videoEditBlocked));
    const { g, role } = seat(String(req.body?.key ?? ""));
    const text = (t: string) => res.type("text/plain").send(t);
    // Each seat sees only its own commands.
    if (cmd === "help") return text(`Your commands (run each as: node chess.mjs <command> --key <your key>):\n${SEAT_COMMANDS[role]}`);
    // An agent the server started in its own thread: its thread's title, then its task.
    if (cmd === "start") {
      if ((role === "w" || role === "b") && seatIsHuman(g, role)) throw new ActionError("This seat is played on the website.");
      const task = seatTask(g, role);
      return text(`${task.title}\n\n${task.prompt}`);
    }
    const unknown = () => new ActionError(`Unknown command: ${cmd}. Yours are:\n${SEAT_COMMANDS[role]}`);
    if (role === "d") {
      // The engine questions: any time, as often as the director likes.
      const probed = await probeCommand(g, cmd, req.body?.args);
      if (probed !== null) return text(probed);
      if (["direct", "confirm", "narrate", "packaging"].includes(cmd) && (videoEditBlocked(g) || directorThreadBusy(g))) throw new ActionError("A video edit or render is already in progress. Wait for it to finish.");
      if (cmd === "brief") {
        if (g.video && !planDrafts.has(g.id)) return text("DONE — this game's video plan is saved. Your task is complete; you can stop now.");
        if (g.phase !== "finished" || !needsDirection(g)) throw new ActionError("This game isn't ready for its video plan yet (it needs to be finished and reviewed).");
        // The lines the video can show are followed move by move first (once per game), so the brief lists
        // them whole, every move with its verdict.
        if (!linesReady(g)) {
          const ready = await Promise.race([deepenLines(g), new Promise<"slow">((r) => setTimeout(() => r("slow"), 270_000))]);
          if (ready !== true) {
            const p = linesProgress(g);
            return text(
              ready === "slow"
                ? `WAITING — the engine is still working out this game's lines move by move${p ? ` (${p.done} of ${p.total} starting positions done)` : ""}. Run \`brief\` again.`
                : "WAITING — the engine failed on some of this game's lines; run `brief` again to retry them.",
            );
          }
        }
        return text(directorBrief(g));
      }
      if (cmd === "direct") {
        if (g.phase !== "finished") throw new ActionError("The video plan comes after the game.");
        if (g.video) throw new ActionError("This game's video plan is already saved.");
        // A plan is checked against the lines as the brief listed them, so only once they're all worked out.
        if (!linesReady(g)) throw new ActionError("This game's engine lines aren't worked out yet: run `brief` first, and plan from what it prints.");
        // A plan that passes the checks is read back before it's final: what each quote will draw and light
        // up, and in which colour, for the director to confirm or fix.
        const plan = validatePlan(g, req.body?.plan);
        planDrafts.set(g.id, plan);
        return text(
          `The plan passes the checks (${plan.moments.length} moments).\n${investigationNotes(g, plan).join("\n")}\n\nBefore it's saved, check what the video will draw and light up:\n\n${planReadback(g, plan)}\n` +
            `Colours: green is the speaking player's pieces and moves, red the opponent's, amber an empty square. Go through every line: is each lit word lit for the piece or square the player meant, at the right moment in the idea, in the right colour? Does every drawing show what the words say (never an arrow for something they say can't happen)? Is anything they point at left undrawn?\n` +
            `If all of it is right, run \`confirm\`. If anything is off, fix the plan and submit it again with \`direct\`.`,
        );
      }
      if (cmd === "confirm") {
        const plan = planDrafts.get(g.id);
        if (!plan && g.video) return text("DONE — the video plan is already saved. Your task is complete; you can stop now.");
        if (!plan) throw new ActionError("There's no plan waiting to be confirmed: submit it with `direct <plan.json>` first.");
        planDrafts.delete(g.id);
        g.video = { ...plan, createdAt: Date.now() };
        saveGameNow(g);
        touch(g);
        dropThumbOptions(g.id);
        const lined = plan.moments.filter((x) => x.line).length;
        if (lined)
          return text(
            `OK — video plan saved (${plan.moments.length} moments). One step left: the narration over its ${lined} engine line${lined === 1 ? "" : "s"}. Run \`narrate-brief\`, investigate each line (its questions, then \`board\`/\`probe\`/\`options\`/\`threat\` as much as you need) until you can say why it is what it is, then write it and submit it with \`narrate <narration.json>\`.`,
          );
        return text(`OK — video plan saved (${plan.moments.length} moments).\n\nDONE — your task is complete; you can stop now.`);
      }
      // The narration over a saved plan's engine lines, in its own step: a focused brief, then each submission
      // checked, saved and read back with how it will play.
      if (cmd === "narrate-brief") {
        if (!g.video) throw new ActionError("This game's video plan isn't saved yet: the narration comes after it (run `brief`).");
        // The questions each line raises are worked out first (the engine pass covers only the game's top lines).
        if (!(await linesPrepared(g))) return text("WAITING — the engine is still working out the questions your lines raise. Run `narrate-brief` again.");
        return text(narrateBrief(g));
      }
      if (cmd === "narrate") {
        if (!g.video) throw new ActionError("This game's video plan isn't saved yet: the narration comes after it (run `brief`).");
        const next = applyNarration(g, req.body?.narration);
        g.video = next;
        saveGameNow(g);
        touch(g);
        const back = narratedReadback(g, next);
        return text(
          `OK — narration saved. Here's how it will play (timed by an estimate of the voices):\n\n${back.join("\n") || "(no narrated lines)"}\n` +
            `Read each line as the narrator would say it. Does each hard move get its room (no ⚠)? Is the payoff the line's loudest moment? Does every word fit what's on the board as it's said? If anything's off, fix it and submit again with \`narrate\`.\n\nDONE — the narration is saved; once you're happy with it, your task is complete.`,
        );
      }
      // New titles, captions and thumbnails for a saved plan, leaving the rest of it as it is.
      if (cmd === "packaging-brief") {
        if (!g.video) throw new ActionError("This game's video plan isn't saved yet: the titles, captions and thumbnails come with it (run `brief`).");
        return text(packagingBrief(g));
      }
      if (cmd === "packaging") {
        if (!g.video) throw new ActionError("This game's video plan isn't saved yet: the titles, captions and thumbnails come with it (run `brief`).");
        try {
          setPackagingOptions(g, packagingChoices(g, req.body?.packaging));
        } catch (e) {
          throw e instanceof ActionError ? e : new ActionError((e as Error).message);
        }
        return text(`OK — saved for the user to pick from (your favourites are used until they do):\n\n${packagingReadback(g, g.video.packagingOptions!)}\n\nDONE — your task is complete; you can stop now.`);
      }
      throw unknown();
    }
    // The narrator: the narration over a saved plan's engine lines, after the director. A focused brief, the
    // engine questions, then each submission checked, saved and read back with how it will play.
    if (role === "x") {
      /** Wait for the broadcaster's next events (`say` goes straight on to this too), after `done` if given. */
      const bcNext = async (done = "") => {
        if (done && req.body.noWait) return text(`${done} Run \`bc-wait\`.`);
        const pending = () => {
          const fresh = broadcasterEvents(g).filter((e) => !g.bcDelivered.includes(e.id));
          if (g.phase === "finished" && g.broadcasterDone) return { kind: "done" as const, fresh };
          if (fresh.length && !bcHold(g, fresh)) return { kind: "events" as const, fresh };
          if (g.phase === "finished") return { kind: "done" as const, fresh };
          return null;
        };
        const out = await waitUntil(g, pending, res, 5_000);
        const head = done ? `${done}\n\n` : "";
        if (!out) return text(`${head}WAITING — nothing new yet. Run \`bc-wait\`.`);
        // Events count as consumed only when the CLI acknowledges them after printing (bc-ack);
        // an unacknowledged batch is simply delivered again on the next bc-wait.
        const ack = randomBytes(6).toString("hex");
        bcAcks.set(ack, { gameId: g.id, ids: out.fresh.map((e) => e.id), done: out.kind === "done" });
        res.setHeader("x-ack", ack);
        if (out.kind === "done") return text(`${head}DONE — the broadcast is over. Your task is complete; you can stop now.`);
        return text(head + out.fresh.map((e) => e.text).join("\n\n") + "\n\n(Now `say` something about this.)");
      };
      if (cmd === "bc-wait") return bcNext();
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
        return bcNext(`OK — segment ${line.id} is on air.`);
      }
      throw unknown();
    }

    const c = role as Color;
    // Every command that acts goes straight on to wait for whatever needs the player next, so a turn is one call.
    const next = async (done = "") => {
      // Scripts that drive both seats in turn (--no-wait) can't block on one side.
      if (done && req.body.noWait) return text(`${done} Run \`wait\`.`);
      const out = await waitUntil(g, () => playerTodo(g, c), res);
      if (out) {
        // Seen as of the hand-off: the website's "Agent idle" counts from here, not from when the call began.
        g.seen[c] = Date.now();
        if (out.startsWith("=== YOUR MOVE")) briefed(c);
      }
      return text((done ? `${done}\n\n` : "") + (out ?? `WAITING — ${waitingReason(g, c)}. Run \`wait\`.`));
    };
    const briefed = (col: Color) => (g.briefedAt = { ...g.briefedAt, [col]: g.moves.length });
    switch (cmd) {
      case "wait":
        return next();
      case "status":
        if (g.phase === "playing") briefed(c);
        return text(g.phase === "playing" ? turnBrief(g, c) : playerTodo(g, c) ?? `WAITING — ${waitingReason(g, c)}.`);
      case "move": {
        // A turn is a retry (its shell timed out mid-wait and it was sent again) when it's the same JSON as the
        // last one accepted and the player hasn't been shown the position since: then it isn't played again.
        // The same JSON after seeing the new position is a real move. Both are saved, so a restart keeps them.
        const hash = createHash("sha256").update(JSON.stringify(req.body.turn ?? {})).digest("hex").slice(0, 16);
        const prev = g.lastTurn?.[c];
        const seenSince = (g.briefedAt?.[c] ?? -1) === g.moves.length;
        if (prev?.hash === hash && !seenSince) return next(`OK — you already played ${prev.san} with this exact turn; it wasn't played again.`);
        const rejected = g.rejectedTurns?.[c];
        if (rejected?.ply === g.moves.length && rejected.hashes.includes(hash)) throw new ActionError("Illegal move.");
        let rec: MoveRecord;
        try {
          rec = submitTurn(g, c, req.body.turn ?? {});
        } catch (e) {
          if (e instanceof ActionError && e.message === "Illegal move.") {
            const hashes = rejected?.ply === g.moves.length ? [...rejected.hashes, hash] : [hash];
            g.rejectedTurns = { ...g.rejectedTurns, [c]: { hashes, ply: g.moves.length } };
            saveGameNow(g);
          }
          throw e;
        }
        g.lastTurn = { ...g.lastTurn, [c]: { hash, san: rec.san } };
        saveGameNow(g);
        const lines = rec.lines.length ? ` Lines recorded: ${rec.lines.length}.` : "";
        const over = g.result ? ` The game is over: ${g.result} (${g.termination}).` : "";
        return next(`OK — played ${rec.san}.${lines}${over}`);
      }
      case "accept-draw":
        acceptDraw(g, c);
        return next("OK — draw agreed.");
      case "resign":
        resign(g, c);
        return next("OK — you resigned.");
      case "interview": {
        // A retry of an answer already on record (its shell timed out mid-wait) just waits again, even
        // once the game has moved on to the next phase.
        const t = readText(req.body).trim();
        if (![g.interviews.pre[c]?.text, g.interviews.post[c]?.text].includes(t)) submitInterview(g, c, t);
        return next("OK — interview recorded.");
      }
      case "lessons":
        if (!g.lessonsDone?.[c]) submitLessons(g, c, readText(req.body));
        return next("OK — lessons saved.");
      case "journal":
        if (!g.journalDone[c]) submitJournal(g, c, readText(req.body));
        return next("OK — journal saved.");
      case "postgame":
        return next(submitPostgame(g, c, req.body.postgame));
      default:
        throw unknown();
    }
  }),
);

/* ------------------------------ static ------------------------------ */

app.use("/videos", express.static(VIDEO_DIR));
// The recorded voice lines are a local thing, like the renders that use them.
if (!PUBLIC_MODE) app.use("/voice", express.static(VOICE_DIR));
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
  return {
    jobs: jobsFor(id),
    videos: videosFor(id),
    // The game's folder under data/videos (its name only), where a render by hand puts its files.
    folder: gameFolder(id),
    ...packagingFor(id),
    packaging: g.video?.packaging ?? null,
    packagingOptions: g.video?.packagingOptions ?? null,
    music: musicTracks(),
    directed: !!g.video,
    approved: videoApproved(g),
    revision: videoRevision(g),
    summonAvailable: summonAvailable(),
    ...publishState(g),
  };
};
app.get("/api/games/:id/render", handle((req) => renderState(String(req.params.id))));
function videoEditBlocked(g: Game) {
  return jobsFor(g.id).some(j => !["done", "failed"].includes(j.status)) || g.publish?.status === "requested";
}
app.get("/api/games/:id/director-thread", localOnly, handle(req => directorThreadState(getGame(String(req.params.id)))));
app.post("/api/games/:id/director-thread", localOnly, handle(async req => {
  const g = getGame(String(req.params.id));
  if (videoEditBlocked(g)) throw new ActionError("Wait for rendering or publishing to finish before opening the director.");
  return openDirectorThread(g, req.body);
}));
app.post("/api/games/:id/video-approval", localOnly, handle(req => {
  const g = getGame(String(req.params.id));
  if (!g.video) throw new ActionError("Run the director first.");
  if (directorThreadBusy(g) || videoEditBlocked(g)) throw new ActionError("Wait for the current work to finish before approving.");
  const revision = videoRevision(g);
  if (req.body?.revision !== revision) throw new ActionError("The plan changed. Review the updated preview before approving.");
  g.videoApproval = { revision, at: Date.now() };
  saveGameNow(g); touch(g);
  return renderState(g.id);
}));
// The recorded voice lines (and their lengths, which set the video's timing).
app.get("/api/games/:id/voice", handle((req) => voiceManifest(getGame(String(req.params.id)).id)));
// The same manifest, sent again each time a line is recorded, so the video tab's preview picks voices up as they land.
app.get("/api/games/:id/voice/stream", (req, res) => {
  const g = games.get(String(req.params.id));
  if (!g || PUBLIC_MODE) return void res.status(404).end();
  sse(req, res, `voice:${g.id}`, () => voiceManifest(g.id));
});
// The two models' series, for the replay's versus and result cards.
app.get("/api/games/:id/rivalry", handle((req) => ({ rivalry: rivalry(getGame(String(req.params.id))) })));
app.post(
  "/api/games/:id/render",
  localOnly,
  handle(async (req) => {
    const id = String(req.params.id);
    if (directorThreadBusy(getGame(id))) throw new ActionError("Wait for the director to finish, then approve the plan.");
    const want = req.body?.formats;
    const formats = (Array.isArray(want) ? want : ["landscape", "portrait"]).filter((f: string): f is RenderFormat => f === "landscape" || f === "portrait");
    if (!formats.length) throw new ActionError('formats must include "landscape" and/or "portrait".');
    await startRender(id, formats, req.body?.music ? String(req.body.music) : null, true, req.body?.redirect === true).catch((e) => {
      throw new ActionError(e.message);
    });
    return renderState(id);
  }),
);
// The upload text edited on the video page: { title?, description?, caption? } (an empty description goes back to the generated one).
app.post(
  "/api/games/:id/upload-text",
  localOnly,
  handle((req) => {
    const g = getGame(String(req.params.id));
    try {
      editUploadText(g, req.body ?? {});
    } catch (e) {
      throw new ActionError((e as Error).message);
    }
    return renderState(g.id);
  }),
);
// The user's pick from the director's options on the video page: { title?, caption?, thumbnail? }, each an option's index.
app.post(
  "/api/games/:id/packaging/pick",
  localOnly,
  handle((req) => {
    const g = getGame(String(req.params.id));
    try {
      pickPackaging(g, req.body ?? {});
    } catch (e) {
      throw new ActionError((e as Error).message);
    }
    return renderState(g.id);
  }),
);
// A director task for new titles, captions and thumbnails on a game whose plan is saved (nothing else in the plan changes).
app.get(
  "/api/games/:id/packaging-launch",
  handle((req) => {
    requireAdmin(req);
    const g = getGame(String(req.params.id));
    if (!g.video) throw new ActionError("The game has no video plan yet: its director makes the packaging with it.");
    return packagingLaunch(g);
  }),
);
// "Publish" on the video page: summons a publisher (through the T3 webhook) to post the videos from the user's browser.
app.post(
  "/api/games/:id/publish",
  localOnly,
  handle(async (req) => {
    const g = getGame(String(req.params.id));
    const want = req.body?.platforms;
    const platforms = (Array.isArray(want) ? want : []).filter((p: string): p is PublishPlatform => p === "youtube" || p === "tiktok");
    const visibility = req.body?.visibility;
    if (visibility !== "public" && visibility !== "test") throw new ActionError('visibility must be "public" or "test".');
    await requestPublish(g, platforms, visibility).catch((e) => {
      throw new ActionError(e.message);
    });
    return renderState(g.id);
  }),
);
// The publisher task for the orchestrator to delegate.
app.get(
  "/api/games/:id/publish-launch",
  handle((req) => {
    requireAdmin(req);
    try {
      return publishLaunch(getGame(String(req.params.id)));
    } catch (e) {
      throw new ActionError((e as Error).message);
    }
  }),
);
// The orchestrator records what the publisher reported: { results: { youtube: { url } , tiktok: { error } } }.
app.post(
  "/api/games/:id/published",
  localOnly,
  handle((req) => {
    requireAdmin(req);
    const results = req.body?.results;
    if (!results || typeof results !== "object") throw new ActionError("Send { results: { youtube?: { url, note? } | { error }, tiktok?: … } }.");
    try {
      return recordPublished(getGame(String(req.params.id)), results);
    } catch (e) {
      throw new ActionError((e as Error).message);
    }
  }),
);
// Show a finished video in Explorer / Finder.
app.post(
  "/api/games/:id/videos/open",
  localOnly,
  handle((req) => {
    const id = String(req.params.id);
    const v = videosFor(id)[0];
    const target = v ? videoPath(id, v.kind) : existsSync(gameVideoDir(id)) ? gameVideoDir(id) : VIDEO_DIR;
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
