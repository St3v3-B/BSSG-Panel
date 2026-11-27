import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { deps } from "./apps/engine";
import { localTarget } from "./apps/local-target";
import { fakeFetch, makeTarGz, sha, WP_FILES } from "./apps/test-fixtures";
import { getDb, schema } from "./db";
import { hooks } from "./routers/apps";
import { startMariadb, type TestContainer } from "./test/docker";
import { OWNER, useHarness, WEB_TEMPLATE, type TestUser } from "./test/harness";
import { createConnection } from "mariadb";

const ROOT_PW = "apps-root-pw";
const PHP_TEMPLATE = WEB_TEMPLATE.replace("slug: testweb", "slug: php-8-3").replace("name: Testsite", "name: PHP 8.3");
const h = useHarness({ env: { MARIADB_ROOT_PASSWORD: ROOT_PW }, templates: { "web/php-8-3.yaml": PHP_TEMPLATE } });
let maria: TestContainer;
let admin: TestUser, owner: TestUser, writer: TestUser, stranger: TestUser;
let site = "", plain = "";
let dir = "";
const realFetch = deps.fetch;
const realTarget = hooks.target;
const limits = { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 };

const tgz = makeTarGz("wordpress", WP_FILES);
const WP_ROUTES = { "https://wordpress.org/latest.tar.gz": { body: tgz }, "https://wordpress.org/latest.tar.gz.sha1": { body: sha(tgz) } };

const mkSite = async (tpl: string, name: string) =>
  (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(tpl), limits, allocationIds: [], variables: {}, startOnInstall: false })).uuid;

async function finished(api: TestUser["api"], id: number) {
  for (let i = 0; i < 100; i++) {
    const j = await api.apps.job({ id });
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("job did not finish");
}

beforeAll(async () => {
  maria = await startMariadb(ROOT_PW);
  process.env.MARIADB_ADMIN_ADDR = `127.0.0.1:${maria.port}`;
  (await import("./env")).resetEnv();
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  owner = await h.user({ discordId: "280000000000000001", name: "eigenaar-site" });
  writer = await h.user({ discordId: "280000000000000002", name: "schrijver" });
  stranger = await h.user({ discordId: "280000000000000003", name: "vreemde" });
  site = await mkSite("php-8-3", "Blog");
  plain = await mkSite("testweb", "Gewone site");
  await getDb().insert(schema.domains).values({ serverId: (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, site)))[0]!.id, hostname: "blog.panel.test", targetPort: null });
  await owner.api.subusers.invite({ uuid: site, who: writer.discordId, permissions: ["files.read", "files.write"] });
}, 240_000);

afterAll(async () => {
  deps.fetch = realFetch;
  hooks.target = realTarget;
  await maria?.stop();
});

afterEach(() => {
  deps.fetch = realFetch;
});

const fresh = () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "apps-site-"));
  mkdirSync(join(dir, "public"));
  hooks.target = () => localTarget(dir);
};

