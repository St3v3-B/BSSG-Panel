/**
 * Git-deploy voor websites: validatie, deploy keys, bekende hosts, webhooks en het starten/afronden van
 * een deploy. De procedures staan in routers/deploy.ts; de daemon doet het echte werk (openapi.yaml, deploy).
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Ctx, Deploy, DeployBuildImage, DeployConfig, DaemonSchemas } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { logActivity } from "./activity";
import { call, daemonFor, DaemonHttpError, DaemonUnreachableError } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { decrypt, randomToken, safeEqual } from "./lib/crypto";
import { notify, targetForServer } from "./notify";
import { publishBusy } from "./publish";
import type { ServerBundle } from "./servers-data";

export type ConfigRow = typeof schema.deployConfigs.$inferSelect;
export type DeployRow = typeof schema.deploys.$inferSelect;

// ---------- validatie ----------

export interface Remote {
  scheme: "https" | "ssh";
  host: string;
  port: number;
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SCP_RE = /^([A-Za-z0-9._-]{1,64})@([A-Za-z0-9.-]{1,253}):([A-Za-z0-9._~/][A-Za-z0-9._~/+-]{0,400})$/;
const PATH_RE = /^\/[A-Za-z0-9._~/+@-]{1,400}$/;
const BRANCH_RE = /^[A-Za-z0-9._/+-]{1,200}$/;

function privateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  if (isIP(h) === 6) return true; // IPv6-literals niet toestaan (ook ::1, fc00::/7, …)
  return false;
}

/**
 * Zelfde regels als de daemon (internal/deploy/validate.go), plus: geen localhost/privé-IP's.
 * Toegestaan: https://host[:poort]/pad, ssh://[user@]host[:poort]/pad, user@host:pad.
 */
export function parseRepoUrl(raw: string): Remote | null {
  if (!raw || raw.length > 500 || raw.startsWith("-") || raw.includes("::")) return null;
  if (/[\s\x00-\x1f\x7f\\"'`$;|&]/.test(raw)) return null;
  const scp = SCP_RE.exec(raw);
  if (scp && !raw.includes("://")) {
    const host = scp[2]!;
    if (!HOST_RE.test(host) || scp[3]!.startsWith("-") || scp[3]!.includes("..") || privateHost(host)) return null;
    return { scheme: "ssh", host: host.toLowerCase(), port: 22 };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "ssh:") return null;
  if (u.search || u.hash || raw.includes("?") || raw.includes("#")) return null;
  const host = u.hostname;
  if (!host || host.startsWith("-") || !HOST_RE.test(host) || privateHost(host)) return null;
  if (u.password) return null;
  if (u.username && (u.protocol === "https:" || !/^[A-Za-z0-9._-]{1,64}$/.test(u.username))) return null;
  if (!PATH_RE.test(u.pathname) || u.pathname.includes("..")) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 22;
  return { scheme: u.protocol === "https:" ? "https" : "ssh", host: host.toLowerCase(), port };
}

export function validBranch(b: string): boolean {
  return (
    BRANCH_RE.test(b) &&
    !b.startsWith("-") && !b.startsWith("/") && !b.startsWith(".") && !b.endsWith("/") && !b.endsWith(".") && !b.endsWith(".lock") &&
    !b.includes("..") && !b.includes("//") && !b.includes("/.") && b !== "HEAD"
  );
}

/** "/a/./b/" → "/a/b"; null bij ".." boven de root of rare tekens. */
export function normalizePath(p: string): string | null {
  if (/[\x00-\x1f]/.test(p) || !p.startsWith("/")) return null;
  const parts: string[] = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === "..") return null;
    if (c.length > 255) return null;
    parts.push(c);
  }
  return "/" + parts.join("/");
}

const STAGE = "/.panel-deploy";

export function validTarget(p: string): string | null {
  const n = normalizePath(p);
  if (!n || n === "/" || n === STAGE || n.startsWith(STAGE + "/")) return null;
  return n;
}

/** Standaard-doelmap per template: Node.js-apps in /app, de rest (nginx/PHP) in de webroot /public. */
export const defaultTargetDir = (templateSlug: string) => (templateSlug === "node" || templateSlug.startsWith("node-") ? "/app" : "/public");

export function buildImageFor(choice: DeployBuildImage, siteImage: string): string {
  return choice === "site" ? siteImage : choice;
}

