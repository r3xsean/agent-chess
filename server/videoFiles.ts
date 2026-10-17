import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { Game } from "../shared/types";
import { sideName } from "../shared/naming";
import { DATA } from "./paths";
import { games } from "./store";

/*
 * Where a game's videos live: one folder per game, named so it reads in Explorer
 * ("2026-10-17 GPT-6 Astra vs Opus 5.5 (g7lto2a464)"). The game id in brackets is what finds the folder
 * again, so the rest of the name can change without losing anything. The files inside keep the id too
 * ("g7lto2a464-youtube.mp4"), so one dragged out of its folder or uploaded still says which game it is.
 * scripts/render-video.mjs writes the same file names (FILES below): keep the two in step.
 */

export const VIDEO_DIR = path.join(DATA, "videos");

/** The files a render makes, by what they are: each is "<id>-<this>". */
export const FILES = {
  youtube: "youtube.mp4",
  tiktok: "tiktok.mp4",
  youtubeSubtitles: "youtube.srt",
  tiktokSubtitles: "tiktok.srt",
  uploadText: "youtube.txt",
  thumbnail: "thumb.png",
  tiktokCover: "tiktok-cover.png",
} as const;
export type VideoFile = keyof typeof FILES;
const fileName = (gameId: string, f: VideoFile) => `${gameId}-${FILES[f]}`;

/** Characters Windows (or a URL) won't have in a folder name. */
const unsafe = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");

/** "2026-10-17 GPT-6 Astra vs Opus 5.5 (g7lto2a464)": the day it was played, the players, the id. */
export function folderName(g: Game): string {
  const d = new Date(g.createdAt);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${day} ${unsafe(`${sideName(g, "w")} vs ${sideName(g, "b")}`)} (${g.id})`;
}

/** The folder already made for a game, found by the id at the end of its name. */
function existingFolder(gameId: string): string | null {
  if (!existsSync(VIDEO_DIR)) return null;
  const tail = `(${gameId})`;
  return readdirSync(VIDEO_DIR, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.endsWith(tail))?.name ?? null;
}

/** A game's folder name: the one it has, or the one it will get. */
export function gameFolder(gameId: string): string {
  const found = existingFolder(gameId);
  if (found) return found;
  const g = games.get(gameId);
  return g ? folderName(g) : `(${gameId})`;
}

/** A game's video folder, as a full path (made on request). */
export function gameVideoDir(gameId: string, make = false): string {
  const dir = path.join(VIDEO_DIR, gameFolder(gameId));
  if (make) mkdirSync(dir, { recursive: true });
  return dir;
}

export const videoPath = (gameId: string, f: VideoFile) => path.join(gameVideoDir(gameId), fileName(gameId, f));
export const videoUrl = (gameId: string, f: VideoFile) => `/videos/${encodeURIComponent(gameFolder(gameId))}/${fileName(gameId, f)}`;

/**
 * Move videos from the old flat layout (all games' files side by side in data/videos) into each game's
 * folder, names unchanged. Runs at startup and is safe to run again: only a render's own files move (an
 * unfinished render's leftovers and anything else stay put), and a file never replaces one already there.
 */
export function migrateFlatVideos(): number {
  if (!existsSync(VIDEO_DIR)) return 0;
  const ours = new Set<string>(Object.values(FILES).flatMap((f) => (f.endsWith(".mp4") ? [f, `${f}.timing`] : [f])));
  let moved = 0;
  for (const e of readdirSync(VIDEO_DIR, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^(g[0-9a-z]+)-(.+)$/);
    // A game this server doesn't know (deleted, say) would get a nameless folder: its files stay where they are.
    if (!m || !ours.has(m[2]) || !games.has(m[1])) continue;
    const target = path.join(gameVideoDir(m[1], true), e.name);
    if (existsSync(target)) continue;
    renameSync(path.join(VIDEO_DIR, e.name), target);
    moved++;
  }
  return moved;
}
