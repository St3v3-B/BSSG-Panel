import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cloneTiming } from "./clone";
import { daemonUrlOverrides } from "./daemon";
import { getDb, schema } from "./db";
import { encrypt } from "./lib/crypto";
import { flushNotify, resetNotify } from "./notify";
import { publishTiming } from "./publish";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, friend: TestUser, helper: TestUser, partial: TestUser, stranger: TestUser;
let webId = 0;
let host = 0;
let node2 = 0;
let d2: FakeDaemon;
const Q = { maxRamMb: 8192, maxDiskMb: 16384, maxCpuPct: 800, maxServers: 10, maxDatabases: 10, templateIds: null, nodeIds: null, maxPortsPerServer: 2 };
const limits = { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 1024 };
const PROD_HOST = "shop.panel.test";
const STAGING_HOST = "staging.shop.panel.test";
const WP_CONFIG = "<?php\ndefine('DB_NAME', 'prod');\n$table_prefix = 'wp_';\n";

beforeAll(async () => {
  cloneTiming.pollMs = 10;
  cloneTiming.progressMs = 0;
  publishTiming.pollMs = 10;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  friend = await h.user({ discordId: "292000000000000001", name: "vriend" });
  helper = await h.user({ discordId: "292000000000000002", name: "helper" });
  partial = await h.user({ discordId: "292000000000000003", name: "half" });
  stranger = await h.user({ discordId: "292000000000000004", name: "vreemde" });
  webId = await h.templateId("testweb");
  await admin.api.admin.users.setQuota({ id: friend.id, ...Q });
  const db = getDb();
  await db.delete(schema.databaseHosts);
  const [hst] = await db.insert(schema.databaseHosts).values({ name: "local", host: "panel-mariadb", port: 3306, adminUser: "", adminPasswordEnc: "x", nodeId: h.localNodeId, daemonManaged: true }).returning();
  host = hst!.id;
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  node2 = n.node.id;
  await db.update(schema.nodes).set({ supportsDomains: true }).where(eq(schema.nodes.id, node2));
  await db.insert(schema.databaseHosts).values({ name: "node2-db", host: "panel-mariadb", port: 3306, adminUser: "", adminPasswordEnc: "x", nodeId: node2, daemonManaged: true });
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
});
afterAll(async () => {
  await flushNotify();
  daemonUrlOverrides.delete(node2);
  await d2.stop();
});
beforeEach(async () => {
  const db = getDb();
  await db.delete(schema.sitePublishes);
  await db.delete(schema.servers);
  await db.delete(schema.s3Targets);
  await db.delete(schema.allocations).where(isNull(schema.allocations.serverId));
  await flushNotify();
  h.daemon.reset();
  d2.reset();
  resetNotify();
});

const srv = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!;

/** Productiesite (online) met WordPress-achtige bestanden, een database en een domein. */
async function production(owner: TestUser = friend) {
  const s = await admin.api.admin.servers.create({ name: "Shop", ownerId: owner.id, nodeId: h.localNodeId, templateId: webId, limits, allocationIds: [], variables: {}, startOnInstall: false });
  h.daemon.servers.get(s.uuid)!.state = "online";
  const fs = h.daemon.fs(s.uuid);
  fs.dirs.add("/public");
  fs.files.set("/wp-config.php", WP_CONFIG);
  fs.files.set("/public/index.php", "v1");
  fs.files.set("/public/old.txt", "alleen in productie");
  fs.files.set("/.panel-deploy/x", "deploy");
  const row = await srv(s.uuid);
  const name = `s${s.uuid.slice(0, 8)}_wordpress`;
  await getDb().insert(schema.databases).values({ serverId: row.id, hostId: host, name, username: `u${s.uuid.slice(0, 8)}_wp`, passwordEnc: encrypt("geheim-wachtwoord") });
  h.daemon.dbs.set(name, { username: `u${s.uuid.slice(0, 8)}_wp`, password: "geheim-wachtwoord", data: "INSERT INTO `wp_options` VALUES (1,'siteurl','https://shop.panel.test');\n-- bestelling 1001\n" });
  await getDb().insert(schema.domains).values({ serverId: row.id, hostname: PROD_HOST, targetPort: null });
  return { uuid: s.uuid, db: name };
}

