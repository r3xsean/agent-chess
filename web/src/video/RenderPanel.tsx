import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { VideoPackaging } from "../../../shared/types";

/** A labelled block of text with a copy button. */
function Copyable({ label, text, multiline }: { label: string; text: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  return (
    <div className="rp-copy">
      <div className="rp-copy-head">
        <span className="rp-label">{label}</span>
        <button className="rp-small" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {multiline ? <pre className="rp-copy-text">{text}</pre> : <div className="rp-copy-text">{text}</div>}
    </div>
  );
}

/** The upload text minus its TITLE/CAPTION lines: just what goes in YouTube's description box. */
const descriptionBody = (d: string) => d.split("DESCRIPTION:\n")[1]?.trim() ?? d.trim();

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
  /** The director's title, caption and thumbnail pick; the rendered upload text and thumbnail image. */
  packaging: VideoPackaging | null;
  description: string | null;
  thumbUrl: string | null;
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
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const wasDirected = useRef<boolean | null>(null);
  /** Jobs seen running (by this panel, or started from it), and finished jobs already acted on. */
  const watched = useRef(new Set<string>());
  const handled = useRef(new Set<string>());

  /**
   * A new state from the server. When the director has just delivered its plan, or a job this panel
   * watched has ended (voices recorded, or the attempt stopped, which can rewrite the voice manifest
   * either way), the preview reloads to show and say the current version.
   */
  const take = (s: RenderState) => {
    setState(s);
    const last = s.jobs.at(-1);
    if (last && active(last)) watched.current.add(last.id);
    const ended = !!last && !active(last) && watched.current.has(last.id) && !handled.current.has(last.id);
    if (ended) handled.current.add(last!.id);
    if ((wasDirected.current === false && s.directed) || ended) onPlan();
    wasDirected.current = s.directed;
  };

  const load = () =>
    api<RenderState>(`/api/games/${gameId}/render`)
      .then(take)
      .catch((e) => setError(e.message));

  const job = state?.jobs.at(-1);
  const busy = !!job && active(job);
  useEffect(() => {
    load();
    const timer = setInterval(load, busy ? 1500 : 10_000);
    return () => clearInterval(timer);
  }, [gameId, busy]);

  /** `redirect`: a new director makes a new plan first (the current one is thrown away). */
  const render = async (redirect = false) => {
    setError("");
    if (
      redirect &&
      !confirm(
        "Throw away the director's plan and summon a new director? It picks new moments and quotes, so new voice lines get recorded. If no director answers, the current plan is kept.",
      )
    )
      return;
    try {
      const s = await api<RenderState>(`/api/games/${gameId}/render`, { formats, music: music || null, voices: !silent, redirect });
      // The job this click started counts as watched even if it already ended (a fast failure).
      const last = s.jobs.at(-1);
      if (last) watched.current.add(last.id);
      take(s);
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

      <div className="rp-row rp-formats">
        <label title="The players' lines in their own voices are recorded (or reused) before the render. Tick this for a version without them.">
          <input type="checkbox" checked={silent} onChange={(e) => setSilent(e.target.checked)} disabled={busy} /> Without voices
        </label>
      </div>

      <button className="rp-go" onClick={() => render()} disabled={busy || !formats.length}>
        {busy ? "Rendering…" : state?.videos.length ? "Render again (same plan)" : "Render"}
      </button>
      {/* The whole process again from the director's plan: to re-cut a video, or get a plan with newer features. */}
      {state?.directed && state.summonAvailable && (
        <button className="rp-redo" onClick={() => render(true)} disabled={busy || !formats.length}>
          {state.videos.length ? "Re-render from scratch (new director)" : "Redo the director, then render"}
        </button>
      )}

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

      {state?.packaging && (
        <div className="rp-packaging">
          <h3>📦 For the upload</h3>
          <Copyable label="YouTube title" text={state.packaging.title} />
          {state.description && <Copyable label="YouTube description" text={descriptionBody(state.description)} multiline />}
          <Copyable label="TikTok caption" text={state.packaging.caption} />
          {state.thumbUrl ? (
            <div className="rp-copy">
              <div className="rp-copy-head">
                <span className="rp-label">Thumbnail</span>
                <a className="rp-small" href={state.thumbUrl} download={`${gameId}-thumb.png`}>
                  Download
                </a>
              </div>
              <img className="rp-thumb" src={state.thumbUrl} alt="YouTube thumbnail" />
            </div>
          ) : (
            <div className="rp-muted">The thumbnail and chapters are made with the YouTube render.</div>
          )}
        </div>
      )}
    </div>
  );
}
