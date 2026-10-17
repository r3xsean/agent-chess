import type { Classification, Color, Game, ThoughtMark } from "../../../shared/types";
import { VOICE_RATE, type VoiceManifest } from "../../../shared/voices";
import { markColors, pointsAt, quoteWords, sentenceEnd, spokenWord } from "../../../shared/thoughtMarks";
import { interviewText, lineSig, videoLines, voiceOf } from "../../../shared/videoLines";
import { shownLine, type LineKind } from "../../../shared/engineLine";

export type Format = "landscape" | "portrait";
export const FRAME: Record<Format, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

/** `voice`: the recorded line spoken in this scene, starting VOICE_AT seconds in, played at `rate`. */
export type Scene = { start: number; dur: number; voice?: { url: string; rate: number } } & (
  | { kind: "versus" }
  | { kind: "interview"; when: "pre" | "post"; color: Color; text: string }
  /** `hook`: this is the cold open, with its on-screen caption. `marks`: what the thought names, drawn as it's said. */
  | { kind: "think"; i: number; thought: string; hook?: string; marks?: SceneMark[] }
  /** Attempt n of move i, made before it. */
  | { kind: "illegal"; i: number; n: number; attempt: string }
  /**
   * `carry`: the thought's last mark, ending on this very move, fading as the piece goes. `clock`: the next
   * move follows straight on, so the hold is its player thinking: their clock runs through it.
   */
  | { kind: "move"; i: number; anim: number; key: boolean; hook?: string; carry?: SceneMark; clock?: boolean }
  /**
   * An engine line played out after move i (see shared/engineLine.ts): each of its moves (`sans`) starts
   * sliding in at `moveAt`, and its caption fades in at `captionAt`, held to the end. `punish` comes first:
   * what the move played allowed, its moves after the one played (`sans`) each at `moveAt`, a pause on its
   * caption at `captionAt` once `at` of them are on the board, then the board winds back over `back`.
   */
  | { kind: "line"; i: number; line: LineKind; caption: string; sans: string[]; moveAt: number[]; captionAt: number; punish?: LinePunishScene }
  /** After the cold open: "how did we get here?", winding back from move i to the start. */
  | { kind: "rewind"; i: number }
  /** A draw offer made with move i, and what the opponent did about it. */
  | { kind: "draw"; i: number; answer: "declined" | "accepted" | "open" }
  | { kind: "resign"; color: Color }
  | { kind: "result" }
  | { kind: "end" }
);

export interface LinePunishScene {
  sans: string[];
  moveAt: number[];
  at: number;
  captionAt: number;
  caption: string;
  back: [number, number];
}

/** How long a line's move takes to slide in; the pause before its caption fades in. */
export const LINE_SLIDE = 0.3;
const LINE_SETTLE = 0.15;

/**
 * One of the director's marks during a thought (see ThoughtMark), in seconds into the scene: it builds up
 * from `start` (its first arrow or ring), each arrow and ring from just before its words are said, and
 * comes off at `end` (the end of its sentence, or `until`, or the next mark starting), fading over
 * MARK_FADE. `keep`: it ends on the move about to be played, so it stays up into the move. `lit`: the
 * words of the quote each item lights up in the bubble while it's drawn (see markLights), each once it's said.
 */
export interface SceneMark {
  start: number;
  end: number;
  keep?: boolean;
  /** `hold`: the next mark draws it again, so it stays up through the wipe until that copy has settled in. */
  arrows: { from: string; to: string; color: Color; at: number; hit?: boolean; lit: SceneLit[]; hold?: number }[];
  /** `side`: whose piece is in the circle (none: an empty square), which sets its colour. */
  rings: { sq: string; at: number; side?: Color; lit: SceneLit[]; hold?: number }[];
  /** The words of the director's refs (see ThoughtRef), lit as they're said, once what they point at is drawn. */
  lit?: SceneLit[];
}

/**
 * A word an item lights up, from `at`: once the item is drawn and the word has been said. `color`: the side
 * whose piece (or move) it names, which it's lit in; none for an empty square, lit in the item's colour.
 */
export interface SceneLit {
  word: number;
  at: number;
  color?: Color;
}

/** How far back a mark's board may be, for moves looked back on (as the director allows). */
const MARK_LOOKBACK = 10;

