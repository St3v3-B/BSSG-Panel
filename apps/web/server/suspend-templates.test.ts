import { buildRouter, createCallerFactory, parseTemplate } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as sftpAuthRoute } from "@/app/api/remote/sftp/auth/route";
import { createContext } from "./context";
import { getDb, schema } from "./db";
import { implementation } from "./index";
import { encrypt } from "./lib/crypto";
import { resetLimiter } from "./lib/ratelimit";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
const caller = createCallerFactory(buildRouter(implementation));
let admin: TestUser, player: TestUser, helper: TestUser;
let uuid = "", serverId = 0, shortId = "", domainId = 0, dbId = 0;
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };
const withKey = async (key: string) => caller(await createContext(new Request("http://panel.test/api/trpc", { headers: { authorization: `Bearer ${key}` } }), new Headers()));

const blocked = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "FORBIDDEN", message: "SUSPENDED" });
/** Mag falen (daemon, Maria, ...) maar niet op opschorting. */
async function passes(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: Error) => x);
  expect(e?.message ?? "").not.toMatch(/SUSPENDED/);
}

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "240000000000000001", name: "speler" });
  helper = await h.user({ discordId: "240000000000000002", name: "helper" });
  const a = await h.allocation(34000);
  const d = await admin.api.admin.servers.create({ name: "S", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"), limits, allocationIds: [a], variables: {}, startOnInstall: false });
  uuid = d.uuid;
  shortId = uuid.slice(0, 8);
  const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  serverId = s!.id;
  await player.api.subusers.invite({ uuid, who: helper.discordId, permissions: ["files.read", "files.write", "power", "console.read", "console.write", "database.manage", "domain.manage"] });
  const [dom] = await getDb().insert(schema.domains).values({ serverId, hostname: "s.panel.test", targetPort: 25565 }).returning();
  domainId = dom!.id;
  const [host] = await getDb().insert(schema.databaseHosts).values({ name: "t", host: "db.test", adminUser: "root", adminPasswordEnc: encrypt("x") }).returning();
  const [db] = await getDb().insert(schema.databases).values({ serverId, hostId: host!.id, name: "s_x", username: "u_x", passwordEnc: encrypt("pw") }).returning();
  dbId = db!.id;
});

const setSuspended = (on: boolean) => admin.api.admin.servers.setSuspended({ uuid, suspended: on, reason: on ? "test" : null });

