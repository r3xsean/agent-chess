import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Game, JournalEntry, Lessons, PlayerStats, Tournament } from "../shared/types";
import { DATA } from "./paths";
import {
  deleteGameFile,
  games,
  memoryEvents,
  players,
  readJournal,
  readLessons,
  saveGameNow,
  savePlayersNow,
  saveTournamentNow,
  tournaments,
  writeJournal,
  writeLessonsFile,
} from "./store";

/*
 * The public site is a read-only mirror. Games are played here, on the local server; every change is
 * pushed to the mirror (data/mirror.json: { "url": "https://…", "secret": "…" }, or MIRROR_URL and
 * MIRROR_SECRET). The mirror shows what it's sent and takes viewers' predictions; nothing flows back.
 */

export interface MirrorConfig {
  url: string;
  secret: string;
}

export function mirrorConfig(): MirrorConfig | null {
  if (process.env.MIRROR_URL && process.env.MIRROR_SECRET) return { url: process.env.MIRROR_URL.replace(/\/+$/, ""), secret: process.env.MIRROR_SECRET };
  const file = path.join(DATA, "mirror.json");
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8"));
    return c.url && c.secret ? { url: String(c.url).replace(/\/+$/, ""), secret: String(c.secret) } : null;
  } catch {
    console.error("[mirror] data/mirror.json is not valid JSON");
    return null;
  }
}

/** Everything the mirror needs, in one batch. */
export interface SyncBatch {
  /** Increases with every batch the local server sends, so a late, stale batch can't overwrite a newer one. */
  seq?: number;

  games?: Game[];
  /** On a full sync: every game id that exists, so the mirror can drop any it has that we don't. */
  allGameIds?: string[];
  tournaments?: Tournament[];
  players?: Record<string, PlayerStats>;
  journals?: Record<string, JournalEntry[]>;
  lessons?: Record<string, Lessons>;
}

/* ------------------------------ the local side: push ------------------------------ */

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");
const sent = new Map<string, string>();
const pendingGames = new Set<string>();
const pendingJournals = new Set<string>();
const pendingLessons = new Set<string>();
let pendingMeta = false;
let timer: NodeJS.Timeout | null = null;
/** A push is on the wire: the next one waits for it, so batches always arrive in order. */
let inFlight = false;
let failures = 0;
let cfg: MirrorConfig | null = null;
let fullSyncDone = false;
let lastSeq = 0;
/** Strictly increasing across restarts too (time-based). */
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now()));

export const mirrorStatus = () => ({ configured: !!cfg, url: cfg?.url ?? null, synced: fullSyncDone, failures });

/** Start pushing to the mirror (no-op when none is configured). Call `mirrorChanged` whenever something changes. */
export function startMirror() {
  cfg = mirrorConfig();
  if (!cfg) return;
  console.log(`[mirror] pushing to ${cfg.url}`);
  queueEverything();
  memoryEvents.on("journal", (id: string) => (pendingJournals.add(id), mirrorChanged()));
  memoryEvents.on("lessons", (model: string) => (pendingLessons.add(model), mirrorChanged()));
  setInterval(heartbeat, 60_000).unref();
  schedule(500);
}

class ResyncError extends Error {}
/** The mirror's storage identity, from its acknowledgements: if it changes, the mirror lost what we sent. */
let mirrorEpoch: string | null = null;

/** A full sync: every game, and every player's journal and model's lessons that exist. */
function queueEverything() {
  for (const g of games.values()) {
    pendingGames.add(g.id);
    for (const p of [g.white, g.black]) {
      pendingJournals.add(p.id);
      if (p.provider !== "human") pendingLessons.add(p.model);
    }
  }
  pendingMeta = true;
}

export function mirrorChanged(g?: Game) {
  if (!cfg) return;
  if (g) pendingGames.add(g.id);
  pendingMeta = true;
  // Moves go out fast: the mirror's prediction cut-off is when it hears of them.
  schedule(g ? 300 : 1500);
}

