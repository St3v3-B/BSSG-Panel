import { parseTemplate, type DaemonServerSpec } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { isSuspended, suspensionOf } from "./routers/admin";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";
import { upsertTemplate } from "./templates";

const h = useHarness();
let admin: TestUser, player: TestUser, other: TestUser;
let gameId = 0, game2Id = 0, webId = 0;
let uuid = "", serverId = 0;
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };

const GAME2 = GAME_TEMPLATE.replace("slug: testgame", "slug: testgame2")
  .replace("name: Testspel", "name: Testspel 2")
  .replace("image: example/game:1", "image: example/game:2")
  .replace("key: SECRET_FLAG", "key: NEW_VAR")
  .replace("default: \"off\"", "default: \"nieuw\"");

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "230000000000000001", name: "speler" });
  other = await h.user({ discordId: "230000000000000002", name: "ander" });
  const r = parseTemplate(GAME2);
  if (!r.ok) throw new Error(r.errors.join(";"));
  await upsertTemplate(r.spec, GAME2);
  gameId = await h.templateId("testgame");
  game2Id = await h.templateId("testgame2");
  webId = await h.templateId("testweb");
  const a = await h.allocation(33000);
  const d = await admin.api.admin.servers.create({ name: "Beheer", ownerId: player.id, nodeId: h.localNodeId, templateId: gameId, limits, allocationIds: [a], variables: { SECRET_FLAG: "on", JAR_FILE: "mijn.jar" }, startOnInstall: false });
  uuid = d.uuid;
  const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  serverId = s!.id;
});