describe("opschorting afdwingen", () => {
  it("niet opgeschort: alles werkt zoals voorheen", async () => {
    await player.api.files.write({ uuid, path: "/a.txt", content: "a" });
    await player.api.servers.rename({ uuid, name: "Naam" });
    expect((await player.api.servers.consoleToken({ uuid })).token).toBeTruthy();
  });

  it("eigenaar en subuser: wijzigen geblokkeerd, lezen blijft kunnen", async () => {
    await setSuspended(true);
    for (const u of [player, helper]) {
      const api = u.api;
      await blocked(api.servers.power({ uuid, action: "start" }));
      await blocked(api.servers.power({ uuid, action: "restart" }));
      await passes(api.servers.power({ uuid, action: "stop" }));
      await passes(api.servers.power({ uuid, action: "kill" }));
      await blocked(api.servers.sendCommand({ uuid, command: "say hi" }));
      await blocked(api.files.write({ uuid, path: "/b.txt", content: "b" }));
      await blocked(api.files.mkdir({ uuid, path: "/d" }));
      await blocked(api.files.rename({ uuid, from: "/a.txt", to: "/c.txt" }));
      await blocked(api.files.delete({ uuid, paths: ["/a.txt"] }));
      await blocked(api.files.compress({ uuid, root: "/", paths: ["a.txt"] }));
      await blocked(api.files.decompress({ uuid, path: "/x.zip" }));
      await blocked(api.files.uploadUrl({ uuid, directory: "/" }));
      await blocked(api.databases.create({ uuid, name: "nieuw", hostId: null }));
      await blocked(api.databases.resetPassword({ id: dbId }));
      await blocked(api.databases.delete({ id: dbId }));
      await blocked(api.domains.add({ uuid, hostname: "n.panel.test", protocol: "http", targetPort: 80, redirectTo: null, wildcard: false, dnsProviderId: null }));
      await blocked(api.domains.update({ id: domainId, targetPort: 80, redirectTo: null }));
      await blocked(api.domains.remove({ id: domainId }));
      // lezen
      expect((await api.servers.get({ uuid })).suspended).toBeTruthy();
      expect((await api.databases.list({ uuid })).length).toBe(1);
      expect((await api.domains.list({ uuid })).length).toBe(1);
      expect((await api.files.downloadUrl({ uuid, path: "/a.txt" })).url).toContain("/files/download");
      expect((await api.files.read({ uuid, path: "/a.txt" })).content).toBe("a");
    }
    await blocked(player.api.servers.rename({ uuid, name: "x" }));
    await blocked(player.api.servers.updateVariables({ uuid, variables: {} }));
    await blocked(player.api.servers.updateSleep({ uuid, enabled: false, idleMinutes: 10 }).catch((e) => { throw e; }));
    await blocked(player.api.servers.reinstall({ uuid }));
    await blocked(player.api.subusers.invite({ uuid, who: admin.discordId, permissions: ["files.read"] }));
    await blocked(player.api.subusers.update({ uuid, userId: helper.id, permissions: ["files.read"] }));
    await blocked(player.api.subusers.remove({ uuid, userId: helper.id }));
    expect((await player.api.subusers.list({ uuid })).length).toBe(1);
  });

  it("console-token is alleen-lezen", async () => {
    const { token } = await player.api.servers.consoleToken({ uuid });
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
    expect(claims.permissions).toEqual(["console.read"]);
  });

  it("API-sleutel met schrijfrechten wordt ook geblokkeerd", async () => {
    const { key } = await player.api.account.createApiKey({ name: "bot", permissions: ["files.read", "files.write", "power"], expiresAt: null });
    const api = await withKey(key);
    await blocked(api.files.write({ uuid, path: "/k.txt", content: "k" }));
    await blocked(api.servers.power({ uuid, action: "start" }));
    expect((await api.files.read({ uuid, path: "/a.txt" })).content).toBe("a");
  });

  it("volledige admin wordt niet geblokkeerd", async () => {
    const api = admin.api;
    await passes(api.servers.power({ uuid, action: "start" }));
    await passes(api.servers.sendCommand({ uuid, command: "say hi" }));
    await api.files.write({ uuid, path: "/admin.txt", content: "ok" });
    await passes(api.files.uploadUrl({ uuid, directory: "/" }));
    await passes(api.databases.create({ uuid, name: "adm", hostId: null }));
    await passes(api.domains.update({ id: domainId, targetPort: 80, redirectTo: null }));
    await api.servers.rename({ uuid, name: "door admin" });
    const { token } = await api.servers.consoleToken({ uuid });
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).permissions).toContain("console.write");
  });

  it("SFTP: 403 voor eigenaar en voor API-sleutel; weer 200 na vrijgeven", async () => {
    await resetLimiter();
    const auth = (password: string) =>
      sftpAuthRoute(
        new Request("http://panel.test/api/remote/sftp/auth", {
          method: "POST",
          headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ username: `speler.${shortId}`, password, ip: "10.9.0.1" }),
        }),
        { params: Promise.resolve({}) },
      );
    await blocked(player.api.account.setSftpPassword({ uuid, password: "geheim-wachtwoord-8" }));
    await setSuspended(false);
    await player.api.account.setSftpPassword({ uuid, password: "geheim-wachtwoord-9" });
    await setSuspended(true);
    const { key } = await player.api.account.createApiKey({ name: "sftp", permissions: ["files.read"], expiresAt: null });
    expect((await auth("geheim-wachtwoord-9")).status).toBe(403);
    expect((await auth(key)).status).toBe(403);
    await setSuspended(false);
    await resetLimiter();
    expect((await auth("geheim-wachtwoord-9")).status).toBe(200);
    expect((await auth(key)).status).toBe(200);
  });

  it("na vrijgeven werkt alles weer", async () => {
    await player.api.files.write({ uuid, path: "/z.txt", content: "z" });
    const { token } = await player.api.servers.consoleToken({ uuid });
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).permissions).toContain("console.write");
  });
});

