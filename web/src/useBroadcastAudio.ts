import { useEffect, useRef, useState } from "react";
import type { Game } from "../../shared/types";

/**
 * Plays broadcaster segments that arrive while the page is open, one after another.
 * Lines that existed when the page loaded are not auto-played (they can be replayed by click).
 */
export function useBroadcastAudio(game: Game | null) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem("broadcastAudio") !== "off");
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [blocked, setBlocked] = useState(false);
  const known = useRef<Set<number> | null>(null);
  const queue = useRef<{ id: number; src: string }[]>([]);
  const audio = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const playNext = () => {
    if (audio.current || !enabledRef.current) return;
    const next = queue.current.shift();
    if (!next) return;
    const a = new Audio(next.src);
    audio.current = a;
    setSpeaking(next.id);
    // Each attempt settles exactly once, and only ever touches its own element.
    let settled = false;
    const settle = (requeue: boolean) => {
      if (settled) return;
      settled = true;
      a.onended = null;
      a.onerror = null;
      if (audio.current !== a) return; // superseded (muted, replayed, or page left)
      audio.current = null;
      setSpeaking(null);
      if (requeue) {
        queue.current.unshift(next);
        setBlocked(true);
      } else playNext();
    };
    a.onended = () => settle(false);
    a.onerror = () => settle(false);
    a.play()
      .then(() => setBlocked(false))
      // Only the autoplay policy (NotAllowedError) should wait for a click; other failures skip the segment.
      .catch((e: DOMException) => settle(e?.name === "NotAllowedError"));
  };

  const stopAll = () => {
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
    }
    audio.current = null;
    queue.current = [];
    setSpeaking(null);
  };

  useEffect(() => {
    known.current = null;
    stopAll();
    // Leaving the game page must silence it.
    return stopAll;
  }, [game?.id]);

  useEffect(() => {
    if (!game) return;
    if (!known.current) {
      known.current = new Set(game.broadcast.map((l) => l.id));
      return;
    }
    for (const l of game.broadcast) {
      if (!l.audio || known.current.has(l.id)) continue;
      known.current.add(l.id);
      if (enabledRef.current) queue.current.push({ id: l.id, src: l.audio }); // muted segments are skipped, not saved up
    }
    playNext();
  }, [game?.broadcast.length, game?.broadcast.map((l) => l.audio ?? "").join("|")]);

  const setOn = (on: boolean) => {
    localStorage.setItem("broadcastAudio", on ? "on" : "off");
    setEnabled(on);
    enabledRef.current = on;
    if (!on) stopAll();
    else playNext();
  };

  const replay = (id: number, src: string) => {
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
    }
    audio.current = null;
    queue.current.unshift({ id, src });
    playNext();
  };

  const unlock = () => {
    setBlocked(false);
    playNext();
  };

  return { enabled, setEnabled: setOn, speaking, blocked, unlock, replay };
}
