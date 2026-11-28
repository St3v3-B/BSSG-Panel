import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as reportRoute } from "@/app/api/remote/deploys/[deploy_id]/route";
import { POST as webhookRoute } from "@/app/api/deploy/webhook/[hook]/route";
import { builtinKnownHosts, checkWebhook, fingerprint, generateDeployKey, normalizePath, parseRepoUrl, pushedBranch, validBranch, validTarget } from "./deploy";
import { getDb, schema } from "./db";
import { decrypt } from "./lib/crypto";
import { resetLimiter } from "./lib/ratelimit";
import { delivery, flushNotify } from "./notify";
import { OWNER, useHarness, type TestUser } from "./test/harness";

describe("deploy: validatie en hulpfuncties", () => {
  it("repository-URL's", () => {
    expect(parseRepoUrl("https://github.com/acme/site.git")).toEqual({ scheme: "https", host: "github.com", port: 443 });
    expect(parseRepoUrl("git@gitlab.com:acme/site.git")).toEqual({ scheme: "ssh", host: "gitlab.com", port: 22 });
    expect(parseRepoUrl("ssh://git@git.example.test:2222/a/b.git")).toEqual({ scheme: "ssh", host: "git.example.test", port: 2222 });
    for (const bad of [
      "file:///etc/passwd", "/srv/repo", "ext::sh -c id", "https://user:pw@github.com/a/b", "https://token@github.com/a/b", "http://github.com/a/b",
      "git://github.com/a/b", "-uhttps://x", "https://github.com/a/b?x=1", "https://localhost/a/b", "https://127.0.0.1/a/b", "https://10.0.0.5/a/b",
      "git@192.168.1.2:a/b", "https://[::1]/a/b", "https://github.com/a b", "git@github.com:-oProxyCommand=x", "https://github.com/$(id)", "fd::3",
    ]) expect(parseRepoUrl(bad), bad).toBeNull();
  });

  it("branches en paden", () => {
    for (const b of ["main", "release/1.2", "feature-x"]) expect(validBranch(b), b).toBe(true);
    for (const b of ["-x", "a..b", "a b", "/a", "a/", "x.lock", "HEAD", "a~1", "a:b"]) expect(validBranch(b), b).toBe(false);
    expect(normalizePath("/a/./b/")).toBe("/a/b");
    expect(normalizePath("/a/../b")).toBeNull();
    expect(validTarget("/")).toBeNull();
    expect(validTarget("/.panel-deploy/x")).toBeNull();
    expect(validTarget("/public/")).toBe("/public");
  });

  it("deploy key in OpenSSH-formaat (ssh-keygen leest hem)", () => {
    const k = generateDeployKey("panel-deploy-test");
    expect(k.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ panel-deploy-test$/);
    let sshKeygen = true;
    try {
      execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    } catch (e) {
      sshKeygen = (e as { code?: string }).code !== "ENOENT";
    }
    if (!sshKeygen) return;
    const dir = mkdtempSync(join(tmpdir(), "deploykey-"));
    try {
      writeFileSync(join(dir, "id"), k.privateKey, { mode: 0o600 });
      const pub = execFileSync("ssh-keygen", ["-y", "-f", join(dir, "id")]).toString().trim();
      expect(pub.split(" ").slice(0, 2).join(" ")).toBe(k.publicKey.split(" ").slice(0, 2).join(" "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingebouwde hostsleutels hebben de gepubliceerde fingerprints", () => {
    const gh = builtinKnownHosts({ scheme: "ssh", host: "github.com", port: 22 })!;
    expect(gh.keys.map((k) => k.fingerprint)).toContain("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
    expect(gh.lines.split("\n").every((l) => l.startsWith("github.com "))).toBe(true);
    expect(builtinKnownHosts({ scheme: "ssh", host: "gitlab.com", port: 22 })!.keys.map((k) => k.fingerprint)).toContain("SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8");
    expect(builtinKnownHosts({ scheme: "ssh", host: "bitbucket.org", port: 22 })!.keys.map((k) => k.fingerprint)).toContain("SHA256:ybgmFkzwOSotHTHLJgHO0QN8L0xErw6vd0VhFA9m3SM");
    expect(builtinKnownHosts({ scheme: "ssh", host: "github.com", port: 2222 })).toBeNull();
    expect(fingerprint("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")).toBe("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
  });

  it("webhook-handtekeningen", () => {
    const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
    const sig = "sha256=" + createHmac("sha256", "geheim").update(body).digest("hex");
    expect(checkWebhook(new Headers({ "x-hub-signature-256": sig, "x-github-event": "push" }), body, "geheim")).toEqual({ ok: true, provider: "github", event: "push" });
    expect(checkWebhook(new Headers({ "x-hub-signature-256": sig, "x-github-event": "ping" }), body, "geheim")).toMatchObject({ ok: true, event: "ping" });
    expect(checkWebhook(new Headers({ "x-hub-signature-256": sig }), Buffer.from("anders"), "geheim").ok).toBe(false);
    expect(checkWebhook(new Headers({ "x-hub-signature-256": "sha256=00" }), body, "geheim").ok).toBe(false);
    expect(checkWebhook(new Headers({ "x-gitlab-token": "geheim", "x-gitlab-event": "Push Hook" }), body, "geheim")).toEqual({ ok: true, provider: "gitlab", event: "push" });
    expect(checkWebhook(new Headers({ "x-gitlab-token": "fout" }), body, "geheim").ok).toBe(false);
    expect(checkWebhook(new Headers({ "x-deploy-token": "geheim" }), body, "geheim")).toEqual({ ok: true, provider: "generic", event: "push" });
    expect(checkWebhook(new Headers({ authorization: "Bearer geheim" }), body, "geheim").ok).toBe(true);
    expect(checkWebhook(new Headers({}), body, "geheim").ok).toBe(false);
  });

  it("branchfilter uit de push", () => {
    const q = new URLSearchParams();
    expect(pushedBranch({ ref: "refs/heads/main" }, "github", q)).toBe("main");
    expect(pushedBranch({ ref: "refs/tags/v1" }, "github", q)).toBe("tag");
    expect(pushedBranch({ ref: "refs/heads/main", deleted: true }, "github", q)).toBe("deleted");
    expect(pushedBranch({ ref: "refs/heads/dev", after: "0".repeat(40) }, "gitlab", q)).toBe("deleted");
    expect(pushedBranch({ push: { changes: [{ new: { type: "branch", name: "main" } }] } }, "github", q)).toBe("main");
    expect(pushedBranch({}, "generic", q)).toBeNull();
    expect(pushedBranch({}, "generic", new URLSearchParams("branch=dev"))).toBe("dev");
  });
});

const h = useHarness();
let admin: TestUser, owner: TestUser, reader: TestUser, manager: TestUser, filesOnly: TestUser, stranger: TestUser;
let site = "";
let game = "";

beforeAll(async () => {
  delivery.inline = true;
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  owner = await h.user({ discordId: "290000000000000001", name: "eigenaar" });
  reader = await h.user({ discordId: "290000000000000002", name: "lezer" });
  manager = await h.user({ discordId: "290000000000000003", name: "beheerder" });
  filesOnly = await h.user({ discordId: "290000000000000004", name: "bestanden" });
  stranger = await h.user({ discordId: "290000000000000005", name: "vreemde" });
  const mk = async (name: string, slug: string, ports: number[]) =>
    (
      await admin.api.admin.servers.create({
        name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug),
        limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 }, allocationIds: await Promise.all(ports.map((p) => h.allocation(p))), variables: {}, startOnInstall: false,
      })
    ).uuid;
  site = await mk("Site", "testweb", []);
  game = await mk("Spel", "testgame", [25800]);
  await owner.api.subusers.invite({ uuid: site, who: reader.discordId, permissions: ["deploy.read"] });
  await owner.api.subusers.invite({ uuid: site, who: manager.discordId, permissions: ["deploy.read", "deploy.manage"] });
  await owner.api.subusers.invite({ uuid: site, who: filesOnly.discordId, permissions: ["files.read", "files.write"] });
}, 180_000);

afterAll(() => {
  delivery.inline = false;
});

beforeEach(async () => {
  h.daemon.deploys.clear();
  await resetLimiter();
});

const report = (id: number, body: unknown, token = h.env.NODE_TOKEN!) =>
  reportRoute(new Request(`http://panel.test/api/remote/deploys/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ deploy_id: String(id) }) });

const hookId = (url: string) => url.split("/").pop()!;
const hook = (url: string, body: unknown, headers: Record<string, string>) =>
  webhookRoute(new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ hook: hookId(url) }) });
const github = (secret: string, body: unknown, event = "push") => ({ "x-github-event": event, "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(JSON.stringify(body)).digest("hex") });

const cfgRow = async () => (await getDb().select().from(schema.deployConfigs).innerJoin(schema.servers, eq(schema.servers.id, schema.deployConfigs.serverId)).where(eq(schema.servers.uuid, site)))[0]!.deploy_configs;
const lastDaemonDeploy = () => h.daemon.deploys.get(site)?.req as Record<string, any> | undefined;

const finish = async (id: number, status: "succeeded" | "failed" | "cancelled", extra: Record<string, unknown> = {}) => {
  h.daemon.deploys.delete(site);
  const res = await report(id, { status, error: status === "succeeded" ? null : "build command exited with code 1", commit: { sha: "a".repeat(40), author: "Ada", message: "Nieuwe header", date: "2026-11-01T10:00:00Z" }, log_tail: ["Fetching", "Deploy finished."], duration_ms: 4200, ...extra });
  expect(res.status).toBe(204);
};

describe("deploy.* procedures", () => {
  it("alleen websites, en rechten", async () => {
    await expect(owner.api.deploy.config({ uuid: game })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "NOT_A_WEBSITE" });
    await expect(stranger.api.deploy.config({ uuid: site })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(filesOnly.api.deploy.config({ uuid: site })).rejects.toMatchObject({ code: "FORBIDDEN", message: "MISSING_PERMISSION: deploy.read" });
    const c = await reader.api.deploy.config({ uuid: site });
    expect(c).toMatchObject({ configured: false, canManage: false, targetDir: "/public", defaultTargetDir: "/public" });
    await expect(reader.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/acme/site.git", authType: "none" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "MISSING_PERMISSION: deploy.manage" });
    await expect(reader.api.deploy.start({ uuid: site })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("instellen: ongeldige invoer", async () => {
    for (const repoUrl of ["file:///etc", "ext::sh -c id", "https://u:p@github.com/a/b.git", "https://127.0.0.1/a.git"]) {
      await expect(owner.api.deploy.configure({ uuid: site, repoUrl, authType: "none" }), repoUrl).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_REPO_URL" });
    }
    await expect(owner.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/a/b.git", authType: "none", branch: "--upload-pack=x" })).rejects.toMatchObject({ message: "INVALID_BRANCH" });
    await expect(owner.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/a/b.git", authType: "none", targetDir: "/" })).rejects.toMatchObject({ message: "INVALID_PATH" });
    await expect(owner.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/a/b.git", authType: "none", sharedPaths: ["/../etc"] })).rejects.toMatchObject({ message: "INVALID_PATH" });
    await expect(owner.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/a/b.git", authType: "token" })).rejects.toMatchObject({ message: "TOKEN_REQUIRED" });
    await expect(owner.api.deploy.configure({ uuid: site, repoUrl: "git@github.com:a/b.git", authType: "none" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(owner.api.deploy.start({ uuid: site })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "NOT_CONFIGURED" });
  });

  it("token versleuteld, nooit terug te lezen; deploy met token en build", async () => {
    const c = await manager.api.deploy.configure({
      uuid: site, repoUrl: "https://github.com/acme/private.git", authType: "token", token: "ghp_SuperSecret123", branch: "main",
      buildCommand: "npm ci && npm run build", buildImage: "site", sourceDir: "/dist", sharedPaths: ["/.env", "/uploads/"],
    });
    expect(c).toMatchObject({ configured: true, canManage: true, tokenSet: true, sharedPaths: ["/.env", "/uploads"], sourceDir: "/dist", targetDir: "/public" });
    expect(c.webhookUrl).toMatch(/^https?:\/\/[^/]+\/api\/deploy\/webhook\/[A-Za-z0-9_-]{20,}$/);
    expect(c.webhookSecret!.length).toBeGreaterThan(20);
    expect(JSON.stringify(c)).not.toContain("ghp_SuperSecret123");
    const row = await cfgRow();
    expect(row.tokenEnc).not.toContain("ghp_SuperSecret123");
    expect(decrypt(row.tokenEnc!)).toBe("ghp_SuperSecret123");
    expect(row.webhookSecretEnc).not.toContain(c.webhookSecret!);
    // lezer ziet geen geheimen
    const rc = await reader.api.deploy.config({ uuid: site });
    expect(rc).toMatchObject({ configured: true, canManage: false, webhookUrl: null, webhookSecret: null, tokenSet: true });
    // token ongewijzigd laten bij opnieuw opslaan
    await owner.api.deploy.configure({ uuid: site, repoUrl: "https://github.com/acme/private.git", authType: "token", branch: "main", buildCommand: "npm ci && npm run build", sourceDir: "/dist", sharedPaths: ["/.env", "/uploads"] });
    expect(decrypt((await cfgRow()).tokenEnc!)).toBe("ghp_SuperSecret123");

    const d = await manager.api.deploy.start({ uuid: site });
    expect(d).toMatchObject({ status: "running", trigger: "manual", branch: "main", triggeredBy: "beheerder" });
    const req = lastDaemonDeploy()!;
    expect(req).toMatchObject({ deploy_id: d.id, repo_url: "https://github.com/acme/private.git", branch: "main", target_dir: "/public", source_dir: "/dist", shared_paths: ["/.env", "/uploads"], build: { command: "npm ci && npm run build", image: "nginx:alpine" }, restart: false });
    expect(req.auth).toEqual({ type: "token", token: "ghp_SuperSecret123" });
    await expect(owner.api.deploy.start({ uuid: site })).rejects.toMatchObject({ code: "CONFLICT", message: "DEPLOY_RUNNING" });

    // live volgen
    h.daemon.deploys.get(site)!.log.push("added 12 packages");
    h.daemon.deploys.get(site)!.phase = "building";
    const live = await reader.api.deploy.get({ id: d.id });
    expect(live).toMatchObject({ status: "running", phase: "building", cancellable: true, log: ["Fetching", "added 12 packages"] });

    await finish(d.id, "succeeded");
    const done = await reader.api.deploy.get({ id: d.id });
    expect(done).toMatchObject({ status: "succeeded", commitSha: "a".repeat(40), commitAuthor: "Ada", commitMessage: "Nieuwe header", durationMs: 4200, log: ["Fetching", "Deploy finished."], phase: null, cancellable: false });
    expect((await report(d.id, { status: "failed", log_tail: [] })).status).toBe(204); // herhaalde melding: genegeerd
    expect((await reader.api.deploy.get({ id: d.id })).status).toBe("succeeded");
    expect((await report(d.id, { status: "succeeded", log_tail: [] }, "fout")).status).toBe(401);
    const acts = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.serverId, (await cfgRow()).serverId));
    expect(acts.map((a) => a.action)).toEqual(expect.arrayContaining(["server.deploy.config.create", "server.deploy.config.update", "server.deploy.start", "server.deploy.succeeded"]));
  });

  it("mislukt → melding; annuleren; geschiedenis met paginering", async () => {
    const d = await owner.api.deploy.start({ uuid: site });
    await finish(d.id, "failed");
    await flushNotify();
    const inbox = await owner.api.inbox.list({});
    expect(inbox.items.find((i) => i.event === "deploy_failed")).toMatchObject({ level: "error", title: "Deploy failed", link: `/servers/${site}/deploy` });
    expect((await owner.api.deploy.get({ id: d.id })).error).toBe("build command exited with code 1");

    const d2 = await owner.api.deploy.start({ uuid: site });
    await expect(reader.api.deploy.cancel({ id: d2.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await owner.api.deploy.cancel({ id: d2.id });
    expect(h.daemon.deploys.has(site)).toBe(false);
    await finish(d2.id, "cancelled", { error: "cancelled" });
    await expect(owner.api.deploy.cancel({ id: d2.id })).rejects.toMatchObject({ code: "CONFLICT", message: "DEPLOY_NOT_RUNNING" });

    const page1 = await reader.api.deploy.list({ uuid: site, limit: 2 });
    expect(page1.items.map((x) => x.status)).toEqual(["cancelled", "failed"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await reader.api.deploy.list({ uuid: site, limit: 2, cursor: page1.nextCursor });
    expect(page2.items[0]!.status).toBe("succeeded");
  });

  it("afgebroken deploy na een daemon-herstart wordt INTERRUPTED", async () => {
    const d = await owner.api.deploy.start({ uuid: site });
    h.daemon.deploys.delete(site); // daemon weet er niets meer van
    expect((await owner.api.deploy.get({ id: d.id })).status).toBe("running"); // < 60 s: melding kan onderweg zijn
    await getDb().update(schema.deploys).set({ startedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.deploys.id, d.id));
    const list = await owner.api.deploy.list({ uuid: site, limit: 1 });
    expect(list.items[0]).toMatchObject({ id: d.id, status: "failed" });
    expect(list.items[0]!.error).toMatch(/^INTERRUPTED/);
    // Komt de melding toch nog, dan telt het echte resultaat.
    await finish(d.id, "succeeded");
    expect((await owner.api.deploy.get({ id: d.id })).status).toBe("succeeded");
  });

  it("webhook: handtekening, branchfilter, wachtrij, geheim roteren, rate-limit", async () => {
    const c = await owner.api.deploy.config({ uuid: site });
    const url = c.webhookUrl!;
    const secret = c.webhookSecret!;
    const push = { ref: "refs/heads/main", after: "b".repeat(40) };
    expect((await hook(url.replace(/[^/]+$/, "x".repeat(32)), push, github(secret, push))).status).toBe(404);
    expect((await hook(url, push, github("fout", push))).status).toBe(401);
    expect((await hook(url, push, { "x-gitlab-token": "fout", "x-gitlab-event": "Push Hook" })).status).toBe(401);
    expect(await (await hook(url, push, github(secret, push, "ping"))).json()).toEqual({ ok: true, pong: true });
    const other = { ref: "refs/heads/dev" };
    expect(await (await hook(url, other, github(secret, other))).json()).toEqual({ ignored: "branch" });
    const tag = { ref: "refs/tags/v1" };
    expect(await (await hook(url, tag, github(secret, tag))).json()).toEqual({ ignored: "tag" });
    expect(h.daemon.deploys.has(site)).toBe(false);

    const r1 = await hook(url, push, github(secret, push));
    expect(r1.status).toBe(202);
    const { deploy_id } = (await r1.json()) as { deploy_id: number };
    expect(lastDaemonDeploy()!.deploy_id).toBe(deploy_id);
    expect((await owner.api.deploy.get({ id: deploy_id })).trigger).toBe("webhook");
    // Tweede push tijdens de deploy: komt in de wachtrij, daarna nog één deploy.
    const r2 = await hook(url, push, { "x-gitlab-token": secret, "x-gitlab-event": "Push Hook" });
    expect(await r2.json()).toEqual({ queued: true });
    expect((await cfgRow()).redeployPending).toBe(true);
    await finish(deploy_id, "succeeded");
    const next = lastDaemonDeploy();
    expect(next?.deploy_id).toBeGreaterThan(deploy_id);
    expect((await cfgRow()).redeployPending).toBe(false);
    await finish(next!.deploy_id, "succeeded");

    // Generiek met X-Deploy-Token en ?branch=
    const g = await webhookRoute(new Request(`${url}?branch=main`, { method: "POST", headers: { "x-deploy-token": secret } }), { params: Promise.resolve({ hook: hookId(url) }) });
    expect(g.status).toBe(202);
    await finish(lastDaemonDeploy()!.deploy_id, "succeeded");

    // Automatisch uit: genegeerd.
    const base = { uuid: site, repoUrl: "https://github.com/acme/private.git", authType: "token" as const, branch: "main", buildCommand: "npm ci && npm run build", sourceDir: "/dist", sharedPaths: ["/.env", "/uploads"] };
    await owner.api.deploy.configure({ ...base, autoDeploy: false });
    expect(await (await hook(url, push, github(secret, push))).json()).toEqual({ ignored: "auto_deploy_off" });
    await owner.api.deploy.configure({ ...base, autoDeploy: true });

    // Nieuw geheim: het oude werkt niet meer.
    const rotated = await owner.api.deploy.rotateWebhookSecret({ uuid: site });
    expect(rotated.webhookSecret).not.toBe(secret);
    expect(rotated.webhookUrl).toBe(url);
    expect((await hook(url, push, github(secret, push))).status).toBe(401);

    // Rate-limit per site (ook met een geldig geheim).
    await resetLimiter();
    const s2 = rotated.webhookSecret!;
    let limited = false;
    for (let i = 0; i < 25 && !limited; i++) {
      const res = await hook(url, other, github(s2, other));
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it("SSH: deploy key, ingebouwde hostsleutels, TOFU voor andere hosts", async () => {
    const c = await owner.api.deploy.configure({ uuid: site, repoUrl: "git@github.com:acme/site.git", authType: "ssh", branch: "main" });
    expect(c.sshPublicKey).toMatch(/^ssh-ed25519 \S+ panel-deploy-/);
    expect(c.sshHost).toMatchObject({ host: "github.com", port: 22, trust: "builtin" });
    const row = await cfgRow();
    expect(decrypt(row.sshPrivateKeyEnc!)).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(row.sshPrivateKeyEnc).not.toContain("OPENSSH");
    const d = await owner.api.deploy.start({ uuid: site });
    const req = lastDaemonDeploy()!;
    expect(req.auth.type).toBe("ssh");
    expect(req.auth.private_key).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(req.auth.known_hosts).toContain("github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
    await finish(d.id, "succeeded");

    const k2 = await owner.api.deploy.generateKey({ uuid: site });
    expect(k2.sshPublicKey).not.toBe(c.sshPublicKey);

    const own = "ssh://git@git.example.test:2222/acme/site.git";
    const c2 = await owner.api.deploy.configure({ uuid: site, repoUrl: own, authType: "ssh", branch: "main" });
    expect(c2.sshHost).toBeNull();
    expect(c2.sshPublicKey).toBe(k2.sshPublicKey); // sleutel blijft
    await expect(owner.api.deploy.start({ uuid: site })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "HOST_KEY_UNTRUSTED" });
    h.daemon.gitHostKeys = [{ type: "ssh-ed25519", fingerprint: "SHA256:abc", known_hosts_line: "[git.example.test]:2222 ssh-ed25519 AAAAtest" }];
    const scan = await owner.api.deploy.scanHostKey({ uuid: site, repoUrl: own });
    expect(scan).toEqual({ host: "git.example.test", port: 2222, keys: [{ type: "ssh-ed25519", fingerprint: "SHA256:abc" }], builtin: false });
    expect(h.daemon.last("POST", "/api/git/host-key")!.body).toEqual({ host: "git.example.test", port: 2222 });
    await expect(owner.api.deploy.trustHostKey({ uuid: site, repoUrl: own, fingerprints: ["SHA256:other"] })).rejects.toMatchObject({ code: "CONFLICT", message: "HOST_KEY_MISMATCH" });
    await expect(reader.api.deploy.trustHostKey({ uuid: site, repoUrl: own, fingerprints: ["SHA256:abc"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const t = await owner.api.deploy.trustHostKey({ uuid: site, repoUrl: own, fingerprints: ["SHA256:abc"] });
    expect(t.sshHost).toMatchObject({ host: "git.example.test", port: 2222, trust: "confirmed" });
    const d2 = await owner.api.deploy.start({ uuid: site });
    expect(lastDaemonDeploy()!.auth.known_hosts).toBe("[git.example.test]:2222 ssh-ed25519 AAAAtest");
    await finish(d2.id, "succeeded");
    h.daemon.gitHostKeys = null;
    await expect(owner.api.deploy.scanHostKey({ uuid: site, repoUrl: "git@other.example.test:a/b.git" })).rejects.toMatchObject({ message: "HOST_UNREACHABLE" });
  });

  it("ontkoppelen: webhook werkt niet meer, geschiedenis blijft", async () => {
    const c = await owner.api.deploy.config({ uuid: site });
    await owner.api.deploy.disconnect({ uuid: site });
    expect((await owner.api.deploy.config({ uuid: site })).configured).toBe(false);
    const push = { ref: "refs/heads/main" };
    expect((await hook(c.webhookUrl!, push, github(c.webhookSecret!, push))).status).toBe(404);
    expect((await owner.api.deploy.list({ uuid: site })).items.length).toBeGreaterThan(3);
    const [n] = await getDb().select().from(schema.activityLog).where(and(eq(schema.activityLog.action, "server.deploy.config.delete")));
    expect(n).toBeTruthy();
  });
});
