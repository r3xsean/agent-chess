import path from "node:path";
import type { Game, SeatRole, Tournament } from "../shared/types";
import { games, saveGameNow, saveSeatsNow, saveTournament, seatKeys, tournaments } from "./store";
import { claimSeats, directorKey, playerFinished, rotateSeatKey, seatClaimed, seatIsHuman, seatKeysFor, startablePairings, touch } from "./game";
import { directorLaunch, directorWho, launchSpec } from "./prompts";
import { needsDirection } from "./director";
import { directorTurnedUp } from "./directorThread";
import { tournamentNext } from "./orchestrator";
import { agentWebhook, orchestratorAvailable, summonAvailable, triggerAgent, triggerOrchestrator, WebhookRefused } from "./summon";
import { bootAt } from "./heartbeat";
import { agentAlive, agentOutcome, agentPrompt, anyAgentCli, canRunAgent, limitWhileRunning, resumePrompt, startAgent, stopAgent, type AgentOutcome, type AgentProc } from "./agents";
import { applyUsageLimit, lastActionAt, usageLimitPauses } from "./usageLimits";

/*
 * Launching agents. The server starts a player's agent itself, in the background through
 * its provider's CLI (see agents.ts), and carries its session on whenever it stops before its seat is done.
 * A seat it can't run that way, and the video director (the user talks with it in T3), is started in its own
 * T3 thread when an agent webhook covers its model and effort. Either way the agent gets only its seat key,
 * and `start` gives it its task, and the server starts a new agent for one that goes quiet. Any other seat
 * goes to an orchestrator run, which delegates it and looks after it. The server also starts the next games
 * of an auto-run tournament. A game's video director is never started on its own: the user asks for one.
 */

type Who = { provider: string; model: string; effort: string };

/** The provider, model and effort a seat's agent runs on. */
function whoFor(g: Game, seat: SeatRole): Who {
  if (seat === "w" || seat === "b") return seat === "w" ? g.white : g.black;
  return directorWho(g);
}

/** Whether the server runs this seat's agent itself, through its CLI. */
const runsItself = (seat: SeatRole, who: Who) => seat !== "d" && canRunAgent(who.provider);

/** Whether the server can start an agent on this provider, model and effort without an orchestrator run. */
const startableDirect = (p: Who) => canRunAgent(p.provider) || !!agentWebhook(p.model, p.effort);

/**
 * Start a seat's agent: in the background through its CLI, or in its own T3 thread. False when neither
 * covers it, or the start failed (then the seat is free again). The seat is taken before anything starts,
 * so two launches at once never start it twice. A seat started before gets a new key, so its earlier agent
 * can't act for it, and an earlier agent the server runs itself is stopped.
 */
