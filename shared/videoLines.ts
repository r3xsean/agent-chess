import type { Color, Game } from "./types";
import { VOICES, voiceFamily } from "./voices";
import { speakable } from "./speech";

/*
 * Every line a replay puts in a player's mouth, with a stable id per line. The server records them
 * from this list and the timeline plays them from the same list, so a scene always gets the
 * recording made for exactly its words, voice and delivery (or none).
 */

export interface VideoLine {
  /** "moment:<ply>", "hook" or "interview:<pre|post>:<w|b>". */
  id: string;
  color: Color;
  text: string;
  delivery?: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The opening sentences of a text, up to about max words (at least one sentence). */
export function excerpt(text: string, max = 40): string {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    if (out && words(out + s) > max) break;
    out += s;
  }
  return out.trim();
}

/**
 * The most an interview line the director didn't pick (one given after the plan) may cost to speak.
 * The plan's speech budget reserves this much for each interview still to come.
 */
export const LATE_INTERVIEW_CHARS = 360;

/** The line an interview is cut to: the director's pick, or else its opening sentences, never more than LATE_INTERVIEW_CHARS spoken. */
export function interviewText(g: Game, when: "pre" | "post", c: Color): string | undefined {
  const picked = g.video?.interviewLines[when][c];
  if (picked) return picked;
  const full = g.interviews[when][c]?.text;
  if (!full) return undefined;
  const line = excerpt(full);
  const fits = (s: string) => speakable(s).length <= LATE_INTERVIEW_CHARS;
  if (fits(line)) return line;
  // Even one long opening sentence is cut back to what the budget allows: a word at a time (any
  // whitespace), or a few characters at a time where there are no words to split (an unbroken run).
  let cut = line.trim();
  while (cut && !fits(`${cut}…`)) cut = /\s/.test(cut) ? cut.replace(/\s+\S+$/, "").trim() : cut.slice(0, -Math.max(1, Math.ceil(cut.length / 20)));
  return cut ? `${cut}…` : undefined;
}

/** The lines of a directed replay (an undirected one isn't voiced). */
export function videoLines(g: Game): VideoLine[] {
  const plan = g.video;
  if (!plan) return [];
  const colorOf = (ply: number) => g.moves.find((m) => m.ply === ply)?.color;
  const out: VideoLine[] = [];
  for (const m of plan.moments) {
    const c = colorOf(m.ply);
    if (c && m.thought) out.push({ id: `moment:${m.ply}`, color: c, text: m.thought, delivery: m.delivery });
  }
  if (plan.hook?.quote) {
    const c = colorOf(plan.hook.ply);
    if (c) out.push({ id: "hook", color: c, text: plan.hook.quote, delivery: plan.hook.delivery });
  }
  for (const when of ["pre", "post"] as const)
    for (const c of ["w", "b"] as Color[]) {
      const text = interviewText(g, when, c);
      if (text) out.push({ id: `interview:${when}:${c}`, color: c, text, delivery: plan.interviewDelivery?.[when][c] });
    }
  return out;
}

/** The voice a side speaks in, or null (a human, or a model without one). */
export function voiceOf(g: Game, c: Color): string | null {
  const ref = c === "w" ? g.white : g.black;
  if (ref.provider === "human") return null;
  const fam = voiceFamily(ref.model);
  return fam ? VOICES[fam].voiceId : null;
}

/**
 * What a recording was made from: voice, delivery and words. A clip is used only while this still
 * matches, so a re-planned line never plays an old recording.
 */
export const lineSig = (voiceId: string, l: VideoLine) => [voiceId, l.delivery ?? "", l.text.trim()].join("|");
