import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Game, PublishPlatform, PublishState, PublishVisibility, VideoPackagingOptions } from "../shared/types";
import { dropThumbOptions, jobsFor, makeThumbnails, useThumbnailOption } from "./render";
import { favourites } from "./director";
import { videoPath } from "./videoFiles";
import { agentDir, games, saveGameNow } from "./store";
import { ActionError, touch } from "./game";
import { CLI, DATA } from "./paths";
import { agentWebhook, orchestratorAvailable, triggerAgent, triggerOrchestrator, WebhookRefused } from "./summon";

/*
 * Posting a game's rendered videos. The platforms' APIs keep an unaudited app's posts private, so
 * instead a publisher agent uploads them the way the user would: in the user's own Brave, already
 * logged in to YouTube Studio and TikTok Studio. The website asks (the click is the user's go-ahead) and
 * starts the publisher in its own T3 thread through the webhook for its model, which reports its posts
 * with the CLI. With no such webhook, the orchestrator's webhook wakes an orchestrator, which delegates the
 * publisher and records its posts.
 */

/** Driving a live browser is Astra's work (see the delegate skill's routing). */
const PUBLISHER = { provider: "codex", model: "gpt-6-astra", effort: "high" };

/** Where the posts go: the publisher checks it's on these before uploading anything. */
const ACCOUNTS = {
  youtube: { name: "Agent Chess", handle: "@AgentChess", channelId: "UC_KWfx33BWK0VnogTyGc3dw" },
  tiktok: { handle: "@agentsplaychess" },
};

/** A request whose publisher hasn't reported back in this long can be made again. */
const STALE_MS = 90 * 60_000;

/**
 * The publishers started in their own thread, by key: which request each is for, and whether it has reported.
 * Local only: games go to the public mirror, so a key is never kept on one.
 */
const KEYS_FILE = path.join(DATA, "publishers.json");
const publishers: Record<string, { gameId: string; attempt: number; reported?: boolean }> = (() => {
  try {
    return existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, "utf8")) : {};
  } catch {
    console.warn("[publish] Could not read publishers.json: earlier publishers' keys are unknown now.");
    return {};
  }
})();
function savePublishers() {
  writeFileSync(`${KEYS_FILE}.tmp`, JSON.stringify(publishers));
  renameSync(`${KEYS_FILE}.tmp`, KEYS_FILE);
}
export const isPublisherKey = (key: string) => key.startsWith("pb-");
const publisherWebhook = () => agentWebhook(PUBLISHER.model, PUBLISHER.effort);

export const PLATFORMS: PublishPlatform[] = ["youtube", "tiktok"];
const NAME: Record<PublishPlatform, string> = { youtube: "YouTube", tiktok: "TikTok" };
/** Each platform's own word for the two visibilities. */
const SHOWN: Record<PublishPlatform, Record<PublishVisibility, string>> = {
  youtube: { public: "Public", test: "Unlisted" },
  tiktok: { public: "Everyone", test: "Only you" },
};

/** The files a platform's post is made from. */
function filesFor(gameId: string, p: PublishPlatform) {
  const yt = p === "youtube";
  return {
    video: videoPath(gameId, yt ? "youtube" : "tiktok"),
    subtitles: videoPath(gameId, yt ? "youtubeSubtitles" : "tiktokSubtitles"),
    thumbnail: videoPath(gameId, yt ? "thumbnail" : "tiktokCover"),
  };
}

/** What stands in the way of posting to a platform (nothing: ready). */
export function missingFor(g: Game, p: PublishPlatform): string[] {
  const f = filesFor(g.id, p);
  const out: string[] = [];
  if (jobsFor(g.id).some((j) => j.status !== "done" && j.status !== "failed")) out.push("a render is still running");
  if (!existsSync(f.video)) out.push(`the ${NAME[p]} video`);
  // The renderer's silent picture, left beside an unfinished render (or one rendering right now).
  else if (existsSync(`${f.video}.video.mp4`)) out.push(`a finished ${NAME[p]} render (the last one didn't finish)`);
  if (!g.video?.packaging) out.push("the director's title and caption");
  if (!existsSync(videoPath(g.id, "uploadText"))) out.push("the upload text (made with the YouTube render)");
  if (p === "youtube" && !existsSync(f.thumbnail)) out.push("the thumbnail (made with the YouTube render)");
  return out;
}

