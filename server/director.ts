import type { Color, Game, VideoMoment, VideoPlan } from "../shared/types";
import { humanSide, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { describePlayer, pvSan } from "./briefing";
import { variantOf } from "../shared/rules";
import { ActionError } from "./game";

/*
 * After the game the broadcaster turns video director: it reads the whole game and picks the
 * moments the replay video should slow down for, plus the best line of each interview.
 */

const colorName = (c: Color) => (c === "w" ? "White" : "Black");
const moveNo = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"}`;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** A finished game still waiting for its video plan. */
export const needsDirection = (g: Game) => !g.video && !!g.review && g.moves.length > 0;

export function directorBrief(g: Game): string {
  const name = (c: Color) => sideName(g, c);
  const human = humanSide(g);
  const out: string[] = [
    "VIDEO DIRECTOR — the broadcast is over. One last job: plan the replay video of this game.",
    "",
    "The game is cut into a YouTube video (every move) and a TikTok video (quiet moves fly by in under a second). Both slow down only for the moments you pick: the board holds on the move, its engine verdict and your broadcast line, and if you choose, a quote from the mover's own commentary appears as a speech bubble before they play it.",
    "",
    "Pick the moments a viewer must not miss: the turning points, the moves the players misjudged (compare their self-eval with the engine), the traps, sacrifices, illegal-move attempts, the decisive blunder and its punishment, the finish. The engine's labels are a guide, not the answer — a move rated 'good' can be the real story (say, the move that allowed the trick), and a technical inaccuracy can be dull. Skip routine theory.",
    "",
    "Also pick the single best line from each interview for the short cut: funny, bold, or what came true (or didn't).",
    "",
    `Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.`,
    ...(human ? [`${name(human)} is a human: their moves come without commentary, so moments on their moves have no quote (the board, the verdict and the agent's reaction tell those).`] : []),
    `Opening: ${g.opening?.name ?? "unknown"}. Result: ${g.result} (${g.termination}).`,
    g.review ? `Accuracy: White ${g.review.w.accuracy ?? "—"}, Black ${g.review.b.accuracy ?? "—"}.` : "",
    "",
    "## Interviews",
  ];
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const iv = g.interviews[when][c];
      if (iv) out.push(`${when === "pre" ? "Pre-game" : "Post-game"}, ${name(c)} (${colorName(c)}): ${iv.text}`, "");
    }

  out.push("## The game, move by move", "(eval is White's view after the move; self-eval is what the mover believed)", "");
  for (const m of g.moves) {
    const a = m.analysis;
    const verdict = a ? `${a.classification}${a.bestSan && a.bestSan !== m.san ? `, engine preferred ${a.bestSan} (${pvSan(m.fenBefore, g.analysis[m.fenBefore]?.pv, 6, variantOf(g))})` : ""}` : "unrated";
    out.push(`ply ${m.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict}; eval ${formatScore(a?.evalAfter)}; self-eval ${m.selfEvalRaw || "—"}`);
    if (m.illegalAttempts.length) out.push(`  tried illegal moves first: ${m.illegalAttempts.join(", ")}`);
    if (m.offeredDraw) out.push(`  offered a draw with this move`);
    if (m.commentary.trim()) out.push(`  commentary: ${m.commentary.trim()}`);
    for (const b of g.broadcast.filter((l) => l.ply === m.ply && l.ts <= (g.endedAt ?? Infinity))) out.push(`  you said: ${b.text}`);
  }

  out.push(
    "",
    "## Your answer",
    "Write a JSON file in your working folder and submit it with `direct <file.json>`. Shape:",
    "```json",
    JSON.stringify(
      {
        moments: [{ ply: 54, why: "Black thinks g6 is safe, but the c2 rook is now trapped", importance: 3, quote: "…exact sentences from that move's commentary…" }],
        interviewLines: { pre: { w: "…", b: "…" }, post: { w: "…", b: "…" } },
      },
      null,
      2,
    ),
    "```",
    "- moments: 6–14 of them, in game order. `ply` is the ply number shown above.",
    "- importance: 3 = a headline moment, 2 = strong (both videos), 1 = minor (YouTube only). Give 4–7 moments importance 2 or 3.",
    "- why: one sentence on why it matters (kept for the editor, not shown on screen).",
    "- quote: what the mover said about this move, shown before they play it — quoted exactly from that move's `commentary:` above, a whole sentence or a few in a row, at most 60 words. Viewers love hearing the players explain themselves, so give EVERY importance 2–3 moment a quote, choosing the sentences that best show their idea or their misjudgment. Leave it out only when the commentary says nothing about the move.",
    "- interviewLines: for each interview, quote one to three consecutive sentences exactly, at most 40 words.",
    "If the server rejects the plan it says why; fix it and submit again. Then run `bc-wait`.",
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** Whitespace- and quote-insensitive form, so an excerpt matches its source despite line wrapping or smart quotes. */
const norm = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const isExcerpt = (excerpt: string, source: string) => norm(source).includes(norm(excerpt).replace(/^[.…]+|[.…]+$/g, "").trim());

export function validatePlan(g: Game, raw: unknown): VideoPlan {
  const p = raw as any;
  if (!p || typeof p !== "object" || !Array.isArray(p.moments)) throw new ActionError("The plan needs a `moments` array.");
  if (p.moments.length < 3 || p.moments.length > 20) throw new ActionError(`Pick 6–14 moments (you gave ${p.moments.length}).`);
  const seen = new Set<number>();
  const moments: VideoMoment[] = p.moments.map((x: any, i: number) => {
    const where = `moments[${i}]`;
    const ply = Number(x?.ply);
    const m = g.moves.find((mv) => mv.ply === ply);
    if (!m) throw new ActionError(`${where}: there is no ply ${x?.ply} (the game has plies 1–${g.moves.length}).`);
    if (seen.has(ply)) throw new ActionError(`${where}: ply ${ply} is listed twice.`);
    seen.add(ply);
    const importance = Number(x.importance);
    if (![1, 2, 3].includes(importance)) throw new ActionError(`${where}: importance must be 1, 2 or 3.`);
    const why = String(x.why ?? "").trim();
    if (!why) throw new ActionError(`${where}: say why it matters.`);
    let thought: string | undefined;
    const q = x.quote ?? x.thought;
    if (q !== undefined && q !== null && String(q).trim()) {
      thought = String(q).trim();
      if (!m.commentary.trim()) throw new ActionError(`${where}: ${sideName(g, m.color)} is a human and shared no commentary on ply ${ply} — leave the quote out.`);
      if (!isExcerpt(thought, m.commentary))
        throw new ActionError(`${where}: the quote must match that move's commentary exactly (ply ${ply}, ${m.san}). It doesn't.`);
      if (words(thought) > 70) throw new ActionError(`${where}: the quote is ${words(thought)} words; keep it to at most 60.`);
    }
    return { ply, why, importance: importance as 1 | 2 | 3, thought };
  });
  moments.sort((a, b) => a.ply - b.ply);
  if (moments.filter((m) => m.importance >= 2).length < 2) throw new ActionError("Give at least a few moments importance 2 or 3 — the short video only shows those.");

  const interviewLines: VideoPlan["interviewLines"] = { pre: {}, post: {} };
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const src = g.interviews[when][c]?.text;
      if (!src) continue;
      const line = String(p.interviewLines?.[when]?.[c] ?? "").trim();
      if (!line) throw new ActionError(`interviewLines.${when}.${c} is missing.`);
      if (!isExcerpt(line, src)) throw new ActionError(`interviewLines.${when}.${c} must be quoted exactly from that interview.`);
      if (words(line) > 50) throw new ActionError(`interviewLines.${when}.${c} is ${words(line)} words; keep it to at most 40.`);
      interviewLines[when][c] = line;
    }
  return { moments, interviewLines, createdAt: Date.now() };
}
