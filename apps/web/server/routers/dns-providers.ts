/** admin.dnsProviders.*: Cloudflare-koppelingen (API-token versleuteld, zones in de database). */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { decrypt, encrypt } from "../lib/crypto";
import { CloudflareError, listZones } from "../lib/cloudflare";

type Row = typeof schema.dnsProviders.$inferSelect;
const toProvider = (p: Row) => ({ id: p.id, type: "cloudflare" as const, name: p.name, zones: p.zones });

export async function zonesOrThrow(token: string) {
  try {
    return await listZones(token);
  } catch (e) {
    if (e instanceof CloudflareError) throw new TRPCError({ code: "BAD_REQUEST", message: `CLOUDFLARE_ERROR: ${e.message}` });
    throw e;
  }
}

export const dnsProviders: Implementation["admin"]["dnsProviders"] = {
  list: async () => (await getDb().select().from(schema.dnsProviders).orderBy(asc(schema.dnsProviders.id))).map(toProvider),

  create: async ({ input, ctx }) => {
    const zones = await zonesOrThrow(input.apiToken);
    const [p] = await getDb().insert(schema.dnsProviders).values({ type: input.type, name: input.name, apiTokenEnc: encrypt(input.apiToken), zones }).returning();
    await logActivity({ action: "admin.dns_provider.create", userId: ctx.session!.userId, metadata: { id: p!.id, name: input.name, zones: zones.length }, ip: ctx.ip });
    return toProvider(p!);
  },

  delete: async ({ input, ctx }) => {
    const r = await getDb().delete(schema.dnsProviders).where(eq(schema.dnsProviders.id, input.id)).returning();
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "DNS_PROVIDER_NOT_FOUND" });
    await logActivity({ action: "admin.dns_provider.delete", userId: ctx.session!.userId, metadata: { id: input.id, name: r[0]!.name }, ip: ctx.ip });
    return { ok: true as const };
  },

  refreshZones: async ({ input, ctx }) => {
    const [p] = await getDb().select().from(schema.dnsProviders).where(eq(schema.dnsProviders.id, input.id));
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "DNS_PROVIDER_NOT_FOUND" });
    const zones = await zonesOrThrow(decrypt(p.apiTokenEnc));
    const [u] = await getDb().update(schema.dnsProviders).set({ zones }).where(eq(schema.dnsProviders.id, p.id)).returning();
    await logActivity({ action: "admin.dns_provider.refresh", userId: ctx.session!.userId, metadata: { id: p.id, zones: zones.length }, ip: ctx.ip });
    return toProvider(u!);
  },
};