/** What the website shows: the request, its posts, and what each platform still needs. */
export function publishState(g: Game) {
  expireStale(g);
  return {
    publish: g.publish ?? null,
    ready: Object.fromEntries(PLATFORMS.map((p) => [p, missingFor(g, p)])) as Record<PublishPlatform, string[]>,
  };
}

const inFlight = (s: PublishState | undefined) => s?.status === "requested" && Date.now() - s.requestedAt < STALE_MS;

/**
 * Ask for the videos to be posted. A platform already posted as a test is made public by changing that
 * post's visibility, not by posting it again; a public post is never touched again.
 */
export async function requestPublish(g: Game, platforms: PublishPlatform[], visibility: PublishVisibility) {
  if (!platforms.length) throw new Error("Pick YouTube and/or TikTok.");
  if (!publisherWebhook() && !orchestratorAvailable()) throw new Error(`No T3 webhook for the publisher (${PUBLISHER.model}@${PUBLISHER.effort}) or the orchestrator configured (data/webhook.json), so no publisher can be summoned.`);
  expireStale(g);
  if (inFlight(g.publish)) throw new Error("These videos are already being published.");
  for (const p of platforms) {
    const missing = missingFor(g, p);
    if (missing.length) throw new Error(`${NAME[p]} isn't ready: missing ${missing.join(", ")}.`);
    const post = g.publish?.posts[p];
    if (post?.visibility === "public") throw new Error(`It's already public on ${NAME[p]}.`);
    if (post && visibility === "test") throw new Error(`It's already on ${NAME[p]} as a test: publish it publicly to make that post public.`);
  }
  const prev = g.publish;
  g.publish = { platforms, visibility, status: "requested", requestedAt: Date.now(), attempt: (prev?.attempt ?? 0) + 1, posts: prev?.posts ?? {} };
  saveGameNow(g);
  touch(g);
  await summonPublisher(g);
}

/** An orchestrator whose webhook didn't answer is asked this many times more, while it hasn't taken the request. */
const ORCHESTRATOR_RETRIES = 3;

async function summonPublisher(g: Game, tries = 0) {
  const s = g.publish!;
  const url = publisherWebhook();
  try {
    if (url) {
      const key = `pb-${randomBytes(24).toString("hex")}`;
      publishers[key] = { gameId: g.id, attempt: s.attempt };
      savePublishers();
      // Handed out before it's started, so no orchestrator run (and no restart) starts a second one.
      s.handedOutAt = Date.now();
      saveGameNow(g);
      await triggerAgent(url, key);
    } else await triggerOrchestrator({ action: "publish", gameId: g.id });
  } catch (e) {
    // Only this request's own state: a report or a newer request since is left as it is.
    if (g.publish !== s || s.status !== "requested") throw e;
    // An orchestrator run (an earlier ask whose answer was lost) took it meanwhile: it's that run's now.
    if (!(e instanceof WebhookRefused) || (!url && s.handedOutAt)) {
      // A request that timed out or dropped may have started the run all the same: the request stays its
      // own (in flight until it's reported on, or for STALE_MS), so a second publisher can't post too. An
      // orchestrator that hasn't taken it is asked again: only one run is ever handed the publisher.
      console.error(`[publish] ${g.id}: the webhook didn't answer (${(e as Error).message}); it may have started, so the request stays its own`);
      if (!url && tries < ORCHESTRATOR_RETRIES)
        setTimeout(() => {
          if (g.publish === s && s.status === "requested" && !s.handedOutAt) summonPublisher(g, tries + 1).catch(() => {});
        }, 60_000).unref();
      return;
    }
    g.publish = { ...s, status: "failed", errors: Object.fromEntries(s.platforms.map((p) => [p, `Couldn't summon a publisher: ${(e as Error).message}`])) };
    saveGameNow(g);
    touch(g);
    throw e;
  }
}

/**
 * A request nothing reported on in STALE_MS fails, so the page can ask again: a new publisher looks for the
 * posts first. Its own publisher can still report late (same request), which records what it did.
 */
function expireStale(g: Game) {
  const s = g.publish;
  if (s?.status !== "requested" || inFlight(s)) return;
  s.status = "failed";
  s.errors = Object.fromEntries(s.platforms.map((p) => [p, `The publisher hadn't reported back after ${STALE_MS / 60_000} minutes. Check ${NAME[p]} for the post before publishing again.`]));
  saveGameNow(g);
  touch(g);
}

