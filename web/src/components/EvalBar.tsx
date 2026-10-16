import { useRef } from "react";
import type { Color, Score } from "../../../shared/types";
import { formatScore, winPercentWhite } from "../../../shared/evalmath";

/** A player's own evaluation drawn on the bar: White's win% as they see it, in their colour. */
export interface BeliefMark {
  key: string;
  white: number;
  color: string;
  /** Far from the engine: the gap to the engine's level is shaded. */
  misjudged: boolean;
  title: string;
}

export function EvalBar({
  score: incoming,
  orientation,
  result,
  hidden,
  marks = [],
}: {
  score?: Score;
  orientation: Color;
  result?: string | null;
  hidden?: boolean;
  marks?: BeliefMark[];
}) {
  // While a new position is still being analyzed, hold the last known evaluation instead of snapping to equal.
  const last = useRef<Score | undefined>(undefined);
  if (incoming) last.current = incoming;
  // You're playing this game: no engine until it's over.
  if (hidden) return <div className="eval-bar off" style={{ height: "var(--size)" }} title="The engine is hidden while you play" />;
  const score = last.current;
  let white = score ? winPercentWhite(score) : 50;
  if (result === "1-0") white = 100;
  else if (result === "0-1") white = 0;
  else if (result === "1/2-1/2") white = 50;
  const label = result ?? (score ? formatScore(score).replace("+", "") : "");
  const whiteAhead = white >= 50;
  const fill = orientation === "w" ? { bottom: 0, height: `${white}%` } : { top: 0, height: `${white}%` };
  // Label sits at the end belonging to the side that's ahead, like chess.com.
  const labelAtBottom = whiteAhead === (orientation === "w");
  // Distance from White's end of the bar (the bottom when White is at the bottom).
  const at = (w: number) => (orientation === "w" ? { bottom: `${w}%` } : { top: `${w}%` });
  return (
    <div className="eval-bar" style={{ height: "var(--size)" }}>
      <div className="fill" style={fill} />
      {/* Once the bar shows the result rather than the engine, a gap to it would mean nothing. */}
      {(result ? [] : marks).map((m) => {
        const lo = Math.min(m.white, white);
        return (
          <div key={m.key}>
            {m.misjudged && (
              <div
                className="belief-gap"
                style={{ ...at(lo), height: `${Math.abs(m.white - white)}%`, ["--c" as string]: m.color }}
                title={m.title}
              />
            )}
            <div
              className={`belief-mark ${m.misjudged ? "off" : ""}`}
              style={{ ...at(m.white), transform: `translateY(${orientation === "w" ? 50 : -50}%)`, ["--c" as string]: m.color }}
              title={m.title}
            />
          </div>
        );
      })}
      <div className="num" style={{ [labelAtBottom ? "bottom" : "top"]: 6, color: whiteAhead ? "#403d39" : "#ffffff" }}>
        {label}
      </div>
    </div>
  );
}
