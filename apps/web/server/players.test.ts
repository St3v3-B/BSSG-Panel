import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { clearPlayersCache, commandFor, newLines, offlineUuid, parseGlist, parseList, playersTiming, setProperty } from "./players";
import { mockExternal } from "./test/external-fake";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ templates: { "game/paper.yaml": tpl("paper.yaml"), "game/velocity.yaml": tpl("velocity.yaml"), "game/java-generic.yaml": tpl("java-generic.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };

const NOTCH = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
let ext: ReturnType<typeof mockExternal>;
let admin: TestUser, alice: TestUser, bob: TestUser, viewer: TestUser, manager: TestUser;
let paper = "", proxy = "", generic = "";
const fs = (u: string) => h.daemon.fs(u);
const files = (u: string) => fs(u).files;
const json = (u: string, p: string) => JSON.parse(files(u).get(p)!) as Array<Record<string, unknown>>;
const setState = (u: string, st: "online" | "offline" | "starting") => (h.daemon.servers.get(u)!.state = st);
const cmds = (u: string) => h.daemon.commands.get(u) ?? [];
const create = async (name: string, owner: TestUser, slug: string, port: number) => {
  const a = await h.allocation(port);
  return (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [a], variables: {}, startOnInstall: false })).uuid;
};

beforeAll(async () => {
  Object.assign(playersTiming, { settleMs: 0, listWaitMs: 600, pollMs: 20, cacheMs: 0 });
  ext = mockExternal((url) => {
    if (url.hostname !== "api.mojang.com") return undefined;
    const m = /^\/users\/profiles\/minecraft\/([A-Za-z0-9_]+)$/.exec(url.pathname);
    if (m && m[1]!.toLowerCase() === "notch") return { json: { id: NOTCH.replaceAll("-", ""), name: "Notch" } };
    return { status: 404 };
  });
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "210100000000000001", name: "alice" });
  bob = await h.user({ discordId: "210200000000000002", name: "bob" });
  viewer = await h.user({ discordId: "210300000000000003", name: "viewer" });
  manager = await h.user({ discordId: "210400000000000004", name: "manager" });
  paper = await create("Paper", alice, "paper", 36301);
  proxy = await create("Proxy", alice, "velocity", 36302);
  generic = await create("Generic", alice, "java-generic", 36303);
  await alice.api.subusers.invite({ uuid: paper, who: viewer.discordId, permissions: ["players.read"] });
  await alice.api.subusers.invite({ uuid: paper, who: manager.discordId, permissions: ["players.read", "players.manage"] });
});
afterAll(() => ext.restore());
beforeEach(() => {
  clearPlayersCache();
  h.daemon.onCommand = null;
  files(paper).set("/server.properties", "#Minecraft server properties\nonline-mode=true\nwhite-list=false\nmotd=Hoi\n");
  for (const f of ["/whitelist.json", "/ops.json", "/banned-players.json", "/banned-ips.json", "/usercache.json"]) files(paper).delete(f);
  fs(paper).dirs.delete("/plugins");
  files(paper).delete("/plugins/floodgate-spigot.jar");
  setState(paper, "offline");
});

