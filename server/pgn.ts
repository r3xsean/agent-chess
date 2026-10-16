import { fullName } from "../shared/naming";
import type { Game } from "../shared/types";
import { scoreToPawns } from "../shared/evalmath";

const NAG: Record<string, string> = { brilliant: " $3", great: " $1", inaccuracy: " $6", mistake: " $2", miss: " $2", blunder: " $4" };
const esc = (s: string) => s.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

/** Sequence of SAN moves starting at a given ply, with move numbers. */
function numbered(sans: string[], firstPly: number): string {
  return sans
    .map((san, i) => {
      const ply = firstPly + i;
      const white = ply % 2 === 1;
      const no = Math.ceil(ply / 2);
      if (white) return `${no}. ${san}`;
      return i === 0 ? `${no}... ${san}` : san;
    })
    .join(" ");
}

export function gameToPgn(g: Game): string {
  const name = (p: Game["white"]) => (p.effort ? `${fullName(p)} (${p.effort})` : fullName(p));
  const date = new Date(g.createdAt).toISOString().slice(0, 10).replace(/-/g, ".");
  const headers: Record<string, string> = {
    Event: g.tournamentId ? `Agent Chess Tournament ${g.tournamentId}` : "Agent Chess Arena",
    Site: "Agent Chess (local)",
    Date: date,
    White: name(g.white),
    Black: name(g.black),
    Result: g.result ?? "*",
  };
  if (g.opening) {
    headers.ECO = g.opening.eco;
    headers.Opening = g.opening.name;
  }
  if (g.termination) headers.Termination = g.termination;
  if (g.review?.w.accuracy != null) headers.WhiteAccuracy = String(g.review.w.accuracy);
  if (g.review?.b.accuracy != null) headers.BlackAccuracy = String(g.review.b.accuracy);
  const head = Object.entries(headers)
    .map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`)
    .join("\n");

  const body: string[] = [];
  for (const m of g.moves) {
    const no = Math.ceil(m.ply / 2);
    // Every move carries a comment, so Black's moves always need their own number.
    const prefix = m.color === "w" ? `${no}. ` : `${no}... `;
    const real = m.analysis && !m.analysis.unavailable ? m.analysis : undefined;
    const notes: string[] = [];
    if (real) notes.push(`[%eval ${scoreToPawns(real.evalAfter, 99).toFixed(2)}] ${real.classification}`);
    if (m.commentary) notes.push(`(self-eval ${m.selfEvalRaw}) ${esc(m.commentary)}`);
    if (m.illegalAttempts.length) notes.push(`Illegal attempts: ${m.illegalAttempts.join(", ")}`);
    // Lines that add nothing beyond the played move go into the comment; the rest become variations.
    const variations: string[] = [];
    for (const l of m.lines) {
      const note = esc(l.note) + (l.brokenAt ? ` [line breaks: ${l.brokenAt} illegal]` : "");
      if (l.san.length <= 1 && (l.san[0] ?? m.san) === m.san) {
        notes.push(`| line: ${esc(l.raw)}${note ? ` ${note}` : ""}`);
        continue;
      }
      variations.push(`(${numbered(l.san, m.ply)}${note ? ` {${note}}` : ""})`);
    }
    body.push([`${prefix}${m.san}${real ? NAG[real.classification] ?? "" : ""}`, `{${notes.join(" ")}}`, ...variations].join(" "));
  }
  body.push(g.result ?? "*");
  return `${head}\n\n${body.join(" ")}\n`;
}
