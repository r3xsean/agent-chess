import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Game } from "../shared/types";
import { speakable } from "../shared/speech";
import { TTS_MODEL, type VoiceManifest } from "../shared/voices";
import { lineSig, videoLines, voiceOf } from "../shared/videoLines";
import { DATA } from "./paths";

/*
 * Recording the replay's spoken lines with ElevenLabs before a render: every quote the director put
 * on screen, its hook, the interview lines and the flashback, each in the speaker's model's voice and
 * with the director's delivery as an audio tag. Clips are cached by their exact input, so re-rendering
 * (or re-planning with the same lines) costs nothing. Nothing is spent without a verified balance.
 */

export const VOICE_DIR = path.join(DATA, "voice");
const API = "https://api.elevenlabs.io/v1";
/**
 * How much speech one plan may have (characters sent, delivery tags and spelled-out notation included).
 * A typical plan is about 2,500. The director's plan is checked against this when it's submitted, so a
 * plan that passed always gets its voices; the recorder's own cap is a backstop with room for interview
 * lines that arrive after the plan.
 */
export const VOICE_BUDGET = 6000;
const MAX_CHARS_PER_GAME = VOICE_BUDGET + 2000;

let savedKey: string | undefined;
/**
 * The key from the environment, or on Windows from the user's saved variables (so a server started
 * before the key was set still finds it).
 */
function apiKey(): string {
  const env = process.env.ELEVENLABS_API_KEY?.trim();
  if (env) return env;
  if (savedKey === undefined) {
    savedKey = "";
    if (process.platform === "win32") {
      const r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "ELEVENLABS_API_KEY"], { encoding: "utf8", timeout: 10_000 });
      savedKey = /ELEVENLABS_API_KEY\s+REG_\w+\s+(\S+)/.exec(r.stdout ?? "")?.[1] ?? "";
    }
  }
  return savedKey;
}
export const voiceAvailable = () => !!apiKey();

/** What gets sent for a line: its delivery as an audio tag, then the words with chess notation spoken out. */
export const spokenText = (text: string, delivery?: string) => `${delivery ? `[${delivery}] ` : ""}${speakable(text)}`;

export async function synthesize(voiceId: string, text: string): Promise<Buffer> {
  const r = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
    // A line takes a few seconds; a hung connection mustn't hold the render queue forever.
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`ElevenLabs ${r.status}: ${detail.slice(0, 300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

/** Whether ffprobe runs (checked before anything is paid for: every clip's length comes from it). */
const probeAvailable = () => spawnSync("ffprobe", ["-version"], { timeout: 10_000 }).status === 0;

/** Seconds of audio in a file. */
export function audioSeconds(file: string): number {
  const p = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", timeout: 20_000 });
  const d = Number((p.stdout ?? "").trim());
  if (p.error || p.status !== 0 || !Number.isFinite(d) || d <= 0) throw new Error(`ffprobe couldn't read the length of ${path.basename(file)}`);
  return d;
}

