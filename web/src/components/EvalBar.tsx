import { useRef } from "react";
import type { Color, Score } from "../../../shared/types";
import { formatScore, winPercentWhite } from "../../../shared/evalmath";

export function EvalBar({ score: incoming, orientation, result }: { score?: Score; orientation: Color; result?: string | null }) {
  // While a new position is still being analyzed, hold the last known evaluation instead of snapping to equal.
  const last = useRef<Score | undefined>(undefined);
  if (incoming) last.current = incoming;
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
  return (
    <div className="eval-bar" style={{ height: "var(--size)" }}>
      <div className="fill" style={fill} />
      <div className="num" style={{ [labelAtBottom ? "bottom" : "top"]: 6, color: whiteAhead ? "#403d39" : "#ffffff" }}>
        {label}
      </div>
    </div>
  );
}
