import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { PublishPlatform, PublishState, PublishVisibility, VideoPackaging, VideoPackagingOptions } from "../../../shared/types";

const PLATFORMS: PublishPlatform[] = ["youtube", "tiktok"];

/**
 * A labelled block of text with copy and edit buttons. `onSave` stores an edit (rejecting with the
 * reason it can't); `onReset`, when given, offers to go back to the generated text.
 */
function EditableText({
  label,
  text,
  limit,
  multiline,
  locked,
  onSave,
  onReset,
}: {
  label: string;
  text: string;
  limit: number;
  multiline?: boolean;
  /** Why it can't be edited right now. */
  locked?: string;
  onSave: (text: string) => Promise<void>;
  onReset?: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  const run = async (f: () => Promise<void>) => {
    setSaving(true);
    setError("");
    try {
      await f();
      setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const save = () => run(() => (draft!.trim() === text.trim() ? Promise.resolve() : onSave(draft!)));
  const reset = () => onReset && confirm(`Throw away your ${label.toLowerCase()} and go back to the generated one?`) && run(onReset);

  if (draft !== null) {
    const over = draft.trim().length > limit;
    return (
      <div className="rp-copy">
        <div className="rp-copy-head">
          <span className="rp-label">{label}</span>
          <span className={over ? "rp-error" : "rp-muted"}>
            {draft.trim().length}/{limit}
          </span>
        </div>
        {multiline ? (
          <textarea className="rp-copy-text rp-edit" rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={saving} autoFocus />
        ) : (
          <input
            className="rp-copy-text rp-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" && setDraft(null))}
            disabled={saving}
            autoFocus
          />
        )}
        <div className="rp-row">
          <button className="rp-small" onClick={save} disabled={saving || over || (!onReset && !draft.trim())}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="rp-small" onClick={() => (setDraft(null), setError(""))} disabled={saving}>
            Cancel
          </button>
        </div>
        {error && <div className="rp-error">{error}</div>}
      </div>
    );
  }
  return (
    <div className="rp-copy">
      <div className="rp-copy-head">
        <span className="rp-label">{label}</span>
        <span className="rp-row">
          {onReset && (
            <button className="rp-small" onClick={reset} disabled={saving || !!locked} title="Your edit is in use: go back to the generated text">
              Use generated
            </button>
          )}
          <button className="rp-small" onClick={() => setDraft(text)} disabled={!!locked} title={locked}>
            Edit
          </button>
          <button className="rp-small" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      {multiline ? <pre className="rp-copy-text">{text}</pre> : <div className="rp-copy-text">{text}</div>}
      {error && <div className="rp-error">{error}</div>}
    </div>
  );
}

/** The upload text minus its TITLE/CAPTION/TAGS lines: just what goes in YouTube's description box. */
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
  /** Only the thumbnails and upload text. */
  packageOnly?: boolean;
}

interface RenderState {
  jobs: RenderJob[];
  videos: { kind: "youtube" | "tiktok"; url: string; bytes: number; at: number }[];
  /** The title, caption and thumbnail in use; the rendered upload text and thumbnail image. */
  packaging: VideoPackaging | null;
  /** The director's options to pick from, its favourite first, and each thumbnail option's image (null: not made yet). */
  packagingOptions: VideoPackagingOptions | null;
  thumbOptionUrls: (string | null)[];
  description: string | null;
  thumbUrl: string | null;
  music: string[];
  directed: boolean;
  summonAvailable: boolean;
  /** The last request to post the videos, and what each platform still needs before it can be posted. */
  publish: PublishState | null;
  ready: Record<PublishPlatform, string[]>;
}

const PLATFORM_LABEL: Record<PublishPlatform, string> = { youtube: "YouTube", tiktok: "TikTok" };

type Pick = { title?: number; caption?: number; thumbnail?: number };

/**
 * The director's titles, captions and thumbnails side by side, its favourite first: clicking one uses it
 * for the upload (the fields below show what's in use, and can still be reworded by hand).
 */
