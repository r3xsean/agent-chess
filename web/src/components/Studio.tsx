import { useEffect, useRef } from "react";
import type { Color, Game } from "../../../shared/types";
import { personalityById } from "../../../shared/personalities";
import { Avatar } from "./PlayerBar";
import type { useBroadcastAudio } from "../useBroadcastAudio";

type Item =
  | { kind: "bc"; ts: number; id: number; text: string; audio?: string }
  | { kind: "iv"; ts: number; color: Color; when: "pre" | "post"; text: string };

export function Studio({ game, audio }: { game: Game; audio: ReturnType<typeof useBroadcastAudio> }) {
  const ref = useRef<HTMLDivElement>(null);
  const items: Item[] = [
    ...game.broadcast.map((l) => ({ kind: "bc" as const, ts: l.ts, id: l.id, text: l.text, audio: l.audio })),
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
        <span>{game.broadcaster?.enabled ? "🎙 Live broadcast" : "No broadcaster for this game"}</span>
        {game.broadcaster?.enabled && (
          <span className={`toggle ${audio.enabled ? "on" : ""}`} onClick={() => audio.setEnabled(!audio.enabled)}>
            Voice <span className="sw" />
          </span>
        )}
      </div>
      {audio.blocked && audio.enabled && (
        <div className="audio-unlock">
          <button className="btn green" style={{ width: "100%" }} onClick={audio.unlock}>
            🔊 Click to start the broadcast audio
          </button>
        </div>
      )}
      {items.length === 0 && <div className="empty">The studio is quiet. Interviews and the broadcaster's commentary will appear here.</div>}
      {items.map((it) =>
        it.kind === "bc" ? (
          <div key={`bc${it.id}`} className={`studio-item ${audio.speaking === it.id ? "speaking" : ""}`}>
            <div className="mic">🎙</div>
            <div style={{ flex: 1 }}>
              <div className="who">
                Broadcaster
                {it.audio && (
                  <button className="icon-btn" style={{ fontSize: 13, padding: "0 4px" }} onClick={() => audio.replay(it.id, it.audio!)} title="Play">
                    {audio.speaking === it.id ? "🔊" : "▶"}
                  </button>
                )}
              </div>
              {it.text}
            </div>
          </div>
        ) : (
          <div key={`iv${it.when}${it.color}`} className="studio-item interview">
            <Avatar personality={(it.color === "w" ? game.white : game.black).personality} />
            <div style={{ flex: 1 }}>
              <div className="who">
                {it.when === "pre" ? "Pre-game interview" : "Post-game interview"} · {personalityById((it.color === "w" ? game.white : game.black).personality).name}
              </div>
              <div className="bubble">{it.text}</div>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
