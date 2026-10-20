import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DirectorThreadState, VideoContext } from "../shared/directorThread";
import type { Game, VideoPlan } from "../shared/types";
import { DEFAULT_DIRECTOR } from "../shared/models";
import { CLI, DATA, ROOT } from "./paths";
import { describePlayer } from "./briefing";
import { agentDir, games, saveGameNow } from "./store";
import { ActionError, touch } from "./game";
import { agentWebhook, orchestratorAvailable, triggerAgent, triggerOrchestrator } from "./summon";
import { probeCommand } from "./probe";
import { applyNarration, directorBrief, investigationNotes, narratorInvestigationNotes, narrateBrief, narratedReadback, packagingBrief, packagingChoices, planReadback, validatePlan } from "./director";
import { deepenLines, linesPrepared, linesReady } from "./lineDepth";
import { videoRevision } from "./videoApproval";
import { reviseVideoPlan } from "./reviseVideoPlan";
import { desktopThreadUrl, findDirectorThread } from "./directorThreadLink";

interface Session {
  gameId: string;
  key: string;
  createdAt: number;
  seenAt: number;
  revision: string;
  status: "opening" | "ready" | "working" | "narrating" | "failed";
  delivery?: string;
  threadId?: string;
  error?: string;
  handedOut?: boolean;
  draft?: VideoPlan;
  context?: VideoContext;
  narrator?: { key: string; revision: string; request: string; active: boolean };
  /**
   * "chat": the user's conversation from the video tab; "auto": a director started by itself (after a game, or a
   * redo), with no one to talk to. Both work the same way, the narrator loop included (sessions from before have none: chat).
   */
  mode?: "auto" | "chat";
  /** The director and its narrator's exchange, round by round, as each recorded it with `log`. */
  log?: { at: number; from: "director" | "narrator"; text: string }[];
}
const DIR = path.join(DATA, "director-threads");
const sessions = new Map<string, Session>();
if (existsSync(DIR)) for (const f of readdirSync(DIR).filter(f => f.endsWith(".json"))) {
  try {
    const s = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Session;
    sessions.set(s.gameId, s);
  } catch { console.warn(`[director-thread] Could not read ${f}; other sessions remain available.`); }
}
function save(s: Session) {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${s.gameId}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(s)); renameSync(`${file}.tmp`, file);
}
const token = () => `dt-${randomBytes(24).toString("hex")}`;
export const directorThreadAvailable = () => !!agentWebhook(DEFAULT_DIRECTOR.model, DEFAULT_DIRECTOR.effort) || orchestratorAvailable();
export function directorThreadState(g: Game): DirectorThreadState {
  const s = sessions.get(g.id);
  if (s && !s.threadId) {
    try { s.threadId = findDirectorThread(s.key, s.createdAt, s.delivery); }
    catch { /* The binding command can still supply the link if T3's schema changes. */ }
    if (s.threadId) {
      if (s.status === "opening" || s.status === "failed") { s.status = g.video ? "ready" : "working"; s.error = undefined; }
      save(s);
    }
    else if (s.status === "opening" && Date.now() - s.createdAt > 120_000) {
      s.status = "failed"; s.error = "The T3 thread hasn't appeared. Check T3 Code, then retry opening it."; save(s);
    }
  }
  if (s && ["working", "narrating"].includes(s.status) && Date.now() - s.seenAt > 30 * 60_000) {
    s.status = "failed";
    s.error = "The director has been quiet for a while. Continue in its T3 thread and run chat-brief, or finish/discard the pending work there.";
    save(s);
  }
  return { available: directorThreadAvailable(), status: s?.status ?? "none", error: s?.error, revision: videoRevision(g), ...(s?.threadId && { threadUrl: desktopThreadUrl(s.threadId) }) };
}
export const directorThreadBusy = (g: Game) => ["working", "narrating"].includes(directorThreadState(g).status);

async function launch(s: Session) {
  const url = agentWebhook(DEFAULT_DIRECTOR.model, DEFAULT_DIRECTOR.effort);
  if (url) s.delivery = await triggerAgent(url, s.key);
  else await triggerOrchestrator({ action: "director-thread", gameId: s.gameId });
}
/**
 * A director started by itself (after a game, or a redo): a session like the user's conversation, but with no one
 * to talk to. It makes the plan, launches its narrator and works with it, then reports. Null while another session
 * of the game is at work.
 */