// ---------- SSH ----------

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const sshString = (b: Buffer | string) => {
  const buf = typeof b === "string" ? Buffer.from(b) : b;
  return Buffer.concat([u32(buf.length), buf]);
};

/** Nieuwe ed25519-deploy key in OpenSSH-formaat (onversleuteld; het panel versleutelt hem zelf). */
export function generateDeployKey(comment: string): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), sshString("none"), sshString("none"), sshString(""), u32(1), sshString(blob), sshString(priv)]);
  const b64 = body.toString("base64").replace(/(.{70})/g, "$1\n").replace(/\n$/, "");
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
  };
}

/** SHA256-fingerprint van een known_hosts-regel of publieke sleutel ("<type> <base64>"), zoals ssh-keygen -l. */
export function fingerprint(keyB64: string): string {
  return "SHA256:" + createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("base64").replace(/=+$/, "");
}

/** Gepubliceerde hostsleutels (github.com/gitlab.com/bitbucket.org, poort 22). */
export const BUILTIN_HOSTS: Record<string, string[]> = {
  "github.com": [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  ],
  "gitlab.com": [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9",
  ],
  "bitbucket.org": [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
  ],
};

export const hostFor = (r: Remote) => (r.port === 22 ? r.host : `[${r.host}]:${r.port}`);

/** known_hosts en fingerprints voor een ingebouwde host, anders null. */
export function builtinKnownHosts(r: Remote): { lines: string; keys: Array<{ type: string; fingerprint: string }> } | null {
  const keys = r.port === 22 ? BUILTIN_HOSTS[r.host] : undefined;
  if (!keys) return null;
  return { lines: keys.map((k) => `${r.host} ${k}`).join("\n"), keys: keys.map((k) => ({ type: k.split(" ")[0]!, fingerprint: fingerprint(k.split(" ")[1]!) })) };
}

// ---------- webhooks ----------

export type WebhookCheck =
  | { ok: false; status: 401 }
  | { ok: true; provider: "github" | "gitlab" | "generic"; event: "push" | "ping" | "other" };

/** Controleert het geheim (constant-time): GitHub/Gitea/Bitbucket HMAC, GitLab-token of X-Deploy-Token/Bearer. */
export function checkWebhook(headers: Headers, raw: Buffer, secret: string): WebhookCheck {
  const sig = headers.get("x-hub-signature-256");
  const gh = headers.get("x-github-event") ?? headers.get("x-gitea-event") ?? headers.get("x-event-key");
  if (sig) {
    const want = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    const a = Buffer.from(sig.trim().toLowerCase());
    const b = Buffer.from(want);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401 };
    const ev = (gh ?? "push").toLowerCase();
    return { ok: true, provider: "github", event: ev === "push" || ev === "repo:push" ? "push" : ev === "ping" ? "ping" : "other" };
  }
  const gl = headers.get("x-gitlab-token");
  if (gl !== null) {
    if (!safeEqual(gl, secret)) return { ok: false, status: 401 };
    const ev = headers.get("x-gitlab-event") ?? "";
    return { ok: true, provider: "gitlab", event: ev === "Push Hook" ? "push" : "other" };
  }
  const tok = headers.get("x-deploy-token") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (tok !== null && safeEqual(tok.trim(), secret)) return { ok: true, provider: "generic", event: "push" };
  return { ok: false, status: 401 };
}

/** Welke branch is gepusht? null = onbekend (generiek zonder body: de ingestelde branch). "deleted" bij een verwijderde branch. */
export function pushedBranch(body: unknown, provider: "github" | "gitlab" | "generic", query: URLSearchParams): string | "deleted" | "tag" | null {
  const b = (body && typeof body === "object" ? body : {}) as { ref?: unknown; deleted?: unknown; after?: unknown; push?: { changes?: Array<{ new?: { type?: string; name?: string } | null }> } };
  // Bitbucket Cloud (repo:push)
  const bb = b.push?.changes?.[0];
  if (bb) {
    if (!bb.new) return "deleted";
    if (bb.new.type !== "branch") return "tag";
    return bb.new.name ?? null;
  }
  const ref = typeof b.ref === "string" ? b.ref : provider === "generic" ? (query.get("branch") ? `refs/heads/${query.get("branch")}` : null) : null;
  if (ref === null) return null;
  if (b.deleted === true || (typeof b.after === "string" && /^0{40}$/.test(b.after))) return "deleted";
  if (ref.startsWith("refs/tags/")) return "tag";
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return ref;
}

