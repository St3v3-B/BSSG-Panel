/**
 * admin.importer: import vanuit Pterodactyl / Pelican.
 *
 * Verloop: connect (Application API lezen → snapshot + voorgestelde mapping) → setMapping (eggs → templates,
 * gebruikers → accounts, doelnode/allocations per server) → dryRun (wat er zou gebeuren; schrijft niets) → start.
 * De runner doet eerst de accounts (koppelen of vooraf aanmaken op Discord-ID, zoals admin.users.create, met de
 * bronnaam als voorlopige naam en het e-mailadres als ongeverifieerd adres), daarna één server tegelijk: aanmaken op
 * de doelnode (skip_install als er bestanden komen), bestanden overzetten (bestaande backup via de Client API, anders
 * SFTP van Wings), klaar. Mislukt een server, dan wordt hij weer opgeruimd en staat hij op `failed`; `start` hervat.
 * De bron wordt nooit gewijzigd: SourceClient kent alleen GET, SFTP alleen lezen.
 * Sleutels staan versleuteld in `import_sessions` en worden gewist zodra alles klaar is of bij `disconnect`.
 */
import { randomUUID } from "node:crypto";
import type { Ctx, ImportPlan, ImportSession as ImportSessionOut, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { decrypt, encrypt } from "../lib/crypto";
import { assertNotInMaintenance } from "../node-maintenance";
import { buildServerSpec, validateVariables } from "../spec";
import { assignAllocations, checkAllocations } from "../routers/admin";
import { backupTar, sftpTar } from "./files";
import { AUTO_SCORE, eggToTemplateYaml, mapVariables, suggestTemplate, type TemplateLite } from "./mapping";
import { SourceClient, type SourceKind, type Snapshot, type SrcServer } from "./source";

type SessionRow = typeof schema.importSessions.$inferSelect;
type ItemRow = typeof schema.importItems.$inferSelect;
type TemplateRow = typeof schema.templates.$inferSelect;
type NodeRow = typeof schema.nodes.$inferSelect;
type AllocRow = typeof schema.allocations.$inferSelect;
type A = Implementation["admin"]["importer"];

export interface Mapping {
  defaultNodeId: number | null;
  eggs: Record<string, { action: "template" | "skip"; templateId: number | null }>;
  users: Record<string, { action: "link" | "create" | "skip"; accountId: number | null; discordId: string | null; matchedBy?: "discord" | "email" | "name" | null }>;
  servers: Record<string, { include: boolean; targetNodeId: number | null; allocationIds: number[] | null }>;
}

const uid = (ctx: Ctx) => ctx.session!.userId;
const bad = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });
const DEFAULT_RAM_MB = 1024;

/** Vervangbaar in tests. */
export const importerDeps = {
  client: (url: string, key: string, clientKey: string | null) => new SourceClient(url, key, clientKey),
  progressMs: 2000,
};

// ---------- sessie ----------

async function currentRow(): Promise<SessionRow | null> {
  const [r] = await getDb().select().from(schema.importSessions).orderBy(desc(schema.importSessions.id)).limit(1);
  return r ?? null;
}
async function mustRow(): Promise<SessionRow> {
  const r = await currentRow();
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "NO_IMPORT" });
  return r;
}
const snapOf = (r: SessionRow) => r.snapshot as Snapshot;
const mapOf = (r: SessionRow) => r.mapping as Mapping;

