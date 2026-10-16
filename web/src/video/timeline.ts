import type { Classification, Color, Game } from "../../../shared/types";

export type Format = "landscape" | "portrait";
export const FRAME: Record<Format, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

export type Scene = { start: number; dur: number } & (
  | { kind: "versus" }
  | { kind: "interview"; when: "pre" | "post"; color: Color; text: string }
  | { kind: "think"; i: number; thought: string }
  | { kind: "illegal"; i: number; attempt: string }
  | { kind: "move"; i: number; anim: number; key: boolean }
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
}

/** Fallback when there's no director's plan: what slows the video down. */
const NOTABLE: Classification[] = ["brilliant", "great", "mistake", "miss", "blunder"];
const PUNISHABLE: Classification[] = ["mistake", "miss", "blunder"];

/** About 270 words a minute: a little quicker than the average adult reads (~240). */
const WORDS_PER_SECOND = 4.5;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The opening sentences of a text, up to about max words (at least one sentence). */
function excerpt(text: string, max = 40): string {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    if (out && words(out + s) > max) break;
    out += s;
  }
  return out.trim();
}

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
  // Interviews are cut to their best line: the director's pick, or else the opening sentences.
  const interview = (when: "pre" | "post", c: Color) => {
    const full = g.interviews[when][c]?.text;
    return plan?.interviewLines[when][c] || (full && excerpt(full));
  };

  // Intro: the matchup, then both pre-game interviews.
  push({ kind: "versus", dur: 3 });
  for (const c of ["w", "b"] as Color[]) {
    const text = interview("pre", c);
    if (text) push({ kind: "interview", when: "pre", color: c, text, dur: Math.max(2.5, 0.4 + read(text)) });
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

    // On key moments the mover explains themselves first, then tries any illegal moves, then plays.
    const thought = opts.thoughts === false ? undefined : plan ? picked?.thought : key ? m.commentary.trim() : undefined;
    if (thought) push({ kind: "think", i, thought, dur: 0.3 + read(thought) });
    for (const attempt of m.illegalAttempts) push({ kind: "illegal", i, attempt, dur: 1.5 });

    const anim = wide ? 0.3 : 0.25;
    // Key moments hold long enough to take in the verdict, the arrow and the engine's line.
    const hold = key ? 2.5 : cls === "book" ? (wide ? 0.6 : 0.35) : wide ? 1.2 : 0.6;
    push({ kind: "move", i, anim, key, dur: anim + hold + (last ? 1 : 0) });

    // Draw offers get their own beat, with the answer: declined if the game went on.
    if (m.offeredDraw) {
      const answer = !last ? "declined" : g.termination === "draw agreed" ? "accepted" : "open";
      push({ kind: "draw", i, answer, dur: 3 });
    }
  });
  const resigned = /^(White|Black) resigned/.exec(g.termination ?? "");
  if (resigned) push({ kind: "resign", color: resigned[1] === "White" ? "w" : "b", dur: 2.8 });

  // Outro: the result, then both post-game interviews, winner first so the loser gets the last word.
  push({ kind: "result", dur: 5 });
  const order: Color[] = g.result === "0-1" ? ["b", "w"] : ["w", "b"];
  for (const c of order) {
    const text = interview("post", c);
    if (text) push({ kind: "interview", when: "post", color: c, text, dur: Math.max(2.5, 0.4 + read(text)) });
  }
  push({ kind: "end", dur: 2.5 });

  return { format, scenes, duration: t, directed: !!plan };
}

/** The scene playing at time t (clamped to the video). */
export function sceneAt(tl: Timeline, t: number): Scene {
  for (const s of tl.scenes) if (t < s.start + s.dur) return s;
  return tl.scenes[tl.scenes.length - 1];
}
