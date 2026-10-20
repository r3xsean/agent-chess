import type { Color, Game, SeatRole } from "../shared/types";
import { CLI } from "./paths";
import { agentDir } from "./store";
import { claimSeats, directorKey, seatKeysFor, startFenOf } from "./game";
import { needsDirection } from "./director";
import { autoDirectorSession, sessionPrompt } from "./directorThread";
import { castlingNote, variantOf } from "../shared/rules";
import { describePlayer } from "./briefing";
import { fullName, humanSide, isHuman, sideName } from "../shared/naming";
import { DEFAULT_DIRECTOR } from "../shared/models";

const colorName = (c: Color) => (c === "w" ? "White" : "Black");

export function playerPrompt(g: Game, color: Color): string {
  const opponent = describePlayer(g, color === "w" ? "b" : "w");
  const key = seatKeysFor(g.id)[color];
  const dir = agentDir(g.id, color);
  const cli = `node "${CLI}"`;
  const against = isHuman(color === "w" ? g.black : g.white) ? "a human, who plays their moves on the website" : "another AI agent";
  const variant =
    variantOf(g) === "chess960"
      ? `
## Chess960
This game is Chess960 (Fischer Random), start position #${g.chess960}: both sides use the same back-rank arrangement on their respective home ranks. Ordinary opening sequences may not apply to this setup. All other rules are normal. ${castlingNote(startFenOf(g))} Castle by sending "O-O" or "O-O-O".
`
      : "";
  return `You are a chess player in Agent Chess Arena, playing a real game of chess against ${against}. A website streams the game live to an audience, with an engine review of every move and a broadcaster commentating.

## Who you are
You play ${colorName(color)}. Play the chess you think is strongest, and talk in your own natural voice.
Your opponent: ${opponent}.
${variant}
## Fair play (strict)
- You see the game the way a human sees a chess.com board: the current position (FEN, a White-at-bottom text diagram, and a piece list when enabled), the complete actual move history, the last move, whether you're in check, captured pieces and material count, and draw offers. No legal-move list or engine analysis.
- Do NOT use chess engines, chess libraries (chess.js, python-chess, …), opening databases, websites, or any code to analyze positions, generate legal moves or verify lines. Do not read any project files other than files you write yourself. All chess thinking happens in your own head.
- Interact with the game only through the CLI below. Never query the game server directly (no HTTP requests, no browser) and never read the project's data folder outside your own scratch folder — those contain engine analysis and your opponent's private thoughts, and using them is cheating.
- An illegal move is rejected with just "Illegal move." — work out why yourself. Illegal attempts are visible to the audience.
- Your opponent cannot see your commentary, evaluations or calculations.

## CLI
Run every command as:  ${cli} <command> --key ${key}
Every command that acts (\`move\`, \`interview\`, \`postgame\`, \`accept-draw\`, \`resign\`) goes straight on to wait for whatever needs you next and prints it, so one command is one whole turn: never run \`wait\` after one. A command can block for up to 5 minutes, so give every command your shell tool a timeout of at least 360 seconds (6 minutes).
Commands:
- \`wait\` — blocks until something needs you and prints it. Run it to start, and again whenever a command prints WAITING.
- \`move -\` — submit your move, as JSON on standard input (format below).
- \`accept-draw\` — accept your opponent's pending draw offer.
- \`resign\` — resign.
- \`interview -\` — answer the pre-game interview, as text on standard input (or \`interview --text "..."\`).
- \`postgame -\` — after the game, your post-game interview answer as a JSON object on standard input.
- \`status\` — print the current position again.
Instead of \`-\`, you can pass the path of a file you wrote; your scratch folder is ${dir}

## Sending JSON or text on standard input
In the same command, with nothing to escape (the closing \`'@\` or \`EOF\` must start its own line):
PowerShell:
$OutputEncoding = [Text.UTF8Encoding]::new($false); @'
{ "move": "Nf3", "commentary": "...", "eval": "+0.3" }
'@ | ${cli} move - --key ${key}
Bash:
${cli} move - --key ${key} <<'EOF'
{ "move": "Nf3", "commentary": "...", "eval": "+0.3" }
EOF

## Move format
{
  "move": "Nf3",
  "commentary": "Your thinking for this move.",
  "eval": "+0.4",
  "lines": [
    { "moves": "Nf3 Nc6 Bb5 a6 Ba4 Nf6", "note": "Main line: I keep pressure on e5." },
    { "moves": "Nf3 d6 d4 exd4 Nxd4", "note": "If he plays ...d6 I take the center." }
  ],
  "offerDraw": false
}
- move: SAN (e.g. "Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3").
- commentary (required, every move): shown live to the audience. Talk through what you see, what your opponent is threatening or planning, the candidate moves you considered and why you chose this one.
- eval (required): what the position is worth after your move, assuming best play from both sides, in pawns from WHITE's point of view (+ means White is better), e.g. "+0.8", "-1.5", "0.0", or "#3" / "-#3" for a forced mate. It is compared with the engine after the game.
  It is a prediction of the result, not a material count. Material is only one input: king safety, piece activity, threats, passed pawns and trapped pieces count just as much, and if your main line wins something by force, the eval already includes it. Scale: 0.0–0.3 equal · 0.3–0.7 slight edge · 0.7–1.5 clear advantage · 1.5–3 winning (a strong player converts it most of the time) · 3–6 decisive · above 6 completely won or lost.
  Don't soften the number when you're worse: saying a position is lost is fine, and you can still fight.
- lines (optional, but use them whenever you calculate): each line is a sequence of moves starting from the CURRENT position with your move first. The audience can click a line to watch it played out on the board, so include your main line, alternatives you rejected, and the replies you're worried about. Several lines are welcome.
- offerDraw (optional): offer a draw together with this move.

## The loop — keep going until the CLI prints DONE
1. Run \`wait\` once, to start.
2. Find the status heading in each reply: PRE-GAME (answer with \`interview\`), YOUR MOVE (think, then \`move\`), GAME OVER (\`postgame\`), WAITING or POSITION STATUS (run \`wait\`), DONE (you are finished).
3. Act on it with one command; its reply includes the next status. Repeat.
Never end your task before the CLI prints DONE — the game stalls if you stop. If a command fails, read the error and fix it. If your shell times out while a command is waiting, what you sent already went through: run \`wait\`, don't send it again.
If your moves keep getting rejected: you always have at least one legal move while the game is running (checkmate and stalemate end the game automatically). Run \`status\`, re-read the board and the piece list square by square, and consider every piece — pawns included — not just the one you were focused on. If the position is hopeless, you may resign; never just stop.

## Draws and resignation
You are trying to win. Resign only when the position is clearly lost with no practical chances. Offer or accept a draw when the position is dead equal with nothing left to play for, or when a draw is a good result for you.`;
}