function clientOf(r: SessionRow): SourceClient {
  if (!r.apiKeyEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONNECTED: connect to the source again" });
  return importerDeps.client(r.url, decrypt(r.apiKeyEnc), r.clientKeyEnc ? decrypt(r.clientKeyEnc) : null);
}

async function templatesLite(): Promise<TemplateRow[]> {
  return getDb().select().from(schema.templates).orderBy(asc(schema.templates.id));
}
const lite = (t: TemplateRow): TemplateLite => ({ id: t.id, slug: t.slug, name: t.name, type: t.type, image: t.image, startup: t.startup, variables: t.variables });

/** Voorgestelde mapping voor alles wat nog geen keuze heeft. */
async function proposeMapping(snap: Snapshot, prev: Mapping | null): Promise<Mapping> {
  const db = getDb();
  const templates = (await templatesLite()).map(lite);
  const m: Mapping = { defaultNodeId: prev?.defaultNodeId ?? null, eggs: { ...(prev?.eggs ?? {}) }, users: { ...(prev?.users ?? {}) }, servers: { ...(prev?.servers ?? {}) } };
  if (m.defaultNodeId === null) {
    const nodes = await db.select().from(schema.nodes).where(isNull(schema.nodes.maintenance)).orderBy(asc(schema.nodes.id));
    m.defaultNodeId = (nodes.find((n) => n.isLocal) ?? nodes[0])?.id ?? null;
  }
  for (const e of snap.eggs) {
    if (m.eggs[e.id]) continue;
    const s = suggestTemplate(e, templates);
    m.eggs[e.id] = s && s.score >= AUTO_SCORE ? { action: "template", templateId: s.templateId } : { action: "skip", templateId: null };
  }
  const accounts = await db.select({ id: schema.users.id, discordId: schema.users.discordId, email: schema.users.email, name: schema.users.name }).from(schema.users).where(eq(schema.users.isEmergency, false));
  for (const u of snap.users) {
    if (m.users[u.id]) continue;
    const byDiscord = u.discordId ? accounts.find((a) => a.discordId === u.discordId) : undefined;
    const byEmail = !byDiscord && u.email ? accounts.find((a) => a.email && a.email.toLowerCase() === u.email!.toLowerCase()) : undefined;
    const byName = !byDiscord && !byEmail ? accounts.find((a) => a.name && a.name.toLowerCase() === u.username.toLowerCase()) : undefined;
    const hit = byDiscord ?? byEmail ?? byName;
    if (hit) m.users[u.id] = { action: "link", accountId: hit.id, discordId: null, matchedBy: byDiscord ? "discord" : byEmail ? "email" : "name" };
    else if (u.discordId) m.users[u.id] = { action: "create", accountId: null, discordId: u.discordId, matchedBy: null };
    else m.users[u.id] = { action: "skip", accountId: null, discordId: null, matchedBy: null };
  }
  for (const s of snap.servers) if (!m.servers[s.id]) m.servers[s.id] = { include: true, targetNodeId: null, allocationIds: null };
  return m;
}

async function sessionOut(r: SessionRow): Promise<ImportSessionOut> {
  const db = getDb();
  const snap = snapOf(r);
  const m = mapOf(r);
  const templates = await templatesLite();
  const tl = templates.map(lite);
  const items = await db.select().from(schema.importItems).where(eq(schema.importItems.sessionId, r.id));
  const byItem = new Map(items.map((i) => [i.sourceServerId, i]));
  const accountIds = Object.values(m.users).map((u) => u.accountId).filter((x): x is number => !!x);
  const accounts = accountIds.length ? await db.select({ id: schema.users.id, name: schema.users.name, discordId: schema.users.discordId }).from(schema.users).where(inArray(schema.users.id, accountIds)) : [];
  const countBy = <K extends string | number>(f: (s: SrcServer) => K) => {
    const c = new Map<K, number>();
    for (const s of snap.servers) c.set(f(s), (c.get(f(s)) ?? 0) + 1);
    return c;
  };
  const perUser = countBy((s) => s.ownerId);
  const perEgg = countBy((s) => s.eggId);
  const nodeName = new Map(snap.nodes.map((n) => [n.id, n.name]));
  return {
    id: r.id,
    kind: r.kind as SourceKind,
    url: r.url,
    connected: !!r.apiKeyEnc,
    hasClientKey: !!r.clientKeyEnc,
    sftpUsername: r.sftp?.username ?? null,
    state: r.state as ImportSessionOut["state"],
    fetchedAt: r.fetchedAt,
    defaultNodeId: m.defaultNodeId,
    nodes: snap.nodes,
    users: snap.users.map((u) => {
      const x = m.users[u.id] ?? { action: "skip" as const, accountId: null, discordId: null };
      const acc = accounts.find((a) => a.id === x.accountId);
      return { id: u.id, username: u.username, email: u.email, sourceDiscordId: u.discordId, serverCount: perUser.get(u.id) ?? 0, action: x.action, accountId: x.accountId, accountName: acc ? (acc.name ?? acc.discordId) : null, discordId: x.discordId, matchedBy: x.matchedBy ?? null };
    }),
    eggs: snap.eggs.map((e) => {
      const x = m.eggs[e.id] ?? { action: "skip" as const, templateId: null };
      return {
        id: e.id,
        nestName: e.nestName,
        name: e.name,
        dockerImages: e.dockerImages,
        startup: e.startup,
        variables: e.variables.map((v) => ({ key: v.key, name: v.name, default: v.default })),
        serverCount: perEgg.get(e.id) ?? 0,
        action: x.action,
        templateId: x.templateId,
        suggestion: suggestTemplate(e, tl),
      };
    }),
    servers: snap.servers.map((s) => {
      const x = m.servers[s.id] ?? { include: true, targetNodeId: null, allocationIds: null };
      const it = byItem.get(s.id);
      return {
        id: s.id,
        uuid: s.uuid,
        identifier: s.identifier,
        name: s.name,
        ownerId: s.ownerId,
        eggId: s.eggId,
        sourceNodeId: s.nodeId,
        sourceNodeName: nodeName.get(s.nodeId) ?? null,
        limits: { ramMb: s.limits.memory, swapMb: s.limits.swap, diskMb: s.limits.disk, cpuPct: s.limits.cpu },
        allocations: s.allocations,
        variables: s.variables,
        suspended: s.suspended,
        include: x.include,
        targetNodeId: x.targetNodeId,
        allocationIds: x.allocationIds,
        status: (it?.status ?? "pending") as ImportSessionOut["servers"][number]["status"],
        error: it?.error ?? null,
        method: (it?.method ?? null) as ImportSessionOut["servers"][number]["method"],
        newUuid: it?.newUuid ?? null,
        bytes: it?.bytes ?? 0,
        startedAt: it?.startedAt ?? null,
        finishedAt: it?.finishedAt ?? null,
      };
    }),
    warnings: snap.warnings,
  };
}

// ---------- plan (dry-run en runner) ----------

type Owner = { kind: "account"; id: number; name: string } | { kind: "create"; discordId: string; username: string; email: string | null };

interface ServerPlan {
  src: SrcServer;
  blocked: string | null;
  owner: Owner | null;
  template: TemplateRow | null;
  node: NodeRow | null;
  allocations: AllocRow[];
  method: "backup" | "sftp" | "none";
  backup: { uuid: string; name: string } | null;
  values: Record<string, string>;
  dropped: string[];
  warnings: string[];
  limits: { cpuPct: number; ramMb: number; swapMb: number; diskMb: number };
}

interface PlanCtx {
  snap: Snapshot;
  m: Mapping;
  templates: Map<number, TemplateRow>;
  nodes: Map<number, NodeRow>;
  free: Map<number, AllocRow[]>;
  taken: Set<number>;
  accounts: Map<number, { id: number; name: string | null; discordId: string | null }>;
  byDiscord: Map<string, number>;
  client: SourceClient | null;
  sftp: boolean;
}

async function planCtx(r: SessionRow, withClient: boolean): Promise<PlanCtx> {
  const db = getDb();
  const [templates, nodes, free, accounts] = await Promise.all([
    templatesLite(),
    db.select().from(schema.nodes),
    db.select().from(schema.allocations).where(isNull(schema.allocations.serverId)).orderBy(asc(schema.allocations.port), asc(schema.allocations.id)),
    db.select({ id: schema.users.id, name: schema.users.name, discordId: schema.users.discordId }).from(schema.users),
  ]);
  const byNode = new Map<number, AllocRow[]>();
  for (const a of free) byNode.set(a.nodeId, [...(byNode.get(a.nodeId) ?? []), a]);
  return {
    snap: snapOf(r),
    m: mapOf(r),
    templates: new Map(templates.map((t) => [t.id, t])),
    nodes: new Map(nodes.map((n) => [n.id, n])),
    free: byNode,
    taken: new Set(),
    accounts: new Map(accounts.map((a) => [a.id, a])),
    byDiscord: new Map(accounts.filter((a) => a.discordId).map((a) => [a.discordId!, a.id])),
    client: withClient && r.apiKeyEnc ? clientOf(r) : null,
    sftp: !!r.sftp,
  };
}

async function planServer(pc: PlanCtx, src: SrcServer, probe: boolean): Promise<ServerPlan> {
  const warnings: string[] = [];
  const p: ServerPlan = { src, blocked: null, owner: null, template: null, node: null, allocations: [], method: "none", backup: null, values: {}, dropped: [], warnings, limits: { cpuPct: Math.max(0, src.limits.cpu), ramMb: src.limits.memory > 0 ? Math.max(64, src.limits.memory) : DEFAULT_RAM_MB, swapMb: Math.max(-1, src.limits.swap), diskMb: Math.max(0, src.limits.disk) } };
  if (src.limits.memory <= 0) warnings.push(`unlimited RAM in the source: ${DEFAULT_RAM_MB} MB set`);
  const sm = pc.m.servers[src.id];
  if (sm && !sm.include) return { ...p, blocked: "excluded" };
  // Eigenaar
  const um = pc.m.users[src.ownerId];
  const su = pc.snap.users.find((u) => u.id === src.ownerId);
  if (!um || um.action === "skip") return { ...p, blocked: `owner ${su?.username ?? src.ownerId} is skipped` };
  if (um.action === "link") {
    const a = um.accountId ? pc.accounts.get(um.accountId) : undefined;
    if (!a) return { ...p, blocked: `owner ${su?.username ?? src.ownerId}: account not found` };
    p.owner = { kind: "account", id: a.id, name: a.name ?? a.discordId ?? String(a.id) };
  } else {
    if (!um.discordId) return { ...p, blocked: `owner ${su?.username ?? src.ownerId}: no Discord ID to create the account` };
    const existing = pc.byDiscord.get(um.discordId);
    p.owner = existing ? { kind: "account", id: existing, name: pc.accounts.get(existing)?.name ?? um.discordId } : { kind: "create", discordId: um.discordId, username: su?.username ?? um.discordId, email: su?.email ?? null };
  }
  // Template
  const em = pc.m.eggs[src.eggId];
  const egg = pc.snap.eggs.find((e) => e.id === src.eggId);
  if (!em || em.action === "skip" || !em.templateId) return { ...p, blocked: `egg ${egg?.name ?? src.eggId} is not mapped to a template` };
  const t = pc.templates.get(em.templateId);
  if (!t) return { ...p, blocked: `template ${em.templateId} not found` };
  p.template = t;
  const mv = mapVariables(src.variables, { variables: t.variables });
  p.values = mv.values;
  p.dropped = mv.dropped;
  if (mv.invalid.length) warnings.push(`values not valid for the template (default used): ${mv.invalid.join(", ")}`);
  const verr = validateVariables(t.variables, p.values, { onlyUserEditable: false });
  if (verr.length) return { ...p, blocked: `variables: ${verr.join("; ")}` };
  // Node
  const nodeId = sm?.targetNodeId ?? pc.m.defaultNodeId;
  const node = nodeId ? pc.nodes.get(nodeId) : undefined;
  if (!node) return { ...p, blocked: "no target node chosen" };
  p.node = node;
  if (node.maintenance) return { ...p, blocked: `node ${node.name} is in maintenance` };
  if (t.type === "web" && !node.supportsDomains) return { ...p, blocked: `node ${node.name} does not support websites` };
  // Allocations
  if (t.type === "game") {
    const free = (pc.free.get(node.id) ?? []).filter((a) => !pc.taken.has(a.id));
    if (sm?.allocationIds?.length) {
      const picked = sm.allocationIds.map((id) => free.find((a) => a.id === id));
      if (picked.some((a) => !a)) return { ...p, blocked: "chosen allocations are not free on the target node" };
      p.allocations = picked as AllocRow[];
    } else {
      const want = Math.max(1, src.allocations.length);
      const out: AllocRow[] = [];
      for (const sa of src.allocations.length ? src.allocations : [{ port: -1 }]) {
        const same = free.find((a) => a.port === sa.port && !out.includes(a));
        if (same) out.push(same);
      }
      for (const a of free) if (out.length < want && !out.includes(a)) out.push(a);
      if (out.length < want) return { ...p, blocked: `node ${node.name} has ${free.length} free allocation(s), ${want} needed` };
      // Primaire poort eerst: die van de primaire bronpoort als die vrij was.
      const primaryPort = src.allocations.find((a) => a.primary)?.port;
      out.sort((a, b) => Number(b.port === primaryPort) - Number(a.port === primaryPort));
      p.allocations = out.slice(0, want);
      const changed = src.allocations.filter((sa) => !p.allocations.some((a) => a.port === sa.port)).map((sa) => sa.port);
      if (changed.length) warnings.push(`port(s) ${changed.join(", ")} not free on the target: other ports assigned`);
    }
    for (const a of p.allocations) pc.taken.add(a.id);
  }
  // Bestanden
  if (pc.client?.hasClientKey && probe) {
    try {
      const b = await pc.client.latestBackup(src.identifier);
      if (b) {
        p.method = "backup";
        p.backup = { uuid: b.uuid, name: b.name };
      } else warnings.push("no completed backup in the source");
    } catch (e) {
      warnings.push(`backups not readable: ${(e as Error).message}`);
    }
  }
  if (p.method === "none" && pc.sftp) p.method = "sftp";
  if (p.method === "none") warnings.push("no files are copied (no backup and no SFTP login): the template install runs instead");
  if (src.suspended) warnings.push("suspended in the source: imported as a normal server");
  return p;
}

function ownerLabel(o: Owner | null): string | null {
  if (!o) return null;
  return o.kind === "account" ? o.name : `new account ${o.discordId} (${o.username})`;
}

// ---------- runner ----------

const runners = new Map<number, Promise<void>>();

export function kickImport(id: number): Promise<void> {
  let p = runners.get(id);
  if (!p) {
    p = runImport(id)
      .catch((e) => console.error(`[import] ${id}:`, e))
      .finally(() => runners.delete(id));
    runners.set(id, p);
  }
  return p;
}
export async function waitImports(): Promise<void> {
  while (runners.size) await Promise.allSettled([...runners.values()]);
}

async function setItem(sessionId: number, sourceId: number, patch: Partial<typeof schema.importItems.$inferInsert>) {
  await getDb().update(schema.importItems).set(patch).where(and(eq(schema.importItems.sessionId, sessionId), eq(schema.importItems.sourceServerId, sourceId)));
}

async function ensureOwner(o: Owner, ctxUser: number | null): Promise<number> {
  if (o.kind === "account") return o.id;
  const db = getDb();
  const [u] = await db.insert(schema.users).values({ discordId: o.discordId, name: o.username, email: o.email }).onConflictDoNothing().returning({ id: schema.users.id });
  if (u) {
    await logActivity({ action: "admin.user.create", userId: ctxUser, metadata: { targetUserId: u.id, discordId: o.discordId, source: "import" } });
    return u.id;
  }
  const [x] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.discordId, o.discordId));
  return x!.id;
}

