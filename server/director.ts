import type { Classification, Color, Game, LineReach, LineRef, MoveRecord, ThoughtMark, ThoughtRef, VideoAside, VideoHook, VideoMoment, VideoPackaging, VideoPlan } from "../shared/types";
import type { VoiceManifest } from "../shared/voices";
import { speakable } from "../shared/speech";
import { triesOf } from "../shared/explain";
import { buildTimeline, silences } from "../web/src/video/timeline";
import { humanSide, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { beliefs } from "../shared/belief";
import { rivalry, seriesLine } from "./rivalry";
import { spokenText, VOICE_BUDGET } from "./voice";
import { LATE_INTERVIEW_CHARS, lineSig, videoLines, voiceOf } from "../shared/videoLines";
import { describePlayer, pvSan } from "./briefing";
import { variantOf, type RulesMove } from "../shared/rules";
import { ActionError } from "./game";
import { fenAt, lineOptions, lineRefProblems, resolveLineRefs, shownLine } from "../shared/engineLine";
import { leftEnPrise } from "./wintr";
import { boardOf, describe, drawnLine, imagined, isHit, markColors, moverKind, moveWordAt, phraseAt, phraseEnd, quoteWords, refProblems, resolveRefs, sanKey, squareWordAt } from "../shared/thoughtMarks";

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
    "The game is cut into a YouTube video (every move) and a TikTok video (quiet moves fly by in under a second). Both slow down only for the moments you pick: a quote from the mover's own commentary on that move appears as a speech bubble, then they play it and the board holds on the move and its engine verdict. Between your moments, the YouTube cut keeps the players talking with asides: short lines from their commentary, said while the moves play on (see `asides` below).",
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
    "Beyond those arcs, pick the other moments a viewer must not miss: big misjudgments (marked `misjudged` below), the moment a player finally sees the truth (marked `realizes`), and the finish. The engine's labels are a guide, not the answer. A move rated 'good' can be the real story (say, the move that allowed the trick), and a technical inaccuracy can be dull. Illegal-move attempts and quiet moves are importance 1 unless they change the story. Skip routine theory as moments: what the players say through the opening goes in asides.",
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
    for (const l of lineOptions(g, i))
      out.push(
        `  line option "${l.kind}": ${l.moves.map((mv) => mv.san).join(" ")} → ${l.fact}${l.punish ? `; allows: ${m.san} ${l.punish.moves.slice(1).map((mv) => mv.san).join(" ")} → ${l.punish.fact}` : ""}`,
      );
    if (m.illegalAttempts.length) out.push(`  tried illegal moves first: ${m.illegalAttempts.join(", ")}`);
    triesOf(m.illegalAttempts, m.tries).forEach((t, n) => {
      if (t?.commentary.trim()) out.push(`  said with illegal attempt ${m.illegalAttempts[n]}: ${t.commentary.trim()}`);
    });
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
            line: {
              kind: "after",
              caption: "Bd1 shuts the rook in, and it falls two moves later",
              refs: [
                { words: "Bd1", to: "Bd1" },
                { words: "rook", to: "c2" },
              ],
            },
            marks: [
              { at: "The rook on c2 is safe", squares: ["c2"], refs: [{ words: "rook on c2", to: "c2" }] },
              {
                at: "if Bd1, I just play Rc5",
                arrows: ["Bd1", "Rc5"],
                refs: [
                  { words: "Bd1", to: "Bd1" },
                  { words: "Rc5", to: "Rc5" },
                ],
              },
              {
                at: "g6 takes f5 away",
                arrows: ["g6", "g6>f5", { draw: "e3>f5", at: "the knight" }],
                refs: [
                  { words: "g6", to: "g6" },
                  { words: "f5", to: "f5" },
                  { words: "the knight", to: "e3" },
                ],
              },
            ],
          },
        ],
        asides: [
          { ply: 1, quote: "…a few words from ply 1's commentary…", short: true },
          { ply: 4, quote: "…", delivery: "easy, sure of itself" },
          { ply: 31, quote: "…a plan, a worry, a read on the opponent…" },
        ],
        interviewLines: { pre: { w: "…", b: "…" }, post: { w: "…", b: "…" } },
        interviewDelivery: { pre: { w: "cocky", b: "measured" }, post: { w: "rueful", b: "gracious" } },
        hook: { ply: 55, quote: "…exact sentences from ply 55's commentary…", delivery: "breezy, totally sure", caption: "Black thinks the rook is safe. It's already lost." },
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
    "- marks (on every quote that points at the board, the hook's included): while the quote is spoken, you draw on the board what it's talking about, the way a streamer draws arrows and circles nonstop while they talk through a position. Be generous: a streamer's board is almost never empty while they talk, and every piece, square and move they mention gets a circle or an arrow the moment they say it. Each mark is one idea (a line, a threat, a fork, a pin, a piece stuck defending, a material count, a weak square, the move they missed): its drawing builds up as the words are said, and the board wipes for the next mark. Each mark has `at`, the words of the quote where the idea starts (exactly as they appear), and `arrows` and/or `squares`:",
    "  - `arrows`, in the order they're said: moves in SAN (\"Rxe8+\", \"Kf7\"), and a piece's attack, defence or reach as \"from>to\" (\"d4>f3\"): a fork is two of them from the forking piece, a pin or a skewer one through the pinned piece to what's behind it, a piece stuck defending one to what it guards, a passed pawn one up its file. Arrows are drawn on the board as the player imagines it: each move is played on from the moves before it in the same mark, and a reach is from where the piece stands by then, so \"after Nd4 the knight hits f3 and e6\" is `[\"Nd4\", \"d4>f3\", \"d4>e6\"]`, and a piece moving twice goes on from where it landed. Each arrow appears as its words are said (the move, or the square a reach is to); when the quote only describes it (\"the king attacks the rook\"), give the item as { \"draw\": \"f7>e8\", \"at\": \"the king attacks the rook\" } so it appears on those words.",
    "  - `refs`: every word of the quote that names a square, a move or a piece goes in a ref of the mark that's up while it's said, saying what it points at: { \"words\": \"the pinned knight\", \"to\": \"e8\" }, { \"words\": \"f2/g2/h2\", \"to\": [\"f2\", \"g2\", \"h2\"] }, { \"words\": \"3 pawns\", \"to\": [\"f6\", \"g7\", \"h7\"] }, or one of the mark's moves: { \"words\": \"Rxe8+\", \"to\": \"Rxe8+\" } (a pawn move can point at its square). `words` are the fewest words that name it, exactly as in the quote; the same words given again point at the next place they appear (\"the knight\" twice for two knights). The ones among them that name the board (\"rook\" of \"the rook behind\"; all of them when none do, as in \"it\") light up in the bubble as they're said, in the colour of what they point at on the board as the player imagines it then (after the moves drawn before them in that mark): green for the speaking player's piece or move, red for the opponent's, amber for an empty square. The server checks every ref: what it points at is drawn in that mark (a circle on it, or an arrow starting or ending there), a kind of piece its words name (\"knight\", \"my king\", \"Nd7\") is really there (or was just taken there), and no word naming a square, a move or a piece is left out of every ref.",
    "  - `squares`: squares to circle, each as it's said, or as { \"sq\": \"f2\", \"at\": \"Rook\" } to circle a piece as the words name it: a hanging piece, a weak square, the square a plan aims for, and every piece the quote names by its kind (\"the rook\", \"my knight\", \"the d-pawn\", \"the pinned knight\"). Circle a piece where the viewer sees it: on the board as it stands while they think, or where a move drawn earlier in the same mark brings it. A piece that's only there after the move they're about to play (\"I take the rook… my knight\" circling the rook's square) reads as the wrong piece: circle it where it is now, or draw the move first in that mark.",
    "  - The board starts from the position while they think (the mover to play) or from just after the move they're about to play, whichever makes the mark hold; add `from`: \"before\" or \"after\" when both would. A threat (the opponent's move named before it's their turn) or two moves in a row by one side are fine as they are. A move they look back on (\"Kf7 attacked my rook\", \"I lost it by playing Nxc5\") is drawn from the position where it was played, up to 10 moves back: just list it, and anything after it in the mark goes on from there.",
    "  - A mark comes off at the end of its sentence, or when the next mark starts. When the idea runs on into the next sentence with nothing new to draw, add `until`: the words it stays up through. A reaction to a blunder (\"Ouch, I walked into Nd4+… I should have seen it\") keeps the refutation up with `until` to the end of the quote. A mark that ends on the move they're about to play stays up until it's played.",
    "  - What to draw (the server sends the plan back while anything the quote points at isn't drawn in the mark that's up as it's said):",
    "    - each piece as it's named or counted: \"Rook + 3 pawns vs knight + 3 pawns\" circles the rook, then each pawn, then the knight and its pawns, in the order said; \"I have a rook against a knight\" circles both;",
    "    - each move named, as an arrow, and a line as its arrows in order;",
    "    - alternatives joined by \"or\" (\"if the knight blocks on e4 or e2\", \"Nd4 or Ng1\") as reaches from the piece (\"c3>e4\", \"c3>e2\"), since a mark's moves are played one after another;",
    "    - a list of squares a piece covers (\"the Nc5 attacks a4, a6, b3…\") as one reach per square, each as it's said;",
    "    - a consequence (\"if White's king moves away, the knight just falls\") as the line that shows it (the king stepping away, then the capture);",
    "    - a check or capture the player waves away (\"if the knight jumps away with check…\") as that move: it's usually the refutation, and it draws best of all;",
    "    - the doomed plan, the trap they're proud of, the threat they fear, and what they say they missed;",
    "    - but never an arrow for what the quote says can't or won't happen (\"the rook cannot capture the knight\", \"Kxe2 isn't possible\"): an arrow always reads as \"this goes there\" or \"this hits that\", so it would show the opposite. Circle the pieces instead.",
    "  - Usually 2–6 marks per quote; a long quote can take 8. Start each mark on words that draw something straight away, so the board isn't empty while the idea is being said. A hook that quotes words of one of your moments draws that moment's marks for them, unless you give it its own.",
    "- line.caption (optional, one line, at most 14 words): why the side the line favours is better at its end, in your own words and grounded in the moves listed: the fork, the overloaded queen, the back rank, the pawn that can't be stopped. Say what it wins (or, for an `instead` line that just keeps everything, what the move played gave away), but never a tactic or square the line doesn't show. Leave it out and the listed fact is shown instead.",
    "  - line.squares, line.draw, line.refs: what the board shows with the caption, at the end of the line, as in marks. The line's moves are played out on the board, but nothing else is drawn unless you say: `squares` circles pieces or squares (\"e6\"), each up while its piece stays there; `draw` adds a piece's attack or defence as \"from>to\" (\"e6>e2\": the rook guarding the pawn), checked against the board. `refs`: every word of the caption that names a square, a move or a piece goes in a ref saying what it points at: { \"words\": \"the rook\", \"to\": \"e6\" }, or one of the line's moves: { \"words\": \"Kg4\", \"to\": \"Kg4\" }. A square a ref points at must be drawn: circled, at an end of a reach, or where one of the line's moves went from or to (a piece the line takes can be pointed at where it was taken). Those words light up in the colour of what they point at: green for the side the line favours, red for the other, amber for an empty square. A caption without refs lights nothing.",
    "  - line.punish (an `instead` line listed with `allows:` only, optional): before the line, the video plays what the move played allowed (the moves after `allows:`) and explains it, then winds the board back for the line. Use it when the reason the move was bad isn't obvious from the better line alone, which is most of the time: a fork, a skewer, the back rank, a piece left loose. In your own words, say what the punishment does: { \"at\": \"Nd4+\", \"caption\": \"Nd4+ forks the king and the rook.\", \"draw\": [\"d4>f3\", \"d4>e6\"], \"squares\": [\"f3\", \"e6\"], \"refs\": [{ \"words\": \"Nd4+\", \"to\": \"Nd4+\" }, { \"words\": \"king\", \"to\": \"f3\" }, { \"words\": \"rook\", \"to\": \"e6\" }] }. `at` is the move after which the caption shows and the board pauses on it (by default the last); `squares`, `draw` and `refs` work as for the line, on the board right after `at`, and the moves on the board then include the move played. A circled piece comes off when it moves or is taken, so the rook circled at the fork disappears when the knight takes it. Say only what those moves show, and draw the idea (the fork's two reaches, the pin through the piece, the mating square), not every move. Then the line's own caption can build on it (\"Kg4 instead: no fork, and the rook stays safe\").",
    "- asides: lines said in passing while the game plays on, in the player's own voice, with nothing drawn. The board doesn't stop for them: each is said as its move is played, and the next moves play on under it. They keep the players talking between your moments, so use them for anything worth hearing even when nothing big happens on the board: what they're going for, a plan, a worry, a read on the opponent, a habit, a joke, a line that comes back later. Each is { \"ply\": 7, \"quote\": \"…\", \"delivery\": \"…\" } (delivery optional), quoted exactly from that move's `commentary:` (or from what was `said with illegal attempt` on it), at most 25 words. Shorter is better, and a clause works (\"I take space in the center\"). Not on a ply that's one of your moments, nor on the last move.",
    "  - Open with a short exchange: 4–6 asides over the first 10–16 plies, the two players taking turns, a few words each (5–12 is ideal), so the opening has them talking through their choices instead of silent theory. Not one on every ply: the moves need room to play between the lines. Where asides do come one after another, each move waits for the line before it, so keep those short.",
    `  - Every aside is in the YouTube cut. Mark the best few with \`"short": true\` (at most ${MAX_SHORT_ASIDES}) to say them in the TikTok cut too, over its quick quiet moves: one or two from the opening, and the ones that set up your headline moments or carry the most personality.`,
    "  - An illegal attempt gets an aside on its move: usually the player owning up to it (the move's commentary often does), or what they meant by it. It's said while the rejected move is on the board.",
    "  - An aside that wouldn't be over before the next moment starts up to 4 plies early, over the quiet moves before it; otherwise the board waits for it.",
    `  - The YouTube cut must never go quiet for long: from the first move to the result, at most ${MAX_SILENCE} seconds may pass with nothing said (no quote, aside or engine line on screen). The server works out the video's timing and sends the plan back with every silent stretch, by ply: fill each with an aside or two from the plies in it.`,
    "- interviewLines: for each interview, quote one to three consecutive sentences exactly, at most 40 words.",
    "- hook (required): the cold open. Both videos start on this moment before rewinding to the start, so it's what decides whether a viewer keeps watching. Pick the most shocking payoff, and fit it to the kind of game: for a built attack, the shot with the attacker's calculation (not the defender's mistake); for a swindle, the winning side's most confident line just before it turns; for a thrown-away win, the leader's line on the move that throws it; otherwise usually the blunder with the mover's most confident line, or the reaction after it. `quote` comes from that move's commentary like any quote (at most 40 words; leave it out on a human's move). `caption` is on-screen text of at most 12 words that makes the viewer need to see how it happened, without notation: \"Sonnet thinks it's winning. It's getting mated in one.\"",
    "- packaging (required): `title` for YouTube (at most 80 characters, the story not the notation, names the models); `caption` for TikTok (at most 150 characters, may end with a few hashtags); `thumbnail`: the move whose position makes the thumbnail and at most 4 words of big text.",
    "- Selling the video without spoiling it: the title, thumbnail and caption are what people see before they click. They may name the twist (the blunder, the trap, the comeback), because the viewer still wants to see how it happened, but never the ending: who won, that it was drawn, or that someone escaped. Make the title and thumbnail a pair that never says the same thing twice. One sets up the stakes (who was winning, how sure they were) and the other delivers the turn. The thumbnail shows the position after its move with that move's engine verdict icon (a blunder's ?? already says something went wrong). When the title names the twist, the thumbnail sells the stakes instead of showing the punishment again: the winning side's last strong move before the turn (\"MATE IN 24…\"), or the blunder with the mover's false confidence (\"TOTALLY SAFE\"). When the title only sets things up, the punishment itself can be the thumbnail.",
    `- Everything spoken (quotes, asides, hook, interview lines) is voiced, and together it must stay under ${VOICE_BUDGET} characters. Plans that follow the limits above fit easily.`,
    "If the server rejects the plan it says why; fix it and submit again. Once it passes, it's read back to you: every quote with its lit words, every drawing and ref with what it points at on the board and its colour, and when each aside is said. Check each line against what the player meant (and that the asides read in order as a conversation), then run `confirm` to save it, or fix the plan and submit it again. Then run `bc-wait`.",
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
  // A hook quoted from a moment's marked quote draws what the moment draws, unless the director says otherwise.
  const copied = h.marks === undefined || h.marks === null ? hookMarksFrom(moments.find((x) => x.ply === hookMove.ply), hookQuote) : undefined;
  let hookMarks: ThoughtMark[] | undefined;
  if (copied && hookQuote) {
    try {
      checkRefs(g, hookMove, hookQuote, copied, "hook");
      hookMarks = copied;
    } catch {
      // The moment's marks leave part of the hook undrawn: it needs its own.
    }
  }
  hookMarks ??= thoughtMarks(g, hookMove, hookQuote, h.marks, "hook");
  const hook: VideoHook = {
    ply: hookMove.ply,
    quote: hookQuote,
    delivery: delivery(h.delivery, "hook.delivery"),
    caption: text(h.caption, "hook.caption", 120, true)!,
    ...(hookMarks && { marks: hookMarks }),
  };
  if (words(hook.caption) > 14) throw new ActionError(`hook.caption is ${words(hook.caption)} words; keep it to at most 12.`);

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

  const asides = asideList(g, p.asides, moments);
  const plan: VideoPlan = { moments, ...(asides && { asides }), interviewLines, interviewDelivery, hook, packaging, createdAt: Date.now() };

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
      `Together the quotes, asides, hook and interview lines come to ${total} characters of speech; keep them under ${VOICE_BUDGET}. Shorten the longest quotes and asides, or drop the quotes from a few importance-1 moments.`,
    );

  const quiet = silentStretches(g, plan);
  if (quiet.length)
    throw new ActionError(
      `The YouTube cut goes more than ${MAX_SILENCE} s with nothing said here:\n${quiet.map((q) => `- ${q}`).join("\n")}\nFill each with an aside or two from the plies in it (or a moment, where one belongs).`,
    );
  return plan;
}

