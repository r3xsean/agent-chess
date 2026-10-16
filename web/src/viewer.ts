import { useEffect, useState } from "react";

/*
 * A viewer is anonymous: the server hands out a random id (the viewer's secret) and an editable name.
 * It's kept per prediction server, so the local site and the public mirror can't mix them up.
 */

export interface ViewerInfo {
  id: string;
  name: string;
  points: number;
  right: number;
  calls: number;
  rank: number;
}

const key = (base: string) => `agentChess.viewer:${base || location.origin}`;
const pending = new Map<string, Promise<ViewerInfo>>();

export async function crowdApi<T>(base: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data as T;
}

/** This browser's viewer on a prediction server: the saved one, or a new one. */
export function ensureViewer(base: string): Promise<ViewerInfo> {
  const saved = localStorage.getItem(key(base));
  let p = pending.get(base);
  if (p) return p;
  p = (async () => {
    if (saved) {
      try {
        return await crowdApi<ViewerInfo>(base, `/api/viewers/${encodeURIComponent(saved)}`);
      } catch {
        // The server forgot this viewer (a fresh database): start a new one below.
      }
    }
    const v = await crowdApi<ViewerInfo>(base, "/api/viewers", { name: "" });
    localStorage.setItem(key(base), v.id);
    return v;
  })();
  pending.set(base, p);
  p.catch(() => pending.delete(base));
  return p;
}

export async function renameViewer(base: string, id: string, name: string): Promise<ViewerInfo> {
  const v = await crowdApi<ViewerInfo>(base, `/api/viewers/${encodeURIComponent(id)}`, { name });
  pending.set(base, Promise.resolve(v));
  return v;
}

/** The viewer for a prediction server (null while it loads, or if the server can't be reached). */
export function useViewer(base: string | null): [ViewerInfo | null, (v: ViewerInfo) => void] {
  const [v, setV] = useState<ViewerInfo | null>(null);
  useEffect(() => {
    if (base === null) return;
    let alive = true;
    ensureViewer(base)
      .then((x) => alive && setV(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base]);
  return [v, setV];
}
