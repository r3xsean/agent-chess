// Performance numbers over a copy of the real games, on a spare server (never the live one, never data/ itself):
// how long the server takes to answer after starting, and how long and how big the main API answers are.
//   node scripts/bench.mjs [--runs 5]
import { copyLiveData, startSpare } from "./spare.mjs";

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 5;

const t0 = performance.now();
const spare = await startSpare({ prepare: copyLiveData });
console.log(`startup to first answer: ${(performance.now() - t0).toFixed(0)} ms`);

const get = async (p) => {
  const s = performance.now();
  const r = await fetch(spare.url + p);
  const b = await r.arrayBuffer();
  return { ms: performance.now() - s, bytes: b.byteLength };
};
const lobby = await (await fetch(spare.url + "/api/lobby")).json();
const biggest = lobby.games.slice().sort((a, b) => b.plies - a.plies)[0]?.id;
const model = (await (await fetch(spare.url + "/api/analytics")).json())[0]?.model;
const paths = [
  "/",
  "/api/lobby",
  "/api/analytics",
  "/api/analytics?scope=rated",
  ...(model ? [`/api/analytics/${encodeURIComponent(model)}`] : []),
  "/api/analytics/openings",
  "/api/experiments",
  "/api/experiments?scope=all",
  ...(biggest ? [`/api/games/${biggest}`, `/api/games/${biggest}/rivalry`] : []),
  ...(lobby.players[0] ? [`/api/players/${encodeURIComponent(lobby.players[0].id)}`] : []),
];
for (const p of paths) {
  const all = [];
  for (let i = 0; i < runs; i++) all.push(await get(p));
  const warm = all.slice(1).map((x) => x.ms).sort((a, b) => a - b);
  console.log(`${p.padEnd(48)} first ${all[0].ms.toFixed(1).padStart(7)} ms  warm p50 ${(warm[Math.floor(warm.length / 2)] ?? all[0].ms).toFixed(1).padStart(6)} ms  ${(all[0].bytes / 1024).toFixed(0).padStart(5)} KB`);
}
await spare.stop();
