import type { Color, Game, PlayerRef } from "./types";
import { MODELS } from "./models";

/*
 * How each model looks: its maker's house colour, and a glyph for its family on a tile one small
 * lightness step from that colour (flagship deepest, smallest lightest). The version is never in the
 * glyph: an older release of a family looks older instead (see AGES), counted against the catalog, so
 * a new release ages the rest on its own. When both players come from one maker, Black takes the
 * maker's away colour so the two sides differ in hue. Makers we can't run yet are here too, so adding one
 * later is only a catalog entry in models.ts. The glyphs themselves are in web/src/glyphs.ts.
 */

export type GlyphId =
  | "keys" | "fox" | "quill" | "blossom"
  | "sun" | "dipper" | "earth" | "crescent"
  | "prism" | "bolt" | "seed"
  | "galaxy" | "rocket" | "fortytwo"
  | "fluke" | "fish"
  | "gale" | "sail" | "pinwheel"
  | "lamp" | "carpet" | "key"
  | "flame" | "lander" | "person";

/** "dark" tiles get a hairline to show on the dark UI; "light" ones get a dark glyph. */
export type Tone = "dark" | "light";

export interface MakerLook {
  name: string;
  /** House colour: the base every model tile is shaded from. */
  color: string;
  /** The name text and eval line, where the house colour wouldn't show on the dark UI. */
  text?: string;
  /** What its glyphs are drawn from. */
  theme: string;
  /** Families, flagship first: the word in a model's label that picks the glyph ("" matches any label). */
  families: { word: string; glyph: GlyphId }[];
  tone?: Tone;
  /** The lightness steps, flagship → smallest, from -1 (deepest) to 1 (lightest). A light house colour keeps to the deep end. */
  range?: [number, number];
  /** Black's colour when both players come from this maker: a second colour from its own brand or theme. */
  away: string;
  awayTone?: Tone;
  awayText?: string;
}

export const MAKER_LOOKS: Record<string, MakerLook> = {
  anthropic: {
    name: "Claude", color: "#d97757", theme: "literary forms", away: "#6a9bcc", // Anthropic's own brand blue
    families: [{ word: "Opus", glyph: "keys" }, { word: "Fable", glyph: "fox" }, { word: "Sonnet", glyph: "quill" }, { word: "Haiku", glyph: "blossom" }],
  },
  mistral: {
    name: "Mistral", color: "#d4a017", theme: "the wind", range: [-1, 0.15], away: "#fa520f", // the orange-red end of its logo
    families: [{ word: "Large", glyph: "gale" }, { word: "Medium", glyph: "sail" }, { word: "Small", glyph: "pinwheel" }],
  },
  openai: {
    name: "OpenAI", color: "#10a37f", theme: "sky and earth", away: "#ab68ff", // the purple ChatGPT used for GPT-4
    families: [{ word: "Sol", glyph: "sun" }, { word: "Astra", glyph: "dipper" }, { word: "Terra", glyph: "earth" }, { word: "Luna", glyph: "crescent" }],
  },
  deepseek: {
    name: "DeepSeek", color: "#1f86c4", theme: "the deep sea", away: "#ff7f50", // coral
    families: [{ word: "Pro", glyph: "fluke" }, { word: "Flash", glyph: "fish" }],
  },
  google: {
    name: "Gemini", color: "#6c6cf0", theme: "light and speed", away: "#f4b400", awayTone: "light", // Google's yellow
    families: [{ word: "Pro", glyph: "prism" }, { word: "Flash", glyph: "bolt" }, { word: "Flash-Lite", glyph: "seed" }],
  },
  alibaba: {
    name: "Qwen", color: "#ae4fcf", theme: "One Thousand and One Nights", away: "#ff6a00", // Alibaba orange
    families: [{ word: "Max", glyph: "lamp" }, { word: "Plus", glyph: "carpet" }, { word: "Coder", glyph: "key" }],
  },
  meta: {
    name: "Meta", color: "#dc4f7c", theme: "the Muses", away: "#0866ff", // Meta blue
    families: [{ word: "Spark", glyph: "flame" }],
  },
  moonshot: {
    name: "Kimi", color: "#7f8ca3", theme: "the moonshot", away: "#e8c766", awayTone: "light", // harvest-moon gold
    families: [{ word: "", glyph: "lander" }],
  },
  xai: {
    name: "Grok", color: "#1d1f23", text: "#a3a9b4", theme: "The Hitchhiker's Guide to the Galaxy", tone: "dark",
    away: "#ececec", awayTone: "light", awayText: "#f4f4f4", // xAI's black against its white
    families: [{ word: "", glyph: "galaxy" }, { word: "Fast", glyph: "rocket" }, { word: "Code", glyph: "fortytwo" }],
  },
  human: {
    name: "Human", color: "#ebe5d9", theme: "you", tone: "light", away: "#5d9bd5",
    families: [{ word: "", glyph: "person" }],
  },
};