export function autoDirectorSession(g: Game): Session | null {
  const have = sessions.get(g.id);
  // An auto director's session that was never used (its launch failed) or went quiet long ago is replaced.
  const unused = have?.mode === "auto" && (have.seenAt - have.createdAt < 1000 || Date.now() - have.seenAt > 45 * 60_000);
  if (have && directorThreadBusy(g) && !unused) return null;
  const s: Session = { gameId: g.id, key: token(), createdAt: Date.now(), seenAt: Date.now(), revision: videoRevision(g), status: "working", mode: "auto" };
  sessions.set(g.id, s);
  save(s);
  return s;
}

/** The prompt a director session's agent starts from (the auto director's task, or the conversation's). */
export const sessionPrompt = (g: Game, s: { key: string }) => {
  const have = sessionFor(s.key).s;
  return directorSessionPrompt(g, have);
};

/** Whether a game's director session (the auto director's or the user's conversation) has had its agent turn up. */
export function directorTurnedUp(g: Game): boolean {
  const s = sessions.get(g.id);
  return !!s && s.seenAt - s.createdAt >= 1000;
}

/** Whether a game's auto director is done: its plan saved, and its narration seen through (or there was none to do). */
export function autoDirectorDone(g: Game): boolean {
  const s = sessions.get(g.id);
  return !!g.video && !(s?.mode === "auto" && ["working", "narrating"].includes(s.status));
}

/** One persistent T3 conversation per game. Reopening never sends a new user message. */
export async function openDirectorThread(g: Game, body: any, start = launch): Promise<DirectorThreadState> {
  if (g.phase !== "finished" || !g.review || !g.moves.length) throw new ActionError("The game needs to be finished and reviewed first.");
  let s = sessions.get(g.id);
  directorThreadState(g);
  // Once the auto director is done, its own thread becomes the conversation (keeping all its reasoning); a fresh
  // one opens only when it never got a thread.
  if (s?.mode === "auto") {
    if (directorThreadBusy(g)) throw new ActionError("The video director is still at work on this game. Open the conversation once it's done.");
    if (s.threadId) { s.mode = "chat"; save(s); }
    else { sessions.delete(g.id); s = undefined; }
  }
  const raw = body?.context;
  const context = raw && Number.isFinite(raw.time) && raw.time >= 0 && ["landscape", "portrait"].includes(raw.format)
    ? { time: Math.min(raw.time, 86400), format: raw.format, ...(g.moves.some(m => m.ply === raw.ply) && { ply: raw.ply }) } : undefined;
  if (s && (s.status !== "failed" || body?.retry !== true || s.threadId)) {
    if (context) { s.context = context; save(s); }
    return directorThreadState(g);
  }
  s = { gameId: g.id, key: token(), createdAt: Date.now(), seenAt: Date.now(), revision: videoRevision(g), status: "opening", context, mode: "chat" };
  sessions.set(g.id, s); save(s);
  try { await start(s); }
  catch (e) { s.status = "failed"; s.error = `Couldn't open the director: ${(e as Error).message}`; }
  save(s); return directorThreadState(g);
}

const target = () => ({ providerInstanceId: DEFAULT_DIRECTOR.provider, model: DEFAULT_DIRECTOR.model, options: { effort: DEFAULT_DIRECTOR.effort } });
export function directorThreadLaunch(g: Game) {
  const s = sessions.get(g.id);
  if (!s || s.handedOut || s.threadId || s.status === "failed") return null;
  s.handedOut = true; save(s);
  return { title: `🎬 Talk with the director — ${g.id}`, target: target(), workspace: ROOT, prompt: directorSessionPrompt(g, s),
    bindCommand: `node "${CLI}" bind-thread --key ${s.key} --text <returned-threadId>` };
}

