// Render a game replay to MP4 for YouTube (16:9) and/or TikTok (9:16).
//
//   node scripts/render-video.mjs <gameId> [--format landscape|portrait|both] [--fps 30]
//        [--music file.mp3] [--sfx off] [--out dir] [--stills 12,40.5] [--thoughts off] [--audio-only]
//
// The server must be running with a fresh build (dist/). The video page at #/video/<id> lays out
// every frame as a pure function of time; this script seeks it frame by frame in headless Chrome and
// pipes the screenshots into ffmpeg. Then it builds the sound: effects from vendor/sfx/ timed to the
// timeline (see sfxCues), over a music bed that dips under them. With no --music it uses the first
// audio file in vendor/music/, if any. --audio-only redoes just the sound of an existing render.
// --stills writes PNGs at the given seconds instead of a video (for checking the layout).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const SERVER = process.env.CHESS_SERVER ?? "http://127.0.0.1:5170";
const SIZES = { landscape: [1920, 1080], portrait: [1080, 1920] };
const RATE = 48_000;

const args = process.argv.slice(2);
const gameId = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
if (!gameId) {
  console.error("usage: node scripts/render-video.mjs <gameId> [--format landscape|portrait|both] [--fps 30] [--music file] [--sfx off] [--out dir] [--stills 1,2] [--audio-only]");
  process.exit(1);
}
const fps = Number(opt("fps", 30));
const formats = opt("format", "both") === "both" ? ["landscape", "portrait"] : [opt("format")];
const outDir = resolve(opt("out", "data/videos"));
const stills = opt("stills", "")
  .split(",")
  .filter(Boolean)
  .map(Number);
const audioOnly = flag("audio-only");
mkdirSync(outDir, { recursive: true });

function findMusic() {
  const given = opt("music");
  if (given) {
    if (!existsSync(given)) throw new Error(`No such music file: ${given}`);
    return resolve(given);
  }
  const dir = resolve("vendor/music");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(n)).sort()[0];
  return f ? join(dir, f) : null;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found; set CHROME_PATH.");
  return found;
}

function run(cmd, argv, input) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: [input ? "pipe" : "ignore", "pipe", "inherit"] });
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("close", (code) => (code === 0 ? res(Buffer.concat(chunks)) : rej(new Error(`${cmd} exited with ${code}`))));
  });
}

/* ------------------------------ sound effects ------------------------------ */

const SFX_DIR = resolve("vendor/sfx");
const STINGS = { brilliant: ["brilliant", 1], great: ["great", 0.9], blunder: ["blunder", 1], mistake: ["mistake", 0.9], miss: ["mistake", 0.9], inaccuracy: ["inaccuracy", 0.7] };

/**
 * When each sound plays. Every move gets a quiet board sound; only the director's key moments get
 * the loud ones (verdict stings), plus the thinking pop, illegal attempts and the scene changes.
 */
function sfxCues(scenes, g) {
  const cues = [];
  const at = (t, ev, gain) => cues.push({ t, ev, gain });
  for (const s of scenes) {
    if (s.kind === "versus") at(s.start + 0.25, "versus", 0.8);
    else if (s.kind === "interview" || s.kind === "end") at(s.start, "transition", 0.35);
    else if (s.kind === "think") at(s.start + 0.05, "think", 0.7);
    else if (s.kind === "illegal") at(s.start + 0.05, "illegal", 0.8);
    else if (s.kind === "draw") at(s.start + 0.05, "draw", 0.8);
    else if (s.kind === "resign") at(s.start + 0.1, "resign", 0.9);
    else if (s.kind === "result") {
      at(s.start, "transition", 0.35);
      if (g.result !== "1/2-1/2") at(s.start + 0.3, "victory", 0.8);
    } else if (s.kind === "move") {
      const m = g.moves[s.i];
      const land = s.start + s.anim - 0.02;
      const gain = s.key ? 0.9 : 0.55;
      const castle = m.san.startsWith("O-O");
      at(land, m.san.includes("x") ? "capture" : "move", gain);
      if (castle) at(land + 0.1, "move", gain * 0.8);
      if (m.san.includes("=")) at(land + 0.05, "promotion", gain);
      if (m.san.includes("#")) at(land + 0.05, "checkmate", 1);
      else if (m.san.includes("+")) at(land, "check", gain * 0.8);
      const sting = s.key && STINGS[m.analysis?.classification];
      if (sting) at(land + 0.1, sting[0], sting[1]);
    }
  }
  return cues;
}