async function runImport(id: number): Promise<void> {
  const db = getDb();
  for (;;) {
    const [r] = await db.select().from(schema.importSessions).where(eq(schema.importSessions.id, id));
    if (!r || r.state !== "running") return;
    const [item] = await db
      .select()
      .from(schema.importItems)
      .where(and(eq(schema.importItems.sessionId, id), eq(schema.importItems.status, "pending")))
      .orderBy(asc(schema.importItems.sourceServerId))
      .limit(1);
    if (!item) break;
    await importOne(r, item);
  }
  const items = await db.select().from(schema.importItems).where(eq(schema.importItems.sessionId, id));
  const allOk = items.every((i) => i.status === "done" || i.status === "skipped");
  const [r] = await db.select().from(schema.importSessions).where(eq(schema.importSessions.id, id));
  if (!r || r.state !== "running") return;
  // Klaar zonder fouten: sleutels wissen (alleen tijdens de import bewaard). Met fouten: blijven voor hervatten.
  await db
    .update(schema.importSessions)
    .set(allOk ? { state: "done", apiKeyEnc: null, clientKeyEnc: null, sftp: null } : { state: "ready" })
    .where(eq(schema.importSessions.id, id));
}

async function importOne(r: SessionRow, item: ItemRow): Promise<void> {
  const db = getDb();
  const snap = snapOf(r);
  const src = snap.servers.find((s) => s.id === item.sourceServerId);
  if (!src) return setItem(r.id, item.sourceServerId, { status: "skipped", error: "no longer in the source", finishedAt: new Date() });
  const pc = await planCtx(r, true);
  const p = await planServer(pc, src, true);
  if (p.blocked) return setItem(r.id, item.sourceServerId, { status: "skipped", error: p.blocked, finishedAt: new Date() });
  await setItem(r.id, item.sourceServerId, { status: "creating", error: null, method: p.method, startedAt: new Date(), finishedAt: null, bytes: 0 });

  const t = p.template!;
  const node = p.node!;
  const uuid = randomUUID();
  let serverId: number | null = null;
  let created = false;
  try {
    assertNotInMaintenance(node);
    const ownerId = await ensureOwner(p.owner!, r.createdBy);
    serverId = await db.transaction(async (tx) => {
      if (p.allocations.length) await checkAllocations(tx, p.allocations.map((a) => a.id), node.id, null);
      const [srv] = await tx
        .insert(schema.servers)
        .values({ uuid, name: src.name.slice(0, 100) || src.identifier, ownerId, nodeId: node.id, templateId: t.id, type: t.type, cpuPct: p.limits.cpuPct, ramMb: p.limits.ramMb, swapMb: p.limits.swapMb, diskMb: p.limits.diskMb, status: p.method === "none" ? "installing" : "offline", installedAt: p.method === "none" ? null : new Date() })
        .returning({ id: schema.servers.id });
      if (p.allocations.length) await assignAllocations(tx, srv!.id, p.allocations.map((a) => a.id));
      const vars = Object.entries(p.values);
      if (vars.length) await tx.insert(schema.serverVariables).values(vars.map(([key, value]) => ({ serverId: srv!.id, key, value })));
      return srv!.id;
    });
    await setItem(r.id, item.sourceServerId, { serverId, newUuid: uuid });
    const spec = buildServerSpec({ uuid, template: t, variables: p.values, limits: p.limits, allocations: p.allocations.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })), skipInstall: p.method !== "none", startOnInstall: false });
    const d = daemonFor(node);
    await call(() => d.createServer(spec));
    created = true;

    if (p.method !== "none") {
      await setItem(r.id, item.sourceServerId, { status: "copying" });
      let bytes = 0;
      let last = 0;
      const onBytes = (n: number) => {
        bytes += n;
        if (Date.now() - last > importerDeps.progressMs) {
          last = Date.now();
          void setItem(r.id, item.sourceServerId, { bytes }).catch(() => undefined);
        }
      };
      if (p.method === "backup") {
        const url = await pc.client!.backupUrl(src.identifier, p.backup!.uuid);
        const stream = await backupTar(url, onBytes);
        await call(() => d.importData(uuid, stream));
      } else {
        const sn = snap.nodes.find((n) => n.id === src.nodeId);
        const sftp = r.sftp!;
        const host = sftp.host || sn?.fqdn;
        if (!host) throw new Error("SFTP: source node unknown; set a host");
        const s = await sftpTar({ host, port: sftp.port ?? sn?.sftpPort ?? 2022, username: `${sftp.username}.${src.identifier}`, password: decrypt(sftp.passwordEnc) }, onBytes);
        try {
          await call(() => d.importData(uuid, s.stream));
        } finally {
          s.close();
        }
      }
      await setItem(r.id, item.sourceServerId, { bytes });
    }
    await setItem(r.id, item.sourceServerId, { status: "done", finishedAt: new Date() });
    await logActivity({ action: "admin.import.server", userId: r.createdBy, serverId, metadata: { serverUuid: uuid, source: r.kind, sourceId: src.id, sourceUuid: src.uuid, method: p.method, template: t.slug, nodeId: node.id, dropped: p.dropped } });
  } catch (e) {
    // Opruimen zodat hervatten schoon opnieuw begint; de bron is niet aangeraakt.
    if (created) await daemonFor(node).deleteServer(uuid).catch(() => undefined);
    if (serverId !== null) {
      await db.transaction(async (tx) => {
        await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, serverId!));
        await tx.delete(schema.servers).where(eq(schema.servers.id, serverId!));
      });
    }
    await setItem(r.id, item.sourceServerId, { status: "failed", error: ((e as Error).message ?? String(e)).slice(0, 1000), serverId: null, newUuid: null, finishedAt: new Date() });
  }
}