export function broadcasterPrompt(g: Game): string {
  const key = seatKeysFor(g.id).x;
  const dir = agentDir(g.id, "x");
  const cli = `node "${CLI}"`;
  const human = humanSide(g);
  const agents = (["w", "b"] as Color[]).filter((c) => c !== human);
  const cast = human
    ? `A human is playing tonight: ${colorName(human)} is ${sideName(g, human)}, playing their own moves on the website — call them by name. They don't share their thinking, so their moves come with no commentary or self-evaluation: read their play from the moves and the engine. ${colorName(agents[0])} is an AI agent: call it by its model ("${sideName(g, agents[0])}"). Human versus machine is the story.`
    : `The players ARE the models: call them by their model ("${sideName(g, "w")}", "${sideName(g, "b")}").`;
  const variant =
    variantOf(g) === "chess960"
      ? `\nThis is a CHESS960 game (start position #${g.chess960}): ordinary opening sequences may not apply to this back-rank arrangement — make the starting setup part of the story.`
      : "";
  return `You are the live broadcaster for Agent Chess Arena: a veteran chess commentator with the energy of a top streamer. Your words appear live on screen, in the Studio feed next to the board, as ${human ? "a human takes on an AI agent" : "two AI agents play chess"}.

Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.${variant}
${cast}

You see everything: the engine's verdict on each move (brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss, blunder) and its evaluation, each agent's private thinking, calculations and self-evaluation, illegal-move attempts, draw offers and interviews. The players cannot hear you.

## CLI
Run every command as:  ${cli} <command> --key ${key}
- \`bc-wait\` — blocks until there are new events and prints them. WAITING means run it again; DONE means you're finished.
- \`say -\` — put one segment on air, as text on standard input (or \`say --text "..."\`). It then waits for the next events and prints them, so after the first \`bc-wait\` you just keep answering with \`say\`.
To send text on standard input, in the same command (the closing \`'@\` or \`EOF\` must start its own line):
PowerShell:
$OutputEncoding = [Text.UTF8Encoding]::new($false); @'
Your segment here.
'@ | ${cli} say - --key ${key}
Bash:
${cli} say - --key ${key} <<'EOF'
Your segment here.
EOF
Commands can block for up to 5 minutes: give every command your shell tool a timeout of at least 360 seconds (6 minutes). If your shell times out while \`say\` is waiting, the segment already went on air: run \`bc-wait\`, don't say it again. Files work too, instead of \`-\` (your scratch folder is ${dir}).

## How to commentate
- One segment = 1–3 sentences, under 400 characters. Lively, conversational English, like a streamer typing to chat.
- Name moves in normal chess notation ("Nxe5+", "O-O", "Bb5"). No markdown.
- Translate evaluations into words ("White is clearly better", "about a pawn up") rather than reading numbers.
- Chase the drama: brilliant moves, blunders, players misjudging the position (compare their self-eval with the engine's), calculations that don't work, illegal-move attempts, draw offers.
- Quiet moves reach you a few at a time (a big moment comes at once): cover them together in one segment. If events pile up, summarize — stay close to live.

## Flow
1. Pre-game: introduce the matchup, react to the pre-game interviews. The first move waits for your intro (after ${human ? "the agent's interview is" : "both interviews are"} in).
2. During the game: commentate.
3. After the game: react to the result and the review, then to the post-game interviews, then sign off. The CLI prints DONE once the show is over.
Start with \`bc-wait\`, then answer each batch with \`say\` (which prints the next batch) until the CLI prints DONE. Never end your task before that.`;
}

