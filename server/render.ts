import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DATA, PORT, ROOT } from "./paths";
import { games, readJson, writeJson } from "./store";
import { videoApproved, videoRevision } from "./videoApproval";
import { voiceGame } from "./voice";
import { gameVideoDir, thumbOptionPath, thumbOptionUrl, videoPath, videoUrl, VIDEO_DIR } from "./videoFiles";

export { VIDEO_DIR };

/*
 * Video renders started after user approval. One render runs at a time; the rest queue.
 * Planning and conversation never start recording or rendering.
 */

export type RenderFormat = "landscape" | "portrait";

export interface RenderJob {
  id: string;
  gameId: string;
  formats: RenderFormat[];
  music: string | null;
  /** Speak the players' lines (false: a deliberately silent render). */
  voices: boolean;
  revision?: string;
  /** Only the thumbnails and the upload text, not the videos (see makeThumbnails). */
  packageOnly?: boolean;
  status: "waiting-director" | "queued" | "rendering" | "done" | "failed";
  /** What's happening right now, in words. */
  stage: string;
  /** 0–100 for the format being rendered. */
  progress: number;
  format?: RenderFormat;
  error?: string;
  note?: string;
  createdAt: number;
  finishedAt?: number;
}

export const MUSIC_DIR = path.join(ROOT, "vendor", "music");
const SCRIPT = path.join(ROOT, "scripts", "render-video.mjs");

/** The queue, kept on disk so a restart picks it up again (finished jobs for a week, so the page still shows how they went). */
const JOBS_FILE = path.join(DATA, "render-jobs.json");
const KEEP_MS = 7 * 86_400_000;
const jobs: RenderJob[] = readJson<RenderJob[]>(JOBS_FILE, []);
let running = false;

function saveJobs() {
  try {
    writeJson(JOBS_FILE, jobs.filter((j) => !j.finishedAt || Date.now() - j.finishedAt < KEEP_MS));
  } catch (e) {
    console.error("[render]", (e as Error).message);
  }
}

/**
 * At boot: jobs the last server left queued or part-done are queued again (a render cut off starts over, its
 * voices already recorded are reused). The renderer it was running went with it (see renderFrames).
 */
export function resumeRenders() {
  const left = jobs.filter((j) => j.status === "queued" || j.status === "rendering");
  for (const j of left) {
    if (j.status === "rendering") j.stage = "Queued again: the server restarted mid-render";
    Object.assign(j, { status: "queued", progress: 0, format: undefined });
  }
  if (!left.length) return;
  console.log(`[render] ${left.length} render${left.length === 1 ? "" : "s"} queued again after a restart`);
  saveJobs();
  // Once this server is listening (the renderer loads the video page from it), and the last renderer is surely gone.
  setTimeout(pump, 5_000);
}

export const jobsFor = (gameId: string) => jobs.filter((j) => j.gameId === gameId);

export function musicTracks(): string[] {
  if (!existsSync(MUSIC_DIR)) return [];
  return readdirSync(MUSIC_DIR)
    .filter((n) => /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(n))
    .sort();
}

/** A file's link, stamped with when it was made so a remade one isn't shown from the cache (null: not made). */
const stamped = (file: string, url: string) => (existsSync(file) ? `${url}?t=${Math.round(statSync(file).mtimeMs)}` : null);

/** What came with the YouTube render: the upload text (title, caption, chapters), the thumbnail, and each thumbnail option's. */
export function packagingFor(gameId: string) {
  const txt = videoPath(gameId, "uploadText");
  const options = games.get(gameId)?.video?.packagingOptions?.thumbnails ?? [];
  return {
    description: existsSync(txt) ? readFileSync(txt, "utf8") : null,
    thumbUrl: stamped(videoPath(gameId, "thumbnail"), videoUrl(gameId, "thumbnail")),
    thumbOptionUrls: options.map((_, n) => stamped(thumbOptionPath(gameId, n), thumbOptionUrl(gameId, n))),
  };
}

/** The upload's thumbnail is now option n: its picture is copied over, or, not made yet, the thumbnails are made. */
export function useThumbnailOption(gameId: string, n: number) {
  const from = thumbOptionPath(gameId, n);
  if (existsSync(from)) copyFileSync(from, videoPath(gameId, "thumbnail"));
  else makeThumbnails(gameId);
}

/** New options: the old options' pictures go (up to the most there can be), so none is shown for the wrong one. */
export function dropThumbOptions(gameId: string) {
  for (let n = 0; n < 10; n++) rmSync(thumbOptionPath(gameId, n), { force: true });
}

/**
 * Make the thumbnails (the one in use and each option's) and the upload text again, without rendering
 * the videos: after new options from the director, or a pick whose picture isn't made yet.
 */
export function makeThumbnails(gameId: string): RenderJob {
  const waiting = jobs.find((j) => j.gameId === gameId && j.packageOnly && j.status === "queued");
  if (waiting) return waiting;
  const job: RenderJob = { id: `${gameId}-${Date.now().toString(36)}`, gameId, formats: ["landscape"], music: null, voices: true, packageOnly: true, status: "queued", stage: "Queued: making the thumbnails", progress: 0, createdAt: Date.now() };
  jobs.push(job);
  saveJobs();
  pump();
  return job;
}

/** The finished videos of a game, newest first. */
export function videosFor(gameId: string) {
  return (["youtube", "tiktok"] as const)
    .map((kind) => ({ kind, path: videoPath(gameId, kind) }))
    .filter((v) => existsSync(v.path))
    .map((v) => {
      const st = statSync(v.path);
      return { kind: v.kind, file: path.basename(v.path), url: videoUrl(gameId, v.kind), bytes: st.size, at: st.mtimeMs };
    });
}

