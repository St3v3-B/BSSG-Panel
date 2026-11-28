/** Mock voor meldingen (inbox, e-mail, voorkeuren, SMTP) en openbare statuspagina's. */
import { TRPCError } from "@trpc/server";
import { ADMIN_NOTIFICATION_EVENTS, DEFAULT_NOTIFICATION_PREFS } from "../schemas";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

type I = Implementation;
const ok = { ok: true as const };

interface Deps {
  servers: Array<{ uuid: string; name: string; type: s.ServerType; templateName: string; ownerId: number; status: s.ServerStatus; primaryAddress: string | null }>;
  branding: () => s.Branding;
  uid: (ctx: { session: { userId: number } | null }) => number;
  nextId: () => number;
}

const hourly = (seed: number) => Array.from({ length: 24 }, (_, i) => (i === 20 - (seed % 5) ? 75 : 100));
const daily = (seed: number) => Array.from({ length: 7 }, (_, i) => (i === 6 - (seed % 3) ? 98.9 : 100));

export function createNotifyMock(d: Deps) {
  const now = Date.now();
  let prefs: s.NotificationPrefs = structuredClone(DEFAULT_NOTIFICATION_PREFS);
  let email: s.EmailStatus = { address: null, pending: null };
  let smtp: s.SmtpSettings = { host: null, port: 587, security: "starttls", username: null, passwordSet: false, from: null, fromName: null };
  const inbox: Array<s.InboxItem & { userId: number }> = [
    { id: 3, userId: 1, event: "server_crashed", level: "error", title: "Server crashed", body: "SMP stopped unexpectedly (exit code 1). Restarting (attempt 1).", server: { uuid: d.servers[0]!.uuid, name: d.servers[0]!.name }, link: `/servers/${d.servers[0]!.uuid}`, createdAt: new Date(now - 5 * 60_000), readAt: null },
    { id: 2, userId: 1, event: "disk", level: "warning", title: "Disk almost full", body: `${d.servers[0]!.name} uses 18,000 MB of 20,000 MB (90%).`, server: { uuid: d.servers[0]!.uuid, name: d.servers[0]!.name }, link: `/servers/${d.servers[0]!.uuid}`, createdAt: new Date(now - 3 * 3600_000), readAt: null },
    { id: 1, userId: 1, event: "login_new_ip", level: "info", title: "New sign-in", body: "Signed in from a new IP address: 198.51.100.7.", server: null, link: "/account", createdAt: new Date(now - 2 * 86400_000), readAt: new Date(now - 86400_000) },
  ];
  const pages: Array<s.StatusPage & { ownerId: number }> = [
    { id: 1, ownerId: 1, slug: "smp", kind: "server", title: "SMP", description: null, enabled: true, showAddress: true, showPlayers: true, servers: [{ uuid: d.servers[0]!.uuid, name: d.servers[0]!.name }], createdAt: new Date(now - 7 * 86400_000) },
  ];
  const mine = (ctx: Parameters<Deps["uid"]>[0]) => inbox.filter((x) => x.userId === d.uid(ctx));
  const settings = (ctx: Parameters<Deps["uid"]>[0], isAdmin: boolean): s.NotificationSettings => {
    const p = structuredClone(prefs);
    if (!isAdmin) for (const e of ADMIN_NOTIFICATION_EVENTS) p[e] = { panel: false, discord: false, email: false };
    void ctx;
    return { prefs: p, email, discordSet: false, emailAvailable: !!smtp.host };
  };
  const own = (uid: number, uuids: string[]) =>
    uuids.map((u) => {
      const srv = d.servers.find((x) => x.uuid === u);
      if (!srv) throw new TRPCError({ code: "NOT_FOUND", message: "server" });
      if (srv.ownerId !== uid) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_OWNER" });
      return { uuid: srv.uuid, name: srv.name };
    });
  const taken = (slug: string, except?: number) => {
    if (pages.some((p) => p.slug === slug && p.id !== except)) throw new TRPCError({ code: "CONFLICT", message: "SLUG_TAKEN" });
  };
  const strip = ({ ownerId: _o, ...p }: (typeof pages)[number]): s.StatusPage => structuredClone(p);

  const account: Pick<I["account"], "notificationSettings" | "setNotificationPrefs" | "setEmail" | "resendEmailVerification" | "testEmail"> = {
    notificationSettings: ({ ctx }) => settings(ctx, !!ctx.session?.isAdmin),
    setNotificationPrefs: ({ input, ctx }) => {
      prefs = { ...prefs, ...(input.prefs as Partial<s.NotificationPrefs>) };
      return settings(ctx, !!ctx.session?.isAdmin);
    },
    setEmail: ({ input }) => {
      if (input.email === null) return (email = { address: null, pending: null });
      if (!smtp.host) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SMTP_NOT_CONFIGURED" });
      return (email = { ...email, pending: input.email });
    },
    resendEmailVerification: () => {
      if (!email.pending) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_PENDING_EMAIL" });
      return ok;
    },
    testEmail: () => {
      if (!email.address) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "EMAIL_NOT_VERIFIED" });
      return ok;
    },
  };

  const inboxImpl: I["inbox"] = {
    list: ({ input, ctx }) => {
      const all = mine(ctx).filter((x) => !input.unreadOnly || !x.readAt);
      const start = input.cursor ? Number(input.cursor) : 0;
      const items = all.slice(start, start + input.limit).map(({ userId: _u, ...x }) => x);
      return { items, nextCursor: start + input.limit < all.length ? String(start + input.limit) : null };
    },
    unreadCount: ({ ctx }) => ({ count: mine(ctx).filter((x) => !x.readAt).length }),
    markRead: ({ input, ctx }) => {
      for (const x of mine(ctx)) if (!input.ids || input.ids.includes(x.id)) x.readAt ??= new Date();
      return ok;
    },
  };

  const statusPages: I["statusPages"] = {
    list: ({ ctx }) => pages.filter((p) => p.ownerId === d.uid(ctx)).map(strip),
    create: ({ input, ctx }) => {
      taken(input.slug);
      const p = { id: d.nextId(), ownerId: d.uid(ctx), kind: "network" as const, slug: input.slug, title: input.title, description: input.description, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers, servers: own(d.uid(ctx), input.serverUuids), createdAt: new Date() };
      pages.push(p);
      return strip(p);
    },
    update: ({ input, ctx }) => {
      const p = pages.find((x) => x.id === input.id && x.ownerId === d.uid(ctx));
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "status page" });
      taken(input.slug, p.id);
      Object.assign(p, { slug: input.slug, title: input.title, description: input.description, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers, servers: own(d.uid(ctx), input.serverUuids) });
      return strip(p);
    },
    delete: ({ input, ctx }) => {
      const i = pages.findIndex((x) => x.id === input.id && x.ownerId === d.uid(ctx));
      if (i >= 0) pages.splice(i, 1);
      return ok;
    },
    candidates: ({ ctx }) =>
      d.servers
        .filter((x) => x.ownerId === d.uid(ctx))
        .map((x) => ({ uuid: x.uuid, name: x.name, type: x.type, templateName: x.templateName, networkMembers: [] })),
    serverPage: ({ input }) => {
      const p = pages.find((x) => x.kind === "server" && x.servers[0]?.uuid === input.uuid);
      return p ? strip(p) : null;
    },
    setServerPage: ({ input, ctx }) => {
      const srv = d.servers.find((x) => x.uuid === input.uuid);
      if (!srv) throw new TRPCError({ code: "NOT_FOUND", message: "server" });
      let p = pages.find((x) => x.kind === "server" && x.servers[0]?.uuid === input.uuid);
      taken(input.slug, p?.id);
      if (!p) {
        p = { id: d.nextId(), ownerId: d.uid(ctx), kind: "server", slug: input.slug, title: input.title ?? srv.name, description: null, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers, servers: [{ uuid: srv.uuid, name: srv.name }], createdAt: new Date() };
        pages.push(p);
      } else Object.assign(p, { slug: input.slug, title: input.title ?? p.title, enabled: input.enabled, showAddress: input.showAddress, showPlayers: input.showPlayers });
      return strip(p);
    },
    public: ({ input }) => {
      const p = pages.find((x) => x.slug === input.slug && x.enabled);
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "STATUS_PAGE_NOT_FOUND" });
      const servers = p.servers.map((ref, i): s.PublicStatusServer => {
        const srv = d.servers.find((x) => x.uuid === ref.uuid)!;
        const state: s.PublicServerState = srv.status === "online" ? "online" : srv.status === "sleeping" ? "sleeping" : srv.status === "starting" ? "starting" : srv.status === "installing" ? "maintenance" : "offline";
        return {
          name: srv.name,
          type: srv.type,
          state,
          players: p.showPlayers && srv.type === "game" && state === "online" ? { online: 3 + i, max: 20 } : null,
          uptime24h: 98.9,
          uptime7d: 99.7,
          hours: hourly(i),
          days: daily(i),
          address: p.showAddress ? srv.primaryAddress : null,
        };
      });
      const up = servers.filter((x) => x.state === "online" || x.state === "sleeping").length;
      return { title: p.title, description: p.description, kind: p.kind, branding: d.branding(), overall: up === servers.length ? "operational" : up === 0 ? "down" : "degraded", servers, updatedAt: new Date() };
    },
  };

  const smtpImpl: I["admin"]["smtp"] = {
    get: () => smtp,
    set: ({ input }) => {
      if (input.host === null) return (smtp = { host: null, port: 587, security: "starttls", username: null, passwordSet: false, from: null, fromName: null });
      smtp = { host: input.host, port: input.port, security: input.security, username: input.username, passwordSet: input.password === undefined ? smtp.passwordSet : !!input.password, from: input.from, fromName: input.fromName };
      return smtp;
    },
    test: () => (smtp.host ? { ok: true, error: null } : { ok: false, error: "SMTP is not configured" }),
  };

  const verifyEmail: I["auth"]["verifyEmail"] = ({ input }) => {
    if (input.token.startsWith("bad")) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_TOKEN" });
    const addr = email.pending ?? "steve@panel.test";
    email = { address: addr, pending: null };
    return { ok: true as const, email: addr };
  };

  return { account, inbox: inboxImpl, statusPages, smtp: smtpImpl, verifyEmail };
}