/**
 * At boot: a request whose publisher was never handed out (the server went down before or while summoning the
 * orchestrator) summons one again. The task is handed out once per request, so if the first summon did get
 * through, only one of the two runs can post.
 */
export function resumePublishes(all: Iterable<Game>) {
  for (const g of all) {
    if (!inFlight(g.publish) || g.publish!.handedOutAt) continue;
    console.log(`[publish] ${g.id}: its publisher was never handed out, summoning one again`);
    summonPublisher(g).catch((e) => console.error(`[publish] ${g.id}: ${(e as Error).message}`));
  }
}

/**
 * A command from a publisher started in its own thread: `start` (its thread's title, then its task) and
 * `published` (its report, recorded once).
 */
export function publisherCommand(key: string, cmd: string, body: { results?: unknown }): string {
  const p = publishers[key];
  const g = p && games.get(p.gameId);
  if (!p || !g) throw new ActionError("This publisher key is unknown.");
  const current = g.publish?.attempt === p.attempt;
  // Its request over (reported, replaced, or failed to start): nothing more to do, and DONE lets its thread settle.
  const over = p.reported
    ? "DONE — your report is recorded. Your task is complete."
    : "DONE — this publish request is over, so there's nothing for you to do. If you uploaded or changed anything for it, say so in your final message, with the links.";
  if (cmd === "start" || cmd === "help") {
    expireStale(g);
    if (p.reported || !current || g.publish?.status !== "requested") return over;
    return `📤 Publisher — ${g.id}\n\n${publisherPrompt(g, key)}`;
  }
  if (cmd !== "published") throw new ActionError(`Unknown command: ${cmd}. Yours are start and published <report.json>.`);
  // A request that failed (to start, or by going stale) still takes its own publisher's report: that's what it posted.
  if (p.reported || !current || g.publish!.status === "done") return over;
  const s = recordPublished(g, body.results, p.attempt);
  p.reported = true;
  savePublishers();
  return `DONE — recorded (${s.status === "done" ? "posted" : "with errors"}). Your task is complete: end with a few sentences on what you did on each platform.`;
}

type Report = Partial<Record<PublishPlatform, { url?: string | null; error?: string; note?: string }>>;

/** A report with a post (an http(s) link, or null) or a reason it isn't posted for each platform asked for, or why not. */
function reportProblem(s: PublishState, results: unknown): string | undefined {
  const shape = `{${s.platforms.map((p) => `"${p}": {"url": "https://…" | null, "note"?: "…"} or {"error": "…"}`).join(", ")}}`;
  if (!results || typeof results !== "object" || Array.isArray(results)) return `Send ${shape}.`;
  for (const p of s.platforms) {
    const r = (results as Record<string, any>)[p];
    if (!r || typeof r !== "object") return `${NAME[p]} has no result: send ${shape}.`;
    if (r.note !== undefined && typeof r.note !== "string") return `${NAME[p]}'s note must be text.`;
    if (r.error !== undefined) {
      if (typeof r.error !== "string" || !r.error.trim()) return `${NAME[p]}'s error must say what stopped it.`;
    } else if (!(r.url === null || (typeof r.url === "string" && /^https?:\/\/\S+$/.test(r.url)))) return `${NAME[p]}'s url must be its link (https://…), or null if you couldn't find it.`;
  }
}

/**
 * The publisher's report on request `attempt` (from the publisher itself, or the orchestrator that delegated it):
 * a post (its link) or an error per platform. A report on an earlier request is refused.
 */
export function recordPublished(g: Game, results: unknown, attempt: number) {
  const s = g.publish;
  if (!s) throw new ActionError("Nothing was asked to be published for this game.");
  if (attempt !== s.attempt) throw new ActionError(`That report is for publish request ${attempt}; the current one is ${s.attempt}.`);
  const problem = reportProblem(s, results);
  if (problem) throw new ActionError(problem);
  const report = results as Report;
  const errors: Partial<Record<PublishPlatform, string>> = {};
  for (const p of s.platforms) {
    const r = report[p];
    if (!r) errors[p] = "The publisher didn't report on it.";
    else if (r.error) errors[p] = r.error;
    else s.posts[p] = { url: r.url ?? s.posts[p]?.url ?? null, visibility: s.visibility, at: Date.now(), ...(r.note ? { note: r.note } : {}) };
  }
  s.errors = Object.keys(errors).length ? errors : undefined;
  s.status = s.errors ? "failed" : "done";
  saveGameNow(g);
  touch(g);
  return s;
}