// ---------- procedures ----------

async function upsertItems(sessionId: number, snap: Snapshot) {
  if (!snap.servers.length) return;
  await getDb()
    .insert(schema.importItems)
    .values(snap.servers.map((s) => ({ sessionId, sourceServerId: s.id })))
    .onConflictDoNothing();
}

function assertNotRunning(r: SessionRow | null) {
  if (r?.state === "running") throw new TRPCError({ code: "CONFLICT", message: "IMPORT_RUNNING" });
}

export const importer: A = {
  get: async () => {
    const r = await currentRow();
    return r ? sessionOut(r) : null;
  },

  connect: async ({ input, ctx }) => {
    assertNotRunning(await currentRow());
    const url = input.url.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) throw bad("SOURCE_INVALID: URL must start with http(s)://");
    const client = importerDeps.client(url, input.apiKey, input.clientApiKey);
    const snap = await client.snapshot(input.kind);
    const mapping = await proposeMapping(snap, null);
    const db = getDb();
    const row = await db.transaction(async (tx) => {
      await tx.delete(schema.importSessions);
      const [r] = await tx
        .insert(schema.importSessions)
        .values({
          kind: input.kind,
          url,
          apiKeyEnc: encrypt(input.apiKey),
          clientKeyEnc: input.clientApiKey ? encrypt(input.clientApiKey) : null,
          sftp: input.sftp ? { username: input.sftp.username, passwordEnc: encrypt(input.sftp.password), host: input.sftp.host, port: input.sftp.port } : null,
          snapshot: snap,
          mapping,
          createdBy: uid(ctx),
        })
        .returning();
      return r!;
    });
    await upsertItems(row.id, snap);
    await logActivity({ action: "admin.import.connect", userId: uid(ctx), metadata: { kind: input.kind, url, users: snap.users.length, eggs: snap.eggs.length, servers: snap.servers.length }, ip: ctx.ip, ctx });
    return sessionOut(row);
  },

  refresh: async () => {
    const r = await mustRow();
    assertNotRunning(r);
    const snap = await clientOf(r).snapshot(r.kind as SourceKind);
    const mapping = await proposeMapping(snap, mapOf(r));
    const [row] = await getDb().update(schema.importSessions).set({ snapshot: snap, mapping, fetchedAt: new Date() }).where(eq(schema.importSessions.id, r.id)).returning();
    await upsertItems(r.id, snap);
    return sessionOut(row!);
  },

  setMapping: async ({ input }) => {
    const r = await mustRow();
    assertNotRunning(r);
    const db = getDb();
    const snap = snapOf(r);
    const m = structuredClone(mapOf(r));
    if (input.defaultNodeId !== undefined) {
      if (input.defaultNodeId !== null && !(await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.id, input.defaultNodeId))).length) throw bad("NODE_NOT_FOUND");
      m.defaultNodeId = input.defaultNodeId;
    }
    for (const e of input.eggs ?? []) {
      if (!snap.eggs.some((x) => x.id === e.id)) throw bad(`EGG_NOT_FOUND: ${e.id}`);
      if (e.action === "template") {
        if (!e.templateId) throw bad("TEMPLATE_REQUIRED");
        if (!(await db.select({ id: schema.templates.id }).from(schema.templates).where(eq(schema.templates.id, e.templateId))).length) throw bad("TEMPLATE_NOT_FOUND");
      }
      m.eggs[e.id] = { action: e.action, templateId: e.action === "template" ? e.templateId : null };
    }
    for (const u of input.users ?? []) {
      if (!snap.users.some((x) => x.id === u.id)) throw bad(`USER_NOT_FOUND: ${u.id}`);
      if (u.action === "link" && (!u.accountId || !(await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, u.accountId), eq(schema.users.isEmergency, false)))).length)) throw bad("ACCOUNT_NOT_FOUND");
      if (u.action === "create" && !u.discordId) throw bad("DISCORD_ID_REQUIRED");
      m.users[u.id] = { action: u.action, accountId: u.action === "link" ? u.accountId : null, discordId: u.action === "create" ? u.discordId : null, matchedBy: null };
    }
    for (const s of input.servers ?? []) {
      if (!snap.servers.some((x) => x.id === s.id)) throw bad(`SERVER_NOT_FOUND: ${s.id}`);
      if (s.targetNodeId !== null && !(await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.id, s.targetNodeId))).length) throw bad("NODE_NOT_FOUND");
      if (s.allocationIds?.length) {
        const nodeId = s.targetNodeId ?? m.defaultNodeId;
        if (!nodeId) throw bad("NODE_REQUIRED");
        await checkAllocations(db, s.allocationIds, nodeId, null);
      }
      m.servers[s.id] = { include: s.include, targetNodeId: s.targetNodeId, allocationIds: s.allocationIds?.length ? s.allocationIds : null };
    }
    const [row] = await db.update(schema.importSessions).set({ mapping: m }).where(eq(schema.importSessions.id, r.id)).returning();
    // Een server die weer meedoet en eerder overgeslagen werd, komt terug in de wachtrij.
    await db.update(schema.importItems).set({ status: "pending", error: null }).where(and(eq(schema.importItems.sessionId, r.id), eq(schema.importItems.status, "skipped")));
    return sessionOut(row!);
  },

  convertEgg: async ({ input }) => {
    const r = await mustRow();
    const egg = snapOf(r).eggs.find((e) => e.id === input.eggId);
    if (!egg) throw new TRPCError({ code: "NOT_FOUND", message: "EGG_NOT_FOUND" });
    const { yaml, errors } = eggToTemplateYaml(egg, r.kind);
    return { yaml, errors };
  },

  dryRun: async () => {
    const r = await mustRow();
    const pc = await planCtx(r, true);
    const items = await getDb().select().from(schema.importItems).where(eq(schema.importItems.sessionId, r.id));
    const done = new Set(items.filter((i) => i.status === "done").map((i) => i.sourceServerId));
    const out: ImportPlan = { createUsers: [], servers: [], skipped: [] };
    const creates = new Map<string, { sourceId: number; username: string; discordId: string }>();
    for (const src of pc.snap.servers) {
      if (done.has(src.id)) {
        out.skipped.push({ sourceId: src.id, name: src.name, reason: "already imported" });
        continue;
      }
      const p = await planServer(pc, src, true);
      if (p.blocked === "excluded") {
        out.skipped.push({ sourceId: src.id, name: src.name, reason: "excluded" });
        continue;
      }
      if (!p.blocked && p.owner?.kind === "create") creates.set(p.owner.discordId, { sourceId: src.ownerId, username: p.owner.username, discordId: p.owner.discordId });
      out.servers.push({
        sourceId: src.id,
        name: src.name,
        owner: ownerLabel(p.owner),
        template: p.template?.name ?? null,
        node: p.node?.name ?? null,
        ports: p.allocations.map((a) => a.port),
        method: p.method,
        variables: p.values,
        droppedVariables: p.dropped,
        warnings: p.warnings,
        blocked: p.blocked,
      });
    }
    out.createUsers = [...creates.values()];
    return out;
  },

  start: async ({ ctx }) => {
    const r = await mustRow();
    assertNotRunning(r);
    if (!r.apiKeyEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONNECTED: connect to the source again" });
    const db = getDb();
    // Hervatten: mislukte (en onderbroken) servers opnieuw.
    await discardInterrupted(r.id);
    await db.update(schema.importItems).set({ status: "pending", error: null }).where(and(eq(schema.importItems.sessionId, r.id), eq(schema.importItems.status, "failed")));
    const [row] = await db.update(schema.importSessions).set({ state: "running" }).where(and(eq(schema.importSessions.id, r.id), sql`${schema.importSessions.state} <> 'running'`)).returning();
    if (!row) throw new TRPCError({ code: "CONFLICT", message: "IMPORT_RUNNING" });
    await logActivity({ action: "admin.import.start", userId: uid(ctx), metadata: { kind: r.kind, url: r.url }, ip: ctx.ip, ctx });
    void kickImport(r.id);
    return sessionOut(row);
  },

  cancel: async ({ ctx }) => {
    const r = await mustRow();
    const [row] = await getDb().update(schema.importSessions).set({ state: r.state === "running" ? "cancelled" : r.state }).where(eq(schema.importSessions.id, r.id)).returning();
    if (r.state === "running") await logActivity({ action: "admin.import.cancel", userId: uid(ctx), metadata: { kind: r.kind, url: r.url }, ip: ctx.ip, ctx });
    return sessionOut(row!);
  },

  disconnect: async ({ ctx }) => {
    const r = await currentRow();
    if (!r) return { ok: true as const };
    assertNotRunning(r);
    await getDb().delete(schema.importSessions).where(eq(schema.importSessions.id, r.id));
    await logActivity({ action: "admin.import.disconnect", userId: uid(ctx), metadata: { kind: r.kind, url: r.url }, ip: ctx.ip, ctx });
    return { ok: true as const };
  },
};

