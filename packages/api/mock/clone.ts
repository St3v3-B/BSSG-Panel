/** Mock voor "server dupliceren" en verbruiksalarmen (in-memory, alleen voor de UI). */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation, SessionCtx } from "../trpc-builder";

type MockServer = {
  uuid: string;
  shortId: string;
  name: string;
  ownerId: number;
  owner: s.UserPublic;
  type: "game" | "web";
  status: s.ServerStatus;
  limits: s.Limits;
  templateName: string;
  allocations: Array<{ ip: string; port: number; primary: boolean }>;
};

export interface CloneMockDeps {
  servers: () => MockServer[];
  /** Voegt een kopie toe aan de mock-state. */
  addServer: (from: MockServer, o: { uuid: string; name: string; ownerId: number; limits: s.Limits }) => void;
  removeServer: (uuid: string) => void;
  user: (id: number) => s.UserPublic;
  id: () => number;
  freeAllocations: () => number;
  quota: (uid: number) => s.QuotaOverview | null;
}

const STEP_MS = 2500;
const ok = { ok: true as const };
const err = (code: TRPCError["code"], message: string): never => {
  throw new TRPCError({ code, message });
};

export function createCloneMock(deps: CloneMockDeps): {
  servers: Pick<Implementation["servers"], "cloneOptions" | "clone" | "cloneJob" | "clones" | "cancelClone" | "alarms" | "updateAlarms">;
  admin: Pick<Implementation["admin"], "alarms">;
} {
  type Job = s.CloneJob & { startedMs: number; canceled: boolean };
  const jobs: Job[] = [];
  const uidOf = (ctx: { session: SessionCtx | null }) => ctx.session!.userId;
  const srv = (uuid: string) => deps.servers().find((x) => x.uuid === uuid) ?? err("NOT_FOUND", "SERVER_NOT_FOUND");
  const canManage = (x: MockServer, uid: number) => x.ownerId === uid || uid === 1;

  /** Voortgang op basis van de tijd: elke stap ~2,5 s; de bestandsstap telt bytes op. */
  const view = (j: Job): s.CloneJob => {
    const { startedMs: _s, canceled: _c, ...rest } = j;
    if (j.status !== "running") return structuredClone(rest);
    const elapsed = Date.now() - j.startedMs;
    const active = j.steps.filter((x) => x.status !== "skipped");
    const at = Math.floor(elapsed / STEP_MS);
    if (at >= active.length) {
      j.status = "succeeded";
      j.finishedAt = new Date();
      j.bytesCopied = j.bytesTotal ?? 0;
      for (const x of active) x.status = "done";
      const t = deps.servers().find((x) => x.uuid === j.target.uuid);
      if (t) t.status = "offline";
      return view(j);
    }
    active.forEach((x, i) => (x.status = i < at ? "done" : i === at ? "running" : "pending"));
    const filesIdx = active.findIndex((x) => x.key === "files");
    const frac = at > filesIdx ? 1 : at < filesIdx ? 0 : (elapsed - filesIdx * STEP_MS) / STEP_MS;
    j.bytesCopied = Math.round((j.bytesTotal ?? 0) * Math.min(1, frac));
    return structuredClone(rest);
  };

  const notes = (x: MockServer): s.CloneOptions["notes"] => {
    const n: s.CloneOptions["notes"] = [];
    if (x.templateName === "Velocity") n.push("proxy_members_not_cloned");
    if (x.status === "online") n.push("live_copy");
    if (x.type === "web") n.push("domains_not_cloned");
    n.push("subusers_not_cloned");
    return n;
  };

  const defaults: s.AlarmDefaults = { enabled: true, cpuPct: 90, ramPct: 90, durationMinutes: 10, diskPct: 90, cooldownMinutes: 60 };
  const own = new Map<string, { config: s.AlarmConfig | null; notifyOffline: boolean }>();
  const activeFor = (x: MockServer): s.ServerAlarms["active"] =>
    x.status === "online" && x.type === "game" ? [{ metric: "ram", valuePct: 93.4, thresholdPct: 90, since: new Date(Date.now() - 14 * 60_000) }] : [];
  const alarmsOf = (x: MockServer): s.ServerAlarms => {
    const o = own.get(x.uuid);
    const { cooldownMinutes: _c, ...base } = defaults;
    const config = o?.config ?? base;
    return { useDefaults: !o?.config, config, defaults, notifyOffline: o?.notifyOffline ?? true, active: config.enabled ? activeFor(x) : [] };
  };

  return {
    servers: {
      cloneOptions: ({ input, ctx }) => {
        const x = srv(input.uuid);
        const u = uidOf(ctx);
        if (!canManage(x, u)) err("FORBIDDEN", "OWNER_ONLY");
        const q = u === 1 ? null : deps.quota(x.ownerId);
        const running = jobs.find((j) => j.source.uuid === x.uuid && view(j).status === "running");
        return {
          type: x.type,
          limits: x.limits,
          ports: x.type === "game" ? Math.max(1, x.allocations.length) : 0,
          databases: x.type === "web" ? [{ name: "s1_wordpress", copyable: true }] : [],
          quota: q ? { ramMb: q.quota.maxRamMb - q.usage.ramMb, diskMb: q.quota.maxDiskMb - q.usage.diskMb, cpuPct: q.quota.maxCpuPct - q.usage.cpuPct, servers: q.quota.maxServers - q.usage.servers, databases: q.quota.maxDatabases - q.usage.databases } : null,
          allowed: u === 1 || !!q,
          isAdmin: u === 1,
          freeAllocations: deps.freeAllocations(),
          notes: notes(x),
          running: running ? view(running) : null,
        };
      },
      clone: ({ input, ctx }) => {
        const x = srv(input.uuid);
        const u = uidOf(ctx);
        if (!canManage(x, u)) err("FORBIDDEN", "OWNER_ONLY");
        if (u !== 1 && (input.ownerId || input.nodeId || input.allocationIds)) err("FORBIDDEN", "ADMIN_ONLY");
        if (u !== 1) {
          const q = deps.quota(x.ownerId) ?? err("FORBIDDEN", "NO_QUOTA");
          if (q.usage.servers + 1 > q.quota.maxServers) err("PRECONDITION_FAILED", "QUOTA_EXCEEDED: servers");
          const l = input.limits ?? x.limits;
          if (q.usage.ramMb + l.ramMb > q.quota.maxRamMb) err("PRECONDITION_FAILED", "QUOTA_EXCEEDED: ram");
        }
        if (jobs.some((j) => j.source.uuid === x.uuid && view(j).status === "running")) err("CONFLICT", "CLONE_IN_PROGRESS");
        const uuid = crypto.randomUUID();
        const ownerId = input.ownerId ?? x.ownerId;
        deps.addServer(x, { uuid, name: input.name, ownerId, limits: input.limits ? { ...input.limits, swapMb: 0 } : x.limits });
        const copyDb = input.copyDatabases && x.type === "web";
        const steps: s.CloneJob["steps"] = [
          { key: "create", status: "running" },
          { key: "files", status: "pending" },
          { key: "databases", status: copyDb ? "pending" : "skipped" },
          { key: "domain", status: input.domain && x.type === "web" ? "pending" : "skipped" },
          { key: "finish", status: "pending" },
        ];
        const j: Job = {
          id: deps.id(),
          status: "running",
          source: { uuid: x.uuid, name: x.name, exists: true },
          target: { uuid, name: input.name, exists: true },
          steps,
          sameNode: !input.nodeId || input.nodeId === 1,
          live: x.status === "online",
          bytesCopied: 0,
          bytesTotal: 1_850_000_000,
          databases: copyDb ? [{ from: "s1_wordpress", to: `s${deps.id()}_wordpress`, username: `u${deps.id()}_wordpress` }] : [],
          domain: x.type === "web" ? input.domain : null,
          warnings: x.templateName === "Velocity" ? ["The proxy's network members were not cloned."] : [],
          errorCode: null,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          startedMs: Date.now(),
          canceled: false,
        };
        jobs.unshift(j);
        return view(j);
      },
      cloneJob: ({ input }) => view(jobs.find((j) => j.id === input.id) ?? err("NOT_FOUND", "JOB_NOT_FOUND")),
      clones: ({ input }) => jobs.filter((j) => j.source.uuid === input.uuid || j.target.uuid === input.uuid).slice(0, 10).map(view),
      cancelClone: ({ input }) => {
        const j = jobs.find((x) => x.id === input.id) ?? err("NOT_FOUND", "JOB_NOT_FOUND");
        if (view(j).status !== "running") err("CONFLICT", "CLONE_NOT_RUNNING");
        j.status = "canceled";
        j.finishedAt = new Date();
        j.target.exists = false;
        for (const x of j.steps) if (x.status === "running" || x.status === "pending") x.status = x.status === "running" ? "failed" : "skipped";
        deps.removeServer(j.target.uuid);
        return ok;
      },
      alarms: ({ input }) => alarmsOf(srv(input.uuid)),
      updateAlarms: ({ input }) => {
        const x = srv(input.uuid);
        own.set(x.uuid, { config: input.config, notifyOffline: input.notifyOffline });
        return alarmsOf(x);
      },
    },
    admin: {
      alarms: {
        defaults: () => ({ ...defaults }),
        setDefaults: ({ input }) => (Object.assign(defaults, input), { ...defaults }),
        active: () =>
          deps
            .servers()
            .filter((x) => alarmsOf(x).active.length)
            .flatMap((x) => alarmsOf(x).active.map((a) => ({ ...a, server: { uuid: x.uuid, name: x.name }, owner: deps.user(x.ownerId) }))),
      },
    },
  };
}