async function cloneDone(u: TestUser, id: number) {
  for (let i = 0; i < 500; i++) {
    const j = await u.api.servers.cloneJob({ id });
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("clone did not finish");
}
async function done(u: TestUser, id: number) {
  for (let i = 0; i < 500; i++) {
    const j = await u.api.publish.job({ id });
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`publish did not finish: ${JSON.stringify(await u.api.publish.job({ id }))}`);
}

/** Staging via publish.createStaging (kopie met database en eigen domein), daarna gewijzigd. */
async function staging(prod: { uuid: string }, o: { nodeId?: number } = {}) {
  const job = o.nodeId
    ? await admin.api.servers.clone({ uuid: prod.uuid, name: "Shop (staging)", copyDatabases: true, domain: STAGING_HOST, nodeId: o.nodeId, startAfter: false })
    : await friend.api.publish.createStaging({ uuid: prod.uuid, domain: STAGING_HOST });
  const j = await cloneDone(o.nodeId ? admin : friend, job.id);
  expect(j.status).toBe("succeeded");
  const d = o.nodeId ? d2 : h.daemon;
  const fs = d.fs(j.target.uuid);
  fs.files.set("/wp-config.php", "<?php // staging-db\n$table_prefix = 'wp_';\n");
  fs.files.set("/public/index.php", "v2");
  fs.files.set("/public/new.txt", "nieuw");
  fs.files.delete("/public/old.txt");
  fs.files.set("/.env", "STAGING=1");
  const sdb = j.databases[0]!.to;
  d.dbs.get(sdb)!.data = `INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://${STAGING_HOST}'),(2,'w','a:1:{s:3:\\"url\\";s:${`https://${STAGING_HOST}/x`.length}:\\"https://${STAGING_HOST}/x\\";}');\n`;
  return { uuid: j.target.uuid, db: sdb };
}

describe("publish: relatie en info", () => {
  it("staging ziet zijn productie, productie zijn staging; createStaging alleen voor websites", async () => {
    const p = await production();
    const s = await staging(p);
    const si = await friend.api.publish.info({ uuid: s.uuid });
    expect(si).toMatchObject({ role: "staging", production: { uuid: p.uuid, name: "Shop", sameNode: true }, canPublish: true, reason: null, backupAvailable: false, stagingHost: STAGING_HOST, productionHost: PROD_HOST });
    expect(si.databases).toEqual([{ from: s.db, to: p.db }]);
    expect(si.defaultExcludes.map((e) => e.pattern)).toEqual(expect.arrayContaining(["wp-config.php", ".env", "public/wp-content/uploads/"]));
    const pi = await friend.api.publish.info({ uuid: p.uuid });
    expect(pi).toMatchObject({ role: "production", production: null, canPublish: false, reason: "NOT_A_STAGING_SITE" });
    expect(pi.stagings.map((x) => x.uuid)).toEqual([s.uuid]);
    expect((await srv(s.uuid)).name).toBe("Shop (staging)");
    await expect(stranger.api.publish.info({ uuid: s.uuid })).rejects.toThrow(/NO_ACCESS/);
  });
});

describe("publish.start: bestanden", () => {
  it("zonder S3-doel alleen met skipBackup; uitsluitingen, productie weer gestart, geschiedenis en log op beide", async () => {
    const p = await production();
    const s = await staging(p);
    await expect(friend.api.publish.start({ uuid: s.uuid })).rejects.toThrow(/BACKUP_UNAVAILABLE/);
    await expect(friend.api.publish.start({ uuid: s.uuid, files: false, databases: false, skipBackup: true })).rejects.toThrow(/NOTHING_TO_PUBLISH/);
    await expect(friend.api.publish.start({ uuid: p.uuid, skipBackup: true })).rejects.toThrow(/NOT_A_STAGING_SITE/);
    const job = await friend.api.publish.start({ uuid: s.uuid, skipBackup: true });
    const j = await done(friend, job.id);
    expect(j).toMatchObject({ status: "succeeded", restored: null, options: { files: true, databases: false, backup: false, sameNode: true } });
    expect(j.steps.map((x) => [x.key, x.status])).toEqual([["backup", "skipped"], ["prepare", "done"], ["stop", "done"], ["files", "done"], ["databases", "skipped"], ["start", "done"], ["finish", "done"]]);
    expect(j.kept).toEqual(["/wp-config.php"]);
    expect(j.warnings.some((w) => /without a backup|No backup/.test(w))).toBe(true);
    const fs = h.daemon.fs(p.uuid);
    expect(fs.files.get("/public/index.php")).toBe("v2");
    expect(fs.files.get("/public/new.txt")).toBe("nieuw");
    expect(fs.files.has("/public/old.txt")).toBe(false);
    expect(fs.files.get("/wp-config.php")).toBe(WP_CONFIG); // productieconfig blijft
    expect(fs.files.has("/.env")).toBe(false); // staging-.env komt niet mee
    expect(fs.files.get("/.panel-deploy/x")).toBe("deploy"); // door het panel beheerd: ongemoeid
    // Zelfde node: lokale kopie, productie gestopt en weer gestart, werkmap opgeruimd.
    expect(h.daemon.last("POST", `/api/servers/${p.uuid}/publish/${j.id}/copy`)!.body).toEqual({ source_uuid: s.uuid });
    const powers = h.daemon.requests.filter((r) => r.path === `/api/servers/${p.uuid}/power`).map((r) => (r.body as { action: string }).action);
    expect(powers).toEqual(["stop", "start"]);
    expect(h.daemon.publishes.size).toBe(0);
    expect(h.daemon.dbs.get(p.db)!.data).toContain("bestelling 1001"); // database niet aangeraakt
    expect((await friend.api.publish.history({ uuid: p.uuid })).map((x) => x.id)).toEqual([j.id]);
    expect((await friend.api.publish.history({ uuid: s.uuid })).map((x) => x.id)).toEqual([j.id]);
    expect((await friend.api.publish.info({ uuid: p.uuid })).stagings[0]!.lastPublishedAt).not.toBeNull();
    for (const uuid of [p.uuid, s.uuid]) {
      const log = await admin.api.admin.activity.search({ serverUuid: uuid });
      expect(log.items.map((i) => i.action)).toEqual(expect.arrayContaining(["server.publish.start", "server.publish.complete"]));
    }
  });

  it("met een S3-doel: eerst een backup van productie (met databases), pas daarna kopiëren", async () => {
    const p = await production();
    const s = await staging(p);
    await admin.api.admin.s3Targets.create({ name: "S3", endpoint: "http://127.0.0.1:9", bucket: "b", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
    expect((await friend.api.publish.info({ uuid: s.uuid })).backupAvailable).toBe(true);
    h.daemon.override = (r) => {
      if (r.method !== "POST" || r.path !== `/api/servers/${p.uuid}/backups`) return undefined;
      const id = (r.body as { backup_id: number }).backup_id;
      setTimeout(() => void getDb().update(schema.backups).set({ status: "completed", completedAt: new Date() }).where(eq(schema.backups.id, id)).then(() => undefined), 30);
      return { status: 202 };
    };
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid })).id);
    expect(j).toMatchObject({ status: "succeeded", options: { backup: true } });
    expect(j.backupId).not.toBeNull();
    const [b] = await getDb().select().from(schema.backups).where(eq(schema.backups.id, j.backupId!));
    expect(b).toMatchObject({ status: "completed", includesDatabases: true, name: "Before publishing Shop (staging)" });
    const order = h.daemon.requests.map((r) => r.path);
    expect(order.findIndex((x) => x === `/api/servers/${p.uuid}/backups`)).toBeLessThan(order.findIndex((x) => x.startsWith(`/api/servers/${p.uuid}/publish/`)));
  });

  it("backup mislukt: niets aan productie veranderd", async () => {
    const p = await production();
    const s = await staging(p);
    await admin.api.admin.s3Targets.create({ name: "S3", endpoint: "http://127.0.0.1:9", bucket: "b", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
    h.daemon.override = (r) => {
      if (r.method !== "POST" || r.path !== `/api/servers/${p.uuid}/backups`) return undefined;
      const id = (r.body as { backup_id: number }).backup_id;
      setTimeout(() => void getDb().update(schema.backups).set({ status: "failed", error: "s3 kapot" }).where(eq(schema.backups.id, id)).then(() => undefined), 30);
      return { status: 202 };
    };
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid })).id);
    expect(j).toMatchObject({ status: "failed", errorCode: "BACKUP_FAILED", restored: null });
    expect(j.error).toMatch(/s3 kapot/);
    expect(h.daemon.fs(p.uuid).files.get("/public/index.php")).toBe("v1");
    expect(h.daemon.requests.some((r) => r.path === `/api/servers/${p.uuid}/power`)).toBe(false);
    expect(h.daemon.servers.get(p.uuid)!.state).toBe("online");
  });
});

