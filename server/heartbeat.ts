import path from "node:path";
import { DATA } from "./paths";
import { readJson, writeJson } from "./store";

/*
 * The server's last sign of life, on disk every few seconds. After a crash or a kill, the next boot knows
 * (to within a beat) when the server went down, so the time it was down isn't counted as anyone's thinking
 * or silence.
 */

const FILE = path.join(DATA, "heartbeat.json");
const EVERY_MS = 5_000;

/** When the server was last alive before this boot (null: never recorded). Read before the first beat overwrites it. */
export const lastAliveAt: number | null = readJson<{ at?: number } | null>(FILE, null)?.at ?? null;
/** When this server started. */
export const bootAt = Date.now();

export function beat() {
  try {
    writeJson(FILE, { at: Date.now() });
  } catch (e) {
    console.error("[heartbeat]", (e as Error).message);
  }
}

export function startHeartbeat() {
  beat();
  setInterval(beat, EVERY_MS).unref();
}