/** Characters left this month, or null if that can't be verified (then nothing new is recorded). */
async function creditsLeft(): Promise<number | null> {
  try {
    const r = await fetch(`${API}/user/subscription`, { headers: { "xi-api-key": apiKey() }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const s = (await r.json()) as { character_count?: unknown; character_limit?: unknown };
    const left = Number(s.character_limit) - Number(s.character_count);
    return typeof s.character_limit === "number" && typeof s.character_count === "number" && Number.isFinite(left) ? left : null;
  } catch {
    return null;
  }
}

/** Game ids are short lower-case tokens; anything else never names a folder. */
const safeId = (id: string) => /^[a-z0-9_-]{1,64}$/i.test(id);
const manifestFile = (gameId: string) => path.join(VOICE_DIR, gameId, "voice.json");

export function voiceManifest(gameId: string): VoiceManifest {
  const f = safeId(gameId) ? manifestFile(gameId) : "";
  if (!f || !existsSync(f)) return { clips: {} };
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return { clips: {} };
  }
}

/** Written whole or not at all, so a reader never sees half a manifest. */
function writeManifest(gameId: string, m: VoiceManifest) {
  const f = manifestFile(gameId);
  writeFileSync(`${f}.tmp`, JSON.stringify(m, null, 2));
  renameSync(`${f}.tmp`, f);
}

export interface VoiceResult {
  recorded: number;
  cached: number;
  /** Characters sent to ElevenLabs this time. */
  chars: number;
  /** Lines that should have a voice but don't, and why. A render stops rather than go out with them silent. */
  silent: number;
  reason?: string;
}

/**
 * Record (or reuse) every line of the game's plan and publish the manifest for exactly this plan.
 * Lines by a model without a voice (or a human) aren't voiced at all.
 *
 * In order: every cached clip is checked first (an unreadable one is deleted), so the cost of what's
 * really missing is known before anything is spent; the manifest starts with every good cached line;
 * then each missing clip is recorded once, however many lines say it, with the budget checked again
 * before every request. When new recordings can't be paid for (no key, no verified balance, too little
 * left, over the cap) or one fails, the result says how many lines are missing and why; whatever was
 * recorded is kept, so a retry pays only for the rest.
 */
export async function voiceGame(g: Game, onLine?: (done: number, total: number) => void): Promise<VoiceResult> {
  if (!safeId(g.id)) throw new Error("Bad game id.");
  const dir = path.join(VOICE_DIR, g.id);
  const jobs = videoLines(g).flatMap((l) => {
    const voiceId = voiceOf(g, l.color);
    if (!voiceId) return [];
    const spoken = spokenText(l.text, l.delivery);
    const hash = createHash("sha1").update([TTS_MODEL, voiceId, spoken].join("\n")).digest("hex").slice(0, 16);
    return [{ id: l.id, sig: lineSig(voiceId, l), voiceId, spoken, hash, file: path.join(dir, `${hash}.mp3`), url: `/voice/${g.id}/${hash}.mp3` }];
  });
  const result: VoiceResult = { recorded: 0, cached: 0, chars: 0, silent: 0 };
  const manifest: VoiceManifest = { clips: {} };
  mkdirSync(dir, { recursive: true });
  try {
    if (!jobs.length) return result;
    if (!probeAvailable()) return { ...result, silent: jobs.length, reason: "ffprobe isn't available (it measures each recorded line)." };

    // One entry per distinct clip: a hook that's also a moment is one recording.
    const clips = new Map<string, { voiceId: string; spoken: string; file: string; url: string; dur?: number }>();
    for (const j of jobs) clips.set(j.hash, { voiceId: j.voiceId, spoken: j.spoken, file: j.file, url: j.url });
    for (const clip of clips.values()) {
      if (!existsSync(clip.file)) continue;
      try {
        clip.dur = audioSeconds(clip.file);
      } catch {
        // An unreadable clip (a cut-off download): drop it, and count it as missing.
        rmSync(clip.file, { force: true });
      }
    }
    const publish = () => {
      for (const j of jobs) {
        const clip = clips.get(j.hash)!;
        if (clip.dur !== undefined) manifest.clips[j.id] = { url: j.url, dur: Math.round(clip.dur * 1000) / 1000, sig: j.sig };
      }
    };
    publish();
    result.cached = jobs.filter((j) => clips.get(j.hash)!.dur !== undefined).length;

    const missing = [...clips.values()].filter((c) => c.dur === undefined);
    const needed = missing.reduce((n, c) => n + c.spoken.length, 0);
    let allowance = 0;
    if (needed) {
      if (!voiceAvailable()) result.reason = "No ELEVENLABS_API_KEY is set.";
      else if (needed > MAX_CHARS_PER_GAME) result.reason = `This plan needs ${needed} characters of speech, over the per-game cap of ${MAX_CHARS_PER_GAME}.`;
      else {
        const left = await creditsLeft();
        if (left === null) result.reason = "Couldn't confirm the ElevenLabs balance (network, or the key's permissions).";
        else if (left < needed) result.reason = `The voices need ${needed} ElevenLabs characters and ${left} are left this month.`;
        else allowance = Math.min(left, MAX_CHARS_PER_GAME);
      }
    }

    let done = 0;
    for (const clip of allowance ? missing : []) {
      // Never past what was verified, whatever happens along the way.
      if (result.chars + clip.spoken.length > allowance) {
        result.reason ??= "The recording budget ran out partway.";
        break;
      }
      result.chars += clip.spoken.length;
      writeFileSync(clip.file, await synthesize(clip.voiceId, clip.spoken));
      try {
        clip.dur = audioSeconds(clip.file);
        result.recorded++;
      } catch {
        // Paid for but unreadable: not retried in this run (no second charge); the next render records it.
        rmSync(clip.file, { force: true });
        result.reason ??= "A recording came back unreadable; render again to re-record it.";
      }
      publish();
      onLine?.(++done, missing.length);
    }
    return result;
  } finally {
    // Published even after a failure (and empty for a plan with no voiced lines): exactly this plan's
    // good clips, never an earlier plan's.
    writeManifest(g.id, manifest);
    result.silent = jobs.filter((j) => !manifest.clips[j.id]).length;
  }
}