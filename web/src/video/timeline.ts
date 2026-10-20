import type { Classification, Color, Game, LineBeat, ThoughtMark } from "../../../shared/types";
import { VOICE_RATE, type VoiceManifest } from "../../../shared/voices";
import { markColors, pointsAt, quoteWords, sentenceEnd, spokenWord } from "../../../shared/thoughtMarks";
import { beatId, branchBeatId, interviewText, lineSig, lineVoice, videoLines } from "../../../shared/videoLines";
import { lineVerdicts, planBranch, planLine, shownLine, type LineKind } from "../../../shared/engineLine";

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
  /**
   * `verdicts`: each move's badge (see lineVerdicts). `beats`: the narrator's lines, each shown from `at` to
   * `end` (seconds into the scene; spoken as narration cues). `first`: an `instead` line played before its
   * move (the move isn't on the board yet, and comes after it).
   */
  | {
      kind: "line";
      i: number;
      line: LineKind;
      caption: string;
      sans: string[];
      moveAt: number[];
      captionAt: number;
      /** Word-cued engine entry; quick undo of the real move ends at `readyAt`. */
      enterAt: number;
      readyAt: number;
      /** Undo every variation move, then (for an after-the-move alternative) replay the real move. */
      back: [number, number];
      restoreEnd: number;
      verdicts: (Classification | undefined)[];
      /** `draws`: what each beat draws on its words, `at` seconds into the beat. */
      beats?: { at: number; end: number; text: string; draws?: { word: number; last?: number; at: number; from?: string; to?: string; ring?: string }[] }[];
      first?: boolean;
      punish?: LinePunishScene;
      /**
       * The line's branches (see LineBranch), by their index in the plan: each one's moves with their badges, and
       * when each of them first lands. With branches the board follows `steps` (see LineStep), and winds back
       * from `backFrom` (what's on it then) at the end.
       */
      branches?: ({ at: number; when: "before" | "after"; sans: string[]; verdicts: (Classification | undefined)[]; moveAt: number[] } | undefined)[];
      steps?: LineStep[];
      backFrom?: { seg: number; count: number };
    }
  /** After the cold open: "how did we get here?", winding back from move i to the start. */
  | { kind: "rewind"; i: number }
  /** A draw offer made with move i, and what the opponent did about it. */
  | { kind: "draw"; i: number; answer: "declined" | "accepted" | "open" }
  | { kind: "resign"; color: Color }
  | { kind: "result" }
  | { kind: "end" }
);

/**
 * A change to the board of a line with branches, in seconds into its scene: the kth move of a path lands
 * (sliding in from `at`; `k` counts the path's moves from the line's start; `hold`: nothing moves, the board just
 * switches to that path where it shares the moves on it), or a path winds back from `from`
 * of its moves to `to` over [at, end]. Path -1 is the line; path j is the line's first `branches[j].at` moves,
 * then branch j's.
 */
export type LineStep = { at: number; seg: number; k: number; hold?: true } | { at: number; end: number; seg: number; from: number; to: number };

export interface LinePunishScene {
  sans: string[];
  moveAt: number[];
  /** The badge on each of its moves (the move played first). */
  verdicts: (Classification | undefined)[];
  at: number;
  captionAt: number;
  caption: string;
  back: [number, number];
}

/** How long a line's move takes to slide in; the pause before its caption fades in. */
export const LINE_SLIDE = 0.3;
export const LINE_RESTORE = 0.22;
/** Keep a full rewind brisk, including long mating lines. */
export const lineRewindDuration = (moves: number) => Math.min(1.2, moves * 0.18);
/** How much longer a line holds on its hard move (great: the only move; brilliant: the sacrifice), badge and all. */
const LINE_STRONG_HOLD = 0.9;
/** How long a move holds before the engine line after it starts (the line's own lead-in comes on top). */
const LINE_AFTER_MOVE = 0.5;
/** How far apart the moves a narrator's cue brings on land, the last on its word. */
const LINE_BURST = 0.35;
/**
 * The least time between two moves of an engine line landing: the slide, the badge popping in (LINE_BADGE, as
 * the video draws it), and a moment to read it. A cue's run of moves and a forced reply never go quicker. The
 * line played again quickly after a branch (moves already seen) still uses LINE_BURST.
 */
