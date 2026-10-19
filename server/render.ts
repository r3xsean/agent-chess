import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { PORT, ROOT } from "./paths";
import { games, saveGameNow } from "./store";
import { touch } from "./game";
import type { VideoPlan } from "../shared/types";
import { needsDirection } from "./director";
import { summonAvailable } from "./summon";
import { launchDirector } from "./launcher";
import { voiceGame } from "./voice";
import { gameVideoDir, thumbOptionPath, thumbOptionUrl, videoPath, videoUrl, VIDEO_DIR } from "./videoFiles";

export { VIDEO_DIR };

/*
 * Video renders started from the website. One render runs at a time; the rest queue. A game with no
 * director's plan gets a director summoned first (through the T3 webhook), and the render waits for it;
 * a redo throws the plan away first, so a new director makes another.
 */

export type RenderFormat = "landscape" | "portrait";

export interface RenderJob {
  id: string;
  gameId: string;
  formats: RenderFormat[];
  music: string | null;
  /** Speak the players' lines (false: a deliberately silent render). */
  voices: boolean;
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
/** How long to wait for a summoned director before rendering with the automatic picks. */
const DIRECTOR_WAIT_MS = 15 * 60_000;

const jobs: RenderJob[] = [];
let running = false;

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
}

/** Plans thrown away for a redo, kept until the new director delivers in case it never does. */
const replaced = new Map<string, VideoPlan>();

/** The redo's director never came: the plan it was replacing goes back (unless a new one arrived after all). */
function restorePlan(gameId: string): boolean {
  const prev = replaced.get(gameId);
  replaced.delete(gameId);
  const g = games.get(gameId);
  if (!prev || !g || g.video) return false;
  g.video = prev;
  saveGameNow(g);
  touch(g);
  return true;
}

/**
 * Queue a render. `redirect`: throw the director's plan away and summon a new director first (to re-cut a
 * video, or to get a plan made with features the old director didn't have).
 */
export async function startRender(gameId: string, formats: RenderFormat[], music: string | null, voices = true, redirect = false): Promise<RenderJob> {
  const g = games.get(gameId);
  if (!g) throw new Error("No such game.");
  if (g.phase !== "finished") throw new Error("The game isn't finished yet.");
  if (music && !musicTracks().includes(music)) throw new Error(`No such track in vendor/music: ${music}`);
  const active = jobs.find((j) => j.gameId === gameId && !j.packageOnly && !["done", "failed"].includes(j.status));
  if (active) return active;
  if (redirect && g.video) {
    if (!summonAvailable()) throw new Error("No T3 webhook configured, so no director can be summoned to redo the plan.");
    replaced.set(gameId, g.video);
    delete g.video;
    if (g.launched) delete g.launched.d;
    g.videoRedos = (g.videoRedos ?? 0) + 1;
    saveGameNow(g);
    touch(g);
  }

  const job: RenderJob = { id: `${gameId}-${Date.now().toString(36)}`, gameId, formats, music, voices, status: "queued", stage: "Queued", progress: 0, createdAt: Date.now() };
  jobs.push(job);
  if (needsDirection(g)) {
    // Without a director the render goes on: with the old plan on a redo, otherwise the automatic picks.
    const fallback = (why: string) => update(job, { status: "queued", stage: "Queued", note: `${why}; ${restorePlan(gameId) ? "keeping the previous plan" : "using the automatic picks"}.` });
    if (summonAvailable()) {
      update(job, { status: "waiting-director", stage: redirect ? "Summoning a new video director…" : "Summoning the video director…" });
      launchDirector(g)
        .then(() => update(job, { stage: "Waiting for the director to pick the moments…" }))
        .catch((e) => {
          fallback(`Couldn't summon a director (${e.message})`);
          pump();
        });
      setTimeout(() => {
        if (job.status === "waiting-director") fallback("The director didn't answer in time");
        pump();
      }, DIRECTOR_WAIT_MS);
    } else update(job, { note: "No T3 webhook configured, so no director; using the automatic picks." });
  }
  pump();
  return job;
}

/** The director saved its plan: release the renders that were waiting for it. */
export function directorDone(gameId: string) {
  replaced.delete(gameId);
  for (const j of jobs) if (j.gameId === gameId && j.status === "waiting-director") update(j, { status: "queued", stage: "Queued" });
  pump();
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
  if (g?.video && job.voices && !job.packageOnly) {
    update(job, { status: "rendering", stage: "Recording the voices…", progress: 0 });
    const stop = (why: string) =>
      update(job, {
        status: "failed",
        stage: "Stopped: the voices aren't ready",
        error: `${why} Render again to retry (lines already recorded are reused, not paid for twice), or tick "Without voices".`,
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
    // Pointed at this server, whichever port it's on.
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHESS_SERVER: `http://127.0.0.1:${PORT}` } });
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
