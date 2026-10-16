import type { Color, PlayerRef } from "../../../shared/types";
import { personalityById } from "../../../shared/personalities";
import type { MaterialInfo } from "../../../shared/material";

const NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

export function Avatar({ personality, size }: { personality: string; size?: number }) {
  const p = personalityById(personality);
  return (
    <div className="avatar" style={{ background: p.color, ...(size ? { width: size, height: size, fontSize: size * 0.55 } : {}) }} title={p.name}>
      {p.emoji}
    </div>
  );
}

/** Pieces this side has captured, and its material lead — like chess.com under each name. */
function Captured({ info, color }: { info: MaterialInfo; color: Color }) {
  const opp: Color = color === "w" ? "b" : "w";
  const lead = info.material[color] - info.material[opp];
  const groups = ["p", "b", "n", "r", "q"]
    .map((t) => ({ t, n: info.captured[color].filter((x) => x === t).length }))
    .filter((g) => g.n > 0);
  return (
    <div className="captured cg-wrap" style={{ width: "auto", height: "auto" }}>
      {groups.map((g, gi) => (
        <span key={g.t} style={{ display: "flex" }}>
          {gi > 0 && <span className="gap" />}
          {Array.from({ length: g.n }, (_, i) => (
            <piece key={i} className={`${NAME[g.t]} ${opp === "w" ? "white" : "black"}`} />
          ))}
        </span>
      ))}
      {lead > 0 && <span className="adv">+{lead}</span>}
    </div>
  );
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export function PlayerBar(props: {
  player: PlayerRef;
  color: Color;
  material: MaterialInfo;
  rating?: number;
  status?: { text: string; kind: "thinking" | "idle" | "plain" } | null;
  clockMs: number;
  active: boolean;
  onClick?: () => void;
}) {
  const p = personalityById(props.player.personality);
  return (
    <div className="player-bar">
      <a href={`#/player/${encodeURIComponent(props.player.id)}`}>
        <Avatar personality={props.player.personality} />
      </a>
      <div className="player-meta">
        <div className="player-name">
          <a href={`#/player/${encodeURIComponent(props.player.id)}`}>{p.name}</a>
          {props.rating !== undefined && <span className="rating">({props.rating})</span>}
          <span className="chip">
            {props.player.modelLabel} · {props.player.effort}
          </span>
          {props.status && <span className={`status-pill ${props.status.kind}`}>{props.status.text}</span>}
        </div>
        <div className="player-sub">
          <Captured info={props.material} color={props.color} />
        </div>
      </div>
      <div className={`clock ${props.active ? "active" : ""}`} title="Total thinking time">
        {fmt(props.clockMs)}
      </div>
    </div>
  );
}
