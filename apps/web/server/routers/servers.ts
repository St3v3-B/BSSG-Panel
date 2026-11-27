import { type Implementation, type ServerStatus } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { activityPage } from "../activity-query";
import { DaemonHttpError, DaemonUnreachableError, call, daemonFor, nodeHost, toTrpcError } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { signBrowserJwt } from "../lib/jwt";
import { buildServerSpec, templateSleepCapable, validateVariables } from "../spec";
import { serverNetwork } from "../network";
import { forbidApiKey } from "../apikey";
import { imagePolicyOf, fetchServers, limitsOf, sleepOf, autoRestartOf, requireServer, isSuspendedFor, serverVariables, toDetail, toSummary, type ServerBundle } from "../servers-data";

const ok = { ok: true as const };
const LIVE_TIMEOUT_MS = 1500;

/** Spec zoals hij nu in de database staat. */
export async function currentSpec(b: ServerBundle, opts: { startOnInstall?: boolean; skipInstall?: boolean } = {}) {
  return buildServerSpec({
    uuid: b.server.uuid,
    template: b.template,
    variables: await serverVariables(b.server.id),
    limits: limitsOf(b.server),
    allocations: b.allocations,
    sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server), imagePolicy: imagePolicyOf(b.server),
    ...opts,
  });
}

/** Status live bij de daemon (korte timeout), anders uit de database. Werkt de database bij. */
export async function liveState(b: ServerBundle): Promise<{ status: ServerStatus; installedAt: Date | null }> {
  const fallback = { status: b.server.status, installedAt: b.server.installedAt };
  let st;
  try {
    st = await daemonFor(b.node).getServer(b.server.uuid, LIVE_TIMEOUT_MS);
  } catch (e) {
    // Onbereikbaar (of geen token voor die node): status onbekend, niet de DB-status.
    if (e instanceof DaemonUnreachableError || e instanceof TRPCError) return { ...fallback, status: "unknown" };
    if (e instanceof DaemonHttpError) return fallback;
    throw e;
  }
  const status = st.state as ServerStatus;
  const installedAt = b.server.installedAt ?? (st.installed_at ? new Date(st.installed_at) : null);
  if (status !== b.server.status || installedAt?.getTime() !== b.server.installedAt?.getTime()) {
    await getDb().update(schema.servers).set({ status, installedAt }).where(eq(schema.servers.id, b.server.id));
  }
  return { status, installedAt };
}

/** Status per server via één GET /api/servers per node; onbereikbare node → unknown. */
export async function liveStatuses(rows: ServerBundle[]): Promise<Map<string, ServerStatus>> {
  const out = new Map<string, ServerStatus>();
  const byNode = new Map<number, ServerBundle[]>();
  for (const b of rows) byNode.set(b.node.id, [...(byNode.get(b.node.id) ?? []), b]);
  await Promise.all(
    [...byNode.values()].map(async (list) => {
      let states;
      try {
        states = await daemonFor(list[0]!.node).listServers(LIVE_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof DaemonUnreachableError || e instanceof TRPCError) for (const b of list) out.set(b.server.uuid, "unknown");
        return; // HTTP-fout: DB-status
      }
      const m = new Map(states.map((st) => [st.uuid, st.state as ServerStatus]));
      for (const b of list) {
        const st = m.get(b.server.uuid);
        if (st) out.set(b.server.uuid, st);
      }
    }),
  );
  return out;
}

export const servers: Pick<
  Implementation["servers"],
  "list" | "get" | "stats" | "power" | "sendCommand" | "consoleToken" | "rename" | "updateVariables" | "reinstall" | "activity" | "updateSleep" | "updateImagePolicy" | "updateImageNow"
