import type { Color, Game } from "../shared/types";
import { newRules, variantOf, type RulesMove } from "../shared/rules";
import { enginePath, lineVerdicts, LINE_WALK, shownLine, type LineKind } from "../shared/engineLine";
import { moveFacts } from "../shared/lineFacts";
import { formatScore, winPercentFor } from "../shared/evalmath";
import { sideName } from "../shared/naming";
import { tally, trade, walk } from "../shared/why";
import { asciiBoard } from "./briefing";
import { ActionError } from "./game";
import { analysed, engineFor, follow, judge } from "./lineDepth";
import { saveGame } from "./store";

/*
 * The director's questions to the engine, the way a commentator pokes at a position to see why it is what it
 * is: what if this is played (`probe`)? what else could the side to move do (`options`)? what is the last move
 * threatening (`threat`)? Each answer is the engine's, with every move badged and described from the board.
 * Positions a probe plays through are analysed and kept, so a probed move can then be a branch of a line.
 */

/** How far each of the engine's continuations is shown. */
const SHOW = 16;
const MAX_OPTIONS = 12;

/** Where a question starts, as the director writes it. */
const WHERE_HELP =
  'a position: "42" (after the game\'s move at ply 42), "42b" (before it), "42a3" (3 moves into the "after" line of ply 42; "42a0" its start) or "42i2" (2 moves into its "instead" line), optionally followed by moves played from there, each after a slash ("42a3/Bc2/Rg8")';

type Where = { fen: string; label: string; line?: { ply: number; kind: LineKind; at: number }; pre: RulesMove[] };

/** A position named as the director writes it (see WHERE_HELP): a base position, then any moves after slashes played from it. */
function position(g: Game, raw: string | undefined): Where {
  const [base, ...extra] = String(raw ?? "").trim().split("/").map((s) => s.trim());
  const from = basePosition(g, base);
  if (!extra.length) return from;
  if (extra.some((s) => !s)) throw new ActionError(`Give ${WHERE_HELP}.`);
  const pre = walk(from.fen, extra, variantOf(g));
  if (pre.length < extra.length) {
    const fen = pre.at(-1)?.after ?? from.fen;
    const legal = newRules(fen, variantOf(g)).moves().map((mv) => mv.san);
    throw new ActionError(`${extra[pre.length]} isn't legal ${pre.length ? `after ${pre.map((mv) => mv.san).join(" ")}` : `from ${from.label}`}. Legal: ${legal.join(" ")}.`);
  }
  return { ...from, fen: pre.at(-1)!.after, label: `${from.label}, then ${pre.map((mv) => mv.san).join(" ")}`, pre };
}

/** How far an engine question has got: positions searched so far (its WAITING reply reports it). */
interface Progress {
  positions: number;
}

/** Analyses and badges the moves a position's slashes played, so they show like any probed move (and can be a branch). */
async function playedThrough(g: Game, from: Where, p: Progress): Promise<void> {
  for (const mv of from.pre) {
    await analysed(g, mv.before, true);
    await analysed(g, mv.after, true);
    p.positions += 2;
    judge(g, mv);
  }
}

function basePosition(g: Game, raw: string): Where {
  const m = /^(\d+)(?:(b)|([ai])(\d+))?$/.exec(raw);
  if (!m) throw new ActionError(`Give ${WHERE_HELP}.`);
  const ply = Number(m[1]);
  const i = g.moves.findIndex((mv) => mv.ply === ply);
  if (i < 0) throw new ActionError(`There's no move at ply ${ply} (plies 1–${g.moves.length}).`);
  const mv = g.moves[i];
  if (m[2]) return { fen: mv.fenBefore, label: `before ply ${ply} (${mv.san})`, pre: [] };
  if (!m[3]) return { fen: mv.fenAfter, label: `after ply ${ply} (${mv.san})`, pre: [] };
  const kind: LineKind = m[3] === "a" ? "after" : "instead";
  const sl = shownLine(g, i, kind, false, true);
  if (!sl) throw new ActionError(`Ply ${ply} has no "${kind}" line.`);
  const at = Number(m[4]);
  if (at > sl.moves.length) throw new ActionError(`The "${kind}" line of ply ${ply} has ${sl.moves.length} moves (${sl.moves.map((x) => x.san).join(" ")}).`);
  return {
    fen: at ? sl.moves[at - 1].after : sl.fen,
    label: `${at} move${at === 1 ? "" : "s"} into the "${kind}" line of ply ${ply}${at ? ` (after ${sl.moves.slice(0, at).map((x) => x.san).join(" ")})` : ""}`,
    line: { ply, kind, at },
    pre: [],
  };
}

