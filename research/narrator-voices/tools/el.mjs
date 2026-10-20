// Helper for the narrator-voice audition. Never prints the API key.
// Usage:
//   node el.mjs balance
//   node el.mjs voices            -> writes ../voices.json (excluding player voices)
//   node el.mjs synth <picks.json> -> synthesizes each pick to ../<name>.mp3
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.elevenlabs.io/v1";
const EXCLUDE = new Set([
  "JBFqnCBsd6RMkjVDRZzb", "pFZP5JQG7iQjIQuC4Bku", "cjVigY5qzO86Huf0OWal",
  "FGY2WhTYpPnrIDTdsKH5", "SOYHLrjzK2X1ezoPC6cr", "N2lVS1w4EtoT3dr4eOWO",
  "IKne3meq5aSn9XLyUdCD",
]);
export const SAMPLE =
  "[wry] Fable's calling this calm. Plus zero point four. But look at the Black king's house: the knight that stood guard on f6 has just wandered off, and the front door on h7 is wide open. [building] So the bishop walks straight in. It's not there to survive. It's there to drag the king out of bed. [excited] Cornered in the hallway. Checkmate.";

function key() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const out = execSync("reg query HKCU\\Environment /v ELEVENLABS_API_KEY", { encoding: "utf8", windowsHide: true });
  const m = out.match(/ELEVENLABS_API_KEY\s+REG_\w+\s+(\S+)/);
  if (!m) throw new Error("ELEVENLABS_API_KEY not found");
  return m[1].trim();
}
const K = key();

async function balance() {
  const r = await fetch(`${BASE}/user/subscription`, { headers: { "xi-api-key": K } });
  if (!r.ok) throw new Error(`subscription ${r.status}: ${await r.text()}`);
  const s = await r.json();
  return { limit: s.character_limit, used: s.character_count, left: s.character_limit - s.character_count, tier: s.tier };
}

const cmd = process.argv[2];
if (cmd === "balance") {
  console.log(JSON.stringify({ ...(await balance()), sampleChars: SAMPLE.length }));
} else if (cmd === "voices") {
  const r = await fetch(`${BASE}/voices`, { headers: { "xi-api-key": K } });
  if (!r.ok) throw new Error(`voices ${r.status}: ${await r.text()}`);
  const { voices } = await r.json();
  const keep = voices
    .filter((v) => !EXCLUDE.has(v.voice_id))
    .map((v) => ({ id: v.voice_id, name: v.name, category: v.category, labels: v.labels, description: v.description }));
  writeFileSync(join(OUT, "tools", "voices.json"), JSON.stringify(keep, null, 2));
  for (const v of keep) console.log(`${v.id} | ${v.name} | ${v.category} | ${JSON.stringify(v.labels)} | ${(v.description || "").slice(0, 120)}`);
  console.log(`total ${voices.length}, kept ${keep.length}`);
} else if (cmd === "synth") {
  const picks = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const before = await balance();
  const results = [];
  for (const p of picks) {
    let model = "eleven_v4";
    let note = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${BASE}/text-to-speech/${p.id}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": K, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: SAMPLE, model_id: model }),
      });
      if (r.ok) {
        writeFileSync(join(OUT, `${p.file}.mp3`), Buffer.from(await r.arrayBuffer()));
        results.push({ ...p, model, note });
        console.log(`ok ${p.name} (${model})`);
        break;
      }
      const err = (await r.text()).slice(0, 300);
      console.log(`fail ${p.name} ${model} ${r.status}: ${err}`);
      if (attempt === 0 && model === "eleven_v4") { note = `eleven_v4 refused (${r.status}); used eleven_v3`; model = "eleven_v3"; }
      else { results.push({ ...p, model: null, note: `failed: ${r.status}` }); break; }
    }
  }
  const after = await balance();
  writeFileSync(join(OUT, "tools", "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ spent: after.used - before.used, left: after.left }));
} else {
  console.log("usage: balance | voices | synth <picks.json>");
}