/** The T3 providers we run, by maker; anything else is told by its label. */
const PROVIDER_MAKERS: Record<string, string> = { claudeAgent: "anthropic", codex: "openai", human: "human" };
const LABEL_MAKERS: [RegExp, string][] = [
  [/^(Claude|Opus|Fable|Sonnet|Haiku)\b/, "anthropic"],
  [/^GPT\b/, "openai"],
  [/^Gemini\b/, "google"],
  [/^Grok\b/, "xai"],
  [/^DeepSeek\b/, "deepseek"],
  [/^(Mistral|Magistral|Devstral|Codestral|Ministral)\b/, "mistral"],
  [/^Qwen/, "alibaba"],
  [/^Muse\b/, "meta"],
  [/^Kimi\b/, "moonshot"],
];

type Who = Pick<PlayerRef, "provider" | "modelLabel">;

export function makerKey(p: Who): string | null {
  return PROVIDER_MAKERS[p.provider] ?? LABEL_MAKERS.find(([re]) => re.test(p.modelLabel))?.[1] ?? null;
}

/**
 * How a model looks one more step back from its family's newest, era by era: drawn as a pixel sprite of
 * `grid` cells, the tile washed out (`desat`) and yellowed (`sepia`), the glyph turned `cream`, with a
 * hard pixel `shadow`, a `vignette`, film `grain`, CRT `scan`lines, `scratch`es, and at the end a `peel`ing
 * corner. The last era is where everything older stays.
 */
export interface Age {
  era: string;
  grid?: number;
  desat?: number;
  sepia?: number;
  cream?: number;
  shadow?: number;
  vignette?: number;
  grain?: number;
  scan?: number;
  scratch?: boolean;
  peel?: boolean;
}
export const AGES: Age[] = [
  { era: "today" },
  { era: "16-bit", grid: 20, desat: 0.32, sepia: 0.14, cream: 0.25, shadow: 0.5, vignette: 0.2, grain: 0.12 },
  { era: "8-bit", grid: 16, desat: 0.62, sepia: 0.28, cream: 0.55, vignette: 0.3, grain: 0.2, scan: 0.24 },
  { era: "old photo", grid: 13, desat: 0.82, sepia: 0.5, cream: 0.9, vignette: 0.45, grain: 0.38, scan: 0.14, scratch: true },
  { era: "legacy", grid: 13, desat: 0.9, sepia: 0.6, cream: 0.95, vignette: 0.55, grain: 0.46, scan: 0.14, scratch: true, peel: true },
];
/** Every size a glyph is drawn as a sprite at (scripts/glyph-sprites.ts makes them). */
export const SPRITE_SIZES = [...new Set(AGES.flatMap((a) => (a.grid ? [a.grid] : [])))];
export const ageOf = (gen: number) => AGES[Math.min(gen, AGES.length - 1)];

export interface ModelLook {
  maker: string | null;
  makerName: string;
  /** The name text, eval line, speech bubbles: the house colour, or the away colour. */
  color: string;
  /** The tile behind the glyph, before ageing. */
  tile: string;
  /** Null for a family (or maker) with no glyph yet: show the plain text tile. */
  glyph: GlyphId | null;
  tone?: Tone;
  /** Releases of its family in the catalog newer than it (0 = the newest). */
  gen: number;
  away: boolean;
}

const FALLBACK = "#8b8987";

/** The family a label belongs to: the word earliest in it ("Grok Code Fast" is Code), the longer on a tie ("Flash-Lite" over "Flash"), and "" for the rest. */
function familyOf(look: MakerLook, label: string) {
  const at = (word: string) => (word ? label.search(new RegExp(`(^|[\\s-])${word}($|[\\s-])`)) : Infinity);
  return look.families
    .map((f) => ({ f, at: at(f.word) }))
    .filter((m) => m.at >= 0)
    .sort((a, b) => a.at - b.at || b.f.word.length - a.f.word.length)[0]?.f;
}