/** How long the YouTube cut may go with nothing said, from the first move to the result. */
const MAX_SILENCE = 15;
/** Roughly how fast the voices speak, in words of the spoken text a second: to time a plan before it's recorded. */
const SPOKEN_WPS = 2.5;
const MAX_ASIDES = 80;
/** How many asides the TikTok cut may say: its quiet moves fly by, so only the best few. */
const MAX_SHORT_ASIDES = 8;

/** The plan's lines as long as they'll roughly take to say, for timing a plan that isn't recorded yet. */
function estimatedVoice(g: Game): VoiceManifest {
  const clips: VoiceManifest["clips"] = {};
  for (const l of videoLines(g)) {
    const voice = voiceOf(g, l.color);
    if (voice) clips[l.id] = { url: "", dur: words(speakable(l.text)) / SPOKEN_WPS, sig: lineSig(voice, l) };
  }
  return { clips };
}

/** The YouTube cut as this plan would time it (the voices estimated). */
const plannedTimeline = (g: Game, plan: VideoPlan) => {
  const pg = { ...g, video: plan };
  return buildTimeline(pg, "landscape", { voice: estimatedVoice(pg) });
};

/**
 * Where the YouTube cut goes quiet for too long, by ply, leaving out stretches with nothing to quote (a
 * human's moves, or plies already used).
 */
