import type { Classification, Color, Game, MoveRecord, ThoughtMark, VideoCallback, VideoHook, VideoMoment, VideoPackaging, VideoPlan } from "../shared/types";
import { humanSide, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { beliefs } from "../shared/belief";
import { rivalry, seriesLine } from "./rivalry";
import { spokenText, VOICE_BUDGET } from "./voice";
import { LATE_INTERVIEW_CHARS, videoLines, voiceOf } from "../shared/videoLines";
import { describePlayer, pvSan } from "./briefing";
import { variantOf } from "../shared/rules";
import { ActionError } from "./game";
import { lineOptions, shownLine } from "../shared/engineLine";
import { leftEnPrise } from "./wintr";
import { moveWordAt, namedLine, phraseAt, quoteWords, squareWordAt } from "../shared/thoughtMarks";

/*
 * After the game the broadcaster turns video director: it reads the whole game and picks the
 * moments the replay video should slow down for, plus the best line of each interview.
 */

const colorName = (c: Color) => (c === "w" ? "White" : "Black");
const moveNo = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 ? "." : "…"}`;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Moves whose replies carry a punishment and a reaction worth showing. */
const SWING: Classification[] = ["mistake", "miss", "blunder"];

/** A swing in White's winning chance this big (in points of win%) is listed in the game's shape. */
const SHAPE_SWING = 20;
const PIECE: Record<string, string> = { n: "knight", b: "bishop", r: "rook", q: "queen" };

/** White's winning chance (0–100) before and after a move, or null without real engine data. */
function whiteWin(m: MoveRecord): { before: number; after: number } | null {
  const a = m.analysis;
  if (!a || a.unavailable) return null;
  return m.color === "w" ? { before: a.winBefore, after: a.winAfter } : { before: 100 - a.winBefore, after: 100 - a.winAfter };
}

/** Whether a commentary names a move (as SAN, with or without check marks), not just a square inside a longer word. */
function names(commentary: string, san: string): boolean {
  const bare = san.replace(/[+#!?]/g, "");
  return new RegExp(`(^|[^A-Za-z0-9-])${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`).test(commentary);
}

/** A finished game still waiting for its video plan. */
export const needsDirection = (g: Game) => !g.video && !!g.review && g.moves.length > 0;

export function directorBrief(g: Game): string {
  const name = (c: Color) => sideName(g, c);
  const human = humanSide(g);
  const out: string[] = [
    "VIDEO DIRECTOR — the broadcast is over. One last job: plan the replay video of this game.",
    "",
    "The game is cut into a YouTube video (every move) and a TikTok video (quiet moves fly by in under a second). Both slow down only for the moments you pick: a quote from the mover's own commentary on that move appears as a speech bubble, then they play it and the board holds on the move and its engine verdict.",
    "",
    "Before picking anything, read the whole game (start with `## Shape of the game` below) and decide what kind of game it is, because that decides where the slow-downs go:",
    "- A built attack or combination: one side made it and calculated it. The story is the idea: the quiet move that set it up, the shot, the defences the attacker saw coming, the finish.",
    "- A swindle or comeback: the lost side's tricks, the moment the winning side relaxes, the turn.",
    "- A thrown-away win: each chance the leader let go, with what would have won.",
    "- A comedy of errors: the reversals themselves, quickly, each with the most confident line before it.",
    "- A clean technical win: few moments. The one mistake, the plan that converted it, the finish.",
    "Many games mix two. Every swing listed in the game's shape should be one of your moments or one you chose to skip, and once one side is safely winning, spend moments there only on something that happens (a trick, a near-escape, the finish).",
    "",
    "The players' own thinking is what makes these videos worth watching, so tell each turning point as a short story in their words over consecutive plies, not as a single frame. A decisive blunder usually takes three or four:",
    "1. The build-up: the blunderer's thinking on the move itself (and sometimes the move before), showing what they believed. Confidence, a plan, a trap they think they're setting, or a threat they're sure isn't real all work well.",
    "2. The punishment: the opponent's next move, with their thinking as they spot it (or as they miss it, which is a story too).",
    "3. The reaction: the blunderer's next move, with the first thing they say after being hit. Realization (\"I missed…\"), damage control, denial, or still not noticing. This is often the best quote in the game. Don't drop it.",
    "Moves rated 'best' or 'good' often carry the punishment and reaction quotes, so read the plies around every swing, not just the flagged move.",
    "",
    "A combination or trap has a shape of its own, and it's the best thing these videos can show:",
    "1. The setup: the quiet move that made it possible, usually rated only 'best' or 'excellent', with the mover's plan.",
    "2. The shot: the move itself, quoted where the calculation shows they saw the point before it happened (\"Kxh7 is illegal: Ng5 guards h7\").",
    "3. The defence: the opponent's reply, and whether they saw it coming.",
    "4. The payoff: the capture or the mate.",
    "Give every ply of that arc importance 2 or more, or the short shows the shot without its point. A move marked `predicted` named the reply that then came: proof the trap was set on purpose rather than handed over. Moves marked `offers`, `gives up` or `leaves en prise` show where material was put up and whether it was taken, and `only move` marks where everything else lost ground; a defender's only move is as much a moment as the attacker's shot.",
    "",
    "Be honest about soundness and quality, because it makes the better story. A sacrifice the engine doesn't trust that still worked is a swindle, and the defence the opponent missed is the payoff (show it as a line). A 'combination' that only collected a piece left hanging is a punishment, not genius. Use the accuracy, the error counts and the verdicts to decide how good the game really was, and let `why`, the chapters and the line captions say it: \"both of them missed it\" is a story; \"a masterpiece\" about a game decided by a hung queen is not.",
    "",
    "Beyond those arcs, pick the other moments a viewer must not miss: big misjudgments (marked `misjudged` below), the moment a player finally sees the truth (marked `realizes`), and the finish. The engine's labels are a guide, not the answer. A move rated 'good' can be the real story (say, the move that allowed the trick), and a technical inaccuracy can be dull. Illegal-move attempts and quiet moves are importance 1 unless they change the story. Skip routine theory.",
    "",
    "Also pick the single best line from each interview for the short cut: funny, bold, or what came true (or didn't).",
    "",
    `Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.`,
    ...(human ? [`${name(human)} is a human: their moves come without commentary, so moments on their moves have no quote (the board, the verdict and the agent's reaction tell those).`] : []),
    `Opening: ${g.opening?.name ?? "unknown"}. Result: ${g.result} (${g.termination}).`,
    ...(g.ratingBefore && g.ratingChange
      ? [`Ratings (the video shows these): ${(["w", "b"] as Color[]).map((c) => `${name(c)} ${g.ratingBefore![c]} → ${g.ratingBefore![c] + g.ratingChange![c]}`).join(", ")}.`]
      : []),
    ...historyLines(g),
    "",
    "## Interviews",
  ];
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const iv = g.interviews[when][c];
      if (iv) out.push(`${when === "pre" ? "Pre-game" : "Post-game"}, ${name(c)} (${colorName(c)}): ${iv.text}`, "");
    }

  out.push(...shapeLines(g), "");

  out.push("## The game, move by move", "(eval and win% are White's view, win% before → after the move; self-eval is what the mover believed)", "");
  const belief = beliefs(g);
  g.moves.forEach((m, i) => {
    const a = m.analysis;
    const verdict = a ? `${a.classification}${a.bestSan && a.bestSan !== m.san ? `, engine preferred ${a.bestSan} (${pvSan(m.fenBefore, g.analysis[m.fenBefore]?.pv, 6, variantOf(g))})` : ""}` : "unrated";
    const ww = whiteWin(m);
    const win = ww ? ` (win% ${Math.round(ww.before)}→${Math.round(ww.after)})` : "";
    out.push(`ply ${m.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict}; eval ${formatScore(a?.evalAfter)}${win}; self-eval ${m.selfEvalRaw || "—"}`);
    out.push(...tacticLines(g, i));
    // Flagged only where a misjudgment starts, flips or ends, so a long stretch of it is one line, not twenty.
    const bl = belief[i];
    if (bl?.change === "starts" || bl?.change === "flips")
      out.push(`  misjudged: ${name(m.color)} ${bl.state === "over" ? "thinks it's doing far better than it is" : "thinks it's doing far worse than it is"} (until a later \`realizes\` line)`);
    else if (bl?.change === "realizes") out.push(`  realizes: ${name(m.color)}'s own eval matches the engine again`);
    // Point at the replies to a blunder, where the punishment and the reaction live.
    for (const back of [1, 2]) {
      const prev = g.moves[i - back];
      const cls = prev?.analysis?.classification;
      if (prev && cls && SWING.includes(cls))
        out.push(`  ${back === 1 ? "answers" : "reacts to"} ${moveNo(prev.ply)} ${prev.san} (${cls}, ply ${prev.ply}): ${back === 1 ? "the punishment, or the miss" : `${name(m.color)}'s first words after it`}`);
    }
    for (const l of lineOptions(g, i)) out.push(`  line option "${l.kind}": ${l.moves.map((mv) => mv.san).join(" ")} → ${l.fact}`);
    if (m.illegalAttempts.length) out.push(`  tried illegal moves first: ${m.illegalAttempts.join(", ")}`);
    if (m.offeredDraw) out.push(`  offered a draw with this move`);
    if (m.commentary.trim()) out.push(`  commentary: ${m.commentary.trim()}`);
    for (const b of g.broadcast.filter((l) => l.ply === m.ply && l.ts <= (g.endedAt ?? Infinity))) out.push(`  you said: ${b.text}`);
  });

  out.push(
    "",
    "## Your answer",
    "Write a JSON file in your working folder and submit it with `direct <file.json>`. Shape:",
    "```json",
    JSON.stringify(
      {
        moments: [
          {
            ply: 54,
            why: "Black thinks g6 is safe, but the c2 rook is now trapped",
            importance: 3,
            quote: "The rook on c2 is safe: if Bd1, I just play Rc5. And g6 takes f5 away from the knight.",
            delivery: "calm, quietly pleased with itself",
            chapter: "The rook that couldn't escape",
            line: { kind: "after", caption: "Bd1 shuts the rook in, and it falls two moves later" },
            marks: [
              { at: "if Bd1, I just play Rc5", moves: ["Bd1", "Rc5"] },
              { at: "g6 takes f5 away", moves: ["g6"], squares: ["f5"] },
            ],
          },
        ],
        interviewLines: { pre: { w: "…", b: "…" }, post: { w: "…", b: "…" } },
        interviewDelivery: { pre: { w: "cocky", b: "measured" }, post: { w: "rueful", b: "gracious" } },
        hook: { ply: 55, quote: "…exact sentences from ply 55's commentary…", delivery: "breezy, totally sure", caption: "Black thinks the rook is safe. It's already lost." },
        callback: { color: "b", line: "…exact sentences from Black's pre-game interview…", ply: 54 },
        packaging: {
          title: "GPT-6 Astra traps Sonnet's rook… and Sonnet doesn't notice for 10 moves",
          caption: "Sonnet was SO sure that rook was safe 💀 #chess #ai",
          thumbnail: { ply: 54, text: "TOTALLY SAFE" },
        },
      },
      null,
      2,
    ),
    "```",
    "- moments: 8–16 of them, in game order. `ply` is the ply number shown above.",
    "- importance: 3 = a headline moment, 2 = strong (both videos), 1 = minor (YouTube only). Give 5–9 moments importance 2 or 3. Keep a headline story whole in the short: if the blunder is a 3, its build-up, punishment and reaction should be at least 2, or the TikTok shows the blunder without its payoff.",
    "- why: one sentence on why it matters (kept for the editor, not shown on screen).",
    "- quote: what the mover said on this move, shown and spoken aloud in their own voice just before they play it, so on the reply after a blunder it reads as their reaction. Quote it exactly from that move's `commentary:` above: one sentence or a few in a row, at most 60 words. Shorter is usually stronger, and 15–35 words is ideal. Give EVERY importance 2–3 moment a quote, and leave one out only when the commentary says nothing worth hearing.",
    "- Choosing the quote: read the whole commentary, not just its opening sentence. Pick the sentences that show what the player felt, believed, planned or feared. The best ones are confident predictions that turn out wrong, plans that are about to fail, a trap they're proud of, and the first words after a shock. Avoid sentences that only describe the move or list recaptures, unless they're about to be proven wrong.",
    "- delivery (optional, on any quote, the hook and interviewDelivery): how the voice actor should say it, in at most 6 words, no brackets: \"smug, unbothered\", \"stunned, then quietly deflated\", \"nervous, talking fast\". You know what happens next and the player doesn't, so play the irony: a doomed move said with total confidence lands harder than one said worriedly. Leave it out when a neutral read is right.",
    "- chapter (importance 2–3 only, optional): a YouTube chapter title for this moment, at most 6 words, written like a story beat (\"The pawn fork nobody saw\"), not notation. Chapters show on the progress bar and in search before anyone presses play, so none may give away how the game ends: \"The fork\", not \"The fork that saved Astra\" or \"The winning blow\".",
    "- line (optional): play an engine line out on the board right after this move, then hold on your `caption`. Use it where the viewer has to see what didn't happen to understand the moment: `instead` plays what the engine wanted in place of this move (what a miss missed, what a blunder should have been); `after` plays the engine's best play from the position this move left, for when the game went another way (the punishment the reply didn't find, or the point of a brilliant or great move that never got played out). Only the options listed under a move as `line option` exist. Lines are where the video shows what the players couldn't see, so don't leave the good ones out: a `miss` at importance 2–3 needs its `instead` line (without it the viewer can't see what was missed); on a thrown-away win, the `instead` on the move that threw it shows how close it was; a tactic nobody played (a blunder's `after`, when the reply missed it) is the ghost of the game and usually worth showing; an unsound sacrifice that worked gets the defence that would have refuted it; a great or brilliant move whose point never got played out gets its `after`. Skip a line when the real moves play it out anyway. A blunder's `after` and the reply's `instead` are often the same line: show it once, on whichever moment tells the story better. A game with several swings usually uses 3–6; a game with no line options listed has none. Each one costs the viewer a few seconds, and in the TikTok cut only importance 2–3 moments show theirs.",
    "- marks (optional, on any quote, the hook's included): while the quote is spoken, the moves it names are drawn on the board, the way a streamer draws arrows while calculating. Each mark has `at`, the words of the quote where it starts (exactly as they appear), with `moves` (the moves those words name, in SAN, in the order they'd be played) and/or `squares` (squares it names, drawn as rings). A mark stays up until the next one starts, so make each mark one idea (a line, a threat, a plan), and the board clears for the next. Each arrow appears as its move is said. Moves are played from the board as it stands while they think (the mover to play) or from just after the move they're about to play, whichever makes them legal; add `from`: \"before\" or \"after\" when both would be. A threat (the opponent's move named before it's their turn) or two moves in a row by one side are fine as they are. Mark where the quote calculates (\"if Bd1, I play Rc5\", \"Qxh7 is mate\", \"after Nf5 the d4 knight hangs\"), not where it only describes (\"my knight on f3 is well placed\"). Usually 1–4 marks per quote, none on a quote that names no moves. They show the viewer what the player saw, so the doomed plan and the refutation they waved away draw best.",
    "- line.caption (optional, one line, at most 14 words): why the side the line favours is better at its end, in your own words and grounded in the moves listed: the fork, the overloaded queen, the back rank, the pawn that can't be stopped. Say what it wins (or, for an `instead` line that just keeps everything, what the move played gave away), but never a tactic or square the line doesn't show. Leave it out and the listed fact is shown instead.",
    "- interviewLines: for each interview, quote one to three consecutive sentences exactly, at most 40 words.",
    "- hook (required): the cold open. Both videos start on this moment before rewinding to the start, so it's what decides whether a viewer keeps watching. Pick the most shocking payoff, and fit it to the kind of game: for a built attack, the shot with the attacker's calculation (not the defender's mistake); for a swindle, the winning side's most confident line just before it turns; for a thrown-away win, the leader's line on the move that throws it; otherwise usually the blunder with the mover's most confident line, or the reaction after it. `quote` comes from that move's commentary like any quote (at most 40 words; leave it out on a human's move). `caption` is on-screen text of at most 12 words that makes the viewer need to see how it happened, without notation: \"Sonnet thinks it's winning. It's getting mated in one.\"",
    "- callback (optional): a pre-game line that the game proves wrong (or spectacularly right), replayed as a flashback right after the move that settles it. `line` is quoted exactly from that player's pre-game interview (at most 30 words); `ply` is the move that pays it off and must be one of your importance 2–3 moments. Only use it when the irony is real.",
    "- packaging (required): `title` for YouTube (at most 80 characters, the story not the notation, names the models); `caption` for TikTok (at most 150 characters, may end with a few hashtags); `thumbnail`: the move whose position makes the thumbnail and at most 4 words of big text.",
    "- Selling the video without spoiling it: the title, thumbnail and caption are what people see before they click. They may name the twist (the blunder, the trap, the comeback), because the viewer still wants to see how it happened, but never the ending: who won, that it was drawn, or that someone escaped. Make the title and thumbnail a pair that never says the same thing twice. One sets up the stakes (who was winning, how sure they were) and the other delivers the turn. The thumbnail shows the position after its move with that move's engine verdict icon (a blunder's ?? already says something went wrong). When the title names the twist, the thumbnail sells the stakes instead of showing the punishment again: the winning side's last strong move before the turn (\"MATE IN 24…\"), or the blunder with the mover's false confidence (\"TOTALLY SAFE\"). When the title only sets things up, the punishment itself can be the thumbnail.",
    `- Everything spoken (quotes, hook, interview lines, flashback) is voiced, and together it must stay under ${VOICE_BUDGET} characters. Plans that follow the limits above fit easily.`,
    "If the server rejects the plan it says why; fix it and submit again. Then run `bc-wait`.",
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/** The two models' history, for titles and hooks ("the rematch", "revenge"). Nothing for a first meeting. */
function historyLines(g: Game): string[] {
  const r = rivalry(g);
  if (!r?.last) return [];
  const name = (c: Color) => sideName(g, c);
  const last = r.last.winner === null ? "a draw" : `won by ${name(r.last.winner)}`;
  return [
    `Their history: ${seriesLine(r.before, name)} before this game; their last meeting was ${last}${r.last.headline ? ` ("${r.last.headline}")` : ""}. After this game: ${seriesLine(r.after, name)}. A rematch, a revenge or a streak can make the title.`,
  ];
}

/**
 * The game at a glance, from the engine's win% (which shows swings that centipawns hide): how well each
 * side played, each side's high point, the lead changes, every big swing, and where it stopped being in doubt.
 */
function shapeLines(g: Game): string[] {
  const name = (c: Color) => sideName(g, c);
  const at = (i: number) => `ply ${g.moves[i].ply}, ${moveNo(g.moves[i].ply)} ${g.moves[i].san}`;
  const pts = g.moves.flatMap((m, i) => {
    const w = whiteWin(m);
    return w ? [{ i, ...w }] : [];
  });
  if (!pts.length) return [];
  const out = ["## Shape of the game", "(win% is White's winning chance from the engine)"];
  if (g.review) {
    const errors = (c: Color) => {
      const n = g.review![c].counts;
      const parts = (["blunder", "mistake", "miss"] as Classification[]).filter((k) => n[k]).map((k) => `${n[k]} ${k}${n[k] === 1 ? "" : k === "miss" ? "es" : "s"}`);
      return parts.length ? parts.join(", ") : "no mistakes";
    };
    out.push(`Play: ${(["w", "b"] as Color[]).map((c) => `${name(c)} ${g.review![c].accuracy ?? "—"}% accuracy, ${errors(c)}`).join("; ")}.`);
  }
  const top = pts.reduce((a, p) => (p.after > a.after ? p : a));
  const bottom = pts.reduce((a, p) => (p.after < a.after ? p : a));
  out.push(`High points: ${name("w")} ${Math.round(top.after)}% (${at(top.i)}); ${name("b")} ${Math.round(100 - bottom.after)}% (${at(bottom.i)}).`);
  // A lead change: from one side clearly better (over 70%) to the other.
  let side = 0;
  let changes = 0;
  for (const p of pts) {
    const now = p.after > 70 ? 1 : p.after < 30 ? -1 : 0;
    if (now && side && now !== side) changes++;
    if (now) side = now;
  }
  out.push(`Lead changes (one side clearly better, then the other): ${changes}.`);
  const swings = pts.filter((p) => Math.abs(p.after - p.before) >= SHAPE_SWING);
  out.push(
    swings.length
      ? `Swings of ${SHAPE_SWING}+ points: ${swings.map((p) => `${at(p.i)} (${g.moves[p.i].analysis!.classification}) ${Math.round(p.before)}→${Math.round(p.after)}`).join(" | ")}.`
      : `No swing of ${SHAPE_SWING}+ points: a steady game.`,
  );
  // Where the result stopped being in doubt: one side at 90%+ from there to the end.
  let k = pts.length;
  const final = pts[pts.length - 1].after;
  const leader: Color | null = final >= 90 ? "w" : final <= 10 ? "b" : null;
  if (leader) while (k > 0 && (leader === "w" ? pts[k - 1].after >= 90 : pts[k - 1].after <= 10)) k--;
  if (leader && k < pts.length - 4) out.push(`Decided: ${name(leader)} stayed at 90%+ from ${at(pts[k].i)} to the end (${pts.length - k} plies).`);
  return out;
}

/** Tactical marks for move i: an only move, material put up (and whether it was taken), and a reply the mover named in advance. */
function tacticLines(g: Game, i: number): string[] {
  const m = g.moves[i];
  const cls = m.analysis?.classification;
  if (!cls || cls === "book" || m.analysis!.unavailable) return [];
  const out: string[] = [];
  const reply = g.moves[i + 1];
  if (cls === "great") out.push("  only move: every other move gave up much of the advantage");
  const inCheck = !!g.moves[i - 1]?.san.match(/[+#]/);
  for (const p of variantOf(g) === "standard" ? leftEnPrise(m.fenBefore, m.uci) : []) {
    const what = `${p.square === m.to ? "the" : "its"} ${PIECE[p.type]} on ${p.square}`;
    const fate = !reply ? "the game ended there" : reply.to === p.square && reply.san.includes("x") ? `taken next move (${reply.san})` : `not taken (${reply.san} instead)`;
    if (SWING.includes(cls)) out.push(`  leaves en prise: ${what}, ${fate}`);
    else if (inCheck) out.push(`  gives up: ${what} to get out of check; ${fate}`);
    else out.push(`  offers: ${what}, ${cls === "inaccuracy" ? "a sacrifice the engine doesn't trust" : "a sacrifice the engine is fine with"}; ${fate}`);
  }
  // A trap set on purpose: the commentary names the mover's answer to the reply that came (and the reply
  // itself, unless the reply was a mistake walking into it), and that answer pays: a check, material won, or
  // the punishment of the mistake. Agents name expected replies all the time; only the ones that pay count,
  // and a straight recapture on the same square never does.
  const follow = g.moves[i + 2];
  const said = m.commentary;
  if (said.trim() && reply && follow && follow.to !== reply.to && names(said, follow.san)) {
    const replyCls = reply.analysis?.classification;
    const walkedIn = !!replyCls && SWING.includes(replyCls);
    // What the answer wins once the opponent has had a move to take back: an even trade isn't a payoff.
    const settled = g.moves[i + 3]?.fenAfter ?? follow.fenAfter;
    const gained = material(settled, m.color) - material(m.fenAfter, m.color);
    const ww = whiteWin(m);
    const wf = whiteWin(follow);
    const winGain = ww && wf ? (m.color === "w" ? wf.after - ww.after : ww.after - wf.after) : 0;
    const forcing = /[+#]/.test(follow.san) || gained >= 2;
    const pays = forcing || (walkedIn && winGain >= 15);
    if (pays && names(said, reply.san)) out.push(`  predicted: named ${moveNo(reply.ply)} ${reply.san} and the answer ${moveNo(follow.ply)} ${follow.san} before either was played`);
    else if (pays && walkedIn) out.push(`  predicted: named the answer ${moveNo(follow.ply)} ${follow.san} to the ${replyCls} that came next`);
  }
  return out;
}

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
/** One side's material lead in a position, in pawns. */
function material(fen: string, c: Color): number {
  let n = 0;
  for (const ch of fen.split(" ")[0]) {
    const v = VALUE[ch.toLowerCase()];
    if (v) n += (ch === ch.toUpperCase()) === (c === "w") ? v : -v;
  }
  return n;
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

/** Whether excerpt is a verbatim piece of source (one ellipsis at either end allowed; an excerpt of nothing is not). */
function isExcerpt(excerpt: string, source: string): boolean {
  const core = norm(excerpt)
    .replace(/^(?:\.{2,3}|…)\s*/, "")
    .replace(/\s*(?:\.{2,3}|…)$/, "")
    .trim();
  return /[a-z0-9]/i.test(core) && norm(source).includes(core);
}

/** A whole number from JSON (a number, or digits in a string); NaN for anything else, objects included. */
const int = (raw: unknown) => (typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN);
/** A string from JSON, or "" for anything else (never calls a crafted toString). */
const str = (raw: unknown) => (typeof raw === "string" ? raw : "");

export function validatePlan(g: Game, raw: unknown): VideoPlan {
  const p = raw as any;
  if (!p || typeof p !== "object" || !Array.isArray(p.moments)) throw new ActionError("The plan needs a `moments` array.");
  if (p.moments.length < 3 || p.moments.length > 20) throw new ActionError(`Pick 8–16 moments (you gave ${p.moments.length}).`);
  const seen = new Set<number>();
  const moments: VideoMoment[] = p.moments.map((x: any, i: number) => {
    const where = `moments[${i}]`;
    const ply = int(x?.ply);
    const m = g.moves.find((mv) => mv.ply === ply);
    if (!m) throw new ActionError(`${where}: ply must be a ply number from the game (1–${g.moves.length}).`);
    if (seen.has(ply)) throw new ActionError(`${where}: ply ${ply} is listed twice.`);
    seen.add(ply);
    const importance = int(x.importance);
    if (![1, 2, 3].includes(importance)) throw new ActionError(`${where}: importance must be 1, 2 or 3.`);
    const why = str(x.why).trim();
    if (!why) throw new ActionError(`${where}: say why it matters.`);
    const thought = moveQuote(g, m, x.quote ?? x.thought, where, 70, 60, 480);
    const chapter = text(x.chapter, `${where}.chapter`, 60);
    const line = lineChoice(g, g.moves.indexOf(m), x.line, where);
    const marks = thoughtMarks(g, m, thought, x.marks, where);
    return { ply, why, importance: importance as 1 | 2 | 3, thought, delivery: delivery(x.delivery, `${where}.delivery`), chapter, ...(line && { line }), ...(marks && { marks }) };
  });
  moments.sort((a, b) => a.ply - b.ply);
  if (moments.filter((m) => m.importance >= 2).length < 2) throw new ActionError("Give at least a few moments importance 2 or 3 — the short video only shows those.");

  const interviewLines: VideoPlan["interviewLines"] = { pre: {}, post: {} };
  const interviewDelivery: NonNullable<VideoPlan["interviewDelivery"]> = { pre: {}, post: {} };
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const src = g.interviews[when][c]?.text;
      if (!src) continue;
      const line = str(p.interviewLines?.[when]?.[c]).trim();
      if (!line) throw new ActionError(`interviewLines.${when}.${c} is missing.`);
      if (!isExcerpt(line, src)) throw new ActionError(`interviewLines.${when}.${c} must be quoted exactly from that interview.`);
      if (words(line) > 50 || line.length > 340) throw new ActionError(`interviewLines.${when}.${c} is too long (${words(line)} words); keep it to at most 40.`);
      interviewLines[when][c] = line;
      const d = delivery(p.interviewDelivery?.[when]?.[c], `interviewDelivery.${when}.${c}`);
      if (d) interviewDelivery[when][c] = d;
    }

  // The cold open.
  const h = p.hook;
  if (!h || typeof h !== "object") throw new ActionError("The plan needs a `hook`: the moment the videos open on.");
  const hookMove = moveAt(g, h.ply, "hook");
  const hookQuote = moveQuote(g, hookMove, h.quote, "hook", 50, 40, 340);
  const hookMarks = thoughtMarks(g, hookMove, hookQuote, h.marks, "hook");
  const hook: VideoHook = {
    ply: hookMove.ply,
    quote: hookQuote,
    delivery: delivery(h.delivery, "hook.delivery"),
    caption: text(h.caption, "hook.caption", 120, true)!,
    ...(hookMarks && { marks: hookMarks }),
  };
  if (words(hook.caption) > 14) throw new ActionError(`hook.caption is ${words(hook.caption)} words; keep it to at most 12.`);

  // A pre-game line paid off later.
  let callback: VideoCallback | undefined;
  const cb = p.callback;
  if (cb !== undefined && cb !== null) {
    const color = cb.color;
    if (color !== "w" && color !== "b") throw new ActionError('callback.color must be "w" or "b".');
    const src = g.interviews.pre[color as Color]?.text;
    if (!src) throw new ActionError(`callback: ${colorName(color)} gave no pre-game interview.`);
    const line = str(cb.line).trim();
    if (!line || !isExcerpt(line, src)) throw new ActionError(`callback.line must be quoted exactly from ${colorName(color)}'s pre-game interview.`);
    if (words(line) > 36 || line.length > 260) throw new ActionError(`callback.line is too long (${words(line)} words); keep it to at most 30.`);
    const at = moments.find((x) => x.ply === int(cb.ply));
    if (!at || at.importance < 2) throw new ActionError("callback.ply must be one of your importance 2–3 moments (the flashback plays right after it).");
    callback = { color, line, ply: at.ply };
  }

  // Titles, caption and thumbnail.
  const pk = p.packaging;
  if (!pk || typeof pk !== "object") throw new ActionError("The plan needs `packaging`: title, caption and thumbnail.");
  const thumbText = text(pk.thumbnail?.text, "packaging.thumbnail.text", 40, true)!;
  if (words(thumbText) > 5) throw new ActionError(`packaging.thumbnail.text is ${words(thumbText)} words; keep it to at most 4.`);
  const packaging: VideoPackaging = {
    title: text(pk.title, "packaging.title", 100, true)!,
    caption: text(pk.caption, "packaging.caption", 220, true)!,
    thumbnail: { ply: moveAt(g, pk.thumbnail?.ply, "packaging.thumbnail").ply, text: thumbText },
  };

  const plan: VideoPlan = { moments, interviewLines, interviewDelivery, hook, callback, packaging, createdAt: Date.now() };

  // Every line is spoken in the player's voice, which is paid by the character: a plan that passes here
  // always gets its voices, so the limit is enforced now, while the director can still trim.
  const spoken = new Set<string>();
  for (const l of videoLines({ ...g, video: plan })) {
    const voice = voiceOf(g, l.color);
    if (voice) spoken.add(`${voice}|${spokenText(l.text, l.delivery)}`);
  }
  // Room for interviews not given yet: they'll be cut to at most LATE_INTERVIEW_CHARS of speech each.
  let late = 0;
  for (const when of ["pre", "post"] as const) for (const c of ["w", "b"] as Color[]) if (!g.interviews[when][c] && voiceOf(g, c)) late += LATE_INTERVIEW_CHARS;
  const total = [...spoken].reduce((n, s) => n + s.length - s.indexOf("|") - 1, 0) + late;
  if (total > VOICE_BUDGET)
    throw new ActionError(
      `Together the quotes, hook, interview lines and flashback come to ${total} characters of speech; keep them under ${VOICE_BUDGET}. Shorten the longest quotes or drop the quotes from a few importance-1 moments.`,
    );
  return plan;
}

function moveAt(g: Game, rawPly: unknown, where: string): MoveRecord {
  const m = g.moves.find((mv) => mv.ply === int(rawPly));
  if (!m) throw new ActionError(`${where}: ply must be a ply number from the game (1–${g.moves.length}).`);
  return m;
}

/**
 * An optional verbatim quote from a move's commentary (none on a human's move). Capped in words and
 * characters both: every quote is also sent to the voice engine, which charges by the character.
 */
function moveQuote(g: Game, m: MoveRecord, raw: unknown, where: string, hardMax: number, max: number, maxChars: number): string | undefined {
  const q = str(raw).trim();
  if (!q) return undefined;
  if (!m.commentary.trim()) throw new ActionError(`${where}: ${sideName(g, m.color)} is a human and shared no commentary on ply ${m.ply} — leave the quote out.`);
  if (!isExcerpt(q, m.commentary)) throw new ActionError(`${where}: the quote must match that move's commentary exactly (ply ${m.ply}, ${m.san}). It doesn't.`);
  if (words(q) > hardMax || q.length > maxChars) throw new ActionError(`${where}: the quote is too long (${words(q)} words); keep it to at most ${max}.`);
  return q;
}

/**
 * A short free-text field on one line: whitespace (line breaks included) collapsed, length-checked,
 * optional unless required. One line matters: chapter titles become lines of the YouTube description.
 */
function text(raw: unknown, where: string, maxChars: number, required = false): string | undefined {
  const s = str(raw).replace(/\s+/g, " ").trim();
  if (!s) {
    if (required) throw new ActionError(`${where} is missing.`);
    return undefined;
  }
  if (s.length > maxChars) throw new ActionError(`${where} is ${s.length} characters; keep it under ${maxChars}.`);
  return s;
}

/** The engine line a moment plays after its move: one the brief offered for that move, with an optional caption. */
function lineChoice(g: Game, i: number, raw: unknown, where: string): VideoMoment["line"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const r = raw as any;
  const kind = typeof raw === "string" ? raw : r?.kind;
  if (kind !== "instead" && kind !== "after") throw new ActionError(`${where}.line.kind must be "instead" or "after".`);
  if (!shownLine(g, i, kind)) throw new ActionError(`${where}.line: ply ${g.moves[i].ply} has no "${kind}" line to show. Only the \`line option\`s listed under a move exist.`);
  const caption = typeof raw === "string" ? undefined : text(r.caption, `${where}.line.caption`, 120);
  if (caption && words(caption) > 16) throw new ActionError(`${where}.line.caption is ${words(caption)} words; keep it to at most 14.`);
  return caption ? { kind, caption } : { kind };
}

/** How much one quote may draw: marks, the moves in one mark, and its rings. */
const MAX_MARKS = 6;
const MAX_MARK_MOVES = 6;
const MAX_MARK_RINGS = 4;

/**
 * The moves and squares a quote names, drawn on the board as they're said (see ThoughtMark). Each mark
 * starts at words of the quote and lasts until the next one; its moves are played from the position
 * before the move or after it, whichever makes them a legal line (or as `from` says).
 */
function thoughtMarks(g: Game, m: MoveRecord, quote: string | undefined, raw: unknown, where: string): ThoughtMark[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ActionError(`${where}.marks must be a list.`);
  if (!raw.length) return undefined;
  if (!quote) throw new ActionError(`${where}.marks: marks are drawn while the quote is spoken, and there's no quote.`);
  if (raw.length > MAX_MARKS) throw new ActionError(`${where}.marks: ${raw.length} marks; keep it to at most ${MAX_MARKS}.`);
  const starts = raw
    .map((x: any, n: number) => {
      const w = `${where}.marks[${n}]`;
      const at = text(x?.at, `${w}.at`, 240, true)!;
      const word = phraseAt(quote, at);
      if (word < 0) throw new ActionError(`${w}.at must be words of the quote, exactly as they appear in it ("${at}" isn't).`);
      return { x, w, at, word };
    })
    .sort((a, b) => a.word - b.word);
  starts.forEach((s, n) => {
    if (n && s.word === starts[n - 1].word) throw new ActionError(`${s.w}.at starts at the same word as another mark; give each mark its own words.`);
  });
  const variant = variantOf(g);
  return starts.map(({ x, w, at, word }, n) => {
    const until = starts[n + 1]?.word ?? Infinity;
    const list = Array.isArray(x.moves) ? x.moves.map(str) : typeof x.moves === "string" ? x.moves.split(/\s+/) : [];
    // Move numbers ("27.", "27...") are dropped; "27...g6" keeps its move.
    const sans: string[] = list.map((s: string) => s.trim()).filter((s: string) => s && !/^(?:\d+\s*)?(?:\.+|…)$/.test(s));
    if (sans.length > MAX_MARK_MOVES) throw new ActionError(`${w}.moves: ${sans.length} moves; keep it to at most ${MAX_MARK_MOVES}.`);
    const from = x.from;
    if (from !== undefined && from !== "before" && from !== "after") throw new ActionError(`${w}.from must be "before" or "after" (or left out).`);
    const fens = from === "before" ? [m.fenBefore] : from === "after" ? [m.fenAfter] : [m.fenBefore, m.fenAfter];
    const named = sans.length ? namedLine(fens, sans, variant) : { moves: [] };
    if ("stuck" in named) {
      const n = named.stuck;
      throw new ActionError(
        `${w}.moves: ${sans[n]} can't be played ${n ? `after ${sans.slice(0, n).join(" ")}` : ""} from the position ${from === "after" ? "after" : from === "before" ? "before" : "before or after"} ${m.san}. List the moves in SAN, in the order played, starting from the board as it is while they think or from just after ${m.san}. A move the player named that isn't legal there can't be drawn: leave it out.`.replace(/\s{2,}/g, " "),
      );
    }
    let k = word;
    let look = word;
    const last = Math.min(until - 1, quoteWords(quote).length - 1);
    const arrows = named.moves.map((mv, j) => {
      // Each arrow is drawn as its own move is said, when the quote names it ("Qxg4"); one it only
      // describes ("I recapture with the knight") follows the one before it a couple of words later.
      const said = moveWordAt(quote, [sans[j], mv.san], look, until);
      if (said >= 0) {
        k = said;
        look = said + 1;
      } else if (j) k = Math.max(k, Math.min(k + 2, last));
      return { san: mv.san, from: mv.from, to: mv.to, color: mv.color, word: k };
    });
    const sqs: string[] = (Array.isArray(x.squares) ? x.squares.map(str) : []).map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    if (sqs.length > MAX_MARK_RINGS) throw new ActionError(`${w}.squares: ${sqs.length} squares; keep it to at most ${MAX_MARK_RINGS}.`);
    const bad = sqs.find((s) => !/^[a-h][1-8]$/.test(s));
    if (bad) throw new ActionError(`${w}.squares: "${bad}" isn't a square.`);
    const rings = [...new Set(sqs)].map((sq) => ({ sq, word: Math.max(word, squareWordAt(quote, sq, word, until)) }));
    if (!arrows.length && !rings.length) throw new ActionError(`${w}: give it moves or squares to draw.`);
    return { at, word, arrows, rings };
  });
}

/** A delivery direction for the voice: a few words, no brackets (the voice engine adds its own). */
function delivery(raw: unknown, where: string): string | undefined {
  const s = text(raw, where, 60);
  if (!s) return undefined;
  if (/[[\]<>]/.test(s)) throw new ActionError(`${where}: just the words, no brackets.`);
  if (words(s) > 8) throw new ActionError(`${where} is ${words(s)} words; keep it to at most 6.`);
  return s;
}
