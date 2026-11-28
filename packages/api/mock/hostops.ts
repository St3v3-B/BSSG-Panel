/**
 * Mock voor admin.maintenance (onderhoud + evacueren) en admin.importer (Pterodactyl/Pelican).
 * Evacuaties en imports lopen "vanzelf": elke opvraging zet één stap verder.
 */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

type MockServer = Omit<s.ServerDetail, "terminal"> & { ownerId: number };

interface Deps {
  nodes: () => s.Node[];
  servers: () => MockServer[];
  users: () => s.UserPublic[];
  templates: () => s.TemplateDetail[];
  id: () => number;
}

const ok = { ok: true as const };
const notFound = (m: string): never => {
  throw new TRPCError({ code: "NOT_FOUND", message: m });
};

/** Een denkbeeldige tweede node als doel, zodat evacueren in de mock iets te kiezen heeft. */
const SPARE = { nodeId: 99, name: "node2" };

const SAMPLE: Omit<s.ImportSession, "id" | "kind" | "url" | "fetchedAt" | "hasClientKey" | "sftpUsername"> = {
  connected: true,
  state: "ready",
  defaultNodeId: 1,
  nodes: [{ id: 1, name: "Wings NL", fqdn: "wings.node1.test", sftpPort: 2022 }],
  users: [
    { id: 1, username: "steve", email: "steve@panel.test", sourceDiscordId: "100000000000000001", serverCount: 1, action: "link", accountId: 1, accountName: "steve", discordId: null, matchedBy: "discord" },
    { id: 2, username: "kees", email: "kees@panel.test", sourceDiscordId: null, serverCount: 1, action: "create", accountId: null, accountName: null, discordId: "300000000000000003", matchedBy: null },
    { id: 3, username: "oud-account", email: null, sourceDiscordId: null, serverCount: 0, action: "skip", accountId: null, accountName: null, discordId: null, matchedBy: null },
  ],
  eggs: [
    { id: 1, nestName: "Minecraft", name: "Paper", dockerImages: ["ghcr.io/pterodactyl/yolks:java_21"], startup: "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}", variables: [{ key: "MINECRAFT_VERSION", name: "Minecraft Version", default: "latest" }, { key: "SERVER_JARFILE", name: "Server Jar File", default: "server.jar" }], serverCount: 1, action: "template", templateId: 1, suggestion: { templateId: 1, templateName: "Paper", score: 85, reasons: ["name", "startup"] } },
    { id: 7, nestName: "Voice Servers", name: "Teamspeak3 Server", dockerImages: ["ghcr.io/parkervcp/yolks:debian"], startup: "./ts3server", variables: [], serverCount: 1, action: "skip", templateId: null, suggestion: null },
  ],
  servers: [
    { id: 11, uuid: "5b0c6a1e-0000-4000-8000-000000000011", identifier: "5b0c6a1e", name: "Survival", ownerId: 1, eggId: 1, sourceNodeId: 1, sourceNodeName: "Wings NL", limits: { ramMb: 4096, swapMb: 0, diskMb: 20000, cpuPct: 200 }, allocations: [{ ip: "0.0.0.0", port: 25565, primary: true }], variables: { MINECRAFT_VERSION: "1.21.4", SERVER_JARFILE: "server.jar" }, suspended: false, include: true, targetNodeId: null, allocationIds: null, status: "pending", error: null, method: null, newUuid: null, bytes: 0, startedAt: null, finishedAt: null },
    { id: 12, uuid: "7d1e2f3a-0000-4000-8000-000000000012", identifier: "7d1e2f3a", name: "Creatief", ownerId: 2, eggId: 1, sourceNodeId: 1, sourceNodeName: "Wings NL", limits: { ramMb: 2048, swapMb: 0, diskMb: 10000, cpuPct: 100 }, allocations: [{ ip: "0.0.0.0", port: 25566, primary: true }], variables: { MINECRAFT_VERSION: "1.21.4" }, suspended: false, include: true, targetNodeId: null, allocationIds: null, status: "pending", error: null, method: null, newUuid: null, bytes: 0, startedAt: null, finishedAt: null },
    { id: 13, uuid: "9a8b7c6d-0000-4000-8000-000000000013", identifier: "9a8b7c6d", name: "TS3", ownerId: 2, eggId: 7, sourceNodeId: 1, sourceNodeName: "Wings NL", limits: { ramMb: 512, swapMb: 0, diskMb: 1000, cpuPct: 50 }, allocations: [{ ip: "0.0.0.0", port: 9987, primary: true }], variables: {}, suspended: false, include: true, targetNodeId: null, allocationIds: null, status: "pending", error: null, method: null, newUuid: null, bytes: 0, startedAt: null, finishedAt: null },
  ],
  warnings: [],
};