const turnOf = (fen: string): Color => (fen.split(" ")[1] === "b" ? "b" : "w");
const evalOf = (g: Game, fen: string) => formatScore(g.analysis[fen]?.score);

/** Moves for the readout, one per line: badge, what it does on the board, the eval after it. */
function described(g: Game, moves: RulesMove[], indent = "  "): string[] {
  const vs = lineVerdicts(g, moves);
  return moves.map((mv, k) => {
    const facts = moveFacts(mv);
    const ev = g.analysis[mv.after]?.score;
    return `${indent}${k + 1}. ${mv.san}${vs[k] ? ` [${vs[k]}]` : ""}${facts ? ` (${facts})` : ""}${ev ? `, eval ${formatScore(ev)}` : ""}`;
  });
}

/** What a run of moves comes to in material, from White's side and Black's: "White wins a knight", "even". */
function comesTo(g: Game, moves: RulesMove[]): string {
  if (!moves.length) return "nothing played";
  const last = moves.at(-1)!;
  if (last.san.endsWith("#")) return `${sideName(g, last.color)} mates`;
  const t = tally(moves, "w", true);
  const parts = [
    trade(t.won, t.lost) && `${sideName(g, "w")} wins ${trade(t.won, t.lost)}`,
    trade(t.lost, t.won) && `${sideName(g, "b")} wins ${trade(t.lost, t.won)}`,
    ...t.promoted.map((c) => `${sideName(g, c)} promotes a pawn`),
  ].filter(Boolean);
  const ahead = t.net > 0 ? `${sideName(g, "w")} comes out ${t.net} ahead` : t.net < 0 ? `${sideName(g, "b")} comes out ${-t.net} ahead` : "material comes out even";
  return `${ahead}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

/** probe <where> <move> [move…]: the moves played from there, then the engine's best play, followed position by position. */
async function probe(g: Game, args: string[], p: Progress): Promise<string> {
  const from = position(g, args[0]);
  const asked = args.slice(1);
  if (!asked.length) throw new ActionError(`probe ${args[0]} <move> [move…]: give the moves to play there (SAN or UCI).`);
  const variant = variantOf(g);
  const played = walk(from.fen, asked, variant);
  if (played.length < asked.length) {
    const fen = played.at(-1)?.after ?? from.fen;
    const legal = newRules(fen, variant).moves().map((mv) => mv.san);
    throw new ActionError(`${asked[played.length]} isn't legal ${played.length ? `after ${played.map((mv) => mv.san).join(" ")}` : "there"}. Legal: ${legal.join(" ")}.`);
  }
  await playedThrough(g, from, p);
  await analysed(g, from.fen, true);
  p.positions++;
  for (const mv of played) {
    await analysed(g, mv.after, true);
    p.positions++;
    judge(g, mv);
  }
  const end = played.at(-1)!.after;
  let counted = true; // `end` itself was counted above
  await follow(g, end, LINE_WALK, true, () => (counted ? (counted = false) : p.positions++));
  const cont = enginePath(g, end, SHOW);
  saveGame(g);
  const all = [...played, ...cont];
  const side = turnOf(from.fen);
  const out = [
    `From ${from.label}: ${sideName(g, side)} to move, eval ${evalOf(g, from.fen)}.`,
    asciiBoard(from.fen, "w"),
    "Played:",
    ...described(g, played),
    cont.length ? "Then the engine's best play for both sides:" : "The game is over there.",
    ...described(g, cont).map((s, k) => s.replace(/^ {2}\d+\./, `  ${played.length + k + 1}.`)),
    `What it all comes to: ${comesTo(g, all)}; eval at the end ${evalOf(g, all.at(-1)!.after)} (${Math.round(winPercentFor(g.analysis[all.at(-1)!.after]?.score ?? { cp: 0 }, "w"))}% for White).`,
  ];
  if (from.line) {
    const [first, ...rest] = [...from.pre, ...played];
    out.push(
      `As a branch of the "${from.line.kind}" line of ply ${from.line.ply}: { "at": ${from.line.at}, "move": "${first.san}"${rest.length ? `, "then": [${rest.map((mv) => `"${mv.san}"`).join(", ")}]` : ""} } (the engine's play above follows it).`,
    );
  }
  return out.join("\n");
}