function silentStretches(g: Game, plan: VideoPlan): string[] {
  const tl = plannedTimeline(g, plan);
  const used = new Set([...plan.moments.map((x) => x.ply), ...(plan.asides ?? []).map((a) => a.ply)]);
  const out: string[] = [];
  for (const gap of silences(tl, MAX_SILENCE)) {
    const plies = tl.scenes.flatMap((s) => (s.kind === "move" && !s.hook && s.start >= gap.from - 0.01 && s.start < gap.to ? [g.moves[s.i]] : []));
    if (!plies.some((m) => m.commentary.trim() && !used.has(m.ply))) continue;
    const [a, b] = [plies[0], plies[plies.length - 1]];
    out.push(`plies ${a.ply}–${b.ply} (${moveNo(a.ply)} ${a.san} to ${moveNo(b.ply)} ${b.san}): about ${Math.round(gap.to - gap.from)} s with nothing said`);
  }
  return out;
}

/** The director's asides (see VideoAside): quoted exactly and short, one per ply, never on a moment or the last move. */
function asideList(g: Game, raw: unknown, moments: VideoMoment[]): VideoAside[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ActionError("`asides` must be an array.");
  if (raw.length > MAX_ASIDES) throw new ActionError(`${raw.length} asides; keep it to at most ${MAX_ASIDES}.`);
  const seen = new Set<number>();
  const out = raw.map((x: any, n): VideoAside => {
    const where = `asides[${n}]`;
    const m = moveAt(g, x?.ply, where);
    if (seen.has(m.ply)) throw new ActionError(`${where}: ply ${m.ply} already has an aside; give it one.`);
    seen.add(m.ply);
    if (moments.some((y) => y.ply === m.ply)) throw new ActionError(`${where}: ply ${m.ply} is one of your moments, so its quote is said there. Put the line in that quote, or give the aside to another ply.`);
    if (m === g.moves[g.moves.length - 1]) throw new ActionError(`${where}: the last move is a moment of its own; give the aside to another ply.`);
    const sources = [m.commentary, ...(m.tries ?? []).map((t) => t.commentary)].filter((s) => s.trim());
    if (!sources.length) throw new ActionError(`${where}: ${sideName(g, m.color)} is a human and shared no commentary on ply ${m.ply}, so there's nothing to quote.`);
    const quote = str(x.quote).trim();
    if (!quote) throw new ActionError(`${where}: give the quote.`);
    if (!sources.some((s) => isExcerpt(quote, s)))
      throw new ActionError(`${where}: the quote must match that move's commentary exactly (ply ${m.ply}, ${m.san})${sources.length > 1 ? ", or what was said with an illegal attempt on it" : ""}. It doesn't.`);
    if (words(quote) > 30 || quote.length > 240) throw new ActionError(`${where}: the quote is too long (${words(quote)} words); keep it to at most 25.`);
    const d = delivery(x.delivery, `${where}.delivery`);
    if (x.short !== undefined && typeof x.short !== "boolean") throw new ActionError(`${where}.short: true or false.`);
    return { ply: m.ply, quote, ...(d && { delivery: d }), ...(x.short === true && { short: true }) };
  });
  const short = out.filter((a) => a.short).length;
  if (short > MAX_SHORT_ASIDES) throw new ActionError(`${short} asides are marked \`short\`; keep it to at most ${MAX_SHORT_ASIDES}, the best of them.`);
  out.sort((a, b) => a.ply - b.ply);
  return out.length ? out : undefined;
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

/**
 * The engine line a moment plays after its move: one the brief offered for that move, with an optional
 * caption (its refs and reaches checked against the board at the line's end), and for an `instead` line,
 * optionally what the move played allowed first, in the director's words.
 */
function lineChoice(g: Game, i: number, raw: unknown, where: string): VideoMoment["line"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const r = raw as any;
  const kind = typeof raw === "string" ? raw : r?.kind;
  if (kind !== "instead" && kind !== "after") throw new ActionError(`${where}.line.kind must be "instead" or "after".`);
  const sl = shownLine(g, i, kind);
  if (!sl) throw new ActionError(`${where}.line: ply ${g.moves[i].ply} has no "${kind}" line to show. Only the \`line option\`s listed under a move exist.`);
  if (typeof raw === "string") return { kind };
  const caption = text(r.caption, `${where}.line.caption`, 120);
  if (caption && words(caption) > 16) throw new ActionError(`${where}.line.caption is ${words(caption)} words; keep it to at most 14.`);
  if (!caption && (r.refs?.length || r.draw?.length || r.squares?.length)) throw new ActionError(`${where}.line: refs, draw and squares go with a caption; give one, or leave them out.`);
  const out: NonNullable<VideoMoment["line"]> = { kind, ...(caption && { caption, ...lineNote(g, sl.fen, sl.moves, sl.moves.length, sl.for, caption, r, `${where}.line`) }) };
  const p = r.punish;
  if (p !== undefined && p !== null && p !== "") {
    const m = g.moves[i];
    if (!sl.punish) throw new ActionError(`${where}.line.punish: ${m.san} has nothing to punish it with that the video can show. Only lines listed with \`allows:\` have one.`);
    const moves = sl.punish.moves;
    const pc = text(p.caption, `${where}.line.punish.caption`, 120, true)!;
    if (words(pc) > 16) throw new ActionError(`${where}.line.punish.caption is ${words(pc)} words; keep it to at most 14.`);
    // The caption shows once the move named in `at` is played (by default, at the end).
    let at = moves.length;
    if (p.at !== undefined && p.at !== null && p.at !== "") {
      const key = sanKey(str(p.at));
      const j = moves.findIndex((mv, n) => n > 0 && sanKey(mv.san) === key);
      if (j < 0) throw new ActionError(`${where}.line.punish.at must be one of the punishment's moves (${moves.slice(1).map((mv) => mv.san).join(", ")}).`);
      at = j + 1;
    }
    out.punish = { at, caption: pc, ...lineNote(g, m.fenBefore, moves, at, sl.for, pc, p, `${where}.line.punish`) };
  }
  return out;
}

/**
 * A line's caption, on the board as it stands when it shows (k of `moves` played from `fen`): what the
 * director draws with it, reaches ("d4>f3") and circles (`squares`), and its refs, every word naming a
 * square, a move or a piece pointing at what's there and drawn (see lineRefProblems; a square a move on the board
 * went from or to counts as drawn, the way a move's arrow does in marks). The director is sent back with
 * every problem at once.
 */
function lineNote(g: Game, fen: string, moves: RulesMove[], k: number, side: Color, caption: string, raw: any, where: string): { refs?: LineRef[]; draw?: LineReach[]; rings?: string[] } {
  const played = moves.slice(0, k).map((mv) => mv.san);
  const rawDraw = raw?.draw;
  const rawRefs = raw?.refs;
  const rawSquares = raw?.squares;
  const ringList = rawSquares === undefined || rawSquares === null ? [] : Array.isArray(rawSquares) ? rawSquares.map((x) => str(x).trim().toLowerCase()).filter(Boolean) : null;
  if (!ringList) throw new ActionError(`${where}.squares must be a list.`);
  if (ringList.length > MAX_MARK_RINGS) throw new ActionError(`${where}.squares: ${ringList.length} squares; keep it to at most ${MAX_MARK_RINGS}.`);
  const badSq = ringList.find((s) => !/^[a-h][1-8]$/.test(s));
  if (badSq) throw new ActionError(`${where}.squares: "${badSq}" isn't a square.`);
  const rings = [...new Set(ringList)];
  const drawList = rawDraw === undefined || rawDraw === null ? [] : Array.isArray(rawDraw) ? rawDraw.map((x) => str(x).trim()).filter(Boolean) : null;
  if (!drawList) throw new ActionError(`${where}.draw must be a list.`);
  if (drawList.length > MAX_MARK_ARROWS) throw new ActionError(`${where}.draw: ${drawList.length} reaches; keep it to at most ${MAX_MARK_ARROWS}.`);
  const notReach = drawList.find((s) => !isHit(s));
  if (notReach) throw new ActionError(`${where}.draw: "${notReach}" isn't a reach. Give a piece's attack or defence as "from>to" ("d4>f3"); the line's own moves are played out on the board already.`);
  const drawn = drawList.length ? drawnLine([fenAt(fen, moves, k)], drawList, variantOf(g)) : { drawn: [] };
  if ("stuck" in drawn) throw new ActionError(`${where}.draw: ${drawList[drawn.stuck]} can't be drawn when the caption shows (after ${played.join(" ")}): ${drawn.why}.`);
  const draw = drawn.drawn.map((d) => ({ from: d.from, to: d.to, color: d.color }));

  const refList = rawRefs === undefined || rawRefs === null ? [] : Array.isArray(rawRefs) ? rawRefs : null;
  if (!refList) throw new ActionError(`${where}.refs must be a list.`);
  if (refList.length > MAX_MARK_REFS) throw new ActionError(`${where}.refs: ${refList.length} refs; keep it to at most ${MAX_MARK_REFS}.`);
  const taken: [number, number][] = [];
  const refs: LineRef[] = refList.map((r: any, j: number) => {
    const wr = `${where}.refs[${j}]`;
    const phrase = text(r?.words, `${wr}.words`, 160, true)!;
    // A repeat of the same words points at the next place they appear.
    let k0 = phraseAt(caption, phrase);
    while (k0 >= 0 && taken.some(([a, b]) => k0 >= a && k0 <= b)) k0 = phraseAt(caption, phrase, k0 + 1);
    if (k0 < 0) throw new ActionError(`${wr}.words must be words of the caption, exactly as they appear ("${phrase}" isn't${taken.length ? ", or every place it appears is taken by an earlier ref" : ""}).`);
    const span: [number, number] = [k0, phraseEnd(caption, phrase, k0)];
    taken.push(span);
    const to = r?.to;
    const list = (Array.isArray(to) ? to : [to]).map((s: unknown) => str(s).trim());
    if (list.length && list.every((s: string) => /^[a-h][1-8]$/i.test(s))) return { words: span, sqs: [...new Set(list.map((s: string) => s.toLowerCase()))] };
    const key = sanKey(list[0] ?? "");
    const move = played.findIndex((san) => key && sanKey(san) === key);
    if (Array.isArray(to) || move < 0) throw new ActionError(`${wr}.to: "${list.join(", ")}" must be a square ("e6"), a list of squares, or one of the moves on the board when the caption shows (${played.join(", ")}).`);
    return { words: span, move };
  });
  // Drawn: what the director circles or reaches to, and the squares the moves played by then go from and to.
  const drawnSqs = [...rings, ...draw.flatMap((d) => [d.from, d.to]), ...moves.slice(0, k).flatMap((mv) => [mv.from, mv.to])];
  const problems = lineRefProblems(caption, refs, fen, moves, k, side, drawnSqs);
  if (problems.length) {
    const shown = problems.slice(0, 10);
    throw new ActionError(
      `${where}: ${problems.length === 1 ? "one thing" : `${problems.length} things`} to fix in what the caption points at:\n${shown.map((x) => `  - ${x}`).join("\n")}\nEvery word of the caption that names a square, a move or a piece goes in a ref, pointing at what it means on the board when the caption shows (after ${played.join(" ")}), and each square a ref points at is drawn: circled in \`squares\`, at an end of a reach in \`draw\`, or where one of those moves went from or to.`,
    );
  }
  return { ...(refs.length && { refs }), ...(draw.length && { draw }), ...(rings.length && { rings }) };
}

/** How much one quote may draw: marks, the arrows in one mark, and its rings. */
const MAX_MARKS = 8;
const MAX_MARK_ARROWS = 10;
const MAX_MARK_RINGS = 10;
const MAX_MARK_REFS = 24;
/** How far back in the game a mark may start, for a move the player looks back on ("Kf7 attacked my rook"). */
const MARK_LOOKBACK = 10;

/** The positions a mark of move m may imagine: before the move, after it, then further back. */
const markFens = (g: Game, m: MoveRecord) => {
  const i = g.moves.indexOf(m);
  return [m.fenBefore, m.fenAfter, ...g.moves.slice(Math.max(0, i - MARK_LOOKBACK), i).reverse().map((mv) => mv.fenBefore)];
};

/**
 * Everything a quote points at on the board is drawn while it's said, and every word that points at it is
 * in a ref that says what it points at, checked against the board (see refProblems). The director is sent
 * back with every problem at once.
 */
function checkRefs(g: Game, m: MoveRecord, quote: string, marks: ThoughtMark[], where: string): void {
  const problems = refProblems(quote, marks, markFens(g, m), m.color);
  if (!problems.length) return;
  const shown = problems.slice(0, 10);
  throw new ActionError(
    `${where}.marks: ${problems.length === 1 ? "one thing" : `${problems.length} things`} to fix in what the quote points at:\n${shown.map((p) => `  - ${p}`).join("\n")}${problems.length > shown.length ? `\n  - …and ${problems.length - shown.length} more like them` : ""}\nEvery word that names a square, a move or a piece goes in a ref of the mark that's up while it's said, pointing at what it means, and that thing is drawn in that mark (circle each piece as it's named or counted, an arrow for each move, a reach for what a piece attacks or defends).`,
  );
}

/** One item of a mark's list: "Nd4+", or { draw: "d4>f3", at: "the fork" } to say which words draw it. */
function markItem(raw: unknown, key: "draw" | "sq"): { what: string; at?: string } {
  if (raw && typeof raw === "object") return { what: str((raw as any)[key] ?? (raw as any).draw ?? (raw as any).sq).trim(), at: str((raw as any).at).trim() || undefined };
  return { what: str(raw).trim() };
}

/**
 * The moves, reaches and squares a quote names, drawn on the board as they're said (see ThoughtMark). Each
 * mark starts at words of the quote and builds up until the next one; its arrows are drawn on the board as
 * it imagines it, from the position before the move or after it, whichever makes them hold (or as `from`
 * says), or else from one earlier in the game, for moves looked back on. Every word naming a move, a square
 * or a piece is in one of its mark's refs, which say what it points at (checkRefs).
 */
function thoughtMarks(g: Game, m: MoveRecord, quote: string | undefined, raw: unknown, where: string): ThoughtMark[] | undefined {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) throw new ActionError(`${where}.marks must be a list.`);
  if (!quote) {
    if (list.length) throw new ActionError(`${where}.marks: marks are drawn while the quote is spoken, and there's no quote.`);
    return undefined;
  }
  const marks = list.length ? markList(g, m, quote, list, where) : [];
  checkRefs(g, m, quote, marks, where);
  return marks.length ? marks : undefined;
}