const decoded = new Map();
async function decode(file) {
  if (!decoded.has(file)) {
    const buf = await run("ffmpeg", ["-v", "error", "-i", file, "-f", "f32le", "-ac", "2", "-ar", String(RATE), "-"]);
    decoded.set(file, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return decoded.get(file);
}

/** Mix every cue into one stereo track and write it as a 16-bit WAV. Variants of a sound rotate. */
async function buildSfxTrack(cues, duration, file) {
  const files = existsSync(SFX_DIR) ? readdirSync(SFX_DIR).filter((n) => /\.(ogg|wav|mp3)$/i.test(n)).sort() : [];
  const variants = (ev) => files.filter((n) => n.startsWith(`${ev}_`));
  const used = {};
  const mix = new Float32Array(Math.ceil((duration + 2) * RATE) * 2);
  let placed = 0;
  for (const c of cues) {
    const list = variants(c.ev);
    if (!list.length) continue;
    const name = list[(used[c.ev] = (used[c.ev] ?? -1) + 1) % list.length];
    const pcm = await decode(join(SFX_DIR, name));
    const off = Math.max(0, Math.round(c.t * RATE)) * 2;
    for (let i = 0; i < pcm.length && off + i < mix.length; i++) mix[off + i] += pcm[i] * c.gain;
    placed++;
  }
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0.95 ? 0.95 / peak : 1;
  const data = Buffer.alloc(mix.length * 2);
  for (let i = 0; i < mix.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[i] * scale)) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
  return placed;
}

/** Put the sound under a silent video: effects, plus music that ducks whenever an effect plays. */
async function mux(video, out, duration, sfx, music) {
  const inputs = ["-i", video];
  if (sfx) inputs.push("-i", sfx);
  if (music) inputs.push("-stream_loop", "-1", "-i", music);
  const m = sfx ? 2 : 1;
  const bed = `[${m}:a]volume=0.55,afade=t=in:d=2,afade=t=out:st=${Math.max(0, duration - 4)}:d=4`;
  let filter = null;
  if (sfx && music) filter = `[1:a]asplit=2[s1][s2];${bed}[m];[m][s1]sidechaincompress=threshold=0.04:ratio=5:attack=5:release=350[md];[md][s2]amix=inputs=2:normalize=0:duration=first[a]`;
  else if (music) filter = `${bed}[a]`;
  else if (sfx) filter = `[1:a]anull[a]`;
  const audio = filter ? ["-filter_complex", filter, "-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : [];
  await run("ffmpeg", ["-y", "-v", "error", ...inputs, "-map", "0:v", ...audio, "-c:v", "copy", "-t", duration.toFixed(3), "-movflags", "+faststart", out]);
}

/* ------------------------------ render ------------------------------ */

const music = stills.length ? null : findMusic();
const game = await (await fetch(`${SERVER}/api/games/${gameId}`)).json();
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ["--hide-scrollbars", "--force-device-scale-factor=1", "--font-render-hinting=none"],
});

try {
  for (const format of formats) {
    const [width, height] = SIZES[format];
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`${SERVER}/#/video/${gameId}?format=${format}&render=1&thoughts=${opt("thoughts", "on")}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__video?.ready, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    const duration = await page.evaluate(() => window.__video.duration);
    const scenes = await page.evaluate(() => window.__video.scenes);
    const cdp = await page.createCDPSession();
    const shot = async (type) =>
      Buffer.from((await cdp.send("Page.captureScreenshot", { format: type, quality: type === "jpeg" ? 92 : undefined, optimizeForSpeed: true })).data, "base64");

    if (stills.length) {
      for (const t of stills) {
        await page.evaluate((x) => window.__video.seek(x), t);
        await page.evaluate(() => window.__video.settle());
        const file = join(outDir, `${gameId}-${format}-${t}s.png`);
        writeFileSync(file, await shot("png"));
        console.log(file);
      }
      await page.close();
      continue;
    }

    const out = join(outDir, `${gameId}-${format === "landscape" ? "youtube" : "tiktok"}.mp4`);
    const silent = `${out}.video.mp4`;
    const started = Date.now();
    let note = "";

    if (audioOnly) {
      if (!existsSync(out)) throw new Error(`--audio-only needs an existing render: ${out}`);
      copyFileSync(out, silent);
    } else {
      const ff = spawn(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(fps), "-t", duration.toFixed(3), silent],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      const done = new Promise((res, rej) => ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`)))));
      const write = (buf) => (ff.stdin.write(buf) ? Promise.resolve() : new Promise((r) => ff.stdin.once("drain", r)));

      const frames = Math.ceil(duration * fps);
      let lastKey = null;
      let lastBuf = null;
      let captured = 0;
      for (let f = 0; f < frames; f++) {
        const key = await page.evaluate((x) => window.__video.seek(x), f / fps);
        // Holds don't change the picture: reuse the previous frame instead of capturing again.
        if (key !== lastKey) {
          await page.evaluate(() => window.__video.settle());
          lastBuf = await shot("jpeg");
          lastKey = key;
          captured++;
        }
        await write(lastBuf);
        if (f % (fps * 10) === 0) {
          const pct = ((f / frames) * 100).toFixed(0);
          process.stdout.write(`\r${format}: ${pct}%  (${(f / fps).toFixed(0)}s of ${duration.toFixed(0)}s, ${((Date.now() - started) / 1000).toFixed(0)}s elapsed)   `);
        }
      }
      ff.stdin.end();
      await done;
      note = `${frames} frames, ${captured} captured, `;
    }
    await page.close();

    let sfx = null;
    if (opt("sfx", "on") !== "off") {
      sfx = `${out}.sfx.wav`;
      const placed = await buildSfxTrack(sfxCues(scenes, game), duration, sfx);
      if (!placed) sfx = null;
      note += `${placed} sound effects, `;
    }
    if (sfx || music) await mux(silent, out, duration, sfx, music);
    else renameSync(silent, out);
    for (const f of [silent, `${out}.sfx.wav`]) rmSync(f, { force: true });
    console.log(`\r${format}: ${out}  (${duration.toFixed(1)}s, ${note}${((Date.now() - started) / 1000).toFixed(0)}s)${music ? "" : "  [no music]"}`);
  }
} finally {
  await browser.close();
}
