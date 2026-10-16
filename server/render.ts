import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DATA, ROOT } from "./paths";
import { games } from "./store";
import { needsDirection } from "./director";
import { summonAvailable, triggerOrchestrator } from "./summon";

/*
 * Video renders started from the website. One render runs at a time; the rest queue. A game with no
 * director's plan gets a director summoned first (through the T3 webhook), and the render waits for it.
 */

export type RenderFormat = "landscape" | "portrait";

export interface RenderJob {
  id: string;
  gameId: string;
  formats: RenderFormat[];
  music: string | null;
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

export const VIDEO_DIR = path.join(DATA, "videos");
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

/** The finished videos of a game, newest first. */
export function videosFor(gameId: string) {
  if (!existsSync(VIDEO_DIR)) return [];
  return (["youtube", "tiktok"] as const)
    .map((kind) => ({ kind, file: `${gameId}-${kind}.mp4` }))
    .filter((v) => existsSync(path.join(VIDEO_DIR, v.file)))
    .map((v) => {
      const st = statSync(path.join(VIDEO_DIR, v.file));
      return { ...v, url: `/videos/${v.file}`, bytes: st.size, at: st.mtimeMs };
    });
}

function update(job: RenderJob, patch: Partial<RenderJob>) {
  Object.assign(job, patch);
}

export async function startRender(gameId: string, formats: RenderFormat[], music: string | null): Promise<RenderJob> {
  const g = games.get(gameId);
  if (!g) throw new Error("No such game.");
  if (g.phase !== "finished") throw new Error("The game isn't finished yet.");
  if (music && !musicTracks().includes(music)) throw new Error(`No such track in vendor/music: ${music}`);
  const active = jobs.find((j) => j.gameId === gameId && !["done", "failed"].includes(j.status));
  if (active) return active;

  const job: RenderJob = { id: `${gameId}-${Date.now().toString(36)}`, gameId, formats, music, status: "queued", stage: "Queued", progress: 0, createdAt: Date.now() };
  jobs.push(job);
  if (needsDirection(g)) {
    if (summonAvailable()) {
      update(job, { status: "waiting-director", stage: "Summoning the video director…" });
      triggerOrchestrator({ action: "direct-video", gameId })
        .then(() => update(job, { stage: "Waiting for the director to pick the moments…" }))
        .catch((e) => update(job, { status: "queued", stage: "Queued", note: `Couldn't summon a director (${e.message}); using the automatic picks.` }));
      setTimeout(() => {
        if (job.status === "waiting-director") update(job, { status: "queued", stage: "Queued", note: "The director didn't answer in time; using the automatic picks." });
        pump();
      }, DIRECTOR_WAIT_MS);
    } else update(job, { note: "No T3 webhook configured, so no director; using the automatic picks." });
  }
  pump();
  return job;
}

/** The director saved its plan: release the renders that were waiting for it. */
export function directorDone(gameId: string) {
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

function run(job: RenderJob): Promise<void> {
  return new Promise((resolve) => {
    const format = job.formats.length === 2 ? "both" : job.formats[0];
    const args = [SCRIPT, job.gameId, "--format", format];
    if (job.music) args.push("--music", path.join(MUSIC_DIR, job.music));
    update(job, { status: "rendering", stage: "Starting the renderer…", progress: 0 });
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
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