/** Even when nothing changes, check now and then that the mirror still has its storage (a wiped volume needs everything again). */
async function heartbeat() {
  if (!cfg || inFlight || !mirrorEpoch) return;
  try {
    const r = await fetch(`${cfg.url}/api/mirror/status`, { signal: AbortSignal.timeout(15_000) });
    const s = (await r.json()) as { epoch?: string };
    if (s.epoch && s.epoch !== mirrorEpoch) {
      console.log("[mirror] the mirror's storage was reset: sending everything again");
      mirrorEpoch = s.epoch;
      sent.clear();
      fullSyncDone = false;
      queueEverything();
      schedule(200);
    }
  } catch {
    // Unreachable for now; the next push or heartbeat tries again.
  }
}

let timerDue = 0;
/** Push in `ms` — or sooner, if a push is already due sooner. */
function schedule(ms: number) {
  if (inFlight) return;
  const due = Date.now() + ms;
  if (timer && timerDue <= due) return;
  if (timer) clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(() => {
    timer = null;
    push().catch((e) => console.error("[mirror]", e));
  }, ms);
}

async function push() {
  if (!cfg || inFlight || (!pendingGames.size && !pendingMeta && !pendingJournals.size && !pendingLessons.size)) return;
  inFlight = true;
  const ids = [...pendingGames];
  const journalIds = [...pendingJournals];
  const models = [...pendingLessons];
  const meta = pendingMeta;
  pendingGames.clear();
  pendingJournals.clear();
  pendingLessons.clear();
  pendingMeta = false;

  const batch: SyncBatch = {};
  const changed: [string, string][] = [];
  const keep = (key: string, value: unknown) => {
    const h = hash(value);
    if (sent.get(key) === h) return false;
    changed.push([key, h]);
    return true;
  };
  const gameList = ids.map((id) => games.get(id)).filter((g): g is Game => !!g && keep(`g:${g.id}`, g));
  if (gameList.length) batch.games = gameList;
  if (!fullSyncDone) batch.allGameIds = [...games.keys()];
  if (meta) {
    if (keep("players", players)) batch.players = players;
    const ts = [...tournaments.values()];
    if (keep("tournaments", ts)) batch.tournaments = ts;
  }
  const journals: Record<string, JournalEntry[]> = {};
  for (const id of journalIds) {
    const j = readJournal(id);
    if (keep(`j:${id}`, j)) journals[id] = j;
  }
  if (Object.keys(journals).length) batch.journals = journals;
  const lessons: Record<string, Lessons> = {};
  for (const model of models) {
    const l = readLessons(model);
    if (l.version > 0 && keep(`l:${model}`, l)) lessons[model] = l;
  }
  if (Object.keys(lessons).length) batch.lessons = lessons;

  const restore = () => {
    for (const id of ids) pendingGames.add(id);
    for (const id of journalIds) pendingJournals.add(id);
    for (const m of models) pendingLessons.add(m);
    pendingMeta ||= meta;
  };
  try {
    if (Object.keys(batch).length) {
      batch.seq = nextSeq();
      const body = gzipSync(JSON.stringify(batch));
      const r = await fetch(`${cfg.url}/api/mirror/sync`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${cfg.secret}` },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const ack = (await r.json().catch(() => ({}))) as { stale?: boolean; acceptedSeq?: number; epoch?: string };
      // A mirror with fresh storage (new epoch) has none of what we sent before: start again from scratch.
      if (ack.epoch && mirrorEpoch && ack.epoch !== mirrorEpoch) {
        mirrorEpoch = ack.epoch;
        throw new ResyncError("the mirror's storage was reset");
      }
      mirrorEpoch ??= ack.epoch ?? null;
      // Our clock is behind what the mirror last accepted (a clock correction, then a restart): jump past it and resend.
      if (ack.stale) {
        lastSeq = Math.max(lastSeq, Number(ack.acceptedSeq) || 0);
        throw new Error("batch was older than the mirror's last one; resending");
      }
      for (const [k, h] of changed) sent.set(k, h);
      if (!fullSyncDone) console.log(`[mirror] full sync done (${gameList.length} games, ${(body.length / 1024).toFixed(0)} KB)`);
    }
    fullSyncDone = true;
    failures = 0;
  } catch (e) {
    if (e instanceof ResyncError) {
      console.log(`[mirror] ${e.message}: sending everything again`);
      inFlight = false;
      sent.clear();
      fullSyncDone = false;
      queueEverything();
      schedule(200);
      return;
    }
    // Put everything back and try again later; the next success sends the latest state anyway (with a newer seq,
    // so if this one still lands late, the mirror ignores it).
    restore();
    failures++;
    const wait = Math.min(120_000, 2000 * 2 ** Math.min(failures, 6));
    if (failures <= 3 || failures % 10 === 0) console.error(`[mirror] push failed (${(e as Error).message}); retrying in ${Math.round(wait / 1000)}s`);
    inFlight = false;
    schedule(wait);
    return;
  }
  inFlight = false;
  // Changes that arrived during the push: moves go out at once, everything else shortly.
  if (pendingGames.size) schedule(300);
  else if (pendingMeta || pendingJournals.size || pendingLessons.size) schedule(1500);
}

/* ------------------------------ the public side: receive ------------------------------ */

const SEQ_FILE = path.join(DATA, "mirror-seq.json");
const saved = existsSync(SEQ_FILE) ? JSON.parse(readFileSync(SEQ_FILE, "utf8")) : {};
let acceptedSeq = Number(saved.seq) || 0;
/** Names this storage: a wiped volume gets a new one, which tells the local server to resend everything. */
export const storageEpoch = typeof saved.epoch === "string" ? saved.epoch : randomBytes(8).toString("hex");
const persistSeq = () => {
  writeFileSync(SEQ_FILE + ".tmp", JSON.stringify({ seq: acceptedSeq, epoch: storageEpoch }));
  renameSync(SEQ_FILE + ".tmp", SEQ_FILE);
};
if (!saved.epoch && process.env.PUBLIC_MODE === "1") persistSeq();
export const syncAck = (extra: object) => ({ ok: true, acceptedSeq, epoch: storageEpoch, ...extra });
export const mirrorPublicStatus = () => ({ epoch: storageEpoch });

/** Only batches newer than the last one applied are taken (a retried push can arrive after its replacement). */
export function acceptSeq(seq: unknown): boolean {
  const n = Number(seq);
  if (!Number.isFinite(n) || n <= acceptedSeq) return false;
  acceptedSeq = n;
  persistSeq();
  return true;
}

/*
 * Prediction cut-offs are the moment this mirror first hears of a move (or result), by its own clock: no clocks
 * are compared, and a cut-off never moves once set. Only someone watching the local server itself (127.0.0.1) can
 * see a move before that, and the local site stops taking guesses for a move it has already shown.
 */
/** Apply a batch from the local server to this (public) server's store. Returns the changed game ids. */
export function ingest(batch: SyncBatch): string[] {
  const changed: string[] = [];
  const now = Date.now();
  for (const g of batch.games ?? []) {
    if (!g || typeof g.id !== "string" || !/^[\w-]+$/.test(g.id) || !Array.isArray(g.moves)) continue;
    const cut: Record<string, number> = { ...games.get(g.id)?.mirrorCutoffs };
    for (const m of g.moves) cut[m.ply] ??= now;
    if (g.result) cut.end ??= now;
    g.mirrorCutoffs = cut;
    games.set(g.id, g);
    saveGameNow(g);
    changed.push(g.id);
  }
  if (batch.allGameIds) {
    const keep = new Set(batch.allGameIds);
    for (const id of [...games.keys()]) {
      if (keep.has(id)) continue;
      games.delete(id);
      deleteGameFile(id);
      changed.push(id);
    }
  }
  for (const t of batch.tournaments ?? []) {
    if (!t || typeof t.id !== "string") continue;
    tournaments.set(t.id, t);
    saveTournamentNow(t);
  }
  if (batch.players) {
    for (const id of Object.keys(players)) if (!(id in batch.players)) delete players[id];
    Object.assign(players, batch.players);
    savePlayersNow();
  }
  for (const [id, entries] of Object.entries(batch.journals ?? {})) if (Array.isArray(entries)) writeJournal(id, entries);
  for (const [model, l] of Object.entries(batch.lessons ?? {})) if (l && typeof l.version === "number") writeLessonsFile(model, l);
  return changed;
}
