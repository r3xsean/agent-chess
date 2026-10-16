import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DATA } from "./paths";

/**
 * The T3 webhook that wakes an orchestrator thread to launch agents with $delegate.
 * Its URL is a credential, so it lives only in data/webhook.json (git-ignored).
 */
function webhookUrl(): string | null {
  const f = path.join(DATA, "webhook.json");
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")).url ?? null;
  } catch {
    return null;
  }
}

export const summonAvailable = () => !!webhookUrl();

export async function triggerOrchestrator(body: { action: "start-game" | "tournament-next"; gameId?: string; tournamentId?: string }) {
  const url = webhookUrl();
  if (!url) throw new Error("No T3 webhook configured (data/webhook.json).");
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: "", tournamentId: "", ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`T3 webhook answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  console.log(`[summon] ${body.action} ${body.gameId ?? body.tournamentId ?? ""}`);
}
