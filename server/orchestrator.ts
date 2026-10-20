import path from "node:path";
import type { Game, SeatRole, Tournament } from "../shared/types";
import { DATA, PORT } from "./paths";
import { games, saveTournament, saveTournamentNow, tournaments } from "./store";
import { ActionError, boardsOf, claimSeats, createGame, seatClaimed, startablePairings, tournamentBreakUntil } from "./game";
import { directorLaunch, launchSpec } from "./prompts";
import { publishLaunch } from "./publish";
import { summonAvailable } from "./summon";
import { directorThreadLaunch } from "./directorThread";
import { fullName, humanSide } from "../shared/naming";

/*
 * The orchestrator's brief: what one run has to do, and nothing else. The T3 webhook's prompt only says
 * to fetch it, so each run reads the steps for its own action (a publish run never reads tournament rules),
 * with the tasks it's to delegate already in it, and the steps live here, next to the agents' own prompts.
 */

export const ORCHESTRATOR_ACTIONS = ["start-game", "tournament-next", "direct-video", "director-thread", "publish"] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTIONS)[number];
/** Who asked: a webhook run settles its own thread at the end; a chat run leaves the user's thread alone. */
export type BriefSource = "webhook" | "chat";

/**
 * Start what a tournament can start now. One board: the next pairing, or the game still running. Several:
 * every pairing a free board and free models allow; games already running are listed by id, for other runs.
 */
export function tournamentNext(t: Tournament): { finished: true } | { games: Game[]; running: string[]; alreadyRunning?: boolean } {
  const live = t.pairings.filter((p) => p.gameId && games.get(p.gameId)?.phase !== "finished");
  if (!live.length && !t.pairings.some((p) => !p.gameId)) {
    t.status = "finished";
    saveTournament(t);
    return { finished: true };
  }
  const byId = new Map(t.players.map((p) => [p.id, p]));
  const start = (next: Tournament["pairings"][number]) => {
    const g = createGame({ white: byId.get(next.white)!, black: byId.get(next.black)!, broadcaster: t.broadcaster, tournamentId: t.id, rated: t.rated !== false, chess960: next.chess960 });
    next.gameId = g.id;
    return g;
  };
  if (boardsOf(t) <= 1) {
    if (live.length) return { games: [games.get(live[0].gameId!)!], running: [], alreadyRunning: true };
    const next = startablePairings(t)[0];
    if (!next) return { games: [], running: [] };
    const g = start(next);
    saveTournamentNow(t);
    return { games: [g], running: [] };
  }
  const started = startablePairings(t).map(start);
  saveTournamentNow(t);
  return { games: started, running: live.map((p) => p.gameId!) };
}

const API = `http://127.0.0.1:${PORT}`;
const TOKEN_FILE = path.join(DATA, "admin-token.txt");

type Task = { title: string; clientRequestId: string; target: unknown; prompt: string; seat?: string };

