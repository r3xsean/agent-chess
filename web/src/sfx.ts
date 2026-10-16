import { useState } from "react";

/*
 * The same sound effects as the replay videos (vendor/sfx, CC0), played on the site: a quiet board
 * sound for every move, louder stings for the moves that matter, and the game's events.
 * Files are <event>_<n>.ogg; variants of an event rotate.
 */

let files: string[] | null = null;
let loading: Promise<void> | null = null;
const turn: Record<string, number> = {};

const KEY = "agent-chess:sfx";
const enabled = () => localStorage.getItem(KEY) !== "off";

function load() {
  loading ??= fetch("/api/sfx")
    .then((r) => r.json())
    .then((list: string[]) => void (files = list))
    .catch(() => void (files = []));
  return loading;
}

export async function playSfx(event: string, volume = 1) {
  if (!enabled()) return;
  await load();
  const list = files!.filter((n) => n.startsWith(`${event}_`));
  if (!list.length) return;
  const name = list[(turn[event] = (turn[event] ?? -1) + 1) % list.length];
  const a = new Audio(`/sfx/${name}`);
  a.volume = Math.max(0, Math.min(1, volume));
  // Browsers block sound until the viewer has interacted with the page; that's fine to skip.
  a.play().catch(() => {});
}

/** The board sound for a move, from its SAN: capture or move, plus check, castling, promotion, mate. */
export function playMoveSound(san: string, volume = 0.6) {
  playSfx(san.includes("x") ? "capture" : "move", volume);
  if (san.startsWith("O-O")) setTimeout(() => playSfx("move", volume * 0.8), 100);
  if (san.includes("=")) playSfx("promotion", volume);
  if (san.includes("#")) setTimeout(() => playSfx("checkmate", 0.9), 60);
  else if (san.includes("+")) playSfx("check", volume * 0.8);
}

/** Verdicts loud enough to deserve a sound of their own. */
export const STING: Record<string, [string, number]> = {
  brilliant: ["brilliant", 0.9],
  great: ["great", 0.8],
  blunder: ["blunder", 0.8],
  mistake: ["mistake", 0.7],
  miss: ["mistake", 0.7],
};

export function useSfxToggle() {
  const [on, setOn] = useState(enabled);
  return {
    on,
    toggle: () => {
      localStorage.setItem(KEY, on ? "off" : "on");
      setOn(!on);
    },
  };
}