const LINE_BADGE = 0.3;
export const LINE_MIN_STEP = LINE_SLIDE + LINE_BADGE + 0.25;
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
 * line from VOICE_AT in, and a breath after). `i`: the move it's quoted from, played at `start` (or, after a
 * rejected attempt, just after its line).
 */
export interface AsideCue {
  start: number;
  dur: number;
  i: number;
  text: string;
  voice?: { url: string; rate: number };
  /** The narrator over an engine line (shown as the line's comment, not in the move list). */
  narrator?: boolean;
}

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
  /** Whether the director picked the moments (otherwise a fallback rule did). */
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
    const voiceId = line && lineVoice(g, line);
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

  // Asides (all of them in the YouTube cut, the director's picks in the short, whose quiet moves fly by): each
  // is said as its move lands (never before: it's about that move's thinking), a little quicker than the other
  // lines, and the board plays on under it, since an aside is a line that holds for a stretch of moves.
  // Thinking, a moment, an engine line or the next aside waits for it to be said (the board holding on the
  // last quiet move), so where they come thick the voices set the pace.
  const asideOf = new Map(opts.thoughts !== false ? (plan?.asides ?? []).filter((a) => wide || a.short).map((a) => [a.ply, a] as const) : []);
  const asideRate = Math.min(ASIDE_RATE_MAX, rate * ASIDE_SPEED);
  const asides: AsideCue[] = [];
  let talkEnd = 0;
  const waitTalk = () => {
    if (talkEnd <= t) return;
    scenes[scenes.length - 1].dur += talkEnd - t;
    t = talkEnd;
  };
  // Says move i's aside from now; how long it lasts.
  const sayAside = (i: number) => {
    const a = asideOf.get(g.moves[i].ply)!;
    waitTalk();
    const v = voiced(`aside:${a.ply}`, 0.3 + read(a.quote), asideRate);
    asides.push({ start: t, dur: v.dur, i, text: a.quote, ...(v.voice && { voice: v.voice }) });
    talkEnd = t + v.dur;
    return v.dur;
  };

  // An engine line after (or, `first`, before) move i: what the move played allowed first, when the director
  // explains it, then the line itself, each move held a little longer when it's the hard one to find (great,
  // brilliant) and quicker when it's forced; the narrator's beats come as the board reaches them, and the
  // board waits for each.
  const lineScene = (i: number, ask: NonNullable<NonNullable<typeof plan>["moments"][number]["line"]>, first = false) => {
    const ln = planLine(g, i, ask);
    if (!ln) return;
    const per = (wide ? 0.8 : 0.65) / pace;
    const step = (v: Classification | undefined) => Math.max(LINE_MIN_STEP, v === "forced" ? per * 0.6 : per) + (v === "great" || v === "brilliant" ? LINE_STRONG_HOLD / pace : 0);
    const said: AsideCue[] = [];
    let at = 0;
    // What the move played allowed, when the director explains it: played out, a pause on the move its
    // caption is about, the rest, then the board winds back to before the move.
    let punish: LinePunishScene | undefined;
    if (ask.punish && ln.punish) {
      const verdicts = lineVerdicts(g, ln.punish.moves);
      const sans = ln.punish.moves.slice(1).map((mv) => mv.san);
      const k = ask.punish.at - 1;
      const moveAt: number[] = [];
      let captionAt = 0;
      at = 0.5 / pace;
      sans.forEach((_, j) => {
        moveAt.push(at);
        at += step(verdicts[j + 1]);
        if (j + 1 === k) {
          captionAt = moveAt[j] + LINE_SLIDE + LINE_SETTLE;
          at = captionAt + Math.max(1.8, 0.6 + read(ask.punish!.caption));
        }
      });
      if (k < sans.length) at += 0.6;
      const back: [number, number] = [at, at + lineRewindDuration(sans.length + 1)];
      punish = { sans, moveAt, verdicts, at: k, captionAt, caption: ask.punish.caption, back };
      at = back[1] + 0.25;
    } else at = 0.8 / pace;
    const verdicts = lineVerdicts(g, ln.moves);
    const beats = (ask.beats ?? []).map((b, n) => ({ ...b, n })).sort((a, b) => a.at - b.at || a.n - b.n);
    const shown: NonNullable<Extract<Scene, { kind: "line" }>["beats"]> = [];
    const ply = g.moves[i].ply;
    const n = ln.moves.length;
    const moveAt: number[] = [];
    let enterAt = 0;
    let readyAt = !punish && ln.kind === "instead" && !first ? LINE_RESTORE : 0;
    // The board as one track (see LineStep): what's on it (`onSeg`'s path, `onCount` of its moves) and each
    // change. Path -1 is the line; branch j's path is the line's first `at` moves, then the branch's.
    const brs = (ask.branches ?? []).flatMap((b, j) => {
      const br = planBranch(g, ln, b);
      return br ? [{ b, j, br }] : [];
    });
    const steps: LineStep[] = [];
    let onSeg = -1;
    let onCount = 0;
    type Track = { seg: number; base: number; n: number; verdicts: (Classification | undefined)[]; moveAt: number[] };
    const main: Track = { seg: -1, base: 0, n, verdicts, moveAt };
    const pushMove = (tr: Track, when: number) => {
      tr.moveAt.push(when);
      onSeg = tr.seg;
      onCount = tr.base + tr.moveAt.length;
      steps.push({ at: when, seg: tr.seg, k: onCount });
    };
    // A track's moves up to k, one after another at their pace, from now.
    const playTo = (tr: Track, k: number) => {
      while (tr.moveAt.length < Math.min(k, tr.n)) {
        pushMove(tr, at);
        at += step(tr.verdicts[tr.moveAt.length - 1]);
      }
      if (tr.moveAt.length) at = Math.max(at, tr.moveAt[tr.moveAt.length - 1] + LINE_SLIDE + LINE_SETTLE);
    };
    const sayBeat = (tr: Track, b: LineBeat & { n: number }, id: string) => {
      playTo(tr, b.at);
      const v = voiced(id, 0.3 + read(b.text));
      const from = at;
      // When word k of the beat is said: by the recording's word timings, else spread over it, else at reading speed.
      const clip = clipOf(id);
      const total = Math.max(1, spokenWord(b.text, Infinity));
      const wordAt = (k: number) => {
        if (!clip) return from + 0.3 + k / (WORDS_PER_SECOND * pace);
        const w = spokenWord(b.text, k);
        return from + VOICE_AT + (clip.words?.length ? clip.words[Math.min(w, clip.words.length - 1)] : (w / total) * clip.dur) / rate;
      };
      if (tr === main && b.enter !== undefined && b.n === 0 && b.at === 0 && !punish) {
        enterAt = wordAt(b.enter);
        readyAt = enterAt + (ln.kind === "instead" && !first ? LINE_RESTORE : 0);
      }
      // The board moves on the words: a cued move lands as its word is said, the ones before it just ahead, each
      // with time for its badge.
      for (const c of b.cues ?? []) {
        const k = Math.min(c.moves, tr.n);
        const count = k - tr.moveAt.length;
        if (count <= 0) continue;
        const gap = LINE_MIN_STEP;
        const land = wordAt(c.word) - LINE_SLIDE;
        const prev = tr.moveAt.length ? tr.moveAt[tr.moveAt.length - 1] + gap : Math.max(from, at, readyAt + LINE_SETTLE);
        const start = Math.max(prev, land - (count - 1) * gap);
        for (let j = 0; j < count; j++) pushMove(tr, start + j * gap);
      }
      const end = from + v.dur;
      said.push({ start: from, dur: v.dur, i, text: b.text, narrator: true, ...(v.voice && { voice: v.voice }) });
      shown.push({ at: from, end, text: b.text, draws: (b.draw ?? []).map((d) => ({ ...d, at: wordAt(d.word) - from })) });
      at = Math.max(end, readyAt + LINE_SETTLE, tr.moveAt.length ? tr.moveAt[tr.moveAt.length - 1] + LINE_SLIDE + LINE_SETTLE : end);
    };
    // The moves two paths share: a branch shares the line's first `at` moves (two branches, the fewer of theirs).
    // Paths go by the branch's index in the plan (a branch that can't be shown any more is skipped, not renumbered).
    const splitOf = (seg: number) => (seg < 0 ? Infinity : (ask.branches?.[seg]?.at ?? 0));
    const shared = (a: number, b: number) => Math.min(splitOf(a), splitOf(b));
    // Gets the board to `count` moves of path `seg`: winds back to where the paths part, then plays the rest quickly.
    const goTo = (seg: number, count: number) => {
      const keep = seg === onSeg ? Math.min(onCount, count) : Math.min(onCount, count, shared(seg, onSeg));
      if (onCount > keep) {
        const d = lineRewindDuration(onCount - keep);
        steps.push({ at, end: at + d, seg: onSeg, from: onCount, to: keep });
        at += d + 0.15;
      }
      // Onto the other path, at once, so what's up top (the callout, the variation) follows before its moves come.
      if (seg !== onSeg) steps.push({ at, seg, k: keep, hold: true });
      for (let k = keep + 1; k <= count; k++) {
        steps.push({ at, seg, k });
        at += LINE_BURST / pace;
      }
      if (count > keep) at += LINE_SLIDE + LINE_SETTLE;
      onSeg = seg;
      onCount = count;
    };
    const branchScenes: NonNullable<Extract<Scene, { kind: "line" }>["branches"]> = [];
    // A branch: the board to where it splits, a breath, its moves under its beats, and a moment to take it in.
    const runBranch = ({ b, j, br }: (typeof brs)[number]) => {
      goTo(j, b.at);
      at += 0.3 / pace;
      const tr: Track = { seg: j, base: b.at, n: br.moves.length, verdicts: lineVerdicts(g, br.moves), moveAt: [] };
      for (const x of (b.beats ?? []).map((x, n) => ({ ...x, n })).sort((p, q) => p.at - q.at || p.n - q.n)) sayBeat(tr, x, branchBeatId(ply, j, x.n));
      playTo(tr, tr.n);
      at += b.beats?.length ? 0.3 : 1.5;
      branchScenes[j] = { at: b.at, when: b.when, sans: br.moves.map((mv) => mv.san), verdicts: tr.verdicts, moveAt: tr.moveAt };
    };
    // "before" branches play as the line reaches their point (after the line's beats there), and the board winds
    // back to the line before it goes on; "after" ones once the line has played out.
    const before = brs.filter((x) => x.b.when === "before").sort((p, q) => p.b.at - q.b.at);
    const later = brs.filter((x) => x.b.when === "after");
    let nextBefore = 0;
    // A "before" branch plays just ahead of the first of the line's beats that moves the board on from its point
    // (one past it, or one there with a cue), so the line's own move lands on the words that answer it.
    const branchesBefore = (b: { at: number; cues?: { moves: number }[] } | null) => {
      const past = (k: number) => !b || b.at > k || (b.at === k && (b.cues ?? []).some((c) => c.moves > k));
      while (nextBefore < before.length && past(before[nextBefore].b.at)) {
        const x = before[nextBefore++];
        playTo(main, x.b.at);
        runBranch(x);
        goTo(-1, x.b.at);
      }
    };
    for (const b of beats) {
      branchesBefore(b);
      sayBeat(main, b, beatId(ply, b.n));
    }
    branchesBefore(null);
    playTo(main, n);
    if (onSeg !== -1 || onCount < n) goTo(-1, n);
    const settled = moveAt[moveAt.length - 1] + LINE_SLIDE + LINE_SETTLE;
    const captionAt = Math.max(settled, at);
    // With the narrator telling it, the line ends on the last thing said unless the director also wrote a caption.
    const caption = ask.caption ?? (beats.length ? "" : ln.caption);
    at = captionAt + (caption ? Math.max(2.6, 0.8 + read(caption)) : 0.2);
    for (const x of later) runBranch(x);
    if (later.length) at += 0.2;
    const backAt = at;
    const back: [number, number] = [backAt, backAt + lineRewindDuration(onCount)];
    const restoreEnd = back[1] + (ln.kind === "instead" && !first ? LINE_RESTORE : 0);
    const start = t;
    push({
      kind: "line",
      i,
      line: ln.kind,
      caption,
      sans: ln.moves.map((mv) => mv.san),
      moveAt,
      captionAt,
      enterAt,
      readyAt,
      back,
      restoreEnd,
      verdicts,
      ...(shown.length && { beats: shown }),
      ...(first && { first: true }),
      ...(punish && { punish }),
      ...(brs.length && { branches: branchScenes, steps: steps.sort((p, q) => p.at - q.at), backFrom: { seg: onSeg, count: onCount } }),
      dur: restoreEnd + 0.15,
    });
    for (const c of said) asides.push({ ...c, start: start + c.start });
  };

  // An `instead` line the director plays before its move rather than after.
  const playsFirst = (j: number) => {
    const a = g.moves[j] && moment(g.moves[j].ply)?.line;
    return !!a?.first && a.kind === "instead" && !a.punish;
  };
  g.moves.forEach((m, i) => {
    const last = i === g.moves.length - 1;
    const picked = moment(m.ply);
    const key = keys[i];
    const aside = !key && asideOf.has(m.ply);
    const ask = picked?.line;
    // An `instead` line the director plays first: the position they faced, what was there, and only then
    // their thinking and the move they really played.
    const lineFirst = playsFirst(i);
    if (ask && lineFirst) {
      waitTalk();
      lineScene(i, ask, true);
    }

    // In the order it happened: any illegal attempts, then (on key moments) the thinking that went with the
    // move that was finally played, which often owns up to the attempt, then the move. An aside on the move
    // is said over its first attempt, which stays on the board until it's said.
    m.illegalAttempts.forEach((attempt, n) => {
      waitTalk();
      const dur = aside && n === 0 ? Math.max(1.5, sayAside(i)) : 1.5;
      push({ kind: "illegal", i, n, attempt, dur });
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
    if (aside && !m.illegalAttempts.length) sayAside(i);
    const next = g.moves[i + 1];
    const clock = !!next && !keys[i + 1] && !next.illegalAttempts.length;
    // A move with an engine line to follow (its own, or the next move's played before it) only pauses long
    // enough for its badge to land: the line takes over from there (its own lead-in is the rest of the wait),
    // so it isn't held like a moment on its own.
    const lineNext = (!!ask && !lineFirst && !!planLine(g, i, ask)) || (!!next && playsFirst(i + 1) && !!planLine(g, i + 1, moment(next.ply)!.line!));
    push({ kind: "move", i, anim, key, dur: anim + (lineNext ? LINE_AFTER_MOVE : hold(i)) + (last ? 1 : 0), ...(carry && { carry }), ...(clock && { clock }) });

    // The engine line the director asked for: what didn't happen, played out, then why it's better (one
    // played before the move came first, above).
    if (ask && !lineFirst) lineScene(i, ask);

    // Draw offers get their own beat, with the answer: declined if the game went on.
    if (m.offeredDraw) {
      waitTalk();
      const answer = !last ? "declined" : g.termination === "draw agreed" ? "accepted" : "open";
      push({ kind: "draw", i, answer, dur: 3 });
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
      at(s.start + s.enterAt, "transition", 0.5);
      at(s.start + s.back[0], "transition", 0.3);
      if (s.restoreEnd > s.back[1]) at(s.start + s.restoreEnd, "move", 0.4);
      // The line's hard moves get their verdict's sting, as a game move would.
      const sting = (land: number, v: Classification | undefined) => {
        if (v === "great" || v === "brilliant") at(land + 0.1, STINGS[v]![0], STINGS[v]![1] * 0.8);
      };
      if (s.punish) {
        s.punish.sans.forEach((san, k) => {
          const land = s.start + s.punish!.moveAt[k] + LINE_SLIDE - 0.02;
          board(land, san, 0.5);
          sting(land, s.punish!.verdicts[k + 1]);
        });
        at(s.start + s.punish.back[0], "transition", 0.35);
      }
      if (s.steps) {
        // With branches, every move that lands on the board (a branch's, or the line's played again after one),
        // and a soft change each time the board winds back to where a branch splits.
        for (const st of s.steps) {
          if ("end" in st) {
            at(s.start + st.at, "transition", 0.25);
            continue;
          }
          if (st.hold) continue;
          const br = st.seg >= 0 ? s.branches?.[st.seg] : undefined;
          const own = br ? st.k - br.at - 1 : st.k - 1;
          const [san, v] = br && own >= 0 ? [br.sans[own], br.verdicts[own]] : [s.sans[st.k - 1], s.verdicts[st.k - 1]];
          if (!san) continue;
          const land = s.start + st.at + LINE_SLIDE - 0.02;
          board(land, san, 0.5);
          // Only a move's first landing stings (not the line played again quickly after a branch).
          if (br ? own >= 0 : s.moveAt[st.k - 1] === st.at) sting(land, v);
        }
      } else
        s.sans.forEach((san, k) => {
          const land = s.start + s.moveAt[k] + LINE_SLIDE - 0.02;
          board(land, san, 0.5);
          sting(land, s.verdicts[k]);
        });
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
