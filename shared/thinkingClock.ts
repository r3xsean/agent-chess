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

export function resumeThinkingClock(g: Clock, now = Date.now()) {
  if (!g.clockPause) return;
  if (g.turnStartedAt !== null) g.turnStartedAt += Math.max(0, now - Math.max(g.clockPause.at, g.turnStartedAt));
  delete g.clockPause;
}
