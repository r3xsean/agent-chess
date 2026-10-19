/*
 * Each model speaks in its own ElevenLabs voice in the replay videos: the quotes from its thinking,
 * and its interview lines. Voices go by model family, so a newer Opus keeps Opus's voice.
 * Models outside these families (and humans) stay silent.
 */

export type VoiceFamily = "opus" | "fable" | "sonnet" | "haiku" | "sol" | "astra" | "luna";

/** The ElevenLabs model: v4 performs the delivery tags ("[smug]", "[stunned]") the director writes. */
export const TTS_MODEL = "eleven_v4";

export const VOICES: Record<VoiceFamily, { voiceId: string; name: string }> = {
  opus: { voiceId: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  fable: { voiceId: "pFZP5JQG7iQjIQuC4Bku", name: "Lily" },
  sonnet: { voiceId: "cjVigY5qzO86Huf0OWal", name: "Eric" },
  haiku: { voiceId: "FGY2WhTYpPnrIDTdsKH5", name: "Laura" },
  sol: { voiceId: "SOYHLrjzK2X1ezoPC6cr", name: "Harry" },
  astra: { voiceId: "N2lVS1w4EtoT3dr4eOWO", name: "Callum" },
  luna: { voiceId: "IKne3meq5aSn9XLyUdCD", name: "Charlie" },
};

/**
 * The narrator: the director's own voice, heard only over the engine lines ("what if…"), never one of the
 * players' voices.
 */
export const NARRATOR = { voiceId: "pqHfZKP75CvOlQylNhV4", name: "Bill" };

/**
 * How fast the recordings play in each cut. The short is a touch quicker: the same clips are
 * time-stretched (pitch kept) rather than recorded twice.
 */
export const VOICE_RATE: Record<"landscape" | "portrait", number> = { landscape: 1, portrait: 1.12 };

/** claude-opus-5-5 → "opus", gpt-6.1-sol → "sol"; null for anything else. */
export function voiceFamily(model: string): VoiceFamily | null {
  const claude = /^claude-(opus|fable|sonnet|haiku)\b/.exec(model);
  if (claude) return claude[1] as VoiceFamily;
  const gpt = /^gpt-[\d.]+-(sol|astra|luna)$/.exec(model);
  return gpt ? (gpt[1] as VoiceFamily) : null;
}

/**
 * The recorded lines of a game, by line id (see shared/videoLines.ts): where each clip is, how long it
 * runs, and what it was made from. `words`: when each spoken word starts, in seconds (the words of
 * `speakable(text)`, without the delivery tag), for clips recorded with timestamps.
 */
export interface VoiceManifest {
  clips: Record<string, { url: string; dur: number; sig: string; words?: number[] }>;
}