/** Each field's limit on its platform. YouTube refuses titles and descriptions with < or >. */
const LIMITS = { title: 100, description: 5000, caption: 2200 };

/**
 * The user's own wording for the upload, from the video page. Title and caption replace the director's;
 * a description replaces the generated one (chapters included) until it's cleared with an empty one.
 */
export function editUploadText(g: Game, edits: { title?: unknown; description?: unknown; caption?: unknown }) {
  const pk = g.video?.packaging;
  if (!pk) throw new Error("There's no director's title and caption to edit yet.");
  if (inFlight(g.publish)) throw new Error("A publisher is posting these videos right now: edit after it reports back.");
  const field = (key: keyof typeof LIMITS, required: boolean) => {
    const v = edits[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`${key} must be text.`);
    const s = v.trim();
    if (required && !s) throw new Error(`The ${key} can't be empty.`);
    if (s.length > LIMITS[key]) throw new Error(`The ${key} is ${s.length} characters; the limit is ${LIMITS[key]}.`);
    if (key !== "caption" && /[<>]/.test(s)) throw new Error(`YouTube doesn't allow < or > in the ${key}.`);
    return s;
  };
  const title = field("title", true);
  const caption = field("caption", true);
  const description = field("description", false);
  if (title !== undefined) pk.title = title;
  if (caption !== undefined) pk.caption = caption;
  if (description !== undefined) {
    if (description) pk.description = description;
    else delete pk.description;
  }
  saveGameNow(g);
  touch(g);
}

/**
 * The director's new titles, captions and thumbnails: its favourites replace the picks (the user's own
 * description stays), unless a publisher is posting right now, and their thumbnails are made.
 */
export function setPackagingOptions(g: Game, options: VideoPackagingOptions) {
  const v = g.video;
  if (!v) throw new Error("The game has no video plan yet.");
  v.packagingOptions = options;
  v.packagingRedos = (v.packagingRedos ?? 0) + 1;
  delete g.packagingSummonedAt;
  if (!inFlight(g.publish)) v.packaging = { ...favourites(options), ...(v.packaging?.description && { description: v.packaging.description }) };
  saveGameNow(g);
  touch(g);
  dropThumbOptions(g.id);
  makeThumbnails(g.id);
}

/** The user's pick from the director's options: { title?, caption?, thumbnail? }, each an option's index. */
export function pickPackaging(g: Game, picks: { title?: unknown; caption?: unknown; thumbnail?: unknown }) {
  const o = g.video?.packagingOptions;
  const pk = g.video?.packaging;
  if (!o || !pk) throw new Error("The director hasn't given options to pick from.");
  if (inFlight(g.publish)) throw new Error("A publisher is posting these videos right now: pick after it reports back.");
  const index = (key: "title" | "caption" | "thumbnail", count: number) => {
    const n = picks[key];
    if (n === undefined) return undefined;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n >= count) throw new Error(`${key} must be an option's number, 0–${count - 1}.`);
    return n;
  };
  const title = index("title", o.titles.length);
  const caption = index("caption", o.captions.length);
  const thumbnail = index("thumbnail", o.thumbnails.length);
  if (title !== undefined) pk.title = o.titles[title];
  if (caption !== undefined) pk.caption = o.captions[caption];
  if (thumbnail !== undefined) {
    pk.thumbnail = { ...o.thumbnails[thumbnail] };
    useThumbnailOption(g.id, thumbnail);
  }
  saveGameNow(g);
  touch(g);
}

/* ------------------------------ the publisher's brief ------------------------------ */

/** The upload text's parts (scripts/render-video.mjs writes it with the YouTube render), the user's description first. */
function uploadText(g: Game) {
  const txt = readFileSync(videoPath(g.id, "uploadText"), "utf8");
  return {
    description: g.video?.packaging?.description ?? txt.split("DESCRIPTION:\n")[1]?.trim() ?? "",
    tags: txt.match(/^TAGS: (.*)$/m)?.[1]?.trim() ?? "",
  };
}

/** A block of exact text, fenced so the publisher copies it as it is. */
const exact = (s: string) => `\`\`\`text\n${s}\n\`\`\``;

