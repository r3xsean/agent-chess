import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Game, JournalEntry, Lessons, PlayerRef, PlayerStats, SeatRole, Tournament } from "../shared/types";
import { DATA } from "./paths";
import { GLICKO_START } from "./glicko";

const dirs = ["games", "tournaments", "journals", "agents"].map((d) => path.join(DATA, d));
for (const d of dirs) mkdirSync(d, { recursive: true });

function writeJson(file: string, value: unknown) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, file);
}
const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};
const safe = (id: string) => id.replace(/[^a-zA-Z0-9._-]/g, "_");

/** "journal" (player id) and "lessons" (model) when a player's memory changes — the mirror follows them. */
export const memoryEvents = new EventEmitter();

export const games = new Map<string, Game>();
export const tournaments = new Map<string, Tournament>();
export let players: Record<string, PlayerStats> = {};
/** Secret per seat, so the CLI can only act for the seat it was given (w, b, the broadcaster x, the video director d). */
export let seatKeys: Record<string, { gameId: string; role: SeatRole }> = {};

/** Orchestrator credential for endpoints that reveal seat keys (launch specs). Stored in data/admin-token.txt. */
export let adminToken = "";

export function loadAll() {
  const tokenFile = path.join(DATA, "admin-token.txt");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(16).toString("hex"));
  adminToken = readFileSync(tokenFile, "utf8").trim();
  for (const f of readdirSync(path.join(DATA, "games"))) {
    if (!f.endsWith(".json")) continue;
    const g = readJson<Game | null>(path.join(DATA, "games", f), null);
    if (g) games.set(g.id, g);
  }
  for (const f of readdirSync(path.join(DATA, "tournaments"))) {
    if (!f.endsWith(".json")) continue;
    const t = readJson<Tournament | null>(path.join(DATA, "tournaments", f), null);
    if (t) tournaments.set(t.id, t);
  }
  players = readJson(path.join(DATA, "players.json"), {});
  seatKeys = readJson(path.join(DATA, "seats.json"), {});
}

const pending = new Map<string, NodeJS.Timeout>();
function debounce(key: string, fn: () => void, ms = 250) {
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    fn();
  }, ms));
}

export const saveGame = (g: Game) => debounce(`g:${g.id}`, () => writeJson(path.join(DATA, "games", `${safe(g.id)}.json`), g));
/** Synchronous write for acknowledged actions (moves, results) so a crash can't lose them. */
export function saveGameNow(g: Game) {
  clearTimeout(pending.get(`g:${g.id}`));
  pending.delete(`g:${g.id}`);
  writeJson(path.join(DATA, "games", `${safe(g.id)}.json`), g);
}
/** The public mirror drops a game the local server no longer has. */
export function deleteGameFile(id: string) {
  clearTimeout(pending.get(`g:${id}`));
  pending.delete(`g:${id}`);
  rmSync(path.join(DATA, "games", `${safe(id)}.json`), { force: true });
}
export function saveSeatsNow() {
  clearTimeout(pending.get("seats"));
  pending.delete("seats");
  writeJson(path.join(DATA, "seats.json"), seatKeys);
}
export function saveTournamentNow(t: Tournament) {
  clearTimeout(pending.get(`t:${t.id}`));
  pending.delete(`t:${t.id}`);
  writeJson(path.join(DATA, "tournaments", `${safe(t.id)}.json`), t);
}
export function savePlayersNow() {
  clearTimeout(pending.get("players"));
  pending.delete("players");
  writeJson(path.join(DATA, "players.json"), players);
}
export const saveTournament = (t: Tournament) =>
  debounce(`t:${t.id}`, () => writeJson(path.join(DATA, "tournaments", `${safe(t.id)}.json`), t));
export const savePlayers = () => debounce("players", () => writeJson(path.join(DATA, "players.json"), players));
export const saveSeats = () => debounce("seats", () => writeJson(path.join(DATA, "seats.json"), seatKeys));

export function flushAll() {
  for (const [key] of pending) clearTimeout(pending.get(key));
  for (const g of games.values()) writeJson(path.join(DATA, "games", `${safe(g.id)}.json`), g);
  for (const t of tournaments.values()) writeJson(path.join(DATA, "tournaments", `${safe(t.id)}.json`), t);
  writeJson(path.join(DATA, "players.json"), players);
  writeJson(path.join(DATA, "seats.json"), seatKeys);
}

export const freshStats = () => ({
  rating: GLICKO_START.rating,
  rd: GLICKO_START.rd,
  glicko: { ...GLICKO_START },
  games: 0,
  wins: 0,
  draws: 0,
  losses: 0,
});

export function ensurePlayer(ref: PlayerRef): PlayerStats {
  if (!players[ref.id]) {
    players[ref.id] = { id: ref.id, ref, ...freshStats() };
    savePlayers();
  }
  return players[ref.id];
}

const journalFile = (playerId: string) => path.join(DATA, "journals", `${safe(playerId)}.json`);
export const readJournal = (playerId: string): JournalEntry[] => readJson(journalFile(playerId), []);
/** Replace a player's whole journal (the public mirror, receiving it). */
export const writeJournal = (playerId: string, entries: JournalEntry[]) => writeJson(journalFile(playerId), entries);
export function appendJournal(playerId: string, entry: JournalEntry) {
  const all = readJournal(playerId).filter((e) => !(e.gameId === entry.gameId && e.color === entry.color));
  all.push(entry);
  writeJson(journalFile(playerId), all);
  memoryEvents.emit("journal", playerId);
}

/* Lessons: one short, self-curated playbook per model, shared by all its personalities. */
const lessonsFile = (model: string) => path.join(DATA, "lessons", `${safe(model)}.json`);
export const readLessons = (model: string): Lessons =>
  readJson(lessonsFile(model), { model, version: 0, text: "", updatedAt: null, history: [] } as Lessons);
/** Goes up with every lessons write, here or arriving at the mirror, so readers can cache lessons files. */
export let lessonsRevision = 0;
export function writeLessons(model: string, text: string, gameId: string | null) {
  lessonsRevision++;
  const cur = readLessons(model);
  const next: Lessons = {
    model,
    version: cur.version + 1,
    text,
    updatedAt: Date.now(),
    history: [...cur.history, { version: cur.version + 1, ts: Date.now(), gameId, text }].slice(-50),
  };
  mkdirSync(path.join(DATA, "lessons"), { recursive: true });
  writeJson(lessonsFile(model), next);
  memoryEvents.emit("lessons", model);
  return next;
}

/** Store a model's lessons as they are (the public mirror, receiving them). */
export function writeLessonsFile(model: string, lessons: Lessons) {
  lessonsRevision++;
  mkdirSync(path.join(DATA, "lessons"), { recursive: true });
  writeJson(lessonsFile(model), lessons);
}

export const agentDir = (gameId: string, role: string) => {
  const d = path.join(DATA, "agents", safe(gameId), role);
  mkdirSync(d, { recursive: true });
  return d;
};
