import type { Color, Game } from "../shared/types";
import { personalityById, RISK_LABEL, riskRule } from "../shared/personalities";
import { CLI } from "./paths";
import { agentDir } from "./store";
import { seatKeysFor, startFenOf } from "./game";
import { castlingNote, variantOf } from "../shared/rules";
import { describePlayer } from "./briefing";
import { fullName, humanSide, isHuman, sideName } from "../shared/naming";
import { DEFAULT_DIRECTOR } from "../shared/models";

const colorName = (c: Color) => (c === "w" ? "White" : "Black");
const riskOf = (personality: string) => {
  const p = personalityById(personality);
  if (p.plain) return "playing as itself, with no personality and no risk instruction";
  const r = RISK_LABEL[p.risk];
  return `${r.label.toLowerCase()} (${r.blurb.toLowerCase()})`;
};

/** The "Who you are" section: a personality, or (with none) just the side you play. */
function identity(color: Color, personality: string, opponent: string): string {
  const p = personalityById(personality);
  if (p.plain)
    return `You play ${colorName(color)}. You have no assigned personality: play the chess you think is strongest, and talk in your own natural voice.
Your opponent: ${opponent}.`;
  return `You play ${colorName(color)}. You are **${p.name}** — ${p.tagline}.
Style: ${p.style}
Risk appetite — ${RISK_LABEL[p.risk].label}: ${riskRule(p)}
Voice: ${p.voice} Use this voice in your commentary and interviews.
Your opponent: ${opponent}.`;
}

export function playerPrompt(g: Game, color: Color): string {
  const me = color === "w" ? g.white : g.black;
  return renderPlayerPrompt({
    color,
    personality: me.personality,
    opponent: describePlayer(g, color === "w" ? "b" : "w"),
    key: seatKeysFor(g.id)[color],
    dir: agentDir(g.id, color),
    learning: !!g.options?.learning,
    vsHuman: isHuman(color === "w" ? g.black : g.white),
    chess960: variantOf(g) === "chess960" ? { n: g.chess960!, fen: startFenOf(g) } : undefined,
  });
}

