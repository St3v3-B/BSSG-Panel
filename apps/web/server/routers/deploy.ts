/** deploy.*: git-deploy voor websites (deploy.read / deploy.manage). Logica in ../deploy.ts. */
import type { Ctx, DeployConfig, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { daemonFor, DaemonHttpError, toTrpcError } from "../daemon";
import {
  builtinKnownHosts,
  cancelDeploy,
  defaultTargetDir,
  generateDeployKey,
  hostFor,
  lastDeploys,
  loadConfig,
  newWebhookId,
  newWebhookSecret,
  normalizePath,
  parseRepoUrl,
  reconcileRunning,
  startDeploy,
  toConfig,
  toDeploy,
  validBranch,
  validTarget,
  type ConfigRow,
} from "../deploy";
import { getDb, schema } from "../db";
import { encrypt } from "../lib/crypto";
import { requireServer, type ServerAccess } from "../servers-data";

const ok = { ok: true as const };

async function site(ctx: Ctx, uuid: string, need: "deploy.read" | "deploy.manage"): Promise<ServerAccess> {
  const a = await requireServer(ctx, uuid, need, { mutates: need === "deploy.manage" });
  if (a.bundle.template.type !== "web") throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_WEBSITE" });
  return a;
}

const canManage = (a: ServerAccess) => a.permissions.includes("deploy.manage");

async function view(a: ServerAccess): Promise<DeployConfig> {
  return toConfig(await loadConfig(a.bundle.server.id), a.bundle, canManage(a));
}

const log = (ctx: Ctx, a: ServerAccess, action: string, metadata: Record<string, unknown> = {}) =>
  logActivity({ action, userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata, ip: ctx.ip, ctx });

async function update(serverId: number, set: Partial<ConfigRow>) {
  await getDb().update(schema.deployConfigs).set({ ...set, updatedAt: new Date() }).where(eq(schema.deployConfigs.serverId, serverId));
}

/** Deploy op id, met rechtencontrole. */
async function deployFor(ctx: Ctx, id: number, need: "deploy.read" | "deploy.manage") {
  const [row] = await getDb().select({ d: schema.deploys, uuid: schema.servers.uuid }).from(schema.deploys).innerJoin(schema.servers, eq(schema.servers.id, schema.deploys.serverId)).where(eq(schema.deploys.id, id));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "DEPLOY_NOT_FOUND" });
  const a = await site(ctx, row.uuid, need);
  return { d: row.d, a };
}

async function who(userId: number | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await getDb().select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
  return u?.name ?? null;
}

/** Hostsleutels via de node; geen SSH-server → BAD_REQUEST HOST_UNREACHABLE. */
async function scan(a: ServerAccess, host: string, port: number) {
  try {
    return await daemonFor(a.bundle.node).scanGitHostKey(host, port);
  } catch (e) {
    if (e instanceof DaemonHttpError && (e.status === 422 || e.status === 400)) throw new TRPCError({ code: "BAD_REQUEST", message: "HOST_UNREACHABLE" });
    throw toTrpcError(e);
  }
}

