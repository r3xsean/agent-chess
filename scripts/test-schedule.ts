// Checks round-robin color balance and completeness for 2..10 players.
import { roundRobin } from "../server/schedule";

let ok = true;
for (let n = 2; n <= 10; n++) {
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
  const p = roundRobin(ids, false);
  const w: Record<string, number> = {};
  const b: Record<string, number> = {};
  const seen = new Set<string>();
  for (const x of p) {
    w[x.white] = (w[x.white] ?? 0) + 1;
    b[x.black] = (b[x.black] ?? 0) + 1;
    seen.add([x.white, x.black].sort().join());
  }
  const worst = Math.max(...ids.map((i) => Math.abs((w[i] ?? 0) - (b[i] ?? 0))));
  const complete = seen.size === (n * (n - 1)) / 2 && p.length === seen.size;
  if (worst > 1 || !complete) ok = false;
  console.log(`n=${n} games=${p.length} complete=${complete} maxColorDiff=${worst}`);
}
process.exit(ok ? 0 : 1);
