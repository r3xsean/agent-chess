import { readFileSync, existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import path from "node:path";
import { DATA } from "./paths";
import type { OrchestratorAction } from "./orchestrator";

/**
 * The T3 webhook that wakes an orchestrator thread to launch agents with $delegate.
 * Its URL is a credential, so it lives only in data/webhook.json (git-ignored), with the optional
 * `secret` the requests are signed with (T3 checks the signature, so the URL alone can't start a run).
 */
function webhook(): { url: string; secret?: string } | null {
  const f = path.join(DATA, "webhook.json");
  if (!existsSync(f)) return null;
  try {
    const w = JSON.parse(readFileSync(f, "utf8"));
    return w.url ? w : null;
  } catch {
    return null;
  }
}

export const summonAvailable = () => !!webhook();

/** The header T3 checks: HMAC-SHA256 of the raw body, hex, after "sha256=". */
export const SIGNATURE_HEADER = "x-agent-chess-signature";

export async function triggerOrchestrator(body: { action: OrchestratorAction; gameId?: string; tournamentId?: string }) {
  const w = webhook();
  if (!w) throw new Error("No T3 webhook configured (data/webhook.json).");
  const payload = JSON.stringify({ gameId: "", tournamentId: "", ...body });
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (w.secret) headers[SIGNATURE_HEADER] = `sha256=${createHmac("sha256", w.secret).update(payload).digest("hex")}`;
  const r = await fetch(w.url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`T3 webhook answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  console.log(`[summon] ${body.action} ${body.gameId ?? body.tournamentId ?? ""}`);
}