/** A name for the brief's own text, as plain words: nothing in it can start a heading, a block or a tag. */
const plain = (s: string) => s.replace(/[^\p{L}\p{N} .'()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
const matchup = (g: Game) => `White ${plain(fullName(g.white))} vs Black ${plain(fullName(g.black))}`;
const watch = (g: Game) => `${API}/#/game/${g.id}`;

function header(what: string) {
  return `You are the Agent Chess orchestrator. ${what}

The Agent Chess server is ${API}. Requests marked (admin) need the header \`x-admin-token\` set to the contents of ${TOKEN_FILE}; never put the token in an agent's prompt. You launch agents and look after them: never play a move, commentate, plan a video or post anything yourself, and never give an agent engine output.`;
}

const DELEGATE = `Delegate with \`delegate_task\`: \`task\` = the task's prompt, and its \`title\`, \`clientRequestId\` and \`target\` exactly as given, with \`mode: "async"\` and \`role: "general"\` (leave \`runtimeMode\` unset: agents need a shell). Keep each returned taskId and childThreadId.`;

function taskBlock(t: Task, record?: string) {
  return [
    `### ${t.title}`,
    `- title: ${JSON.stringify(t.title)}`,
    `- clientRequestId: ${JSON.stringify(t.clientRequestId)}`,
    `- target: ${JSON.stringify(t.target)}`,
    ...(record ? [`- once delegated, record it: ${record}`] : []),
    `- prompt: everything between <prompt> and </prompt>, exactly as written:`,
    `<prompt>`,
    t.prompt,
    `</prompt>`,
  ].join("\n");
}

const SETTLE_OWN = 'settle your own thread as the very last thing: `t3_thread_organize` with action "settle" and no threadId.';

function finish(source: BriefSource, when: string) {
  const own = source === "chat" ? "Leave your own thread as it is: the user is reading it." : `Then ${SETTLE_OWN}`;
  return `## When you're done
Once ${when}: settle each finished child task's thread (\`t3_thread_organize\` with action "settle" and its childThreadId). ${own} Don't settle while anything still needs you.`;
}

function nothing(why: string, source: BriefSource) {
  return `You are the Agent Chess orchestrator. ${why} There's nothing for you to do.${source === "webhook" ? ` Just ${SETTLE_OWN}` : " Tell the user."}`;
}

/** Launching the agents of one or more games, looking after them, and each broadcast game's director after it. */
function gamesBrief(intro: string, gs: Game[], source: BriefSource, extra: string[] = []) {
  // The seats in this brief are handed to this run as it's written, so a run asking at the same time gets none of them.
  const todo = gs
    .map((g) => ({ g, tasks: (launchSpec(g).tasks as Task[]).filter((t) => !seatClaimed(g, t.seat as SeatRole)) }))
    .filter((x) => x.tasks.length);
  for (const { g, tasks } of todo) claimSeats(g, tasks.map((t) => t.seat as SeatRole));
  if (!todo.length) return null;
  const many = todo.length > 1;
  const humans = todo.filter(({ g }) => humanSide(g));
  // With a webhook, the server summons each broadcast game's director itself once the game is over.
  const broadcast = summonAvailable() ? [] : todo.filter(({ g }) => g.broadcaster?.enabled);
  const out = [
    header(intro),
    "",
    "## 1. Launch",
    `${DELEGATE} Launch every task below in one message, and record each one right after it's delegated. These seats are yours: this brief has kept them for you for 10 minutes, and recording them keeps them yours. If a delegation fails, retry it with the same clientRequestId.`,
    humans.length ? `A human plays ${humans.map(({ g }) => `${humanSide(g) === "w" ? "White" : "Black"} in ${g.id}`).join(", ")} on the website: that seat has no task.` : "",
    `Then tell the user where to watch: ${todo.map(({ g }) => watch(g)).join(", ")}.`,
    "",
    ...todo.flatMap(({ g, tasks }) => [
      ...(many ? [`## Game ${g.id}: ${matchup(g)}`, ""] : []),
      ...tasks.map((t) => taskBlock(t, `POST ${API}/api/games/${g.id}/launched with JSON {"seat":"${t.seat}"} (admin)`) + "\n"),
    ]),
    "## 2. Look after them",
    `You're woken when a child task finishes; don't poll or sleep in loops. Look after only the seats you launched. Each time one finishes, GET ${API}/api/games/<id>/agents:`,
    "- Its seat shows `done: true`: nothing to do.",
    "- `clockPause.code` is `usage_limit`, or the task failed with a usage limit: leave it to T3's auto-resume. Do not abort, cancel, re-delegate, or send repeated continuations. The server freezes the clocks and clears the usage pause when players act again. Other pause reasons also mean wait, not abort.",
    '- Not done: the agent stopped early. Continue it with `t3_thread_send` to its childThreadId: "The game is not over. Keep looping: run the CLI command your last reply asked for, and act on what it prints, until it prints DONE." If it can\'t be revived, `task_cancel` it and delegate its task again with clientRequestId `<its clientRequestId>-r<n>` (the same prompt: its key still works).',
    "- If the side to move's `secondsSinceSeen` passes 600 while its task still runs, check it with `task_status` before doing anything.",
    `- A game that can't go on: POST ${API}/api/games/<id>/abort (admin).`,
    "",
  ];
  if (broadcast.length)
    out.push(
      "## 3. After the game: the video director",
      `${broadcast.length < todo.length ? `For ${broadcast.map(({ g }) => g.id).join(", ")} (the broadcast game${broadcast.length > 1 ? "s" : ""}): o` : "O"}nce the broadcaster's seat is done (the game is finished), GET ${API}/api/games/<id>/director-launch (admin). If \`tasks\` has one, delegate it the same way and record it with {"seat":"d"}. If it's empty, its \`note\` says why, and there's nothing to do.`,
      'When the director finishes, `/agents` should show `director.done: true`. If not, continue it once with `t3_thread_send` ("Your task isn\'t done: run `brief` and carry on until `confirm` prints DONE."); if it can\'t be continued, delegate its task again with its clientRequestId plus `-r2` (a model\'s safety filter occasionally refuses a long brief; a second try usually works).',
      "",
    );
  out.push(...extra.flatMap((e) => [e, ""]));
  out.push(finish(source, `every game above is finished, each seat you launched is done${broadcast.length ? " and each director's plan is saved (or there was none to make)" : ""}`));
  const text = out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  // One game: its id goes straight into the steps. The prompts never say <id>, so they come through as they are.
  return many ? text : text.replaceAll("/api/games/<id>/", `/api/games/${todo[0].g.id}/`);
}

function startGame(g: Game, source: BriefSource) {
  if (g.phase === "finished") return nothing(`Game ${g.id} is already over.`, source);
  return (
    gamesBrief(`Start game ${g.id}: ${matchup(g)}${g.broadcaster?.enabled ? ", with a broadcaster" : ""}.`, [g], source) ??
    nothing(`Every seat of game ${g.id} was already launched by another orchestrator run, which looks after it.`, source)
  );
}

function nextInTournament(t: Tournament, source: BriefSource) {
  const res = tournamentNext(t);
  // Only the tournament's id goes in: its name is whatever was typed in, and this text is instructions.
  if ("finished" in res)
    return `${header(`Tournament ${t.id} is over.`)}

Tell the user, with the final standings from GET ${API}/api/tournaments/${t.id}.${source === "webhook" ? ` Then ${SETTLE_OWN}` : ""}`;
  const extra: string[] = [];
  if (res.running.length) extra.push(`## Other games\nGames ${res.running.join(", ")} of this tournament belong to other orchestrator runs: leave them alone.`);
  extra.push(
    t.autoRun
      ? "## The rest of the tournament\nThe website starts the next games by itself as boards free up, each with its own orchestrator run: once the games above are done, so are you."
      : `## The rest of the tournament\nThis tournament isn't auto-run: once your games are finished, POST ${API}/api/orchestrator/brief with JSON {"action":"tournament-next","tournamentId":"${t.id}","source":"${source}"} (admin) and follow the brief it returns, until it says the tournament is over.`,
  );
  const intro = res.alreadyRunning
    ? `Tournament ${t.id}: its current game isn't fully launched yet.`
    : `Tournament ${t.id}: start ${res.games.length > 1 ? `its next ${res.games.length} games, one per board` : "its next game"}.`;
  const until = tournamentBreakUntil(t);
  const busy = until > Date.now()
    ? `Tournament ${t.id} is on a break until ${new Date(until).toISOString()}.`
    : `Tournament ${t.id} can't start a game right now: it is waiting for active boards or busy models to finish.`;
  return (
    gamesBrief(intro, res.games, source, extra) ??
    (res.games.length
      ? nothing(`Every seat of tournament ${t.id}'s current game${res.games.length > 1 ? "s" : ""} was already launched by another orchestrator run.`, source)
      : t.autoRun
        ? nothing(`${busy} The website asks again when the next games can start.`, source)
        : `${header(`${busy} It isn't auto-run, so nothing will ask again by itself.`)}

Tell the user, and that the next games start when they ask you again (or press Start tournament on its page, which runs the rest by itself).${source === "webhook" ? ` Then ${SETTLE_OWN}` : ""}`)
  );
}

function directVideo(g: Game, source: BriefSource) {
  const spec = directorLaunch(g);
  const task = spec.tasks[0] as Task | undefined;
  if (!task) return nothing(`Game ${g.id} needs no video director now: ${"note" in spec ? spec.note : ""}`, source);
  return [
    header(`The website wants a replay video of finished game ${g.id} (${matchup(g)}), and it has no video plan yet: launch its video director.`),
    "",
    "## 1. Launch",
    DELEGATE,
    "",
    taskBlock(task, `POST ${API}/api/games/${g.id}/launched with JSON {"seat":"d"} (admin)`),
    "",
    "## 2. When it finishes",
    `GET ${API}/api/games/${g.id}/agents: \`director.done: true\` means the plan and its narration are saved (the director launches its own narrator and works it through with it), and the user reviews and approves it before rendering. If not, continue it once with \`t3_thread_send\` ("Your task isn't done: run \`chat-brief\` and carry on: the plan, then your narrator, then \`done\`."); if it can't be continued, delegate its task again with clientRequestId \`${task.clientRequestId}-r2\` (a model's safety filter occasionally refuses a long brief; a second try usually works).`,
    "",
    finish(source, "the director is done"),
  ].join("\n");
}

function publish(g: Game, source: BriefSource) {
  let task: Task;
  try {
    task = publishLaunch(g, true).tasks[0];
  } catch (e) {
    return nothing(`${(e as Error).message.replace(/\.$/, "")} (game ${g.id}): another run handles it.`, source);
  }
  const platforms = g.publish!.platforms;
  const names = platforms.map((p) => (p === "youtube" ? "YouTube" : "TikTok")).join(" and ");
  return [
    header(`The user pressed Publish on game ${g.id}'s video page: launch the publisher, which posts its videos to ${names} in the user's own browser. The click is the user's go-ahead, so don't ask again.`),
    "",
    "## 1. Launch",
    DELEGATE,
    "",
    taskBlock(task),
    "",
    "## 2. Record what it posted",
    `When the publisher finishes, find the line starting \`PUBLISH_RESULT \` at the end of its result and record the JSON after it: POST ${API}/api/games/${g.id}/published with JSON {"results": <that JSON>} (admin).`,
    "If the line is missing, continue the publisher (`t3_thread_send` to its childThreadId) asking for its PUBLISH_RESULT line.",
    `**Never** delegate a second publisher for this request: it may already have posted, and a second upload would be a duplicate post. If it can't answer, record {"results": {${platforms.map((p) => `"${p}": {"error": "…"}`).join(", ")}}}, saying what you know.`,
    "",
    "## 3. Tell the user what was posted, with the links.",
    "",
    finish(source, "the posts are recorded"),
  ].join("\n");
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/i;

export function orchestratorBrief(action: string, ids: { gameId?: string; tournamentId?: string }, source: BriefSource = "webhook"): string {
  if (!ORCHESTRATOR_ACTIONS.includes(action as OrchestratorAction)) throw new ActionError(`Unknown action "${action}": use one of ${ORCHESTRATOR_ACTIONS.join(", ")}.`);
  if (action === "tournament-next") {
    const t = ID.test(ids.tournamentId ?? "") ? tournaments.get(ids.tournamentId!) : undefined;
    if (!t) throw new ActionError(`No such tournament: ${ids.tournamentId ?? "(none given)"}`);
    return nextInTournament(t, source);
  }
  const g = ID.test(ids.gameId ?? "") ? games.get(ids.gameId!) : undefined;
  if (!g) throw new ActionError(`No such game: ${ids.gameId ?? "(none given)"}`);
  if (action === "start-game") return startGame(g, source);
  if (action === "direct-video") return directVideo(g, source);
  if (action === "director-thread") {
    const task = directorThreadLaunch(g);
    if (!task) return nothing("This director thread is already being opened or is ready.", source);
    return [header("The user asked to open a persistent director conversation in T3 Code."),
      `Create an ordinary top-level thread using t3_thread_launch, workspaceStrategy {"type":"root"}, the title/model below and prompt as its message. This is the user's conversation, not a delegated worker. Do not settle that new thread.`,
      JSON.stringify(task, null, 2),
      "After launch, run bindCommand with the returned threadId. This connects the video tab's button to that exact conversation. Never render or approve the plan.",
      source === "webhook" ? `Then ${SETTLE_OWN}` : "Tell the user their director thread is ready."].join("\n\n");
  }
  return publish(g, source);
}