/** How long a mark takes to come off; how early each item is drawn before its word; how long a mark stays after its sentence. */
export const MARK_FADE = 0.2;
const MARK_LEAD = 0.1;
const MARK_HOLD = 0.5;
/** How soon into the next mark a drawing it repeats must come for the last one's copy to stay up until it does. */
const MARK_BRIDGE = 2;
/** How long a drawing takes to snap in and settle: a held copy stays that long past the new one appearing. */
const MARK_SETTLE = 0.25;

/**
 * An aside (see VideoAside): a line said while the game plays on, over the scenes from `start` for `dur` (its
 * line from VOICE_AT in, and a breath after). `i`: the move it's quoted from, played at or after `start`.
 */
export interface AsideCue {
  start: number;
  dur: number;
  i: number;
  text: string;
  voice?: { url: string; rate: number };
}

/** How many plies before its own move an aside may start, to be said before the next moment comes. */
const ASIDE_LEAD = 4;
/**
 * Asides play this much quicker than the cut's other lines, time-stretched with the pitch kept (the render
 * uses rubberband, the preview the browser's own), and never past ASIDE_RATE_MAX, where speech starts to smear.
 */
const ASIDE_SPEED = 1.15;
const ASIDE_RATE_MAX = 1.3;

/**
 * A quiet move holds for as long as its reply took to think of, against the game's other quiet moves: from
 * HOLD_MIN to HOLD_MAX times the usual hold, by the log of the thinking time.
 */
const HOLD_MIN = 0.5;
const HOLD_MAX = 2.2;
const thinkWeight = (ms: number) => Math.log2(1 + ms / 5000);

export interface Timeline {
  format: Format;
  scenes: Scene[];
  /** Lines said in passing, over the scenes (the YouTube cut of a directed game only). */
  asides: AsideCue[];
  duration: number;
  /** Whether the broadcaster picked the moments (otherwise a fallback rule did). */
  directed: boolean;
}

