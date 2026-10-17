import { existsSync, readFileSync } from "node:fs";
import type { Game, PublishPlatform, PublishState, PublishVisibility } from "../shared/types";
import { jobsFor } from "./render";
import { videoPath } from "./videoFiles";
import { saveGameNow } from "./store";
import { touch } from "./game";
import { summonAvailable, triggerOrchestrator } from "./summon";

/*
 * Posting a game's rendered videos. The platforms' APIs keep an unaudited app's posts private, so
 * instead a publisher agent uploads them the way the user would: in the user's own Brave, already
 * logged in to YouTube Studio and TikTok Studio. The website asks (the click is the user's go-ahead),
 * the T3 webhook wakes an orchestrator, the orchestrator delegates the publisher and records its posts.
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
  if (!summonAvailable()) throw new Error("No T3 webhook configured (data/webhook.json), so no publisher can be summoned.");
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
  try {
    await triggerOrchestrator({ action: "publish", gameId: g.id });
  } catch (e) {
    g.publish = { ...g.publish, status: "failed", errors: Object.fromEntries(platforms.map((p) => [p, `Couldn't summon a publisher: ${(e as Error).message}`])) };
    saveGameNow(g);
    touch(g);
    throw e;
  }
}

/** The publisher's report, recorded by the orchestrator: a post (its link) or an error per platform. */
export function recordPublished(g: Game, results: Partial<Record<PublishPlatform, { url?: string | null; error?: string; note?: string }>>) {
  const s = g.publish;
  if (!s) throw new Error("Nothing was asked to be published for this game.");
  const errors: Partial<Record<PublishPlatform, string>> = {};
  for (const p of s.platforms) {
    const r = results[p];
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

/* ------------------------------ the publisher's brief ------------------------------ */

/** The upload text's parts (scripts/render-video.mjs writes it with the YouTube render). */
function uploadText(gameId: string) {
  const txt = readFileSync(videoPath(gameId, "uploadText"), "utf8");
  return {
    description: txt.split("DESCRIPTION:\n")[1]?.trim() ?? "",
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
  const { description, tags } = uploadText(g.id);
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

function publisherPrompt(g: Game): string {
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
End your final message with exactly one line in this form (valid JSON, keys ${keys} only):
PUBLISH_RESULT {"youtube":{"url":"https://…","note":"…"},"tiktok":{"error":"what stopped it"}}
For each platform: "url" when it's posted (null if the post exists but you couldn't find its link), or "error" when it isn't. "note" is optional: anything the user should know, such as a field you couldn't set or the cover frame you picked. Before that line, say in a few sentences what you did on each platform.${
    s.visibility === "test"
      ? " This is a test post, to check the process before posts go public: also list the settings each upload page offered that these steps don't mention, and anything that was slow, confusing or fragile, so the steps can be improved."
      : ""
  }`;
}

/** The publisher task for the orchestrator to delegate (one per request: a retry is a new task). */
export function publishLaunch(g: Game) {
  if (g.publish?.status !== "requested") throw new Error("Nothing is waiting to be published for this game.");
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
