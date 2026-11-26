/** Activiteitenlog: elke muterende actie en elke login. */
import { getDb, schema } from "./db";

export interface ActivityInput {
  action: string;
  userId?: number | null;
  serverId?: number | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function logActivity(a: ActivityInput): Promise<void> {
  try {
    await getDb().insert(schema.activityLog).values({
      action: a.action,
      userId: a.userId ?? null,
      serverId: a.serverId ?? null,
      metadata: a.metadata ?? {},
      ip: a.ip ?? null,
    });
  } catch (e) {
    // Het log mag een geslaagde actie niet laten mislukken.
    console.error(`[activity] ${a.action} niet gelogd:`, e);
  }
}