export interface TimelineOptions {
  /** Show the mover's thinking: before key moments, and in asides. */
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
  const clipOf = (id: string) => {
    const line = lines.get(id);
    const clip = opts.voice?.clips[id];
    const voiceId = line && voiceOf(g, line.color);
    return line && clip && voiceId && clip.sig === lineSig(voiceId, line) ? clip : undefined;
  };
  const voiced = (id: string, dur: number, r = rate) => {
    const clip = clipOf(id);
    if (!clip) return { dur };
    return { voice: { url: clip.url, rate: r }, dur: Math.max(dur, VOICE_AT + clip.dur / r + VOICE_TAIL) };
  };
  // A thought's marks, timed to the voice: to the word where the clip has word timings, else spread over
  // the clip by word, else (no voice) at reading speed.
  // A mark that ends on the move about to be played (move i) is kept up into it.
  const timedMarks = (id: string, quote: string, marks: ThoughtMark[] | undefined, dur: number, i: number): { marks?: SceneMark[] } => {
    if (!marks?.length) return {};
    const m = g.moves[i];
    const fens = [m.fenBefore, m.fenAfter, ...g.moves.slice(Math.max(0, i - MARK_LOOKBACK), i).reverse().map((mv) => mv.fenBefore)];
    const colors = markColors(quote, marks, fens, m.color);
    const clip = clipOf(id);
    const total = Math.max(1, spokenWord(quote, Infinity));
    const qw = quoteWords(quote);
    const at = (k: number) => {
      if (!clip) return 0.3 + k / (WORDS_PER_SECOND * pace);
      const w = spokenWord(quote, k);
      const t = clip.words?.length ? clip.words[Math.min(w, clip.words.length - 1)] : (w / total) * clip.dur;
      return VOICE_AT + t / rate;
    };
    // When word k has been said: the next word starts, or the line ends.
    const after = (k: number) => (k + 1 < qw.length ? at(k + 1) : clip ? VOICE_AT + clip.dur / rate : at(qw.length));
    const drawAt = (k: number) => Math.min(Math.max(0, at(k) - MARK_LEAD), dur);
    const timed = marks.map((mk, n) => {
      const arrows = mk.arrows.map((a, j) => ({
        from: a.from,
        to: a.to,
        color: colors[n].arrows[j].side ?? a.color,
        at: drawAt(a.word),
        ...(a.hit && { hit: true }),
        lit: colors[n].arrows[j].lit.map((w) => ({ ...w, at: Math.max(drawAt(a.word), drawAt(w.word)) })),
      }));
      const rings = mk.rings.map((r, j) => {
        const c = colors[n].rings[j];
        return { sq: r.sq, at: drawAt(r.word), ...(c.side && { side: c.side }), lit: c.lit.map((w) => ({ ...w, at: Math.max(drawAt(r.word), drawAt(w.word)) })) };
      });
      // A ref's words light up as each is said, but never before what it points at is drawn.
      const drawnAt = (r: (typeof colors)[number]["refs"][number]) => {
        if (r.move !== undefined) return arrows[r.move]?.at ?? 0;
        const times = (r.sqs ?? []).map((sq) => Math.min(...arrows.filter((a) => a.from === sq || a.to === sq).map((a) => a.at), ...rings.filter((x) => x.sq === sq).map((x) => x.at)));
        return Math.max(0, ...times.filter(Number.isFinite));
      };
      // Of a ref's words, the ones naming the board light up ("the rook behind": "rook"); all of them if
      // none do ("it", "both pieces").
      const lit = colors[n].refs.flatMap((r) => {
        const from = drawnAt(r);
        const span = Array.from({ length: r.words[1] - r.words[0] + 1 }, (_, j) => r.words[0] + j);
        const naming = span.filter((k) => pointsAt(qw[k]).length);
        return (naming.length ? naming : span).map((k) => ({ word: k, at: Math.max(from, drawAt(k)), ...(r.color && { color: r.color }) }));
      });
      const start = Math.min(...arrows.map((a) => a.at), ...rings.map((r) => r.at));
      const last = Math.max(mk.word, ...mk.arrows.map((a) => a.word), ...mk.rings.map((r) => r.word), ...(mk.refs ?? []).map((r) => r.words[1]));
      return { start, natural: after(mk.until ?? sentenceEnd(quote, last)) + MARK_HOLD, arrows, rings, lit };
    });
    // An arrow or circle the next mark draws again soon after it starts stays up through the wipe until
    // it's drawn again, rather than coming off and straight back (the knight circled in idea after idea).
    const arrowKey = (a: { from: string; to: string; hit?: boolean; color: Color }) => `${a.from}${a.to}${a.hit ? "~" : ""}${a.color}`;
    const ringKey = (r: { sq: string; side?: Color }) => `${r.sq}${r.side ?? ""}`;
    timed.forEach((mk, n) => {
      const next = timed[n + 1];
      if (!next) return;
      for (const a of mk.arrows) {
        const again = next.arrows.find((b) => arrowKey(b) === arrowKey(a));
        if (again && again.at - next.start <= MARK_BRIDGE) Object.assign(a, { hold: again.at + MARK_SETTLE });
      }
      for (const r of mk.rings) {
        const again = next.rings.find((b) => ringKey(b) === ringKey(r));
        if (again && again.at - next.start <= MARK_BRIDGE) Object.assign(r, { hold: again.at + MARK_SETTLE });
      }
    });
    return {
      marks: timed.map(({ start, natural, arrows, rings, lit }, n) => {
        const keep = n === timed.length - 1 && arrows.some((a) => !a.hit && a.from === m.from && a.to === m.to);
        return { start, end: keep ? dur : Math.min(natural, timed[n + 1]?.start ?? dur, dur), ...(keep && { keep }), arrows, rings, ...(lit.length && { lit }) };
      }),
    };
  };
  const kept = (marks: SceneMark[] | undefined) => marks?.find((mk) => mk.keep);
  const interview = (when: "pre" | "post", c: Color) => interviewText(g, when, c);

  // Cold open: the director's payoff moment first (the mover's line, the move, its verdict), then rewind.
  const hookAt = plan?.hook ? g.moves.findIndex((m) => m.ply === plan.hook!.ply) : -1;
  if (plan?.hook && hookAt >= 0) {
    const { quote, caption } = plan.hook;
    let carry: SceneMark | undefined;
    if (quote && opts.thoughts !== false) {
      const v = voiced("hook", Math.max(2, 0.6 + read(quote)));
      const tm = timedMarks("hook", quote, plan.hook.marks, v.dur, hookAt);
      carry = kept(tm.marks);
      push({ kind: "think", i: hookAt, thought: quote, hook: caption, ...v, ...tm });
    }
    const anim = wide ? 0.3 : 0.25;
    push({ kind: "move", i: hookAt, anim, key: true, hook: caption, dur: anim + Math.max(2.4, read(caption)), ...(carry && { carry }) });
    push({ kind: "rewind", i: hookAt, dur: 1.6 });
  }

