// The website's performance in headless Chrome, over a copy of the real games on a spare server: how much script
// each page loads, how soon it shows its content, and how much CPU it burns sitting idle (a finished game, a live
// one). Builds the site into a temp dir first (never dist/, which the live server serves).
//   node scripts/bench-browser.mjs [--dist <built site>] [--throttle 4]
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { copyLiveData, startSpare } from "./spare.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : def);
const throttle = Number(arg("throttle", 4));

let dist = arg("dist");
if (!dist) {
  dist = mkdtempSync(path.join(tmpdir(), "agent-chess-dist-"));
  const b = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dist, "--emptyOutDir"], { cwd: ROOT, encoding: "utf8" });
  if (b.status !== 0) throw new Error(b.stderr || b.stdout);
}
const spare = await startSpare({ prepare: copyLiveData, env: { AGENT_CHESS_DIST: dist } });
const H = { "content-type": "application/json", "x-admin-token": spare.token };
const post = async (p, body) => {
  const text = await (await fetch(spare.url + p, { method: "POST", headers: H, body: JSON.stringify(body) })).text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// A live game: created and taken through its interviews, so it's being played (its clock running).
const created = await post("/api/games", { white: { model: "claude-opus-5-5", effort: "high" }, black: { model: "gpt-6-astra", effort: "high" } });
const keys = Object.fromEntries(created.launch.tasks.map((t) => [t.role, /--key (\S+)/.exec(t.prompt)?.[1]]));
for (const k of [keys.white ?? keys.w, keys.black ?? keys.b]) await post("/api/agent/interview", { key: k, text: "Ready.", noWait: true });
await new Promise((r) => setTimeout(r, 1500));
const lobby = await (await fetch(spare.url + "/api/lobby")).json();
const finished = lobby.games.filter((g) => g.phase === "finished").sort((a, b) => b.plies - a.plies)[0].id;

const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-first-run"] });

async function measure(name, hash, ready, idleToo = true) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await cdp.send("Performance.enable");
  const types = new Map();
  let js = 0;
  cdp.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
  cdp.on("Network.loadingFinished", (e) => types.get(e.requestId) === "Script" && (js += e.encodedDataLength));
  const t0 = Date.now();
  await page.goto(spare.url + "/" + hash, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(ready, { timeout: 60_000 });
  const shown = Date.now() - t0;
  const jsAtContent = js;
  await new Promise((r) => setTimeout(r, 2000));
  const lcp = await page.evaluate(() => new Promise((r) => new PerformanceObserver((l) => r(l.getEntries().at(-1)?.startTime ?? null)).observe({ type: "largest-contentful-paint", buffered: true })));
  if (!idleToo) {
    console.log(`${name.padEnd(16)} JS before content ${(jsAtContent / 1024).toFixed(0).padStart(4)} KB  content ${String(shown).padStart(5)} ms  LCP ${String(Math.round(lcp ?? 0)).padStart(5)} ms`);
    return void (await page.close());
  }
  const m = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
  const a = await m();
  await new Promise((r) => setTimeout(r, 10_000));
  const b = await m();
  const idle = (k) => ((b[k] - a[k]) * 1000).toFixed(0);
  console.log(
    `${name.padEnd(16)} JS before content ${(jsAtContent / 1024).toFixed(0).padStart(4)} KB  content ${String(shown).padStart(5)} ms  LCP ${String(Math.round(lcp ?? 0)).padStart(5)} ms  idle 10 s: script ${idle("ScriptDuration").padStart(4)} ms, task ${idle("TaskDuration").padStart(4)} ms, layout ${idle("LayoutDuration").padStart(3)} ms`,
  );
  await page.close();
}

console.log(`CPU throttled ${throttle}×; site from ${dist}`);
// The first page a browser opens pays for its fonts; everything after is warm.
await measure("(warm-up)", "#/", ".games-table tbody tr", false);
await measure("lobby", "#/", ".games-table tbody tr");
await measure("finished game", `#/game/${finished}`, ".cg-wrap piece");
await measure("live game", `#/game/${created.game.id}`, ".cg-wrap piece");
await measure("agents", "#/agents", "table");
for (const [n, h, s] of [["lobby again", "#/", ".games-table tbody tr"], ["finished again", `#/game/${finished}`, ".cg-wrap piece"]]) await measure(n, h, s, false);
await browser.close();
await spare.stop();