describe("admin.servers.setSuspended", () => {
  it("opschorten stopt via de daemon, zet de kolommen en logt", async () => {
    expect(await isSuspended(serverId)).toBe(false);
    await admin.api.admin.servers.setSuspended({ uuid, suspended: true, reason: "Misbruik" });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/power`)?.body).toMatchObject({ action: "stop" });
    expect(await isSuspended(serverId)).toBe(true);
    expect(await suspensionOf(uuid)).toMatchObject({ reason: "Misbruik" });
    const list = await admin.api.admin.servers.list({ suspended: true });
    expect(list.items.map((s) => s.uuid)).toEqual([uuid]);
    expect(list.items[0]!.suspended).toMatchObject({ reason: "Misbruik" });
    expect((await admin.api.admin.servers.list({ suspended: false })).items.map((s) => s.uuid)).not.toContain(uuid);
    const log = await admin.api.admin.activity.search({ action: "admin.server.suspend" });
    expect(log.items[0]!.serverUuid).toBe(uuid);
  });

  it("daemonfout: niet opgeschort; vrijgeven werkt", async () => {
    await admin.api.admin.servers.setSuspended({ uuid, suspended: false });
    expect(await isSuspended(serverId)).toBe(false);
    h.daemon.mode = "error500";
    await expect(admin.api.admin.servers.setSuspended({ uuid, suspended: true, reason: null })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect(await isSuspended(serverId)).toBe(false);
  });

  it("alleen admins", async () => {
    await expect(player.api.admin.servers.setSuspended({ uuid, suspended: true, reason: null })).rejects.toThrow(/NOT_ADMIN/);
  });
});

describe("admin.servers.list filters", () => {
  it("op eigenaar, node, type en status", async () => {
    const ids = async (f: object) => (await admin.api.admin.servers.list(f)).items.map((s) => s.uuid);
    expect(await ids({ ownerId: player.id })).toContain(uuid);
    expect(await ids({ ownerId: other.id })).toEqual([]);
    expect(await ids({ nodeId: h.localNodeId })).toContain(uuid);
    expect(await ids({ nodeId: 9999 })).toEqual([]);
    expect(await ids({ type: "web" })).toEqual([]);
    expect(await ids({ type: "game", status: "installing" })).toContain(uuid);
    expect(await ids({ status: "online" })).toEqual([]);
  });
});

describe("admin.servers.changeTemplate", () => {
  it("weigert ander type en dezelfde template", async () => {
    await expect(admin.api.admin.servers.changeTemplate({ uuid, templateId: webId, reinstall: false })).rejects.toThrow(/TEMPLATE_TYPE_MISMATCH/);
    await expect(admin.api.admin.servers.changeTemplate({ uuid, templateId: gameId, reinstall: false })).rejects.toThrow(/SAME_TEMPLATE/);
    await expect(admin.api.admin.servers.changeTemplate({ uuid, templateId: 9999, reinstall: false })).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
  });

  it("behoudt variabelen met dezelfde key, nieuwe krijgen de default, PUT naar de daemon", async () => {
    await admin.api.admin.servers.changeTemplate({ uuid, templateId: game2Id, reinstall: false });
    const put = h.daemon.last("PUT", `/api/servers/${uuid}`)!.body as DaemonServerSpec;
    expect(put).toMatchObject({ image: "example/game:2", skip_install: true });
    expect(put.environment).toEqual({ JAR_FILE: "mijn.jar", NEW_VAR: "nieuw" });
    const vars = await getDb().select().from(schema.serverVariables).where(eq(schema.serverVariables.serverId, serverId));
    expect(Object.fromEntries(vars.map((v) => [v.key, v.value]))).toEqual({ JAR_FILE: "mijn.jar" });
    const d = await player.api.servers.get({ uuid });
    expect(d.templateName).toBe("Testspel 2");
    const log = await admin.api.admin.activity.search({ action: "admin.server.template" });
    expect(log.items).toHaveLength(1);
  });

  it("reinstall draait het install-script en zet status installing; daemonfout laat alles staan", async () => {
    h.daemon.mode = "error500";
    await expect(admin.api.admin.servers.changeTemplate({ uuid, templateId: gameId, reinstall: true })).rejects.toThrow();
    h.daemon.mode = "ok";
    expect((await player.api.servers.get({ uuid })).templateName).toBe("Testspel 2");
    await getDb().update(schema.servers).set({ status: "offline" }).where(eq(schema.servers.id, serverId));
    await admin.api.admin.servers.changeTemplate({ uuid, templateId: gameId, reinstall: true });
    expect(h.daemon.last("POST", `/api/servers/${uuid}/install`)).toBeTruthy();
    const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.id, serverId));
    expect(s).toMatchObject({ templateId: gameId, status: "installing" });
  });
});

describe("admin.settings.update", () => {
  it("werkt gedeeltelijk bij, valideert en logt", async () => {
    const s = await admin.api.admin.settings.update({ panelName: " Mijn Panel ", accentColor: "#AA00ff" });
    expect(s).toMatchObject({ panelName: "Mijn Panel", accentColor: "#aa00ff", logoUrl: null, defaultLimits: { ramMb: 2048 } });
    expect((await admin.api.admin.settings.update({ logoUrl: "https://panel.test/logo.png" })).logoUrl).toBe("https://panel.test/logo.png");
    expect((await admin.api.admin.settings.update({ logoUrl: null })).logoUrl).toBeNull();
    const l = { cpuPct: 50, ramMb: 1024, swapMb: 0, diskMb: 2048 };
    expect((await admin.api.admin.settings.update({ defaultLimits: l })).defaultLimits).toEqual(l);
    await expect(admin.api.admin.settings.update({ logoUrl: "javascript:alert(1)" })).rejects.toThrow(/INVALID_LOGO_URL/);
    await expect(admin.api.admin.settings.update({ accentColor: "rood" })).rejects.toThrow();
    await expect(admin.api.admin.settings.update({ panelName: "  " })).rejects.toThrow(/INVALID_PANEL_NAME/);
    await expect(player.api.admin.settings.update({ panelName: "x" })).rejects.toThrow(/NOT_ADMIN/);
    expect(await (await h.anon()).auth.branding()).toMatchObject({ panelName: "Mijn Panel", accentColor: "#aa00ff" });
  });
});
