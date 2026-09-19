import { getDb, auditLog } from "@/lib/db";
import type { Actor } from "@/lib/posts/state-machine";

/**
 * For a medical tenant this table is the record of who approved what, so every
 * state transition writes here — including the ones made by jobs.
 */
export async function recordAudit(entry: {
  tenantId?: string | null;
  postId?: string | null;
  actor: Actor;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await db.insert(auditLog).values({
    tenantId: entry.tenantId ?? null,
    postId: entry.postId ?? null,
    actor: entry.actor.type === "human" ? entry.actor.label : entry.actor.label,
    actorType: entry.actor.type,
    action: entry.action,
    payload: entry.payload ?? {},
  });
}

export function systemActor(label = "system"): Actor {
  return { type: "system", label };
}
