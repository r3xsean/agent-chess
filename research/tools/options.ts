import { readFileSync } from "node:fs";
import { lineOptions } from "../../shared/engineLine";
const g = JSON.parse(readFileSync("data/games/g0x3ixb84e.json", "utf8"));
g.moves.forEach((m: any, i: number) => { for (const l of lineOptions(g, i)) console.log(`ply ${m.ply} ${m.san} ${l.kind}: ${l.moves.map((x) => x.san).join(" ")} -> ${l.fact}`); });