describe("publish.start: databases", () => {
  it("bevestiging nodig; veiligheidskopie, vervangen met URL-vervanging (ook geserialiseerd) en siteurl/home; tijdelijke database weg", async () => {
    const p = await production();
    const s = await staging(p);
    await expect(friend.api.publish.start({ uuid: s.uuid, databases: true, skipBackup: true })).rejects.toThrow(/CONFIRM_DATABASES/);
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid, files: false, databases: true, confirmDatabases: true, skipBackup: true })).id);
    expect(j.status).toBe("succeeded");
    expect(j.databases).toEqual([{ from: s.db, to: p.db }]);
    expect(j.urlRewrite).toEqual({ from: STAGING_HOST, to: PROD_HOST, replaced: 2, skipped: 0 });
    const data = h.daemon.dbs.get(p.db)!.data;
    const url = `https://${PROD_HOST}/x`;
    expect(data).toContain(`(1,'siteurl','https://${PROD_HOST}')`);
    expect(data).toContain(`s:${url.length}:\\"${url}\\"`);
    expect(data).not.toContain("bestelling 1001");
    expect(data).toContain(`UPDATE \`wp_options\` SET option_value = REPLACE(option_value, '://${STAGING_HOST}', '://${PROD_HOST}') WHERE option_name IN ('siteurl', 'home');`);
    expect(h.daemon.last("PUT", `/api/db/databases/${p.db}/import`)!.path).toContain("replace=1");
    // Veiligheidskopie gemaakt en weer verwijderd; staging ongemoeid.
    expect(h.daemon.requests.some((r) => r.method === "POST" && r.path === "/api/db/databases" && (r.body as { name: string }).name === `pb${j.id}_1`)).toBe(true);
    expect(h.daemon.dbs.has(`pb${j.id}_1`)).toBe(false);
    expect(h.daemon.dbs.get(s.db)!.data).toContain(STAGING_HOST);
    // Bestanden niet aangeraakt.
    expect(h.daemon.fs(p.uuid).files.get("/public/index.php")).toBe("v1");
  });

  it("import mislukt: database en bestanden terug zoals ze waren, productie weer gestart", async () => {
    const p = await production();
    const s = await staging(p);
    const before = h.daemon.dbs.get(p.db)!.data;
    let imports = 0;
    h.daemon.override = (r) => {
      // Veiligheidskopie lukt, de import van staging in productie niet; het terugzetten weer wel.
      if (r.method === "PUT" && r.path.startsWith(`/api/db/databases/${p.db}/import`) && imports++ === 0) return { status: 500, body: { error: "import_failed", message: "syntax kapot" } };
      return undefined;
    };
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid, databases: true, confirmDatabases: true, skipBackup: true })).id);
    expect(j).toMatchObject({ status: "failed", restored: true });
    expect(j.error).toMatch(/syntax kapot/);
    expect(j.steps.find((x) => x.key === "databases")!.status).toBe("failed");
    expect(h.daemon.dbs.get(p.db)!.data).toBe(before);
    expect(h.daemon.fs(p.uuid).files.get("/public/index.php")).toBe("v1");
    expect(h.daemon.fs(p.uuid).files.get("/public/old.txt")).toBe("alleen in productie");
    expect(h.daemon.servers.get(p.uuid)!.state).toBe("starting");
    expect([...h.daemon.dbs.keys()].some((k) => k.startsWith("pb"))).toBe(false);
    const log = await admin.api.admin.activity.search({ serverUuid: p.uuid });
    expect(log.items.map((i) => i.action)).toContain("server.publish.failed");
  });
});

