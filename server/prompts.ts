import type { Color, Game, SeatRole } from "../shared/types";
import { CLI } from "./paths";
import { agentDir } from "./store";
import { claimSeats, directorKey, seatKeysFor, startFenOf } from "./game";
import { needsDirection } from "./director";
import { autoDirectorSession, sessionPrompt } from "./directorThread";
import { castlingNote, variantOf } from "../shared/rules";
import { describePlayer, setOpeningNote } from "./briefing";
import { fullName, isHuman } from "../shared/naming";
import { DEFAULT_DIRECTOR } from "../shared/models";
import { seatSetup } from "../shared/seatSetup";

const colorName = (c: Color) => (c === "w" ? "White" : "Black");

/**
 * A player's task. `via`: "tools" for an agent playing through the chess MCP tools (cli/chess-mcp.mjs), which
 * bring its board picture with each turn; else the CLI, which names the picture's file.
 */
export function playerPrompt(g: Game, color: Color, via: "cli" | "tools" = "cli"): string {
  const opponent = describePlayer(g, color === "w" ? "b" : "w");
  const key = seatKeysFor(g.id)[color];
  const dir = agentDir(g.id, color);
  const cli = `node "${CLI}"`;
  const tools = via === "tools";
  const setup = seatSetup(g, color);
  const sees =
    setup.view === "image"
      ? "the current position as a picture of the board from your side (no FEN, text diagram or piece list)"
      : `the current position (FEN, a White-at-bottom text diagram, and a piece list when enabled${setup.view === "added" ? ", plus a picture of the board from your side" : ""})`;
  const picture =
    setup.view === "text"
      ? ""
      : `
## The board picture
Every time you're shown the position (YOUR MOVE, POSITION STATUS), it comes with a picture of the board from your side: your pieces at the bottom, files and ranks marked round the edge, the last move's two squares tinted, and a king in check ringed in red. ${tools ? "It is attached to the tool's reply." : "Its file is on the BOARD PICTURE line: open it with your file-reading or image-viewing tool every turn (it's a PNG)."}${setup.view === "image" ? " It is the only board you get: read the position from it." : ""}
Above the board is a check code that changes every move. Send it as "seen" with your move: a move without the code of this turn's picture is turned down (that isn't an illegal move, and it isn't shown with your moves).
`;
  const reread = !setup.reread
    ? ""
    : `
## Write out the position
Before you choose each move, read the position again square by square and write out every piece on the board, both sides, pawns included, as "position" in your move: { "white": ["Kg1", "Qd1", "Ra1", "Pa2", …], "black": ["Kg8", "Pa7", …] } (a letter K Q R B N P, then the square). It is checked against the board before your move is: if it doesn't match, the move is turned down with "your position doesn't match the board", and you read the board again and resend (that isn't an illegal move, and it isn't shown with your moves).
`;
  const against = isHuman(color === "w" ? g.black : g.white) ? "a human, who plays their moves on the website" : "another AI agent";
  const variant =
    variantOf(g) === "chess960"
      ? `
## Chess960
This game is Chess960 (Fischer Random), start position #${g.chess960}: both sides use the same back-rank arrangement on their respective home ranks. Ordinary opening sequences may not apply to this setup. All other rules are normal. ${castlingNote(startFenOf(g))} Castle by sending "O-O" or "O-O-O".
`
      : g.setOpening
        ? `
## Set opening
${setOpeningNote(g)}
`
        : "";
  return `You are a chess player in Agent Chess Arena, playing a real game of chess against ${against}. A website streams the game live to an audience, with an engine review of every move.

## Who you are
You play ${colorName(color)}. Play the chess you think is strongest, and talk in your own natural voice.
Your opponent: ${opponent}.
${variant}
## Fair play (strict)
- You see the game the way a human sees a chess.com board: ${sees}, the complete actual move history, the last move, whether you're in check, captured pieces and material count, and draw offers. No legal-move list or engine analysis.
- Do NOT use chess engines, chess libraries (chess.js, python-chess, …), opening databases, websites, or any code to analyze positions, generate legal moves or verify lines${setup.view === "image" ? ", or to read the board picture for you (no image processing; look at it yourself)" : ""}. Do not read any project files other than files you write yourself${setup.view !== "text" && !tools ? " and your board pictures" : ""}. All chess thinking happens in your own head.
- Interact with the game only through the ${tools ? "chess tools" : "CLI"} below. Never query the game server directly (no HTTP requests, no browser) and never read the project's data folder outside your own scratch folder — those contain engine analysis and your opponent's private thoughts, and using them is cheating.
- An illegal move is rejected with just "Illegal move." — work out why yourself. Illegal attempts are visible to the audience.
- Your opponent cannot see your commentary, evaluations or calculations.
${picture}${reread}
${
  tools
    ? `## Chess tools
You play through the tools of the \`chess\` MCP server; they already know your seat. Every tool that acts (\`move\`, \`interview\`, \`postgame\`, \`accept_draw\`, \`resign\`) goes straight on to wait for whatever needs you next and returns it, so one call is one whole turn: never call \`wait\` after one. A call can take up to 5 minutes.
Tools:
- \`wait\` — blocks until something needs you and returns it. Call it to start, and again whenever a reply says WAITING.
- \`move\` — submit your move: its arguments are the move format below.
- \`accept_draw\` — accept your opponent's pending draw offer.
- \`resign\` — resign.
- \`interview\` — answer the pre-game interview (\`text\`).
- \`postgame\` — after the game, your post-game interview answer (\`interview\`).
- \`status\` — the current position again.
Your scratch folder, for any notes you write: ${dir}`
    : `## CLI
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
EOF`
}

