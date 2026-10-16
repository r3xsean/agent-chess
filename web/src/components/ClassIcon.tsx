import type { Classification } from "../../../shared/types";

export const CLASS_META: Record<Classification, { label: string; color: string; glyph: string }> = {
  brilliant: { label: "Brilliant", color: "#26c2a3", glyph: "!!" },
  great: { label: "Great", color: "#749bbf", glyph: "!" },
  best: { label: "Best", color: "#81b64c", glyph: "★" },
  excellent: { label: "Excellent", color: "#81b64c", glyph: "👍" },
  good: { label: "Good", color: "#95b776", glyph: "✓" },
  book: { label: "Book", color: "#a88764", glyph: "📖" },
  forced: { label: "Forced", color: "#96af8b", glyph: "→" },
  inaccuracy: { label: "Inaccuracy", color: "#f7c631", glyph: "?!" },
  mistake: { label: "Mistake", color: "#ffa459", glyph: "?" },
  miss: { label: "Miss", color: "#ff7769", glyph: "✕" },
  blunder: { label: "Blunder", color: "#fa412d", glyph: "??" },
};

export const CLASS_ORDER: Classification[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

function Glyph({ c }: { c: Classification }) {
  const white = "#fff";
  switch (c) {
    case "best":
      return <path d="M50 20 L58.8 38 L78.5 40.7 L64.2 54.5 L67.6 74.1 L50 64.8 L32.4 74.1 L35.8 54.5 L21.5 40.7 L41.2 38 Z" fill={white} />;
    case "excellent":
      return (
        <path
          d="M30 48 h9 v26 h-9 z M43 48 l9-17 c2-4 8-3 8 2 v10 h13 c4 0 7 4 6 8 l-4 17 c-1 4-4 6-8 6 h-24 z"
          fill={white}
        />
      );
    case "good":
      return <path d="M28 52 L43 67 L73 35" stroke={white} strokeWidth="11" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    case "book":
      return (
        <path
          d="M24 32 c9-4 18-4 25 2 v38 c-7-6-16-6-25-2 z M51 34 c7-6 16-6 25-2 v38 c-9-4-18-4-25 2 z"
          fill={white}
        />
      );
    case "miss":
      return <path d="M34 34 L66 66 M66 34 L34 66" stroke={white} strokeWidth="11" strokeLinecap="round" />;
    case "forced":
      return <path d="M28 50 H68 M54 34 L70 50 L54 66" stroke={white} strokeWidth="10" fill="none" strokeLinecap="round" strokeLinejoin="round" />;
    default: {
      const g = CLASS_META[c].glyph;
      return (
        <text x="50" y="52" textAnchor="middle" dominantBaseline="central" fill={white} fontWeight="900" fontSize={g.length > 1 ? 50 : 60} fontFamily="Arial, sans-serif" letterSpacing="-4">
          {g}
        </text>
      );
    }
  }
}

export function ClassIcon({ c, size }: { c: Classification; size?: number }) {
  return (
    <svg className="class-icon" viewBox="0 0 100 100" width={size} height={size} aria-label={CLASS_META[c].label}>
      <circle cx="50" cy="50" r="48" fill={CLASS_META[c].color} />
      <Glyph c={c} />
    </svg>
  );
}
