import type { Game, SeatRole, Tournament } from "../shared/types";
import { games, saveGameNow, saveSeatsNow, saveTournament, seatKeys, tournaments } from "./store";
import { claimSeats, directorKey, playerFinished, rotateSeatKey, seatClaimed, seatIsHuman, seatKeysFor, startablePairings, touch } from "./game";
import { directorLaunch, directorWho, launchSpec } from "./prompts";
import { needsDirection } from "./director";
import { tournamentNext } from "./orchestrator";
import { agentWebhook, orchestratorAvailable, summonAvailable, triggerAgent, triggerOrchestrator } from "./summon";

/*
 * Launching agents. A seat whose model and effort have an agent webhook is started by the server itself,
 * in its own T3 thread: the run gets only its seat key, and `start` gives it its task. The server watches
 * those seats and starts a new agent for one that goes quiet. Any other seat goes to an orchestrator run,
 * which delegates it and looks after it. The server also starts the next games of an auto-run tournament
 * and a broadcast game's video director once it's over.
 */

type Who = { model: string; effort: string };

/** The model and effort a seat's agent runs on. */
function whoFor(g: Game, seat: SeatRole): Who {
  if (seat === "w" || seat === "b") return seat === "w" ? g.white : g.black;
  if (seat === "x") return g.broadcaster!;
  return directorWho(g);
}

/**
 * Start a seat's agent in its own thread. False when no agent webhook covers its model and effort, or T3
 * refused (then the seat is free again). The seat is taken before anything is sent, so two launches at
 * once never start it twice. A seat started before gets a new key, so its earlier agent can't act for it.
 */
async function launchDirect(g: Game, seat: SeatRole): Promise<boolean> {
  const { model, effort } = whoFor(g, seat);
  const url = agentWebhook(model, effort);
  if (!url) return false;
  const prev = g.directLaunch?.[seat];
  const key = prev ? rotateSeatKey(g.id, seat) : seat === "d" ? directorKey(g.id) : seatKeysFor(g.id)[seat];
  claimSeats(g, [seat]);
  g.directLaunch = { ...g.directLaunch, [seat]: { at: Date.now(), relaunches: prev ? prev.relaunches + 1 : 0 } };
  saveGameNow(g);
  try {
    const delivery = await triggerAgent(url, key);
    // Kept with the key (local only, never mirrored): usage-limit detection finds the agent's thread by it.
    if (delivery && seatKeys[key]) {
      seatKeys[key].delivery = delivery;
      saveSeatsNow();
    }
    return true;
  } catch (e) {
    console.error(`[launch] ${g.id} ${seat}: ${(e as Error).message}`);
    // A relaunch keeps its record, so the watch tries again later; a first launch goes to the orchestrator.
    if (!prev) {
      delete g.launched?.[seat];
      delete g.directLaunch[seat];
      saveGameNow(g);
    }
    return false;
  }
}

/** Start a game's agents that aren't started yet: each in its own thread where it can be, the rest through an orchestrator run. */
export async function launchGame(g: Game): Promise<{ direct: SeatRole[]; orchestrator: boolean }> {
  const seats = launchSpec(g).tasks.map((t) => t.seat as SeatRole).filter((s) => !seatClaimed(g, s));
  const ok = await Promise.all(seats.map((s) => launchDirect(g, s)));
  const direct = seats.filter((_, i) => ok[i]);
  // The orchestrator's brief hands out only the seats still free: the ones started here are taken.
  const rest = seats.length > direct.length;
  if (rest) await triggerOrchestrator({ action: "start-game", gameId: g.id });
  touch(g);
  return { direct, orchestrator: rest };
}

/** Start a finished game's video director (none if there's nothing to plan, or one is already at it). */
export async function launchDirector(g: Game): Promise<string | undefined> {
  const spec = directorLaunch(g);
  if (!spec.tasks.length) return "note" in spec ? spec.note : undefined;
  if (await launchDirect(g, "d")) return;
  // The orchestrator's brief hands the seat out itself.
  if (g.launched) delete g.launched.d;
  saveGameNow(g);
  await triggerOrchestrator({ action: "direct-video", gameId: g.id });
}

/** When each tournament game was last launched, so a launch that failed (T3 unreachable) is tried again later. */
const launchTried = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/** Start whatever an auto-run tournament can start now (never making games nothing could launch). */
async function launchTournament(t: Tournament) {
  const seats = [...t.players, ...(t.broadcaster?.enabled ? [t.broadcaster] : [])].filter((p) => !("provider" in p && p.provider === "human"));
  if (!orchestratorAvailable() && seats.some((p) => !agentWebhook(p.model, p.effort))) throw new Error("No orchestrator webhook, and not every player has an agent webhook.");
  const res = tournamentNext(t);
  if ("finished" in res) return;
  for (const g of res.games) {
    launchTried.set(g.id, Date.now());
    await launchGame(g);
  }
}

