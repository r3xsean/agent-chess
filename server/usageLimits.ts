import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Color, Game } from "../shared/types";
import { pauseGame } from "./pauses";
import { seatKeys } from "./store";

export const T3_DATABASE = process.env.T3_STATE_DB ?? path.join(homedir(), ".t3", "userdata", "statev2.sqlite");

interface UsageFailure { id: string; at: number; resetAt?: number }

/** A seat an orchestrator delegated: its task's clientRequestId is <game>-<seat>, with -r<n> for replacement tasks. */
function delegatedThread(db: DatabaseSync, g: Game, color: Color) {
  const player = color === "w" ? g.white : g.black;
  // Exact decoded matching avoids mistaking another game's thread or an arbitrary title for this seat.
  const threads = db.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE provider_instance_id = ? AND created_at >= ? AND thread_id LIKE ? ORDER BY created_at DESC`).all(
    player.provider, new Date(g.createdAt).toISOString(), `%${g.id}-${color}%`,
  ) as { thread_id: string }[];
  const suffix = new RegExp(`:delegate-task:${g.id}-${color}(?:-r\\d+)?$`);
  return threads.find((t) => {
    try { return suffix.test(decodeURIComponent(t.thread_id)); } catch { return false; }
  });
}

/** Threads found for webhook deliveries, so each is looked up once. */
const byDelivery = new Map<string, string>();

/**
 * A seat the server started in its own thread: the thread whose first message came from the seat key's
 * webhook delivery, among the threads made around its launch.
 */
function directThread(db: DatabaseSync, g: Game, color: Color) {
  const launch = g.directLaunch?.[color];
  const key = Object.entries(seatKeys).find(([, v]) => v.gameId === g.id && v.role === color)?.[0];
  const delivery = key ? seatKeys[key].delivery : undefined;
  if (!launch || !delivery) return undefined;
  const known = byDelivery.get(delivery);
  if (known) return { thread_id: known };
  const threads = db.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads WHERE created_at >= ? AND created_at <= ?`).all(
    new Date(launch.at - 60_000).toISOString(), new Date(launch.at + 10 * 60_000).toISOString(),
  ) as { thread_id: string }[];
  const first = db.prepare(`SELECT turn_item_id FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND type = 'user_message' ORDER BY ordinal LIMIT 1`);
  const thread = threads.find((t) => ((first.get(t.thread_id) as { turn_item_id: string } | undefined)?.turn_item_id ?? "").includes(delivery.replace(/^delivery:relay:/, "")));
  if (thread) byDelivery.set(delivery, thread.thread_id);
  return thread;
}

/**
 * Whether a player's usage limit should pause the game: not once it has done its part of the pregame or
 * postgame, when it has nothing left to do that would lift the pause.
 */
export function usageLimitPauses(g: Game, color: Color) {
  if ((color === "w" ? g.white : g.black).provider === "human") return false;
  if (g.phase === "pregame" && g.interviews.pre[color]) return false;
  if (g.phase === "postgame" && g.interviews.post[color] && g.journalDone[color] && (!g.options?.learning || g.lessonsDone?.[color])) return false;
  return true;
}

/** A player's last real action (a move, an interview or anything else that acts, never a status check or a wait). */
export const lastActionAt = (g: Game, color: Color) =>
  Math.max(g.lastAgentActionAt?.[color] ?? 0, g.moves.filter((m) => m.color === color).at(-1)?.ts ?? 0, g.interviews.pre[color]?.ts ?? 0, g.interviews.post[color]?.ts ?? 0);

/** T3's SQLite schema is internal. Keep its read-only adapter isolated and fail without pausing. */
function readFailure(db: DatabaseSync, g: Game, color: Color): UsageFailure | null {
  if (!usageLimitPauses(g, color)) return null;
  const thread = directThread(db, g, color) ?? delegatedThread(db, g, color);
  if (!thread) return null;
  const row = db.prepare(`SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND type = 'error' AND status = 'failed' AND parent_item_id IS NULL
    ORDER BY updated_at DESC, ordinal DESC LIMIT 1`).get(thread.thread_id) as { turn_item_id: string; payload_json: string } | undefined;
  if (!row) return null;
  const item = JSON.parse(row.payload_json);
  if (item.failure?.class !== "usage_limit") return null;
  const at = Date.parse(item.completedAt ?? item.updatedAt);
  if (!Number.isFinite(at) || at < g.createdAt || at > Date.now()) return null;
  const resetAt = Date.parse(item.failure.resetAt);
  // Persist a fingerprint, not T3's internal thread/run identifiers, in publicly mirrored game data.
  return { id: createHash("sha256").update(row.turn_item_id).digest("hex"), at, ...(Number.isFinite(resetAt) ? { resetAt } : {}) };
}

/** One bounded sweep. Only reads T3, and writes through the chess server's normal persistence/events. */
export function checkUsageLimits(games: Iterable<Game>, database: string, changed: (g: Game) => void) {
  const active = [...games].filter((g) => g.phase !== "finished");
  if (!active.length || !existsSync(database)) return;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100");
    // Read everything before applying changes: an incompatible schema cannot partially pause games.
    const failures = active.flatMap((g) => (["w", "b"] as Color[]).map((color) => ({ g, color, failure: readFailure(db, g, color) })));
    for (const { g, color, failure } of failures) if (failure && applyUsageLimit(g, color, failure)) changed(g);
  } finally {
    db.close();
  }
}

/**
 * Pause a game's thinking clock for a player's usage limit (from its T3 thread, or the log of an agent the
 * server runs itself), unless it was seen already or the player has acted since. Whether anything changed.
 */
export function applyUsageLimit(g: Game, color: Color, failure: UsageFailure) {
  if (g.usageLimitSeen?.[color] === failure.id) return false;
  g.usageLimitSeen = { ...g.usageLimitSeen, [color]: failure.id };
  if (failure.at > lastActionAt(g, color)) {
    const provider = (color === "w" ? g.white : g.black).provider === "claudeAgent" ? "Claude" : (color === "w" ? g.white : g.black).provider === "codex" ? "Codex" : "Model";
    pauseGame(g, { at: failure.at, code: "usage_limit", reason: `${provider} usage limit reached`, seats: [color], resetAt: failure.resetAt });
    if (g.clockPause?.code === "usage_limit") {
      g.clockPause.at = Math.min(g.clockPause.at, failure.at);
      g.clockPause.seats = [...new Set([...(g.clockPause.seats ?? []), color])];
      g.clockPause.resetAt = Math.max(g.clockPause.resetAt ?? 0, failure.resetAt ?? 0) || undefined;
      const providers = new Set(g.clockPause.seats.map((c) => (c === "w" ? g.white : g.black).provider));
      if (providers.size > 1) g.clockPause.reason = "Model usage limits reached";
    }
  }
  return true;
}

export function startUsageLimitWatcher(games: () => Iterable<Game>, changed: (g: Game) => void) {
  if (process.env.T3_USAGE_WATCH === "0") return;
  let warned = false;
  const sweep = () => {
    try {
      checkUsageLimits(games(), T3_DATABASE, changed);
      warned = false;
    } catch {
      if (!warned) console.warn("[usage] T3 usage detection unavailable; existing pauses are preserved. Check T3_STATE_DB and T3 schema compatibility.");
      warned = true;
    }
  };
  sweep();
  setInterval(sweep, 5_000).unref();
}
