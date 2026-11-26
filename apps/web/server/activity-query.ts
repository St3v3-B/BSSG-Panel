/** Activiteitenlog lezen (pagina's, nieuwste eerst; cursor = id van het laatste item). */
import type { ActivityEntry } from "@panel/api";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { getDb, schema } from "./db";
import { userPublic } from "./servers-data";

export async function activityPage(where: SQL | undefined, input: { cursor?: string | null; limit: number }): Promise<{ items: ActivityEntry[]; nextCursor: string | null }> {
  const cursor = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : null;
  const rows = await getDb()
    .select({ log: schema.activityLog, user: schema.users, server: { uuid: schema.servers.uuid, name: schema.servers.name } })
    .from(schema.activityLog)
    .leftJoin(schema.users, eq(schema.users.id, schema.activityLog.userId))
    .leftJoin(schema.servers, eq(schema.servers.id, schema.activityLog.serverId))
    .where(and(where, cursor !== null ? lt(schema.activityLog.id, cursor) : undefined))
    .orderBy(desc(schema.activityLog.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    items: page.map((r) => {
      const meta = r.log.metadata ?? {};
      return {
        id: r.log.id,
        action: r.log.action,
        user: r.user && r.user.discordId ? userPublic(r.user) : null,
        serverUuid: r.server?.uuid ?? (typeof meta.serverUuid === "string" ? meta.serverUuid : null),
        serverName: r.server?.name ?? (typeof meta.serverName === "string" ? meta.serverName : null),
        metadata: meta,
        ip: r.log.ip,
        at: r.log.at,
      };
    }),
    nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.log.id) : null,
  };
}