## Move format
{
  "move": "Nf3",
  "commentary": "Your thinking for this move.",
  "eval": "+0.4",
  "lines": [
    { "moves": "Nf3 Nc6 Bb5 a6 Ba4 Nf6", "note": "Main line: I keep pressure on e5." },
    { "moves": "Nf3 d6 d4 exd4 Nxd4", "note": "If he plays ...d6 I take the center." }
  ],${setup.view !== "text" ? `\n  "seen": "K7Q",` : ""}${setup.reread ? `\n  "position": { "white": ["Kg1", "Qd1", "Pe4", …], "black": ["Kg8", "Pe5", …] },` : ""}
  "offerDraw": false
}
- move: SAN (e.g. "Nf3", "exd5", "O-O", "e8=Q") or UCI ("g1f3").
- commentary (required, every move): shown live to the audience. Talk through what you see, what your opponent is threatening or planning, the candidate moves you considered and why you chose this one.
- eval (required): what the position is worth after your move, assuming best play from both sides, in pawns from WHITE's point of view (+ means White is better), e.g. "+0.8", "-1.5", "0.0", or "#3" / "-#3" for a forced mate. It is compared with the engine after the game.
  It is a prediction of the result, not a material count. Material is only one input: king safety, piece activity, threats, passed pawns and trapped pieces count just as much, and if your main line wins something by force, the eval already includes it. Scale: 0.0–0.3 equal · 0.3–0.7 slight edge · 0.7–1.5 clear advantage · 1.5–3 winning (a strong player converts it most of the time) · 3–6 decisive · above 6 completely won or lost.
  Don't soften the number when you're worse: saying a position is lost is fine, and you can still fight.
- lines (optional, but use them whenever you calculate): each line is a sequence of moves starting from the CURRENT position with your move first. The audience can click a line to watch it played out on the board, so include your main line, alternatives you rejected, and the replies you're worried about. Several lines are welcome.
- offerDraw (optional): offer a draw together with this move.${setup.view !== "text" ? `\n- seen (required): the check code at the top of this turn's board picture.` : ""}${setup.reread ? `\n- position (required): every piece on the board as you read it, before you chose your move (see "Write out the position").` : ""}

${
  tools
    ? `## The loop — keep going until a tool returns DONE
1. Call \`wait\` once, to start.
2. Find the status heading in each reply: PRE-GAME (answer with \`interview\`), YOUR MOVE (think, then \`move\`), GAME OVER (\`postgame\`), WAITING or POSITION STATUS (call \`wait\`), DONE (you are finished).
3. Act on it with one call; its reply includes the next status. Repeat.
Never end your task before a tool returns DONE — the game stalls if you stop. If a call fails, read the error and fix it. If a call says what you sent already went through, call \`wait\`; don't send it again.`
    : `## The loop — keep going until the CLI prints DONE
1. Run \`wait\` once, to start.
2. Find the status heading in each reply: PRE-GAME (answer with \`interview\`), YOUR MOVE (think, then \`move\`), GAME OVER (\`postgame\`), WAITING or POSITION STATUS (run \`wait\`), DONE (you are finished).
3. Act on it with one command; its reply includes the next status. Repeat.
Never end your task before the CLI prints DONE — the game stalls if you stop. If a command fails, read the error and fix it. If your shell times out while a command is waiting, what you sent already went through: run \`wait\`, don't send it again.`
}
If your moves keep getting rejected: you always have at least one legal move while the game is running (checkmate and stalemate end the game automatically). ${tools ? "Call" : "Run"} \`status\`, re-read ${setup.view === "image" ? "the board picture" : "the board and the piece list"} square by square, and consider every piece — pawns included — not just the one you were focused on. If the position is hopeless, you may resign; never just stop.

## Draws and resignation
You are trying to win. Resign only when the position is clearly lost with no practical chances. Offer or accept a draw when the position is dead equal with nothing left to play for, or when a draw is a good result for you.`;
}

/** The video director: a finished game's own task. It only plans the replay video. */
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

/** How long a launched director is left to finish before another run may launch one. */
const DIRECTOR_STALE_MS = 45 * 60_000;

/**
 * The director task for a finished game, or none (with why), handed to the run that asks: a second run
 * asking within the next 45 minutes gets none.
 */
export function directorLaunch(g: Game, effort?: string) {
  const none = (note: string) => ({ gameId: g.id, tasks: [], note });
  if (g.phase !== "finished") return none("The game isn't finished yet: its director comes after the game.");
  if (!needsDirection(g)) return none(g.video ? "The video plan is already made." : "There's nothing to plan: the players made fewer than three moves, or there's no engine review yet.");
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

/** Who directs a game's video: the default director, at the effort asked for. */
export function directorWho(_g: Game, effort?: string) {
  return { provider: DEFAULT_DIRECTOR.provider, model: DEFAULT_DIRECTOR.model, effort: effort ?? DEFAULT_DIRECTOR.effort };
}

const effortOption = (provider: string, effort: string) =>
  provider === "codex" ? { reasoningEffort: effort } : { effort };

/**
 * What an agent the server launched itself is told by `start`: its thread's title, then its task. The
 * director's seat does whichever job the game is at: the plan, or (once it's saved) new packaging.
 */
export function seatTask(g: Game, role: SeatRole, via: "cli" | "tools" = "cli"): { title: string; prompt: string } {
  if (role === "w" || role === "b") return { title: `♟ ${colorName(role)}: ${fullName(role === "w" ? g.white : g.black)} — ${g.id}`, prompt: playerPrompt(g, role, via) };
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
  // `launched`: seats an orchestrator already delegated — don't launch them again.
  return { gameId: g.id, launched: g.launched ?? {}, tasks };
}