describe("publish.start: fouten", () => {
  it("omwisselen mislukt: productie hersteld en weer gestart", async () => {
    const p = await production();
    const s = await staging(p);
    h.daemon.publishSwapFails = true;
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid, skipBackup: true })).id);
    expect(j).toMatchObject({ status: "failed", restored: true });
    expect(j.steps.find((x) => x.key === "files")!.status).toBe("failed");
    expect(h.daemon.fs(p.uuid).files.get("/public/index.php")).toBe("v1");
    expect(h.daemon.requests.some((r) => r.path === `/api/servers/${p.uuid}/publish/${j.id}/rollback`)).toBe(true);
    expect(h.daemon.servers.get(p.uuid)!.state).toBe("starting");
  });

  it("oudere daemon zonder /publish: DAEMON_TOO_OLD, productie draait gewoon door", async () => {
    const p = await production();
    const s = await staging(p);
    h.daemon.publishUnsupported = true;
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid, skipBackup: true })).id);
    expect(j).toMatchObject({ status: "failed", errorCode: "DAEMON_TOO_OLD", restored: null });
    expect(h.daemon.servers.get(p.uuid)!.state).toBe("online");
    expect(h.daemon.fs(p.uuid).files.get("/public/index.php")).toBe("v1");
  });

  it("power op productie geblokkeerd zolang het loopt; geen tweede publicatie", async () => {
    const p = await production();
    const s = await staging(p);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    h.daemon.transferHold = () => (entered(), held);
    const job = await friend.api.publish.start({ uuid: s.uuid, skipBackup: true });
    await inside;
    await expect(friend.api.servers.power({ uuid: p.uuid, action: "stop" })).rejects.toThrow(/PUBLISH_IN_PROGRESS/);
    await expect(friend.api.publish.start({ uuid: s.uuid, skipBackup: true })).rejects.toThrow(/PUBLISH_IN_PROGRESS/);
    expect((await friend.api.publish.info({ uuid: s.uuid })).running?.id).toBe(job.id);
    release();
    expect((await done(friend, job.id)).status).toBe("succeeded");
  });

  it("onderbroken taak (panel herstart): mislukt en productie teruggezet", async () => {
    const p = await production();
    const s = await staging(p);
    const pr = await srv(p.uuid);
    const sr = await srv(s.uuid);
    const [row] = await getDb()
      .insert(schema.sitePublishes)
      .values({ stagingServerId: sr.id, productionServerId: pr.id, stagingUuid: s.uuid, productionUuid: p.uuid, stagingName: "x", productionName: "y", userId: friend.id, steps: [{ key: "files", status: "running" }], options: { files: true, databases: false, exclude: [], rewriteUrls: true, backup: false, sameNode: true } })
      .returning();
    const j = await friend.api.publish.job({ id: row!.id });
    expect(j).toMatchObject({ status: "failed", errorCode: "INTERRUPTED", restored: true });
    expect(h.daemon.requests.some((r) => r.path === `/api/servers/${p.uuid}/publish/${row!.id}/rollback`)).toBe(true);
  });
});

