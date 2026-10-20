// How models look: each label finds its maker and family glyph, a family's older releases count back from
// the newest in the catalog (a retired one too), Black takes the away colour only when one maker made both
// sides, and every glyph has a well-formed sprite for each era.
import { AGES, SPRITE_SIZES, ageOf, lookOf, sideLooks } from "../shared/looks";
import { selfEvalColors } from "../shared/naming";
import { GLYPHS } from "../web/src/glyphs";
import { SPRITES } from "../web/src/glyphSprites";

let ok = true;
const fail = (msg: string) => ((ok = false), console.log("FAIL", msg));
const eq = (what: string, got: unknown, want: unknown) => got !== want && fail(`${what}: got ${got}, want ${want}`);
const ref = (provider: string, modelLabel: string) => ({ id: `${modelLabel}@high`, provider, model: modelLabel, modelLabel, effort: "high" });

// Families, including makers we don't run yet (told by the label).
for (const [provider, label, glyph] of [
  ["claudeAgent", "Opus 5.5", "keys"],
  ["claudeAgent", "Haiku 5.5", "blossom"],
  ["codex", "GPT-6 Astra", "dipper"],
  ["codex", "GPT-5.6 Terra", "earth"],
  ["gemini", "Gemini 3.5 Flash-Lite", "seed"],
  ["gemini", "Gemini 3.8 Flash", "bolt"],
  ["grok", "Grok 4.7", "galaxy"],
  ["grok", "Grok Code Fast 1", "fortytwo"],
  ["deepseek", "DeepSeek V4-Pro", "fluke"],
  ["qwen", "Qwen3.8-Max", "lamp"],
  ["kimi", "Kimi K3", "lander"],
  ["human", "Sean", "person"],
] as const)
  eq(`${label} glyph`, lookOf({ provider, modelLabel: label }).glyph, glyph);
eq("unknown maker glyph", lookOf({ provider: "x", modelLabel: "Mystery 1" }).glyph, null);
eq("unknown family glyph", lookOf({ provider: "mistral", modelLabel: "Devstral 2" }).glyph, null);

// Generations count back from the newest release of the family in the catalog.
for (const [provider, label, gen] of [
  ["codex", "GPT-6.1 Sol", 0],
  ["codex", "GPT-6 Sol", 1],
  ["codex", "GPT-5.6 Sol", 2],
  ["codex", "GPT-6 Luna", 0],
  ["codex", "GPT-5.6 Luna", 1],
  ["codex", "GPT-6 Astra", 0],
  ["claudeAgent", "Opus 5.5", 0],
  ["claudeAgent", "Opus 5", 1],
  ["claudeAgent", "Sonnet 5", 1],
  ["claudeAgent", "Fable 5.1", 0],
  ["claudeAgent", "Opus 4.1", 2], // retired: two catalog Opuses are newer
  ["codex", "GPT-4 Sol", 3],
  ["human", "Sean", 0],
] as const)
  eq(`${label} generation`, lookOf({ provider, modelLabel: label }).gen, gen);
if (!ageOf(99).peel || ageOf(99) !== AGES[AGES.length - 1]) fail("very old releases should stay in the last (peeling) era");
if (ageOf(0).grid) fail("the newest should be the crisp glyph");

// Shades: one maker's families differ, in its own hue.
if (lookOf({ provider: "claudeAgent", modelLabel: "Opus 5.5" }).tile === lookOf({ provider: "claudeAgent", modelLabel: "Sonnet 5.5" }).tile) fail("Opus and Sonnet share a tile");

// Away colours: only when one maker made both sides, and only for Black.
const opus = ref("claudeAgent", "Opus 5.5"), sonnet = ref("claudeAgent", "Sonnet 5.5"), sol = ref("codex", "GPT-6.1 Sol");
const same = sideLooks({ white: opus, black: sonnet });
eq("Claude vs Claude: White away", same.w.away, false);
eq("Claude vs Claude: Black away", same.b.away, true);
eq("Claude vs Claude: Black's colour", same.b.color, "#6a9bcc");
eq("Claude vs OpenAI: Black away", sideLooks({ white: opus, black: sol }).b.away, false);
eq("human vs human: Black away", sideLooks({ white: ref("human", "A"), black: ref("human", "B") }).b.away, true);
const lines = selfEvalColors({ white: opus, black: sonnet });
if (lines.w === lines.b) fail("same-maker eval lines share a colour");
eq("Claude vs Claude: White's line", lines.w, "#d97757");
const grok = sideLooks({ white: ref("grok", "Grok 4.7"), black: ref("grok", "Grok 4.7 Fast") });
eq("Grok vs Grok: White's tone", grok.w.tone, "dark");
eq("Grok vs Grok: Black's tone", grok.b.tone, "light");

// Sprites: every glyph, every era's size, square, only "#" and ".", and not blank.
for (const id of Object.keys(GLYPHS) as (keyof typeof GLYPHS)[])
  for (const n of SPRITE_SIZES) {
    const rows = SPRITES[id]?.[n];
    if (!rows) fail(`${id} has no ${n}px sprite`);
    else if (rows.length !== n || rows.some((r) => r.length !== n || /[^#.]/.test(r))) fail(`${id} ${n}px sprite isn't ${n}×${n} of # and .`);
    else if (!rows.some((r) => r.includes("#"))) fail(`${id} ${n}px sprite is blank`);
  }

console.log(ok ? "ok" : "FAILED");
process.exit(ok ? 0 : 1);
