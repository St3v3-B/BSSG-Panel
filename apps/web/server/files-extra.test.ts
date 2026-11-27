import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { getSigningKey, verifyJwt } from "./lib/jwt";
import { OWNER, useHarness, type TestUser } from "./test/harness";

/** files.search / chmod / move / archiveUrl. */
const h = useHarness({ env: { REDIS_URL: "redis://127.0.0.1:1" } });
let player: TestUser, reader: TestUser, stranger: TestUser;
let uuid = "";
let serverId = 0;

beforeAll(async () => {
  const admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "270000000000000001", name: "speler" });
  reader = await h.user({ discordId: "270000000000000002", name: "lezer" });
  stranger = await h.user({ discordId: "270000000000000003", name: "vreemd" });
  const d = await admin.api.admin.servers.create({
    name: "F2",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(25590)],
    variables: {},
    startOnInstall: false,
  });
  uuid = d.uuid;
  const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  serverId = srv!.id;
  const fs = h.daemon.fs(uuid);
  fs.dirs.add("/plugins");
  fs.dirs.add("/archief");
  fs.files.set("/plugins/Essentials.jar", "jar");
  fs.files.set("/plugins/config.yml", "motd: hallo\nport: 25565\n");
  fs.files.set("/server.properties", "motd=Hallo wereld\n");
  await player.api.subusers.invite({ uuid, who: reader.discordId, permissions: ["files.read"] });
});

const actions = async (action: string) =>
  getDb().select().from(schema.activityLog).where(and(eq(schema.activityLog.serverId, serverId), eq(schema.activityLog.action, action)));

describe("files.search", () => {
  it("op naam en op inhoud, via de daemon, met files.read", async () => {
    const byName = await reader.api.files.search({ uuid, query: "ess" });
    expect(byName.results.map((r) => r.entry.path)).toEqual(["/plugins/Essentials.jar"]);
    expect(byName.results[0]!.entry.modifiedAt).toBeInstanceOf(Date);
    expect(byName).toMatchObject({ truncated: false, timedOut: false });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/files/search`)?.body).toEqual({ path: "/", query: "ess", content: false, limit: 200 });

    const byContent = await player.api.files.search({ uuid, path: "/plugins", query: "MOTD", content: true, limit: 5 });
    expect(byContent.results).toEqual([expect.objectContaining({ entry: expect.objectContaining({ path: "/plugins/config.yml" }), matches: [{ line: 1, text: "motd: hallo" }] })]);
  });

  it("invoer en rechten", async () => {
    await expect(player.api.files.search({ uuid, query: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(stranger.api.files.search({ uuid, query: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.files.search({ uuid, path: "/bestaat-niet", query: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("files.chmod", () => {
  it("geeft mode, dirMode en recursive door en logt", async () => {
    expect(await player.api.files.chmod({ uuid, paths: ["/plugins"], mode: "644", dirMode: "755", recursive: true })).toEqual({ changed: 1 });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/files/chmod`)?.body).toEqual({ paths: ["/plugins"], mode: "644", dir_mode: "755", recursive: true, allow_special: false });
    const [log] = await actions("server.file.chmod");
    expect(log!.metadata).toMatchObject({ paths: ["/plugins"], mode: "644", dirMode: "755", recursive: true });
  });

  it("speciale bits alleen bewust; ongeldige modus; geen files.write", async () => {
    await expect(player.api.files.chmod({ uuid, paths: ["/server.properties"], mode: "4755" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await player.api.files.chmod({ uuid, paths: ["/server.properties"], mode: "2755", allowSpecial: true })).toEqual({ changed: 1 });
    await expect(player.api.files.chmod({ uuid, paths: ["/server.properties"], mode: "9" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(reader.api.files.chmod({ uuid, paths: ["/server.properties"], mode: "644" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("files.move", () => {
  it("verplaatst elk item naar de doelmap en logt één keer", async () => {
    h.daemon.fs(uuid).files.set("/a.txt", "a");
    h.daemon.fs(uuid).files.set("/b.txt", "b");
    await player.api.files.move({ uuid, paths: ["/a.txt", "/b.txt"], destination: "/archief" });
    const fs = h.daemon.fs(uuid);
    expect(fs.files.get("/archief/a.txt")).toBe("a");
    expect(fs.files.get("/archief/b.txt")).toBe("b");
    expect(fs.files.has("/a.txt")).toBe(false);
    const logs = await actions("server.file.move");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.metadata).toEqual({ paths: ["/a.txt", "/b.txt"], destination: "/archief" });
  });

  it("niet in zichzelf, niet zonder files.write", async () => {
    await expect(player.api.files.move({ uuid, paths: ["/plugins"], destination: "/plugins/sub" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "MOVE_INTO_SELF" });
    await expect(reader.api.files.move({ uuid, paths: ["/server.properties"], destination: "/archief" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("files.archiveUrl", () => {
  it("eenmalige JWT met files.read en de selectie in de archive-claim", async () => {
    const key = await getSigningKey();
    const r = await reader.api.files.archiveUrl({ uuid, root: "/", paths: ["/plugins", "/server.properties"], format: "tar.gz" });
    const u = new URL(r.url);
    expect(`${u.origin}${u.pathname}`).toBe(`https://node1.test/api/servers/${uuid}/files/archive`);
    expect([...u.searchParams.keys()]).toEqual(["token"]);
    const c = verifyJwt(u.searchParams.get("token")!, key.publicKey)!.claims;
    expect(c).toMatchObject({ server_uuid: uuid, permissions: ["files.read"], archive: { root: "/", paths: ["/plugins", "/server.properties"], format: "tar.gz" } });
    expect(c.path).toBeUndefined();
    expect(r.expiresAt.getTime()).toBe(c.exp * 1000);
    const [log] = await actions("server.file.download_archive");
    expect(log!.metadata).toEqual({ root: "/", paths: ["/plugins", "/server.properties"], format: "tar.gz" });
    // Standaard zip.
    const z = new URL((await player.api.files.archiveUrl({ uuid, root: "/", paths: ["/"] })).url);
    expect(verifyJwt(z.searchParams.get("token")!, key.publicKey)!.claims.archive?.format).toBe("zip");
  });

  it("vreemde krijgt niets", async () => {
    await expect(stranger.api.files.archiveUrl({ uuid, root: "/", paths: ["/"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