/** One quote's marks, as the director would submit them for move `ply`, checked as a plan's are (scripts/test-marks.ts). */
export function checkedMarks(g: Game, ply: number, quote: string, raw: unknown): ThoughtMark[] | undefined {
  return thoughtMarks(g, moveAt(g, ply, "test"), quote, raw, "marks");
}

/** One moment's engine line, as the director would submit it for move `ply`, checked as a plan's is. */
export function checkedLine(g: Game, ply: number, raw: unknown): VideoMoment["line"] {
  return lineChoice(g, g.moves.indexOf(moveAt(g, ply, "test")), raw, "line");
}

function markList(g: Game, m: MoveRecord, quote: string, raw: unknown[], where: string): ThoughtMark[] {
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
  const total = quoteWords(quote).length;
  return starts.map(({ x, w, at, word }, n) => {
    const next = starts[n + 1]?.word ?? Infinity;
    const last = Math.min(next - 1, total - 1);
    // Words of the mark that say when one of its items is drawn ("the king attacks"), if given.
    const wordsAt = (phrase: string | undefined, where: string) => {
      if (!phrase) return -1;
      const k = phraseAt(quote, phrase, word);
      if (k < 0 || k > last) throw new ActionError(`${where}.at must be words of this mark's part of the quote, exactly as they appear ("${phrase}" isn't).`);
      return k;
    };
    // The words given for an item, first to last: it appears on them and lights them up.
    const say = (phrase: string | undefined, start: number): { say?: [number, number] } => {
      if (!phrase || start < 0) return {};
      const end = phraseEnd(quote, phrase, start);
      return end >= start ? { say: [start, end] } : {};
    };
    const rawList = x.arrows ?? x.moves;
    const list = (Array.isArray(rawList) ? rawList : typeof rawList === "string" ? rawList.split(/\s+/) : []).map((r: unknown) => markItem(r, "draw"));
    // Move numbers ("27.", "27...") are dropped; "27...g6" keeps its move.
    const items = list.filter((it: { what: string }) => it.what && !/^(?:\d+\s*)?(?:\.+|…)$/.test(it.what));
    if (items.length > MAX_MARK_ARROWS) throw new ActionError(`${w}.arrows: ${items.length} arrows; keep it to at most ${MAX_MARK_ARROWS}.`);
    const from = x.from;
    if (from !== undefined && from !== "before" && from !== "after") throw new ActionError(`${w}.from must be "before" or "after" (or left out).`);
    const fens = from === "before" ? [m.fenBefore] : from === "after" ? [m.fenAfter] : [m.fenBefore, m.fenAfter];
    const whats = items.map((it: { what: string }) => it.what);
    // The board now (or just after the move) first; failing that, one from earlier in the game, for a move
    // the player looks back on ("Kf7 attacked my rook", "I lost it by playing Nxc5").
    const i = g.moves.indexOf(m);
    const back = from ? [] : g.moves.slice(Math.max(0, i - MARK_LOOKBACK), i).reverse().map((mv) => mv.fenBefore);
    let line = items.length ? drawnLine(fens, whats, variant) : { drawn: [] };
    if ("stuck" in line && back.length) {
      const earlier = drawnLine(back, whats, variant);
      if (!("stuck" in earlier) || earlier.stuck > line.stuck) line = earlier;
    }
    if ("stuck" in line) {
      const k = line.stuck;
      const before = items.slice(0, k).map((it: { what: string }) => it.what);
      throw new ActionError(
        `${w}.arrows: ${items[k].what} can't be drawn ${before.length ? `after ${before.join(" ")}` : ""} from the position ${from === "after" ? "after" : from === "before" ? "before" : "before or after"} ${m.san}${from ? "" : `, or from any of the ${MARK_LOOKBACK} moves before it`}: ${line.why}. List the moves in SAN in the order played, and a piece's attack or defence as "from>to" (\"d4>f3\") from where it stands by then, starting from the board as it is while they think or from just after ${m.san} (or, for moves they look back on, where they were played). What the player named that doesn't hold there can't be drawn: leave it out.`.replace(/\s{2,}/g, " "),
      );
    }
    let k = word;
    let look = word;
    const arrows = line.drawn.map((d, j) => {
      // Each arrow is drawn as its words are said: the move named ("Qxg4"), the square a reach is to (or
      // from), or the words the director gave. One the quote only describes ("I recapture with the knight")
      // follows the one before it a couple of words later.
      const given = wordsAt(items[j].at, `${w}.arrows[${j}]`);
      const said =
        given >= 0
          ? given
          : d.hit
            ? [squareWordAt(quote, d.to, look, next), squareWordAt(quote, d.from, look, next)].find((s) => s >= 0) ?? -1
            : moveWordAt(quote, [items[j].what, d.san], look, next);
      if (said >= 0) {
        k = said;
        look = said + 1;
      } else if (j) k = Math.max(k, Math.min(k + 2, last));
      return { san: d.san, from: d.from, to: d.to, color: d.color, word: k, ...(d.hit && { hit: true }), ...say(items[j].at, given) };
    });
    const sqs = (Array.isArray(x.squares) ? x.squares : []).map((r: unknown) => markItem(r, "sq")).filter((it: { what: string }) => it.what);
    if (sqs.length > MAX_MARK_RINGS) throw new ActionError(`${w}.squares: ${sqs.length} squares; keep it to at most ${MAX_MARK_RINGS}.`);
    const bad = sqs.find((it: { what: string }) => !/^[a-h][1-8]$/i.test(it.what));
    if (bad) throw new ActionError(`${w}.squares: "${bad.what}" isn't a square.`);
    const seen = new Set<string>();
    const rings = sqs.flatMap((it: { what: string; at?: string }, j: number) => {
      const sq = it.what.toLowerCase();
      if (seen.has(sq)) return [];
      seen.add(sq);
      const given = wordsAt(it.at, `${w}.squares[${j}]`);
      const ringWord = given >= 0 ? given : Math.max(word, squareWordAt(quote, sq, word, next));
      return [{ sq, word: ringWord, ...say(it.at, given) }];
    });
    if (!arrows.length && !rings.length) throw new ActionError(`${w}: give it arrows or squares to draw.`);
    let until: number | undefined;
    if (x.until !== undefined && x.until !== null && x.until !== "") {
      const phrase = text(x.until, `${w}.until`, 240)!;
      const lastDrawn = Math.max(word, ...arrows.map((a) => a.word), ...rings.map((r: { word: number }) => r.word));
      const end = phraseEnd(quote, phrase, word);
      if (end < 0) throw new ActionError(`${w}.until must be words of the quote, exactly as they appear ("${phrase}" isn't).`);
      if (end < lastDrawn) throw new ActionError(`${w}.until: "${phrase}" comes before the mark has finished drawing; give words after it.`);
      if (end >= next) throw new ActionError(`${w}.until: "${phrase}" runs into the next mark, which clears the board anyway; leave it out.`);
      until = end;
    }
    // What its words point at: { words: "the pinned knight", to: "e8" }, { words: "f2/g2/h2", to: ["f2", "g2",
    // "h2"] }, or { words: "Rxe8+", to: "Rxe8+" } for one of its moves. Checked against the board in checkRefs.
    const rawRefs = Array.isArray(x.refs) ? x.refs : x.refs === undefined ? [] : null;
    if (!rawRefs) throw new ActionError(`${w}.refs must be a list.`);
    if (rawRefs.length > MAX_MARK_REFS) throw new ActionError(`${w}.refs: ${rawRefs.length} refs; keep it to at most ${MAX_MARK_REFS}.`);
    const taken: [number, number][] = [];
    const refs: ThoughtRef[] = rawRefs.map((r: any, j: number) => {
      const wr = `${w}.refs[${j}]`;
      const phrase = text(r?.words, `${wr}.words`, 160, true)!;
      // The first place the words appear that an earlier ref hasn't taken: a repeat ("the knight" twice)
      // points at the next one.
      let k0 = phraseAt(quote, phrase, word);
      while (k0 >= 0 && k0 <= last && taken.some(([a, b]) => k0 >= a && k0 <= b)) k0 = phraseAt(quote, phrase, k0 + 1);
      if (k0 < 0 || k0 > last) throw new ActionError(`${wr}.words must be words of this mark's part of the quote, exactly as they appear ("${phrase}" isn't${taken.length ? ", or every place it appears is taken by an earlier ref" : ""}).`);
      const words: [number, number] = [k0, phraseEnd(quote, phrase, k0)];
      taken.push(words);
      const to = r?.to;
      const list = (Array.isArray(to) ? to : [to]).map((s: unknown) => str(s).trim());
      if (list.length && list.every((s: string) => /^[a-h][1-8]$/i.test(s))) return { words, sqs: [...new Set(list.map((s: string) => s.toLowerCase()))] };
      // One of this mark's moves, as written in its arrows or as played.
      const key = sanKey(list[0] ?? "");
      const move = arrows.findIndex((a, n) => !a.hit && key && (sanKey(a.san) === key || sanKey(items[n].what) === key));
      if (Array.isArray(to) || move < 0)
        throw new ActionError(`${wr}.to: "${list.join(", ")}" must be a square ("e8"), a list of squares (["f2", "g2"]), or one of this mark's moves (${arrows.filter((a) => !a.hit).map((a) => a.san).join(", ") || "it has none"}).`);
      return { words, move };
    });
    return { at, word, ...(until !== undefined && { until }), arrows, rings, refs };
  });
}

