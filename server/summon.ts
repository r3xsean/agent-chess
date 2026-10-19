import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { DATA } from "./paths";
import type { OrchestratorAction } from "./orchestrator";

/**
 * The T3 webhooks. A T3 webhook always runs on the model and effort of the thread that made it, so there is
 * one per model and effort an agent plays on (`agents`, keyed "<model>@<effort>"): each run is that agent,
 * in its own thread. The orchestrator's webhook (`url`) launches the seats no agent webhook covers, with
 * $delegate. Their URLs are credentials, so they live only in data/webhook.json (git-ignored), with the
 * `secret` every request is signed with (T3 checks the signature, so a URL alone can't start a run).
 */
interface Webhooks {
  url?: string;
  secret?: string;
  agents?: Record<string, string>;
}

function webhooks(): Webhooks {
  const f = path.join(DATA, "webhook.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

export const comboOf = (model: string, effort: string) => `${model}@${effort}`;

/** The webhook that starts an agent on this model and effort, if one is set up. */
export const agentWebhook = (model: string, effort: string): string | undefined => webhooks().agents?.[comboOf(model, effort)];

export const orchestratorAvailable = () => !!webhooks().url;
/** Whether anything can be summoned at all: the orchestrator, or an agent directly. */
export const summonAvailable = () => orchestratorAvailable() || Object.keys(webhooks().agents ?? {}).length > 0;

/** The header T3 checks: HMAC-SHA256 of the raw body, hex, after "sha256=". */
export const SIGNATURE_HEADER = "x-agent-chess-signature";

/** POST to a webhook; T3 answers with the delivery's id. */
async function post(url: string, body: object): Promise<string | undefined> {
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = webhooks().secret;
  if (secret) headers[SIGNATURE_HEADER] = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const r = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`T3 webhook answered ${r.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text).deliveryId;
  } catch {
    return undefined;
  }
}

export async function triggerOrchestrator(body: { action: OrchestratorAction; gameId?: string; tournamentId?: string }) {
  const url = webhooks().url;
  if (!url) throw new Error("No T3 orchestrator webhook configured (data/webhook.json).");
  await post(url, { gameId: "", tournamentId: "", ...body });
  console.log(`[summon] ${body.action} ${body.gameId ?? body.tournamentId ?? ""}`);
}

/** Start one agent in its own thread: it only gets its seat key, and asks the server for its task with it. Returns the delivery's id. */
export async function triggerAgent(url: string, key: string) {
  const delivery = await post(url, { key });
  console.log(`[summon] agent ${key.replace(/-[0-9a-f]+$/, "")}`);
  return delivery;
}