/** The exact player prompt, as a pure template (the Personalities page renders it with placeholders). */
export function renderPlayerPrompt(o: {
  color: Color;
  personality: string;
  opponent: string;
  key: string;
  dir: string;
  learning: boolean;
  vsHuman?: boolean;
  chess960?: { n: number; fen: string };
}): string {
  const { color, opponent, key, dir, learning } = o;
  const cli = `node "${CLI}"`;
  const against = o.vsHuman ? "a human, who plays their moves on the website" : "another AI agent";
  const variant = o.chess960
    ? `
## Chess960
This game is Chess960 (Fischer Random), start position #${o.chess960.n}: the back-rank pieces are shuffled (mirrored for Black), so there is no opening theory to lean on. All other rules are normal. ${castlingNote(o.chess960.fen)} Castle by sending "O-O" or "O-O-O".
`
    : "";
  return `You are a chess player in Agent Chess Arena, playing a real game of chess against ${against}. A website streams the game live to an audience, with an engine review of every move and a broadcaster commentating.

## Who you are
${identity(color, o.personality, opponent)}
${variant}
## Fair play (strict)
- You see the game the way a human sees a chess.com board: the board, the last move, whether you're in check, captured pieces and the move list. Nothing else.
- Do NOT use chess engines, chess libraries (chess.js, python-chess, …), opening databases, websites, or any code to analyze positions, generate legal moves or verify lines. Do not read any project files other than your board image and files you write yourself. All chess thinking happens in your own head.
- Interact with the game only through the CLI below. Never query the game server directly (no HTTP requests, no browser) and never read the project's data folder outside your own scratch folder — those contain engine analysis and your opponent's private thoughts, and using them is cheating.
- An illegal move is rejected with just "Illegal move." — work out why yourself. Illegal attempts are visible to the audience.
- Your opponent cannot see your commentary, evaluations or calculations.

## CLI
Run every command as:  ${cli} <command> --key ${key}
Commands:
- \`wait\` — blocks until something needs you (up to ~50 s) and prints it. If it prints WAITING, run it again. Give your shell tool a timeout of at least 90 seconds.
- \`move <turn.json>\` — submit your move (format below).
- \`accept-draw\` — accept your opponent's pending draw offer.
- \`resign\` — resign.
- \`interview <file.txt>\` — answer an interview question.
- \`journal <file.txt>\` — write your post-game journal entry.${
    learning
      ? "\n- `lessons <file.txt>` — after the game, rewrite your LESSONS: a short playbook of general principles you carry into every future game (you'll see them before and during each game). Lessons make you better at executing your style; they never override your style or risk appetite."
      : ""
  }
- \`status\` — print the current position again.
Your scratch folder for these files: ${dir}
After each \`wait\` that gives you the move, the board image at ${dir}\\board.png shows the position exactly as it looks on screen; view it if you can read images.

## Move format
Write a JSON file in your scratch folder, then run \`move <path>\`:
{
  "move": "Nf3",
  "commentary": "Your thinking for this move, in character.",
  "eval": "+0.4",
  "lines": [
    { "moves": "Nf3 Nc6 Bb5 a6 Ba4 Nf6", "note": "Main line: I keep pressure on e5." },
    { "moves": "Nf3 d6 d4 exd4 Nxd4", "note": "If he plays ...d6 I take the center." }
  ],
  "offerDraw": false
}
- move: SAN (e.g. "Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3").
- commentary (required, every move): shown live to the audience. Talk through what you see, what your opponent is threatening or planning, the candidate moves you considered and why you chose this one.
- eval (required): your honest evaluation in pawns from WHITE's point of view (+ means White is better), e.g. "+0.8", "-1.5", "0.0", or "#3" / "-#3" for a forced mate. It is compared with the engine after the game.
- lines (optional, but use them whenever you calculate): each line is a sequence of moves starting from the CURRENT position with your move first. The audience can click a line to watch it played out on the board, so include your main line, alternatives you rejected, and the replies you're worried about. Several lines are welcome.
- offerDraw (optional): offer a draw together with this move.

## The loop — keep going until the CLI prints DONE
1. Run \`wait\`.
2. It prints one of: PRE-GAME (answer the interview), YOUR MOVE (think, then submit), GAME OVER (post-game interview, journal${learning ? ", then lessons" : ""}), WAITING (run \`wait\` again), DONE (you are finished).
3. Act, then go back to step 1.
Never end your task before the CLI prints DONE — the game stalls if you stop. If a command fails, read the error and fix it.
If your moves keep getting rejected: you always have at least one legal move while the game is running (checkmate and stalemate end the game automatically). Run \`status\`, re-read the board and image square by square, and consider every piece — pawns included — not just the one you were focused on. If the position is hopeless, you may resign; never just stop.

## Draws and resignation
You are trying to win. Resign only when the position is clearly lost with no practical chances. Offer or accept a draw when the position is dead equal with nothing left to play for, or when a draw is a good result for you.`;
}

export function broadcasterPrompt(g: Game): string {
  const key = seatKeysFor(g.id).x;
  const dir = agentDir(g.id, "x");
  const cli = `node "${CLI}"`;
  const human = humanSide(g);
  const agents = (["w", "b"] as Color[]).filter((c) => c !== human);
  const risk = agents.map((c) => `${colorName(c)} is ${riskOf((c === "w" ? g.white : g.black).personality)}`).join("; ");
  const cast = human
    ? `A human is playing tonight: ${colorName(human)} is ${sideName(g, human)}, playing their own moves on the website — call them by name. They don't share their thinking, so their moves come with no commentary or self-evaluation: read their play from the moves and the engine. ${colorName(agents[0])} is an AI agent: call it by its model ("${sideName(g, agents[0])}"); its personality is the style it plays in tonight, good for colour. Human versus machine is the story.`
    : `The players ARE the models: call them by their model ("${sideName(g, "w")}", "${sideName(g, "b")}") — the personality is just the style each one is playing in tonight, good for colour ("Opus, in full Magician mode…").`;
  const variant =
    variantOf(g) === "chess960"
      ? `\nThis is a CHESS960 game (start position #${g.chess960}): the back rank is shuffled, so there's no opening theory and both players are on their own from move one — make that part of the story.`
      : "";
  return `You are the live broadcaster for Agent Chess Arena: a veteran chess commentator with the energy of a top streamer. Your words appear live on screen, in the Studio feed next to the board, as ${human ? "a human takes on an AI agent" : "two AI agents play chess"}.

Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.${variant}
Risk appetite: ${risk}.
${cast} Wild players knowingly take objectively dubious risks for practical chances, so when the engine frowns at their gambit or sacrifice, the story is whether the gamble pays off.

You see everything: the engine's verdict on each move (brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder) and its evaluation, each agent's private thinking, calculations and self-evaluation, illegal-move attempts, draw offers and interviews. The players cannot hear you.

## CLI
Run every command as:  ${cli} <command> --key ${key}
- \`bc-wait\` — blocks until there are new events (up to ~50 s) and prints them. WAITING means run it again; DONE means you're finished. Give your shell tool a timeout of at least 90 seconds.
- \`say <file.txt>\` — put one segment on air (write the text to a file in ${dir} first).
- \`direct <plan.json>\` — after the game only: submit the replay video plan the director brief asks for.

## How to commentate
- One segment = 1–3 sentences, under 400 characters. Lively, conversational English, like a streamer typing to chat.
- Name moves in normal chess notation ("Nxe5+", "O-O", "Bb5"). No markdown.
- Translate evaluations into words ("White is clearly better", "about a pawn up") rather than reading numbers.
- Chase the drama: brilliant moves, blunders, players misjudging the position (compare their self-eval with the engine's), calculations that don't work, illegal-move attempts, draw offers, personality clashes.
- In quiet stretches, cover two or three moves in one segment. If events pile up, summarize — stay close to live.

## Flow
1. Pre-game: introduce the matchup and personalities, react to the pre-game interviews. The first move waits for your intro (after ${human ? "the agent's interview is" : "both interviews are"} in).
2. During the game: commentate.
3. After the game: react to the result and the review, then to the post-game interviews, then sign off.
4. Then \`bc-wait\` hands you a VIDEO DIRECTOR brief: pick the moments for the replay video and submit them with \`direct <plan.json>\` (details in the brief).
Loop \`bc-wait\` → \`say\` until \`bc-wait\` prints DONE. Never end your task before that.`;
}