describe("admin.templates create/update/delete", () => {
  const yaml = (slug: string, version: number, extra = "") =>
    GAME_TEMPLATE.replace("slug: testgame", `slug: ${slug}`).replace("version: 1", `version: ${version}`) + extra;

  it("create: valideert, uniek, logt", async () => {
    const t = await admin.api.admin.templates.create({ yaml: yaml("eigen", 1) });
    expect(t).toMatchObject({ slug: "eigen", version: 1, serverCount: 0 });
    await expect(admin.api.admin.templates.create({ yaml: yaml("eigen", 1) })).rejects.toMatchObject({ code: "CONFLICT", message: "SLUG_EXISTS" });
    await expect(admin.api.admin.templates.create({ yaml: "slug: x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(player.api.admin.templates.create({ yaml: yaml("x", 1) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const log = await admin.api.admin.activity.search({ action: "admin.template.create" });
    expect(log.items.length).toBeGreaterThan(0);
  });

  it("update: zelfde slug, geen lagere versie", async () => {
    const id = await h.templateId("eigen");
    const nieuw = yaml("eigen", 2).replace("name: Testspel", "name: Aangepast");
    const t = await admin.api.admin.templates.update({ id, yaml: nieuw });
    expect(t).toMatchObject({ name: "Aangepast", version: 2 });
    await expect(admin.api.admin.templates.update({ id, yaml: yaml("eigen", 1) })).rejects.toMatchObject({ message: "VERSION_LOWER" });
    await expect(admin.api.admin.templates.update({ id, yaml: yaml("andere", 3) })).rejects.toMatchObject({ message: "SLUG_MISMATCH" });
    await expect(admin.api.admin.templates.update({ id, yaml: "kapot: [" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(admin.api.admin.templates.update({ id: 99999, yaml: nieuw })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(parseTemplate((await admin.api.admin.templates.get({ id })).yaml).ok).toBe(true);
  });

  it("delete: geweigerd zolang servers de template gebruiken", async () => {
    await expect(admin.api.admin.templates.delete({ id: await h.templateId("testgame") })).rejects.toMatchObject({ code: "CONFLICT", message: "TEMPLATE_IN_USE" });
    const id = await h.templateId("eigen");
    await admin.api.admin.templates.delete({ id });
    await expect(admin.api.admin.templates.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.api.admin.templates.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const log = await admin.api.admin.activity.search({ action: "admin.template.delete" });
    expect(log.items.length).toBe(1);
  });
});

describe("setSftpPassword en servers.activity: beveiliging", () => {
  it("setSftpPassword is verboden met een API-sleutel", async () => {
    const { key } = await player.api.account.createApiKey({ name: "ro", permissions: ["files.read"], expiresAt: null });
    const api = await withKey(key);
    await expect(api.account.setSftpPassword({ uuid, password: "lang-genoeg-wachtwoord" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "NOT_WITH_API_KEY" });
  });

  it("activity: subusers zien geen IP's en metadata (commando's); eigenaar en admin wel", async () => {
    await player.api.servers.sendCommand({ uuid, command: "op geheim-wachtwoord" }).catch(() => {});
    await getDb().insert(schema.activityLog).values({ serverId, userId: player.id, action: "server.console.command", metadata: { command: "login hunter2" }, ip: "203.0.113.77" });
    const own = await player.api.servers.activity({ uuid, limit: 50 });
    expect(own.items.some((i) => i.ip === "203.0.113.77" && JSON.stringify(i.metadata).includes("hunter2"))).toBe(true);
    const sub = await helper.api.servers.activity({ uuid, limit: 50 });
    expect(sub.items.length).toBeGreaterThan(0);
    expect(sub.items.every((i) => i.ip === null && Object.keys(i.metadata).length === 0)).toBe(true);
    expect(JSON.stringify(sub)).not.toMatch(/hunter2|203\.0\.113\.77/);
    const adm = await admin.api.servers.activity({ uuid, limit: 50 });
    expect(adm.items.some((i) => i.ip === "203.0.113.77")).toBe(true);
  });
});
