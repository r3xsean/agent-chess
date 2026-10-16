import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Game, JournalEntry, Lessons, PlayerStats, Tournament } from "../shared/types";
import { DATA } from "./paths";
import { deleteGameFile, games, players, readJournal, readLessons, saveGameNow, savePlayersNow, saveTournamentNow, tournaments, writeJournal, writeLessonsFile } from "./store";

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
let pendingMeta = false;
let timer: NodeJS.Timeout | null = null;
let failures = 0;
let cfg: MirrorConfig | null = null;
let fullSyncDone = false;

export const mirrorStatus = () => ({ configured: !!cfg, url: cfg?.url ?? null, synced: fullSyncDone, failures });

/** Start pushing to the mirror (no-op when none is configured). Call `mirrorChanged` whenever something changes. */
export function startMirror() {
  cfg = mirrorConfig();
  if (!cfg) return;
  console.log(`[mirror] pushing to ${cfg.url}`);
  for (const id of games.keys()) pendingGames.add(id);
  pendingMeta = true;
  schedule(500);
}

export function mirrorChanged(g?: Game) {
  if (!cfg) return;
  if (g) pendingGames.add(g.id);
  pendingMeta = true;
  schedule(1500);
}

function schedule(ms: number) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    push().catch((e) => console.error("[mirror]", e));
  }, ms);
}

async function push() {
  if (!cfg || (!pendingGames.size && !pendingMeta)) return;
  const ids = [...pendingGames];
  pendingGames.clear();
  const meta = pendingMeta;
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
    // Journals and lessons only change during a post-game, which is always a game change too.
    const journals: Record<string, JournalEntry[]> = {};
    const lessons: Record<string, Lessons> = {};
    const scope = fullSyncDone ? gameList : [...games.values()];
    for (const g of scope) {
      for (const p of [g.white, g.black]) {
        const j = readJournal(p.id);
        if (j.length && keep(`j:${p.id}`, j)) journals[p.id] = j;
        if (p.provider !== "human" && !(p.model in lessons)) {
          const l = readLessons(p.model);
          if (l.version > 0 && keep(`l:${p.model}`, l)) lessons[p.model] = l;
        }
      }
    }
    if (Object.keys(journals).length) batch.journals = journals;
    if (Object.keys(lessons).length) batch.lessons = lessons;
  }
  if (!Object.keys(batch).length) return;

  try {
    const body = gzipSync(JSON.stringify(batch));
    const r = await fetch(`${cfg.url}/api/mirror/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${cfg.secret}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    for (const [k, h] of changed) sent.set(k, h);
    if (!fullSyncDone) console.log(`[mirror] full sync done (${gameList.length} games, ${(body.length / 1024).toFixed(0)} KB)`);
    fullSyncDone = true;
    failures = 0;
  } catch (e) {
    // Put everything back and try again later; the next success sends the latest state anyway.
    for (const id of ids) pendingGames.add(id);
    pendingMeta ||= meta;
    failures++;
    const wait = Math.min(120_000, 2000 * 2 ** Math.min(failures, 6));
    if (failures <= 3 || failures % 10 === 0) console.error(`[mirror] push failed (${(e as Error).message}); retrying in ${Math.round(wait / 1000)}s`);
    schedule(wait);
    return;
  }
  if (pendingGames.size || pendingMeta) schedule(1500);
}

/* ------------------------------ the public side: receive ------------------------------ */

/** Apply a batch from the local server to this (public) server's store. Returns the changed game ids. */
export function ingest(batch: SyncBatch): string[] {
  const changed: string[] = [];
  for (const g of batch.games ?? []) {
    if (!g || typeof g.id !== "string" || !Array.isArray(g.moves)) continue;
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