> = {
  list: async ({ ctx }) => {
    const uid = ctx.session!.userId;
    const subOf = getDb().select({ id: schema.subusers.serverId }).from(schema.subusers).where(eq(schema.subusers.userId, uid));
    const rows = await fetchServers(or(eq(schema.servers.ownerId, uid), inArray(schema.servers.id, subOf)));
    const live = await liveStatuses(rows);
    return rows.map((b) => toSummary(b, uid, live.get(b.server.uuid)));
  },

  get: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    const [live, vars, [viewer], net] = await Promise.all([
      liveState(a.bundle),
      serverVariables(a.bundle.server.id),
      getDb().select().from(schema.users).where(eq(schema.users.id, ctx.session!.userId)),
      serverNetwork(a.bundle),
    ]);
    return toDetail(a.bundle, { id: viewer!.id, name: viewer!.name, discordId: viewer!.discordId }, a.permissions, vars, live, net);
  },

  stats: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "console.read");
    let st;
    try {
      st = await daemonFor(a.bundle.node).stats(input.uuid, 5000);
    } catch (e) {
      if (e instanceof DaemonHttpError && e.status === 404) return null;
      throw toTrpcError(e);
    }
    return {
      cpuPct: st.cpu_pct,
      memoryBytes: st.memory_bytes,
      memoryLimitBytes: st.memory_limit_bytes,
      networkRxBytes: st.network_rx_bytes,
      networkTxBytes: st.network_tx_bytes,
      diskBytes: st.disk_bytes,
      diskLimitBytes: st.disk_limit_bytes,
      uptimeMs: st.uptime_ms,
    };
  },

  power: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "power", { mutates: input.action === "start" || input.action === "restart" });
    await call(() => daemonFor(a.bundle.node).power(input.uuid, input.action));
    await logActivity({ action: `server.power.${input.action}`, userId: ctx.session!.userId, serverId: a.bundle.server.id, ip: ctx.ip, ctx });
    return ok;
  },

  sendCommand: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "console.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).sendCommands(input.uuid, [input.command]));
    await logActivity({ action: "server.console.command", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { command: input.command }, ip: ctx.ip, ctx });
    return ok;
  },

  consoleToken: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "console.read");
    const env = getEnv();
    const { token, claims } = await signBrowserJwt({
      iss: env.PANEL_URL,
      aud: a.bundle.node.fqdn,
      sub: String(ctx.session!.userId),
      serverUuid: a.bundle.server.uuid,
      // Opgeschort: alleen-lezen console (geen console.write/power).
      permissions: isSuspendedFor(ctx, a.bundle) ? a.permissions.filter((p) => p === "console.read") : a.permissions,
    });
    return { token, socketUrl: `wss://${nodeHost(a.bundle.node)}/api/servers/${a.bundle.server.uuid}/ws`, expiresAt: new Date(claims.exp * 1000) };
  },

  rename: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const name = input.name.trim();
    if (!name) throw new TRPCError({ code: "BAD_REQUEST", message: "NAME_EMPTY" });
    await getDb().update(schema.servers).set({ name }).where(eq(schema.servers.id, a.bundle.server.id));
    await logActivity({ action: "server.rename", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { from: a.bundle.server.name, to: name }, ip: ctx.ip, ctx });
    return ok;
  },

  updateVariables: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    const errors = validateVariables(b.template.variables, input.variables, { onlyUserEditable: !ctx.session!.isAdmin });
    if (errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: `INVALID_VARIABLES: ${errors.join("; ")}` });
    const merged = { ...(await serverVariables(b.server.id)), ...input.variables };
    const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: merged, limits: limitsOf(b.server), allocations: b.allocations, skipInstall: true, sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server) });
    await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
    const entries = Object.entries(input.variables);
    if (entries.length) {
      await getDb()
        .insert(schema.serverVariables)
        .values(entries.map(([key, value]) => ({ serverId: b.server.id, key, value })))
        .onConflictDoUpdate({ target: [schema.serverVariables.serverId, schema.serverVariables.key], set: { value: sql`excluded.value` } });
    }
    await logActivity({ action: "server.variables.update", userId: ctx.session!.userId, serverId: b.server.id, metadata: { keys: entries.map(([k]) => k) }, ip: ctx.ip, ctx });
    return ok;
  },

  updateSleep: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    if (b.server.type !== "game" || !templateSleepCapable(b.template)) throw new TRPCError({ code: "BAD_REQUEST", message: "SLEEP_NOT_SUPPORTED" });
    const next = { ...b.server, sleepEnabled: input.enabled, sleepIdleMinutes: input.idleMinutes };
    await call(async () => daemonFor(b.node).updateServer(b.server.uuid, await currentSpec({ ...b, server: next }, { skipInstall: true })));
    await getDb().update(schema.servers).set({ sleepEnabled: input.enabled, sleepIdleMinutes: input.idleMinutes }).where(eq(schema.servers.id, b.server.id));
    await logActivity({ action: "server.sleep.update", userId: ctx.session!.userId, serverId: b.server.id, metadata: { enabled: input.enabled, idleMinutes: input.idleMinutes }, ip: ctx.ip, ctx });
    return ok;
  },

  updateImagePolicy: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    const next = { ...b.server, imageUpdatePolicy: input.policy };
    await call(async () => daemonFor(b.node).updateServer(b.server.uuid, await currentSpec({ ...b, server: next }, { skipInstall: true })));
    await getDb().update(schema.servers).set({ imageUpdatePolicy: input.policy }).where(eq(schema.servers.id, b.server.id));
    await logActivity({ action: "server.image.policy", userId: ctx.session!.userId, serverId: b.server.id, metadata: { policy: input.policy ?? "default" }, ip: ctx.ip, ctx });
    return ok;
  },

  updateImageNow: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    await call(() => daemonFor(a.bundle.node).updateServerImage(input.uuid));
    await logActivity({ action: "server.image.update.requested", userId: ctx.session!.userId, serverId: a.bundle.server.id, ip: ctx.ip, ctx });
    return ok;
  },

  reinstall: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    await call(() => daemonFor(a.bundle.node).reinstall(input.uuid));
    await getDb().update(schema.servers).set({ status: "installing" }).where(eq(schema.servers.id, a.bundle.server.id));
    await logActivity({ action: "server.reinstall", userId: ctx.session!.userId, serverId: a.bundle.server.id, ip: ctx.ip, ctx });
    return ok;
  },

  activity: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    const page = await activityPage(and(eq(schema.activityLog.serverId, a.bundle.server.id)), input);
    // Eigenaar en admin zien alles; subusers zien alleen wie wat deed, zonder IP-adressen en
    // metadata (bevat o.a. consolecommando's, bestandspaden en SFTP-gebruikersnamen).
    if (a.canManage) return page;
    return { ...page, items: page.items.map((i) => ({ ...i, ip: null, metadata: {} })) };
  },
};