/** The narrator loop, the same for the auto director and the user's conversation (see the narrator's prompt). */
const NARRATOR_LOOP = (g: Game, cli: string, key: string) => `THE NARRATOR: the narration over the plan's engine lines (and their branches) is written by a narrator of your own, never by you.
- Once a saved plan has engine lines, write a handoff for it: for each line, what it's for in the story, what you found when you probed it (the why: what a sacrifice is for, what's threatened, where the losing side can't get out), and what the viewer must come away with. Run \`request-narration <handoff.txt>\`. It returns the narrator's task: launch it with delegate_task as a child of THIS thread (mode async; its task, target and clientRequestId as given), and keep its taskId and childThreadId. If the CLI answer was lost, \`narration-task\` returns the same task again.
- Work with it. Each of its turns ends with what it did, then REQUESTS (a line it thinks the video needs or doesn't, a line's kind, a quote that repeats it…) and OBJECTIONS. When its turn ends you're told. Weigh each request on the chess and on the story, checking with the engine where it helps: agree → make the change (\`revise <file.json>\`, then \`confirm\`) and say so; disagree → say why. Reply with t3_thread_send to its childThreadId. Record each round with \`log <file|--text "…">\`: what it asked and what you decided, and why. Argue it out, but after about four rounds your call stands.
- When you're both satisfied, tell it the narration is final: it runs \`done\` and ends. Then you run \`done\`. If it fails or goes silent, cancel its task, run \`narration-cancel\`, and say so.`;

function directorSessionPrompt(g: Game, s: Session) {
  const cli = `node "${CLI}"`;
  const common = `Run commands as: ${cli} <command> [file] --key ${s.key}. Keep your files in ${agentDir(g.id, "d")}.
TOOLS: \`brief\` (the whole game: engine verdicts, the players' commentary and interviews, the line options and the questions each raises, and the plan's schema), \`chat-brief\` (the saved plan, the playback position and the narrator exchange so far), \`direct\`/\`revise\` then \`confirm\` (make or change the plan; each is checked and read back first), \`packaging-brief\`/\`packaging\`, \`narrate-brief\` (what the narrator sees). And the engine, as often and as deep as you need: \`board <where>\`, \`probe <where> <moves…>\`, \`options <where> [n]\`, \`threat <where>\` (see "Asking the engine" in the brief).
INVESTIGATE WIDELY, BEFORE YOU CHOOSE. The best line in a game is often not the one that looks best at first, so open many before you narrow down:
- Your candidates: every line the brief lists under "Lines worth narrating", every turning point you want in the story, and every place a player named or weighed a move in their own words (the line that starts with it).
- For EACH candidate: \`board\` it; run \`options\` where the losing side moves (if even its best loses the piece, nothing saves it: why?); \`threat\` after each quiet move; and \`probe\` the moves a human would reach for: the capture, the check, the sacrifice taken, the move the player named. Follow what surprises you: probe its answers too.
- Inside a branch, too: a position can carry moves after slashes ("42a3/Bc2"), so before you say "every defence fails" there, run \`options\` on it and see each defence lose.
- Keep notes in investigation.md: for each line, what it shows, its why in one sentence, the question a viewer would ask, and how strong it is for the video.
- Only then choose. Rule a line out only after you've probed it and found it weaker. Expect dozens of engine questions, not a handful: your plan's readback shows what you haven't looked at yet.
Choose the lines whose why you can say (as many as the story needs; there is no fixed number), give each moment's \`why\` the point of its line, and build your narrator's handoff from your notes.
${NARRATOR_LOOP(g, cli, s.key)}
Do not edit application code or persisted JSON files directly. Never approve, render, record voices or publish: the user does that from the video tab.`;
  const editing = `revise accepts {moments:[{ply,...changed fields}],removeMoments:[ply],asides:[...],hook:{...},interviewLines:{...},quiet:[...]}; omitted sections and moments stay unchanged, supplied non-moment sections replace that section. New moments need the brief's fields. A change to a line's narration goes to the narrator (request-narration with what to change, or t3_thread_send to a narrator still at work).
The preview hot-reloads every saved change. confirm saves a draft for the user to review; it is NOT render approval. Finish each request with done, then respond to the user here. Before later edits run chat-brief to refresh the plan. Text edits reuse recorded audio only when words and delivery still match.`;
  if (s.mode === "auto")
    return `You are the video director for Agent Chess Arena, where AI agents play chess against each other. Game ${g.id} (White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}) is over, and it's being cut into a replay video. Your job: choose what the video slows down for, and see the narration over its engine lines through with a narrator of your own. No one is watching this thread live: work it through, then report.
${common}
STEPS: run \`brief\`; investigate; write the plan and submit it with \`direct <plan.json>\` (leave narration beats and branches out: they're the narrator's); check the readback and \`confirm\`. Then the narrator, as above, until you're both satisfied, and \`done\`. Your final answer: the story, the moments, the lines and what each is for, what the narrator asked for and what you decided.
AFTERWARDS: this thread is also where the user talks with you about the video, from its "Talk with the director" button, so keep it open (never settle or archive it). When they write here, run chat-brief first (their playback position, and the plan as saved now, which they may have changed since), then talk with them: answer from what you investigated and decided, and make the changes they ask for. Your session key stays the same.
${editing}`;
  return `You are the video director for Agent Chess game ${g.id}. The user opened this persistent T3 Code conversation from the video tab. Talk with them HERE in T3 Code. Keep this thread available for follow-up edits; do not settle/archive it automatically.
If your current thread id is available, register it with bind-thread --text <threadId> so the website can open this exact thread.
${common}
Start with chat-brief, which gives the current saved plan and playback position. If no plan exists, make one as the auto director would (brief, investigate, direct, confirm, then the narrator). If a plan exists, briefly orient the user and wait for their request; don't rewrite it merely because they opened the thread.
${editing}`;
}