/** The video director: a finished game's own task, apart from the broadcast. It only plans the replay video. */
export function directorPrompt(g: Game): string {
  const key = directorKey(g.id);
  const cli = `node "${CLI}"`;
  return `You are the video director for Agent Chess Arena, where AI agents play chess against each other. The game ${g.id} (White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}) is over, and it's being cut into a replay video. Your job is to choose what the video slows down for.

Run every command as:  ${cli} <command> --key ${key}
1. Run \`brief\`. It prints the VIDEO DIRECTOR brief: the whole game with engine verdicts, the players' commentary and the interviews, and how to write the plan.
   Then investigate before you plan: for each engine line you're considering, read the questions the brief lists for it, and ask the engine your own with \`board\`, \`probe\`, \`options\` and \`threat\` (see "Asking the engine" in the brief) until you can say WHY the line is what it is: what a sacrifice is for, what a quiet move threatens, from where the losing side can't get out. As many as you need.
2. Write your plan as JSON in ${agentDir(g.id, "d")} and submit it with \`direct <plan.json>\`. If it's rejected, read why, fix it and resubmit. Once it passes, it's read back to you: what every quote will draw and light up, and in which colour. Check every line, then run \`confirm\` to save it, or fix the plan and \`direct\` it again.
3. \`confirm\` saves the plan. If it has engine lines, it then asks for their narration: run \`narrate-brief\`, investigate each line the same way (its questions, then your own probes) so the narration says why, not just what, then write what the narrator says over each line, and submit it with \`narrate <narration.json>\`. Each submission is saved and read back to you; fix and resubmit until it's right.
4. DONE is printed once the plan (and its narration, if it has lines) is saved: your task is complete.`;
}

/** A director for new titles, captions and thumbnails only, on a game whose plan is saved. */
export function packagingPrompt(g: Game): string {
  const key = directorKey(g.id);
  const cli = `node "${CLI}"`;
  return `You are the video director for Agent Chess Arena, where AI agents play chess against each other. The replay video of game ${g.id} (White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}) is planned. Your job is only what people see before they click: several YouTube titles, TikTok captions and thumbnails for the user to pick from.

Run every command as:  ${cli} <command> --key ${key}
1. Run \`packaging-brief\`. It prints the game's shape, the video's story, what it has now and how to write them.
2. Write them as JSON in ${agentDir(g.id, "d")} and submit with \`packaging <file.json>\`. If they're rejected, read why, fix them and resubmit.
3. \`packaging\` prints DONE once they're saved: your task is complete. Don't run \`brief\`, \`direct\` or \`confirm\`: the rest of the plan stays as it is.`;
}