/** Halve server van een onderbroken poging (panel herstart tijdens aanmaken/kopiëren) opruimen. */
async function discardInterrupted(sessionId: number): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(schema.importItems).where(and(eq(schema.importItems.sessionId, sessionId), inArray(schema.importItems.status, ["creating", "copying"])));
  for (const it of rows) {
    if (it.serverId !== null) {
      const [srv] = await db.select({ s: schema.servers, n: schema.nodes }).from(schema.servers).innerJoin(schema.nodes, eq(schema.nodes.id, schema.servers.nodeId)).where(eq(schema.servers.id, it.serverId));
      if (srv) await daemonFor(srv.n).deleteServer(srv.s.uuid).catch(() => undefined);
      await db.transaction(async (tx) => {
        await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, it.serverId!));
        await tx.delete(schema.servers).where(eq(schema.servers.id, it.serverId!));
      });
    }
    await setItem(sessionId, it.sourceServerId, { status: "pending", error: null, serverId: null, newUuid: null });
  }
}

/** Bij de start van het panel: een import die liep, gaat verder (de server die bezig was opnieuw). */
export async function resumeImports(): Promise<void> {
  const r = await currentRow();
  if (!r || r.state !== "running") return;
  await discardInterrupted(r.id);
  void kickImport(r.id);
}
