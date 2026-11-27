/**
 * Mock-implementatie van het hele contract, in-memory. panel-ui bouwt hiertegen
 * (`pnpm dev` start het panel met PANEL_MOCK=1).
 *
 * De mock doet alsof je ingelogd bent als admin "steve" met 2FA aan; zet
 * MOCK_ROLE=user, MOCK_ROLE=pending of MOCK_ROLE=anonymous om de andere schermen te zien.
 */
import { TRPCError } from "@trpc/server";
import { ALL_PERMISSIONS } from "../schemas";
import { bedrockPlatform, suggestBackendName } from "../network";
import type * as s from "../schemas";
import type { Implementation, SessionCtx } from "../trpc-builder";
import { contentProfile } from "../content";
import * as data from "./data";

const MOCK_HITS: s.ContentHit[] = [
  { source: "modrinth", projectId: "fabric-api", name: "Fabric API", description: "Core API for Fabric mods", author: "modmuss50", downloads: 100000000, iconUrl: null, url: "https://modrinth.com/mod/fabric-api" },
  { source: "modrinth", projectId: "lithium", name: "Lithium", description: "Server optimisation", author: "jellysquid3", downloads: 50000000, iconUrl: null, url: "https://modrinth.com/mod/lithium" },
  { source: "hangar", projectId: "ViaVersion", name: "ViaVersion", description: "Allow newer clients", author: "ViaVersion", downloads: 9000000, iconUrl: null, url: "https://hangar.papermc.io/ViaVersion/ViaVersion" },
];

export type MockRole = "admin" | "user" | "pending" | "anonymous";

export function mockSession(role: MockRole = (process.env.MOCK_ROLE as MockRole) || "admin"): SessionCtx | null {
  if (role === "anonymous") return null;
  return {
    sessionId: "mock-session",
    userId: role === "user" ? 2 : 1,
    discordId: role === "user" ? "100000000000000002" : "100000000000000001",
    isAdmin: role === "admin",
    isOwner: role === "admin",
    isEmergency: false,
    blocked: false,
    totpEnabled: role !== "user",
    totpVerified: role === "admin",
  };
}

const ok = { ok: true as const };
const clone = <T>(v: T): T => structuredClone(v);
const notFound = (what: string): never => {
  throw new TRPCError({ code: "NOT_FOUND", message: what });
};

