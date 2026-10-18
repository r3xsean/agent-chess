import type { Color, Game, GamePause } from "../shared/types";
import { pauseThinkingClock, resumeThinkingClock } from "../shared/thinkingClock";

/** Migrate the temporary timer freeze installed during the first live outage. */
export function migratePause(g: Game) {
  if (!g.clockPause || g.clockPause.code) return;
  const usage = /^Claude usage limit reached/.test(g.clockPause.reason);
  g.clockPause.code = usage ? "usage_limit" : "manual";
  if (usage) {
    g.clockPause.reason = "Claude usage limit reached";
    g.clockPause.seats = [g.moves.length % 2 === 0 ? "w" : "b"];
  }
}

export function pauseGame(g: Game, pause: GamePause) {
  if (g.phase === "finished") return;
  pauseThinkingClock(g, pause);
}

/** Called only after a real action succeeds, never by status/wait or a duplicate request. */
export function playerActed(g: Game, color: Color, now = Date.now()) {
  g.lastAgentActionAt = { ...g.lastAgentActionAt, [color]: now };
  const pause = g.clockPause;
  if (pause?.code !== "usage_limit" || !pause.seats?.includes(color)) return;
  pause.seats = pause.seats.filter((c) => c !== color);
  if (!pause.seats.length) resumeThinkingClock(g, now);
}