describe("publish: rechten", () => {
  it("subuser met de juiste rechten op beide mag; zonder rechten op productie FORBIDDEN; vreemden en API-sleutels niet; admin altijd", async () => {
    const p = await production();
    const s = await staging(p);
    await friend.api.subusers.invite({ uuid: s.uuid, who: helper.discordId, permissions: ["files.read"] });
    await friend.api.subusers.invite({ uuid: p.uuid, who: helper.discordId, permissions: ["files.write", "power"] });
    await friend.api.subusers.invite({ uuid: s.uuid, who: partial.discordId, permissions: ["files.read", "files.write", "database.manage"] });
    await friend.api.subusers.invite({ uuid: p.uuid, who: partial.discordId, permissions: ["files.read"] });

    expect(await partial.api.publish.info({ uuid: s.uuid })).toMatchObject({ canPublish: false, reason: "MISSING_PERMISSION: files.write" });
    await expect(partial.api.publish.start({ uuid: s.uuid, skipBackup: true })).rejects.toThrow(/MISSING_PERMISSION: files.write/);
    await expect(stranger.api.publish.start({ uuid: s.uuid, skipBackup: true })).rejects.toThrow(/NO_ACCESS/);
    await expect(stranger.api.publish.history({ uuid: p.uuid })).rejects.toThrow(/NO_ACCESS/);
    // Databases vragen database.manage op beide.
    await expect(helper.api.publish.start({ uuid: s.uuid, databases: true, confirmDatabases: true, skipBackup: true })).rejects.toThrow(/MISSING_PERMISSION: database.manage/);
    // Met een backupdoel ook backup.create op productie.
    await admin.api.admin.s3Targets.create({ name: "S3", endpoint: "http://127.0.0.1:9", bucket: "b", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
    await expect(helper.api.publish.start({ uuid: s.uuid })).rejects.toThrow(/MISSING_PERMISSION: backup.create/);
    await getDb().delete(schema.s3Targets);
    // Alleen subuser: geen createStaging.
    await expect(helper.api.publish.createStaging({ uuid: p.uuid })).rejects.toThrow(/OWNER_ONLY/);

    const j = await done(helper, (await helper.api.publish.start({ uuid: s.uuid, skipBackup: true })).id);
    expect(j.status).toBe("succeeded");
    await expect(stranger.api.publish.job({ id: j.id })).rejects.toThrow(/JOB_NOT_FOUND/);
    expect((await partial.api.publish.job({ id: j.id })).id).toBe(j.id);

    const a = await done(admin, (await admin.api.publish.start({ uuid: s.uuid, skipBackup: true })).id);
    expect(a.status).toBe("succeeded");
  });
});

describe("publish: andere node", () => {
  it("staging op een andere node: via de tar-stroom (zonder .panel-*), databases tussen de nodes", async () => {
    const p = await production();
    const s = await staging(p, { nodeId: node2 });
    d2.fs(s.uuid).files.set("/.panel-wp-setup.json", "staging-setup");
    const info = await friend.api.publish.info({ uuid: s.uuid });
    expect(info).toMatchObject({ production: { sameNode: false }, notes: expect.arrayContaining(["cross_node"]) });
    const j = await done(friend, (await friend.api.publish.start({ uuid: s.uuid, databases: true, confirmDatabases: true, skipBackup: true })).id);
    expect(j).toMatchObject({ status: "succeeded", options: { sameNode: false } });
    expect(d2.requests.some((r) => r.path === `/api/servers/${s.uuid}/transfer/export?live=1&exclude_internal=1`)).toBe(true);
    expect(h.daemon.requests.some((r) => r.method === "PUT" && r.path === `/api/servers/${p.uuid}/publish/${j.id}/data`)).toBe(true);
    const fs = h.daemon.fs(p.uuid);
    expect(fs.files.get("/public/index.php")).toBe("v2");
    expect(fs.files.has("/.panel-wp-setup.json")).toBe(false);
    expect(h.daemon.dbs.get(p.db)!.data).toContain(`https://${PROD_HOST}`);
  });
});