/** options <where> [n]: the side to move's best n moves, each with the engine's line after it and what it comes to. */
async function options(g: Game, args: string[], p: Progress): Promise<string> {
  const from = position(g, args[0]);
  const variant = variantOf(g);
  const legal = newRules(from.fen, variant).moves();
  await playedThrough(g, from, p);
  if (!legal.length) return `From ${from.label}: no legal moves (the game is over there).`;
  const n = Math.min(legal.length, MAX_OPTIONS, Math.max(1, Number(args[1]) || 5));
  const a = await engineFor().analyze(from.fen, variant, n, true);
  if (a.failed || !a.multi?.length) throw new ActionError("The engine couldn't analyse that position; try again.");
  const side = turnOf(from.fen);
  const best = winPercentFor(a.multi[0].score, side);
  const out = [`From ${from.label}: ${sideName(g, side)} to move. Its ${a.multi.length} best moves, best first, each with the engine's line after it:`, asciiBoard(from.fen, "w")];
  a.multi.forEach((l, k) => {
    const moves = walk(from.fen, l.pv.slice(0, SHOW), variant);
    if (!moves.length) return;
    const win = winPercentFor(l.score, side);
    out.push(
      `${k + 1}. ${moves[0].san}: eval ${formatScore(l.score)} (${Math.round(win)}% for ${sideName(g, side)}${k ? (best - win >= 1 ? `, ${Math.round(best - win)} points worse than the best` : ", about as good as the best") : ""}). ${comesTo(g, moves)}.`,
      `   ${moves.map((mv) => mv.san).join(" ")}`,
      `   ${moves[0].san}: ${moveFacts(moves[0]) || "a quiet move"}`,
    );
  });
  if (legal.length > n) out.push(`(${legal.length - n} other legal moves are all worse than these.)`);
  out.push("Probe any of them (`probe`) to follow it position by position, with every move badged; a probed move can be a branch.");
  return out.join("\n");
}

/** threat <where>: what the side that just moved would play if it got another move now (the other side passes). */
async function threat(g: Game, args: string[], p: Progress): Promise<string> {
  const from = position(g, args[0]);
  const variant = variantOf(g);
  const side = turnOf(from.fen);
  await playedThrough(g, from, p);
  if (newRules(from.fen, variant).inCheck()) return `From ${from.label}: ${sideName(g, side)} is in check, so there's no passing: the check is the threat.`;
  const parts = from.fen.split(" ");
  const other: Color = side === "w" ? "b" : "w";
  const passed = [parts[0], other, parts[2], "-", parts[4], parts[5]].join(" ");
  let a;
  try {
    a = await engineFor().analyze(passed, variant, undefined, true);
  } catch {
    throw new ActionError("The engine couldn't analyse that.");
  }
  if (a.failed || !a.pv.length) throw new ActionError("The engine couldn't analyse that.");
  const moves = walk(passed, a.pv.slice(0, SHOW), variant);
  if (!moves.length) throw new ActionError("No threat could be worked out there.");
  return [
    `From ${from.label}: if ${sideName(g, side)} passed, ${sideName(g, other)} would play ${moves[0].san} (${moveFacts(moves[0]) || "a quiet move"}), eval ${formatScore(a.score)} with ${sideName(g, other)} to move.`,
    `That's the threat: ${moves.map((mv) => mv.san).join(" ")}. ${comesTo(g, moves)}.`,
    `${sideName(g, side)} has to answer it: \`options ${args[0]}\` shows how (and whether it can).`,
  ].join("\n");
}