/**
 * The cold open's marks, when the director gave none and the hook quotes a moment of the same move that
 * has them: the marks that fall inside the hook's words, shifted to them.
 */
function hookMarksFrom(moment: VideoMoment | undefined, quote: string | undefined): ThoughtMark[] | undefined {
  if (!moment?.marks?.length || !moment.thought || !quote) return undefined;
  const mw = quoteWords(moment.thought);
  const hw = quoteWords(quote);
  const off = mw.findIndex((_, o) => hw.every((h, j) => mw[o + j] === h));
  if (off < 0) return undefined;
  const inside = (k: number) => k >= off && k < off + hw.length;
  const shift = ([a, b]: [number, number]): [number, number] => [a - off, Math.min(b, off + hw.length - 1) - off];
  const marks = moment.marks
    .filter((mk) => inside(mk.word) && mk.arrows.every((a) => inside(a.word)) && mk.rings.every((r) => inside(r.word)))
    .map((mk) => ({
      ...mk,
      word: mk.word - off,
      ...(mk.until !== undefined && { until: Math.min(mk.until, off + hw.length - 1) - off }),
      arrows: mk.arrows.map((a) => ({ ...a, word: a.word - off, ...(a.say && { say: shift(a.say) }) })),
      rings: mk.rings.map((r) => ({ ...r, word: r.word - off, ...(r.say && { say: shift(r.say) }) })),
      ...(mk.refs && { refs: mk.refs.filter((r) => inside(r.words[0]) && inside(r.words[1])).map((r) => ({ ...r, words: shift(r.words) })) }),
    }));
  return marks.length ? marks : undefined;
}