async function launchDirect(g: Game, seat: SeatRole): Promise<boolean> {
  const who = whoFor(g, seat);
  const local = runsItself(seat, who);
  const url = local ? undefined : agentWebhook(who.model, who.effort);
  if (!local && !url) return false;
  const prev = g.directLaunch?.[seat];
  const before = seatKeysFor(g.id)[seat];
  const earlier = before ? seatKeys[before]?.agent : undefined;
  const key = prev ? rotateSeatKey(g.id, seat) : seat === "d" ? directorKey(g.id) : seatKeysFor(g.id)[seat];
  if (earlier && agentAlive(earlier)) stopAgent(earlier);
  claimSeats(g, [seat]);
  const relaunches = prev ? prev.relaunches + 1 : 0;
  g.directLaunch = { ...g.directLaunch, [seat]: { at: Date.now(), relaunches } };
  saveGameNow(g);
  try {
    if (local) {
      const agent = await startAgent({ ...who, prompt: agentPrompt(key), logName: `${g.id}-${seat}-${relaunches}` });
      // The seat went, or was done with, while its agent started (the game aborted): nothing to hand on.
      if (!seatKeys[key] || !needsAgent(g, seat)) {
        stopAgent(agent);
        return true;
      }
      seatKeys[key].agent = agent;
      saveSeatsNow();
      console.log(`[launch] ${g.id} ${seat}: ${who.model} started in the background (pid ${agent.pid})`);
      return true;
    }
    const delivery = await triggerAgent(url!, key);
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

/**
 * Start a finished game's video director (none if there's nothing to plan, or one is already at it): in its own
 * thread when a webhook covers its model, which asks for its task with its session key, else through an
 * orchestrator run. Undefined once started, else why not.
 */
export async function launchDirector(g: Game): Promise<string | undefined> {
  const spec = directorLaunch(g);
  if (!spec.tasks.length) return "note" in spec ? spec.note : undefined;
  g.directorSummonedAt = Date.now();
  saveGameNow(g);
  const { model, effort } = directorWho(g);
  const url = agentWebhook(model, effort);
  // A start that fails, or may have come to nothing, is started again by `watch` if it never turns up.
  if (url && "key" in spec && spec.key) {
    await triggerAgent(url, spec.key);
    return;
  }
  // No webhook for its model: an orchestrator run delegates it. Its brief hands the seat out itself.
  if (g.launched) delete g.launched.d;
  saveGameNow(g);
  await triggerOrchestrator({ action: "direct-video", gameId: g.id });
}

/** How long new titles and thumbnails asked for are waited on before they can be asked for again. */
const PACKAGING_STALE_MS = 30 * 60_000;

/**
 * Start a director for new titles, captions and thumbnails on a game whose plan is saved (the director's seat
 * does only that once there's a plan, see seatTask): in its own T3 thread when a webhook covers the director's
 * model and effort, else in the background through its CLI. Undefined once started, else why not.
 */
export async function launchPackaging(g: Game): Promise<string | undefined> {
  if (!g.video) return "The game has no video plan yet: its director makes the titles, captions and thumbnails with it.";
  const since = g.packagingSummonedAt ? Date.now() - g.packagingSummonedAt : Infinity;
  if (since < PACKAGING_STALE_MS) return `New titles and thumbnails were asked for ${Math.round(since / 60_000)} min ago and aren't in yet.`;
  const who = directorWho(g);
  const url = agentWebhook(who.model, who.effort);
  if (!url && !canRunAgent(who.provider)) return `Nothing can start ${who.model}@${who.effort}: there's no T3 webhook for it (data/webhook.json) and its CLI isn't available.`;
  const key = directorKey(g.id);
  g.packagingSummonedAt = Date.now();
  saveGameNow(g);
  try {
    if (url) await triggerAgent(url, key);
    else await startAgent({ ...who, prompt: agentPrompt(key), logName: `${g.id}-packaging-${g.video.packagingRedos ?? 0}` });
  } catch (e) {
    // A webhook request that timed out or dropped may have started it all the same: only a refusal frees it.
    if (!url || e instanceof WebhookRefused) {
      delete g.packagingSummonedAt;
      saveGameNow(g);
    }
    throw e;
  }
}

/** How long after it was started a director that never turned up is started again, at most. */
const DIRECTOR_RETRY_MS = 6 * 3_600_000;

/** When each tournament game was last launched, so a launch that failed (T3 unreachable) is tried again later. */
const launchTried = new Map<string, number>();
const RETRY_MS = 5 * 60_000;

/** Start whatever an auto-run tournament can start now (never making games nothing could launch). */
async function launchTournament(t: Tournament) {
  const seats = t.players.filter((p) => p.provider !== "human");
  if (!orchestratorAvailable() && seats.some((p) => !startableDirect(p))) throw new Error("No orchestrator webhook, and not every player can be started without one.");
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
const QUIET_MS = { w: 25 * 60_000, b: 25 * 60_000, d: 30 * 60_000 } as const;
/** An agent that hasn't turned up this long after its launch never will. */
const NO_SHOW_MS = 10 * 60_000;
const MAX_RELAUNCHES = 3;

/** Whether a seat still needs its agent. */
function needsAgent(g: Game, seat: SeatRole) {
  if (seat === "w" || seat === "b") return !seatIsHuman(g, seat) && g.phase !== "finished" && !playerFinished(g, seat);
  return g.phase === "finished" && needsDirection(g) && !!g.directLaunch?.d;
}

const gaveUp = new Set<string>();

/** A stopped agent's session isn't carried on sooner than this after its run started, so a CLI that dies at once isn't restarted in a tight loop. */
const RESUME_GAP_MS = 30_000;
/** Runs in a row that may carry a session on without the agent acting, before a new agent takes the seat. */
const MAX_RESUMES = 3;
/** A usage limit that didn't say when it resets is tried again after this long. */
const LIMIT_RETRY_MS = 30 * 60_000;
/** Each stopped run's log is read once. */
const outcomes = new Map<string, AgentOutcome>();
/** Stopped runs whose session is being carried on now (a start takes a moment), so it's carried on once. */
const resuming = new Set<string>();

/** A hand-over to T3 is tried this often until it goes through. */
const HANDOVER_RETRY_MS = 60_000;
const handOverTried = new Map<string, number>();

/**
 * An agent the server ran itself stopped, and its CLI is turned off since: its seat goes to T3, in its own
 * thread (same key: the agent it replaces has stopped) or else through an orchestrator run. The seat stays
 * the server's, and is tried again, until T3 has taken it.
 */
function handOver(g: Game, seat: SeatRole, l: { at: number; relaunches: number }, key: string, agent: AgentProc, now: number) {
  const id = `${g.id}-${seat}`;
  if (now - (handOverTried.get(id) ?? 0) < HANDOVER_RETRY_MS) return;
  handOverTried.set(id, now);
  const who = whoFor(g, seat);
  const url = agentWebhook(who.model, who.effort);
  if (!url && !orchestratorAvailable()) {
    console.error(`[launch] ${id}: its agent stopped, its CLI is turned off, and there's no T3 webhook to hand the seat to`);
    return;
  }
  console.log(`[launch] ${id}: its agent stopped and its CLI is turned off, handing the seat to T3`);
  const done = () => {
    if (seatKeys[key]?.agent === agent) delete seatKeys[key].agent;
    saveSeatsNow();
  };
  if (url) {
    triggerAgent(url, key)
      .then((delivery) => {
        done();
        if (delivery && seatKeys[key]) seatKeys[key].delivery = delivery;
        saveSeatsNow();
        // Its claim and its no-show time start now, so nothing else takes the seat before it turns up.
        claimSeats(g, [seat]);
        l.at = Date.now();
        saveGameNow(g);
      })
      .catch((e) => console.error(`[launch] ${id}: ${e.message} (trying again in a minute)`));
    return;
  }
  // The orchestrator's brief hands out only free seats: freed first, and taken back if T3 can't be reached.
  done();
  const launched = g.launched?.[seat];
  if (g.launched) delete g.launched[seat];
  delete g.directLaunch![seat];
  saveGameNow(g);
  triggerOrchestrator({ action: "start-game", gameId: g.id }).catch((e) => {
    console.error(`[launch] ${id}: ${e.message} (trying again in a minute)`);
    if (seatKeys[key]) seatKeys[key].agent = agent;
    saveSeatsNow();
    if (launched) g.launched = { ...g.launched, [seat]: launched };
    g.directLaunch = { ...g.directLaunch, [seat]: l };
    saveGameNow(g);
  });
}

/** Whether a player's agent did something real since a time (not a status check, a wait or `help`). */
function actedSince(g: Game, seat: SeatRole, since: number) {
  return (seat === "w" || seat === "b") && lastActionAt(g, seat) > since;
}

/**
 * An agent the server runs itself stopped before its seat was done. A usage limit pauses a player's clock
 * (if it still has something to do that would lift the pause) and waits until it resets. Then the session
 * carries on with the same key, or, with no session to carry on or after a few runs that never acted, a new
 * agent takes the seat. With its CLI turned off since, the seat goes to T3.
 */
function agentStopped(g: Game, seat: SeatRole, l: { at: number; relaunches: number }, key: string, agent: AgentProc, now: number) {
  const id = `${agent.pid}@${agent.startedAt}`;
  if (now - agent.startedAt < RESUME_GAP_MS || resuming.has(id)) return;
  if (!canRunAgent(agent.provider)) {
    handOver(g, seat, l, key, agent, now);
    return;
  }
  const out = outcomes.get(id) ?? agentOutcome(agent);
  outcomes.set(id, out);
  if (out.usageLimit) {
    if ((seat === "w" || seat === "b") && usageLimitPauses(g, seat) && applyUsageLimit(g, seat, out.usageLimit)) {
      console.log(`[launch] ${g.id} ${seat}: usage limit${out.usageLimit.resetAt ? ` until ${new Date(out.usageLimit.resetAt).toISOString()}` : ""}`);
      saveGameNow(g);
      touch(g);
    }
    if (now < (out.usageLimit.resetAt ? out.usageLimit.resetAt + 60_000 : out.usageLimit.at + LIMIT_RETRY_MS)) return;
  }
  // A run that acted (or that only stopped for its limit) starts the count again.
  const resumes = actedSince(g, seat, agent.startedAt) || out.usageLimit ? 0 : agent.resumes;
  if (out.session && resumes < MAX_RESUMES) {
    console.log(`[launch] ${g.id} ${seat}: its agent stopped${out.usageLimit ? " (usage limit)" : ""}, carrying its session on`);
    outcomes.delete(id);
    resuming.add(id);
    const who = whoFor(g, seat);
    startAgent({ ...who, provider: agent.provider, prompt: resumePrompt(key), logName: path.basename(agent.log, ".jsonl"), session: out.session, resumes: resumes + 1 })
      .then((next) => {
        // Only if the seat is still this run's and still needs it (nothing replaced it, the game didn't end).
        if (seatKeys[key]?.agent !== agent || !needsAgent(g, seat)) return stopAgent(next);
        seatKeys[key].agent = next;
        saveSeatsNow();
        // It has its no-show time again to turn up, however long ago it was last heard from.
        l.at = Date.now();
        saveGameNow(g);
      })
      .catch((e) => console.error(`[launch] ${g.id} ${seat}: ${(e as Error).message}`))
      .finally(() => resuming.delete(id));
    return;
  }
  if (l.relaunches >= MAX_RELAUNCHES) {
    if (!gaveUp.has(`${g.id}-${seat}`)) console.error(`[launch] ${g.id} ${seat}: stopped again after ${MAX_RELAUNCHES} relaunches, giving up`);
    gaveUp.add(`${g.id}-${seat}`);
    return;
  }
  console.log(`[launch] ${g.id} ${seat}: its agent stopped ${out.session ? "again without acting" : "with no session to carry on"}, starting a new agent`);
  outcomes.delete(id);
  l.at = now;
  launchDirect(g, seat).catch(() => {});
}

/** An agent the server runs itself whose seat is done may take this long to finish up and stop by itself. */
const LINGER_MS = 10 * 60_000;
const doneSince = new Map<string, number>();

/** A seat that's done with its agent (its part over, or the game ended): a run that's over is forgotten, one still going after a while is stopped. */
function seatDone(g: Game, seat: SeatRole, key: string, agent: AgentProc, now: number) {
  const id = `${g.id}-${seat}`;
  if (agentAlive(agent)) {
    const since = doneSince.get(id) ?? now;
    doneSince.set(id, since);
    if (now - since < LINGER_MS) return;
    console.log(`[launch] ${id}: its seat is done and its agent is still running, stopping it`);
    stopAgent(agent);
  }
  doneSince.delete(id);
  delete seatKeys[key].agent;
  saveSeatsNow();
}

/** Every few seconds: carry stopped agents on, revive quiet ones, start the next tournament games. */
export function watch() {
  // Agents already running are looked after whatever can be started now; starting anything needs a webhook or a CLI.
  const launching = summonAvailable() || anyAgentCli();
  const now = Date.now();
  for (const g of games.values()) {
    if (g.directLaunch)
      for (const [seat, l] of Object.entries(g.directLaunch) as [SeatRole, { at: number; relaunches: number }][]) {
        const key = seatKeysFor(g.id)[seat];
        const agent = key ? seatKeys[key]?.agent : undefined;
        if (!needsAgent(g, seat)) {
          if (agent) seatDone(g, seat, key, agent, now);
          continue;
        }
        if (agent && !agentAlive(agent)) {
          agentStopped(g, seat, l, key, agent, now);
          continue;
        }
        // A CLI that reported a usage limit but stays up is stopped, so the limit is waited out like any other.
        if (agent && limitWhileRunning(agent)) {
          console.log(`[launch] ${g.id} ${seat}: its agent hit a usage limit and its CLI is still running, stopping it`);
          stopAgent(agent);
          continue;
        }
        if (!launching) continue;
        // A paused game's agents are waiting on purpose (a usage limit resumes by itself). One the server runs
        // itself that's still running isn't waiting out a limit (its CLI stops at one): only a deliberate pause holds it.
        if (g.clockPause && !(agent && g.clockPause.code === "usage_limit")) continue;
        const seen = g.seen[seat] ?? 0;
        // After a restart every agent gets its full time again, counted from the boot: the time the server was
        // down isn't the agent's silence (its CLI was retrying), and its last calls before it may not have been saved.
        if (seen >= l.at ? now - Math.max(seen, bootAt) < QUIET_MS[seat] : now - Math.max(l.at, bootAt) < NO_SHOW_MS) continue;
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
    if (!launching) continue;
    // A director started that never turned up (the server went down mid-start, or T3 lost it) is started again.
    const summoned = g.directorSummonedAt ?? 0;
    if (
      g.phase === "finished" &&
      summoned &&
      now - summoned > NO_SHOW_MS &&
      now - summoned < DIRECTOR_RETRY_MS &&
      (g.directorResummons ?? 0) < MAX_RELAUNCHES &&
      needsDirection(g) &&
      !directorTurnedUp(g)
    ) {
      console.log(`[launch] ${g.id} director: never turned up, starting it again`);
      g.directorResummons = (g.directorResummons ?? 0) + 1;
      // Its seat was taken by the start that came to nothing.
      if (g.launched) delete g.launched.d;
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
  if (!launching) return;
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