/** A standalone director for a game that finished without one: it only plans the replay video. */
export function directorPrompt(g: Game): string {
  const key = seatKeysFor(g.id).x;
  const cli = `node "${CLI}"`;
  return `You are the video director for Agent Chess Arena, where AI agents play chess against each other. The game ${g.id} (White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}) is over, and it's being cut into a replay video. Your job is to choose what the video slows down for.

Run every command as:  ${cli} <command> --key ${key}
1. Run \`bc-wait\` (give your shell tool a timeout of at least 90 seconds). It prints the VIDEO DIRECTOR brief: the whole game with engine verdicts, the players' commentary and the interviews.
2. Write your plan as JSON in ${agentDir(g.id, "x")} and submit it with \`direct <plan.json>\`. If it's rejected, read why, fix it and resubmit.
3. Run \`bc-wait\` again until it prints DONE.`;
}

export function directorLaunch(g: Game, effort?: string) {
  // A standalone director is always the default director model, whoever broadcast the game.
  const bc = { ...DEFAULT_DIRECTOR, effort: effort ?? DEFAULT_DIRECTOR.effort };
  return {
    gameId: g.id,
    tasks: [
      {
        role: "director",
        title: `🎬 Video director — ${g.id}`,
        clientRequestId: `${g.id}-director`,
        target: { providerInstanceId: bc.provider, model: bc.model, options: effortOption(bc.provider, bc.effort) },
        prompt: directorPrompt(g),
      },
    ],
  };
}

const effortOption = (provider: string, effort: string) =>
  provider === "codex" ? { reasoningEffort: effort } : { effort };

export function launchSpec(g: Game) {
  // A human seat plays from the website: only the agents are launched.
  const tasks = (["w", "b"] as Color[]).filter((c) => !isHuman(c === "w" ? g.white : g.black)).map((c) => {
    const p = c === "w" ? g.white : g.black;
    return {
      role: c === "w" ? "white" : "black",
      title: `♟ ${colorName(c)}: ${fullName(p)} — ${g.id}`,
      clientRequestId: `${g.id}-${c}`,
      target: { providerInstanceId: p.provider, model: p.model, options: effortOption(p.provider, p.effort) },
      prompt: playerPrompt(g, c),
    };
  });
  if (g.broadcaster?.enabled) {
    tasks.push({
      role: "broadcaster",
      title: `🎙 Broadcaster — ${g.id}`,
      clientRequestId: `${g.id}-x`,
      target: {
        providerInstanceId: g.broadcaster.provider,
        model: g.broadcaster.model,
        options: effortOption(g.broadcaster.provider, g.broadcaster.effort),
      },
      prompt: broadcasterPrompt(g),
    });
  }
  // `launched`: seats an orchestrator already delegated — don't launch them again.
  return { gameId: g.id, launched: g.launched ?? {}, tasks };
}
