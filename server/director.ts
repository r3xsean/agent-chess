import type { Classification, Color, Game, LineBeat, LineBranch, LineReach, LineRef, MoveRecord, ThoughtMark, ThoughtRef, VideoAside, VideoHook, VideoMoment, VideoPackaging, VideoPackagingOptions, VideoPlan } from "../shared/types";
import type { VoiceManifest } from "../shared/voices";
import { speakable } from "../shared/speech";
import { triesOf } from "../shared/explain";
import { buildTimeline, LINE_SLIDE, silences, type Scene } from "../web/src/video/timeline";
import { humanSide, isHuman, sideName } from "../shared/naming";
import { formatScore, winPercentFor } from "../shared/evalmath";
import { beliefs } from "../shared/belief";
import { rivalry, seriesLine } from "./rivalry";
import { spokenText, VOICE_BUDGET } from "./voice";
import { LATE_INTERVIEW_CHARS, lineSig, lineVoice, videoLines, voiceOf } from "../shared/videoLines";
import { asciiBoard, describePlayer, pvSan } from "./briefing";
import { modelAnalytics } from "./analytics";
import { variantOf, type RulesMove } from "../shared/rules";
import { ActionError, isRated } from "./game";
import { branchOptions, fenAt, lineOptions, lineRefProblems, lineVerdicts, obvious, planBranch, planLine, resolveLineRefs, shownLine, type ShownBranch, type ShownLine } from "../shared/engineLine";
import { walk } from "../shared/why";
import { investigated, PROBE_COMMANDS } from "./probe";
import { mustUnderstand, questionLines, questionWeight, understandLines } from "./lineQuestions";
import { moveFacts } from "../shared/lineFacts";
import { leftEnPrise } from "./wintr";
import { boardOf, describe, drawnLine, imagined, isHit, markColors, moverKind, moveWordAt, phraseAt, phraseEnd, quoteWords, refProblems, resolveRefs, sanKey, squareWordAt } from "../shared/thoughtMarks";

/*
 * After the game a video director (its own task, apart from the broadcaster) reads the whole game and picks the
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

/** How many of each title, caption and thumbnail the director offers the user. */
const PACKAGING_OPTIONS = { min: 3, max: 5 };

const PACKAGING_EXAMPLE = {
  titles: [
    "GPT-6 Astra traps Sonnet's rook… and Sonnet doesn't notice for 10 moves",
    "Sonnet called its rook \"totally safe\". GPT-6 Astra disagreed",
    "Sonnet vs GPT-6 Astra: the rook that had nowhere to go",
  ],
  captions: ["Sonnet was SO sure that rook was safe 💀 #chess #ai", "POV: your rook is \"totally safe\" #chess #ai #chesstok", "Count how long it takes Sonnet to notice 👀 #chess #ai"],
  thumbnails: [
    { ply: 54, text: "TOTALLY SAFE" },
    { ply: 56, text: "NOWHERE TO GO" },
    { ply: 50, text: "SONNET IS WINNING" },
  ],
};

/** How to write the packaging (the full plan's brief and the packaging-only one share it); the first line follows "packaging:". */
const PACKAGING_RULES = [
  `options for the user to pick from, your favourite first. \`titles\`: ${PACKAGING_OPTIONS.min}–${PACKAGING_OPTIONS.max} YouTube titles (each at most 80 characters, the story not the notation, names the models). \`captions\`: ${PACKAGING_OPTIONS.min}–${PACKAGING_OPTIONS.max} TikTok captions (each at most 150 characters, may end with a few hashtags). \`thumbnails\`: ${PACKAGING_OPTIONS.min}–${PACKAGING_OPTIONS.max}, each the move whose position makes it (\`ply\`) and at most 4 words of big text (\`text\`).`,
  "- Make them real alternatives, not rewordings of one idea: give each title, caption and thumbnail its own angle on the story (the stakes, the twist, a player's own words or false confidence, the rivalry, the absurdity). The user sees them side by side and picks one title, one caption and one thumbnail, so near-twins waste the choice. Every option must follow every rule here: none is a throwaway.",
  "- Selling the video without spoiling it: the title, thumbnail and caption are what people see before they click. They may name the twist (the blunder, the trap, the comeback), because the viewer still wants to see how it happened, but never the ending: who won, that it was drawn, or that someone escaped. A title and a thumbnail should make a pair that never says the same thing twice: make your favourite title and favourite thumbnail one, and give every other thumbnail at least one of your titles it pairs with. One sets up the stakes (who was winning, how sure they were) and the other delivers the turn. The thumbnail shows the position after its move with that move's engine verdict icon (a blunder's ?? already says something went wrong). When the title names the twist, the thumbnail sells the stakes instead of showing the punishment again: the winning side's last strong move before the turn (\"MATE IN 24…\"), or the blunder with the mover's false confidence (\"TOTALLY SAFE\"). When the title only sets things up, the punishment itself can be the thumbnail.",
];

export function directorBrief(g: Game): string {
  const name = (c: Color) => sideName(g, c);
  const human = humanSide(g);
  const out: string[] = [
    "VIDEO DIRECTOR — plan the replay video of this game.",
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
    ...characterLines(g),
    "",
    "## Interviews",
  ];
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const iv = g.interviews[when][c];
      if (iv) out.push(`${when === "pre" ? "Pre-game" : "Post-game"}, ${name(c)} (${colorName(c)}): ${iv.text}`, "");
    }

  out.push(...shapeLines(g), "", ...showpieceLines(g), "");
  out.push(
    "## Asking the engine",
    "Before you choose a line, find out why it is what it is. From any position of the game or of a line, as often and as deep as you need:",
    ...PROBE_COMMANDS.split("\n"),
    "What a sacrifice is for (probe it being taken), what a quiet move threatens (threat), whether the losing side had any way out (options: when even its best move loses the piece, nothing saves it). Open every candidate line this way, the ones below the top of the list too, before you choose: the strongest story is often a line that doesn't look best at first. A line whose why you can see and say is the one worth the video's time.",
    "",
  );

  out.push("## The game, move by move", "(eval and win% are White's view, win% before → after the move; self-eval is what the mover believed)", "");
  const belief = beliefs(g);
  g.moves.forEach((m, i) => {
    const a = m.analysis;
    const verdict = a ? `${a.classification}${a.bestSan && a.bestSan !== m.san ? `, engine preferred ${a.bestSan} (${pvSan(m.fenBefore, g.analysis[m.fenBefore]?.pv, 6, variantOf(g))})` : ""}` : "unrated";
    const ww = whiteWin(m);
    const win = ww ? ` (win% ${Math.round(ww.before)}→${Math.round(ww.after)})` : "";
    out.push(`ply ${m.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict}; eval ${formatScore(a?.evalAfter)}${win}; self-eval ${m.selfEvalRaw || "—"}; thought ${thinkTime(m.thinkMs)}`);
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
    for (const l of lineOptions(g, i)) {
      out.push(
        `  line option "${l.kind}" (${l.moves.length} moves): ${lineMoves(g, l.moves)} → ${l.fact}${l.punish ? `; allows: ${lineMoves(g, l.punish.moves.slice(1))} → ${l.punish.fact}` : ""}`,
      );
      for (const b of branchOptions(g, l).slice(0, 2)) out.push(`    branch: ${b.question} ${lineMoves(g, b.moves)} → ${b.fact}`);
    }
    if (m.illegalAttempts.length) out.push(`  tried illegal moves first: ${m.illegalAttempts.join(", ")}`);
    triesOf(m.illegalAttempts, m.tries).forEach((t, n) => {
      if (t?.commentary.trim()) out.push(`  said with illegal attempt ${m.illegalAttempts[n]}: ${t.commentary.trim()}`);
    });
    if (m.offeredDraw) out.push(`  offered a draw with this move`);
    if (m.commentary.trim()) out.push(`  commentary: ${m.commentary.trim()}`);
    for (const b of g.broadcast.filter((l) => l.ply === m.ply && l.ts <= (g.endedAt ?? Infinity))) out.push(`  broadcaster said: ${b.text}`);
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
        quiet: [88],
        interviewLines: { pre: { w: "…", b: "…" }, post: { w: "…", b: "…" } },
        interviewDelivery: { pre: { w: "cocky", b: "measured" }, post: { w: "rueful", b: "gracious" } },
        hook: { ply: 55, quote: "…exact sentences from ply 55's commentary…", delivery: "breezy, totally sure", caption: "Black thinks the rook is safe. It's already lost." },
        packaging: PACKAGING_EXAMPLE,
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
    "- line (optional): play an engine line out on the board right after this move, then hold on your `caption`. Use it where the viewer has to see what didn't happen to understand the moment: `instead` plays what the engine wanted in place of this move (what a miss missed, what a blunder should have been); `after` plays the engine's best play from the position this move left, for when the game went another way (the punishment the reply didn't find, or the point of a brilliant or great move that never got played out). The options listed under a move as `line option` are the ones worth offering; when the user asks for a what-if on a move with none listed, you can still give that move an `instead` or `after` line, and the engine's line is shown as long as the game went another way. Lines are where the video shows what the players couldn't see, so don't leave the good ones out: a `miss` at importance 2–3 needs its `instead` line (without it the viewer can't see what was missed); on a thrown-away win, the `instead` on the move that threw it shows how close it was; a tactic nobody played (a blunder's `after`, when the reply missed it) is the ghost of the game and usually worth showing; an unsound sacrifice that worked gets the defence that would have refuted it; a great or brilliant move whose point never got played out gets its `after`. Skip a line when the real moves play it out anyway. A blunder's `after` and the reply's `instead` are often the same line: show it once, on whichever moment tells the story better. Pick at most three, and only where the line shows what the viewer can't get from the move and its best-move arrow: the lines worth narrating are ranked above (`## Lines worth narrating`), and the biggest turning point gets its line when it has one. A game with no line options listed has none. Each one costs the viewer a few seconds, and in the TikTok cut only importance 2–3 moments show theirs.",
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
    "- The narration over each line (what the narrator says, where the board moves on the words, how far the line runs, whether it plays before the move) is written by your narrator once the plan is saved (see your instructions), so leave `beats`, `end`, `first` and `branches` out here: choose the lines, and say in each moment's `why` what its line is for.",
    "- line.caption (optional, one line, at most 14 words; with beats, usually left out): why the side the line favours is better at its end, in your own words and grounded in the moves listed: the fork, the overloaded queen, the back rank, the pawn that can't be stopped. Say what it wins (or, for an `instead` line that just keeps everything, what the move played gave away), but never a tactic or square the line doesn't show. Leave it out and the listed fact is shown instead.",
    "  - line.squares, line.draw, line.refs: what the board shows with the caption, at the end of the line, as in marks. The line's moves are played out on the board, but nothing else is drawn unless you say: `squares` circles pieces or squares (\"e6\"), each up while its piece stays there; `draw` adds a piece's attack or defence as \"from>to\" (\"e6>e2\": the rook guarding the pawn), checked against the board. `refs`: every word of the caption that names a square, a move or a piece goes in a ref saying what it points at: { \"words\": \"the rook\", \"to\": \"e6\" }, or one of the line's moves: { \"words\": \"Kg4\", \"to\": \"Kg4\" }. A square a ref points at must be drawn: circled, at an end of a reach, or where one of the line's moves went from or to (a piece the line takes can be pointed at where it was taken). Those words light up in the colour of what they point at: green for the side the line favours, red for the other, amber for an empty square. A caption without refs lights nothing.",
    "  - line.punish (an `instead` line listed with `allows:` only, optional): before the line, the video plays what the move played allowed (the moves after `allows:`) and explains it, then winds the board back for the line. Use it when the reason the move was bad isn't obvious from the better line alone, which is most of the time: a fork, a skewer, the back rank, a piece left loose. In your own words, say what the punishment does: { \"at\": \"Nd4+\", \"caption\": \"Nd4+ forks the king and the rook.\", \"draw\": [\"d4>f3\", \"d4>e6\"], \"squares\": [\"f3\", \"e6\"], \"refs\": [{ \"words\": \"Nd4+\", \"to\": \"Nd4+\" }, { \"words\": \"king\", \"to\": \"f3\" }, { \"words\": \"rook\", \"to\": \"e6\" }] }. `at` is the move after which the caption shows and the board pauses on it (by default the last); `squares`, `draw` and `refs` work as for the line, on the board right after `at`, and the moves on the board then include the move played. A circled piece comes off when it moves or is taken, so the rook circled at the fork disappears when the knight takes it. Say only what those moves show, and draw the idea (the fork's two reaches, the pin through the piece, the mating square), not every move. Then the line's own caption can build on it (\"Kg4 instead: no fork, and the rook stays safe\").",
    "- asides: lines said in passing while the game plays on, in the player's own voice, with nothing drawn. The board doesn't stop for them: each is said as its move lands, and the next moves play on under it, often several of them before the line ends. So an aside must stay true while the board moves on: a plan, a verdict on the position, a worry, an attitude, a read on the opponent, a habit, what they're aiming for over the next few moves, a line that comes back later (\"Queens are off and the queenside is where the game will be decided\", \"I am still worse, but fewer pawns improve my defensive chances\", \"Knight check Ne2+ is the one trick to watch\"). Never a line about the move itself or a tactic that's only there for one move (\"Rook to the open c-file\", \"...Kg8 is safest\", \"So ...Nxe4 regains the pawn\", \"Now ...Rb8 attacks the b5 pawn\"): three moves later the voice would still be explaining a position that's gone. A single-move thought worth hearing is a moment (importance 1 if it's minor), where the game stops for it; otherwise leave it out. Each is { \"ply\": 7, \"quote\": \"…\", \"delivery\": \"…\" } (delivery optional), quoted exactly from that move's `commentary:` (or from what was `said with illegal attempt` on it), at most 25 words. Not on a ply that's one of your moments, nor on the last move.",
    "  - Open with a short exchange: 4–6 asides over the first 10–16 plies, the two players taking turns, so the opening has them talking about who they are and what they're going for (an opening choice and why, how they see the opponent, the kind of game they want), not narrating the moves (\"I take space in the center\" is the move, not the player). Where asides come one after another, each move waits for the line before it, so keep those short.",
    `  - Every aside is in the YouTube cut. Mark the ones the TikTok cut says too with \`"short": true\`: it shows only your importance 2–3 moments and its quiet moves fly by, so the short's asides are what keep it talking between them. Pick the ones that set up your headline moments or carry the most personality, one or two from the opening, and enough that the short never goes more than ${MAX_SILENCE.portrait} seconds with nothing said (the server checks this too). At most ${MAX_SHORT_ASIDES}.`,
    "  - An illegal attempt gets an aside on its move: usually the player owning up to it (the move's commentary often does), or what they meant by it. It's said while the rejected move is on the board.",
    "  - An aside that runs into the next moment holds the board until it's said (it's never said before its own move), so a long aside just before a moment delays it.",
    `  - The video shouldn't go quiet for long: from the first move to the result, at most ${MAX_SILENCE.landscape} seconds in the YouTube cut (${MAX_SILENCE.portrait} in the short) may pass with nothing said (no quote, aside or engine line on screen). The server works out the video's timing and sends the plan back with every silent stretch, by ply: fill each with an aside that holds, or a moment where one belongs. Where nothing said in a stretch holds beyond its own move, don't force one in: list a ply from that stretch in \`quiet\` (\"quiet\": [57, 92]) and the stretch is left as it is.`,
    "- interviewLines: for each interview, quote one to three consecutive sentences exactly, at most 40 words.",
    "- hook (required): the cold open. Both videos start on this moment before rewinding to the start, so it's what decides whether a viewer keeps watching. Pick the most shocking payoff, and fit it to the kind of game: for a built attack, the shot with the attacker's calculation (not the defender's mistake); for a swindle, the winning side's most confident line just before it turns; for a thrown-away win, the leader's line on the move that throws it; otherwise usually the blunder with the mover's most confident line, or the reaction after it. `quote` comes from that move's commentary like any quote (at most 40 words; leave it out on a human's move). `caption` is on-screen text of at most 12 words that makes the viewer need to see how it happened, without notation: \"Sonnet thinks it's winning. It's getting mated in one.\"",
    ...PACKAGING_RULES.map((l, n) => (n ? l : `- packaging (required): ${l}`)),
    `- Everything spoken (quotes, asides, hook, interview lines, the narrator's beats) is voiced, and together it must stay under ${VOICE_BUDGET} characters. Plans that follow the limits above fit easily.`,
    "If the server rejects the plan it says why; fix it and submit again. Once it passes, it's read back to you: every quote with its lit words, every drawing and ref with what it points at on the board and its colour, and when each aside is said. Check each line against what the player meant (and that the asides read in order as a conversation), then run `confirm` to save it, or fix the plan and submit it again. Saving it completes your task.",
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

/**
 * Who the players are beyond their names: each model's record across its rated games, this one included:
 * material for the narrator and the titles.
 */
function characterLines(g: Game): string[] {
  const out: string[] = ["", "## The players"];
  for (const c of ["w", "b"] as Color[]) {
    const p = c === "w" ? g.white : g.black;
    const who = `${sideName(g, c)} (${colorName(c)})`;
    if (isHuman(p)) {
      out.push(`${who}: a human player.`);
      continue;
    }
    out.push(`${who}: an AI model.`);
    const a = modelAnalytics(p.model, "rated");
    if (!a || !a.row.games) continue;
    const r = a.row;
    const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x)}%`);
    const num = (x: number | null, d = 1) => (x === null ? "—" : `${Math.round(x * 10 ** d) / 10 ** d}`);
    const form = a.form.last.map((f) => f.result).join("");
    const res = a.mind.resign;
    out.push(
      `  Its record over ${r.games} rated game${r.games === 1 ? "" : "s"}${isRated(g) ? " (this one included)" : ""}: ${r.record.wins}W ${r.record.draws}D ${r.record.losses}L${r.rating ? `, rated ${r.rating}` : ""}${form ? `, recent form ${form} (newest last)` : ""}; plays like ${r.estElo ?? "—"} Elo at ${pct(r.accuracy)} accuracy; ${num(r.blundersPer100)} blunders and ${num(r.illegalPer100)} illegal tries per 100 moves; its own eval is off from the engine's by ${num(r.calibration, 0)} points of win% on average (too optimistic on ${pct(a.mind.over)} of moves, too pessimistic on ${pct(a.mind.under)})${res.count ? `; resigned ${res.count} time${res.count === 1 ? "" : "s"}, ${res.count - res.justified} too early` : ""}.`,
    );
  }
  return out;
}

