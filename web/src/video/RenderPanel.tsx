import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Format = "landscape" | "portrait";

interface RenderJob {
  id: string;
  formats: Format[];
  status: "waiting-director" | "queued" | "rendering" | "done" | "failed";
  stage: string;
  progress: number;
  format?: Format;
  error?: string;
  note?: string;
}

interface RenderState {
  jobs: RenderJob[];
  videos: { kind: "youtube" | "tiktok"; url: string; bytes: number; at: number }[];
  music: string[];
  directed: boolean;
  summonAvailable: boolean;
}

const FORMAT_LABEL: Record<Format, string> = { landscape: "YouTube 16:9", portrait: "TikTok 9:16" };
const active = (j: RenderJob) => j.status !== "done" && j.status !== "failed";

/** Render the replay to MP4 from the site: pick formats and music, follow progress, download. */
export function RenderPanel({ gameId, onPlan }: { gameId: string; onPlan: () => void }) {
  const [state, setState] = useState<RenderState | null>(null);
  const [formats, setFormats] = useState<Format[]>(["landscape", "portrait"]);
  const [music, setMusic] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const wasDirected = useRef<boolean | null>(null);

  const load = () =>
    api<RenderState>(`/api/games/${gameId}/render`)
      .then((s) => {
        setState(s);
        // The director just delivered its plan: the preview should show the new picks.
        if (wasDirected.current === false && s.directed) onPlan();
        wasDirected.current = s.directed;
      })
      .catch((e) => setError(e.message));

  const job = state?.jobs.at(-1);
  const busy = !!job && active(job);
  useEffect(() => {
    load();
    const timer = setInterval(load, busy ? 1500 : 10_000);
    return () => clearInterval(timer);
  }, [gameId, busy]);

  const render = async () => {
    setError("");
    try {
      setState(await api<RenderState>(`/api/games/${gameId}/render`, { formats, music: music || null }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const upload = async (f: File) => {
    setUploading(true);
    setError("");
    try {
      const r = await fetch("/api/music", { method: "POST", headers: { "x-filename": encodeURIComponent(f.name) }, body: f });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? r.statusText);
      setMusic(data.name);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const toggle = (f: Format) => setFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));

  return (
    <div className="render-panel">
      <h3>🎬 Render MP4</h3>

      <div className="rp-row">
        {state?.directed ? (
          <span className="rp-ok">✓ The director picked the key moments</span>
        ) : state?.summonAvailable ? (
          <span className="rp-muted">No director's plan yet: rendering summons one first (a few minutes).</span>
        ) : (
          <span className="rp-muted">No director's plan; the key moments come from the engine's verdicts.</span>
        )}
      </div>

      <div className="rp-row rp-formats">
        {(["landscape", "portrait"] as Format[]).map((f) => (
          <label key={f}>
            <input type="checkbox" checked={formats.includes(f)} onChange={() => toggle(f)} disabled={busy} /> {FORMAT_LABEL[f]}
          </label>
        ))}
      </div>

      <div className="rp-row">
        <label className="rp-label">Music</label>
        <select value={music} onChange={(e) => setMusic(e.target.value)} disabled={busy}>
          <option value="">None</option>
          {state?.music.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button className="rp-small" onClick={() => file.current?.click()} disabled={busy || uploading}>
          {uploading ? "Uploading…" : "Upload…"}
        </button>
        <input ref={file} type="file" accept="audio/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      <button className="rp-go" onClick={render} disabled={busy || !formats.length}>
        {busy ? "Rendering…" : "Render"}
      </button>

      {job && (
        <div className={`rp-job ${job.status}`}>
          <div className="rp-stage">{job.stage}</div>
          {job.status === "rendering" && (
            <div className="rp-bar">
              <i style={{ width: `${job.progress}%` }} />
            </div>
          )}
          {job.note && <div className="rp-muted">{job.note}</div>}
          {job.error && <pre className="rp-error">{job.error}</pre>}
        </div>
      )}
      {error && <div className="rp-error">{error}</div>}

      {!!state?.videos.length && (
        <div className="rp-videos">
          {state.videos.map((v) => (
            <div key={v.kind} className="rp-video">
              <span>
                {v.kind === "youtube" ? "YouTube" : "TikTok"} · {(v.bytes / 1e6).toFixed(1)} MB · {new Date(v.at).toLocaleString()}
              </span>
              <a className="rp-small" href={`${v.url}?t=${Math.round(v.at)}`} download>
                Download
              </a>
            </div>
          ))}
          <button className="rp-small" onClick={() => api(`/api/games/${gameId}/videos/open`, {})}>
            Show in folder
          </button>
        </div>
      )}
    </div>
  );
}