const KICK_COOLDOWN_MS = 5 * 60_000;

function kickTournament(t: Tournament, onFail?: () => void) {
  if (!startablePairings(t).length) return;
  t.lastKickAt = Date.now();
  saveTournament(t);
  launchTournament(t).catch((e) => {
    console.error(`[launch] tournament ${t.id} (retrying in 60s): ${e.message}`);
    onFail?.();
  });
}

/**
 * An agent unheard from this long has stopped: a new one takes its seat. Its commands block 5 minutes at
 * most, and the longest a player has thought over one move is about 15 minutes.
 */
const QUIET_MS = { w: 25 * 60_000, b: 25 * 60_000, x: 25 * 60_000, d: 30 * 60_000 } as const;
/** An agent that hasn't turned up this long after its launch never will. */
const NO_SHOW_MS = 10 * 60_000;
const MAX_RELAUNCHES = 3;
/** A game that finished longer ago than this (or before the server was up) doesn't summon its director by itself. */
const DIRECTOR_AFTER_MS = 30 * 60_000;

/** Whether a seat still needs its agent. */
function needsAgent(g: Game, seat: SeatRole) {
  if (seat === "w" || seat === "b") return !seatIsHuman(g, seat) && g.phase !== "finished" && !playerFinished(g, seat);
  if (seat === "x") return g.phase !== "finished";
  return g.phase === "finished" && needsDirection(g) && !!g.directLaunch?.d;
}

const gaveUp = new Set<string>();

/** Every few seconds: revive quiet agents, summon directors, start the next tournament games. */
export function watch() {
  if (!summonAvailable()) return;
  const now = Date.now();
  for (const g of games.values()) {
    // A paused game's agents are waiting on purpose (a usage limit resumes by itself).
    if (g.directLaunch && !g.clockPause)
      for (const [seat, l] of Object.entries(g.directLaunch) as [SeatRole, { at: number; relaunches: number }][]) {
        if (!needsAgent(g, seat)) continue;
        const seen = g.seen[seat] ?? 0;
        if (seen >= l.at ? now - seen < QUIET_MS[seat] : now - l.at < NO_SHOW_MS) continue;
        if (l.relaunches >= MAX_RELAUNCHES) {
          if (!gaveUp.has(`${g.id}-${seat}`)) console.error(`[launch] ${g.id} ${seat}: quiet again after ${MAX_RELAUNCHES} relaunches, giving up`);
          gaveUp.add(`${g.id}-${seat}`);
          continue;
        }
        console.log(`[launch] ${g.id} ${seat}: ${seen >= l.at ? "gone quiet" : "never turned up"}, starting a new agent`);
        // Taken again synchronously, so the next tick doesn't start another.
        l.at = now;
        launchDirect(g, seat).catch(() => {});
      }
    // A broadcast game's video director comes once the game is over.
    if (g.phase === "finished" && g.broadcaster?.enabled && !g.directorSummonedAt && now - (g.finishedAt ?? 0) < DIRECTOR_AFTER_MS && needsDirection(g)) {
      g.directorSummonedAt = now;
      saveGameNow(g);
      launchDirector(g).catch((e) => console.error(`[launch] ${g.id} director: ${e.message}`));
    }
    // An auto-run tournament's game with a seat nobody has taken (its launch failed, or its agent never came) is launched again.
    if (g.tournamentId && g.phase !== "finished" && now - (launchTried.get(g.id) ?? 0) > RETRY_MS) {
      const t = tournaments.get(g.tournamentId);
      launchTried.set(g.id, now);
      if (t?.autoRun && t.status === "running" && launchSpec(g).tasks.some((task) => !seatClaimed(g, task.seat as SeatRole)))
        launchGame(g).catch((e) => console.error(`[launch] ${g.id}: ${e.message}`));
    }
    // Auto-run tournaments: once a game is fully over, start the next pairing.
    if (g.phase === "finished" && g.tournamentId && !g.nextTriggered) {
      const t = tournaments.get(g.tournamentId);
      if (t?.autoRun && t.status === "running") {
        g.nextTriggered = true;
        saveGameNow(g);
        kickTournament(t, () => setTimeout(() => (g.nextTriggered = false), 60_000));
      }
    }
  }
  // Retry after breaks, or when busy models become available.
  for (const t of tournaments.values()) {
    if (!t.autoRun || t.status !== "running") continue;
    if (now - (t.lastKickAt ?? 0) < KICK_COOLDOWN_MS || !startablePairings(t).length) continue;
    kickTournament(t, () => (t.lastKickAt = Date.now() - KICK_COOLDOWN_MS + 60_000));
  }
}

/** "Start tournament" on the website: start what can go now. */
export async function startTournament(t: Tournament) {
  t.lastKickAt = Date.now();
  saveTournament(t);
  await launchTournament(t);
}