  // Intro: the matchup, then the pre-game interviews. After a cold open the short gets straight to the game.
  push({ kind: "versus", dur: wide || hookAt < 0 ? 3 : 1.8 });
  if (wide || hookAt < 0)
    for (const c of ["w", "b"] as Color[]) {
      const text = interview("pre", c);
      if (text) push({ kind: "interview", when: "pre", color: c, text, ...voiced(`interview:pre:${c}`, Math.max(2.5, 0.4 + read(text))) });
    }

  // The game.
  const moment = (ply: number) => plan?.moments.find((x) => x.ply === ply && (wide || x.importance >= 2));
  const firstOutOfBook = g.moves.findIndex((m) => m.analysis?.classification !== "book");
  const keys = g.moves.map((m, i) => {
    const cls = m.analysis?.classification;
    const prevCls = g.moves[i - 1]?.analysis?.classification;
    const last = i === g.moves.length - 1;
    return plan
      ? !!moment(m.ply) || last
      : (cls !== undefined && NOTABLE.includes(cls)) ||
          m.illegalAttempts.length > 0 ||
          (i === firstOutOfBook && i > 0) ||
          (prevCls !== undefined && PUNISHABLE.includes(prevCls)) ||
          last;
  });
  const anim = wide ? 0.3 : 0.25;
  // Key moments hold long enough to take in the verdict, the arrow and the engine's line. A quiet move holds
  // as long as the reply after it took to think of, against the game's other quiet moves (so the video is no
  // longer for it): a long think lingers, a quick one flies by. Book moves are theory, and all go quickly.
  const book = (i: number) => g.moves[i].analysis?.classification === "book";
  const paced = (i: number) => !keys[i] && !book(i) && !!g.moves[i + 1] && !keys[i + 1];
  const weight = (i: number) => thinkWeight(g.moves[i + 1].thinkMs);
  const pacedMoves = g.moves.map((_, i) => i).filter(paced);
  const meanWeight = pacedMoves.reduce((n, i) => n + weight(i), 0) / (pacedMoves.length || 1);
  const hold = (i: number) => {
    if (keys[i]) return 2.5;
    const usual = book(i) ? (wide ? 0.6 : 0.35) : wide ? 1.2 : 0.6;
    return paced(i) && meanWeight > 0 ? usual * Math.min(HOLD_MAX, Math.max(HOLD_MIN, weight(i) / meanWeight)) : usual;
  };

  // Asides (all of them in the YouTube cut, the director's few picks in the short, whose quiet moves fly by):
  // each is said over its move, a little quicker than the other lines, and the board plays on under it.
  // Thinking, a moment, an engine line or the next aside waits for it to be said (the board holding on the
  // last quiet move), so where they come thick the voices set the pace. One that wouldn't be over before the
  // next of those starts up to ASIDE_LEAD plies early, over quiet moves only.
  const asideOf = new Map(opts.thoughts !== false ? (plan?.asides ?? []).filter((a) => wide || a.short).map((a) => [a.ply, a] as const) : []);
  const asideRate = Math.min(ASIDE_RATE_MAX, rate * ASIDE_SPEED);
  const asides: AsideCue[] = [];
  let talkEnd = 0;
  let quietFrom = t;
  const moveStart: number[] = [];
  const waitTalk = () => {
    if (talkEnd <= t) return;
    scenes[scenes.length - 1].dur += talkEnd - t;
    t = talkEnd;
  };
  // The quiet moves from move i up to the next thing an aside can't run under.
  const room = (i: number) => {
    let n = 0;
    for (let j = i; j < g.moves.length; j++) {
      const mv = g.moves[j];
      if (j > i && (keys[j] || asideOf.has(mv.ply) || mv.illegalAttempts.length)) break;
      n += anim + hold(j);
      if (mv.offeredDraw) break;
    }
    return n;
  };
  // Says move i's aside from now (or, `early`, from as early as it needs and may); how long it lasts.
  const sayAside = (i: number, early: boolean) => {
    const a = asideOf.get(g.moves[i].ply)!;
    waitTalk();
    const v = voiced(`aside:${a.ply}`, 0.3 + read(a.quote), asideRate);
    const short = v.dur - room(i);
    const start = early && short > 0 ? Math.max(talkEnd, quietFrom, moveStart[i - ASIDE_LEAD] ?? quietFrom, t - short) : t;
    asides.push({ start, dur: v.dur, i, text: a.quote, ...(v.voice && { voice: v.voice }) });
    talkEnd = start + v.dur;
    return v.dur;
  };