function narratorPrompt(g: Game, s: Session) {
  const n = s.narrator!;
  const cli = `node "${CLI}"`;
  return `You are the narrator for Agent Chess game ${g.id} (White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}), working with its video director, who launched you. You are the voice that tells the viewer what was really on the board over the video's engine lines, and why.
The director's handoff:
${n.request}

Run commands as: ${cli} <command> [file] --key ${n.key}. Keep your files in ${agentDir(g.id, "n")}.
1. Run \`chat-brief\` (the saved plan and your exchange with the director so far) and \`narrate-brief\` (each line, what the viewer must understand, the branches it raises, and how to write the narration).
2. Investigate before you write, every line from several angles: \`board\` it; \`options\` at each point the losing side moves (what saves it, or why nothing does); \`threat\` after each quiet move; \`probe\` what each side would naturally try instead (the capture, the check, the sacrifice taken, a player's own idea) and follow whatever surprises you. Inside a branch too: a position can carry moves after slashes ("42a3/Bc2"), so check a claim like "every defence fails" with \`options\` there yourself rather than taking the director's word. Expect many engine questions per line. Keep notes in investigation.md. Your goal: be able to say WHY the line is what it is, and to spot what the director missed (a stronger line, a better question to answer). Each narration readback shows which lines you haven't probed yet.
3. Write the narration as JSON and submit it with \`narrate <narration.json>\`. It's checked, saved and read back with how it will play; fix and resubmit until it's right.
4. What's yours: how each line is told (beats, word cues, drawings, branches, where it's cut, puzzle before the move or reveal after it, the best-move arrow) and re-cutting the players' quotes right around a line. What's the director's: the story (the moments, which have lines and of which kind, the quotes elsewhere). If you think the story should change (a line the video needs and hasn't got, one it shouldn't have, a line's kind, a quote that repeats you), ask for it, with the engine's evidence.
5. End each turn with exactly this, and record the same with \`log <file|--text "…">\`:
   DONE THIS ROUND: what you wrote or changed
   REQUESTS: each change you want the director to make, and why (or "none")
   OBJECTIONS: anything in its decisions you disagree with, and why (or "none")
6. The director answers in this thread. If it changed the plan, run \`narrate-brief\` again first (a narration written against the old plan is refused). Argue back where you disagree; after about four rounds its call stands. When it says the narration is final, run \`done\` and end.
Do not edit the plan except through narrate, and never approve, record voices, render or publish.`;
}const narrationTask = (g: Game, s: Session) => JSON.stringify({ task: narratorPrompt(g, s), target: target(), mode: "async", clientRequestId: `${g.id}-narrate-${s.narrator!.key.slice(-12)}` }, null, 2);
export const isDirectorThreadKey = (key: string) => key.startsWith("dt-");
function sessionFor(key: string) {
  for (const s of sessions.values()) {
    if (s.key === key) return { s, narrator: false };
    if (s.narrator?.key === key && s.narrator.active) return { s, narrator: true };
  }
  throw new ActionError("This director session is no longer active.");
}

