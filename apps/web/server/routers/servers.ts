import { cloneTargetBusy } from "../clone";
import { publishBusy } from "../publish";
import { type Implementation, type ServerStatus } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { activityPage } from "../activity-query";
import { DaemonHttpError, call, daemonFor, nodeHost, toTrpcError } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { applyServerState, getNodeLive, resolveStatus } from "../node-cache";
import { signBrowserJwt } from "../lib/jwt";
import { buildServerSpec, templateSleepCapable, validateVariables } from "../spec";
import { serverNetwork } from "../network";
import { getTerminalEnabled } from "../settings";
import { forbidApiKey, keyAllowsServer } from "../apikey";
import { imagePolicyOf, isFullAdmin, fetchServers, limitsOf, sleepOf, autoRestartOf, requireServer, isSuspendedFor, serverVariables, toDetail, toSummary, liveViews, type ServerBundle } from "../servers-data";

const ok = { ok: true as const };
const POWER_STATE: Record<"start" | "stop" | "restart" | "kill", ServerStatus> = { start: "starting", stop: "stopping", restart: "stopping", kill: "offline" };

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

export const servers: Pick<
  Implementation["servers"],
  "list" | "get" | "stats" | "power" | "sendCommand" | "consoleToken" | "terminalToken" | "rename" | "updateVariables" | "reinstall" | "activity" | "updateSleep" | "updateImagePolicy" | "updateImageNow"
> = {
  list: async ({ input, ctx }) => {
    const uid = ctx.session!.userId;
    let rows;
    if (input?.all) {
      forbidApiKey(ctx);
      if (!isFullAdmin(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_ADMIN" });
      rows = await fetchServers(undefined);
    } else {
      const subOf = getDb().select({ id: schema.subusers.serverId }).from(schema.subusers).where(eq(schema.subusers.userId, uid));
      rows = await fetchServers(or(eq(schema.servers.ownerId, uid), inArray(schema.servers.id, subOf)));
    }
    rows = rows.filter((b) => keyAllowsServer(ctx, b.server.id));
    const live = await liveViews(rows);
    return rows.map((b) => {
      const l = live.get(b.server.uuid);
      return toSummary(b, uid, l?.status, l?.lastSeenAt);
    });
  },

  get: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    const [live, vars, [viewer], net, terminalGlobal] = await Promise.all([
      liveViews([a.bundle]).then((m) => m.get(a.bundle.server.uuid)!),
      serverVariables(a.bundle.server.id),
      getDb().select().from(schema.users).where(eq(schema.users.id, ctx.session!.userId)),
      serverNetwork(a.bundle),
      getTerminalEnabled(),
    ]);
    return toDetail(a.bundle, { id: viewer!.id, name: viewer!.name, discordId: viewer!.discordId }, a.permissions, vars, { status: live.status, lastSeenAt: live.lastSeenAt, installedAt: a.bundle.server.installedAt ?? live.installedAt }, net, terminalGlobal);
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
    // Een kopie wordt nog gevuld: niet starten (de daemon weigert dan het uitpakken).
    if (await cloneTargetBusy(a.bundle.server.id)) throw new TRPCError({ code: "CONFLICT", message: "CLONE_IN_PROGRESS" });
    // Publiceren (staging → productie) stopt en start de site zelf.
    if (await publishBusy(a.bundle.server.id)) throw new TRPCError({ code: "CONFLICT", message: "PUBLISH_IN_PROGRESS" });
    await call(() => daemonFor(a.bundle.node).power(input.uuid, input.action));
    // Cache direct bijwerken; de daemon pusht de echte status en de monitor corrigeert zo nodig.
    // Niet op "starting" zetten als de server al draait: anders blijft een start-klik op een
    // online server (of een herhaalde start) de status op "starting" houden.
    const live = await getNodeLive(a.bundle.node.id).catch(() => null);
    const current = resolveStatus(live, input.uuid, a.bundle.server.status).status;
    const alreadyUp = input.action === "start" && (current === "online" || current === "starting");
    if (!alreadyUp) await applyServerState(a.bundle.node.id, input.uuid, POWER_STATE[input.action]).catch(() => {});
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

  terminalToken: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "terminal", { mutates: true });
    // Een shell kan alle bestanden wijzigen: zonder files.write geen terminal (ook niet via een beperkte sleutel).
    if (!a.permissions.includes("files.write")) throw new TRPCError({ code: "FORBIDDEN", message: "MISSING_PERMISSION: files.write" });
    if (!a.bundle.server.terminalAllowed || !(await getTerminalEnabled())) throw new TRPCError({ code: "FORBIDDEN", message: "TERMINAL_DISABLED" });
    const { token, claims } = await signBrowserJwt({
      iss: getEnv().PANEL_URL,
      aud: a.bundle.node.fqdn,
      sub: String(ctx.session!.userId),
      serverUuid: a.bundle.server.uuid,
      permissions: ["terminal"],
      extra: { purpose: "terminal" },
    });
    if (!input.refresh) await logActivity({ action: "server.terminal.open", userId: ctx.session!.userId, serverId: a.bundle.server.id, ip: ctx.ip, ctx });
    return { token, socketUrl: `wss://${nodeHost(a.bundle.node)}/api/servers/${a.bundle.server.uuid}/terminal`, expiresAt: new Date(claims.exp * 1000) };
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
    await applyServerState(a.bundle.node.id, input.uuid, "installing").catch(() => {});
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