export function createHostopsMock(d: Deps): { maintenance: Implementation["admin"]["maintenance"]; importer: Implementation["admin"]["importer"] } {
  const evacuations: s.Evacuation[] = [];
  let session: s.ImportSession | null = null;
  const node = (id: number) => d.nodes().find((n) => n.id === id) ?? notFound("NODE_NOT_FOUND");
  const onNode = (n: s.Node) => d.servers().filter((x) => x.node.id === n.id);

  const step = (ev: s.Evacuation) => {
    if (ev.status !== "running") return;
    const running = ev.items.find((i) => i.status === "running");
    if (running) {
      const x = d.servers().find((sv) => sv.uuid === running.serverUuid);
      const fail = x?.type === "web" && ev.items.indexOf(running) % 2 === 1;
      running.status = fail ? "failed" : "done";
      running.finishedAt = new Date();
      if (fail) running.error = "NO_FREE_ALLOCATION: node node2 has 0 free allocation(s), 1 needed";
      else {
        running.newAddress = x?.type === "game" ? "203.0.113.20:25565" : null;
        running.dns = x?.type === "web" ? [{ hostname: x.primaryAddress ?? "site.panel.test", type: "A", value: "203.0.113.20", changed: true }] : [];
      }
      return;
    }
    const next = ev.items.find((i) => i.status === "queued");
    if (next) {
      next.status = "running";
      next.startedAt = new Date();
      next.targetNodeId ??= SPARE.nodeId;
      next.targetNodeName ??= SPARE.name;
    } else {
      ev.status = "completed";
      ev.finishedAt = new Date();
    }
  };

  const target = (n: s.Node, x: MockServer): s.EvacuationTarget[] => [
    { nodeId: SPARE.nodeId, name: SPARE.name, fits: true, reason: null, freeRamMb: 12_000, freeDiskMb: 400_000, freeAllocations: 20, sameHttpMode: true },
    ...d
      .nodes()
      .filter((o) => o.id !== n.id)
      .map((o) => ({ nodeId: o.id, name: o.name, fits: !o.maintenance && (x.type !== "web" || o.supportsDomains), reason: o.maintenance ? "MAINTENANCE" : x.type === "web" && !o.supportsDomains ? "NO_DOMAINS" : null, freeRamMb: null, freeDiskMb: null, freeAllocations: 5, sameHttpMode: o.httpRelayNodeId === n.httpRelayNodeId })),
  ];

  const maintenance: Implementation["admin"]["maintenance"] = {
    set: ({ input }) => {
      const n = node(input.id);
      n.maintenance = { since: n.maintenance?.since ?? new Date(), message: input.message, plannedStart: input.plannedStart, plannedEnd: input.plannedEnd };
      for (const x of onNode(n)) x.maintenance = n.maintenance;
      return n;
    },
    end: ({ input }) => {
      const n = node(input.id);
      n.maintenance = null;
      for (const x of onNode(n)) x.maintenance = null;
      for (const ev of evacuations.filter((e) => e.nodeId === n.id && e.status === "running")) {
        ev.status = "cancelled";
        for (const i of ev.items) if (i.status === "queued") i.status = "cancelled";
      }
      return n;
    },
    plan: ({ input }) => {
      const n = node(input.id);
      const list = onNode(n).filter((x) => !input.uuids?.length || input.uuids.includes(x.uuid));
      return {
        nodeId: n.id,
        items: list.map((x) => ({ uuid: x.uuid, name: x.name, type: x.type, ownerName: x.owner.name, ramMb: x.limits.ramMb, diskMb: x.limits.diskMb, allocations: x.type === "web" ? 0 : Math.max(1, x.allocations.length), hasDomains: x.type === "web", suggestedNodeId: SPARE.nodeId, targets: target(n, x) })),
      };
    },
    evacuate: ({ input }) => {
      const n = node(input.id);
      if (!n.maintenance) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NODE_NOT_IN_MAINTENANCE" });
      if (evacuations.some((e) => e.nodeId === n.id && e.status === "running")) throw new TRPCError({ code: "CONFLICT", message: "EVACUATION_RUNNING" });
      const ev: s.Evacuation = {
        id: d.id(),
        nodeId: n.id,
        status: "running",
        concurrency: input.concurrency,
        createdAt: new Date(),
        finishedAt: null,
        items: input.items.map((it) => {
          const x = d.servers().find((sv) => sv.uuid === it.uuid) ?? notFound("SERVER_NOT_FOUND");
          const t = it.nodeId ? (d.nodes().find((o) => o.id === it.nodeId) ?? null) : null;
          return { id: d.id(), serverUuid: x.uuid, serverName: x.name, targetNodeId: t?.id ?? (it.nodeId ?? null), targetNodeName: t?.name ?? (it.nodeId === SPARE.nodeId ? SPARE.name : null), auto: it.nodeId === null, status: "queued", error: null, newAddress: null, dns: [], startedAt: null, finishedAt: null };
        }),
      };
      evacuations.push(ev);
      return ev;
    },
    evacuation: ({ input }) => {
      const ev = [...evacuations].reverse().find((e) => e.nodeId === input.id) ?? null;
      if (ev) step(ev);
      return ev;
    },
    cancel: ({ input }) => {
      const ev = [...evacuations].reverse().find((e) => e.nodeId === input.id) ?? notFound("NO_EVACUATION");
      for (const i of ev.items) if (i.status === "queued") i.status = "cancelled";
      if (ev.status === "running") ev.status = "cancelled";
      return ev;
    },
  };

  const must = () => session ?? notFound("NO_IMPORT");
  const plan = (x: s.ImportSession): s.ImportPlan => {
    const out: s.ImportPlan = { createUsers: [], servers: [], skipped: [] };
    for (const sv of x.servers) {
      if (!sv.include) {
        out.skipped.push({ sourceId: sv.id, name: sv.name, reason: "excluded" });
        continue;
      }
      if (sv.status === "done") {
        out.skipped.push({ sourceId: sv.id, name: sv.name, reason: "already imported" });
        continue;
      }
      const u = x.users.find((y) => y.id === sv.ownerId);
      const e = x.eggs.find((y) => y.id === sv.eggId);
      const t = e?.templateId ? d.templates().find((y) => y.id === e.templateId) : undefined;
      const blocked = !u || u.action === "skip" ? `owner ${u?.username ?? sv.ownerId} is skipped` : !e || e.action === "skip" || !t ? `egg ${e?.name ?? sv.eggId} is not mapped to a template` : null;
      if (!blocked && u?.action === "create" && u.discordId && !out.createUsers.some((c) => c.discordId === u.discordId)) out.createUsers.push({ sourceId: u.id, username: u.username, discordId: u.discordId });
      const keys = new Set(t?.variables.map((v) => v.key) ?? []);
      out.servers.push({
        sourceId: sv.id,
        name: sv.name,
        owner: u ? (u.action === "link" ? u.accountName : `new account ${u.discordId} (${u.username})`) : null,
        template: t?.name ?? null,
        node: d.nodes().find((n) => n.id === (sv.targetNodeId ?? x.defaultNodeId))?.name ?? null,
        ports: sv.allocations.map((a) => a.port),
        method: x.hasClientKey ? "backup" : x.sftpUsername ? "sftp" : "none",
        variables: Object.fromEntries(Object.entries(sv.variables).filter(([k]) => keys.has(k))),
        droppedVariables: Object.keys(sv.variables).filter((k) => !keys.has(k)),
        warnings: x.hasClientKey || x.sftpUsername ? [] : ["no files are copied (no backup and no SFTP login): the template install runs instead"],
        blocked,
      });
    }
    return out;
  };
  const advance = (x: s.ImportSession) => {
    if (x.state !== "running") return;
    const busy = x.servers.find((sv) => sv.status === "creating" || sv.status === "copying");
    if (busy) {
      if (busy.status === "creating") {
        busy.status = "copying";
        busy.bytes = 150 * 1024 * 1024;
      } else {
        busy.status = "done";
        busy.newUuid = crypto.randomUUID();
        busy.finishedAt = new Date();
      }
      return;
    }
    const p = plan(x);
    const next = x.servers.find((sv) => sv.status === "pending" && sv.include);
    if (!next) {
      x.state = "done";
      x.connected = false;
      return;
    }
    const pl = p.servers.find((y) => y.sourceId === next.id);
    if (pl?.blocked) {
      next.status = "skipped";
      next.error = pl.blocked;
      return;
    }
    next.status = "creating";
    next.method = pl?.method ?? "none";
    next.startedAt = new Date();
  };

  const importer: Implementation["admin"]["importer"] = {
    get: () => {
      if (session) advance(session);
      return session;
    },
    connect: ({ input }) => {
      if (session?.state === "running") throw new TRPCError({ code: "CONFLICT", message: "IMPORT_RUNNING" });
      session = { ...structuredClone(SAMPLE), id: d.id(), kind: input.kind, url: input.url.replace(/\/+$/, ""), fetchedAt: new Date(), hasClientKey: !!input.clientApiKey, sftpUsername: input.sftp?.username ?? null };
      return session;
    },
    refresh: () => ((must().fetchedAt = new Date()), must()),
    setMapping: ({ input }) => {
      const x = must();
      if (input.defaultNodeId !== undefined) x.defaultNodeId = input.defaultNodeId;
      for (const e of input.eggs ?? []) Object.assign(x.eggs.find((y) => y.id === e.id) ?? notFound("EGG_NOT_FOUND"), { action: e.action, templateId: e.action === "template" ? e.templateId : null });
      for (const u of input.users ?? []) {
        const acc = u.accountId ? d.users().find((y) => y.id === u.accountId) : undefined;
        Object.assign(x.users.find((y) => y.id === u.id) ?? notFound("USER_NOT_FOUND"), { action: u.action, accountId: u.action === "link" ? u.accountId : null, accountName: acc?.name ?? null, discordId: u.action === "create" ? u.discordId : null, matchedBy: null });
      }
      for (const sv of input.servers ?? []) Object.assign(x.servers.find((y) => y.id === sv.id) ?? notFound("SERVER_NOT_FOUND"), { include: sv.include, targetNodeId: sv.targetNodeId, allocationIds: sv.allocationIds });
      for (const sv of x.servers) if (sv.status === "skipped") sv.status = "pending";
      return x;
    },
    convertEgg: ({ input }) => {
      const e = must().eggs.find((y) => y.id === input.eggId) ?? notFound("EGG_NOT_FOUND");
      const slug = `egg-${e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      return {
        yaml: `# Converted from egg "${e.name}". Review before saving:\n# - check that the image runs as a non-root user (uid 1000)\nschema: 1\nslug: ${slug}\nname: ${e.name}\ntype: game\nversion: 1\nimage: ${e.dockerImages[0] ?? "alpine:3.20"}\nstartup: ${JSON.stringify(e.startup)}\nstop:\n  type: signal\n  value: SIGINT\nready_pattern: "."\ninstall:\n  image: alpine:3.20\n  script: echo install\n`,
        errors: [],
      };
    },
    dryRun: () => plan(must()),
    start: () => {
      const x = must();
      if (x.state === "running") throw new TRPCError({ code: "CONFLICT", message: "IMPORT_RUNNING" });
      for (const sv of x.servers) if (sv.status === "failed") sv.status = "pending";
      x.state = "running";
      return x;
    },
    cancel: () => {
      const x = must();
      if (x.state === "running") x.state = "cancelled";
      return x;
    },
    disconnect: () => ((session = null), ok),
  };
  return { maintenance, importer };
}