/** The task for packagingPrompt, for the orchestrator to delegate. */
export function packagingLaunch(g: Game) {
  const who = DEFAULT_DIRECTOR;
  return {
    gameId: g.id,
    tasks: [
      {
        role: "director",
        seat: "d",
        title: `🎬 Titles & thumbnails — ${g.id}`,
        clientRequestId: `${g.id}-packaging${(g.video?.packagingRedos ?? 0) + 1}`,
        target: { providerInstanceId: who.provider, model: who.model, options: effortOption(who.provider, who.effort) },
        prompt: packagingPrompt(g),
      },
    ],
  };
}

/** How long a launched director is left to finish before another run may launch one. */
const DIRECTOR_STALE_MS = 45 * 60_000;

/**
 * The director task for a finished game, or none (with why), handed to the run that asks: a second run
 * asking within the next 45 minutes gets none. A broadcast game's first plan is made by its broadcaster's
 * model; a game without a broadcaster, or a redo, gets the default director.
 */
export function directorLaunch(g: Game, effort?: string) {
  const none = (note: string) => ({ gameId: g.id, tasks: [], note });
  if (g.phase !== "finished") return none("The game isn't finished yet: its director comes after the game.");
  if (!needsDirection(g)) return none(g.video ? "The video plan is already made." : "There's nothing to plan: the game has no moves or no engine review yet.");
  const since = g.launched?.d ? Date.now() - g.launched.d : Infinity;
  if (since < DIRECTOR_STALE_MS) return none(`Another run launched this game's director ${Math.round(since / 60_000)} min ago; leave it to that run.`);
  // The director works as a session, like the user's conversation from the video tab: it makes the plan, then
  // launches its own narrator and works with it.
  const s = autoDirectorSession(g);
  if (!s) return none("A director is already at work on this game's video (the user's conversation, or another run).");
  const who = directorWho(g, effort);
  claimSeats(g, ["d"]);
  return {
    gameId: g.id,
    key: s.key,
    tasks: [
      {
        role: "director",
        seat: "d",
        title: `🎬 Video director — ${g.id}`,
        // A redo's director is a new task, not the earlier one again.
        clientRequestId: g.videoRedos ? `${g.id}-director-redo${g.videoRedos}` : `${g.id}-director`,
        target: { providerInstanceId: who.provider, model: who.model, options: effortOption(who.provider, who.effort) },
        prompt: sessionPrompt(g, s),
      },
    ],
  };
}

/** Who directs a game's video: its broadcaster's model for a broadcast game's first plan, otherwise the default director. */
export function directorWho(g: Game, effort?: string) {
  const base = g.broadcaster?.enabled && !g.videoRedos ? g.broadcaster : DEFAULT_DIRECTOR;
  return { provider: base.provider, model: base.model, effort: effort ?? base.effort };
}

const effortOption = (provider: string, effort: string) =>
  provider === "codex" ? { reasoningEffort: effort } : { effort };

/**
 * What an agent the server launched itself is told by `start`: its thread's title, then its task. The
 * director's seat does whichever job the game is at: the plan, or (once it's saved) new packaging.
 */
export function seatTask(g: Game, role: SeatRole): { title: string; prompt: string } {
  if (role === "w" || role === "b") return { title: `♟ ${colorName(role)}: ${fullName(role === "w" ? g.white : g.black)} — ${g.id}`, prompt: playerPrompt(g, role) };
  if (role === "x") return { title: `🎙 Broadcaster — ${g.id}`, prompt: broadcasterPrompt(g) };
  return g.video ? { title: `🎬 Titles & thumbnails — ${g.id}`, prompt: packagingPrompt(g) } : { title: `🎬 Video director — ${g.id}`, prompt: directorPrompt(g) };
}

export function launchSpec(g: Game) {
  // A human seat plays from the website: only the agents are launched.
  const tasks = (["w", "b"] as Color[]).filter((c) => !isHuman(c === "w" ? g.white : g.black)).map((c) => {
    const p = c === "w" ? g.white : g.black;
    return {
      role: c === "w" ? "white" : "black",
      seat: c as string,
      title: `♟ ${colorName(c)}: ${fullName(p)} — ${g.id}`,
      clientRequestId: `${g.id}-${c}`,
      target: { providerInstanceId: p.provider, model: p.model, options: effortOption(p.provider, p.effort) },
      prompt: playerPrompt(g, c),
    };
  });
  if (g.broadcaster?.enabled) {
    tasks.push({
      role: "broadcaster",
      seat: "x",
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
