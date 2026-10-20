import { memo, useEffect, useRef } from "react";
import type { Color, Game } from "../../../shared/types";
import { fullName } from "../../../shared/naming";
import { sideLooks } from "../../../shared/looks";
import { PlayerAvatar } from "./PlayerName";
import { scrollIntoPanel } from "../scroll";

/** The players' pre- and post-game interviews, in the order they were given. */
export const Interviews = memo(function Interviews({ game }: { game: Game }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = (["pre", "post"] as const)
    .flatMap((when) =>
      (["w", "b"] as Color[]).flatMap((c) => {
        const iv = game.interviews[when][c];
        return iv ? [{ ts: iv.ts, color: c, when, text: iv.text }] : [];
      }),
    )
    .sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    // To the newest answer, in whichever box scrolls the feed (never the page).
    scrollIntoPanel(ref.current?.lastElementChild, "nearest", false);
  }, [items.length]);

  return (
    <div ref={ref}>
      {items.length === 0 && <div className="empty">No interviews yet. The players' pre- and post-game answers will appear here.</div>}
      {items.map((it) => (
        <div key={`iv${it.when}${it.color}`} className="interview-item">
          <PlayerAvatar player={it.color === "w" ? game.white : game.black} look={sideLooks(game)[it.color]} size={36} />
          <div style={{ flex: 1 }}>
            <div className="who">
              {it.when === "pre" ? "Pre-game interview" : "Post-game interview"} · {fullName(it.color === "w" ? game.white : game.black)}
            </div>
            <div className="bubble">{it.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
});
