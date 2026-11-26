/** Activiteitenlog: elke muterende actie en elke login. */
import type { Ctx } from "@panel/api";
import { apiKeyOf } from "./apikey";
import { getDb, schema } from "./db";

export interface ActivityInput {
  action: string;
  userId?: number | null;
  serverId?: number | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  /** Voor de inlogmethode (method=api_key bij een API-sleutel). */
  ctx?: Ctx;
}

export async function logActivity(a: ActivityInput): Promise<void> {
  try {
    await getDb().insert(schema.activityLog).values({
      action: a.action,
      userId: a.userId ?? null,
      serverId: a.serverId ?? null,
      metadata: apiKeyOf(a.ctx) ? { ...a.metadata, method: "api_key", apiKeyId: apiKeyOf(a.ctx)!.id } : (a.metadata ?? {}),
      ip: a.ip ?? null,
    });
  } catch (e) {
    // Het log mag een geslaagde actie niet laten mislukken.
    console.error(`[activity] ${a.action} niet gelogd:`, e);
  }
}
