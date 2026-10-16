import type { Classification, Color, Game } from "../../../shared/types";
import { VOICE_RATE, type VoiceManifest } from "../../../shared/voices";
import { interviewText, lineSig, videoLines, voiceOf } from "../../../shared/videoLines";

export type Format = "landscape" | "portrait";
export const FRAME: Record<Format, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

/** `voice`: the recorded line spoken in this scene, starting VOICE_AT seconds in, played at `rate`. */
export type Scene = { start: number; dur: number; voice?: { url: string; rate: number } } & (
  | { kind: "versus" }
  | { kind: "interview"; when: "pre" | "post"; color: Color; text: string }
  /** `hook`: this is the cold open, with its on-screen caption. */
  | { kind: "think"; i: number; thought: string; hook?: string }
  /** Attempt n of move i, made before it. */
  | { kind: "illegal"; i: number; n: number; attempt: string }
  | { kind: "move"; i: number; anim: number; key: boolean; hook?: string }
  /** After the cold open: "how did we get here?", winding back from move i to the start. */
  | { kind: "rewind"; i: number }
  /** A pre-game line replayed right after move i, the one that proves it wrong (or right). */
  | { kind: "flashback"; i: number; color: Color; text: string }
  /** A draw offer made with move i, and what the opponent did about it. */
  | { kind: "draw"; i: number; answer: "declined" | "accepted" | "open" }
  | { kind: "resign"; color: Color }
  | { kind: "result" }
  | { kind: "end" }
);

export interface Timeline {
  format: Format;
  scenes: Scene[];
  duration: number;
  /** Whether the broadcaster picked the moments (otherwise a fallback rule did). */
  directed: boolean;
}

export interface TimelineOptions {
  /** Show the mover's thinking before key moments. */
  thoughts?: boolean;
  /** Reading speed multiplier: 1.2 = everything 20% quicker. */
  pace?: number;
  /** The recorded voice lines: a voiced scene lasts as long as its line. */
  voice?: VoiceManifest;
}

/** When a voiced line starts within its scene, and the breath left after it. */
export const VOICE_AT = 0.3;
const VOICE_TAIL = 0.5;

/** Fallback when there's no director's plan: what slows the video down. */
const NOTABLE: Classification[] = ["brilliant", "great", "mistake", "miss", "blunder"];
const PUNISHABLE: Classification[] = ["mistake", "miss", "blunder"];

/** About 270 words a minute: a little quicker than the average adult reads (~240). */
const WORDS_PER_SECOND = 4.5;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/*
 * The broadcaster isn't in the video: its lines are stamped with the move on the board when they
 * were said, which often trails the move they're about. The video tells the story with the players'
 * own words, the engine's verdicts and the eval instead. (The broadcaster still picks the moments.)
 */