function youtubeSteps(g: Game, s: PublishState): string {
  const f = filesFor(g.id, "youtube");
  const shown = SHOWN.youtube[s.visibility];
  const post = s.posts.youtube;
  if (post)
    return `### YouTube: make the existing post ${shown}
It was posted earlier as ${SHOWN.youtube[post.visibility]}${post.url ? ` (${post.url})` : ""}. Find that video in YouTube Studio → Content, change only its visibility to **${shown}**, save, and check the change took.`;
  const { description, tags } = uploadText(g);
  return `### YouTube: upload
In YouTube Studio (channel ${ACCOUNTS.youtube.name}), Create → Upload videos, and select:
- Video: \`${f.video}\`

Then fill in:
- **Title:**
${exact(g.video!.packaging!.title)}
- **Description**, exactly this, with its line breaks (the timestamps at the end become chapters):
${exact(description)}
- **Thumbnail:** upload \`${f.thumbnail}\`.
- **Audience:** "No, it's not made for kids".
- **Show more → Tags:** ${tags || "(none)"}
- **Show more → Language:** English (subtitles need it). **Category:** People & Blogs, like the channel's other videos. Leave the rest of "Show more" (altered content, paid promotion, comments, licence, remixing) as it comes.
${existsSync(f.subtitles) ? `- **Video elements → Add subtitles:** English, Upload file → "With timing" → \`${f.subtitles}\`, then Publish it (subtitles' own Publish/Done button).\n` : ""}- Skip end screens and cards.
- **Visibility:** **${shown}**. Not scheduled.

Before pressing the final Publish/Save button, go back over every field above. Wait for the upload to reach "Checks complete" (or "Processing"; you needn't wait for HD), then publish. Get the video's link (youtu.be/… or youtube.com/shorts/…) from the dialog that follows or from Content.`;
}

function tiktokSteps(g: Game, s: PublishState): string {
  const f = filesFor(g.id, "tiktok");
  const shown = SHOWN.tiktok[s.visibility];
  const post = s.posts.tiktok;
  if (post)
    return `### TikTok: make the existing post visible to ${shown}
It was posted earlier with "Who can watch" set to ${SHOWN.tiktok[post.visibility]}${post.url ? ` (${post.url})` : ""}. In TikTok Studio → Posts find it, change only its privacy to **${shown}**, and check the change took.`;
  // The account's covers are all the short's versus card (Agent Chess, the two models, VS).
  const cover = existsSync(f.thumbnail)
    ? `the versus card, like the account's other posts. Upload the image \`${f.thumbnail}\` (a still of that card from this video) as the cover if the cover editor allows uploading an image; otherwise pick the frame where the versus card is fully shown (early in the video, right after the cold open's "rewind"). Say in your report which way you did it.`
    : `the versus card, like the account's other posts: pick the frame where it's fully shown (early in the video, right after the cold open's "rewind"). Say in your report which frame (its time) you picked.`;
  return `### TikTok: upload
In TikTok Studio (https://www.tiktok.com/tiktokstudio/upload) as ${ACCOUNTS.tiktok.handle}, select:
- Video: \`${f.video}\`

Then fill in:
- **Description**, exactly this text. Typing a hashtag opens a suggestion list: close it with Escape or a space so the tag stays as written, not a suggestion:
${exact(g.video!.packaging!.caption)}
- **Cover:** ${cover}
- **Who can watch this video:** **${shown}**.
- Leave comments, Duet, Stitch, "Disclose post content" and "AI-generated content" as they come (the account's other posts carry no labels).
- Not scheduled.
${existsSync(f.subtitles) ? `- Subtitles: TikTok's web uploader can't take a subtitle file as far as we know. If it has a way to upload \`${f.subtitles}\`, use it. Otherwise leave captions to TikTok and mention it in your report.\n` : ""}
Before pressing Post, go back over every field above. After posting, find the post in TikTok Studio → Posts (it may show as processing) and get its link (https://www.tiktok.com/${ACCOUNTS.tiktok.handle}/video/…).`;
}

