import { useId } from "react";
import type { PlayerRef } from "../../../shared/types";
import { ageOf, agedColors, lookOf, type Age, type ModelLook } from "../../../shared/looks";
import { isHuman } from "../../../shared/naming";
import { GLYPHS } from "../glyphs";
import { SPRITES } from "../glyphSprites";

type Who = Pick<PlayerRef, "provider" | "modelLabel">;

/** The word that tells models apart at a glance: "Opus", "Haiku", "Sol", "Luna"… */
export function modelMark(p: Who): string {
  const words = p.modelLabel.split(" ");
  return p.provider === "codex" ? words[words.length - 1] : words[0];
}

/**
 * A player's face: their model's glyph on its tile, an older release drawn from an older era (see AGES in
 * shared/looks.ts). In a game, pass the side's `look` (sideLooks) so Black shows the away colour when both
 * players share a maker.
 */
export function PlayerAvatar({ player, size = 40, look = lookOf(player) }: { player: Who; size?: number; look?: ModelLook }) {
  const age = ageOf(look.gen);
  const { tile, ink } = agedColors(look);
  const behind = look.gen ? ` · ${look.gen} ${look.gen === 1 ? "release" : "releases"} behind the newest` : "";
  const mark = modelMark(player);
  return (
    <div className={`player-avatar ${look.tone ?? ""}`} style={{ width: size, height: size, background: tile }} title={isHuman(player) ? `${player.modelLabel} (human)` : `${player.modelLabel}${behind}`}>
      {!look.glyph ? (
        <span style={{ fontSize: size * (mark.length > 5 ? 0.22 : 0.27) }}>{mark}</span>
      ) : age.grid ? (
        <Sprite rows={SPRITES[look.glyph][age.grid]} ink={ink} shadow={age.shadow} />
      ) : (
        <svg className="glyph" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: GLYPHS[look.glyph](ink, tile) }} />
      )}
      {look.gen > 0 && <Wear age={age} size={size} />}
    </div>
  );
}

const spritePaths = new Map<string[], string>();
function Sprite({ rows, ink, shadow }: { rows: string[]; ink: string; shadow?: number }) {
  let d = spritePaths.get(rows);
  if (d === undefined) {
    d = rows.map((r, y) => [...r].map((c, x) => (c === "#" ? `M${x} ${y}h1v1h-1z` : "")).join("")).join("");
    spritePaths.set(rows, d);
  }
  return (
    <svg className="glyph" viewBox={`0 0 ${rows.length} ${rows.length}`} shapeRendering="crispEdges" overflow="visible">
      {shadow && <path d={d} fill="#000" opacity={shadow} transform="translate(1 1)" />}
      <path d={d} fill={ink} />
    </svg>
  );
}

/** Film grain: the same specks on every tile. */
const GRAIN = Array.from({ length: 40 }, (_, i) => {
  const x = (i * 7.3) % 24, y = (i * 11.7) % 24, r = 0.22 + ((i * 3) % 5) / 11;
  return `M${(x - r).toFixed(2)} ${y.toFixed(2)}a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0a${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0`;
}).join("");
const FLAP = "M14 0C15.3 3.6 15.8 7 14.8 9.7 17.9 9.2 21 9.4 24 10Z";

/** The wear an era leaves on a tile: vignette, grain, scanlines, scratches, and at the end a peeling corner. */
function Wear({ age, size }: { age: Age; size: number }) {
  const id = useId();
  const fine = size > 30;
  return (
    <>
      {age.vignette && <div className="wear" style={{ background: `radial-gradient(circle at 50% 45%, transparent 38%, rgba(30,18,6,${age.vignette}) 100%)` }} />}
      {age.grain && (
        <svg className="wear" viewBox="0 0 24 24" preserveAspectRatio="none">
          <path d={GRAIN} fill="#2b1d0c" opacity={age.grain} />
        </svg>
      )}
      {age.scan && <div className="wear" style={{ background: `repeating-linear-gradient(0deg, rgba(0,0,0,${age.scan}) 0 1px, transparent 1px ${Math.max(2, Math.round(size / 17))}px)` }} />}
      {age.scratch && (
        <svg className="wear" viewBox="0 0 24 24" preserveAspectRatio="none">
          <path d="M5.5 -1 8.8 25M16.5 6 15.2 13.5M2 15.5 11 13.8" stroke="rgba(255,244,220,.4)" strokeWidth={fine ? 0.3 : 0.5} fill="none" />
        </svg>
      )}
      {age.peel && (
        <svg className="wear" viewBox="0 0 24 24" preserveAspectRatio="none">
          <defs>
            <linearGradient id={`${id}g`} x1="14.5" y1="9.8" x2="19.5" y2="4.6" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#f6ecd4" />
              <stop offset=".55" stopColor="#d9c8a2" />
              <stop offset="1" stopColor="#a8946c" />
            </linearGradient>
            <filter id={`${id}f`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation=".7" />
            </filter>
          </defs>
          <path d="M24 0H14L24 10Z" fill="#1a1917" />
          <path d={FLAP} fill="rgba(0,0,0,.55)" transform="translate(-.6 .9)" filter={`url(#${id}f)`} />
          <path d={FLAP} fill={`url(#${id}g)`} />
          <path d="M14 0 24 10" stroke="rgba(0,0,0,.25)" strokeWidth=".35" />
        </svg>
      )}
    </>
  );
}

/** The model's name in its colour (the house colour, or the away colour in a game), with the effort. */
export function PlayerName({ player, effort = true, className = "", look = lookOf(player) }: { player: PlayerRef; effort?: boolean; className?: string; look?: ModelLook }) {
  return (
    <span className={`player-fullname ${className}`}>
      <b style={{ color: look.color }}>{player.modelLabel}</b>
      {effort && <small className="effort">{isHuman(player) ? "human" : player.effort}</small>}
    </span>
  );
}