  g.moves.forEach((m, i) => {
    const last = i === g.moves.length - 1;
    const picked = moment(m.ply);
    const key = keys[i];
    const aside = !key && asideOf.has(m.ply);

    // In the order it happened: any illegal attempts, then (on key moments) the thinking that went with the
    // move that was finally played, which often owns up to the attempt, then the move. An aside on the move
    // is said over its first attempt, which stays on the board until it's said.
    m.illegalAttempts.forEach((attempt, n) => {
      waitTalk();
      const dur = aside && n === 0 ? Math.max(1.5, sayAside(i, false)) : 1.5;
      push({ kind: "illegal", i, n, attempt, dur });
      quietFrom = t;
    });
    const thought = opts.thoughts === false ? undefined : plan ? picked?.thought : key ? m.commentary.trim() : undefined;
    let carry: SceneMark | undefined;
    if (thought) {
      waitTalk();
      const v = voiced(`moment:${m.ply}`, 0.3 + read(thought));
      // The marks go with the director's quote (the fallback's thinking has none).
      const tm = picked ? timedMarks(`moment:${m.ply}`, thought, picked.marks, v.dur, i) : {};
      carry = kept(tm.marks);
      push({ kind: "think", i, thought, ...v, ...tm });
    }

    if (key) waitTalk();
    if (aside && !m.illegalAttempts.length) sayAside(i, true);
    moveStart[i] = t;
    const next = g.moves[i + 1];
    const clock = !!next && !keys[i + 1] && !next.illegalAttempts.length;
    push({ kind: "move", i, anim, key, dur: anim + hold(i) + (last ? 1 : 0), ...(carry && { carry }), ...(clock && { clock }) });
    if (key) quietFrom = t;

    // The engine line the director asked for: what didn't happen, played out, then why it's better.
    const ask = picked?.line;
    const ln = ask && shownLine(g, i, ask.kind);
    if (ask && ln) {
      const caption = ask.caption ?? ln.caption;
      const per = (wide ? 0.8 : 0.65) / pace;
      let at = 0;
      // What the move played allowed, when the director explains it: played out, a pause on the move its
      // caption is about, the rest, then the board winds back to before the move.
      let punish: LinePunishScene | undefined;
      if (ask.punish && ln.punish) {
        const sans = ln.punish.moves.slice(1).map((mv) => mv.san);
        const k = ask.punish.at - 1;
        const moveAt: number[] = [];
        let captionAt = 0;
        at = 0.5 / pace;
        sans.forEach((_, j) => {
          moveAt.push(at);
          at += per;
          if (j + 1 === k) {
            captionAt = moveAt[j] + LINE_SLIDE + LINE_SETTLE;
            at = captionAt + Math.max(1.8, 0.6 + read(ask.punish!.caption));
          }
        });
        if (k < sans.length) at += 0.6;
        const back: [number, number] = [at, at + 0.18 * (sans.length + 1) + 0.15];
        punish = { sans, moveAt, at: k, captionAt, caption: ask.punish.caption, back };
        at = back[1] + 0.25;
      } else at = 0.8 / pace;
      const moveAt = ln.moves.map((_, j) => at + j * per);
      const captionAt = moveAt[moveAt.length - 1] + LINE_SLIDE + LINE_SETTLE;
      push({ kind: "line", i, line: ln.kind, caption, sans: ln.moves.map((mv) => mv.san), moveAt, captionAt, ...(punish && { punish }), dur: captionAt + Math.max(2.6, 0.8 + read(caption)) });
      quietFrom = t;
    }

    // Draw offers get their own beat, with the answer: declined if the game went on.
    if (m.offeredDraw) {
      waitTalk();
      const answer = !last ? "declined" : g.termination === "draw agreed" ? "accepted" : "open";
      push({ kind: "draw", i, answer, dur: 3 });
      quietFrom = t;
    }
  });
  waitTalk();
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

  return { format, scenes, asides, duration: t, directed: !!plan };
}

/**
 * The stretches of the game, from the end of the pre-game interviews to the result, where nothing is said
 * for longer than `max` seconds: no thought, aside or engine line on screen.
 */