export const deploy: Implementation["deploy"] = {
  config: async ({ input, ctx }) => view(await site(ctx, input.uuid, "deploy.read")),

  configure: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    const b = a.bundle;
    const remote = parseRepoUrl(input.repoUrl);
    if (!remote) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
    if (!validBranch(input.branch)) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_BRANCH" });
    if ((input.authType === "ssh") !== (remote.scheme === "ssh")) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL: use an SSH address with a deploy key, or https:// otherwise" });
    const target = validTarget(input.targetDir ?? defaultTargetDir(b.template.slug));
    const source = normalizePath(input.sourceDir);
    const shared = input.sharedPaths.map((p) => normalizePath(p));
    if (!target || !source || shared.some((p) => !p || p === "/")) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_PATH" });
    const cur = await loadConfig(b.server.id);
    if (input.authType === "token" && !input.token && !(cur?.tokenEnc && input.token === undefined)) throw new TRPCError({ code: "BAD_REQUEST", message: "TOKEN_REQUIRED" });
    const tokenEnc = input.authType !== "token" ? null : input.token ? encrypt(input.token) : (cur?.tokenEnc ?? null);
    const values = {
      repoUrl: input.repoUrl,
      branch: input.branch,
      authType: input.authType,
      tokenEnc,
      tokenUsername: input.authType === "token" ? input.tokenUsername || null : null,
      targetDir: target,
      sourceDir: source,
      buildCommand: input.buildCommand || null,
      buildImage: input.buildImage,
      sharedPaths: [...new Set(shared as string[])],
      restartAfter: input.restartAfter,
      autoDeploy: input.autoDeploy,
    };
    // SSH: deploy key maken als die er nog niet is; hostsleutels van github/gitlab/bitbucket vanzelf vertrouwen.
    const ssh: Partial<ConfigRow> = {};
    if (remote.scheme === "ssh") {
      if (!cur?.sshPrivateKeyEnc) {
        const k = generateDeployKey(`panel-deploy-${b.server.uuid.slice(0, 8)}`);
        Object.assign(ssh, { sshPrivateKeyEnc: encrypt(k.privateKey), sshPublicKey: k.publicKey });
      }
      const builtin = builtinKnownHosts(remote);
      if (builtin) Object.assign(ssh, { knownHosts: builtin.lines, sshHostFor: hostFor(remote), sshHostKeys: builtin.keys, sshHostTrust: "builtin" });
      else if (cur?.sshHostFor !== hostFor(remote)) Object.assign(ssh, { knownHosts: null, sshHostFor: null, sshHostKeys: null, sshHostTrust: null });
    }
    if (cur) await update(b.server.id, { ...values, ...ssh });
    else await getDb().insert(schema.deployConfigs).values({ serverId: b.server.id, ...values, ...ssh, webhookId: newWebhookId(), webhookSecretEnc: encrypt(newWebhookSecret()) });
    await log(ctx, a, cur ? "server.deploy.config.update" : "server.deploy.config.create", { repoHost: remote.host, branch: input.branch, auth: input.authType, build: !!values.buildCommand });
    return view(a);
  },

  disconnect: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    await getDb().delete(schema.deployConfigs).where(eq(schema.deployConfigs.serverId, a.bundle.server.id));
    await log(ctx, a, "server.deploy.config.delete");
    return ok;
  },

  generateKey: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    if (!(await loadConfig(a.bundle.server.id))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
    const k = generateDeployKey(`panel-deploy-${a.bundle.server.uuid.slice(0, 8)}`);
    await update(a.bundle.server.id, { sshPrivateKeyEnc: encrypt(k.privateKey), sshPublicKey: k.publicKey });
    await log(ctx, a, "server.deploy.key.generate");
    return view(a);
  },

  scanHostKey: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    const r = parseRepoUrl(input.repoUrl);
    if (!r || r.scheme !== "ssh") throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
    const builtin = builtinKnownHosts(r);
    if (builtin) return { host: r.host, port: r.port, keys: builtin.keys, builtin: true };
    const keys = await scan(a, r.host, r.port);
    return { host: r.host, port: r.port, keys: keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint })), builtin: false };
  },

  trustHostKey: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    const c = await loadConfig(a.bundle.server.id);
    if (!c) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
    const r = parseRepoUrl(input.repoUrl);
    if (!r || r.scheme !== "ssh" || input.repoUrl !== c.repoUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
    // Opnieuw ophalen: alleen sleutels die de gebruiker zag en die de host nu nog steeds toont.
    const keys = await scan(a, r.host, r.port);
    const chosen = keys.filter((k) => input.fingerprints.includes(k.fingerprint));
    if (!chosen.length) throw new TRPCError({ code: "CONFLICT", message: "HOST_KEY_MISMATCH" });
    await update(c.serverId, {
      knownHosts: chosen.map((k) => k.known_hosts_line).join("\n"),
      sshHostFor: hostFor(r),
      sshHostKeys: chosen.map((k) => ({ type: k.type, fingerprint: k.fingerprint })),
      sshHostTrust: "confirmed",
    });
    await log(ctx, a, "server.deploy.hostkey.trust", { host: hostFor(r), fingerprints: chosen.map((k) => k.fingerprint) });
    return view(a);
  },

  rotateWebhookSecret: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    if (!(await loadConfig(a.bundle.server.id))) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
    await update(a.bundle.server.id, { webhookSecretEnc: encrypt(newWebhookSecret()) });
    await log(ctx, a, "server.deploy.webhook.rotate");
    return view(a);
  },

  start: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.manage");
    const c = await loadConfig(a.bundle.server.id);
    if (!c) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
    const row = await startDeploy(a.bundle, c, "manual", ctx.session!.userId, ctx);
    return toDeploy(row, input.uuid, await who(row.userId));
  },

  cancel: async ({ input, ctx }) => {
    const { d, a } = await deployFor(ctx, input.id, "deploy.manage");
    await cancelDeploy(a.bundle, d);
    await log(ctx, a, "server.deploy.cancel", { id: d.id });
    return ok;
  },

  list: async ({ input, ctx }) => {
    const a = await site(ctx, input.uuid, "deploy.read");
    const before = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : undefined;
    const rows = await lastDeploys(a.bundle.server.id, input.limit + 1, before);
    const items = await Promise.all(rows.slice(0, input.limit).map(async (r) => toDeploy((await reconcileRunning(a.bundle, r.d)).row, input.uuid, r.who)));
    return { items, nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.d.id) : null };
  },

  get: async ({ input, ctx }) => {
    const { d, a } = await deployFor(ctx, input.id, "deploy.read");
    const { row, progress } = await reconcileRunning(a.bundle, d);
    const base = toDeploy(row, a.bundle.server.uuid, await who(row.userId));
    if (progress) {
      return {
        ...base,
        commitSha: progress.commit?.sha ?? base.commitSha,
        commitAuthor: progress.commit?.author ?? base.commitAuthor,
        commitMessage: progress.commit?.message ?? base.commitMessage,
        commitDate: progress.commit?.date ? new Date(progress.commit.date) : base.commitDate,
        log: progress.log,
        phase: progress.phase,
        cancellable: progress.cancellable,
      };
    }
    return { ...base, log: row.log, phase: null, cancellable: false };
  },
};
