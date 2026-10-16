import { useEffect, useRef } from "react";
import type { Color, Game } from "../../../shared/types";
import { fullName } from "../../../shared/naming";
import { PlayerAvatar } from "./PlayerName";

type Item =
  | { kind: "bc"; ts: number; id: number; text: string }
  | { kind: "iv"; ts: number; color: Color; when: "pre" | "post"; text: string };

export function Studio({ game, hideBroadcast }: { game: Game; hideBroadcast?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const items: Item[] = [
    // The broadcaster talks engine verdicts and the agent's thinking: not for a player's eyes mid-game.
    ...(hideBroadcast ? [] : game.broadcast.map((l) => ({ kind: "bc" as const, ts: l.ts, id: l.id, text: l.text }))),
    ...(["pre", "post"] as const).flatMap((when) =>
      (["w", "b"] as Color[]).flatMap((c) => {
        const iv = game.interviews[when][c];
        return iv ? [{ kind: "iv" as const, ts: iv.ts, color: c, when, text: iv.text }] : [];
      }),
    ),
  ].sort((a, b) => a.ts - b.ts);

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  return (
    <div ref={ref}>
      <div className="studio-controls">
        <span>
          {!game.broadcaster?.enabled ? "No broadcaster for this game" : hideBroadcast ? "🎙 The broadcast unlocks when your game ends" : "🎙 Live broadcast"}
        </span>
      </div>
      {items.length === 0 && <div className="empty">The studio is quiet. Interviews and the broadcaster's commentary will appear here.</div>}
      {items.map((it) =>
        it.kind === "bc" ? (
          <div key={`bc${it.id}`} className="studio-item">
            <div className="mic">🎙</div>
            <div style={{ flex: 1 }}>
              <div className="who">Broadcaster</div>
              {it.text}
            </div>
          </div>
        ) : (
          <div key={`iv${it.when}${it.color}`} className="studio-item interview">
            <PlayerAvatar player={it.color === "w" ? game.white : game.black} size={36} />
            <div style={{ flex: 1 }}>
              <div className="who">
                {it.when === "pre" ? "Pre-game interview" : "Post-game interview"} · {fullName(it.color === "w" ? game.white : game.black)}
              </div>
              <div className="bubble">{it.text}</div>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