// ---------- weergave ----------

export function webhookUrl(c: ConfigRow): string {
  return `${getEnv().PANEL_URL}/api/deploy/webhook/${c.webhookId}`;
}

export function toConfig(c: ConfigRow | null, b: ServerBundle, canManage: boolean): DeployConfig {
  const def = defaultTargetDir(b.template.slug);
  if (!c) {
    return {
      configured: false, canManage, repoUrl: null, branch: "main", authType: "none", tokenSet: false, tokenUsername: null,
      targetDir: def, defaultTargetDir: def, sourceDir: "/", buildCommand: null, buildImage: "site", sharedPaths: [],
      restartAfter: def === "/app", autoDeploy: true, sshPublicKey: null, sshHost: null, webhookUrl: null, webhookSecret: null,
    };
  }
  const r = parseRepoUrl(c.repoUrl);
  const trusted = r?.scheme === "ssh" && c.knownHosts && c.sshHostFor === hostFor(r) && c.sshHostTrust;
  return {
    configured: true,
    canManage,
    repoUrl: c.repoUrl,
    branch: c.branch,
    authType: c.authType,
    tokenSet: !!c.tokenEnc,
    tokenUsername: c.tokenUsername,
    targetDir: c.targetDir,
    defaultTargetDir: def,
    sourceDir: c.sourceDir,
    buildCommand: c.buildCommand,
    buildImage: (["site", "node:24-alpine", "node:22-alpine", "composer:2"] as const).includes(c.buildImage as DeployBuildImage) ? (c.buildImage as DeployBuildImage) : "site",
    sharedPaths: c.sharedPaths,
    restartAfter: c.restartAfter,
    autoDeploy: c.autoDeploy,
    sshPublicKey: c.sshPublicKey,
    sshHost: trusted && r ? { host: r.host, port: r.port, trust: c.sshHostTrust!, keys: c.sshHostKeys ?? [] } : null,
    webhookUrl: canManage ? webhookUrl(c) : null,
    webhookSecret: canManage ? decrypt(c.webhookSecretEnc) : null,
  };
}

export function toDeploy(d: DeployRow, uuid: string, who: string | null): Deploy {
  return {
    id: d.id,
    serverUuid: uuid,
    status: d.status,
    trigger: d.trigger,
    branch: d.branch,
    commitSha: d.commitSha,
    commitAuthor: d.commitAuthor,
    commitMessage: d.commitMessage,
    commitDate: d.commitDate,
    triggeredBy: who,
    error: d.error,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    durationMs: d.durationMs,
  };
}

export async function loadConfig(serverId: number): Promise<ConfigRow | null> {
  const [c] = await getDb().select().from(schema.deployConfigs).where(eq(schema.deployConfigs.serverId, serverId));
  return c ?? null;
}

export const newWebhookId = () => randomToken(24);
export const newWebhookSecret = () => randomToken(32);

// ---------- deploy starten en afronden ----------

/** Maximale duur (= timeout in de daemon) plus marge; daarna geldt een "running"-rij als dood. */
const TIMEOUT_S = 1800;
const STALE_MS = (TIMEOUT_S + 300) * 1000;
const LOG_LINES = 300;

/** Lopende rijen die niet meer kunnen lopen (te oud) afsluiten. */
export async function reapStale(serverId: number): Promise<void> {
  await getDb()
    .update(schema.deploys)
    .set({ status: "failed", error: "INTERRUPTED: the deploy did not report back in time", finishedAt: new Date() })
    .where(and(eq(schema.deploys.serverId, serverId), eq(schema.deploys.status, "running"), lt(schema.deploys.startedAt, new Date(Date.now() - STALE_MS))));
}