/**
 * What the video will draw and light up, in words, for the director to check before the plan is final:
 * each quote with its lit words marked, then each idea's drawings and refs, with what they point at on the
 * board as the player imagines it and the colour that gives them (worked out by the same code the video
 * uses). The server's checks catch what can't be right; this is for what can be right but isn't meant.
 */
export function planReadback(g: Game, plan: VideoPlan): string {
  const quotes = [
    ...(plan.hook?.quote && plan.hook.marks ? [{ label: "Cold open", ply: plan.hook.ply, quote: plan.hook.quote, marks: plan.hook.marks }] : []),
    ...plan.moments.flatMap((x) => (x.thought && x.marks?.length ? [{ label: `Ply ${x.ply}`, ply: x.ply, quote: x.thought, marks: x.marks }] : [])),
  ];
  const out: string[] = [];
  for (const q of quotes) {
    const m = g.moves.find((x) => x.ply === q.ply)!;
    const fens = markFens(g, m);
    const colors = markColors(q.quote, q.marks, fens, m.color);
    const tone = (c?: Color) => (!c ? "amber" : c === m.color ? "green" : "red");
    const ws = quoteWords(q.quote);
    const said = ([a, b]: [number, number]) => `"${ws.slice(a, b + 1).join(" ")}"`;
    // The quote, each lit word in [brackets] with its colour.
    const shown = [...ws];
    q.marks.forEach((mk, n) =>
      (mk.refs ?? []).forEach((r, j) => {
        shown[r.words[0]] = `[${shown[r.words[0]]}`;
        shown[r.words[1]] = `${shown[r.words[1]]}](${tone(colors[n].refs[j]?.color)})`;
      }),
    );
    out.push(`${q.label}, ${sideName(g, m.color)} (${m.color === "w" ? "White" : "Black"}) speaking, playing ${m.san}:`, `  ${shown.join(" ")}`);
    q.marks.forEach((mk, n) => {
      const at = imagined(mk, fens);
      const refs = resolveRefs(q.quote, mk, fens, m.color);
      const draws = [
        ...mk.arrows.map((a, j) => {
          const pc = a.hit ? at(a.word).now.get(a.from) : { type: moverKind(a.san), color: a.color };
          return `${a.hit ? `reach ${a.from}→${a.to}` : `arrow ${a.san} (${a.from}→${a.to})`}: ${describe(pc)}, ${tone(colors[n].arrows[j].side)}, on "${ws[a.word]}"`;
        }),
        ...mk.rings.map((r, j) => {
          const k = (mk.refs ?? []).findIndex((x) => x.sqs?.includes(r.sq));
          const c = refs[k];
          const pc = c && "pieces" in c ? c.pieces[mk.refs![k].sqs!.indexOf(r.sq)] : at(r.word).now.get(r.sq);
          return `circle ${r.sq}: ${describe(pc)}, ${tone(colors[n].rings[j].side)}, on "${ws[r.word]}"`;
        }),
      ];
      const words = (mk.refs ?? []).map((r, j) => {
        const c = refs[j];
        if (r.move !== undefined) return `${said(r.words)} → the move ${mk.arrows[r.move].san}, ${tone(mk.arrows[r.move].color)}`;
        const what = (r.sqs ?? []).map((sq, i) => `${sq}: ${"pieces" in c ? describe(c.pieces[i]) : "?"}`).join("; ");
        return `${said(r.words)} → ${what}, ${tone("color" in c ? c.color : undefined)}`;
      });
      out.push(`  Idea ${n + 1}, from "${mk.at}" (the board wipes for it):`, ...draws.map((d) => `    draws ${d}`), ...words.map((w) => `    lights ${w}`));
    });
    out.push("");
  }
  // The engine lines' captions, the same way: lit words and what they point at when the caption shows.
  for (const x of plan.moments) {
    const ln = x.line;
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    const sl = ln && shownLine(g, i, ln.kind);
    if (!ln || !sl || (!ln.caption && !ln.punish)) continue;
    const m = g.moves[i];
    const tone = (c?: Color) => (!c ? "amber" : c === sl.for ? "green" : "red");
    const note = (label: string, caption: string, refs: LineRef[] = [], draw: LineReach[] = [], rings: string[] = [], fen: string, moves: RulesMove[], k: number) => {
      const ws = quoteWords(caption);
      const colors = resolveLineRefs(caption, refs, fen, moves, k, sl.for);
      const shown = [...ws];
      refs.forEach((r, j) => {
        shown[r.words[0]] = `[${shown[r.words[0]]}`;
        shown[r.words[1]] = `${shown[r.words[1]]}](${tone("color" in colors[j] ? colors[j].color : undefined)})`;
      });
      out.push(`  ${label}, after ${moves.slice(0, k).map((mv) => mv.san).join(" ")}:`, `    ${shown.join(" ")}`);
      for (const d of draw) out.push(`    draws reach ${d.from}→${d.to}: ${tone(d.color)}`);
      const board = boardOf(fenAt(fen, moves, k));
      for (const sq of rings) {
        // A circle takes the piece a ref to its square names (one a capture took there, say), else what's there.
        const j = refs.findIndex((r) => r.sqs?.includes(sq));
        const c = colors[j];
        const pc = c && "pieces" in c ? c.pieces[refs[j].sqs!.indexOf(sq)] : board.get(sq);
        out.push(`    circles ${sq}: ${describe(pc)}, ${tone(pc?.color)}${pc && !(board.get(sq)?.type === pc.type && board.get(sq)?.color === pc.color) ? " (gone from there by then, so not shown)" : ""}`);
      }
      refs.forEach((r, j) => {
        const said = `"${ws.slice(r.words[0], r.words[1] + 1).join(" ")}"`;
        const c = colors[j];
        const what = r.move !== undefined ? `the move ${moves[r.move].san}` : (r.sqs ?? []).map((sq, n) => `${sq}: ${"pieces" in c ? describe(c.pieces[n]) : "?"}`).join("; ");
        out.push(`    lights ${said} → ${what}, ${tone("color" in c ? c.color : undefined)}`);
      });
    };
    out.push(`Ply ${x.ply}, the "${ln.kind}" line (green: ${sideName(g, sl.for)}):`);
    if (ln.punish && sl.punish) note("What it allowed", ln.punish.caption, ln.punish.refs, ln.punish.draw, ln.punish.rings, m.fenBefore, sl.punish.moves, ln.punish.at);
    if (ln.caption) note("The line", ln.caption, ln.refs, ln.draw, ln.rings, sl.fen, sl.moves, sl.moves.length);
    out.push("");
  }
  // The asides in the order they're said, and when (by an estimate of the voices), so they can be read
  // through as the conversation the video will play.
  const tl = plannedTimeline(g, plan);
  if (tl.asides.length) {
    const stamp = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    out.push("Asides in the YouTube cut, in the order they're said, timed by an estimate of the voices (★: in the TikTok cut too):");
    for (const a of tl.asides) {
      const m = g.moves[a.i];
      const star = plan.asides?.find((x) => x.ply === m.ply)?.short ? "★ " : "";
      // The move on the board as it starts: its own, or one played before it.
      const over = tl.scenes.find((s) => (s.kind === "move" || s.kind === "illegal") && !("hook" in s && s.hook) && s.start + s.dur > a.start + 0.01);
      const early = over && "i" in over && over.i < a.i ? `, starting ${a.i - over.i} ${a.i - over.i === 1 ? "ply" : "plies"} early, over ${moveNo(g.moves[over.i].ply)} ${g.moves[over.i].san}` : "";
      out.push(`  ${star}${stamp(a.start)} ${sideName(g, m.color)} (${moveNo(m.ply)} ${m.san}${early}): "${a.text}"`);
    }
    out.push("");
  }
  return out.join("\n");
}

/** A delivery direction for the voice: a few words, no brackets (the voice engine adds its own). */
function delivery(raw: unknown, where: string): string | undefined {
  const s = text(raw, where, 60);
  if (!s) return undefined;
  if (/[[\]<>]/.test(s)) throw new ActionError(`${where}: just the words, no brackets.`);
  if (words(s) > 8) throw new ActionError(`${where} is ${words(s)} words; keep it to at most 6.`);
  return s;
}