/** The publisher's task. One started in its own thread (with its `key`) records its report with the CLI; a delegated one ends with it. */
function publisherPrompt(g: Game, key?: string): string {
  const s = g.publish!;
  const title = g.video?.packaging?.title ?? g.id;
  const steps = s.platforms.map((p) => (p === "youtube" ? youtubeSteps(g, s) : tiktokSteps(g, s))).join("\n\n");
  const keys = s.platforms.map((p) => `"${p}"`).join(" and ");
  return `You are the publisher for Agent Chess, a site where AI models play chess and their games are made into replay videos. The user has asked for game ${g.id}'s videos to be posted ("${title}"). Do it the way they would by hand: in **their own Brave browser**, through your browser-control tooling (the browser with family "brave", connected by the extension). Do not use any other browser or a fresh profile: Brave is where they're logged in.

## Accounts
${s.platforms.includes("youtube") ? `- YouTube: the channel **${ACCOUNTS.youtube.name}** (${ACCOUNTS.youtube.handle}, channel ID ${ACCOUNTS.youtube.channelId}). Before anything else, note which channel YouTube Studio is on. If it's another one, switch with the avatar menu → Switch account → ${ACCOUNTS.youtube.name}, choosing only an account that's already signed in, and confirm the channel ID. When you're finished, even after a failure, switch back to the channel you found and confirm it.\n` : ""}${s.platforms.includes("tiktok") ? `- TikTok: **${ACCOUNTS.tiktok.handle}**. Check that's the account TikTok Studio is on; if not, stop and report it (don't switch or sign in).\n` : ""}
## Never post twice
This may be a retry. Before uploading anywhere, look at the account's existing posts (YouTube Studio → Content; TikTok Studio → Posts) for this video: the YouTube title above, or the TikTok description's first words. If it's already there, don't upload it again: check its settings match the steps below, fix any that don't, and report that post. If you can't tell whether a Publish or Post went through, check the posts list; never press it again on a guess.

${steps}

## Rules
- Work in new tabs and close only those. Don't touch other posts, drafts or channel settings. TikTok Studio may offer to resume an unfinished draft: leave it as it is (neither resume nor discard it) and start a new upload. If it forces you to choose, stop and report it.
- If a login, password, 2-step check or CAPTCHA appears, stop on that platform and report it as blocked: never enter credentials, and don't solve or work around CAPTCHAs.
- The pages change from time to time: find each control by what it says and does, not by where it used to be. If a field above doesn't exist any more, do the nearest equivalent and say what you did.
- Don't print or save cookies or tokens.

## Report
${
    key
      ? `When you're finished on every platform (or stopped), write your report as JSON (keys ${keys} only) to a file in ${agentDir(g.id, "p")}, like this:
{"youtube":{"url":"https://…","note":"…"},"tiktok":{"error":"what stopped it"}}
and record it, once: node "${CLI}" published <report.json> --key ${key}
It prints DONE once it's recorded; if it says the JSON is wrong, fix it and run it again.`
      : `End your final message with exactly one line in this form (valid JSON, keys ${keys} only):
PUBLISH_RESULT {"youtube":{"url":"https://…","note":"…"},"tiktok":{"error":"what stopped it"}}`
  }
For each platform: "url" when it's posted (null if the post exists but you couldn't find its link), or "error" when it isn't. "note" is optional: anything the user should know, such as a field you couldn't set or the cover frame you picked. ${key ? "Then, in your final message" : "Before that line"}, say in a few sentences what you did on each platform.${
    s.visibility === "test"
      ? " This is a test post, to check the process before posts go public: also list the settings each upload page offered that these steps don't mention, and anything that was slow, confusing or fragile, so the steps can be improved."
      : ""
  }`;
}

/**
 * The publisher task for the orchestrator to delegate (one per request: a retry is a new task). `handOut`
 * gives it to one run only: another run asking for the same request gets an error, so it can't post twice.
 */
export function publishLaunch(g: Game, handOut = false) {
  expireStale(g);
  if (g.publish?.status !== "requested") throw new Error("Nothing is waiting to be published for this game.");
  if (handOut) {
    if (g.publish.handedOutAt) throw new Error("This request's publisher was already handed to another orchestrator run.");
    g.publish.handedOutAt = Date.now();
    saveGameNow(g);
  }
  return {
    gameId: g.id,
    tasks: [
      {
        role: "publisher",
        title: `📤 Publisher — ${g.id}`,
        clientRequestId: `${g.id}-publish${g.publish.attempt}`,
        target: { providerInstanceId: PUBLISHER.provider, model: PUBLISHER.model, options: { reasoningEffort: PUBLISHER.effort } },
        prompt: publisherPrompt(g),
      },
    ],
  };
}