function PackagingPicker({ state, locked, onPick }: { state: RenderState; locked?: string; onPick: (p: Pick) => Promise<void> }) {
  const o = state.packagingOptions!;
  const pk = state.packaging!;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const choose = async (p: Pick) => {
    setSaving(true);
    setError("");
    try {
      await onPick(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const texts = (label: string, key: "title" | "caption", list: string[], current: string) => (
    <div className="rp-pick">
      <span className="rp-label">{label}</span>
      {list.map((t, n) => (
        <button key={n} className={`rp-pick-text${t === current ? " on" : ""}`} onClick={() => t !== current && choose({ [key]: n })} disabled={saving || !!locked} title={locked}>
          <span className="rp-pick-n">{n + 1}</span>
          <span>{t}</span>
          {n === 0 && <span className="rp-pick-fav">director's favourite</span>}
        </button>
      ))}
    </div>
  );
  const isThumb = (t: { ply: number; text: string }) => t.ply === pk.thumbnail.ply && t.text === pk.thumbnail.text;
  return (
    <div className="rp-picker">
      <div className="rp-muted">The director's options, its favourite first. Click one to use it; until you do, the favourites are used.</div>
      {texts("YouTube title", "title", o.titles, pk.title)}
      {texts("TikTok caption", "caption", o.captions, pk.caption)}
      <div className="rp-pick">
        <span className="rp-label">Thumbnail</span>
        <div className="rp-pick-thumbs">
          {o.thumbnails.map((t, n) => (
            <button key={n} className={`rp-pick-thumb${isThumb(t) ? " on" : ""}`} onClick={() => !isThumb(t) && choose({ thumbnail: n })} disabled={saving || !!locked} title={locked ?? `"${t.text}", after ply ${t.ply}`}>
              {state.thumbOptionUrls[n] ? <img src={state.thumbOptionUrls[n]!} alt={t.text} /> : <span className="rp-pick-thumb-wait">{t.text}<br /><small>ply {t.ply}: picture not made yet</small></span>}
              <span className="rp-pick-n">{n + 1}</span>
            </button>
          ))}
        </div>
      </div>
      {error && <div className="rp-error">{error}</div>}
    </div>
  );
}

/**
 * Post the videos from the user's own browser: the click summons a publisher agent (through the T3
 * webhook), which uploads in YouTube Studio and TikTok Studio and reports each post's link.
 */
function PublishPanel({ gameId, state, onState }: { gameId: string; state: RenderState; onState: (s: RenderState) => void }) {
  const s = state.publish;
  const posts = s?.posts ?? {};
  const open = (p: PublishPlatform) => posts[p]?.visibility !== "public";
  const [platforms, setPlatforms] = useState<PublishPlatform[]>(["youtube", "tiktok"]);
  const [visibility, setVisibility] = useState<PublishVisibility>("test");
  const [error, setError] = useState("");
  const working = s?.status === "requested";
  // A platform posted as a test can only go public (by changing that post), and a public one is done.
  const can = (p: PublishPlatform) => open(p) && !state.ready[p].length && !(posts[p] && visibility === "test");
  const chosen = platforms.filter(can);

  const publish = async () => {
    setError("");
    const where = chosen.map((p) => PLATFORM_LABEL[p]).join(" and ");
    const how = visibility === "public" ? "publicly" : "as a test (YouTube unlisted, TikTok only you)";
    if (!confirm(`Post this video to ${where} ${how}? A publisher agent uploads it in your Brave browser.`)) return;
    try {
      onState(await api<RenderState>(`/api/games/${gameId}/publish`, { platforms: chosen, visibility }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="rp-publish">
      <h3>📤 Publish</h3>
      {PLATFORMS.map((p) => {
        const post = posts[p];
        return (
          <div key={p} className="rp-row rp-formats">
            <label>
              <input
                type="checkbox"
                checked={platforms.includes(p) && can(p)}
                disabled={working || !can(p)}
                onChange={() => setPlatforms((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]))}
              />{" "}
              {PLATFORM_LABEL[p]}
            </label>
            {post ? (
              <span className="rp-ok">
                ✓ {post.visibility === "public" ? "Public" : "Test post"}
                {post.url && (
                  <>
                    {" · "}
                    <a href={post.url} target="_blank" rel="noreferrer">
                      open
                    </a>
                  </>
                )}
              </span>
            ) : state.ready[p].length ? (
              <span className="rp-muted">Needs {state.ready[p].join(", ")}</span>
            ) : null}
          </div>
        );
      })}
      <div className="rp-row">
        <label className="rp-label">Visibility</label>
        <select value={visibility} onChange={(e) => setVisibility(e.target.value as PublishVisibility)} disabled={working}>
          <option value="test">Test: YouTube unlisted, TikTok only you</option>
          <option value="public">Public</option>
        </select>
      </div>
      <button className="rp-go" onClick={publish} disabled={working || !chosen.length || !state.summonAvailable}>
        {working ? "Publishing…" : visibility === "public" && chosen.some((p) => posts[p]) ? "Make public" : "Publish"}
      </button>
      {!state.summonAvailable && <div className="rp-muted">Publishing needs the T3 webhook (data/webhook.json).</div>}
      {working && <div className="rp-muted">A publisher is uploading in your Brave browser. This takes a few minutes.</div>}
      {s?.errors &&
        Object.entries(s.errors).map(([p, e]) => (
          <div key={p} className="rp-error">
            {PLATFORM_LABEL[p as PublishPlatform]}: {e}
          </div>
        ))}
      {Object.entries(posts).map(([p, post]) =>
        post?.note ? (
          <div key={p} className="rp-muted">
            {PLATFORM_LABEL[p as PublishPlatform]}: {post.note}
          </div>
        ) : null,
      )}
      {error && <div className="rp-error">{error}</div>}
    </div>
  );
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

  /** Store an edit to the upload text (the publisher posts with it); throws the server's reason it can't. */
  const editText = async (edits: { title?: string; description?: string; caption?: string }) => take(await api<RenderState>(`/api/games/${gameId}/upload-text`, edits));
  const editLock = state?.publish?.status === "requested" ? "A publisher is posting these videos right now" : undefined;
  /** Use one of the director's options; throws the server's reason it can't. */
  const pick = async (picks: Pick) => take(await api<RenderState>(`/api/games/${gameId}/packaging/pick`, picks));

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
        {busy ? (job!.packageOnly ? "Making the thumbnails…" : "Rendering…") : state?.videos.length ? "Render again (same plan)" : "Render"}
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
          {state.packagingOptions && <PackagingPicker state={state} locked={editLock} onPick={pick} />}
          <EditableText label="YouTube title" text={state.packaging.title} limit={100} locked={editLock} onSave={(t) => editText({ title: t })} />
          {(state.packaging.description ?? state.description) && (
            <EditableText
              label="YouTube description"
              text={state.packaging.description ?? descriptionBody(state.description!)}
              limit={5000}
              multiline
              locked={editLock}
              onSave={(t) => editText({ description: t })}
              onReset={state.packaging.description && state.description ? () => editText({ description: "" }) : undefined}
            />
          )}
          <EditableText label="TikTok caption" text={state.packaging.caption} limit={2200} multiline locked={editLock} onSave={(t) => editText({ caption: t })} />
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

      {state?.packaging && !!state.videos.length && <PublishPanel gameId={gameId} state={state} onState={take} />}
    </div>
  );
}