export function buildTimeline(g: Game, format: Format, opts: TimelineOptions = {}): Timeline {
  const wide = format === "landscape";
  const pace = opts.pace ?? 1;
  const read = (s: string) => 0.3 + words(s) / (WORDS_PER_SECOND * pace);
  const scenes: Scene[] = [];
  let t = 0;
  const push = (s: Scene extends infer S ? (S extends unknown ? Omit<S, "start"> : never) : never) => {
    scenes.push({ ...s, start: t } as Scene);
    t += s.dur;
  };

  const plan = g.video;
  // A line with a recording made from exactly its words, voice and delivery lasts as long as the
  // recording (at this cut's speed, plus a breath); otherwise, as long as it takes to read.
  const lines = new Map(videoLines(g).map((l) => [l.id, l]));
  const rate = VOICE_RATE[format];
  const voiced = (id: string, dur: number) => {
    const line = lines.get(id);
    const clip = opts.voice?.clips[id];
    const voiceId = line && voiceOf(g, line.color);
    if (!line || !clip || !voiceId || clip.sig !== lineSig(voiceId, line)) return { dur };
    return { voice: { url: clip.url, rate }, dur: Math.max(dur, VOICE_AT + clip.dur / rate + VOICE_TAIL) };
  };
  const interview = (when: "pre" | "post", c: Color) => interviewText(g, when, c);

  // Cold open: the director's payoff moment first (the mover's line, the move, its verdict), then rewind.
  const hookAt = plan?.hook ? g.moves.findIndex((m) => m.ply === plan.hook!.ply) : -1;
  if (plan?.hook && hookAt >= 0) {
    const { quote, caption } = plan.hook;
    if (quote && opts.thoughts !== false) push({ kind: "think", i: hookAt, thought: quote, hook: caption, ...voiced("hook", Math.max(2, 0.6 + read(quote))) });
    const anim = wide ? 0.3 : 0.25;
    push({ kind: "move", i: hookAt, anim, key: true, hook: caption, dur: anim + Math.max(2.4, read(caption)) });
    push({ kind: "rewind", i: hookAt, dur: 1.6 });
  }

  // Intro: the matchup, then the pre-game interviews. After a cold open the short gets straight to the
  // game: its pre-game line, if any, comes back as a flashback when it pays off.
  push({ kind: "versus", dur: wide || hookAt < 0 ? 3 : 1.8 });
  if (wide || hookAt < 0)
    for (const c of ["w", "b"] as Color[]) {
      const text = interview("pre", c);
      if (text) push({ kind: "interview", when: "pre", color: c, text, ...voiced(`interview:pre:${c}`, Math.max(2.5, 0.4 + read(text))) });
    }

  // The game.
  const moment = (ply: number) => plan?.moments.find((x) => x.ply === ply && (wide || x.importance >= 2));
  const firstOutOfBook = g.moves.findIndex((m) => m.analysis?.classification !== "book");
  g.moves.forEach((m, i) => {
    const cls = m.analysis?.classification;
    const prevCls = g.moves[i - 1]?.analysis?.classification;
    const last = i === g.moves.length - 1;
    const picked = moment(m.ply);
    const key = plan
      ? !!picked || last
      : (cls !== undefined && NOTABLE.includes(cls)) ||
        m.illegalAttempts.length > 0 ||
        (i === firstOutOfBook && i > 0) ||
        (prevCls !== undefined && PUNISHABLE.includes(prevCls)) ||
        last;

    // In the order it happened: any illegal attempts, then (on key moments) the thinking that went with the
    // move that was finally played, which often owns up to the attempt, then the move.
    m.illegalAttempts.forEach((attempt, n) => push({ kind: "illegal", i, n, attempt, dur: 1.5 }));
    const thought = opts.thoughts === false ? undefined : plan ? picked?.thought : key ? m.commentary.trim() : undefined;
    if (thought) push({ kind: "think", i, thought, ...voiced(`moment:${m.ply}`, 0.3 + read(thought)) });

    const anim = wide ? 0.3 : 0.25;
    // Key moments hold long enough to take in the verdict, the arrow and the engine's line.
    const hold = key ? 2.5 : cls === "book" ? (wide ? 0.6 : 0.35) : wide ? 1.2 : 0.6;
    push({ kind: "move", i, anim, key, dur: anim + hold + (last ? 1 : 0) });

    // Draw offers get their own beat, with the answer: declined if the game went on.
    if (m.offeredDraw) {
      const answer = !last ? "declined" : g.termination === "draw agreed" ? "accepted" : "open";
      push({ kind: "draw", i, answer, dur: 3 });
    }

    // The flashback lands right after the move that settles it.
    const cb = plan?.callback;
    if (cb && cb.ply === m.ply && picked) push({ kind: "flashback", i, color: cb.color, text: cb.line, ...voiced("callback", Math.max(2.8, 0.8 + read(cb.line))) });
  });
  const resigned = /^(White|Black) resigned/.exec(g.termination ?? "");
  if (resigned) push({ kind: "resign", color: resigned[1] === "White" ? "w" : "b", dur: 2.8 });

  // Outro: the result, then both post-game interviews, winner first so the loser gets the last word.
  push({ kind: "result", dur: 5 });
  const order: Color[] = g.result === "0-1" ? ["b", "w"] : ["w", "b"];
  for (const c of order) {
    const text = interview("post", c);
    if (text) push({ kind: "interview", when: "post", color: c, text, ...voiced(`interview:post:${c}`, Math.max(2.5, 0.4 + read(text))) });
  }
  push({ kind: "end", dur: 2.5 });

  return { format, scenes, duration: t, directed: !!plan };
}

/** The scene playing at time t (clamped to the video). */
export function sceneAt(tl: Timeline, t: number): Scene {
  for (const s of tl.scenes) if (t < s.start + s.dur) return s;
  return tl.scenes[tl.scenes.length - 1];
}
