import { useEffect, useState } from "react";
import type { Game, JournalEntry, Lessons, ModelOption, Personality, PlayerRef, PlayerStats, Tournament } from "../../shared/types";

export interface GameSummary {
  id: string;
  createdAt: number;
  white: PlayerRef;
  black: PlayerRef;
  phase: Game["phase"];
  result: Game["result"];
  termination: string | null;
  plies: number;
  opening: Game["opening"];
  tournamentId?: string;
  accuracy: { w: number | null; b: number | null } | null;
}

export interface Lobby {
  games: GameSummary[];
  players: PlayerStats[];
  tournaments: Tournament[];
}

export interface Meta {
  models: ModelOption[];
  personalities: Personality[];
  defaultBroadcaster: { provider: string; model: string; effort: string };
  /** A T3 webhook is configured, so the site can summon agents itself. */
  summonAvailable: boolean;
}

export interface LaunchSpec {
  gameId: string;
  tasks: { role: string; title: string; clientRequestId: string; target: unknown; prompt: string }[];
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data as T;
}

/** Subscribe to a server-sent-events stream that pushes the whole object on change. */
export function useStream<T>(url: string | null): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    setValue(null);
    const es = new EventSource(url);
    es.onmessage = (e) => setValue(JSON.parse(e.data));
    return () => es.close();
  }, [url]);
  return value;
}

export function useFetch<T>(url: string | null, deps: unknown[] = []): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    api<T>(url).then((v) => alive && setValue(v)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, ...deps]);
  return value;
}

export type MemoryModel = { model: string; label: string; lessons: Lessons; players: { player: PlayerStats; journal: JournalEntry[] }[] };

export type PlayerPage ={ player: PlayerStats; journal: JournalEntry[]; games: GameSummary[] };
export type TournamentPage = { tournament: Tournament; games: (GameSummary | null)[] };