describe("hulpfuncties", () => {
  it("offline-UUID zoals Java's nameUUIDFromBytes (v3)", () => {
    // Bekende waarde: OfflinePlayer:Notch
    expect(offlineUuid("Notch")).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
    const u = offlineUuid("Steve");
    expect(u[14]).toBe("3");
    expect(["8", "9", "a", "b"]).toContain(u[19]);
    const md5 = createHash("md5").update("OfflinePlayer:Steve").digest("hex");
    expect(u.replaceAll("-", "").slice(0, 12)).toBe(md5.slice(0, 12));
  });

  it("list uuids en glist parsen, met logprefix en kleurcodes", () => {
    expect(parseList(["[12:00:00 INFO]: There are 2 of a max of 20 players online: Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5), .Pocket (00000000-0000-0000-0009-01f2a3b4c5d6)"])).toEqual({
      online: 2,
      max: 20,
      players: [{ name: "Steve", uuid: NOTCH, server: null }, { name: ".Pocket", uuid: "00000000-0000-0000-0009-01f2a3b4c5d6", server: null }],
    });
    expect(parseList(["[12:00:00] [Server thread/INFO]: There are 0 of a max of 10 players online: "])).toEqual({ online: 0, max: 10, players: [] });
    expect(parseList(["iets anders"])).toBeNull();
    expect(parseGlist(["[12:00:00 INFO]: \x1b[33m[lobby] (2): Steve, Alex", "[12:00:00 INFO]: [survival] (0): ", "[12:00:00 INFO]: There are 2 players currently connected to the proxy."])).toEqual({
      online: 2,
      players: [{ name: "Steve", uuid: null, server: "lobby" }, { name: "Alex", uuid: null, server: "lobby" }],
    });
  });

  it("newLines: alleen wat na het eerste venster kwam", () => {
    expect(newLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
    expect(newLines(["a", "b"], ["a", "b"])).toEqual([]);
    expect(newLines([], ["x"])).toEqual(["x"]);
  });

  it("setProperty laat de rest staan", () => {
    expect(setProperty("#c\na=1\nwhite-list=false\n", "white-list", "true")).toBe("#c\na=1\nwhite-list=true\n");
    expect(setProperty("a=1", "white-list", "true")).toBe("a=1\nwhite-list=true\n");
  });

  it("commando's: geen injectie mogelijk", () => {
    expect(commandFor({ action: "ban", name: "Steve", reason: "griefing" }, false)).toBe("ban Steve griefing");
    expect(commandFor({ action: "whitelistAdd", name: ".Pocket" }, true)).toBe("fwhitelist add Pocket");
    expect(() => commandFor({ action: "op", name: "Steve\nstop" }, false)).toThrow(/INVALID_PLAYER_NAME/);
    expect(() => commandFor({ action: "op", name: ".Pocket" }, false)).toThrow(/BEDROCK_NOT_AVAILABLE/);
    expect(() => commandFor({ action: "kick", name: "Steve", reason: "x\nstop" }, false)).toThrow(/INVALID_REASON/);
    expect(() => commandFor({ action: "pardonIp", ip: "1.2.3.4; stop" }, false)).toThrow(/INVALID_IP/);
  });
});

describe("players.* rechten en validatie", () => {
  it("vreemde gebruiker FORBIDDEN, lezer mag lezen maar niet wijzigen", async () => {
    await expect(bob.api.players.info({ uuid: paper })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(bob.api.players.online({ uuid: paper })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await viewer.api.players.info({ uuid: paper })).supported).toBe(true);
    await expect(viewer.api.players.manage({ uuid: paper, op: { action: "op", name: "Steve" } })).rejects.toThrow(/MISSING_PERMISSION: players.manage/);
    await manager.api.players.manage({ uuid: paper, op: { action: "whitelistOn" } });
  });

  it("ongeldige namen en redenen weigert het schema (ook via een directe aanroep)", async () => {
    setState(paper, "online");
    for (const name of ["Steve stop", "a;op b", "x".repeat(17), "", "Steve\nop Evil", "émile", "..x"]) {
      await expect(alice.api.players.manage({ uuid: paper, op: { action: "op", name } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "kick", name: "Steve", reason: "bye\nstop" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "kick", name: "Steve", reason: "a stop" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "pardonIp", ip: "1.2.3.4\nstop" } as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(cmds(paper).some((c) => /stop|Evil/.test(c))).toBe(false);
  });

  it("Bedrock-namen alleen met Floodgate", async () => {
    setState(paper, "online");
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: ".Pocket" } })).rejects.toThrow(/BEDROCK_NOT_AVAILABLE/);
    fs(paper).dirs.add("/plugins");
    files(paper).set("/plugins/floodgate-spigot.jar", "jar");
    expect((await alice.api.players.info({ uuid: paper })).floodgate).toBe(true);
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: ".Pocket" } });
    expect(cmds(paper).at(-1)).toBe("fwhitelist add Pocket");
  });
});

describe("draaiende server: consolecommando's", () => {
  it("whitelist, op, ban met reden, ban-ip, kick; activiteitenlog per actie", async () => {
    setState(paper, "online");
    h.daemon.commands.delete(paper);
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistOn" } });
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: "Steve" } });
    await alice.api.players.manage({ uuid: paper, op: { action: "op", name: "Steve" } });
    await alice.api.players.manage({ uuid: paper, op: { action: "ban", name: "Griefer", reason: "  TNT bij spawn  " } });
    await alice.api.players.manage({ uuid: paper, op: { action: "banIp", target: "198.51.100.7" } });
    await alice.api.players.manage({ uuid: paper, op: { action: "kick", name: "Alex", reason: "AFK" } });
    expect(cmds(paper)).toEqual(["whitelist on", "whitelist add Steve", "op Steve", "ban Griefer TNT bij spawn", "ban-ip 198.51.100.7", "kick Alex AFK"]);
    const serverId = (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, paper)))[0]!.id;
    const acts = (await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.serverId, serverId))).map((a) => a.action);
    expect(acts).toEqual(expect.arrayContaining(["server.players.whitelistOn", "server.players.whitelistAdd", "server.players.op", "server.players.ban", "server.players.banIp", "server.players.kick"]));
    // bestanden niet zelf aangeraakt
    expect(files(paper).has("/whitelist.json")).toBe(false);
  });

  it("starten/stoppen: SERVER_BUSY", async () => {
    setState(paper, "starting");
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "op", name: "Steve" } })).rejects.toThrow(/SERVER_BUSY/);
  });
});