/** Maakt een verse mock met eigen state (handig in tests). */
export function createMock(): Implementation {
  const db = {
    users: clone(data.users),
    servers: clone(data.servers),
    nodes: clone(data.nodes),
    templates: clone(data.templates),
    allocations: clone(data.allocations),
    domains: clone(data.domains),
    files: clone(data.files),
    fileContents: clone(data.fileContents),
    backups: clone(data.backups),
    schedules: clone(data.schedules),
    activity: clone(data.activity),
    /** Proxy-uuid → backends (de eerste is de standaardserver); alleen servers met template "Velocity" zijn een proxy. */
    networks: new Map<string, Array<{ serverUuid: string; name: string }>>(),
    content: [] as Array<s.InstalledContent & { serverUuid: string }>,
    subusers: [] as Array<{ serverUuid: string; userId: number; permissions: s.Permission[]; createdAt: Date }>,
    apiKeys: [] as s.ApiKey[],
    phpSettings: new Map<string, s.PhpSettings>(),
    admins: ["100000000000000001"],
    settings: { panelName: "Blokgenoten Panel", logoUrl: null, accentColor: "#22c55e", defaultLimits: { cpuPct: 200, ramMb: 4096, swapMb: 0, diskMb: 20_000 }, imageUpdates: { defaultPolicy: "notify", windowStart: "04:00", windowEnd: "05:00" } } as s.Settings,
    totpEnabled: new Map<number, boolean>([[1, true]]),
    quotas: new Map<number, s.QuotaInput>([[2, { maxRamMb: 4096, maxDiskMb: 50_000, maxCpuPct: 300, maxServers: 3, maxDatabases: 2, templateIds: null, nodeIds: null, maxPortsPerServer: 2 }]]),
    webhooks: new Map<string, s.WebhookStatus>(),
    notif: new Map<string, s.ServerNotifications>(),
    nextId: 1000,
  };
  const hookStatus = (url: string | null | undefined): s.WebhookStatus => (url ? { set: true, hint: `…${url.slice(-4)}` } : { set: false, hint: null });
  const id = () => ++db.nextId;
  const user = (uid: number) => db.users.find((u) => u.id === uid) ?? notFound("user");
  const srv = (uuid: string) => db.servers.find((x) => x.uuid === uuid) ?? notFound("server");
  const summary = (x: (typeof db.servers)[number], uid: number): s.ServerSummary => {
    const { permissions: _p, allocations: _a, variables: _v, node: _n, sftp: _s, installedAt: _i, createdAt: _c, ownerId, ...rest } = x;
    return { ...rest, isOwner: ownerId === uid };
  };
  const mockBedrock = (uuid: string) => {
    const x = srv(uuid);
    const slug = x.templateName.toLowerCase();
    const mode = slug === "velocity" ? ("proxy" as const) : ("standalone" as const);
    const a = db.allocations.find((a) => a.serverUuid === uuid && a.role === "bedrock");
    return {
      supported: !!bedrockPlatform(slug),
      mode,
      enabled: !!a,
      address: a ? a.ip : null,
      port: a?.port ?? null,
      allocationId: a?.id ?? null,
      freeAllocations: db.allocations.filter((f) => f.serverUuid === null).map((f) => ({ id: f.id, ip: f.ip, port: f.port })),
    };
  };
  const isMcProxy = (x: (typeof db.servers)[number]) => x.templateName === "Velocity";
  const network = (x: (typeof db.servers)[number]): s.ServerNetwork => {
    if (isMcProxy(x)) {
      const members = (db.networks.get(x.uuid) ?? []).map((m, i) => {
        const b = srv(m.serverUuid);
        return { serverUuid: b.uuid, serverName: b.name, name: m.name, isDefault: i === 0, address: b.primaryAddress };
      });
      return { role: "proxy", members, proxy: null, connectAddress: x.primaryAddress };
    }
    for (const [p, list] of db.networks) if (list.some((m) => m.serverUuid === x.uuid)) return { role: "backend", members: [], proxy: { uuid: p, name: srv(p).name }, connectAddress: null };
    return { role: "none", members: [], proxy: null, connectAddress: null };
  };
  const detail = (x: (typeof db.servers)[number], uid: number): s.ServerDetail => {
    const { ownerId, ...rest } = x;
    const sub = db.subusers.find((u) => u.serverUuid === x.uuid && u.userId === uid);
    return { ...rest, network: network(x), isOwner: ownerId === uid, permissions: ownerId === uid || uid === 1 ? [...ALL_PERMISSIONS] : (sub?.permissions ?? []) };
  };
  const me = (session: SessionCtx): s.Me => ({
    user: user(session.userId),
    isAdmin: session.isAdmin,
    isOwner: session.isOwner,
    isEmergency: false,
    totpEnabled: session.totpEnabled,
    totpVerified: session.totpVerified,
  });
  const uid = (ctx: { session: SessionCtx | null }) => ctx.session!.userId;
  const fakeStats = (x: (typeof db.servers)[number]): s.Stats => ({
    cpuPct: 20 + Math.random() * 60,
    memoryBytes: x.limits.ramMb * 1024 * 1024 * (0.4 + Math.random() * 0.2),
    memoryLimitBytes: x.limits.ramMb * 1024 * 1024,
    networkRxBytes: 1_200_000,
    networkTxBytes: 3_400_000,
    diskBytes: 4_200_000_000,
    diskLimitBytes: x.limits.diskMb * 1024 * 1024,
    uptimeMs: 3_600_000,
  });
  const adminUser = (u: s.UserPublic): s.AdminUser => ({
    ...u,
    blocked: false,
    isAdmin: db.admins.includes(u.discordId),
    totpEnabled: db.totpEnabled.get(u.id) ?? false,
    createdAt: new Date("2026-11-20T09:00:00Z"),
    lastLoginAt: u.name ? new Date("2026-11-26T08:00:00Z") : null,
    serverCount: db.servers.filter((x) => x.ownerId === u.id).length,
  });
  const usageOf = (uid: number): s.QuotaUsage => {
    const own = db.servers.filter((x) => x.ownerId === uid);
    return { ramMb: own.reduce((a, x) => a + x.limits.ramMb, 0), diskMb: own.reduce((a, x) => a + x.limits.diskMb, 0), cpuPct: own.reduce((a, x) => a + x.limits.cpuPct, 0), servers: own.length, databases: 0 };
  };
  const overview = (uid: number): s.QuotaOverview | null => {
    const q = db.quotas.get(uid);
    if (!q) return null;
    return {
      quota: q,
      usage: usageOf(uid),
      templates: db.templates.filter((t) => !q.templateIds || q.templateIds.includes(t.id)).map((t) => ({ id: t.id, name: t.name, type: t.type })),
      nodes: db.nodes.filter((n) => !q.nodeIds || q.nodeIds.includes(n.id)).map((n) => ({ id: n.id, name: n.name, supportsDomains: n.supportsDomains })),
    };
  };
  const nodeHealth = (n: s.Node): s.NodeHealth => ({
    nodeId: n.id,
    online: true,
    version: "0.1.0-mock",
    diskQuotaMode: n.diskQuotaMode,
    cpuCount: 6,
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryUsedBytes: 3.1 * 1024 ** 3,
    diskTotalBytes: 296 * 1024 ** 3,
    diskFreeBytes: 273 * 1024 ** 3,
    serverCount: db.servers.length,
    error: null,
  });
  const dnsCheck = (domainId: number): s.DnsCheck => ({
    domainId,
    records: [
      { type: "A", name: "@", expected: "203.0.113.10", actual: [], status: "missing" },
      { type: "CNAME", name: "www", expected: "blokgenoten.test", actual: [], status: "missing" },
    ],
    nameservers: ["ns1.transip.nl", "ns2.transip.eu"],
    provider: "transip",
    warnings: [],
    checkedAt: new Date(),
  });
  const pageOf = <T>(items: T[], limit: number) => ({ items: items.slice(0, limit), nextCursor: items.length > limit ? String(limit) : null });
  const signed = (path: string) => ({ url: `https://node1.test${path}?token=mock`, expiresAt: new Date(Date.now() + 10 * 60_000) });
  const database = (dbId: number, serverUuid: string, name: string): s.Database => ({
    id: dbId, serverUuid, hostId: 1, hostName: "mariadb", host: "203.0.113.10", port: 3306, name: `s${dbId}_${name}`, username: `u${dbId}_${name}`.slice(0, 32), password: "mock-password", adminerUrl: "https://adminer.test",
  });
  const appJobs: s.AppJob[] = [];
  const mockJob = (uuid: string, appId: string, adminUser: string | null): s.AppJob => {
    const steps = ["download", "verify", "extract", "database", "configure", "finish"].map((key) => ({ key, status: "done" as const }));
    const job: s.AppJob = {
      id: id(), serverUuid: uuid, appId, appName: ({ wordpress: "WordPress", grav: "Grav", nextcloud: "Nextcloud" } as Record<string, string>)[appId] ?? appId, status: "succeeded", steps, errorCode: null, error: null,
      result: { version: "6.8", siteUrl: "https://mock.example.test", adminUrl: "https://mock.example.test/wp-admin/", adminUsername: adminUser, adminPassword: adminUser ? "mock-admin-password" : null, databaseName: "mock_db", notes: [] },
      startedAt: new Date(), finishedAt: new Date(),
    };
    appJobs.unshift(job);
    return job;
  };
  const databases: s.Database[] = [database(1, data.servers[2]!.uuid, "wordpress")];

  return {
    auth: {
      me: ({ ctx }) => (ctx.session ? me(ctx.session) : null),
      branding: () => ({ panelName: db.settings.panelName, logoUrl: db.settings.logoUrl, accentColor: db.settings.accentColor }),
      discordLoginUrl: () => ({ url: "/?mock-login=1" }),
      verifyTotp: ({ input }) => {
        if (input.code !== "123456") throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_CODE (mock: use 123456)" });
        return ok;
      },
      emergencyLogin: () => ok,
      logout: () => ok,
    },
    account: {
      get: ({ ctx }) => me(ctx.session!),
      totpSetup: () => ({ secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Blokgenoten%20Panel:steve?secret=JBSWY3DPEHPK3PXP&issuer=Blokgenoten%20Panel" }),
      totpEnable: ({ input, ctx }) => {
        if (input.code !== "123456") throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_CODE (mock: use 123456)" });
        db.totpEnabled.set(uid(ctx), true);
        return ok;
      },
      totpDisable: ({ ctx }) => (db.totpEnabled.set(uid(ctx), false), ok),
      apiKeys: () => db.apiKeys,
      createApiKey: ({ input }) => {
        const k: s.ApiKey = { id: id(), name: input.name, prefix: "pk_mock1", permissions: input.permissions, lastUsedAt: null, expiresAt: input.expiresAt, createdAt: new Date() };
        db.apiKeys.push(k);
        return { key: "pk_mock1_" + "x".repeat(40), apiKey: k };
      },
      revokeApiKey: ({ input }) => ((db.apiKeys = db.apiKeys.filter((k) => k.id !== input.id)), ok),
      setSftpPassword: () => ok,
      webhook: () => db.webhooks.get("user") ?? { set: false, hint: null },
      setWebhook: ({ input }) => {
        const w = hookStatus(input.url);
        db.webhooks.set("user", w);
        return w;
      },
      testWebhook: () => ok,
      quota: ({ ctx }) => overview(uid(ctx)),
    },
    servers: {
      create: ({ input, ctx }) => {
        const u = uid(ctx);
        const o = overview(u);
        if (!o) throw new TRPCError({ code: "FORBIDDEN", message: "NO_QUOTA" });
        const tpl = o.templates.find((t) => t.id === input.templateId) ?? (() => { throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" }); })();
        if (o.usage.servers + 1 > o.quota.maxServers) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "QUOTA_EXCEEDED: servers" });
        const base = db.servers.find((x) => x.type === tpl.type) ?? db.servers[0]!;
        const x = { ...clone(base), uuid: crypto.randomUUID(), name: input.name, ownerId: u, owner: user(u), status: "installing" as const, limits: { ...input.limits, swapMb: 0 } };
        db.servers.push(x);
        return detail(x, u);
      },
      updateOwnLimits: ({ input }) => ((srv(input.uuid).limits = { ...input.limits, swapMb: 0 }), ok),
      deleteOwn: ({ input }) => {
        const x = srv(input.uuid);
        if (x.name !== input.confirmName) throw new TRPCError({ code: "BAD_REQUEST", message: "NAME_MISMATCH" });
        db.servers = db.servers.filter((y) => y !== x);
        return ok;
      },
      list: ({ ctx }) => {
        const u = uid(ctx);
        return db.servers.filter((x) => x.ownerId === u || u === 1 || db.subusers.some((su) => su.serverUuid === x.uuid && su.userId === u)).map((x) => summary(x, u));
      },
      get: ({ input, ctx }) => {
        const x = srv(input.uuid);
        const u = uid(ctx);
        if (x.ownerId !== u && u !== 1 && !db.subusers.some((su) => su.serverUuid === x.uuid && su.userId === u)) throw new TRPCError({ code: "NOT_FOUND", message: "server" });
        return detail(x, u);
      },
      stats: ({ input }) => {
        const x = srv(input.uuid);
        return x.status === "online" || x.status === "starting" ? fakeStats(x) : null;
      },
      power: ({ input }) => {
        const x = srv(input.uuid);
        x.status = input.action === "stop" || input.action === "kill" ? "offline" : "online";
        return ok;
      },
      sendCommand: () => ok,
      consoleToken: ({ input }) => ({ token: "mock.jwt.token", socketUrl: `wss://node1.test/api/servers/${input.uuid}/ws`, expiresAt: new Date(Date.now() + 10 * 60_000) }),
      rename: ({ input }) => ((srv(input.uuid).name = input.name), ok),
      updateVariables: ({ input }) => {
        const x = srv(input.uuid);
        for (const v of x.variables) if (v.key in input.variables) v.value = input.variables[v.key]!;
        return ok;
      },
      reinstall: ({ input }) => ((srv(input.uuid).status = "installing"), ok),
      notifications: ({ input }) => db.notif.get(input.uuid) ?? { webhook: { set: false, hint: null }, autoRestart: false, autoRestartMax: 3 },
      updateNotifications: ({ input }) => {
        const prev = db.notif.get(input.uuid) ?? { webhook: { set: false, hint: null }, autoRestart: false, autoRestartMax: 3 };
        const n = { webhook: input.webhookUrl === undefined ? prev.webhook : hookStatus(input.webhookUrl), autoRestart: input.autoRestart, autoRestartMax: input.autoRestartMax };
        db.notif.set(input.uuid, n);
        return n;
      },
      testWebhook: () => ok,
      updateSleep: ({ input }) => ((srv(input.uuid).sleep = { ...srv(input.uuid).sleep, enabled: input.enabled, idleMinutes: input.idleMinutes }), ok),
      updateImagePolicy: ({ input }) => {
        const iu = srv(input.uuid).imageUpdate;
        srv(input.uuid).imageUpdate = { ...iu, policy: input.policy, effectivePolicy: input.policy ?? db.settings.imageUpdates.defaultPolicy };
        return ok;
      },
      updateImageNow: ({ input }) => ((srv(input.uuid).imageUpdate = { ...srv(input.uuid).imageUpdate, available: false, reinstallRequired: false }), ok),
      activity: ({ input }) => pageOf(db.activity.filter((a) => a.serverUuid === input.uuid), input.limit),
      bedrock: ({ input }) => mockBedrock(input.uuid),
      setBedrock: ({ input }) => {
        const x = srv(input.uuid);
        if (!bedrockPlatform(x.templateName.toLowerCase())) throw new TRPCError({ code: "BAD_REQUEST", message: "BEDROCK_NOT_SUPPORTED" });
        if (!input.enabled) {
          const a = db.allocations.find((a) => a.serverUuid === x.uuid && a.role === "bedrock");
          if (a) Object.assign(a, { serverUuid: null, role: "game" });
          return mockBedrock(input.uuid);
        }
        const free = db.allocations.find((a) => a.serverUuid === null && (input.allocationId ? a.id === input.allocationId : true));
        if (!free) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_FREE_ALLOCATIONS" });
        Object.assign(free, { serverUuid: x.uuid, role: "bedrock" });
        return mockBedrock(input.uuid);
      },
      networkCandidates: ({ input }) => {
        if (!isMcProxy(srv(input.uuid))) throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_PROXY" });
        return db.servers
          .filter((x) => ["Paper", "Folia", "Fabric"].includes(x.templateName))
          .map((x) => {
            const taken = [...db.networks].find(([p, l]) => p !== input.uuid && l.some((m) => m.serverUuid === x.uuid));
            return { uuid: x.uuid, name: x.name, templateName: x.templateName, address: x.primaryAddress, ownerName: x.owner.name, suggestedName: suggestBackendName(x.name), takenBy: taken ? srv(taken[0]).name : null };
          });
      },
      updateNetwork: ({ input }) => {
        const p = srv(input.uuid);
        if (!isMcProxy(p)) throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_PROXY" });
        const before = db.networks.get(input.uuid) ?? [];
        const sorted = [...input.members].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        db.networks.set(input.uuid, sorted.map((m) => ({ serverUuid: m.serverUuid, name: m.name })));
        const removed = before.filter((m) => !sorted.some((n) => n.serverUuid === m.serverUuid));
        return {
          servers: [
            { uuid: p.uuid, name: p.name, role: "proxy" as const, restarted: false, reloaded: input.restart, error: null },
            ...sorted.map((m) => ({ uuid: m.serverUuid, name: srv(m.serverUuid).name, role: "backend" as const, restarted: input.restart, reloaded: false, error: null })),
            ...removed.map((m) => ({ uuid: m.serverUuid, name: srv(m.serverUuid).name, role: "removed" as const, restarted: input.restart, reloaded: false, error: null })),
          ],
        };
      },
    },
    content: {
      info: ({ input }) => {
        const p = contentProfile(srv(input.uuid).templateName.toLowerCase());
        return p
          ? { supported: true, kind: p.kind, directory: p.directory, loaders: p.loaders, sources: p.sources, gameVersion: p.versionVar === "MINECRAFT_VERSION" ? "1.21.5" : null, modpacks: p.modpacks }
          : { supported: false, kind: null, directory: null, loaders: [], sources: [], gameVersion: null, modpacks: false };
      },
      search: ({ input }) => {
        if (input.modpacks) return { hits: [{ source: "modrinth" as const, projectId: "cool-pack", name: "Cool Pack", description: "A Fabric modpack", author: "someone", downloads: 1000, iconUrl: null, url: "https://modrinth.com/modpack/cool-pack" }], total: 1 };
        const hits = MOCK_HITS.filter((h) => h.source === input.source && h.name.toLowerCase().includes(input.query.toLowerCase()));
        return { hits, total: hits.length };
      },
      resolve: ({ input }) => {
        const hit = MOCK_HITS.find((h) => h.source === input.source && h.projectId === input.projectId) ?? notFound("project");
        const dep = MOCK_HITS.find((h) => h.projectId === "fabric-api" && h.projectId !== input.projectId);
        return {
          hit, versionId: input.versionId ?? "v2", versionNumber: "2.0.0", filename: `${hit.projectId}-2.0.0.jar`, size: 1234,
          dependencies: dep ? [{ projectId: dep.projectId, name: dep.name, installed: db.content.some((c) => c.serverUuid === input.uuid && c.projectId === dep.projectId) }] : [],
        };
      },
      install: ({ input }) => {
        const hit = MOCK_HITS.find((h) => h.source === input.source && h.projectId === input.projectId) ?? notFound("project");
        const dir = contentProfile(srv(input.uuid).templateName.toLowerCase());
        const row = { serverUuid: input.uuid, id: db.content.length + 1, source: input.source, projectId: hit.projectId, name: hit.name, versionId: input.versionId ?? "v2", versionNumber: "2.0.0", filename: `${hit.projectId}-2.0.0.jar`, kind: dir?.kind ?? "plugin", installedAt: new Date() } as const;
        db.content.push({ ...row });
        return [row].map(({ serverUuid: _u, ...r }) => r);
      },
      list: ({ input }) => db.content.filter((c) => c.serverUuid === input.uuid).map(({ serverUuid: _u, ...r }) => r),
      checkUpdates: ({ input }) => db.content.filter((c) => c.serverUuid === input.uuid && c.versionId === "v1").map((c) => ({ id: c.id, versionId: "v2", versionNumber: "2.0.0" })),
      update: ({ input }) => {
        const c = db.content.find((x) => x.id === input.id && x.serverUuid === input.uuid) ?? notFound("content");
        Object.assign(c, { versionId: "v2", versionNumber: "2.0.0" });
        const { serverUuid: _u, ...r } = c;
        return r;
      },
      uninstall: ({ input }) => ((db.content = db.content.filter((c) => !(c.id === input.id && c.serverUuid === input.uuid))), ok),
      importModpack: () => ({ name: "Mock pack", minecraftVersion: "1.21.5", loaderVersion: "0.16.14", filesInstalled: 12, filesSkipped: 3, overridesApplied: 5, reinstalled: true }),
      versionOptions: () => ({
        variables: { version: "MINECRAFT_VERSION", build: "BUILD", loader: null },
        versions: [{ id: "1.21.5", stable: true }, { id: "1.21.4", stable: true }, { id: "1.21.3", stable: true }, { id: "1.21.4-rc1", stable: false }],
        builds: ["120", "119"],
        loaderVersions: [],
      }),
    },
    files: {
      list: ({ input }) => (input.path === "/" ? db.files : []),
      read: ({ input }) => {
        const c = db.fileContents[input.path] ?? notFound("file");
        return { content: c, size: c.length };
      },
      write: ({ input }) => ((db.fileContents[input.path] = input.content), ok),
      mkdir: () => ok,
      rename: () => ok,
      delete: () => ok,
      compress: ({ input }) => ({
        archive: { name: "archive.tar.gz", path: `${input.root.replace(/\/$/, "")}/archive.tar.gz`, isDirectory: false, isSymlink: false, size: 1024, mode: "-rw-r--r--", mimeType: "application/gzip", modifiedAt: new Date() },
      }),
      decompress: () => ok,
      uploadUrl: ({ input }) => signed(`/api/servers/${input.uuid}/files/upload`),
      downloadUrl: ({ input }) => signed(`/api/servers/${input.uuid}/files/download`),
      sftpDetails: ({ input }) => srv(input.uuid).sftp,
    },
    domains: {
      list: ({ input }) => db.domains.filter((x) => x.serverUuid === input.uuid),
      add: ({ input }) => {
        const dom: s.Domain = { id: id(), serverUuid: input.uuid, hostname: input.hostname, protocol: input.protocol, targetPort: input.targetPort, redirectTo: input.redirectTo, wildcard: input.wildcard, dnsProviderId: input.dnsProviderId, sslStatus: "pending", dnsStatus: "unchecked", lastCheckedAt: null };
        db.domains.push(dom);
        return dom;
      },
      update: ({ input }) => {
        const dom = db.domains.find((x) => x.id === input.id) ?? notFound("domain");
        Object.assign(dom, { targetPort: input.targetPort, redirectTo: input.redirectTo });
        return dom;
      },
      remove: ({ input }) => ((db.domains = db.domains.filter((x) => x.id !== input.id)), ok),
      check: ({ input }) => dnsCheck(input.id),
      lastCheck: ({ input }) => dnsCheck(input.id),
      applyDns: ({ input }) => ({ ...dnsCheck(input.id), records: dnsCheck(input.id).records.map((r) => ({ ...r, actual: r.expected ? [r.expected] : [], status: "ok" as const })) }),
      target: () => ({ ip: "203.0.113.10", nodeFqdn: "node1.test" }),
    },
    databases: {
      list: ({ input }) => databases.filter((x) => x.serverUuid === input.uuid),
      create: ({ input }) => {
        const x = database(id(), input.uuid, input.name);
        databases.push(x);
        return x;
      },
      resetPassword: ({ input }) => {
        const x = databases.find((y) => y.id === input.id) ?? notFound("database");
        x.password = "nieuw-mock-password";
        return x;
      },
      delete: () => ok,
    },
    apps: {
      catalog: () => [
        { id: "wordpress", name: "WordPress", description: "The most popular CMS and blog platform.", homepage: "https://wordpress.org", requiresDatabase: true, supportsAdmin: true, downloadMb: 35, compatible: true, incompatibleReason: null },
        { id: "grav", name: "Grav", description: "Fast flat-file CMS without a database.", homepage: "https://getgrav.org", requiresDatabase: false, supportsAdmin: false, downloadMb: 23, compatible: true, incompatibleReason: null },
        { id: "nextcloud", name: "Nextcloud", description: "Your own cloud storage, calendar and contacts.", homepage: "https://nextcloud.com", requiresDatabase: true, supportsAdmin: true, downloadMb: 296, compatible: true, incompatibleReason: null },
      ],
      check: () => ({ publicEmpty: true, entries: 1 }),
      install: ({ input }) => mockJob(input.uuid, input.appId, input.admin?.username ?? null),
      job: ({ input }) => appJobs.find((j) => j.id === input.id) ?? notFound("job"),
      jobs: ({ input }) => appJobs.filter((j) => j.serverUuid === input.uuid),
    },
    backups: {
      list: ({ input }) => db.backups.filter((b) => b.serverUuid === input.uuid),
      create: ({ input }) => {
        const b: s.Backup = { id: id(), serverUuid: input.uuid, name: input.name ?? `backup ${new Date().toISOString().slice(0, 10)}`, sizeBytes: null, sha256: null, status: "running", includesDatabases: input.includeDatabases, error: null, createdAt: new Date(), completedAt: null };
        db.backups.push(b);
        return b;
      },
      restore: () => ok,
      delete: ({ input }) => ((db.backups = db.backups.filter((b) => b.id !== input.id)), ok),
      downloadUrl: ({ input }) => ({ url: `https://s3.test/backups/${input.id}.tar.zst`, expiresAt: new Date(Date.now() + 10 * 60_000) }),
    },
    schedules: {
      list: ({ input }) => db.schedules.filter((x) => x.serverUuid === input.uuid),
      create: ({ input }) => {
        const { uuid, ...rest } = input;
        const x: s.Schedule = { id: id(), serverUuid: uuid, ...rest, lastRunAt: null, nextRunAt: new Date(Date.now() + 86_400_000), lastResult: null, lastOutput: null };
        db.schedules.push(x);
        return x;
      },
      update: ({ input }) => {
        const x = db.schedules.find((y) => y.id === input.id) ?? notFound("schedule");
        const { id: _id, ...rest } = input;
        Object.assign(x, rest);
        return x;
      },
      delete: ({ input }) => ((db.schedules = db.schedules.filter((x) => x.id !== input.id)), ok),
      runNow: () => ok,
    },
    siteSettings: {
      php: ({ input }) => {
        srv(input.uuid);
        const defaults: s.PhpSettings = { memoryLimitMb: 256, uploadMaxMb: 64, maxExecutionTime: 120, maxInputVars: 3000, displayErrors: false, timezone: "Europe/Amsterdam", opcache: true, disabledExtensions: [] };
        return { settings: db.phpSettings.get(input.uuid) ?? defaults, defaults, managed: db.phpSettings.has(input.uuid), ramLimitMb: 1024, extensions: ["gd", "intl", "exif", "mysqli"] };
      },
      updatePhp: ({ input }) => (db.phpSettings.set(input.uuid, input.settings), ok),
    },
    subusers: {
      list: ({ input }) => db.subusers.filter((x) => x.serverUuid === input.uuid).map((x) => ({ user: user(x.userId), permissions: x.permissions, createdAt: x.createdAt })),
      invite: ({ input }) => {
        let u = db.users.find((x) => x.discordId === input.who || x.name === input.who);
        if (!u) {
          if (!/^\d{15,21}$/.test(input.who)) throw new TRPCError({ code: "NOT_FOUND", message: "unknown username" });
          u = { id: id(), discordId: input.who, name: null, avatarUrl: null };
          db.users.push(u);
        }
        const su = { serverUuid: input.uuid, userId: u.id, permissions: input.permissions, createdAt: new Date() };
        db.subusers.push(su);
        return { user: u, permissions: su.permissions, createdAt: su.createdAt };
      },
      update: ({ input }) => {
        const su = db.subusers.find((x) => x.serverUuid === input.uuid && x.userId === input.userId) ?? notFound("subuser");
        su.permissions = input.permissions;
        return { user: user(su.userId), permissions: su.permissions, createdAt: su.createdAt };
      },
      remove: ({ input }) => ((db.subusers = db.subusers.filter((x) => !(x.serverUuid === input.uuid && x.userId === input.userId))), ok),
    },
    admin: {
      dashboard: () => ({
        nodes: db.nodes.map(nodeHealth),
        alerts: [{ kind: "install_failed", message: "Installation of blokgenoten.test is still running", at: new Date(), serverUuid: data.servers[2]!.uuid, nodeId: 1 }],
        serverCount: db.servers.length,
        userCount: db.users.length,
      }),
      imageUpdates: {
        list: () => db.servers.map((x) => ({ uuid: x.uuid, name: x.name, type: x.type, status: x.status, templateName: x.templateName, nodeName: x.nodeName, image: x.type === "web" ? "serversideup/php:8.3-fpm-nginx-alpine" : "eclipse-temurin:25-jre", imageUpdate: x.imageUpdate })),
        checkNow: () => ok,
      },
      nodes: {
        list: () => db.nodes,
        get: ({ input }) => {
          const n = db.nodes.find((x) => x.id === input.id) ?? notFound("node");
          return { ...n, health: nodeHealth(n) };
        },
        create: ({ input }) => {
          const n: s.Node = { id: id(), ...input, diskQuotaMode: null, isLocal: false, publicIp: null, joinState: null };
          db.nodes.push(n);
          return { node: n, token: "mock-node-token", installCommand: `curl -fsSL https://panel.test/install-node.sh | bash -s -- --panel https://panel.test --token mock-node-token` };
        },
        update: ({ input }) => {
          const n = db.nodes.find((x) => x.id === input.id) ?? notFound("node");
          Object.assign(n, input);
          return n;
        },
        delete: ({ input }) => ((db.nodes = db.nodes.filter((x) => x.id !== input.id)), ok),
        regenerateToken: () => ({ token: "mock-node-token-2", installCommand: "curl -fsSL https://panel.test/install-node.sh | bash" }),
        createJoin: ({ input }) => {
          const n: s.Node = {
            id: id(), name: input.name, fqdn: input.fqdn ?? `${input.name}.panel.test`, daemonPort: input.daemonPort, sftpPort: input.sftpPort, maxRamMb: input.maxRamMb, maxDiskMb: input.maxDiskMb,
            s3TargetId: input.s3TargetId, diskQuotaMode: null, isLocal: false, supportsDomains: input.supportsDomains, publicPort: input.publicPort ?? (input.supportsDomains ? 443 : 8443), publicIp: null, joinState: "waiting",
          };
          db.nodes.push(n);
          return { node: n, joinCommand: "curl -fsSL https://panel.test/join | sudo bash -s -- mock-join-code", expiresAt: new Date(Date.now() + 3_600_000) };
        },
        joinCommand: () => ({ joinCommand: "curl -fsSL https://panel.test/join | sudo bash -s -- mock-join-code-2", expiresAt: new Date(Date.now() + 3_600_000) }),
        joinStatus: ({ input }) => {
          const n = db.nodes.find((x) => x.id === input.id) ?? notFound("node");
          return {
            state: n.joinState, message: null, ip: n.publicIp,
            dns: { mode: "manual" as const, record: { type: "A" as const, name: n.fqdn, value: n.publicIp }, resolvedIp: null, ok: false },
            daemonConnected: false, certificateOk: false, allocationsCreated: 0, codeExpiresAt: new Date(Date.now() + 3_600_000), codeUsed: false,
          };
        },
        updateDaemon: () => ok,
        uninstallCommand: () => ({ command: "curl -fsSL https://panel.test/join | sudo bash -s -- --uninstall" }),
      },
      allocations: {
        list: ({ input }) => db.allocations.filter((a) => a.nodeId === input.nodeId),
        create: ({ input }) => {
          let created = 0;
          for (const part of input.ports.split(",")) {
            const [a, b] = part.split("-").map((p) => Number(p.trim()));
            for (let p = a!; p <= (b ?? a!); p++) {
              db.allocations.push({ id: id(), nodeId: input.nodeId, ip: input.ip, port: p, serverUuid: null, primary: false, role: "game" });
              created++;
            }
          }
          return { created };
        },
        delete: ({ input }) => ((db.allocations = db.allocations.filter((a) => a.id !== input.id)), ok),
      },
      servers: {
        list: ({ input, ctx }) => pageOf(db.servers.filter((x) => !input.search || x.name.toLowerCase().includes(input.search.toLowerCase())).map((x) => summary(x, uid(ctx))), input.limit),
        create: ({ input, ctx }) => {
          const t = db.templates.find((x) => x.id === input.templateId) ?? notFound("template");
          const owner = user(input.ownerId);
          const uuid = crypto.randomUUID();
          const allocs = input.allocationIds.map((aid) => db.allocations.find((a) => a.id === aid)).filter((a): a is s.Allocation => !!a);
          allocs.forEach((a, i) => Object.assign(a, { serverUuid: uuid, primary: i === 0 }));
          const x = {
            uuid, shortId: uuid.slice(0, 8), name: input.name, type: t.type, status: "installing" as const, templateName: t.name, nodeName: "node1",
            primaryAddress: allocs[0] ? `${allocs[0].ip}:${allocs[0].port}` : null, limits: input.limits, isOwner: false, owner, ownerId: owner.id,
            permissions: [], allocations: allocs,
            variables: t.variables.map((v) => ({ ...v, value: input.variables[v.key] ?? v.default })),
            node: { id: 1, name: "node1", fqdn: "node1.test", supportsDomains: true }, sftp: { host: "node1.test", port: 2022, username: `${owner.name ?? owner.discordId}.${uuid.slice(0, 8)}` },
            suspended: null, network: { role: "none" as const, members: [], proxy: null, connectAddress: null },
            domainsAllowed: t.type === "web",
            sleep: { supported: t.type === "game", enabled: false, idleMinutes: 10 },
            imageUpdate: { policy: null, effectivePolicy: db.settings.imageUpdates.defaultPolicy, available: false, reinstallRequired: false, checkedAt: null },
            installedAt: null, createdAt: new Date(),
          };
          db.servers.push(x);
          return detail(x, uid(ctx));
        },
        updateLimits: ({ input }) => ((srv(input.uuid).limits = input.limits), ok),
        updateOwner: ({ input }) => {
          const x = srv(input.uuid);
          x.ownerId = input.ownerId;
          x.owner = user(input.ownerId);
          return ok;
        },
        updateAllocations: () => ok,
        delete: ({ input }) => ((db.servers = db.servers.filter((x) => x.uuid !== input.uuid)), ok),
        transfer: () => ok,
        setDomainsAllowed: ({ input }) => (((srv(input.uuid) as { domainsAllowed?: boolean }).domainsAllowed = input.allowed), ok),
        setSuspended: ({ input }) => {
          const x = srv(input.uuid);
          (x as { suspended: s.ServerSummary["suspended"] }).suspended = input.suspended ? { reason: input.reason, at: new Date() } : null;
          if (input.suspended) x.status = "offline";
          return ok;
        },
        changeTemplate: ({ input }) => {
          const t = db.templates.find((y) => y.id === input.templateId) ?? notFound("template");
          srv(input.uuid).templateName = t.name;
          if (input.reinstall) srv(input.uuid).status = "installing";
          return ok;
        },
      },
      templates: {
        list: () => db.templates.map(({ yaml: _y, variables: _v, ...t }) => t),
        get: ({ input }) => db.templates.find((t) => t.id === input.id) ?? notFound("template"),
        create: ({ input }) => {
          const t: s.TemplateDetail = { id: id(), slug: `mock-${db.nextId}`, name: "New template", type: "game", version: 1, description: null, serverCount: 0, yaml: input.yaml, variables: [] };
          db.templates.push(t);
          return t;
        },
        update: ({ input }) => {
          const t = db.templates.find((x) => x.id === input.id) ?? notFound("template");
          t.yaml = input.yaml;
          t.version++;
          return t;
        },
        delete: ({ input }) => ((db.templates = db.templates.filter((t) => t.id !== input.id)), ok),
        validate: ({ input }) => (input.yaml.includes("schema: 1") ? { ok: true, errors: [] } : { ok: false, errors: ["schema: verwacht 1"] }),
      },
      users: {
        list: ({ input }) => pageOf(db.users.filter((u) => !input.search || (u.name ?? u.discordId).includes(input.search)).map(adminUser), input.limit),
        get: ({ input }) => adminUser(user(input.id)),
        create: ({ input }) => {
          const u = { id: id(), discordId: input.discordId, name: null, avatarUrl: null };
          db.users.push(u);
          return adminUser(u);
        },
        setBlocked: () => ok,
        resetTotp: ({ input }) => (db.totpEnabled.set(input.id, false), ok),
        getQuota: ({ input }) => db.quotas.get(input.id) ?? null,
        setQuota: ({ input }) => {
          const { id: uidIn, ...q } = input;
          db.quotas.set(uidIn, q);
          return ok;
        },
        clearQuota: ({ input }) => (db.quotas.delete(input.id), ok),
      },
      quotas: {
        usage: ({ input }) => pageOf(db.users.map((u) => ({ user: u, quota: db.quotas.get(u.id) ?? null, usage: usageOf(u.id) })), input.limit),
      },
      admins: {
        list: () =>
          db.admins.map((discordId) => ({ discordId, user: db.users.find((u) => u.discordId === discordId) ?? null, addedBy: null, addedAt: new Date("2026-11-20T09:00:00Z"), isOwner: discordId === "100000000000000001" })),
        add: ({ input }) => (db.admins.includes(input.discordId) || db.admins.push(input.discordId), ok),
        remove: ({ input }) => {
          if (input.discordId === "100000000000000001") throw new TRPCError({ code: "FORBIDDEN", message: "OWNER" });
          db.admins = db.admins.filter((x) => x !== input.discordId);
          return ok;
        },
      },
      databaseHosts: {
        list: () => [{ id: 1, name: "mariadb", host: "203.0.113.10", port: 3306, adminUser: "panel", nodeId: 1, daemonManaged: false, databaseCount: databases.length }],
        create: ({ input }) => ({ id: id(), name: input.name, host: input.host, port: input.port, adminUser: input.adminUser, nodeId: input.nodeId, daemonManaged: false, databaseCount: 0 }),
        update: ({ input }) => ({ id: input.id, name: input.name ?? "mariadb", host: input.host ?? "203.0.113.10", port: input.port ?? 3306, adminUser: input.adminUser ?? "panel", nodeId: input.nodeId ?? 1, daemonManaged: false, databaseCount: 0 }),
        delete: () => ok,
        test: () => ({ ok: true, error: null }),
      },
      s3Targets: {
        list: () => [{ id: 1, name: "Unraid", endpoint: "http://unraid.test:9000", bucket: "panel-backups", region: "us-east-1", pathStyle: true, accessKeyPreview: "AKIA" }],
        create: ({ input }) => ({ id: id(), name: input.name, endpoint: input.endpoint, bucket: input.bucket, region: input.region, pathStyle: input.pathStyle, accessKeyPreview: input.accessKey.slice(0, 4) }),
        update: ({ input }) => ({ id: input.id, name: input.name ?? "Unraid", endpoint: input.endpoint ?? "http://unraid.test:9000", bucket: input.bucket ?? "panel-backups", region: input.region ?? "us-east-1", pathStyle: input.pathStyle ?? true, accessKeyPreview: (input.accessKey ?? "AKIA").slice(0, 4) }),
        delete: () => ok,
        test: () => ({ ok: true, error: null }),
      },
      dnsProviders: {
        list: () => [{ id: 1, type: "cloudflare" as const, name: "Cloudflare", zones: [{ id: "z1", name: "blokgenoten.test" }] }],
        create: ({ input }) => ({ id: id(), type: input.type, name: input.name, zones: [] }),
        delete: () => ok,
        refreshZones: ({ input }) => ({ id: input.id, type: "cloudflare" as const, name: "Cloudflare", zones: [{ id: "z1", name: "blokgenoten.test" }] }),
      },
      activity: {
        search: ({ input }) =>
          pageOf(db.activity.filter((a) => (!input.userId || a.user?.id === input.userId) && (!input.serverUuid || a.serverUuid === input.serverUuid) && (!input.action || a.action.startsWith(input.action))), input.limit),
      },
      notifications: {
        get: () => db.webhooks.get("admin") ?? { set: false, hint: null },
        set: ({ input }) => {
          const w = hookStatus(input.url);
          db.webhooks.set("admin", w);
          return w;
        },
        test: () => ok,
      },
      settings: {
        get: () => db.settings,
        update: ({ input }) => Object.assign(db.settings, input),
      },
    },
  };
}

export const mockImplementation = createMock();
