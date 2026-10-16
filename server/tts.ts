import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./paths";

const PIPER_PORT = Number(process.env.PIPER_PORT ?? 5171);
const VOICE = process.env.PIPER_VOICE ?? "en_US-ryan-high";
let proc: ChildProcess | null = null;
let ready = false;

export function startTts() {
  const py = path.join(ROOT, "vendor", "piper-venv", "Scripts", "python.exe");
  const voices = path.join(ROOT, "vendor", "voices");
  if (!existsSync(py) || !existsSync(path.join(voices, `${VOICE}.onnx`))) {
    console.warn("[tts] Piper not installed; broadcaster will be text-only");
    return;
  }
  proc = spawn(py, ["-m", "piper.http_server", "-m", VOICE, "--data-dir", voices, "--port", String(PIPER_PORT)], {
    stdio: "ignore",
    windowsHide: true,
  });
  proc.on("error", (e) => {
    // Spawn failures must not take the server down; the broadcast just goes text-only.
    console.warn(`[tts] Piper failed to start (${e.message}); broadcaster will be text-only`);
    ready = false;
    proc = null;
  });
  proc.on("exit", () => {
    ready = false;
    proc = null;
  });
  const poll = async (tries: number) => {
    try {
      const r = await fetch(`http://127.0.0.1:${PIPER_PORT}/voices`);
      if (r.ok) {
        ready = true;
        console.log(`[tts] Piper ready (${VOICE})`);
        return;
      }
    } catch {}
    if (tries > 0) setTimeout(() => poll(tries - 1), 1000);
    else console.warn("[tts] Piper did not start");
  };
  poll(60);
}

export function stopTts() {
  proc?.kill();
}

const PIECE: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };

/** Turn SAN like "Nxe5+" into "knight takes e5, check" so TTS reads it naturally. */
export function speakable(text: string): string {
  return text
    .replace(/\bO-O-O\b|\b0-0-0\b/g, "castles queenside")
    .replace(/\bO-O\b|\b0-0\b/g, "castles kingside")
    .replace(/\b(\d+)\.(\.\.)?(?!\d)\s*/g, "")
    .replace(/\b([KQRBN])?([a-h])?([1-8])?(x)?([a-h][1-8])(=([QRBN]))?([+#])?(?=[\s,.!?;:)]|$)/g, (m, piece, ff, fr, cap, to, _p, promo, chk) => {
      if (!piece && !cap && !promo && !chk && !ff) return m; // plain square like "e5": leave as is
      const words: string[] = [];
      if (piece) words.push(PIECE[piece]);
      else if (ff) words.push(ff);
      if (piece && (ff || fr)) words.push(`${ff ?? ""}${fr ?? ""}`);
      if (cap) words.push("takes");
      words.push(to);
      if (promo) words.push(`promotes to ${PIECE[promo]}`);
      if (chk === "+") words.push("check");
      if (chk === "#") words.push("checkmate");
      return words.join(" ");
    })
    .replace(/[*_#`]/g, "")
    .replace(/\+(\d)/g, "plus $1")
    .replace(/-(\d+\.\d)/g, "minus $1");
}

export async function synthesize(text: string): Promise<Buffer | null> {
  if (!ready) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${PIPER_PORT}/synthesize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: speakable(text) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
