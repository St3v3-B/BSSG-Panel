/** Openbare statuspagina's: beheer door de eigenaar en het openbare (gecachete) antwoord. */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { getDb, schema } from "../db";
import { requireServer } from "../servers-data";
import { invalidateStatus, isUniqueViolation, pageView, publicStatus, setPageServers, slugTaken } from "../status-pages";

const ok = { ok: true as const };

/** Eigen servers op uuid, in de opgegeven volgorde; FORBIDDEN bij een vreemde of onbekende server. */
async function ownServerIds(userId: number, uuids: string[]): Promise<number[]> {
  const unique = [...new Set(uuids)];
  const rows = await getDb().select({ id: schema.servers.id, uuid: schema.servers.uuid, ownerId: schema.servers.ownerId }).from(schema.servers).where(inArray(schema.servers.uuid, unique));
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  return unique.map((u) => {
    const r = byUuid.get(u);
    if (!r || r.ownerId !== userId) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_OWNER" });
    return r.id;
  });
}

async function ownPage(userId: number, id: number) {
  const [p] = await getDb().select().from(schema.statusPages).where(and(eq(schema.statusPages.id, id), eq(schema.statusPages.ownerId, userId)));
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "STATUS_PAGE_NOT_FOUND" });
  return p;
}

async function serverPageRow(serverId: number) {
  const [r] = await getDb()
    .select({ p: schema.statusPages })
    .from(schema.statusPages)
    .innerJoin(schema.statusPageServers, eq(schema.statusPageServers.pageId, schema.statusPages.id))
    .where(and(eq(schema.statusPages.kind, "server"), eq(schema.statusPageServers.serverId, serverId)))
    .limit(1);
  return r?.p ?? null;
}

const unique = async <T,>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) throw slugTaken();
    throw e;
  }
};

export const statusPages: Implementation["statusPages"] = {
  list: async ({ ctx }) => {
    const rows = await getDb().select().from(schema.statusPages).where(eq(schema.statusPages.ownerId, ctx.session!.userId)).orderBy(asc(schema.statusPages.id));
    return Promise.all(rows.map(pageView));
  },

  create: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const userId = ctx.session!.userId;
    const ids = await ownServerIds(userId, input.serverUuids);
    const page = await unique(() =>
      getDb().transaction(async (tx) => {
        const [p] = await tx
          .insert(schema.statusPages)
          .values({ slug: input.slug, ownerId: userId, kind: "network", title: input.title, description: input.description, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers })
          .returning();
        await tx.insert(schema.statusPageServers).values(ids.map((serverId, position) => ({ pageId: p!.id, serverId, position })));
        return p!;
      }),
    );
    invalidateStatus(page.slug);
    await logActivity({ action: "statuspage.create", userId, metadata: { id: page.id, slug: page.slug }, ip: ctx.ip, ctx });
    return pageView(page);
  },

  update: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const userId = ctx.session!.userId;
    const prev = await ownPage(userId, input.id);
    // Een serverpagina hoort bij precies één server; die wijzig je via setServerPage.
    const ids = prev.kind === "server" ? null : await ownServerIds(userId, input.serverUuids);
    const [p] = await unique(() =>
      getDb()
        .update(schema.statusPages)
        .set({ slug: input.slug, title: input.title, description: input.description, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers, updatedAt: new Date() })
        .where(eq(schema.statusPages.id, prev.id))
        .returning(),
    );
    if (ids) await setPageServers(prev.id, ids);
    invalidateStatus(prev.slug);
    invalidateStatus(p!.slug);
    await logActivity({ action: "statuspage.update", userId, metadata: { id: prev.id, slug: p!.slug }, ip: ctx.ip, ctx });
    return pageView(p!);
  },

  delete: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const p = await ownPage(ctx.session!.userId, input.id);
    await getDb().delete(schema.statusPages).where(eq(schema.statusPages.id, p.id));
    invalidateStatus(p.slug);
    await logActivity({ action: "statuspage.delete", userId: ctx.session!.userId, metadata: { id: p.id, slug: p.slug }, ip: ctx.ip, ctx });
    return ok;
  },

  candidates: async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({ id: schema.servers.id, uuid: schema.servers.uuid, name: schema.servers.name, type: schema.servers.type, templateName: schema.templates.name })
      .from(schema.servers)
      .innerJoin(schema.templates, eq(schema.templates.id, schema.servers.templateId))
      .where(eq(schema.servers.ownerId, ctx.session!.userId))
      .orderBy(asc(schema.servers.name));
    const ids = rows.map((r) => r.id);
    const members = ids.length
      ? await db
          .select({ proxy: schema.networkMembers.proxyServerId, backend: schema.servers.uuid, ownerId: schema.servers.ownerId })
          .from(schema.networkMembers)
          .innerJoin(schema.servers, eq(schema.servers.id, schema.networkMembers.backendServerId))
          .where(inArray(schema.networkMembers.proxyServerId, ids))
          .orderBy(asc(schema.networkMembers.position))
      : [];
    return rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      type: r.type,
      templateName: r.templateName,
      // Alleen eigen backends: een netwerkpagina toont geen servers van anderen.
      networkMembers: members.filter((m) => m.proxy === r.id && m.ownerId === ctx.session!.userId).map((m) => m.backend),
    }));
  },

  serverPage: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const p = await serverPageRow(a.bundle.server.id);
    return p ? pageView(p) : null;
  },

  setServerPage: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const s = a.bundle.server;
    const db = getDb();
    const prev = await serverPageRow(s.id);
    const fields = { slug: input.slug, title: input.title ?? prev?.title ?? s.name, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers, updatedAt: new Date() };
    const page = await unique(async () => {
      if (prev) return (await db.update(schema.statusPages).set(fields).where(eq(schema.statusPages.id, prev.id)).returning())[0]!;
      return db.transaction(async (tx) => {
        const [p] = await tx.insert(schema.statusPages).values({ ...fields, ownerId: s.ownerId, kind: "server" }).returning();
        await tx.insert(schema.statusPageServers).values({ pageId: p!.id, serverId: s.id, position: 0 });
        return p!;
      });
    });
    if (prev) invalidateStatus(prev.slug);
    invalidateStatus(page.slug);
    await logActivity({ action: "server.statuspage.update", userId: ctx.session!.userId, serverId: s.id, metadata: { slug: page.slug, enabled: page.enabled, showAddress: page.showAddress }, ip: ctx.ip, ctx });
    return pageView(page);
  },

  public: async ({ input }) => {
    const r = await publicStatus(input.slug);
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "STATUS_PAGE_NOT_FOUND" });
    return r;
  },
};
