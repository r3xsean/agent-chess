// Classify every move of some famous games through /api/explore, to sanity-check Brilliant/Great.
// Usage: node scripts/test-brilliant.mjs   (server must be running)
import { Chess } from "chess.js";

const SERVER = "http://127.0.0.1:5170";
const GAMES = {
  "Morphy – Opera Game (1858)":
    "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#",
  "Légal trap": "e4 e5 Nf3 d6 Bc4 Bg4 Nc3 g6 Nxe5 Bxd1 Bxf7+ Ke7 Nd5#",
};

async function explore(body) {
  for (;;) {
    const r = await fetch(`${SERVER}/api/explore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = await r.json();
    if (!a.superseded) return a;
  }
}

for (const [name, line] of Object.entries(GAMES)) {
  console.log(`\n== ${name}`);
  const c = new Chess();
  let prev;
  let bookSoFar = true;
  const out = [];
  for (const san of line.split(" ")) {
    const mv = c.move(san);
    const a = await explore({
      fen: mv.after,
      move: { fenBefore: mv.before, uci: mv.from + mv.to + (mv.promotion ?? ""), bookSoFar, prev: prev && { to: prev.to, san: prev.san, winBefore: prev.cls?.winBefore, winAfter: prev.cls?.winAfter } },
    });
    const cls = a.move?.classification ?? "?";
    if (cls !== "book") bookSoFar = false;
    const no = Math.ceil(c.history().length / 2) + (mv.color === "w" ? ". " : "... ");
    out.push(`${no}${san} ${cls}${a.move?.bestSan && a.move.bestSan !== san ? ` (best ${a.move.bestSan})` : ""}`);
    prev = { to: mv.to, san, cls: a.move };
  }
  console.log(out.join("\n"));
}
