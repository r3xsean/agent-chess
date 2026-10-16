import type { Classification, Color, Game, MoveRecord, VideoCallback, VideoHook, VideoMoment, VideoPackaging, VideoPlan } from "../shared/types";
import { humanSide, sideName } from "../shared/naming";
import { formatScore } from "../shared/evalmath";
import { beliefs } from "../shared/belief";
import { rivalry, seriesLine } from "./rivalry";
import { spokenText, VOICE_BUDGET } from "./voice";
import { LATE_INTERVIEW_CHARS, videoLines, voiceOf } from "../shared/videoLines";
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
/** Moves whose replies carry a punishment and a reaction worth showing. */
const SWING: Classification[] = ["mistake", "miss", "blunder"];

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
    "The players' own thinking is what makes these videos worth watching, so tell each turning point as a short story in their words, not as a single frame. Around a decisive blunder that usually takes three or four consecutive plies:",
    "1. The build-up: the blunderer's thinking on the move itself (and sometimes the move before), showing what they believed. Confidence, a plan, a trap they think they're setting, or a threat they're sure isn't real all work well.",
    "2. The punishment: the opponent's next move, with their thinking as they spot it (or as they miss it, which is a story too).",
    "3. The reaction: the blunderer's next move, with the first thing they say after being hit. Realization (\"I missed…\"), damage control, denial, or still not noticing. This is often the best quote in the game. Don't drop it.",
    "The same shape works for a brilliant move or a sacrifice: the idea before it, the opponent's response, and whether it landed. Moves rated 'best' or 'good' often carry the punishment and reaction quotes, so read the plies around every swing, not just the flagged move.",
    "",
    "Beyond those arcs, pick the other moments a viewer must not miss: traps, sacrifices, illegal-move attempts, big misjudgments (marked `misjudged` below) and the moment a player finally sees the truth (marked `realizes`), and the finish. The engine's labels are a guide, not the answer. A move rated 'good' can be the real story (say, the move that allowed the trick), and a technical inaccuracy can be dull. Skip routine theory.",
    "",
    "Also pick the single best line from each interview for the short cut: funny, bold, or what came true (or didn't).",
    "",
    `Matchup: White ${describePlayer(g, "w")} vs Black ${describePlayer(g, "b")}.`,
    ...(human ? [`${name(human)} is a human: their moves come without commentary, so moments on their moves have no quote (the board, the verdict and the agent's reaction tell those).`] : []),
    `Opening: ${g.opening?.name ?? "unknown"}. Result: ${g.result} (${g.termination}).`,
    ...historyLines(g),
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
  const belief = beliefs(g);
  g.moves.forEach((m, i) => {
    const a = m.analysis;
    const verdict = a ? `${a.classification}${a.bestSan && a.bestSan !== m.san ? `, engine preferred ${a.bestSan} (${pvSan(m.fenBefore, g.analysis[m.fenBefore]?.pv, 6, variantOf(g))})` : ""}` : "unrated";
    out.push(`ply ${m.ply} — ${moveNo(m.ply)} ${m.san} by ${name(m.color)}: ${verdict}; eval ${formatScore(a?.evalAfter)}; self-eval ${m.selfEvalRaw || "—"}`);
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
            quote: "…exact sentences from that move's commentary…",
            delivery: "calm, quietly pleased with itself",
            chapter: "The rook that couldn't escape",
          },
        ],
        interviewLines: { pre: { w: "…", b: "…" }, post: { w: "…", b: "…" } },
        interviewDelivery: { pre: { w: "cocky", b: "measured" }, post: { w: "rueful", b: "gracious" } },
        hook: { ply: 55, quote: "…exact sentences from ply 55's commentary…", delivery: "breezy, totally sure", caption: "Black thinks the rook is safe. It's already lost." },
        callback: { color: "b", line: "…exact sentences from Black's pre-game interview…", ply: 54 },
        packaging: {
          title: "GPT-6 Astra traps Sonnet's rook… and Sonnet doesn't notice for 10 moves",
          caption: "Sonnet was SO sure that rook was safe 💀 #chess #ai",
          thumbnail: { ply: 54, text: "TRAPPED?!" },
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
    "- chapter (importance 2–3 only, optional): a YouTube chapter title for this moment, at most 6 words, written like a story beat (\"The pawn fork nobody saw\"), not notation.",
    "- interviewLines: for each interview, quote one to three consecutive sentences exactly, at most 40 words.",
    "- hook (required): the cold open. Both videos start on this moment before rewinding to the start, so it's what decides whether a viewer keeps watching. Pick the most shocking payoff: usually the blunder with the mover's most confident line, or the reaction after it. `quote` comes from that move's commentary like any quote (at most 40 words; leave it out on a human's move). `caption` is on-screen text of at most 12 words that makes the viewer need to see how it happened, without notation: \"Sonnet thinks it's winning. It's getting mated in one.\"",
    "- callback (optional): a pre-game line that the game proves wrong (or spectacularly right), replayed as a flashback right after the move that settles it. `line` is quoted exactly from that player's pre-game interview (at most 30 words); `ply` is the move that pays it off and must be one of your importance 2–3 moments. Only use it when the irony is real.",
    "- packaging (required): `title` for YouTube (at most 80 characters, the story not the notation, names the models); `caption` for TikTok (at most 150 characters, may end with a few hashtags); `thumbnail`: the move whose position makes the thumbnail and at most 4 words of big text.",
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
    return { ply, why, importance: importance as 1 | 2 | 3, thought, delivery: delivery(x.delivery, `${where}.delivery`), chapter };
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
  const hook: VideoHook = {
    ply: hookMove.ply,
    quote: moveQuote(g, hookMove, h.quote, "hook", 50, 40, 340),
    delivery: delivery(h.delivery, "hook.delivery"),
    caption: text(h.caption, "hook.caption", 120, true)!,
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

/** A delivery direction for the voice: a few words, no brackets (the voice engine adds its own). */
function delivery(raw: unknown, where: string): string | undefined {
  const s = text(raw, where, 60);
  if (!s) return undefined;
  if (/[[\]<>]/.test(s)) throw new ActionError(`${where}: just the words, no brackets.`);
  if (words(s) > 8) throw new ActionError(`${where} is ${words(s)} words; keep it to at most 6.`);
  return s;
}