/** board <where>: the position, with whose move it is and the eval. */
async function board(g: Game, args: string[], p: Progress): Promise<string> {
  const from = position(g, args[0]);
  await playedThrough(g, from, p);
  const a = await analysed(g, from.fen, true);
  saveGame(g);
  return [`${from.label}: ${sideName(g, turnOf(from.fen))} to move, eval ${formatScore(a.score)}${a.bestSan ? `, the engine's move ${a.bestSan}` : ""}.`, asciiBoard(from.fen, "w"), `FEN: ${from.fen}`].join("\n");
}

/** Who asks the engine: the director, or its narrator. */
export type Asker = "director" | "narrator";

/** Each game's engine questions so far, by who asked, so their readbacks can show what they've looked at and what not. */
const asked = new Map<string, { who: Asker; cmd: string; where: string; at: number }[]>();

/**
 * What an agent has investigated in a game: the lines it has asked about (as "42a", "85i": a line's ply and
 * kind, from positions like "42a3"), the plies it has looked at in the game itself, and how many questions.
 */
export function investigated(gameId: string, who: Asker): { lines: Set<string>; plies: Set<number>; count: number } {
  const list = (asked.get(gameId) ?? []).filter((q) => q.who === who);
  const lines = new Set<string>();
  const plies = new Set<number>();
  for (const q of list) {
    const m = /^(\d+)(?:(b)|([ai])\d+)?$/.exec(q.where.split("/")[0].trim());
    if (!m) continue;
    plies.add(Number(m[1]));
    if (m[3]) lines.add(`${m[1]}${m[3]}`);
  }
  return { lines, plies, count: list.length };
}

/**
 * The engine searches every position to full depth however long that takes, but an agent's command has to answer
 * inside the CLI's window (330 s): one that isn't done by then answers WAITING while the work carries on, and the
 * same question asked again joins it (finished positions are kept in the game) instead of starting over.
 */
const ANSWER_WITHIN_MS = Number(process.env.PROBE_ANSWER_MS ?? 270_000);
const working = new Map<string, { done: Promise<string>; p: Progress }>();

/** The director's engine questions (see the top of this file), or null for any other command. `who` asks (for its readbacks). */
export async function probeCommand(g: Game, cmd: string, args: unknown, who: Asker = "director"): Promise<string | null> {
  const list = Array.isArray(args) ? args.map((x) => String(x)) : [];
  const run = cmd === "probe" ? probe : cmd === "options" ? options : cmd === "threat" ? threat : cmd === "board" ? board : null;
  if (!run) return null;
  const key = `${g.id}|${cmd}|${list.join(" ")}`;
  let job = working.get(key);
  if (!job) {
    const p: Progress = { positions: 0 };
    const done = run(g, list, p).finally(() => working.delete(key));
    done.catch(() => {}); // a failure after a WAITING reply surfaces when the question is asked again
    job = { done, p };
    working.set(key, job);
  }
  let timer: NodeJS.Timeout | undefined;
  const out = await Promise.race([job.done, new Promise<null>((r) => (timer = setTimeout(() => r(null), ANSWER_WITHIN_MS)))]).finally(() => clearTimeout(timer));
  if (out === null) {
    const n = job.p.positions;
    return cmd === "probe"
      ? `WAITING — the engine is still following that line at full depth (${n} position${n === 1 ? "" : "s"} done so far, all kept). Run the same \`probe\` again to pick up where it is.`
      : `WAITING — the engine is still searching that position at full depth. Run the same \`${cmd}\` again to pick up where it is.`;
  }
  asked.set(g.id, [...(asked.get(g.id) ?? []), { who, cmd, where: String(list[0] ?? "").trim(), at: Date.now() }]);
  return out;
}

/** The engine questions, for each seat's command list. */
export const PROBE_COMMANDS = `  board <where>                  the position there, whose move, the eval and the engine's move
  probe <where> <move> [move…]   play moves from a position, then see the engine's best play after them, every move badged
  options <where> [n]            the side to move's best n moves (default 5), each with the engine's line and what it comes to
  threat <where>                 what the side that just moved threatens (the other side passes)
                                 <where>: "42" after ply 42, "42b" before it, "42a3" 3 moves into ply 42's "after" line, "42i2" into its "instead" line;
                                 add moves after slashes to start further on: "42a3/Bc2" after Bc2 there, "42a3/Bc2/Rg8" after Rg8 too
                                 (so you can ask \`options\` or \`threat\` anywhere inside a branch, not just on the game or its lines)`;
