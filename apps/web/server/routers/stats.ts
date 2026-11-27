/** servers.statsHistory en servers.statsSparklines: verbruiksgeschiedenis (zie ../stats-history.ts). */
import { ALL_PERMISSIONS, type Implementation, type StatsSparkline } from "@panel/api";
import { and, eq, inArray } from "drizzle-orm";
import { apiKeyOf } from "../apikey";
import { getDb, schema } from "../db";
import { isFullAdmin, requireServer } from "../servers-data";
import { sparklines, statsHistory } from "../stats-history";

const MB = 1024 * 1024;

export const stats: Pick<Implementation["servers"], "statsHistory" | "statsSparklines"> = {
  statsHistory: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "console.read");
    const s = a.bundle.server;
    return statsHistory(s.id, input.range, { cpuLimitPct: s.cpuPct, memoryLimitBytes: s.ramMb * MB, diskLimitBytes: s.diskMb * MB });
  },

  statsSparklines: async ({ input, ctx }) => {
    const uuids = [...new Set(input.uuids)];
    if (!uuids.length) return {};
    const db = getDb();
    const uid = ctx.session!.userId;
    // Rechten in bulk (twee queries), met dezelfde regels als requireServer(…, "console.read").
    const rows = await db.select({ id: schema.servers.id, uuid: schema.servers.uuid, ownerId: schema.servers.ownerId }).from(schema.servers).where(inArray(schema.servers.uuid, uuids));
    if (!rows.length) return {};
    const subs = await db
      .select({ serverId: schema.subusers.serverId, permissions: schema.subusers.permissions })
      .from(schema.subusers)
      .where(and(eq(schema.subusers.userId, uid), inArray(schema.subusers.serverId, rows.map((r) => r.id))));
    const subPerms = new Map(subs.map((s) => [s.serverId, s.permissions]));
    const key = apiKeyOf(ctx);
    const admin = isFullAdmin(ctx);
    const allowed = rows.filter((r) => {
      const perms: readonly string[] = r.ownerId === uid || admin ? ALL_PERMISSIONS : (subPerms.get(r.id) ?? []);
      if (!perms.includes("console.read")) return false;
      return !key || key.permissions.includes("console.read");
    });
    const lines = await sparklines(allowed.map((r) => r.id));
    const out: Record<string, StatsSparkline> = {};
    for (const r of allowed) out[r.uuid] = lines.get(r.id)!;
    return out;
  },
};