export function silences(tl: Timeline, max: number): { from: number; to: number }[] {
  let intro = -1;
  tl.scenes.forEach((s, k) => {
    if (s.kind === "versus" || (s.kind === "interview" && s.when === "pre")) intro = k;
  });
  const begin = intro >= 0 ? tl.scenes[intro].start + tl.scenes[intro].dur : 0;
  const end = tl.scenes.find((s) => s.kind === "resign" || s.kind === "result")?.start ?? tl.duration;
  const spans = [
    ...tl.scenes.filter((s) => s.start >= begin && (s.kind === "think" || s.kind === "line")).map((s) => [s.start, s.start + s.dur]),
    ...tl.asides.map((a) => [a.start, a.start + a.dur]),
  ].sort((a, b) => a[0] - b[0]);
  const out: { from: number; to: number }[] = [];
  let from = begin;
  for (const [a, b] of spans) {
    if (a - from > max) out.push({ from, to: a });
    from = Math.max(from, b);
  }
  if (end - from > max) out.push({ from, to: end });
  return out;
}

/** A sound effect at a moment of the video: one of vendor/sfx's events (`<ev>_<n>.ogg`, variants rotating), at a gain. */
export interface SfxCue {
  t: number;
  ev: string;
  gain: number;
}

const STINGS: Partial<Record<Classification, [string, number]>> = {
  brilliant: ["brilliant", 1],
  great: ["great", 0.9],
  blunder: ["blunder", 1],
  mistake: ["mistake", 0.9],
  miss: ["mistake", 0.9],
  inaccuracy: ["inaccuracy", 0.7],
};

/**
 * When each sound effect plays, for the render's soundtrack and the preview alike. Every move gets a
 * quiet board sound; only the key moments get the loud ones (verdict stings), plus the thinking pop,
 * illegal attempts and the scene changes. (The voices are cued from the scenes themselves.)
 */
export function sfxCues(tl: Timeline, g: Game): SfxCue[] {
  const cues: SfxCue[] = [];
  const at = (t: number, ev: string, gain: number) => cues.push({ t, ev, gain });
  const board = (land: number, san: string, gain: number) => {
    at(land, san.includes("x") ? "capture" : "move", gain);
    if (san.startsWith("O-O")) at(land + 0.1, "move", gain * 0.8);
    if (san.includes("=")) at(land + 0.05, "promotion", gain);
    if (san.includes("#")) at(land + 0.05, "checkmate", 1);
    else if (san.includes("+")) at(land, "check", gain * 0.8);
  };
  for (const s of tl.scenes) {
    if (s.kind === "versus") at(s.start + 0.25, "versus", 0.8);
    else if (s.kind === "interview" || s.kind === "end") at(s.start, "transition", 0.35);
    else if (s.kind === "rewind") at(s.start, "transition", 0.6);
    else if (s.kind === "line") {
      // An engine line: a scene change, then quieter board sounds for its moves (each as it lands), with
      // the punishment first and a softer change as the board winds back from it.
      at(s.start, "transition", 0.5);
      if (s.punish) {
        s.punish.sans.forEach((san, k) => board(s.start + s.punish!.moveAt[k] + LINE_SLIDE - 0.02, san, 0.5));
        at(s.start + s.punish.back[0], "transition", 0.35);
      }
      s.sans.forEach((san, k) => board(s.start + s.moveAt[k] + LINE_SLIDE - 0.02, san, 0.5));
    } else if (s.kind === "think") at(s.start + 0.05, "think", 0.7);
    else if (s.kind === "illegal") at(s.start + 0.05, "illegal", 0.8);
    else if (s.kind === "draw") at(s.start + 0.05, "draw", 0.8);
    else if (s.kind === "resign") at(s.start + 0.1, "resign", 0.9);
    else if (s.kind === "result") {
      at(s.start, "transition", 0.35);
      if (g.result !== "1/2-1/2") at(s.start + 0.3, "victory", 0.8);
    } else if (s.kind === "move") {
      const m = g.moves[s.i];
      const land = s.start + s.anim - 0.02;
      board(land, m.san, s.key ? 0.9 : 0.55);
      const cls = m.analysis?.classification;
      const sting = s.key && cls ? STINGS[cls] : undefined;
      if (sting) at(land + 0.1, sting[0], sting[1]);
    }
  }
  return cues;
}

/** The scene playing at time t (clamped to the video). */
export function sceneAt(tl: Timeline, t: number): Scene {
  for (const s of tl.scenes) if (t < s.start + s.dur) return s;
  return tl.scenes[tl.scenes.length - 1];
}