/** Vraagt de daemon naar een lopende rij; weet hij er niets van (herstart), dan is hij afgebroken. */
export async function reconcileRunning(b: ServerBundle, d: DeployRow): Promise<{ row: DeployRow; progress: DaemonSchemas["DeployProgress"] | null }> {
  if (d.status !== "running") return { row: d, progress: null };
  let p: DaemonSchemas["DeployProgress"] | null = null;
  try {
    p = await daemonFor(b.node).deployProgress(b.server.uuid);
  } catch {
    return { row: d, progress: null }; // node onbereikbaar: niets concluderen
  }
  if (p && p.deploy_id === d.id) return { row: d, progress: p };
  if (Date.now() - d.startedAt.getTime() < 60_000) return { row: d, progress: null }; // melding kan nog onderweg zijn
  const [row] = await getDb()
    .update(schema.deploys)
    .set({ status: "failed", error: "INTERRUPTED: the node no longer knows this deploy (restarted?)", finishedAt: new Date() })
    .where(and(eq(schema.deploys.id, d.id), eq(schema.deploys.status, "running")))
    .returning();
  return { row: row ?? d, progress: null };
}

function daemonRequest(c: ConfigRow, b: ServerBundle, deployId: number): DaemonSchemas["DeployRequest"] {
  const auth: DaemonSchemas["DeployAuth"] = { type: c.authType };
  if (c.authType === "token") {
    if (!c.tokenEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TOKEN_REQUIRED" });
    auth.token = decrypt(c.tokenEnc);
    if (c.tokenUsername) auth.username = c.tokenUsername;
  }
  if (c.authType === "ssh") {
    const r = parseRepoUrl(c.repoUrl);
    if (!c.sshPrivateKeyEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_DEPLOY_KEY" });
    if (!r || !c.knownHosts || c.sshHostFor !== hostFor(r)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "HOST_KEY_UNTRUSTED" });
    auth.private_key = decrypt(c.sshPrivateKeyEnc);
    auth.known_hosts = c.knownHosts;
  }
  return {
    deploy_id: deployId,
    repo_url: c.repoUrl,
    branch: c.branch,
    auth,
    target_dir: c.targetDir,
    source_dir: c.sourceDir,
    shared_paths: c.sharedPaths,
    build: c.buildCommand ? { command: c.buildCommand, image: buildImageFor(c.buildImage as DeployBuildImage, b.template.image) } : null,
    restart: c.restartAfter,
    timeout_seconds: TIMEOUT_S,
    log_lines: LOG_LINES,
  };
}

export class DeployConflict extends Error {}

/**
 * Start een deploy (handmatig of via de webhook). Gooit CONFLICT `DEPLOY_RUNNING` als er al een loopt.
 * `ctx` alleen voor het activiteitenlog (null bij een webhook).
 */
export async function startDeploy(b: ServerBundle, c: ConfigRow, trigger: "manual" | "webhook", userId: number | null, ctx: Ctx | null): Promise<DeployRow> {
  await reapStale(b.server.id);
  // Publiceren (staging → productie) wisselt dezelfde bestanden om: niet tegelijk.
  if (await publishBusy(b.server.id)) throw new TRPCError({ code: "CONFLICT", message: "PUBLISH_IN_PROGRESS" });
  const db = getDb();
  let row: DeployRow;
  try {
    [row] = (await db.insert(schema.deploys).values({ serverId: b.server.id, userId, trigger, branch: c.branch, status: "running" }).returning()) as [DeployRow];
  } catch (e) {
    if (String((e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code) === "23505") throw new TRPCError({ code: "CONFLICT", message: "DEPLOY_RUNNING" });
    throw e;
  }
  const fail = async (msg: string) => {
    await db.update(schema.deploys).set({ status: "failed", error: msg.slice(0, 2000), finishedAt: new Date(), durationMs: Date.now() - row.startedAt.getTime() }).where(eq(schema.deploys.id, row.id));
  };
  let req: DaemonSchemas["DeployRequest"];
  try {
    req = daemonRequest(c, b, row.id);
  } catch (e) {
    await fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
  try {
    await call(() => daemonFor(b.node).startDeploy(b.server.uuid, req));
  } catch (e) {
    const raw = e instanceof TRPCError ? e.message : String(e);
    await fail(raw);
    if (e instanceof TRPCError && e.code === "CONFLICT") throw new TRPCError({ code: "CONFLICT", message: "DEPLOY_RUNNING" });
    throw e;
  }
  await db.update(schema.deployConfigs).set({ redeployPending: false }).where(eq(schema.deployConfigs.serverId, b.server.id));
  await logActivity({ action: "server.deploy.start", userId, serverId: b.server.id, metadata: { id: row.id, trigger, branch: c.branch }, ip: ctx?.ip ?? null, ctx: ctx ?? undefined });
  return row;
}

/** Lopende deploy afbreken via de daemon. */
export async function cancelDeploy(b: ServerBundle, d: DeployRow): Promise<void> {
  if (d.status !== "running") throw new TRPCError({ code: "CONFLICT", message: "DEPLOY_NOT_RUNNING" });
  try {
    await daemonFor(b.node).cancelDeploy(b.server.uuid, d.id);
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 409) throw new TRPCError({ code: "CONFLICT", message: "NOT_CANCELLABLE" });
    if (e instanceof DaemonHttpError && e.status === 404) {
      // De daemon kent hem niet (meer): als afgebroken markeren.
      await getDb().update(schema.deploys).set({ status: "cancelled", error: "cancelled", finishedAt: new Date() }).where(and(eq(schema.deploys.id, d.id), eq(schema.deploys.status, "running")));
      return;
    }
    if (e instanceof DaemonUnreachableError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DAEMON_UNREACHABLE" });
    throw e;
  }
}

export interface DeployReport {
  status: "succeeded" | "failed" | "cancelled";
  error?: string | null;
  commit?: { sha: string; author: string; message: string; date?: string | null } | null;
  log_tail: string[];
  duration_ms?: number;
}

/** Resultaat van de daemon verwerken (POST /api/remote/deploys/{id}). */
export async function finishDeploy(d: DeployRow, s: { id: number; uuid: string; name: string }, r: DeployReport): Promise<void> {
  const db = getDb();
  const commitDate = r.commit?.date ? new Date(r.commit.date) : null;
  // Ook een rij die de reconcile al als INTERRUPTED had afgesloten krijgt het echte resultaat.
  const updated = await db
    .update(schema.deploys)
    .set({
      status: r.status,
      error: r.status === "succeeded" ? null : (r.error ?? "unknown error").slice(0, 2000),
      commitSha: r.commit?.sha.slice(0, 64) ?? d.commitSha,
      commitAuthor: r.commit?.author.slice(0, 200) ?? d.commitAuthor,
      commitMessage: r.commit?.message.slice(0, 500) ?? d.commitMessage,
      commitDate: commitDate && !Number.isNaN(commitDate.getTime()) ? commitDate : d.commitDate,
      log: r.log_tail.slice(-500).map((l) => l.slice(0, 2000)),
      durationMs: r.duration_ms ?? Date.now() - d.startedAt.getTime(),
      finishedAt: new Date(),
    })
    .where(and(eq(schema.deploys.id, d.id), sql`(${schema.deploys.status} = 'running' or ${schema.deploys.error} like 'INTERRUPTED%')`))
    .returning({ id: schema.deploys.id });
  if (!updated.length) return; // al verwerkt (herhaalde melding)
  await logActivity({ action: `server.deploy.${r.status}`, userId: d.userId, serverId: s.id, metadata: { id: d.id, commit: r.commit?.sha.slice(0, 12) ?? null, error: r.status === "failed" ? (r.error ?? null) : null } });
  if (r.status !== "cancelled") {
    const target = await targetForServer(s.id).catch(() => null);
    if (target) {
      const commit = r.commit ? `${r.commit.sha.slice(0, 8)} ${r.commit.message}`.slice(0, 200) : null;
      await notify(r.status === "succeeded" ? { kind: "deploy_succeeded", branch: d.branch, commit } : { kind: "deploy_failed", branch: d.branch, commit, error: r.error ?? "unknown error", logTail: r.log_tail.slice(-12) }, target);
    }
  }
}

/** Na een afgeronde deploy: kwam er intussen een push binnen, dan nog één keer. */
export async function runPendingRedeploy(b: ServerBundle): Promise<void> {
  const c = await loadConfig(b.server.id);
  if (!c?.redeployPending || !c.autoDeploy) return;
  try {
    await startDeploy(b, c, "webhook", null, null);
  } catch (e) {
    console.error("[deploy] pending redeploy failed:", e instanceof Error ? e.message : e);
  }
}

export async function lastDeploys(serverId: number, limit: number, before?: number) {
  return getDb()
    .select({ d: schema.deploys, who: schema.users.name })
    .from(schema.deploys)
    .leftJoin(schema.users, eq(schema.users.id, schema.deploys.userId))
    .where(before ? and(eq(schema.deploys.serverId, serverId), lt(schema.deploys.id, before)) : eq(schema.deploys.serverId, serverId))
    .orderBy(desc(schema.deploys.id))
    .limit(limit);
}

