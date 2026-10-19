import { useEffect, useRef, useState } from "react";
import type { DirectorThreadState, VideoContext } from "../../../shared/directorThread";
import { api } from "../api";

export function DirectorThread({ gameId, directed, locked, context, onState }: {
  gameId: string; directed: boolean; locked: boolean; context: VideoContext; onState: (state: DirectorThreadState) => void;
}) {
  const [state, setState] = useState<DirectorThreadState | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const openWhenReady = useRef(false);
  const callback = useRef(onState);
  callback.current = onState;
  const take = (s: DirectorThreadState) => {
    setState(s); callback.current(s);
    if (s.threadUrl && openWhenReady.current) { openWhenReady.current = false; window.location.href = s.threadUrl; }
    if (s.status === "failed") openWhenReady.current = false;
  };
  useEffect(() => {
    let alive = true;
    const load = () => api<DirectorThreadState>(`/api/games/${gameId}/director-thread`).then(s => {
      if (alive) { take(s); setError(""); }
    }).catch(e => { if (alive) setError(e.message); });
    load();
    const timer = setInterval(load, 2500);
    return () => { alive = false; openWhenReady.current = false; clearInterval(timer); };
  }, [gameId]);
  const open = async () => {
    setSending(true); setError(""); openWhenReady.current = true;
    try { take(await api<DirectorThreadState>(`/api/games/${gameId}/director-thread`, { context, retry: state?.status === "failed" })); }
    catch (e) { openWhenReady.current = false; setError((e as Error).message); }
    finally { setSending(false); }
  };
  const opening = sending || state?.status === "opening";
  return <section className="director-thread">
    <h3>1. Run director</h3>
    {directed ? <p className="rp-ok">✓ A plan is ready to review</p> : <>
      <p className="rp-muted">The director prepares the cut and delegates its narration in T3 Code.</p>
      <button className="rp-go" disabled={locked || opening || !state?.available || state.status === "working"} onClick={open}>{opening ? "Opening T3 Code…" : state?.status === "working" ? "Director is working…" : "Run director"}</button>
    </>}
    <h3>2. Review and approve</h3>
    <p className="rp-muted">Talk and make changes in T3 Code. This preview updates as edits are saved. Come back here to approve.</p>
    {state?.threadUrl ? <a className="rp-go" href={state.threadUrl} onClick={() => { void api(`/api/games/${gameId}/director-thread`, { context }).catch(() => {}); }}>Talk with the director ↗</a> : <button className="rp-go" disabled={locked || opening || !state?.available} onClick={open}>{opening ? "Opening T3 Code…" : state?.status === "failed" ? "Retry opening director" : "Talk with the director ↗"}</button>}
    {(state?.status === "working" || state?.status === "narrating") && <p className="rp-muted" role="status">{state.status === "narrating" ? "The narration agent is working in T3 Code…" : "The director is preparing changes…"}</p>}
    {state?.error && <p className="rp-error">{state.error}</p>}
    {state && !state.available && !state.threadUrl && <p className="rp-muted">The director connection isn’t configured on this server.</p>}
    {error && <p className="rp-error" role="alert">{error}</p>}
  </section>;
}