function update(job: RenderJob, patch: Partial<RenderJob>) {
  Object.assign(job, patch);
  saveJobs();
}

/** Queue only the exact plan the user approved. Voice recording is part of this explicit step. */
export async function startRender(gameId: string, formats: RenderFormat[], music: string | null, voices = true, redirect = false): Promise<RenderJob> {
  const g = games.get(gameId);
  if (!g) throw new Error("No such game.");
  if (g.phase !== "finished") throw new Error("The game isn't finished yet.");
  if (redirect) throw new Error("Run the director, review the plan and approve it before rendering.");
  if (!videoApproved(g)) throw new Error("Approve the current video plan before rendering.");
  if (music && !musicTracks().includes(music)) throw new Error(`No such track in vendor/music: ${music}`);
  const active = jobs.find(j => j.gameId === gameId && !j.packageOnly && !["done", "failed"].includes(j.status));
  if (active) return active;
  const job: RenderJob = { id: `${gameId}-${Date.now().toString(36)}`, gameId, formats, music, voices, revision: videoRevision(g), status: "queued", stage: "Queued", progress: 0, createdAt: Date.now() };
  jobs.push(job);
  saveJobs();
  pump();
  return job;
}

function pump() {
  if (running) return;
  const job = jobs.find((j) => j.status === "queued");
  if (!job) return;
  running = true;
  run(job).finally(() => {
    running = false;
    pump();
  });
}

async function run(job: RenderJob): Promise<void> {
  // The players' voices first: the video's timing follows the length of each recorded line. A video
  // with some lines voiced and others silent would look broken, so if any line can't be voiced the
  // render stops and says why; a retry reuses everything already recorded.
  const g = games.get(job.gameId);
  const changed = () => !job.packageOnly && (!g || !videoApproved(g) || videoRevision(g) !== job.revision);
  const stale = () => update(job, { status: "failed", stage: "Plan changed", error: "Review and approve the updated plan, then render again.", finishedAt: Date.now() });
  if (changed()) return stale();
  if (g?.video && job.voices && !job.packageOnly) {
    update(job, { status: "rendering", stage: "Recording the voices…", progress: 0 });
    const stop = (why: string) =>
      update(job, {
        status: "failed",
        stage: "Stopped: the voices aren't ready",
        error: `${why} Render again to retry; lines already recorded are reused, not paid for twice.`,
        finishedAt: Date.now(),
      });
    try {
      const v = await voiceGame(g, (done, total) => update(job, { stage: `Recording the voices… ${done}/${total}`, progress: Math.round((done / total) * 100) }));
      if (v.silent) return stop(`${v.silent} line${v.silent > 1 ? "s" : ""} couldn't be voiced: ${v.reason ?? "unknown reason."}`);
      if (v.recorded) update(job, { note: `Recorded ${v.recorded} voice line${v.recorded > 1 ? "s" : ""} (${v.chars} ElevenLabs characters)${v.cached ? `, reused ${v.cached}` : ""}.` });
    } catch (e) {
      return stop(`Recording failed: ${(e as Error).message}.`);
    }
  }
  if (changed()) return stale();
  return renderFrames(job);
}

function renderFrames(job: RenderJob): Promise<void> {
  return new Promise((resolve) => {
    const format = job.formats.length === 2 ? "both" : job.formats[0];
    // Into the game's own folder, under the one the site serves and lists videos from (the data folder can live anywhere).
    const args = [SCRIPT, job.gameId, "--format", format, "--out", gameVideoDir(job.gameId, true)];
    if (job.music) args.push("--music", path.join(MUSIC_DIR, job.music));
    if (!job.voices) args.push("--voices", "off");
    if (job.packageOnly) args.push("--package");
    update(job, { status: "rendering", stage: job.packageOnly ? "Making the thumbnails…" : "Starting the renderer…", progress: 0 });
    // Pointed at this server, whichever port it's on. When this server goes, however it goes, the renderer goes
    // with it, so the next boot can render the job again without two renderers writing the same files: on Windows
    // a child dies with its parent anyway (libuv's job object); elsewhere its unused standard input closes.
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, CHESS_SERVER: `http://127.0.0.1:${PORT}`, RENDER_EXIT_WITH_SERVER: "1" } });
    let errText = "";
    child.stdout.on("data", (d: Buffer) => {
      // The renderer reports "\r<format>: <pct>%" while capturing frames, then a line per finished file.
      for (const part of d.toString().split(/[\r\n]+/)) {
        const pct = part.match(/^(landscape|portrait): (\d+)%/);
        if (pct) update(job, { format: pct[1] as RenderFormat, progress: Number(pct[2]), stage: `Rendering the ${pct[1] === "landscape" ? "YouTube" : "TikTok"} video` });
        const done = part.match(/^(landscape|portrait): .*\.mp4/);
        if (done) update(job, { progress: 100, stage: `${done[1] === "landscape" ? "YouTube" : "TikTok"} video done` });
      }
    });
    child.stderr.on("data", (d: Buffer) => (errText += d.toString()));
    child.on("close", (code) => {
      if (code === 0) update(job, { status: "done", stage: "Done", progress: 100, finishedAt: Date.now() });
      else update(job, { status: "failed", stage: "Failed", error: errText.trim().split("\n").slice(-3).join("\n") || `renderer exited with ${code}`, finishedAt: Date.now() });
      resolve();
    });
  });
}