describe("apps.catalog / check", () => {
  it("lists the catalogue; non-PHP sites are marked incompatible with a reason", async () => {
    const php = await owner.api.apps.catalog({ uuid: site });
    expect(php.map((a) => a.id)).toEqual(["wordpress", "grav", "nextcloud"]);
    expect(php.every((a) => a.compatible)).toBe(true);
    expect(php.find((a) => a.id === "wordpress")).toMatchObject({ requiresDatabase: true, supportsAdmin: true });
    const other = await owner.api.apps.catalog({ uuid: plain });
    expect(other.every((a) => !a.compatible && a.incompatibleReason)).toBe(true);
  });

  it("check reports whether public/ is empty", async () => {
    fresh();
    expect(await owner.api.apps.check({ uuid: site, appId: "wordpress" })).toEqual({ publicEmpty: true, entries: 0 });
    writeFileSync(join(dir, "public/x.php"), "x");
    expect(await owner.api.apps.check({ uuid: site, appId: "wordpress" })).toEqual({ publicEmpty: false, entries: 1 });
    await expect(owner.api.apps.check({ uuid: site, appId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("apps.install", () => {
  it("WordPress end to end: job, database on the host, wp-config, password shown once", async () => {
    fresh();
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    const j0 = await owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: false, admin: { username: "boss", email: "boss@panel.test" } });
    expect(j0).toMatchObject({ status: "running", appId: "wordpress", appName: "WordPress" });
    expect(j0.steps.map((s) => s.key)).toEqual(["prepare", "download", "verify", "upload", "extract", "database", "configure", "finish"]);
    const j = await finished(owner.api, j0.id);
    expect(j.status).toBe("succeeded");
    expect(j.steps.every((s) => s.status === "done")).toBe(true);
    expect(j.result).toMatchObject({ version: "9.9.1", adminUrl: "https://blog.panel.test/wp-admin/", adminUsername: "boss" });
    const pw = j.result!.adminPassword;
    expect(pw).toBeTruthy();
    // shown once
    expect((await owner.api.apps.job({ id: j0.id })).result!.adminPassword).toBeNull();
    expect((await owner.api.apps.jobs({ uuid: site }))[0]!.result!.adminPassword).toBeNull();
    // database exists and is what wp-config contains
    const dbs = await owner.api.databases.list({ uuid: site });
    expect(dbs).toHaveLength(1);
    const cfg = readFileSync(join(dir, "wp-config.php"), "utf8");
    expect(cfg).toContain(`define('DB_NAME', '${dbs[0]!.name}');`);
    expect(cfg).toContain(`define('DB_PASSWORD', '${dbs[0]!.password}');`);
    expect(cfg).toContain(`define('DB_HOST', '${dbs[0]!.host}');`);
    expect(JSON.parse(readFileSync(join(dir, ".panel-wp-setup.json"), "utf8")).password).toBe(pw);
    const c = await createConnection({ host: "127.0.0.1", port: maria.port, user: dbs[0]!.username, password: dbs[0]!.password, database: dbs[0]!.name });
    await c.end();
    // activity log, and the stored result is encrypted
    const [row] = await getDb().select().from(schema.appInstalls).where(eq(schema.appInstalls.id, j0.id));
    expect(row!.resultEnc).toMatch(/^v1:/);
    expect(row!.resultEnc).not.toContain("boss");
    expect((await admin.api.admin.activity.search({ action: "server.app.install", limit: 10 })).items.length).toBeGreaterThan(0);
  });

  it("refuses a non-empty public/ (PUBLIC_NOT_EMPTY) unless replaceExisting", async () => {
    fresh();
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    writeFileSync(join(dir, "public/mine.php"), "mine");
    await expect(owner.api.apps.install({ uuid: site, appId: "grav", replaceExisting: false, admin: null })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "PUBLIC_NOT_EMPTY" });
    expect(existsSync(join(dir, "public/mine.php"))).toBe(true);
    const j = await finished(owner.api, (await owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: true, admin: null })).id);
    expect(j.status).toBe("succeeded");
    expect(j.result!.adminPassword).toBeNull();
    expect(existsSync(join(dir, "public/mine.php"))).toBe(false);
  });

  it("a checksum mismatch fails the job with its code and leaves no database behind", async () => {
    fresh();
    const before = (await owner.api.databases.list({ uuid: site })).length;
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz.sha1": { body: "f".repeat(40) } }).fn;
    const j = await finished(owner.api, (await owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: false, admin: null })).id);
    expect(j).toMatchObject({ status: "failed", errorCode: "CHECKSUM_MISMATCH", result: null });
    expect(j.steps.find((s) => s.key === "verify")!.status).toBe("failed");
    expect(j.steps.find((s) => s.key === "extract")!.status).toBe("pending");
    expect((await owner.api.databases.list({ uuid: site })).length).toBe(before);
  });

  it("one install at a time per site", async () => {
    fresh();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(WP_ROUTES);
    deps.fetch = async (u) => (u.endsWith(".sha1") ? (await gate, f.fn(u)) : f.fn(u));
    const j0 = await owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: false, admin: null });
    await expect(owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: true, admin: null })).rejects.toMatchObject({ code: "CONFLICT", message: "INSTALL_RUNNING" });
    release();
    expect((await finished(owner.api, j0.id)).status).toBe("succeeded");
  });

  it("incompatible template and unknown app are rejected", async () => {
    fresh();
    await expect(owner.api.apps.install({ uuid: plain, appId: "wordpress", replaceExisting: false, admin: null })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(owner.api.apps.install({ uuid: site, appId: "../evil", replaceExisting: false, admin: null })).rejects.toBeTruthy();
    await expect(owner.api.apps.install({ uuid: site, appId: "nope", replaceExisting: false, admin: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("permissions: files.write is required, database.manage for apps with a database; strangers see nothing", async () => {
    fresh();
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    await finished(owner.api, (await owner.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: false, admin: null })).id);
    await expect(writer.api.apps.install({ uuid: site, appId: "wordpress", replaceExisting: true, admin: null })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("database.manage") });
    await expect(stranger.api.apps.catalog({ uuid: site })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [last] = await owner.api.apps.jobs({ uuid: site });
    await expect(stranger.api.apps.job({ id: last!.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ro = await h.user({ discordId: "280000000000000004", name: "lezer" });
    await owner.api.subusers.invite({ uuid: site, who: ro.discordId, permissions: ["files.read"] });
    await expect(ro.api.apps.catalog({ uuid: site })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a running row without a live worker (panel restart) is reported as interrupted", async () => {
    const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, site));
    const [r] = await getDb().insert(schema.appInstalls).values({ serverId: s!.id, appId: "grav", steps: [{ key: "download", status: "running" }] }).returning();
    const j = await owner.api.apps.job({ id: r!.id });
    expect(j).toMatchObject({ status: "failed", errorCode: "INTERRUPTED" });
    expect(j.steps[0]!.status).toBe("failed");
  });
});