/**
 * How much a line is worth narrating: how much of the game it swung (the winning chances a move threw away,
 * or a reply let go), plus what makes it hard to see (a brilliant or only move in it, a mate, a quiet first
 * move), with the reasons in words.
 */
function lineWorth(g: Game, i: number, l: ShownLine): { score: number; why: string[] } {
  const m = g.moves[i];
  const a = m.analysis!;
  const name = (c: Color) => sideName(g, c);
  const why: string[] = [];
  let swing = 0;
  if (l.kind === "instead") {
    swing = Math.max(0, a.winBefore - a.winAfter);
    why.push(`${m.san} threw away ${Math.round(swing)} points of ${name(m.color)}'s winning chances`);
  } else if (l.for !== m.color) {
    const reply = g.moves[i + 1]?.analysis;
    swing = reply ? Math.max(0, 100 - a.winAfter - reply.winAfter) : 0;
    why.push(`${name(l.for)} could have gained ${Math.round(swing)} points here and didn't`);
  } else {
    swing = 15;
    why.push(`the point of ${m.san}, never played out`);
  }
  const vs = lineVerdicts(g, l.moves);
  let hard = 0;
  if (vs.includes("brilliant")) (hard += 25), why.push("it has a brilliant move");
  else if (vs.includes("great")) (hard += 15), why.push("it has an only move");
  if (l.mate) (hard += 10), why.push(`it ends in mate in ${l.mate}`);
  if (!l.moves[0].captured && !/[+#]/.test(l.moves[0].san)) (hard += 10), why.push("it starts with a quiet move");
  const q = questionWeight(g, l);
  if (q.top) (hard += q.weight), why.push(`it raises a question worth answering on the board: ${q.top.question} → ${q.top.answer}`);
  return { score: swing + hard, why };
}

/** The game's lines ranked by what they're worth narrating, the same line offered twice counted once. */
function rankedLines(g: Game): { i: number; l: ShownLine; score: number; why: string[] }[] {
  const seen = new Set<string>();
  const out: { i: number; l: ShownLine; score: number; why: string[] }[] = [];
  g.moves.forEach((_, i) => {
    for (const l of lineOptions(g, i)) {
      const sig = `${l.fen}|${l.moves.map((mv) => mv.uci).join(" ")}`;
      const w = lineWorth(g, i, l);
      const had = out.findIndex((x) => `${x.l.fen}|${x.l.moves.map((mv) => mv.uci).join(" ")}` === sig);
      if (had >= 0) {
        if (w.score > out[had].score) out[had] = { i, l, ...w };
        continue;
      }
      seen.add(sig);
      out.push({ i, l, ...w });
    }
  });
  return out.sort((a, b) => b.score - a.score);
}

/** A line's code, as the engine questions name its positions ("42a3" → "42a"). */
const lineCode = (g: Game, i: number, kind: "instead" | "after") => `${g.moves[i].ply}${kind === "after" ? "a" : "i"}`;

/**
 * What the director has investigated, for its plan's readback: the lines it chose without asking the engine
 * about them, and the strong lines it never looked at (a line ruled out should be one probed and found weaker).
 * A line counts as looked at when any position of it, or of its move in the game, was asked about.
 */
export function investigationNotes(g: Game, plan: VideoPlan): string[] {
  const inv = investigated(g.id, "director");
  const seen = (i: number, kind: "instead" | "after") => inv.lines.has(lineCode(g, i, kind)) || inv.plies.has(g.moves[i].ply);
  const chosen = plan.moments.flatMap((x) => {
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    return x.line ? [{ i, kind: x.line.kind }] : [];
  });
  const unprobed = chosen.filter((c) => !seen(c.i, c.kind));
  const skipped = rankedLines(g)
    .slice(0, SHOWPIECES)
    .filter((x) => !chosen.some((c) => c.i === x.i && c.kind === x.l.kind) && !seen(x.i, x.l.kind));
  const name = (i: number, kind: string) => `ply ${g.moves[i].ply} ${moveNo(g.moves[i].ply)} ${g.moves[i].san} ("${kind}", ${lineCode(g, i, kind as "instead" | "after")}0)`;
  return [
    `Your investigation so far: ${inv.count} engine question${inv.count === 1 ? "" : "s"}${inv.lines.size ? `, about lines ${[...inv.lines].join(", ")}` : ""}.`,
    ...(unprobed.length ? [`⚠ Lines in this plan you haven't asked the engine about: ${unprobed.map((c) => name(c.i, c.kind)).join("; ")}. Probe them: you can't hand over their why without seeing it.`] : []),
    ...(skipped.length
      ? [`⚠ Strong lines you haven't looked at: ${skipped.map((x) => name(x.i, x.l.kind)).join("; ")}. A line you leave out should be one you probed and found weaker, not one you never opened.`]
      : []),
  ];
}

/** What the narrator has investigated, for its narration's readback: the plan's lines it hasn't asked the engine about yet. */
export function narratorInvestigationNotes(g: Game, plan: VideoPlan): string[] {
  const inv = investigated(g.id, "narrator");
  const unprobed = plan.moments.flatMap((x) => {
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    return x.line && !inv.lines.has(lineCode(g, i, x.line.kind)) && !inv.plies.has(x.ply) ? [`ply ${x.ply} ${moveNo(x.ply)} ${g.moves[i].san} (${lineCode(g, i, x.line.kind)}0)`] : [];
  });
  return [
    `Your investigation so far: ${inv.count} engine question${inv.count === 1 ? "" : "s"}${inv.lines.size ? `, about lines ${[...inv.lines].join(", ")}` : ""}.`,
    ...(unprobed.length ? [`⚠ Lines you're narrating without having asked the engine about them: ${unprobed.join("; ")}. Look before you tell the viewer why.`] : []),
  ];
}

/** How many of the game's strongest lines the brief lists (the video takes as many as its story needs). */
const SHOWPIECES = 6;

function showpieceLines(g: Game): string[] {
  const top = rankedLines(g).slice(0, SHOWPIECES);
  if (!top.length) return [];
  return [
    "## Lines worth narrating",
    "(the strongest of the engine lines, best first: the biggest swings and the moves hardest to find; a line the move's best-move arrow already shows isn't offered at all. This is not a limit: the video takes as many lines as its story needs, and any line option in the game below can be one. Look into each of these before you narrow them down. A line with a `branch:` listed under it raises a question a viewer would ask (why not the natural move? what if they try this instead?), and the narration answers it on the board, branch and all, so such a line makes the strongest showpiece: give its moment importance 3 and say in its `why` what question the line answers)",
    ...top.flatMap((x, n) => [
      `${n + 1}. ply ${g.moves[x.i].ply}, ${moveNo(g.moves[x.i].ply)} ${g.moves[x.i].san}, "${x.l.kind}": ${x.l.moves.map((mv) => mv.san).join(" ")} → ${x.l.fact}. Why: ${x.why.join("; ")}.`,
      ...questionLines(g, x.l, 4).map((s) => `   ${s}`),
    ]),
  ];
}

/** How long a move took: "8 s", "2 min 40 s". */
function thinkTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

/**
 * An engine line's moves for the brief, each with its verdict where it isn't simply the engine's best
 * (great: the only move; brilliant: a sound sacrifice; forced: the only legal move; a game move keeps its
 * own), and the eval it ends on.
 */
function lineMoves(g: Game, moves: RulesMove[]): string {
  const vs = lineVerdicts(g, moves);
  const end = moves.length ? g.analysis[moves[moves.length - 1].after]?.score : undefined;
  return `${moves
    .map((mv, k) => {
      const notes = [vs[k] && vs[k] !== "best" ? vs[k] : "", moveFacts(mv)].filter(Boolean).join("; ");
      return notes ? `${mv.san} (${notes})` : mv.san;
    })
    .join(" ")}${end ? ` [ends at ${formatScore(end)}]` : ""}`;
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

export function validatePlan(g: Game, raw: unknown, existing?: VideoPlan): VideoPlan {
  const notes: string[] = [];
  markNotes = notes;
  try {
    const plan = checkPlan(g, raw, existing);
    if (notes.length) planNotes.set(plan, notes);
    return plan;
  } finally {
    markNotes = null;
  }
}

function checkPlan(g: Game, raw: unknown, existing?: VideoPlan): VideoPlan {
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
    if (existing?.moments.includes(x)) return x;
    const prev = existing?.moments.find((m) => m.ply === ply);
    const importance = int(x.importance);
    if (![1, 2, 3].includes(importance)) throw new ActionError(`${where}: importance must be 1, 2 or 3.`);
    const why = str(x.why).trim();
    if (!why) throw new ActionError(`${where}: say why it matters.`);
    const thought = moveQuote(g, m, x.quote ?? x.thought, where, 70, 60, 480);
    const chapter = text(x.chapter, `${where}.chapter`, 60);
    const line = prev && x.line === prev.line ? prev.line : lineChoice(g, g.moves.indexOf(m), x.line, where);
    const marks = prev && thought === prev.thought && x.marks === prev.marks ? prev.marks : thoughtMarks(g, m, thought, x.marks, where);
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
  let hook: VideoHook;
  if (existing?.hook && h === existing.hook) hook = existing.hook;
  else {
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
  hook = {
    ply: hookMove.ply,
    quote: hookQuote,
    delivery: delivery(h.delivery, "hook.delivery"),
    caption: text(h.caption, "hook.caption", 120, true)!,
    ...(hookMarks && { marks: hookMarks }),
  };
  if (words(hook.caption) > 14) throw new ActionError(`hook.caption is ${words(hook.caption)} words; keep it to at most 12.`);
  }

  // Titles, captions and thumbnails to pick from; the favourites are used until the user picks.
  const keepPackaging = !!existing && p.packaging === existing.packaging;
  const packagingOptions = keepPackaging ? existing.packagingOptions : packagingChoices(g, p.packaging);
  const packaging = keepPackaging ? existing.packaging : favourites(packagingOptions!);

  const asides = asideList(g, p.asides, moments);
  if (p.quiet !== undefined && p.quiet !== null && !Array.isArray(p.quiet)) throw new ActionError("`quiet` must be a list of plies.");
  const quiet = [...new Set(((p.quiet ?? []) as unknown[]).map((x, n) => moveAt(g, x, `quiet[${n}]`).ply))].sort((a, b) => a - b);
  if (quiet.length > MAX_QUIET) throw new ActionError(`${quiet.length} plies in \`quiet\`; keep it to at most ${MAX_QUIET}, one per stretch.`);
  const plan: VideoPlan = { moments, ...(asides && { asides }), ...(quiet.length && { quiet }), interviewLines, interviewDelivery, hook, packaging, packagingOptions, createdAt: Date.now() };

  // Every line is spoken in the player's voice, which is paid by the character: a plan that passes here
  // always gets its voices, so the limit is enforced now, while the director can still trim.
  const spoken = new Set<string>();
  for (const l of videoLines({ ...g, video: plan })) {
    const voice = lineVoice(g, l);
    if (voice) spoken.add(`${voice}|${spokenText(l.text, l.delivery)}`);
  }
  // Room for interviews not given yet: they'll be cut to at most LATE_INTERVIEW_CHARS of speech each.
  let late = 0;
  for (const when of ["pre", "post"] as const) for (const c of ["w", "b"] as Color[]) if (!g.interviews[when][c] && voiceOf(g, c)) late += LATE_INTERVIEW_CHARS;
  const total = [...spoken].reduce((n, s) => n + s.length - s.indexOf("|") - 1, 0) + late;
  if (total > VOICE_BUDGET)
    throw new ActionError(
      `Together the quotes, asides, hook, interview lines and narrator beats come to ${total} characters of speech; keep them under ${VOICE_BUDGET}. Shorten the longest quotes, asides and beats, or drop the quotes from a few importance-1 moments.`,
    );

  const silent = silentStretches(g, plan, "landscape");
  if (silent.length)
    throw new ActionError(
      `The YouTube cut goes more than ${MAX_SILENCE.landscape} s with nothing said here:\n${silent.map((q) => `- ${q}`).join("\n")}\nFill each with an aside that holds while the board moves on (or a moment, where one belongs). If nothing said there holds beyond its own move, list a ply from the stretch in \`quiet\` instead.`,
    );
  const silentShort = silentStretches(g, plan, "portrait");
  if (silentShort.length)
    throw new ActionError(
      `The TikTok cut goes more than ${MAX_SILENCE.portrait} s with nothing said here:\n${silentShort.map((q) => `- ${q}`).join("\n")}\nFill each by marking an aside from the plies in it \`"short": true\` (or adding one that holds), so the short says it too. If nothing said there holds beyond its own move, list a ply from the stretch in \`quiet\` instead.`,
    );
  return plan;
}

/** The director's titles, captions and thumbnails: 3–5 of each, all different, each within its limits. */
export function packagingChoices(g: Game, raw: unknown): VideoPackagingOptions {
  const pk = raw as any;
  const shape = `{ "titles": [...], "captions": [...], "thumbnails": [{ "ply": 54, "text": "..." }, ...] }`;
  if (!pk || typeof pk !== "object") throw new ActionError(`The plan needs \`packaging\`: ${shape}.`);
  if (!Array.isArray(pk.titles) && (pk.title || pk.thumbnail)) throw new ActionError(`\`packaging\` takes several options of each now, your favourite first: ${shape}.`);
  const list = <T>(key: string, one: (x: unknown, where: string) => T, sig: (x: T) => string): T[] => {
    const xs = pk[key];
    const { min, max } = PACKAGING_OPTIONS;
    if (!Array.isArray(xs) || xs.length < min || xs.length > max) throw new ActionError(`packaging.${key}: give ${min}–${max} of them, your favourite first${Array.isArray(xs) ? ` (you gave ${xs.length})` : ""}.`);
    const out = xs.map((x, n) => one(x, `packaging.${key}[${n}]`));
    const seen = new Map<string, number>();
    out.forEach((x, n) => {
      const k = sig(x);
      if (seen.has(k)) throw new ActionError(`packaging.${key}[${n}] is the same as packaging.${key}[${seen.get(k)}]: make each one different.`);
      seen.set(k, n);
    });
    return out;
  };
  const lower = (s: string) => s.toLowerCase();
  return {
    titles: list(
      "titles",
      (x, where) => {
        const t = text(x, where, 100, true)!;
        if (/[<>]/.test(t)) throw new ActionError(`${where}: YouTube doesn't allow < or > in a title.`);
        return t;
      },
      lower,
    ),
    captions: list("captions", (x, where) => text(x, where, 220, true)!, lower),
    thumbnails: list(
      "thumbnails",
      (x: any, where) => {
        const t = text(x?.text, `${where}.text`, 40, true)!;
        if (words(t) > 5) throw new ActionError(`${where}.text is ${words(t)} words; keep it to at most 4.`);
        return { ply: moveAt(g, x?.ply, where).ply, text: t };
      },
      (x) => `${x.ply}|${lower(x.text)}`,
    ),
  };
}

/** The director's favourite of each: what the upload uses until the user picks. */
export const favourites = (o: VideoPackagingOptions): VideoPackaging => ({ title: o.titles[0], caption: o.captions[0], thumbnail: o.thumbnails[0] });

/** The options as the director gave them, for it to check (and for the packaging command's answer). */
export function packagingReadback(g: Game, o: VideoPackagingOptions): string {
  const move = (ply: number) => {
    const m = g.moves.find((x) => x.ply === ply)!;
    return `after ${moveNo(ply)} ${m.san} by ${sideName(g, m.color)}${m.analysis?.classification ? ` (${m.analysis.classification})` : ""}`;
  };
  return [
    "YouTube titles:",
    ...o.titles.map((t, n) => `  ${n + 1}. ${t}  (${t.length} characters)`),
    "TikTok captions:",
    ...o.captions.map((t, n) => `  ${n + 1}. ${t}  (${t.length} characters)`),
    "Thumbnails:",
    ...o.thumbnails.map((t, n) => `  ${n + 1}. "${t.text}", ${move(t.ply)}`),
  ].join("\n");
}

/**
 * The brief for new titles, captions and thumbnails on a game whose plan is already made: the game's
 * shape, the plan's story (its cold open and moments) and the options it has now, without re-planning anything.
 */
export function packagingBrief(g: Game): string {
  const plan = g.video!;
  const name = (c: Color) => sideName(g, c);
  const verdict = (m: MoveRecord) => `${m.analysis?.classification ?? "unrated"}; eval ${formatScore(m.analysis?.evalAfter)}`;
  const at = (ply: number) => g.moves.find((m) => m.ply === ply);
  const out: string[] = [
    "VIDEO PACKAGING — new titles, captions and thumbnails for this game's replay video.",
    "",
    "The video itself is planned and stays as it is. What's being redone is what people see before they click: the YouTube title, the TikTok caption and the thumbnail. You give several options of each, and the user picks one of each.",
    "",
    `Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.`,
    `Opening: ${g.opening?.name ?? "unknown"}. Result: ${g.result} (${g.termination}).`,
    ...historyLines(g),
    "",
    ...shapeLines(g),
    "",
    "## The video's story",
    "(the plan's cold open and moments; `why` is the director's note on why each matters)",
  ];
  if (plan.hook) {
    const m = at(plan.hook.ply);
    out.push(`Cold open: ply ${plan.hook.ply}${m ? `, ${moveNo(m.ply)} ${m.san} by ${name(m.color)} (${verdict(m)})` : ""}. On screen: "${plan.hook.caption}"${plan.hook.quote ? ` Said: "${plan.hook.quote}"` : ""}`);
  }
  for (const x of plan.moments) {
    const m = at(x.ply);
    if (!m) continue;
    out.push(`ply ${x.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict(m)}; importance ${x.importance}. ${x.why}${x.thought ? `\n  said: "${x.thought}"` : ""}`);
  }
  // Big verdicts the plan didn't make moments of can still make a thumbnail.
  const big = g.moves.filter((m) => !plan.moments.some((x) => x.ply === m.ply) && ["brilliant", "great", "miss", "mistake", "blunder"].includes(m.analysis?.classification ?? ""));
  if (big.length) out.push("", "Other moves with a big verdict:", ...big.map((m) => `ply ${m.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict(m)}`));
  const now = plan.packagingOptions ?? { titles: plan.packaging ? [plan.packaging.title] : [], captions: plan.packaging ? [plan.packaging.caption] : [], thumbnails: plan.packaging ? [plan.packaging.thumbnail] : [] };
  if (now.titles.length) out.push("", "## What it has now (keep any that are good, and make the rest new)", packagingReadback(g, now));
  out.push(
    "",
    "## Your answer",
    "Write a JSON file in your working folder and submit it with `packaging <file.json>`. Shape:",
    "```json",
    JSON.stringify(PACKAGING_EXAMPLE, null, 2),
    "```",
    ...PACKAGING_RULES.map((l, n) => (n ? l : `- ${l}`)),
    "- A thumbnail's `ply` can be any move of the game, not only the ones listed above.",
    "If the server rejects them it says why; fix them and submit again. Once they pass they're saved for the user to pick from, and your task is complete.",
  );
  return out.join("\n");
}

/** How long each cut may go with nothing said, from the first move to the result: the short, quicker, sooner. */
const MAX_SILENCE: Record<"landscape" | "portrait", number> = { landscape: 20, portrait: 12 };
/** How many stretches the director may leave quiet on purpose. */
const MAX_QUIET = 20;
/** Roughly how fast the voices speak, in words of the spoken text a second: to time a plan before it's recorded. */
const SPOKEN_WPS = 2.5;
const MAX_ASIDES = 80;
/** How many asides the TikTok cut may say (its quiet moves fly by, so they're fewer than the YouTube cut's). */
const MAX_SHORT_ASIDES = 30;

/** The plan's lines as long as they'll roughly take to say, for timing a plan that isn't recorded yet. */
function estimatedVoice(g: Game): VoiceManifest {
  const clips: VoiceManifest["clips"] = {};
  for (const l of videoLines(g)) {
    const voice = lineVoice(g, l);
    if (voice) clips[l.id] = { url: "", dur: words(speakable(l.text)) / SPOKEN_WPS, sig: lineSig(voice, l) };
  }
  return { clips };
}

/** A cut (the YouTube one unless said) as this plan would time it, the voices estimated. */
const plannedTimeline = (g: Game, plan: VideoPlan, format: "landscape" | "portrait" = "landscape") => {
  const pg = { ...g, video: plan };
  return buildTimeline(pg, format, { voice: estimatedVoice(pg) });
};

/**
 * Where a cut goes quiet for too long, by ply, leaving out stretches with nothing left to quote there (a
 * human's moves, plies already said in that cut, or moments the cut leaves out, which can't take an aside)
 * and the ones the director left quiet on purpose.
 */
function silentStretches(g: Game, plan: VideoPlan, format: "landscape" | "portrait"): string[] {
  const tl = plannedTimeline(g, plan, format);
  const said = (plan.asides ?? []).filter((a) => format === "landscape" || a.short);
  const used = new Set([...plan.moments.map((x) => x.ply), ...said.map((a) => a.ply)]);
  const quiet = new Set(plan.quiet ?? []);
  const out: string[] = [];
  for (const gap of silences(tl, MAX_SILENCE[format])) {
    const plies = tl.scenes.flatMap((s) => (s.kind === "move" && !s.hook && s.start >= gap.from - 0.01 && s.start < gap.to ? [g.moves[s.i]] : []));
    if (plies.some((m) => quiet.has(m.ply))) continue;
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
  const sl = shownLine(g, i, kind, false, true);
  if (!sl) throw new ActionError(`${where}.line: ply ${g.moves[i].ply} has no "${kind}" line to show: the engine has none there that the game didn't play.`);
  if (typeof raw === "string") return { kind, deep: true };
  // Where the director cuts it: a count of its moves, or the move it ends on.
  let end: number | undefined;
  if (r.end !== undefined && r.end !== null && r.end !== "") {
    end = lineStep(sl, r.end, `${where}.line.end`);
    if (end < 1) throw new ActionError(`${where}.line.end: the line shows at least its first move.`);
    if (end >= sl.moves.length) end = undefined;
  }
  const cut: ShownLine = end ? { ...sl, moves: sl.moves.slice(0, end) } : sl;
  if (end && obvious(g, cut))
    throw new ActionError(`${where}.line.end: cut to ${cut.moves.map((mv) => mv.san).join(" ")}, the line is just a capture the move's best-move arrow already shows. Play it further, or leave this line out.`);
  const beats = lineBeats(g, cut, r.beats, `${where}.line.beats`, r.first === true);
  if (beats?.some((b) => b.enter !== undefined) && r.punish)
    throw new ActionError(`${where}.line: enter is only available without a punishment opening (its narration comes after that opening).`);
  if (r.first !== undefined && r.first !== null && typeof r.first !== "boolean") throw new ActionError(`${where}.line.first: true or false.`);
  const first = r.first === true;
  if (first && (kind !== "instead" || (r.punish !== undefined && r.punish !== null && r.punish !== "")))
    throw new ActionError(`${where}.line.first: only an "instead" line without \`punish\` can play before its move (the punishment needs the move on the board).`);
  const caption = text(r.caption, `${where}.line.caption`, 120);
  if (caption && words(caption) > 16) throw new ActionError(`${where}.line.caption is ${words(caption)} words; keep it to at most 14.`);
  if (!caption && (r.refs?.length || r.draw?.length || r.squares?.length)) throw new ActionError(`${where}.line: refs, draw and squares go with a caption; give one, or leave them out.`);
  if (r.bestArrow !== undefined && r.bestArrow !== null && typeof r.bestArrow !== "boolean") throw new ActionError(`${where}.line.bestArrow: true or false.`);
  const showBest = r.bestArrow === true && kind === "instead" && !first;
  const out: NonNullable<VideoMoment["line"]> = {
    kind,
    deep: true,
    ...(showBest && { showBest: true as const }),
    ...(caption && { caption, ...lineNote(g, sl.fen, sl.moves, sl.moves.length, sl.for, caption, r, `${where}.line`) }),
    ...(beats && { beats }),
    ...(end && { end }),
    ...(first && { first }),
  };
  const branches = lineBranches(g, sl, cut, beats, r.branches, `${where}.line.branches`);
  if (branches) out.branches = branches;
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

/** How many narrator lines one engine line may have, and how long each may run. */
const MAX_BEATS = 8;
const MAX_BEAT_WORDS = 70;
/** How many branches one line may have, and how many narrator lines each. */
const MAX_BRANCHES = 2;
const MAX_BRANCH_BEATS = 4;

/**
 * A line's branches (see LineBranch), as the narrator asks for them: each one the brief offered for the line
 * (branchOptions), splitting off at a point of the line as cut, "before" (played as the line gets there) or
 * "after" (once it's played out), cut to `end`, with its own beats. A "before" branch needs the board at its
 * point when it comes: the line's beats up to there can't have played past it.
 */
function lineBranches(g: Game, sl: ShownLine, cut: ShownLine, beats: LineBeat[] | undefined, raw: unknown, where: string): LineBranch[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ActionError(`${where} must be a list.`);
  if (raw.length > MAX_BRANCHES) throw new ActionError(`${where}: ${raw.length} branches; keep it to at most ${MAX_BRANCHES}.`);
  const offered = branchOptions(g, sl);
  const out: LineBranch[] = [];
  raw.forEach((b: any, j) => {
    const w = `${where}[${j}]`;
    const at = lineStep(cut, b?.at, `${w}.at`);
    if (at >= cut.moves.length) throw new ActionError(`${w}.at: a branch splits off where the line still has a move to play (0–${cut.moves.length - 1}${cut.moves.length < sl.moves.length ? `; the line is cut to ${cut.moves.length} moves` : ""}).`);
    const fen = at ? cut.moves[at - 1].after : cut.fen;
    const thenRaw = b?.then === undefined || b?.then === null ? [] : Array.isArray(b.then) ? b.then.map((x: unknown) => str(x).trim()) : null;
    if (!thenRaw) throw new ActionError(`${w}.then must be a list of moves.`);
    const chosen = walk(fen, [str(b?.move).trim(), ...thenRaw], variantOf(g));
    const alt = chosen[0];
    const list = offered.map((o) => `at ${o.at}: ${o.moves[0].san}`).join(", ") || "none";
    if (!alt) throw new ActionError(`${w}.move: "${str(b?.move)}" isn't a legal move there. The branches on offer: ${list}.`);
    if (chosen.length < 1 + thenRaw.length) throw new ActionError(`${w}.then: ${thenRaw[chosen.length - 1]} isn't legal after ${chosen.map((mv) => mv.san).join(" ")}.`);
    if (alt.uci === cut.moves[at].uci) throw new ActionError(`${w}.move: ${alt.san} is the line's own move there; a branch plays something else.`);
    const then = chosen.slice(1).map((mv) => mv.uci);
    // An offered branch, or any move the director has probed there (its positions analysed).
    const br = planBranch(g, cut, { at, uci: alt.uci, then });
    const probeAt = `${g.moves[sl.i].ply}${sl.kind === "after" ? "a" : "i"}${at}`;
    if (!br) throw new ActionError(`${w}: ${[alt, ...chosen.slice(1)].map((mv) => mv.san).join(" ")} at ${at} hasn't been analysed yet. Probe it first (\`probe ${probeAt} ${chosen.map((mv) => mv.san).join(" ")}\`), or pick one of the branches on offer: ${list}.`);
    if (out.some((o) => o.at === at && o.uci === alt.uci && (o.then ?? []).join() === then.join())) throw new ActionError(`${w}: the same branch twice.`);
    const when = b?.when === undefined || b?.when === null ? "after" : b.when;
    if (when !== "before" && when !== "after") throw new ActionError(`${w}.when must be "before" or "after".`);
    const whole: ShownLine = { ...cut, fen: br.fen, moves: br.moves };
    let end: number | undefined;
    if (b?.end !== undefined && b?.end !== null && b?.end !== "") {
      end = lineStep(whole, b.end, `${w}.end`);
      if (end < 1) throw new ActionError(`${w}.end: the branch shows at least its first move.`);
      if (end >= br.moves.length) end = undefined;
    }
    const shown: ShownLine = end ? { ...whole, moves: br.moves.slice(0, end) } : whole;
    if (Array.isArray(b?.beats) && b.beats.length > MAX_BRANCH_BEATS) throw new ActionError(`${w}.beats: ${b.beats.length} lines; keep it to at most ${MAX_BRANCH_BEATS}.`);
    if (Array.isArray(b?.beats) && b.beats.some((x: any) => x?.enter !== undefined)) throw new ActionError(`${w}.beats: enter is for the line's first beat only.`);
    const bb = lineBeats(g, shown, b?.beats, `${w}.beats`);
    if (when === "before") {
      // It plays just ahead of the first beat that moves the board on from its point (see the timeline), so no beat
      // before its point may already have brought the line past it.
      const over = (beats ?? []).find((x) => x.at < at && (x.cues ?? []).some((c) => c.moves > at));
      if (over)
        throw new ActionError(`${w}: a "before" branch at ${at} plays when the line gets there, but the beat "${over.text.slice(0, 40)}…" (at ${over.at}) already brings the line past ${at}. Move that cue into a beat at ${at} or later, or make the branch "after".`);
    }
    out.push({ at, uci: alt.uci, ...(then.length && { then }), when, ...(end && { end }), ...(bb && { beats: bb }) });
  });
  return out.length ? out : undefined;
}

/**
 * A point in a line, as a count of its moves on the board (0: none yet), "start", or one of its moves in SAN
 * (once it has landed; a move that comes twice in the line has to be given as a count).
 */
function lineStep(sl: ShownLine, raw: unknown, where: string): number {
  const sans = sl.moves.map((mv) => mv.san);
  if (raw === undefined || raw === null || str(raw).trim().toLowerCase() === "start") return 0;
  let k = int(raw);
  if (!Number.isFinite(k)) {
    const key = sanKey(str(raw));
    const hits = sans.flatMap((s, j) => (key && sanKey(s) === key ? [j] : []));
    if (!hits.length) throw new ActionError(`${where} must be "start", a number of the line's moves (0–${sans.length}), or one of its moves (${sans.join(", ")}).`);
    if (hits.length > 1) throw new ActionError(`${where}: ${str(raw)} comes ${hits.length} times in the line; give it as a count of moves instead (${hits.map((j) => j + 1).join(" or ")}).`);
    k = hits[0] + 1;
  }
  if (!Number.isInteger(k) || k < 0 || k > sans.length) throw new ActionError(`${where}: a whole number of the line's moves on the board, 0–${sans.length} (or "start", or one of its moves).`);
  return k;
}

/**
 * The narrator's lines over an engine line (see LineBeat): the director's own words, free to say anything.
 * Each starts where the board has got to (`at`), and can move the board on its words (`cues`: by these words,
 * this many of the line's moves are on the board) and draw on them (`draw`: a reach or a circle, on the board
 * as it is when the words are said). The board only goes forward: each beat and cue is at or past the last.
 */
function lineBeats(g: Game, sl: ShownLine, raw: unknown, where: string, first = false): LineBeat[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ActionError(`${where} must be a list.`);
  if (raw.length > MAX_BEATS) throw new ActionError(`${where}: ${raw.length} lines; keep it to at most ${MAX_BEATS}.`);
  let on = 0;
  const out = raw.map((b: any, n): LineBeat => {
    const w = `${where}[${n}]`;
    const said = text(b?.text, `${w}.text`, 480, true)!;
    if (words(said) > MAX_BEAT_WORDS) throw new ActionError(`${w}.text is ${words(said)} words; keep it to at most ${MAX_BEAT_WORDS - 10}.`);
    const at = lineStep(sl, b?.at, `${w}.at`);
    if (at < on) throw new ActionError(`${w}.at: the board already has ${on} of the line's moves on it by then (the beats before moved it on); a beat starts at ${on} or later.`);
    on = at;
    // Where in the text each cue and drawing falls.
    const place = (phrase: unknown, wx: string, after = -1) => {
      const p = text(phrase, wx, 160, true)!;
      const k = phraseAt(said, p, after + 1);
      if (k < 0) throw new ActionError(`${wx} must be words of the text, exactly as they appear${after >= 0 ? `, after the cue before it` : ""} ("${p}" isn't).`);
      return k;
    };
    const enter = b?.enter === undefined ? undefined : place(b.enter, `${w}.enter`);
    if (enter !== undefined && (n !== 0 || at !== 0)) throw new ActionError(`${w}.enter: put the entry cue in the first beat, at "start".`);
    const cueList = b?.cues === undefined || b?.cues === null ? [] : Array.isArray(b.cues) ? b.cues : null;
    if (!cueList) throw new ActionError(`${w}.cues must be a list.`);
    let lastWord = -1;
    const cues = cueList.map((c: any, j: number) => {
      const wc = `${w}.cues[${j}]`;
      const word = place(c?.words, `${wc}.words`, lastWord);
      if (enter !== undefined && word <= enter) throw new ActionError(`${wc}.words: a move cue must come after the engine entry cue; leave a short phrase for the rewind.`);
      const moves = lineStep(sl, c?.moves, `${wc}.moves`);
      if (moves <= on) throw new ActionError(`${wc}.moves: ${on} of the line's moves are already on the board by then; a cue brings on more (up to ${sl.moves.length}).`);
      lastWord = word;
      on = moves;
      return { word, moves };
    });
    // The board each drawing is made on: the moves on it by its words.
    const drawList = b?.draw === undefined || b?.draw === null ? [] : Array.isArray(b.draw) ? b.draw : null;
    if (!drawList) throw new ActionError(`${w}.draw must be a list.`);
    if (drawList.length > MAX_MARK_ARROWS + MAX_MARK_RINGS) throw new ActionError(`${w}.draw: keep it to at most ${MAX_MARK_ARROWS + MAX_MARK_RINGS}.`);
    const draw = drawList.map((d: any, j: number) => {
      const wd = `${w}.draw[${j}]`;
      const word = place(d?.words, `${wd}.words`);
      const last = phraseEnd(said, text(d?.words, `${wd}.words`, 160, true)!, word);
      const k = Math.max(at, ...cues.filter((c: { word: number }) => c.word <= word).map((c: { moves: number }) => c.moves));
      const fen = enter !== undefined && word < enter && !first ? g.moves[sl.i].fenAfter : fenAt(sl.fen, sl.moves, k);
      const shown = k ? `after ${sl.moves.slice(0, k).map((mv) => mv.san).join(" ")}` : "at the start of the line";
      if (d?.square !== undefined) {
        const ring = str(d.square).trim().toLowerCase();
        if (!/^[a-h][1-8]$/.test(ring)) throw new ActionError(`${wd}.square: "${ring}" isn't a square.`);
        return { word, last, ring };
      }
      const reach = str(d?.reach).trim();
      if (!isHit(reach)) throw new ActionError(`${wd}: give a "reach" ("f5>h4", a piece's attack or defence) or a "square" to circle.`);
      const drawn = drawnLine([fen], [reach], variantOf(g));
      if ("stuck" in drawn) throw new ActionError(`${wd}: ${reach} can't be drawn on the board as it is then (${shown}): ${drawn.why}.`);
      return { word, last, from: drawn.drawn[0].from, to: drawn.drawn[0].to };
    });
    const d = delivery(b?.delivery, `${w}.delivery`);
    return { at, text: said, ...(enter !== undefined && { enter }), ...(d && { delivery: d }), ...(cues.length && { cues }), ...(draw.length && { draw }) };
  });
  return out.length ? out : undefined;
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
function thoughtMarks(g: Game, m: MoveRecord, quote: string | undefined, raw: unknown, where: string, strict = false): ThoughtMark[] | undefined {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) throw new ActionError(`${where}.marks must be a list.`);
  if (!quote) {
    if (list.length) throw new ActionError(`${where}.marks: marks are drawn while the quote is spoken, and there's no quote.`);
    return undefined;
  }
  try {
    const marks = list.length ? markList(g, m, quote, list, where) : [];
    checkRefs(g, m, quote, marks, where);
    return marks.length ? marks : undefined;
  } catch (e) {
    if (!(e instanceof ActionError) || strict) throw e;
    // Drawings are best effort: they never cost a quote, a moment or its line. Every mark that can be drawn is
    // kept, in order; when what they light up can't be checked, their refs go (the words are coloured as found).
    const kept: unknown[] = [];
    for (const x of list) {
      try {
        markList(g, m, quote, [...kept, x], where);
        kept.push(x);
      } catch {}
    }
    let marks = kept.length ? markList(g, m, quote, kept, where) : [];
    const refsOff = !!marks.length && refProblems(quote, marks, markFens(g, m), m.color).length > 0;
    if (refsOff) marks = marks.map(({ refs: _, ...mk }) => mk);
    markNotes?.push(
      `${where}: ${list.length - kept.length ? `${list.length - kept.length} of its ${list.length} marks couldn't be drawn and were left out` : "its marks are kept"}${refsOff ? ", and the words they light are found automatically" : ""}. Why: ${e.message.split("\n").slice(0, 3).join(" ")}`,
    );
    return marks.length ? marks : undefined;
  }
}

/** Where the best-effort drawings note what they left out, while a plan is checked (read back with it). */
let markNotes: string[] | null = null;
/** What each checked plan's drawings left out, for its readback. */
export const planNotes = new WeakMap<VideoPlan, string[]>();

/** One quote's marks, as the director would submit them for move `ply`, checked as a plan's are (scripts/test-marks.ts). */
export function checkedMarks(g: Game, ply: number, quote: string, raw: unknown): ThoughtMark[] | undefined {
  return thoughtMarks(g, moveAt(g, ply, "test"), quote, raw, "marks", true);
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
  const dropped = planNotes.get(plan);
  if (dropped?.length)
    out.push(
      "Drawings left out (the quotes, moments and lines all stay; fix these only if the drawing matters, otherwise leave them):",
      ...dropped.map((n) => `  - ${n}`),
      "",
    );
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
    const sl = ln && planLine(g, i, ln);
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
  out.push(...narratedReadback(g, plan));
  // The asides in the order they're said, and when (by an estimate of the voices), so they can be read
  // through as the conversation the video will play.
  const tl = plannedTimeline(g, plan);
  if (tl.asides.length) {
    const stamp = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    out.push(
      "Asides in the YouTube cut, in the order they're said, timed by an estimate of the voices (★: in the TikTok cut too). ⚠ marks one that looks like it's about a single move: the board plays on under an aside, so make sure it still holds a few moves later, or make it a moment, or drop it:",
    );
    for (const a of tl.asides) {
      if (a.narrator) continue;
      const m = g.moves[a.i];
      const star = plan.asides?.find((x) => x.ply === m.ply)?.short ? "★ " : "";
      // The move on the board as it starts: its own, or one played before it.
      const over = tl.scenes.find((s) => (s.kind === "move" || s.kind === "illegal") && !("hook" in s && s.hook) && s.start + s.dur > a.start + 0.01);
      const early = over && "i" in over && over.i < a.i ? `, starting ${a.i - over.i} ${a.i - over.i === 1 ? "ply" : "plies"} early, over ${moveNo(g.moves[over.i].ply)} ${g.moves[over.i].san}` : "";
      const hint = oneMoveHint(a.text);
      if (hint) out.push(`  ⚠ ${hint}:`);
      out.push(`  ${star}${stamp(a.start)} ${sideName(g, m.color)} (${moveNo(m.ply)} ${m.san}${early}): "${a.text}"`);
    }
    out.push("");
  }
  if (plan.packagingOptions) out.push("Packaging, for the user to pick from (each one must be good enough to be picked):", packagingReadback(g, plan.packagingOptions), "");
  return out.join("\n");
}

/**
 * Why an aside looks like it's about a single move, or nothing: it names a move ("Rxf2", "...Kg8", "O-O") or
 * a capture ("regains the pawn"). Only a nudge, for the readback: a plan can name a move and still hold.
 */
function oneMoveHint(quote: string): string | undefined {
  const move = /(?:^|[\s(:])((?:\d*\.\.\.|…)?(?:[KQRBN][a-h]?[1-8]?x?[a-h][1-8]|[a-h]x[a-h][1-8]|O-O(?:-O)?)[+#!?]*|(?:\d*\.\.\.|…)[a-h][1-8])(?=$|[\s,.;:!?)])/.exec(quote);
  if (move) return `names a move (${move[1]})`;
  const capture = /\b(takes?|taking|recaptures?|regains?|captures?|grabs?)\b/i.exec(quote);
  return capture ? `describes a capture ("${capture[1]}")` : undefined;
}

/** A delivery direction for the voice: a few words, no brackets (the voice engine adds its own). */
function delivery(raw: unknown, where: string): string | undefined {
  const s = text(raw, where, 60);
  if (!s) return undefined;
  if (/[[\]<>]/.test(s)) throw new ActionError(`${where}: just the words, no brackets.`);
  if (words(s) > 8) throw new ActionError(`${where} is ${words(s)} words; keep it to at most 6.`);
  return s;
}

/* ------------------------------ the narration ------------------------------ */

/** How long a great or brilliant move should have the board to itself before the next one lands, in seconds. */
const ROOM = 1.5;

/**
 * The narrated lines as they'll play: each move with its badge, the eval, when it lands and how long it has the
 * board to itself (a hard move given too little is flagged), and each narrator line with where the board moves
 * (⟨…lands⟩) and what's drawn ({…}) in its words. For the director to check the narration against the board.
 */
export function narratedReadback(g: Game, plan: VideoPlan): string[] {
  const out: string[] = [];
  const tl = plannedTimeline(g, plan);
  for (const x of plan.moments) {
    const ln = x.line;
    if (!ln?.beats?.length) continue;
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    const sl = planLine(g, i, ln);
    if (!sl) continue;
    const m = g.moves[i];
    const verdicts = lineVerdicts(g, sl.moves);
    const scene = tl.scenes.find((s): s is Extract<Scene, { kind: "line" }> => s.kind === "line" && s.i === i);
    const where = ln.first
      ? `, played before ${m.san} (the board holds on the position ${sideName(g, m.color)} faced; then their quote and ${m.san} land)`
      : ln.kind === "instead"
        ? `, played after ${m.san} (their quote and ${m.san} land with its badge, then it slides back off and the line plays)`
        : "";
    out.push(`Ply ${x.ply}, the narrated "${ln.kind}" line${where}${scene ? `, about ${Math.round(scene.dur)} s long` : ""}:`);
    let on = 0;
    const beatsAt = (k: number) =>
      ln.beats!.filter((b) => b.at === k).forEach((b) => {
        on = Math.max(on, b.at);
        const ws = quoteWords(b.text);
        const marked = ws.map((wd, j) => {
          const tags: string[] = [];
          if (b.enter === j) tags.push("⟨engine view opens; rewind if after the move⟩");
          for (const c of (b.cues ?? []).filter((c) => c.word === j)) {
            tags.push(`⟨${sl.moves.slice(on, c.moves).map((mv) => mv.san).join(" ")} lands⟩`);
            on = c.moves;
          }
          for (const d of (b.draw ?? []).filter((d) => d.word === j)) tags.push(d.ring ? `{circle ${d.ring}}` : `{${d.from}→${d.to}}`);
          return tags.length ? `${wd} ${tags.join(" ")}` : wd;
        });
        out.push(`    narrator${b.delivery ? ` (${b.delivery})` : ""}: "${marked.join(" ")}"`);
      });
    out.push(`  start: ${sideName(g, sl.moves[0].color)} to move, eval ${formatScore(g.analysis[sl.fen]?.score)}`);
    beatsAt(0);
    sl.moves.forEach((mv, k) => {
      const land = scene ? scene.moveAt[k] + LINE_SLIDE : undefined;
      const alone = scene && land !== undefined ? (scene.moveAt[k + 1] ?? scene.dur) - land : undefined;
      const hard = verdicts[k] === "great" || verdicts[k] === "brilliant";
      const timing = land !== undefined && alone !== undefined ? `; lands ${land.toFixed(1)} s in, alone on the board for ${alone.toFixed(1)} s` : "";
      const warn = hard && alone !== undefined && alone < ROOM ? ` ⚠ the ${verdicts[k]} move is gone before it can land: shape the words to give it room` : "";
      out.push(`  ${k + 1}. ${mv.san}${verdicts[k] ? ` (${verdicts[k]})` : ""}, eval ${formatScore(g.analysis[mv.after]?.score)}${timing}${warn}`);
      beatsAt(k + 1);
    });
    out.push(...branchReadback(g, sl, ln, scene), ...understoodReadback(g, sl, ln));
    // The whole exchange around it, in order, so three voices in a row can be read as one conversation; a
    // player's line that walks through the same squares as the narrator's is flagged (it probably repeats it).
    const near = speechAround(g, plan, i);
    if (near.length) {
      const squares = (s: string) => new Set(s.toLowerCase().match(/[a-h][1-8]/g) ?? []);
      const said = squares(ln.beats.map((b) => b.text).join(" "));
      out.push("  What the players say around it:");
      for (const s of near) {
        const shared = [...squares(s.text)].filter((q) => said.has(q));
        out.push(`    ply ${s.ply} (${s.kind}, ${s.when} the line), ${sideName(g, s.color)}: ${s.text ? `"${s.text}"` : "(nothing said)"}`);
        if (shared.length >= 2) out.push(`      ⚠ names ${shared.join(", ")} like the narrator does: if it says the same thing, re-cut or drop it with \`speech\``);
      }
    }
    out.push("");
  }
  const nudge = sameSide(g, plan);
  if (nudge) out.push(`Where the lines play: ${placements(g, plan).map((s) => s.trim()).join("; ")}. ${nudge}`, "");
  return out;
}

/** How much a branch must be worth (see branchLine's score) to be recommended: the natural move that fails, or a player's own idea. */
const RECOMMEND = 40;

/** The branch the brief recommends for a moment's line (★): its best one, when it's worth it and the moment is shown in both cuts. */
function recommendedBranch(g: Game, x: VideoMoment, sl: ShownLine): ShownBranch | undefined {
  if (x.importance < 2) return undefined;
  const top = branchOptions(g, sl)[0];
  return top && top.score >= RECOMMEND ? top : undefined;
}

/** The narrator's beats as they'll play, with where the board moves (⟨…lands⟩) and what's drawn ({…}) in their words; `on` is where the board starts. */
function markedBeats(beats: LineBeat[], moves: RulesMove[], k: number, on: { n: number }, indent = "    "): string[] {
  return beats
    .filter((b) => b.at === k)
    .map((b) => {
      on.n = Math.max(on.n, b.at);
      const ws = quoteWords(b.text);
      const marked = ws.map((wd, j) => {
        const tags: string[] = [];
        if (b.enter === j) tags.push("⟨engine view opens; rewind if after the move⟩");
        for (const c of (b.cues ?? []).filter((c) => c.word === j)) {
          tags.push(`⟨${moves.slice(on.n, c.moves).map((mv) => mv.san).join(" ")} lands⟩`);
          on.n = c.moves;
        }
        for (const d of (b.draw ?? []).filter((d) => d.word === j)) tags.push(d.ring ? `{circle ${d.ring}}` : `{${d.from}→${d.to}}`);
        return tags.length ? `${wd} ${tags.join(" ")}` : wd;
      });
      return `${indent}narrator${b.delivery ? ` (${b.delivery})` : ""}: "${marked.join(" ")}"`;
    });
}

/** A line's branches as they'll play, for the readback: where each splits, its moves with their timing, and its beats. */
function branchReadback(g: Game, sl: ShownLine, ln: NonNullable<VideoMoment["line"]>, scene: Extract<Scene, { kind: "line" }> | undefined): string[] {
  const out: string[] = [];
  (ln.branches ?? []).forEach((b, j) => {
    const br = planBranch(g, sl, b);
    if (!br) return void out.push(`  branch ${j + 1}: can't be shown any more (drop it)`);
    const bs = scene?.branches?.[j];
    const split = b.at ? `after ${sl.moves.slice(0, b.at).map((mv) => mv.san).join(" ")}` : "at the start of the line";
    out.push(`  branch ${j + 1} (${b.when === "before" ? `played as the line gets there, then the board winds back and the line goes on` : "played once the line is done: the board winds back to where it splits"}), splitting ${split}: ${br.question} → ${br.fact}`);
    const vs = lineVerdicts(g, br.moves);
    const on = { n: 0 };
    out.push(...markedBeats(b.beats ?? [], br.moves, 0, on, "      "));
    br.moves.forEach((mv, k) => {
      const land = bs ? bs.moveAt[k] + LINE_SLIDE : undefined;
      const alone = bs && land !== undefined ? (bs.moveAt[k + 1] ?? land + ROOM) - land : undefined;
      const hard = vs[k] === "great" || vs[k] === "brilliant";
      const timing = land !== undefined ? `; lands ${land.toFixed(1)} s in` : "";
      const warn = hard && alone !== undefined && alone < ROOM ? ` ⚠ the ${vs[k]} move is gone before it can land: shape the words to give it room` : "";
      out.push(`    ${k + 1}. ${mv.san}${vs[k] ? ` (${vs[k]})` : ""}, eval ${formatScore(g.analysis[mv.after]?.score)}${timing}${warn}`);
      out.push(...markedBeats(b.beats ?? [], br.moves, k + 1, on, "      "));
    });
    if (!b.beats?.length) out.push("    ⚠ no beats: the branch plays in silence; say what question it answers");
  });
  return out;
}

/**
 * What the viewer must understand of a line (see mustUnderstand), each with whether the beats look like they say
 * it: its piece or threat named, and for a "can't get out", words that say so. A nudge for the narrator, not a check.
 */
function understoodReadback(g: Game, sl: ShownLine, ln: NonNullable<VideoMoment["line"]>): string[] {
  const qs = mustUnderstand(g, sl).filter((q) => q.at <= sl.moves.length);
  if (!qs.length) return [];
  const said = [...(ln.beats ?? []), ...(ln.branches ?? []).flatMap((b) => b.beats ?? [])].map((b) => b.text.toLowerCase()).join(" ");
  // Said in one sentence: the piece (or the threat's move) and, for a "can't get out", words that say there's no way out.
  const sentences = said.split(/[.!?…]+/);
  const cant = /\b(can't|cannot|can not|nothing|no way|nowhere|whatever|every|anything|unstoppable|doomed|trapped|lost)\b/;
  return [
    "  What the viewer must understand (from the engine; ⚠ where the beats don't seem to say it):",
    ...qs.map((q) => {
      const names = (s: string) => !q.keys?.length || q.keys.some((k) => s.includes(k.toLowerCase()));
      // A "can't get out" is said by any sentence that says so (the piece may be named around it); a threat, by naming it.
      const ok = q.kind === "decided" ? sentences.some((s) => cant.test(s)) : sentences.some(names);
      return `    ${ok ? "✓" : "⚠"} ${q.question} → ${q.answer}`;
    }),
  ];
}

/** Whether a line can play before its move: an `instead` line without a punishment (which needs the move on the board). */
const choosable = (ln: NonNullable<VideoPlan["moments"][number]["line"]>) => ln.kind === "instead" && !ln.punish;

/** Each shown line of the plan and where it plays, before its move or after it, one per line of the brief. */
function placements(g: Game, plan: VideoPlan): string[] {
  return plan.moments.flatMap((x) => {
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    if (!x.line || !shownLine(g, i, x.line.kind, !x.line.deep, true)) return [];
    const m = g.moves[i];
    const side = !choosable(x.line) ? "after (it needs the move on the board)" : x.line.first ? "before (a puzzle)" : "after (a reveal)";
    return [`  ply ${x.ply}, ${moveNo(m.ply)} ${m.san}: ${side}`];
  });
}

/** A nudge when two or more lines could go either way and all go the same way (null when they're mixed, or there's no choice). */
function sameSide(g: Game, plan: VideoPlan): string | null {
  const free = plan.moments.filter((x) => x.line && choosable(x.line) && shownLine(g, g.moves.findIndex((m) => m.ply === x.ply), x.line.kind, !x.line.deep, true));
  if (free.length < 2) return null;
  const before = free.filter((x) => x.line!.first).length;
  if (before && before < free.length) return null;
  return `Every line that can go either way plays ${before ? "before" : "after"} its move. That's allowed, but it gets predictable: consider making one ${before ? "a reveal after the move" : "a puzzle before it"}.`;
}

/**
 * Lines that show the range of the narrator's voice: energy, questions, the payoff, the letdown. Shown a few at
 * a time, a different few each brief, so none of them becomes a template.
 */
const VOICE_SAMPLES = [
  "Why is the bar suddenly screaming for White? The brilliant bishop takes h7! The king has to take, and the knight comes in with CHECK. But instead…",
  "All it had to do was put the knight on d5. From there it hits the queen AND the rook, and only one can run. Unfortunately…",
  "Everything loses here except one quiet move: the only move, king to h1. Now the check on g2 simply doesn't exist. But tragically…",
  "Down a whole piece, and the engine still loves Black. Why? The a-pawn. NOBODY can catch it. Instead…",
  "Wait, where did White's advantage go? Rewind. Knight takes e5 was free, and it uncovers the bishop on the queen. And now Black gets to cash in…",
  "Calm, it says? The bar just flipped. Rewind: bishop to g5 pins the knight, and the whole attack stalls. Too late now. Watch what White does next…",
  "This needs to be EXTREMELY precise. Rook to f1, the accurate move, and the back rank is sealed for good. Of course, that's not what happened.",
  "The engine's choice is a queen move nobody finds in a game: back to b8, into the corner, and it holds EVERYTHING. But…",
  "No captures. No checks. Just g4, and nothing stops g5 next. Sadly…",
];

const pickSamples = (n: number) => [...VOICE_SAMPLES].sort(() => Math.random() - 0.5).slice(0, n);

/** How far around a line the narrator may re-cut what the players say: a couple of plies before it, a few after. */
const SPEECH_BEFORE = 2;
const SPEECH_AFTER = 6;

/** The plies whose speech sits around the line at move i (the narrator may re-cut it). */
const aroundLine = (g: Game, i: number) => g.moves.slice(Math.max(0, i - SPEECH_BEFORE), i + SPEECH_AFTER + 1);

/**
 * What the players say around the line at move i, in the order the video plays it: each moment's quote and
 * each aside on the plies near it (the line's own moment before or after it, as it's placed), with the
 * commentary it's cut from, so the narrator can see the whole exchange and re-cut it.
 */
type SpeechNear = { ply: number; kind: "quote" | "aside"; when: "before" | "after"; color: Color; text: string; source: string };
function speechAround(g: Game, plan: VideoPlan, i: number): SpeechNear[] {
  const at = g.moves[i];
  const own = plan.moments.find((x) => x.ply === at.ply);
  const first = !!own?.line?.first;
  return aroundLine(g, i).flatMap((m): SpeechNear[] => {
    const source = [m.commentary, ...(m.tries ?? []).map((t) => t.commentary)].filter((s) => s.trim()).join(" / ");
    if (!source) return [];
    const x = plan.moments.find((y) => y.ply === m.ply);
    const a = plan.asides?.find((y) => y.ply === m.ply);
    const when: "before" | "after" = m.ply < at.ply || (m.ply === at.ply && !first) ? "before" : "after";
    if (x) return [{ ply: m.ply, kind: "quote" as const, when, color: m.color, text: x.thought ?? "", source }];
    if (a) return [{ ply: m.ply, kind: "aside" as const, when, color: m.color, text: a.quote, source }];
    return [];
  });
}

/** What a line's moves are, step by step, for the narration brief: each with its verdict, what it does, and the eval after it. */
function lineSteps(g: Game, sl: ShownLine): string[] {
  const vs = lineVerdicts(g, sl.moves);
  return sl.moves.map((mv, k) => {
    // For the losing side, how forced its best move is: what its next best would have cost on top.
    const a = g.analysis[mv.before];
    const forced =
      mv.color !== sl.for && a && !a.failed && a.second && (a.bestUci ?? a.pv[0]) === mv.uci
        ? (() => {
            const drop = winPercentFor(a.score, mv.color) - winPercentFor(a.second, mv.color);
            return drop >= 10 ? `its best try, and the next best is ${Math.round(drop)} points worse` : "";
          })()
        : "";
    const notes = [vs[k] && vs[k] !== "best" ? vs[k] : "", moveFacts(mv), forced].filter(Boolean).join("; ");
    return `    ${k + 1}. ${mv.san}${notes ? ` (${notes})` : ""}, eval ${formatScore(g.analysis[mv.after]?.score)}`;
  });
}

/**
 * The narration brief: just what the narrator needs, line by line. Who's playing, what the video's story is,
 * and for each line the director chose: the position, what the player believed, said and thought about, the
 * line move by move with what each move does, what really happened instead, and what's already written.
 */
export function narrateBrief(g: Game): string {
  const plan = g.video!;
  const name = (c: Color) => sideName(g, c);
  const lines = plan.moments.filter((x) => x.line);
  const out: string[] = [
    "VIDEO NARRATOR — write what the narrator says over this video's engine lines.",
    "",
    "The replay video is planned. Over its engine lines (the \"what if\" lines and \"what this allowed\" lines), and only there, it has a narrator: a third voice apart from the two players, an older storyteller who has seen the whole game. Everywhere else the players speak for themselves, in their own words. Here, you speak. This is the part of the video where the viewer finds out what was really on the board, so it has to be the part they remember.",
    "",
    "## Your job",
    "You're the one voice that knows what was really on the board. Make the viewer SEE the move that mattered and FEEL what it meant, then get out of the way: the player's own words and the move they really played come next, and they're the punchline.",
    "",
    "## The shape of a line (a shape, not a script: vary it, break it when the moment calls for it)",
    "1. The hook: a question or the stakes, best about something already on screen. The eval bar is up the whole time, the badges are on the board, the material is on the cards: why is the bar so lopsided? what does that badge mean? Or the stakes: all it had to do was…; this has to be EXTREMELY careful.",
    "2. The move: name it with its weight (the brilliant…, the only move…, the accurate…), and let it land on the words that name it.",
    "3. The why: one plain chess sentence. What it takes, what it hits, the defender it removes, what it stops. Forced replies play on the board without you narrating them.",
    "4. Maybe one escalation, if the line keeps getting better (and it doesn't end there…).",
    "5. The hand-back: a few words that lead into what the viewer sees next, so it depends on where the line plays. Played before the move, their real move comes next (but instead…, unfortunately…, but tragically, it doesn't see it). Played after the move, their move is already on the board and the game simply goes on, so never \"instead\": point at what's coming (and Sol is about to make it pay…, now watch what Black does with it…), or just let the board take over. Then stop. No recap, no moral, no explaining what the player got wrong: their words and their move are about to do that. Anything about what they believed, how long they thought or who they are belongs before the line, as setup, never after it as an epilogue.",
    "",
    "## The voice",
    "Warm, a little theatrical, genuinely excited by a brilliant move and genuinely pained by a miss. Talk to the viewer (\"you might be wondering…\"). Say moves the way people do (\"rook takes e2\"). Short, punchy sentences; a word or two in capitals where the voice hits hardest, with one real peak per line. A dash of attitude toward the players is welcome, but the chess comes first, and no extended metaphors. Shorter is stronger: most lines are a few sentences, and one line per video can be the showpiece that runs longer, in the same shape. Be specific to this game, never a template.",
    "A few lines to show the energy and the length (each from a different game; write your own, never reuse these):",
    ...pickSamples(4).map((s) => `- \"${s}\"`),
    "",
    "## The players around you",
    "Your line sits in a conversation: a player speaks before it, and usually after it, and the viewer hears every word. Three voices in a row that explain the same thing feel like the video has stalled, so each should say something different: let the players keep what only they can give (what they believed, how it felt, what they saw too late), and say what they couldn't (what was really on the board, what they missed). Your narration comes first. When a player's line around yours would repeat what you need to say, change the player's line, not yours: re-cut it to a different part of their commentary, or drop it, with `speech` (below). Each line lists what's said around it and the commentary it's cut from.",
    "",
    "## Giving the hard move room",
    "A great or brilliant move is the moment the line exists for. It lands with its badge and a sting, and the viewer needs a beat to see it. Shape your words around it: name it, let it land, and say something about it (or stop for breath) before the next move comes in. Never let the next move land a word or two after it. The readback tells you how long each move has the board to itself, and flags a hard move that's gone too soon.",
    "",
    "## The chess",
    "The chess is the engine's. Say only what the board and the facts below show: no fork that isn't one, no \"only move\" unless it's badged great, no \"winning\" when the line ends level. The facts listed with each move (check, what it takes, what it hits, a fork, the defender it removes) are worked out from the board, so lean on them.",
    "",
    `Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}. Result: ${g.result} (${g.termination}).`,
    ...characterLines(g),
    "",
    "## The video's story",
    ...plan.moments.map((x) => {
      const m = g.moves.find((mv) => mv.ply === x.ply)!;
      return `ply ${x.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)} (${m.analysis?.classification ?? "unrated"}): ${x.why}${x.thought ? ` They say: "${x.thought}"` : ""}`;
    }),
    "",
    "## Before or after the move",
    "An \"instead\" line (one that doesn't show a punishment) can play on either side of the move it's about, and the choice changes what the line is.",
    "- Before (\"first\": true), a puzzle: the board holds on the position the player faced, and nobody has seen their move yet. The viewer gets to look for it with you; then the player's words and the move they really played land. Strongest when the position itself asks a question you can put to the viewer (what's guarding that queen? what's loose?).",
    "- After (\"first\": false, the default), a reveal: the player's words and their move land first, with its badge and the eval swing, then the move slides back off and your line plays from the position before it. Strongest when the shock is the hook: a big swing, a confident quote that turns ironic, a self-eval far from the truth. Open by reacting to what just happened (\"Wait. Where did all of White's advantage go?\"), then rewind to what was there.",
    "Mix them across the video: every line a puzzle (or every line a reveal) gets predictable, and two lines a few moves apart read better as one of each. A line that shows a punishment, or isn't an \"instead\" line, always plays after its move.",
    "Where the lines play now:",
    ...placements(g, plan),
    "",
    "## Seeing the picture: work out WHY before you write",
    "An engine line on its own is just moves. Your job is to find out why they are the moves, the way a strong commentator does at the board, and then say that. You can ask the engine three questions, from any position of the game or of a line, as often and as deep as you need (run them like your other commands):",
    ...PROBE_COMMANDS.split("\n"),
    "How to read the answers:",
    "- The engine's line is both sides' best play. If the losing side's BEST move still loses the bishop, every other move loses at least as much: the bishop can't be saved. `options` at that point shows it: every one of its moves loses it, and how. That is the sentence the viewer needs (\"the bishop has nowhere to go and nothing can defend it\"), not \"the rook steps aside\".",
    "- A quiet move in a line nearly always threatens something: `threat` right after it says what, and `options` for the other side shows whether it can be met.",
    "- A sacrifice has a point. `probe` the other side taking it and see what happens: that is usually the most exciting thing in the line, and it belongs in the video, before the line shows that declining is the best defence.",
    "- A natural move that \"fails\" is only worth showing when the refutation takes a moment to see. A piece that just hangs to a recapture is not a question anyone asks.",
    "For each line, before you write it:",
    "1. What does it end with, and where is it decided: the first position where every option of the losing side loses?",
    "2. What decides it: the threat, the piece that can't be saved, the pawn that can't be stopped, the sacrifice that can't be taken? Check each with `threat`, `options` and `probe`.",
    "3. Which question would a viewer ask there (what if they take? can't they just defend? why not the obvious move?), and what answers it on the board? That is your branch.",
    "4. Then write the beats: the why in plain chess words, with the forced replies flying by under a phrase.",
    "Say only what the engine's answers show, and probe until you're sure.",
    "",
    "## Branches: calculating out loud",
    "When a position is hard, the best commentators don't show one line: they answer the viewer's questions on the board. \"What if Black just takes the bishop?\" Play it, show the point, wind back. \"Can't Black defend with the rook?\" Play that too, and it still loses. A line can do the same with branches. Each line below lists the branches the engine has already worked out (the sacrifice accepted, a player's own idea, the natural move that fails, the other side's other try), and any move you have probed at a point of the line can be a branch too, with moves of your own after it (`then`) before the engine plays on.",
    "- When: a line with a sacrifice or a hard move in it (great, brilliant), a defence that looks like it should work, or a player who saw the idea and talked themselves out of it. One branch on a showpiece line is the usual; two when both are questions a viewer would really ask. A branch marked ★ is recommended for its line: play it, or a better one you found by probing.",
    "- \"before\": the line gets to the branch's point, the branch plays, the board winds back, and the line goes on as the answer. Best for the sacrifice accepted (its point first, then the line shows the best defence: declining) and for the natural move that fails just before a hard move (\"Not the king. The KNIGHT takes.\"). It plays just ahead of the first of the line's beats that moves the board on from its point: a beat at the branch's point with a cue, or any beat past it. So write the line's answer as a beat at the branch's `at` with a cue on its move.",
    "- \"after\": the line plays out, then the board winds back to where the other side could have tried something else, and you show it loses too (\"But what if Black defends with the rook?\"). Best for the other side's try, or a player's own worry.",
    "- A branch's first beat is said with the board at the split point: ask the question there, then cue the other move on the words that name it. Keep a branch short (two to four beats): the line is still the story, and the branch serves it. Every move in a branch gets its badge, and the callout up top and the eval bar follow it.",
  ];
  if (!lines.length) out.push("", "This plan has no engine lines, so there's nothing to narrate.");
  for (const x of lines) {
    const i = g.moves.findIndex((m) => m.ply === x.ply);
    const m = g.moves[i];
    const ln = x.line!;
    const full = shownLine(g, i, ln.kind, !ln.deep, true);
    if (!full) continue;
    const before = ln.kind === "instead";
    out.push(
      "",
      `## The line at ply ${x.ply}: ${before ? `what ${name(m.color)} could have played instead of ${moveNo(m.ply)} ${m.san}` : `after ${moveNo(m.ply)} ${m.san}, ${full.for === m.color ? `the point of the move` : `how ${name(full.for)} could have punished it`}`}`,
      `The director's note: ${x.why}`,
      `${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${m.analysis?.classification}; eval after it ${formatScore(m.analysis?.evalAfter)}; ${name(m.color)}'s own eval ${m.selfEvalRaw || "—"}; thought for ${thinkTime(m.thinkMs)}.`,
      ...(x.thought ? [`What ${name(m.color)} says on it (spoken in their voice, ${ln.first ? "right after your line" : "before the move, ahead of your line"}): "${x.thought}"`] : []),
      `The position where the line starts (${name(full.moves[0].color)} to move, eval ${formatScore(g.analysis[full.fen]?.score)}):`,
      asciiBoard(full.fen, "w"),
      `The line (${full.moves.length} moves; what it shows: ${full.fact}):`,
      ...lineSteps(g, full),
      ...(full.punish ? [`What ${m.san} really allowed instead: ${full.punish.moves.slice(1).map((mv) => mv.san).join(" ")} → ${full.punish.fact}.`] : []),
      ...(() => {
        const star = recommendedBranch(g, x, full);
        return [
          ...understandLines(g, full),
          ...questionLines(g, full, 8, star, true),
          `Where a question names a branch, give its \`at\` and \`move\` to play it (the ★ one is recommended). Any move you probe at a point of the line can be a branch too.`,
          ...(ln.branches?.length ? [`Branches in the plan now: ${ln.branches.map((b) => `at ${b.at} ${walk(b.at ? full.moves[b.at - 1]?.after ?? full.fen : full.fen, [b.uci], variantOf(g))[0]?.san ?? b.uci} (${b.when})`).join(", ")}.`] : []),
        ];
      })(),
      `What happened next in the game: ${g.moves.slice(i + 1, i + 4).map((mv) => `${moveNo(mv.ply)} ${mv.san} (${mv.analysis?.classification ?? "?"})`).join(", ") || "the game ended"}.`,
      ...(() => {
        const near = speechAround(g, plan, i);
        return near.length
          ? [
              `What the players say around your line, in order (their own voices; you can re-cut or drop any of it with \`speech\`, see below):`,
              ...near.flatMap((s) => [
                `    ply ${s.ply} (${s.kind}, ${s.when} your line), ${name(s.color)}: ${s.text ? `"${s.text}"` : "(nothing said)"}`,
                `      their full commentary on that move: "${s.source}"`,
              ]),
            ]
          : [];
      })(),
      choosable(ln)
        ? `It can play before ${m.san} (a puzzle, "first": true) or after it (a reveal, "first": false). It's set to ${ln.first ? "before" : "after"}; choose whichever makes this line land hardest.`
        : `It plays after ${m.san} (it needs the move on the board).`,
      ...(ln.beats?.length ? ["What the narrator says now (rewrite it freely):", ...ln.beats.map((b) => `    "${b.text}"`)] : []),
    );
  }
  out.push(
    "",
    "## Your answer",
    "Write a JSON file in your working folder and submit it with `narrate <file.json>`. Shape:",
    "```json",
    JSON.stringify(
      {
        lines: [
          {
            ply: 53,
            first: true,
            end: 4,
            beats: [
              { at: "start", text: "…before the line plays…" },
              { at: "start", text: "…the move named here lands as it's said…", delivery: "building", cues: [{ words: "…the words naming it…", moves: 1 }], draw: [{ words: "the queen on h4", reach: "f5>h4" }] },
              { at: 1, text: "…room for it, then on…" },
            ],
            branches: [
              {
                at: 1,
                move: "Qh5",
                when: "after",
                beats: [
                  { at: "start", text: "…the question, with the board wound back to where it splits…" },
                  { at: "start", text: "…the other move lands as it's named, and why it doesn't help…", cues: [{ words: "…the words naming it…", moves: 2 }] },
                ],
              },
            ],
          },
          {
            ply: 81,
            first: false,
            beats: [
              { at: "start", text: "…reacting to the move that just landed, then back to what was there…", delivery: "stunned" },
              { at: "start", text: "…the better move lands as it's said…", cues: [{ words: "…the words naming it…", moves: 1 }] },
            ],
          },
        ],
        speech: [
          { ply: 82, quote: "…a different part of that move's commentary, so it doesn't repeat you…" },
          { ply: 83, quote: "" },
        ],
      },
      null,
      2,
    ),
    "```",
    "- lines: one entry per line you narrate (a line you leave out keeps what it has). `ply` is the moment's ply.",
    "- beats: what the narrator says, in order, up to 8 per line, each at most 60 words. `at`: where the board is when it starts (\"start\", a count of the line's moves on the board, or one of its moves in SAN, said once it has landed; a move that comes twice is given as a count). `delivery` (optional): how it's said, in at most 6 words (\"building\", \"amazed\", \"wincing\").",
    "- enter (optional, first beat at start, without a punishment opening): exact words of that beat, e.g. \"enter\": \"Rewind\". Until those words the real board, move badge and eval stay visible. On the cue the board takes the engine tint and, for an after-the-move instead line, quickly undoes the player's move. Use it when reacting to the eval swing before looking back; whenever you say rewind, put the cue on that word. Say \"rewind\" (or anything like it) only where the board really winds back: an `instead` line played after its move. An `after` line plays forward from the position on screen, and a line played before its move starts from the position the player faced, so neither rewinds: lead straight into it (\"Here's why.\", \"Watch.\"). Omit it to enter immediately. Leave a short phrase after entry before the first move cue so the rewind can finish.",
    "- cues (optional): the board follows your words. Each says: by these words of the text, this many of the line's moves (or up to this move) are on the board. The move lands as its words are said, and moves before it come in just ahead, each held long enough for its badge to show (just under a second apiece), so a run of forced replies plays under a phrase or two: give a long run the words to cover it. Without cues, a beat is said with the board standing still. After entry, cues only move forward. At the end the video automatically unwinds every variation move quickly to its starting position, then replays the real move if this was an after-the-move instead line. Do not add beats just to perform that return.",
    "- draw (optional): a piece's reach (\"from>to\", an attack or a defence) or a circled `square`, on the board as it is when its words are said. `words` is the whole phrase that names what it points at (\"the queen on h4\", not just \"queen\"): all of it lights up in that piece's colour, and the drawing appears as its first word is said.",
    "- end (optional): how many of the line's moves are shown (a count, or the move it ends on). Cut it once the point is made; without it the whole line plays. A line cut down to a plain capture the move's best-move arrow already shows is refused.",
    `- branches (optional, at most ${MAX_BRANCHES}; required when the line has a ★): each { "at", "move", "when", "end", "beats" }. \`at\` and \`move\`: one of the branches listed for the line (the point as a count of the line's moves, the move in SAN). \`when\`: "before" or "after" (see "Branches"). \`end\` (optional): how many of the branch's moves are shown, its first move included. \`beats\`: up to ${MAX_BRANCH_BEATS}, written like the line's, but \`at\` and cues count the branch's own moves (0: the board at the split point, before the other move).`,
    "- bestArrow (optional, an `instead` line played after its move): when the move lands, its best-move arrow and \"best was…\" would show your answer before you reveal it, so by default they're hidden; true keeps them (for when the reveal isn't the point).",
    "- first (optional, an `instead` line without a punishment): true plays the line before the move (a puzzle), false after it (a reveal; the default). See \"Before or after the move\". Played before, leave room for the player's own words, which come right after your line.",
    "- speech (optional): what the players say around your lines, re-cut so the voices don't repeat each other. Each is { \"ply\": …, \"quote\": \"…\" }: on a moment, it replaces what the mover says there; on any other ply, it's the aside said there. The quote must be that move's own words, quoted exactly from its commentary (a moment's quote at most 60 words, an aside's at most 25); \"\" drops it. Only plies near a line can be changed (from two before it to six after). A re-cut quote keeps the drawings of the words it keeps.",
    `- Everything spoken in the video, your beats included, must stay under ${VOICE_BUDGET} characters; the server tells you if it doesn't. Dropping lines can't leave the video silent for long either: the server sends it back if it does.`,
    "Each submission is checked, saved and read back to you with how it will play. Fix anything that's off and submit again; when you're happy with it, you're done.",
  );
  return out.join("\n");
}

/** The narration submitted for a saved plan, checked like a plan's lines: the plan with those lines' narration replaced. */
export function applyNarration(g: Game, raw: unknown): VideoPlan {
  const plan = g.video!;
  const r = raw as any;
  if (!r || typeof r !== "object" || !Array.isArray(r.lines)) throw new ActionError("The narration needs a `lines` list: { \"lines\": [{ \"ply\": …, \"beats\": [...] }] }.");
  const moments = plan.moments.map((x) => ({ ...x }));
  const done = new Set<number>();
  r.lines.forEach((l: any, n: number) => {
    const where = `lines[${n}]`;
    const ply = int(l?.ply);
    const x = moments.find((y) => y.ply === ply);
    if (!x?.line) throw new ActionError(`${where}.ply: ${Number.isFinite(ply) ? `ply ${ply} has no engine line in the plan` : "give the ply of a moment with an engine line"} (${moments.filter((y) => y.line).map((y) => y.ply).join(", ") || "none"}).`);
    if (done.has(ply)) throw new ActionError(`${where}: ply ${ply} is listed twice.`);
    done.add(ply);
    const i = g.moves.findIndex((m) => m.ply === ply);
    const sl = shownLine(g, i, x.line.kind, !x.line.deep, true);
    if (!sl) throw new ActionError(`${where}: the line at ply ${ply} can't be shown any more; leave it out.`);
    if (l?.first === true && x.line.punish) throw new ActionError(`${where}.first: this line shows what the move allowed first, which needs the move on the board, so it can't play before it.`);
    if (x.line.punish && l?.beats?.some((b: any) => b?.enter !== undefined)) throw new ActionError(`${where}.beats: enter isn't available after a punishment opening.`);
    // The line's caption, refs and punishment stay as the plan has them; only the narration is checked here.
    const parsed = lineChoice(g, i, { beats: l.beats, end: l.end, first: l.first, bestArrow: l.bestArrow, branches: l.branches, kind: x.line.kind }, `${where}`);
    // A line with a branch the brief recommends (★) shows one: the question it answers is what makes the line.
    const cut = parsed?.end ? { ...sl, moves: sl.moves.slice(0, parsed.end) } : sl;
    const star = recommendedBranch(g, x, sl);
    if (star && !parsed?.branches?.length && star.at < cut.moves.length)
      throw new ActionError(`${where}.branches: this line has a recommended branch (★ at ${star.at}: ${star.moves[0].san}, "${star.question}"). Play it (or another one offered for this line), "before" or "after", with its own beats.`);
    x.line = { ...x.line, ...(parsed?.beats ? { beats: parsed.beats } : {}), end: parsed?.end, first: parsed?.first, showBest: parsed?.showBest, branches: parsed?.branches };
    if (!x.line.showBest) delete x.line.showBest;
    if (!x.line.branches) delete x.line.branches;
    if (!parsed?.beats) delete x.line.beats;
    if (!x.line.end) delete x.line.end;
    if (!x.line.first) delete x.line.first;
  });
  // What the players say around the lines, re-cut by the narrator: a moment's quote (its drawings kept for the
  // words it keeps), or the aside on a ply; "" drops it.
  const near = new Set<number>();
  for (const x of moments) if (x.line) for (const m of aroundLine(g, g.moves.findIndex((mv) => mv.ply === x.ply))) near.add(m.ply);
  if (r.speech !== undefined && r.speech !== null && !Array.isArray(r.speech)) throw new ActionError("`speech` must be a list.");
  let asideRaw: any[] = (plan.asides ?? []).map((a) => ({ ...a }));
  ((r.speech ?? []) as any[]).forEach((sp, n) => {
    const where = `speech[${n}]`;
    const m = moveAt(g, sp?.ply, where);
    if (!near.has(m.ply)) throw new ActionError(`${where}: ply ${m.ply} isn't near any engine line; only what's said around a line can be changed here (plies ${[...near].sort((a, b) => a - b).join(", ")}).`);
    const quote = str(sp?.quote).trim();
    const d = delivery(sp?.delivery, `${where}.delivery`);
    const x = moments.find((y) => y.ply === m.ply);
    if (x) {
      if (!quote) {
        delete x.thought;
        delete x.marks;
        delete x.delivery;
        return;
      }
      const thought = moveQuote(g, m, quote, `${where}.quote`, 70, 60, 480)!;
      let marks = thought === x.thought ? x.marks : hookMarksFrom(x, thought);
      if (marks && thought !== x.thought) {
        try {
          checkRefs(g, m, thought, marks, where);
        } catch {
          marks = undefined;
        }
      }
      x.thought = thought;
      if (marks) x.marks = marks;
      else delete x.marks;
      if (d) x.delivery = d;
      return;
    }
    asideRaw = asideRaw.filter((a) => a.ply !== m.ply);
    if (quote) asideRaw.push({ ply: m.ply, quote, ...(d && { delivery: d }), ...(sp?.short === true && { short: true }) });
  });
  const asides = asideList(g, asideRaw.sort((a, b) => a.ply - b.ply), moments);
  const next: VideoPlan = { ...plan, moments, ...(asides ? { asides } : {}) };
  if (!asides) delete next.asides;
  for (const format of ["landscape", "portrait"] as const) {
    const silent = silentStretches(g, next, format);
    if (silent.length)
      throw new ActionError(
        `With these changes the ${format === "landscape" ? "YouTube" : "TikTok"} cut goes more than ${MAX_SILENCE[format]} s with nothing said:\n${silent.map((q) => `- ${q}`).join("\n")}\nKeep a line there instead of dropping it.`,
      );
  }
  const spoken = new Set<string>();
  for (const l of videoLines({ ...g, video: next })) {
    const voice = lineVoice(g, l);
    if (voice) spoken.add(`${voice}|${spokenText(l.text, l.delivery)}`);
  }
  const total = [...spoken].reduce((k, s) => k + s.length - s.indexOf("|") - 1, 0);
  if (total > VOICE_BUDGET) throw new ActionError(`With this narration everything spoken in the video comes to ${total} characters; keep it under ${VOICE_BUDGET}. Shorten the beats.`);
  return next;
}
