import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { T3_DATABASE } from "./usageLimits";

/** T3's desktop URL uses environment/thread, unlike links rendered inside T3 messages. */
export function desktopThreadUrl(threadId: string, database = T3_DATABASE): string | undefined {
  const file = path.join(path.dirname(database), "environment-id");
  if (!existsSync(file)) return undefined;
  const environment = readFileSync(file, "utf8").trim();
  return environment ? `t3code://threads/${encodeURIComponent(environment)}/${encodeURIComponent(threadId)}` : undefined;
}

/** Read-only compatibility adapter, like usageLimits: never modify T3's database. */
export function findDirectorThread(key: string, at: number, delivery?: string, database = T3_DATABASE): string | undefined {
  if (!existsSync(database)) return undefined;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100");
    const threads = db.prepare(`SELECT thread_id FROM orchestration_v2_projection_threads WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`).all(
      new Date(at - 60_000).toISOString(), new Date(at + 10 * 60_000).toISOString(),
    ) as { thread_id: string }[];
    const first = db.prepare(`SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type = 'user_message' ORDER BY ordinal LIMIT 1`);
    for (const t of threads) {
      const row = first.get(t.thread_id) as { turn_item_id: string; payload_json: string } | undefined;
      if (row && ((delivery && row.turn_item_id.includes(delivery.replace(/^delivery:relay:/, ""))) || row.payload_json.includes(key))) return t.thread_id;
    }
    return undefined;
  } finally { db.close(); }
}
