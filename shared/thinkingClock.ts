import type { Game, GamePause } from "./types";

type Clock = Pick<Game, "turnStartedAt" | "clockPause">;

/** Outage time never contributes to a player's recorded or displayed thinking. */
export function currentThinkMs(g: Clock, now = Date.now()): number {
  return g.turnStartedAt === null ? 0 : Math.max(0, (g.clockPause?.at ?? now) - g.turnStartedAt);
}

export function pauseThinkingClock(g: Clock, pause: GamePause) {
  if (g.clockPause) return;
  g.clockPause = { ...pause, at: Math.min(pause.at, Date.now()) };
}

/**
 * The server was down from `from` (its last sign of life) to `to` (its restart): that isn't thinking either. A
 * paused clock is already frozen. True when the turn's start moved.
 */
export function skipDowntime(g: Clock, from: number, to: number): boolean {
  if (g.turnStartedAt === null || g.clockPause) return false;
  const gap = Math.max(0, to - Math.max(from, g.turnStartedAt));
  g.turnStartedAt += gap;
  return gap > 0;
}

export function resumeThinkingClock(g: Clock, now = Date.now()) {
  if (!g.clockPause) return;
  if (g.turnStartedAt !== null) g.turnStartedAt += Math.max(0, now - Math.max(g.clockPause.at, g.turnStartedAt));
  delete g.clockPause;
}