describe("gestopte server: bestanden direct bewerken", () => {
  it("online-mode: UUID via Mojang (juiste schrijfwijze), whitelist aan in server.properties", async () => {
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: "notch" } });
    expect(json(paper, "/whitelist.json")).toEqual([{ uuid: NOTCH, name: "Notch" }]);
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistOn" } });
    expect(files(paper).get("/server.properties")).toContain("white-list=true");
    expect(files(paper).get("/server.properties")).toContain("motd=Hoi");
    const info = await alice.api.players.info({ uuid: paper });
    expect(info).toMatchObject({ running: false, onlineMode: true, whitelistEnabled: true, whitelist: [{ name: "Notch", uuid: NOTCH }] });
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: "BestaatNiet_1" } })).rejects.toThrow(/PLAYER_NOT_FOUND/);
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistRemove", name: "NOTCH" } });
    expect(json(paper, "/whitelist.json")).toEqual([]);
    expect(cmds(paper).filter((c) => c.includes("notch"))).toEqual([]);
  });

  it("offline-mode: afgeleide UUID; op met op-permission-level, ban + pardon, ban-ip alleen met IP", async () => {
    files(paper).set("/server.properties", "online-mode=false\nop-permission-level=2\n");
    await alice.api.players.manage({ uuid: paper, op: { action: "op", name: "Steve" } });
    expect(json(paper, "/ops.json")).toEqual([{ uuid: offlineUuid("Steve"), name: "Steve", level: 2, bypassesPlayerLimit: false }]);
    await alice.api.players.manage({ uuid: paper, op: { action: "ban", name: "Griefer", reason: "TNT" } });
    expect(json(paper, "/banned-players.json")[0]).toMatchObject({ uuid: offlineUuid("Griefer"), name: "Griefer", reason: "TNT", expires: "forever", source: "Panel" });
    const info = await alice.api.players.info({ uuid: paper });
    expect(info.onlineMode).toBe(false);
    expect(info.bans[0]).toMatchObject({ name: "Griefer", reason: "TNT" });
    await alice.api.players.manage({ uuid: paper, op: { action: "pardon", name: "griefer" } });
    expect(json(paper, "/banned-players.json")).toEqual([]);
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "banIp", target: "Steve" } })).rejects.toThrow(/IP_REQUIRED/);
    await alice.api.players.manage({ uuid: paper, op: { action: "banIp", target: "2001:db8::1", reason: "bots" } });
    expect(json(paper, "/banned-ips.json")[0]).toMatchObject({ ip: "2001:db8::1", reason: "bots" });
    await alice.api.players.manage({ uuid: paper, op: { action: "pardonIp", ip: "2001:db8::1" } });
    expect(json(paper, "/banned-ips.json")).toEqual([]);
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "kick", name: "Steve" } })).rejects.toThrow(/SERVER_NOT_RUNNING/);
  });

  it("achter Velocity (forwarding): echte UUID's ondanks online-mode=false", async () => {
    files(paper).set("/server.properties", "online-mode=false\n");
    await alice.api.servers.updateVariables({ uuid: paper, variables: { VELOCITY_FORWARDING: "true" } }).catch(async () => {
      const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, paper));
      await getDb().insert(schema.serverVariables).values({ serverId: srv!.id, key: "VELOCITY_FORWARDING", value: "true" }).onConflictDoNothing();
    });
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: "Notch" } });
    expect(json(paper, "/whitelist.json")[0]!.uuid).toBe(NOTCH);
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, paper));
    await getDb().delete(schema.serverVariables).where(eq(schema.serverVariables.serverId, srv!.id));
  });

  it("usercache.json gaat voor (ook Bedrock-spelers); onbekende Bedrock-speler geeft een duidelijke fout", async () => {
    fs(paper).dirs.add("/plugins");
    files(paper).set("/plugins/floodgate-spigot.jar", "jar");
    files(paper).set("/usercache.json", JSON.stringify([{ name: ".Pocket", uuid: "00000000-0000-0000-0009-01f2a3b4c5d6", expiresOn: "2027-01-01 00:00:00 +0000" }]));
    await alice.api.players.manage({ uuid: paper, op: { action: "whitelistAdd", name: ".pocket" } });
    expect(json(paper, "/whitelist.json")).toEqual([{ uuid: "00000000-0000-0000-0009-01f2a3b4c5d6", name: ".Pocket" }]);
    await expect(alice.api.players.manage({ uuid: paper, op: { action: "op", name: ".Nieuw" } })).rejects.toThrow(/BEDROCK_PLAYER_UNKNOWN/);
  });

  it("kapotte bestanden: lege lijsten, geen crash", async () => {
    files(paper).set("/ops.json", "{kapot");
    files(paper).set("/whitelist.json", JSON.stringify([{ name: "Steve", uuid: "niet-een-uuid" }, "rommel"]));
    const info = await alice.api.players.info({ uuid: paper });
    expect(info.ops).toEqual([]);
    expect(info.whitelist).toEqual([{ name: "Steve", uuid: null }]);
  });
});