export async function directorThreadCommand(key: string, cmd: string, body: any, blocked?: (g: Game) => boolean): Promise<string> {
  const { s, narrator } = sessionFor(key);
  const g = games.get(s.gameId);
  if (!g) throw new ActionError("No such game.");
  s.seenAt = Date.now(); save(s);
  if (cmd === "bind-thread" && !narrator) {
    const id = typeof body.text === "string" ? body.text.trim() : "";
    if (!id || id.length > 2000 || /[\s\x00-\x1f]/.test(id)) throw new ActionError("Give the T3 thread id.");
    if (s.threadId && s.threadId !== id) throw new ActionError("This conversation is already bound to another thread.");
    s.threadId = id;
    if (s.status === "opening") s.status = g.video ? "ready" : "working";
    save(s); return "Director thread linked to the video tab.";
  }
  if (cmd === "start" || cmd === "help")
    return narrator ? narratorPrompt(g, s) : `${s.mode === "auto" ? "🎬 Video director" : "🎬 Talk with the director"} — ${g.id}\n\n${directorSessionPrompt(g, s)}`;
  if (cmd === "chat-brief") {
    // Reading the plan as it is now lets the director edit it again, between its narrator's turns too.
    if (!s.draft && !narrator) s.revision = videoRevision(g);
    if (s.status === "opening" || s.status === "failed") s.status = s.narrator?.active ? "narrating" : s.draft || !g.video ? "working" : "ready";
    s.error = undefined;
    save(s);
    const log = (s.log ?? []).map((l) => `[${l.from}] ${l.text}`).join("\n\n");
    return `Game ${g.id}. Playback context: ${JSON.stringify(s.context ?? null)}\nCurrent saved plan (normalized read-only reference, not submission JSON):\n${JSON.stringify(g.video ?? null, null, 2)}${log ? `\n\nThe director and narrator's exchange so far:\n${log}` : ""}`;
  }
  // Each round of the director and narrator's exchange, as they record it (shown in chat-brief, and kept for the user).
  if (cmd === "log") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 6000) throw new ActionError("Give what to record, 1–6,000 characters (log <file> or --text \"…\").");
    s.log = [...(s.log ?? []), { at: Date.now(), from: narrator ? "narrator" : "director", text }];
    save(s);
    return "Recorded.";
  }
  if (cmd === "done") {
    if (s.draft) throw new ActionError("An unsaved draft remains. Confirm it or use discard-draft first.");
    // The narrator's done hands the turn back to its director, whose own done finishes the work.
    if (narrator) {
      s.narrator!.active = false;
      s.revision = videoRevision(g);
      s.status = "working";
      save(s);
      return "Done: your director takes it from here. End your turn with your final report.";
    }
    if (s.narrator?.active) throw new ActionError("Wait for the narration agent, or cancel its task and run narration-cancel.");
    s.status = "ready"; s.error = undefined; save(s);
    return s.mode === "auto" ? "Done: the plan and its narration are saved for the user to review. Give your final report." : "Saved work is ready for the user to review in the video tab. Reply in T3 Code.";
  }
  if (cmd === "discard-draft" && !narrator) { delete s.draft; save(s); return "Unsaved draft discarded; the saved plan is unchanged."; }
  if (cmd === "narration-cancel" && !narrator) {
    if (s.narrator) s.narrator.active = false;
    s.status = "ready"; s.revision = videoRevision(g); save(s); return "Narration credential revoked; any changes already saved remain for review.";
  }
  if (cmd === "narration-task" && !narrator) {
    if (!s.narrator?.active) throw new ActionError("No narration task is active.");
    return narrationTask(g, s);
  }
  if (cmd === "brief") {
    if (!linesReady(g)) {
      let timer: ReturnType<typeof setTimeout>;
      const ready = await Promise.race([deepenLines(g), new Promise<false>(r => { timer = setTimeout(() => r(false), 270_000); })]).finally(() => clearTimeout(timer!));
      if (!ready) return "WAITING — engine lines are still being prepared. Run brief again.";
    }
    return directorBrief(g);
  }
  const probed = await probeCommand(g, cmd, body.args, narrator ? "narrator" : "director");
  if (probed !== null) return probed;
  if (cmd === "narrate-brief") {
    if (!g.video) throw new ActionError("Save a plan first.");
    if (!(await linesPrepared(g))) return "WAITING — the engine is still working out the questions your lines raise. Run narrate-brief again.";
    // The narrator reads the plan as it is now: what it narrates next is checked against this.
    if (narrator) {
      s.narrator!.revision = videoRevision(g);
      save(s);
    }
    return narrateBrief(g);
  }
  if (cmd === "packaging-brief") { if (!g.video) throw new ActionError("Save a plan first."); return packagingBrief(g); }
  if (blocked?.(g)) throw new ActionError("Wait for rendering or publishing to finish before editing.");
  // The director and its narrator take turns: the director may change the plan between the narrator's turns (a
  // request it agreed to), and whoever edits next has to have read the plan as it is now.
  const revision = narrator ? s.narrator!.revision : s.revision;
  if (revision !== videoRevision(g))
    throw new ActionError(narrator ? "The director changed the plan since you last read it. Run narrate-brief again, then submit." : "The plan changed (your narrator saved narration). Read chat-brief to refresh before editing; discard a stale draft first.");
  if (cmd === "request-narration" && !narrator) {
    if (!g.video || s.draft) throw new ActionError("Save your plan/draft before delegating narration.");
    if (s.narrator?.active) throw new ActionError("Your narrator is still at work: talk to it in its thread (t3_thread_send), or narration-cancel first.");
    const request = typeof body.text === "string" ? body.text.trim() : "";
    if (!request || request.length > 8000) throw new ActionError("Give a narration request of 1–8,000 characters.");
    s.narrator = { key: token(), revision, request, active: true }; s.status = "narrating"; save(s);
    return narrationTask(g, s);
  }
  if (!narrator && (cmd === "direct" || cmd === "revise")) {
    if (cmd === "direct" && g.video) throw new ActionError("Use revise to edit the saved plan.");
    if (cmd === "direct" && body.plan?.moments?.some((m: any) => m.line?.beats || m.line?.branches)) throw new ActionError("The separate narration agent writes beats; save the plan, then request-narration.");
    s.draft = cmd === "direct" ? validatePlan(g, body.plan) : reviseVideoPlan(g, body.plan);
    s.status = "working"; save(s);
    return `Draft checked. Review its drawings and quotes, then confirm to save for user review.\n${investigationNotes(g, s.draft).join("\n")}\n\n${planReadback(g, s.draft)}`;
  }
  if (cmd === "confirm" && !narrator) {
    if (!s.draft) throw new ActionError("No draft to save; use direct or revise first.");
    g.video = s.draft; delete s.draft;
  } else if (cmd === "narrate" && narrator) {
    if (!g.video) throw new ActionError("No plan to narrate.");
    g.video = applyNarration(g, body.narration);
  } else if (cmd === "packaging" && !narrator) {
    if (!g.video) throw new ActionError("No plan yet.");
    const options = packagingChoices(g, body.packaging);
    g.video = { ...g.video, packagingOptions: options, packaging: { title: options.titles[0], caption: options.captions[0], thumbnail: options.thumbnails[0] } };
  } else throw new ActionError(`Command ${cmd} isn't available here. Narration edits require request-narration and the separate narrator.`);
  saveGameNow(g); touch(g);
  if (narrator) s.narrator!.revision = videoRevision(g); else s.revision = videoRevision(g);
  s.status = narrator ? "narrating" : "working"; save(s);
  return cmd === "narrate" ? `Narration saved; the preview updates now.\n${narratorInvestigationNotes(g, g.video!).join("\n")}\n\n${narratedReadback(g, g.video!).join("\n")}\nEnd your turn with DONE THIS ROUND / REQUESTS / OBJECTIONS for your director (and log it).` : "Saved; the preview updates now. Delegate narration if needed, otherwise run done and reply to the user in T3 Code.";
}
