/*
 * A live stream from the server (server/stream.ts): the whole object when it connects, then "patch" events with
 * only what changed. Everything a patch doesn't touch is kept as it was (the same objects), so parts of a page
 * that show only those can skip redrawing.
 */

interface Patch {
  base: number;
  v: number;
  set: Record<string, unknown>;
  del: string[];
  arrays: Record<string, { len: number; at: Record<string, unknown> }>;
  records: Record<string, { set: Record<string, unknown>; del: string[] }>;
}

export function applyPatch<T>(value: T, p: Patch): T {
  const next = { ...(value as Record<string, unknown>) };
  for (const k of p.del) delete next[k];
  Object.assign(next, p.set);
  for (const [k, { len, at }] of Object.entries(p.arrays)) {
    const items = ((next[k] as unknown[]) ?? []).slice(0, len);
    for (const [i, item] of Object.entries(at)) items[Number(i)] = item;
    next[k] = items;
  }
  for (const [k, r] of Object.entries(p.records)) {
    const entries = { ...(next[k] as Record<string, unknown>), ...r.set };
    for (const ek of r.del) delete entries[ek];
    next[k] = entries;
  }
  return next as T;
}

/** Follow a stream: `on` gets the object each time it changes. Returns the function that stops it. */
export function follow<T>(url: string, on: (value: T) => void): () => void {
  let es: EventSource;
  let value: T | null = null;
  let v = 0;
  let stopped = false;
  const open = () => {
    es = new EventSource(url);
    es.onmessage = (e) => {
      value = JSON.parse(e.data) as T;
      v = Number(e.lastEventId) || 0;
      on(value);
    };
    es.addEventListener("patch", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as Patch;
      // A patch for a version this page doesn't have: start again from the whole object.
      if (value === null || p.base !== v) {
        es.close();
        if (!stopped) open();
        return;
      }
      value = applyPatch(value, p);
      v = p.v;
      on(value);
    });
  };
  open();
  return () => {
    stopped = true;
    es.close();
  };
}
