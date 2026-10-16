// Print a compact status of a game: node scripts/status.mjs <gameId>
const id = process.argv[2];
const g = await (await fetch(`http://127.0.0.1:5170/api/games/${id}`)).json();
console.log(`${g.id} phase=${g.phase} result=${g.result ?? "-"} ${g.termination ?? ""} moves=${g.moves.length} opening=${g.opening?.name ?? "-"}`);
for (const m of g.moves.slice(-8)) {
  console.log(
    `${m.ply}. ${m.san} [${m.analysis?.classification ?? "…"}] self=${m.selfEvalRaw} lines=${m.lines.length}${m.lines.some((l) => l.brokenAt) ? "(broken)" : ""} illegal=${m.illegalAttempts.join(",") || "-"} ${Math.round(m.thinkMs / 1000)}s | ${m.commentary.slice(0, 110).replace(/\n/g, " ")}`,
  );
}
console.log("pending illegal:", JSON.stringify(g.pendingIllegal));
for (const l of g.broadcast.slice(-3)) console.log(`BC#${l.id}${l.audio ? "🔊" : ""}: ${l.text.slice(0, 160)}`);
if (g.review) console.log("review:", JSON.stringify(g.review));