describe("players.online", () => {
  it("gestopt: niets; ping-sample compleet: geen consolecommando", async () => {
    expect(await alice.api.players.online({ uuid: paper })).toMatchObject({ running: false, players: [], source: "none" });
    setState(paper, "online");
    h.daemon.commands.delete(paper);
    h.daemon.players = { online: 1, max: 20, version: "Paper", sample: [{ name: "Notch", id: NOTCH }] };
    expect(await alice.api.players.online({ uuid: paper })).toEqual({ running: true, online: 1, max: 20, players: [{ name: "Notch", uuid: NOTCH, server: null }], complete: true, source: "ping" });
    expect(cmds(paper)).toEqual([]);
  });

  it("sample onvolledig (anoniem of >12): `list uuids` op de console", async () => {
    setState(paper, "online");
    h.daemon.players = { online: 2, max: 20, version: "Paper", sample: [{ name: "Anonymous Player", id: "00000000-0000-0000-0000-000000000000" }] };
    h.daemon.consoleLines.set(paper, ["[12:00:00 INFO]: There are 2 of a max of 20 players online: Oud (11111111-1111-1111-1111-111111111111)"]);
    h.daemon.onCommand = (_u, c) => (c === "list uuids" ? [`[12:00:01 INFO]: There are 2 of a max of 20 players online: Notch (${NOTCH}), Alex (ec561538-f3fd-461d-aff5-086b22154bce)`] : []);
    const r = await alice.api.players.online({ uuid: paper });
    expect(r).toMatchObject({ online: 2, complete: true, source: "console" });
    expect(r.players.map((p) => p.name)).toEqual(["Notch", "Alex"]);
  });

  it("console geeft niets: wat de ping weet, onvolledig", async () => {
    setState(paper, "online");
    h.daemon.players = { online: 3, max: 20, version: "Paper", sample: [{ name: "Notch", id: NOTCH }] };
    h.daemon.onCommand = () => [];
    expect(await alice.api.players.online({ uuid: paper })).toMatchObject({ online: 3, complete: false, source: "ping", players: [{ name: "Notch" }] });
  });

  it("Velocity: glist all met backend per speler; beheer niet ondersteund", async () => {
    setState(proxy, "online");
    h.daemon.players = { online: 2, max: 500, version: "Velocity", sample: [] };
    h.daemon.onCommand = (_u, c) => (c === "glist all" ? ["[12:00:00 INFO]: [lobby] (1): Steve", "[12:00:00 INFO]: [survival] (1): Alex", "[12:00:00 INFO]: There are 2 players currently connected to the proxy."] : []);
    const r = await alice.api.players.online({ uuid: proxy });
    expect(r.players).toEqual([{ name: "Steve", uuid: null, server: "lobby" }, { name: "Alex", uuid: null, server: "survival" }]);
    expect(await alice.api.players.info({ uuid: proxy })).toMatchObject({ supported: true, platform: "proxy" });
    await expect(alice.api.players.manage({ uuid: proxy, op: { action: "op", name: "Steve" } })).rejects.toThrow(/NOT_SUPPORTED/);
    setState(proxy, "offline");
  });

  it("generiek Java zonder server.properties: niet ondersteund", async () => {
    setState(generic, "offline");
    expect((await alice.api.players.info({ uuid: generic })).supported).toBe(false);
    files(generic).set("/server.properties", "online-mode=true\n");
    expect((await alice.api.players.info({ uuid: generic })).supported).toBe(true);
  });
});