/** The release number in a label ("GPT-6.1 Sol" → [6, 1], "Qwen3.8-Max" → [3, 8]), compared part by part. */
const versionOf = (label: string) => label.match(/\d+(?:\.\d+)*/)?.[0].split(".").map(Number) ?? null;
function newer(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

/** The catalog's releases by maker and family. */
let catalog: { key: string; version: number[] }[] | null = null;
function releases(key: string) {
  catalog ??= MODELS.flatMap((m) => {
    const maker = makerKey({ provider: m.provider, modelLabel: m.label });
    const family = maker && MAKER_LOOKS[maker] && familyOf(MAKER_LOOKS[maker], m.label);
    const version = versionOf(m.label);
    return family && version ? [{ key: `${maker}/${family.glyph}`, version }] : [];
  });
  return catalog.filter((r) => r.key === key).map((r) => r.version);
}

/** How many releases of its family in the catalog are newer: a model that's left the catalog still counts against those in it. */
function generationOf(maker: string, glyph: GlyphId, label: string) {
  const mine = versionOf(label);
  if (!mine) return 0;
  return new Set(releases(`${maker}/${glyph}`).filter((v) => newer(v, mine)).map((v) => v.join("."))).size;
}

const looks = new Map<string, ModelLook>();
export function lookOf(p: Who, away = false): ModelLook {
  const key = `${p.provider}\n${p.modelLabel}\n${away}`;
  let look = looks.get(key);
  if (!look) looks.set(key, (look = computeLook(p, away)));
  return look;
}

function computeLook(p: Who, away: boolean): ModelLook {
  const maker = makerKey(p);
  const look = maker ? MAKER_LOOKS[maker] : undefined;
  if (!look) return { maker, makerName: p.provider, color: FALLBACK, tile: FALLBACK, glyph: null, gen: 0, away: false };
  const base = away ? look.away : look.color;
  const tone = away ? look.awayTone : look.tone;
  const color = away ? (look.awayText ?? look.away) : (look.text ?? look.color);
  const family = familyOf(look, p.modelLabel);
  if (!family) return { maker, makerName: look.name, color, tile: base, glyph: null, tone, gen: 0, away };
  const rank = look.families.indexOf(family);
  return {
    maker, makerName: look.name, color, tone, away,
    tile: familyTile(base, tone, away ? undefined : look.range, rank, look.families.length),
    glyph: family.glyph,
    gen: generationOf(maker!, family.glyph, p.modelLabel),
  };
}

/** Both sides' looks in a game: when one maker made both, Black takes its away colour. */
export function sideLooks(g: Pick<Game, "white" | "black">): Record<Color, ModelLook> {
  const w = lookOf(g.white);
  const same = w.maker !== null && w.maker === makerKey(g.black);
  return { w, b: lookOf(g.black, same) };
}

/**
 * Effort as bars out of five, on one ladder for every provider, matched by name: "high" is three bars
 * whoever runs it, and a provider just never reaches the rungs it doesn't offer. Null for an effort off the
 * ladder (and for people).
 */
const EFFORT_BARS: Record<string, number> = { none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
export const effortBars = (effort: string | undefined): number | null => (effort !== undefined && Object.hasOwn(EFFORT_BARS, effort) ? EFFORT_BARS[effort] : null);

/** A tile and glyph colour after ageing. */
export function agedColors(look: Pick<ModelLook, "tile" | "tone" | "gen">): { tile: string; ink: string } {
  const a = ageOf(look.gen);
  const ink = look.tone === "light" ? "#3a352d" : "#ffffff";
  if (!look.gen) return { tile: look.tile, ink };
  const tile = look.tone === "dark" ? mix(look.tile, "#4a3920", (a.sepia ?? 0) * 1.1) : mix(gray(look.tile, a.desat ?? 0), "#8a7254", a.sepia ?? 0);
  return { tile, ink: look.tone === "light" ? mix(ink, "#4a3a22", (a.cream ?? 0) * 0.6) : mix(ink, "#ecd9ae", a.cream ?? 0) };
}

function familyTile(base: string, tone: Tone | undefined, range: [number, number] | undefined, rank: number, n: number): string {
  if (n === 1) return base;
  if (tone === "dark") return mix(base, "#ffffff", rank * 0.06);
  const [lo, hi] = range ?? [-1, 1];
  const t = lo + ((hi - lo) * rank) / (n - 1);
  // Deepen toward a dark version of the same hue (so gold stays gold, not olive); lighten toward white.
  const [h, s] = hsl(base);
  return t < 0 ? mix(base, fromHsl(h, Math.min(s, 70), 13), -t * 0.32) : mix(base, "#ffffff", t * 0.26);
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (a: string, b: string, t: number) => hex(rgb(a).map((x, i) => x + (rgb(b)[i] - x) * t));
function gray(color: string, t: number) {
  const [r, g, b] = rgb(color);
  const y = 0.3 * r + 0.59 * g + 0.11 * b;
  return hex([r, g, b].map((x) => x + (y - x) * t));
}

function hsl(color: string): [number, number, number] {
  const [r, g, b] = rgb(color).map((x) => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return hex([f(0), f(8), f(4)].map((x) => x * 255));
}
