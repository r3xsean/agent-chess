import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DirectorThreadState, VideoContext } from "../shared/directorThread";
import type { Game, VideoPlan } from "../shared/types";
import { DEFAULT_DIRECTOR } from "../shared/models";
import { CLI, DATA, ROOT } from "./paths";
import { games, saveGameNow } from "./store";
import { ActionError, touch } from "./game";
import { agentWebhook, orchestratorAvailable, triggerAgent, triggerOrchestrator } from "./summon";
import { applyNarration, directorBrief, narrateBrief, narratedReadback, packagingBrief, packagingChoices, planReadback, validatePlan } from "./director";
import { deepenLines, linesReady } from "./lineDepth";
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
/** One persistent T3 conversation per game. Reopening never sends a new user message. */
export async function openDirectorThread(g: Game, body: any, start = launch): Promise<DirectorThreadState> {
  if (g.phase !== "finished" || !g.review || !g.moves.length) throw new ActionError("The game needs to be finished and reviewed first.");
  let s = sessions.get(g.id);
  directorThreadState(g);
  const raw = body?.context;
  const context = raw && Number.isFinite(raw.time) && raw.time >= 0 && ["landscape", "portrait"].includes(raw.format)
    ? { time: Math.min(raw.time, 86400), format: raw.format, ...(g.moves.some(m => m.ply === raw.ply) && { ply: raw.ply }) } : undefined;
  if (s && (s.status !== "failed" || body?.retry !== true || s.threadId)) {
    if (context) { s.context = context; save(s); }
    return directorThreadState(g);
  }
  s = { gameId: g.id, key: token(), createdAt: Date.now(), seenAt: Date.now(), revision: videoRevision(g), status: "opening", context };
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

function directorSessionPrompt(g: Game, s: Session) {
  return `You are the video director for Agent Chess game ${g.id}. The user opened this persistent T3 Code conversation from the video tab. Talk with them HERE in T3 Code. Keep this thread available for follow-up edits; do not settle/archive it automatically.
Run commands as: node "${CLI}" <command> [file] --key ${s.key}. If your current thread id is available, register it with bind-thread --text <threadId> so the website can open this exact thread.
Start with chat-brief, which gives the current saved plan and playback position. If no plan exists, run brief, create the plan with direct <file.json>, check its readback, then confirm. If a plan already exists, briefly orient the user and wait for their request; do not rewrite it merely because they opened the thread.
Use brief for the full game's engine analysis, players' quotes and plan schema. Answer questions grounded in those sources. For requested changes to an existing plan use revise <file.json>, inspect the checked draft, then confirm to save it. revise accepts {moments:[{ply,...changed fields}],removeMoments:[ply],asides:[...],hook:{...},interviewLines:{...},quiet:[...]}; omitted sections and moments stay unchanged, supplied non-moment sections replace that section. New moments require the brief's fields; changed marks/lines use its submission schema. Packaging changes use packaging-brief and packaging <file.json>. Do not edit application code or persisted JSON files directly. Explain unsupported features honestly.
NARRATION: do not write or submit narrator beats yourself. Use request-narration <request.txt> with the requested plies and changes. It returns a dedicated narrator task, prompt and model. Launch it with delegate_task as a child of THIS thread, retain taskId, and wait for its result. If the CLI response was lost, narration-task retrieves that same task; reuse its clientRequestId when retrying delegation. It saves through the CLI with its own key. If delegation fails or the child fails, cancel the task and use narration-cancel to release the edit lock before reporting the failure. When a newly created plan has engine lines, delegate their narration before finishing.
The preview hot-reloads every saved change. confirm saves a draft for the user to review; it is NOT render approval. The user returns to the video tab to approve and explicitly render with voices. Never approve, render, record voices, or publish from this thread. Finish each request with done to clear the working state, then respond to the user here. Before subsequent edits run chat-brief to refresh the current plan. Text edits reuse recorded audio only when words and delivery still match.`;
}
function narratorPrompt(g: Game, s: Session) {
  const n = s.narrator!;
  return `You are the separate narration agent for Agent Chess game ${g.id}, delegated by its director. Request: ${n.request}
Run commands as: node "${CLI}" <command> [file] --key ${n.key}.
Read chat-brief and narrate-brief, then submit only the requested changes with narrate <file.json>. Inspect the readback and fix as needed. Preserve unrelated lines. Follow the narration brief's word cues, entry cues and before/after hand-backs. When finished, run done, then report the actual changes to your parent director in your final answer. Do not edit the plan directly, approve, record voices, render, or publish. A changed line is text-only until the user renders with voices.`;
}
const narrationTask = (g: Game, s: Session) => JSON.stringify({ task: narratorPrompt(g, s), target: target(), mode: "async", clientRequestId: `${g.id}-narrate-${s.narrator!.key.slice(-12)}` }, null, 2);
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
  if (cmd === "start" || cmd === "help") return narrator ? narratorPrompt(g, s) : `🎬 Talk with the director — ${g.id}\n\n${directorSessionPrompt(g, s)}`;
  if (cmd === "chat-brief") {
    if (!s.draft && !s.narrator?.active) s.revision = videoRevision(g);
    if (s.status === "opening" || s.status === "failed") s.status = s.narrator?.active ? "narrating" : s.draft || !g.video ? "working" : "ready";
    s.error = undefined;
    save(s);
    return `Game ${g.id}. Playback context: ${JSON.stringify(s.context ?? null)}\nCurrent saved plan (normalized read-only reference, not submission JSON):\n${JSON.stringify(g.video ?? null, null, 2)}`;
  }
  if (cmd === "done") {
    if (s.draft) throw new ActionError("An unsaved draft remains. Confirm it or use discard-draft first.");
    if (narrator) { s.narrator!.active = false; s.revision = videoRevision(g); }
    else if (s.narrator?.active) throw new ActionError("Wait for the narration agent, or cancel its task and run narration-cancel.");
    s.status = "ready"; s.error = undefined; save(s); return "Saved work is ready for the user to review in the video tab. Reply in T3 Code.";
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
  if (cmd === "narrate-brief") { if (!g.video) throw new ActionError("Save a plan first."); return narrateBrief(g); }
  if (cmd === "packaging-brief") { if (!g.video) throw new ActionError("Save a plan first."); return packagingBrief(g); }
  if (blocked?.(g)) throw new ActionError("Wait for rendering or publishing to finish before editing.");
  if (!narrator && s.narrator?.active) throw new ActionError("The narration agent is working. Wait for it before editing the plan.");
  const revision = narrator ? s.narrator!.revision : s.revision;
  if (revision !== videoRevision(g)) throw new ActionError("The plan changed. Read chat-brief to refresh before editing; discard a stale draft first.");
  if (cmd === "request-narration" && !narrator) {
    if (!g.video || s.draft) throw new ActionError("Save your plan/draft before delegating narration.");
    const request = typeof body.text === "string" ? body.text.trim() : "";
    if (!request || request.length > 8000) throw new ActionError("Give a narration request of 1–8,000 characters.");
    s.narrator = { key: token(), revision, request, active: true }; s.status = "narrating"; save(s);
    return narrationTask(g, s);
  }
  if (!narrator && (cmd === "direct" || cmd === "revise")) {
    if (cmd === "direct" && g.video) throw new ActionError("Use revise to edit the saved plan.");
    if (cmd === "direct" && body.plan?.moments?.some((m: any) => m.line?.beats)) throw new ActionError("The separate narration agent writes beats; save the plan, then request-narration.");
    s.draft = cmd === "direct" ? validatePlan(g, body.plan) : reviseVideoPlan(g, body.plan);
    s.status = "working"; save(s);
    return `Draft checked. Review its drawings and quotes, then confirm to save for user review.\n${planReadback(g, s.draft)}`;
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
  return cmd === "narrate" ? `Narration saved; the preview updates now.\n${narratedReadback(g, g.video!).join("\n")}\nRun done when satisfied, then report to the director.` : "Saved; the preview updates now. Delegate narration if needed, otherwise run done and reply to the user in T3 Code.";
}
