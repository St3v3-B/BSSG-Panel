/** Toegang voor ontwikkelaars: API-sleutels (scopes, per server, rate limit), REST /api/v1 en de terminal-token. */
import { buildRouter, createCallerFactory } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as sftpAuthRoute } from "@/app/api/remote/sftp/auth/route";
import { API_KEY_REQUESTS_PER_MINUTE } from "./apikey";
import { createContext } from "./context";
import { getDb, schema } from "./db";
import { implementation } from "./index";
import { getSigningKey, verifyJwt } from "./lib/jwt";
import { getLimiter, resetLimiter } from "./lib/ratelimit";
import { handleRest, restContext } from "./rest/handler";
import { REST_ROUTES } from "./rest/routes";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
const router = buildRouter(implementation);
const caller = createCallerFactory(router);
let admin: TestUser, player: TestUser, helper: TestUser;
let uuid = "", other = "";

const withKey = async (key: string) => caller(await createContext(new Request("http://panel.test/api/trpc", { headers: { authorization: `Bearer ${key}` } }), new Headers()));
const rest = (path: string, init: RequestInit & { key?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  return handleRest(new Request(`http://panel.test/api/v1${path}`, { ...init, headers }), { router, context: restContext, baseUrl: "https://panel.test" });
};
const sftp = (username: string, password: string) =>
  sftpAuthRoute(
    new Request("http://panel.test/api/remote/sftp/auth", {
      method: "POST",
      headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ username, password, ip: "10.0.0.9" }),
    }),
    { params: Promise.resolve({}) },
  );

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000001", name: "speler" });
  helper = await h.user({ discordId: "290000000000000002", name: "helper" });
  const mk = async (name: string, port: number) =>
    (
      await admin.api.admin.servers.create({
        name, ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"),
        limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 }, allocationIds: [await h.allocation(port)], variables: {}, startOnInstall: false,
      })
    ).uuid;
  uuid = await mk("Een", 25610);
  other = await mk("Twee", 25611);
  for (const u of [uuid, other]) h.daemon.servers.get(u)!.state = "offline";
  h.daemon.fs(uuid).files.set("/a.txt", "hallo");
  h.daemon.fs(other).files.set("/b.txt", "ander");
});

beforeEach(async () => {
  await resetLimiter();
});

describe("API-sleutels: scopes en beperking per server", () => {
  it("sleutel beperkt tot één server ziet de andere niet (tRPC, REST en SFTP)", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "deploy", permissions: ["files.read"], expiresAt: null, serverUuids: [uuid] });
    expect(apiKey.serverUuids).toEqual([uuid]);
    expect((await player.api.account.apiKeys()).find((k) => k.id === apiKey.id)!.serverUuids).toEqual([uuid]);
    const api = await withKey(key);
    expect((await api.servers.list()).map((s) => s.uuid)).toEqual([uuid]);
    expect((await api.files.read({ uuid, path: "/a.txt" })).content).toBe("hallo");
    await expect(api.servers.get({ uuid: other })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.files.read({ uuid: other, path: "/b.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(Object.keys(await api.servers.statsSparklines({ uuids: [uuid, other] }))).toEqual([]); // geen console.read in de scopes
    expect((await rest(`/servers/${other}`, { key })).status).toBe(403);
    // SFTP met de sleutel: alleen op de toegestane server
    expect((await sftp(`speler.${uuid.slice(0, 8)}`, key)).status).toBe(200);
    expect((await sftp(`speler.${other.slice(0, 8)}`, key)).status).toBe(403);
  });

  it("alleen-lezen-sleutel: lezen mag, schrijven/power niet", async () => {
    const { key } = await player.api.account.createApiKey({ name: "lezer", permissions: ["files.read", "console.read"], expiresAt: null });
    const api = await withKey(key);
    expect((await api.servers.list()).length).toBe(2);
    await expect(api.files.write({ uuid, path: "/x.txt", content: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.servers.power({ uuid, action: "start" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.servers.terminalToken({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("server buiten bereik bij aanmaken → FORBIDDEN; subuser-sleutel alleen met de rechten van de subuser", async () => {
    await expect(helper.api.account.createApiKey({ name: "x", permissions: [], expiresAt: null, serverUuids: [uuid] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await player.api.subusers.invite({ uuid, who: helper.discordId, permissions: ["files.read"] });
    const { key } = await helper.api.account.createApiKey({ name: "helper", permissions: ["files.read", "files.write", "power"], expiresAt: null, serverUuids: [uuid] });
    const api = await withKey(key);
    expect((await api.servers.get({ uuid })).permissions).toEqual(["files.read"]);
    await expect(api.files.write({ uuid, path: "/y.txt", content: "y" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await player.api.subusers.remove({ uuid, userId: helper.id });
  });

  it("nooit admin-procedures, ook niet voor de eigenaar-admin", async () => {
    const { key } = await admin.api.account.createApiKey({ name: "admin", permissions: ["files.read"], expiresAt: null });
    const api = await withKey(key);
    await expect(api.admin.servers.list({ limit: 10 })).rejects.toMatchObject({ code: "FORBIDDEN", message: "NOT_ADMIN" });
    await expect(api.admin.settings.update({ terminalEnabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.servers.list({ all: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rest("/servers", { key }).then((r) => r.json())) as unknown[]).toEqual([]);
  });

  it("rate limit per sleutel: TOO_MANY_REQUESTS (tRPC) en 429 met Retry-After (REST)", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "druk", permissions: [], expiresAt: null });
    for (let i = 0; i < API_KEY_REQUESTS_PER_MINUTE; i++) await getLimiter().hit(`apikey:${apiKey.id}`, 60);
    await expect(withKey(key)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
    const r = await rest("/servers", { key });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    // een andere sleutel van dezelfde gebruiker heeft een eigen teller
    const b = await player.api.account.createApiKey({ name: "rustig", permissions: [], expiresAt: null });
    expect((await rest("/servers", { key: b.key })).status).toBe(200);
  });

  it("activiteitenlog noemt de sleutel bij naam", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "ci-bot", permissions: ["files.read", "files.write"], expiresAt: null });
    expect((await rest(`/servers/${uuid}/files/contents?path=/ci.txt`, { key, method: "PUT", body: "gebouwd", headers: { "content-type": "text/plain" } })).status).toBe(200);
    const logs = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.file.write"));
    expect(logs.at(-1)!.metadata).toMatchObject({ path: "/ci.txt", method: "api_key", apiKeyId: apiKey.id, apiKeyName: "ci-bot" });
    expect(h.daemon.fs(uuid).files.get("/ci.txt")).toBe("gebouwd");
  });
});

describe("REST /api/v1", () => {
  let key = "";
  beforeAll(async () => {
    key = (await player.api.account.createApiKey({ name: "rest", permissions: ["console.read", "console.write", "power", "files.read", "files.write", "backup.create", "backup.restore", "database.manage"], expiresAt: null })).key;
  });

  it("zonder (geldige) sleutel 401; een sessiecookie telt niet", async () => {
    expect((await rest("/servers")).status).toBe(401);
    const r = await rest("/servers", { headers: { cookie: player.cookie } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await rest("/servers", { key: `${key.slice(0, 8)}${"x".repeat(35)}` })).status).toBe(401);
  });

  it("servers, detail, power, commando, bestanden", async () => {
    const list = (await (await rest("/servers", { key })).json()) as Array<{ uuid: string }>;
    expect(list.map((s) => s.uuid).sort()).toEqual([uuid, other].sort());
    const d = (await (await rest(`/servers/${uuid}`, { key })).json()) as { uuid: string; permissions: string[]; createdAt: string };
    expect(d.uuid).toBe(uuid);
    expect(d.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d.permissions).toContain("power");

    const p = await rest(`/servers/${uuid}/power`, { key, method: "POST", body: JSON.stringify({ action: "start" }) });
    expect(p.status).toBe(202);
    expect(await p.json()).toEqual({ ok: true });
    const bad = await rest(`/servers/${uuid}/power`, { key, method: "POST", body: JSON.stringify({ action: "explode" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string; message: string }).message).toMatch(/action/);
    expect((await rest(`/servers/${uuid}/command`, { key, method: "POST", body: JSON.stringify({ command: "say hoi" }) })).status).toBe(200);
    expect((await rest(`/servers/${uuid}/command`, { key, method: "POST", body: "{kapot" })).status).toBe(400);

    const files = (await (await rest(`/servers/${uuid}/files?path=/`, { key })).json()) as Array<{ name: string }>;
    expect(files.map((f) => f.name)).toContain("a.txt");
    expect(await (await rest(`/servers/${uuid}/files/contents?path=/a.txt`, { key })).json()).toMatchObject({ content: "hallo" });
    expect((await rest(`/servers/${uuid}/files/contents?path=/n.txt`, { key, method: "PUT", body: "nieuw" })).status).toBe(200);
    expect(h.daemon.fs(uuid).files.get("/n.txt")).toBe("nieuw");
    expect((await rest(`/servers/${uuid}/files/delete`, { key, method: "POST", body: JSON.stringify({ paths: ["/n.txt"] }) })).status).toBe(200);
    expect(h.daemon.fs(uuid).files.has("/n.txt")).toBe(false);
    expect((await rest(`/servers/${uuid}/backups`, { key })).status).toBe(200);
    expect((await rest(`/servers/${uuid}/databases`, { key })).status).toBe(200);
  });

  it("backup terugzetten alleen via de server waar hij bij hoort", async () => {
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, other));
    const [b] = await getDb().insert(schema.backups).values({ serverId: srv!.id, name: "x", status: "completed", s3Key: "x.tar.zst" }).returning();
    const r = await rest(`/servers/${uuid}/backups/${b!.id}/restore`, { key, method: "POST" });
    expect(r.status).toBe(404);
  });

  it("onbekend pad 404, verkeerde methode 405, ongeldige uuid 404", async () => {
    expect((await rest("/nope", { key })).status).toBe(404);
    expect((await rest(`/servers/${uuid}`, { key, method: "DELETE" })).status).toBe(405);
    expect((await rest("/servers/niet-een-uuid", { key })).status).toBe(404);
  });

  it("openapi.json: 3.1, zonder sleutel, elke route met operationId en schema's", async () => {
    const r = await rest("/openapi.json");
    expect(r.status).toBe(200);
    const doc = (await r.json()) as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]!.url).toBe("https://panel.test/api/v1");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops.map((o) => o.operationId).sort()).toEqual(REST_ROUTES.map((r) => r.operationId).sort());
    const list = doc.paths["/servers"]!.get!.responses["200"] as { content: { "application/json": { schema: { type: string } } } };
    expect(list.content["application/json"].schema.type).toBe("array");
    const one = doc.paths["/servers/{uuid}"]!.get!.responses["200"] as { content: { "application/json": { schema: { properties: Record<string, { format?: string }> } } } };
    expect(one.content["application/json"].schema.properties.createdAt!.format).toBe("date-time");
  });
});

describe("terminal: token, recht en admin-schakelaars", () => {
  it("eigenaar krijgt een eenmalig terminal-token (purpose, alleen recht terminal); log één keer, niet bij refresh", async () => {
    const t = await player.api.servers.terminalToken({ uuid });
    expect(t.socketUrl).toBe(`wss://node1.test/api/servers/${uuid}/terminal`);
    const v = verifyJwt(t.token, (await getSigningKey()).publicKey)!;
    expect(v.claims).toMatchObject({ purpose: "terminal", permissions: ["terminal"], server_uuid: uuid, aud: "node1.test", sub: String(player.id) });
    expect(v.claims.jti).toBeTruthy();
    await player.api.servers.terminalToken({ uuid, refresh: true });
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
    const logs = await getDb().select().from(schema.activityLog).where(and(eq(schema.activityLog.action, "server.terminal.open"), eq(schema.activityLog.serverId, srv!.id)));
    expect(logs.length).toBe(1);
    // het console-token blijft zonder purpose (de daemon weigert dat op /terminal)
    const c = await player.api.servers.consoleToken({ uuid });
    expect(verifyJwt(c.token, (await getSigningKey()).publicKey)!.claims.purpose).toBeUndefined();
  });

  it("subuser zonder terminal of zonder files.write → FORBIDDEN; met beide wel", async () => {
    await player.api.subusers.invite({ uuid, who: helper.discordId, permissions: ["files.read", "files.write"] });
    await expect(helper.api.servers.terminalToken({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN", message: "MISSING_PERMISSION: terminal" });
    await player.api.subusers.update({ uuid, userId: helper.id, permissions: ["terminal"] });
    await expect(helper.api.servers.terminalToken({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN", message: "MISSING_PERMISSION: files.write" });
    await player.api.subusers.update({ uuid, userId: helper.id, permissions: ["terminal", "files.read", "files.write"] });
    expect((await helper.api.servers.terminalToken({ uuid })).token).toBeTruthy();
    await player.api.subusers.remove({ uuid, userId: helper.id });
  });

  it("admin zet hem per server en globaal uit: TERMINAL_DISABLED, servers.get en SFTP-rechten volgen", async () => {
    await player.api.account.setSftpPassword({ uuid, password: "terminal-wachtwoord-1" });
    const perms = async () => ((await (await sftp(`speler.${uuid.slice(0, 8)}`, "terminal-wachtwoord-1")).json()) as { permissions: string[] }).permissions;
    expect(await perms()).toContain("terminal");
    expect((await player.api.servers.get({ uuid })).terminal).toEqual({ enabled: true, serverAllowed: true, globalEnabled: true });

    await admin.api.admin.servers.setTerminalAllowed({ uuid, allowed: false });
    await expect(player.api.servers.terminalToken({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN", message: "TERMINAL_DISABLED" });
    expect((await player.api.servers.get({ uuid })).terminal).toEqual({ enabled: false, serverAllowed: false, globalEnabled: true });
    expect(await perms()).not.toContain("terminal");
    await expect(player.api.admin.servers.setTerminalAllowed({ uuid, allowed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.api.admin.servers.setTerminalAllowed({ uuid, allowed: true });

    expect((await admin.api.admin.settings.get()).terminalEnabled).toBe(true);
    expect((await admin.api.admin.settings.update({ terminalEnabled: false })).terminalEnabled).toBe(false);
    await expect(player.api.servers.terminalToken({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN", message: "TERMINAL_DISABLED" });
    expect((await player.api.servers.get({ uuid })).terminal.enabled).toBe(false);
    expect(await perms()).not.toContain("terminal");
    await admin.api.admin.settings.update({ terminalEnabled: true });
    expect((await player.api.servers.terminalToken({ uuid })).token).toBeTruthy();
  });

  it("opgeschort → SUSPENDED", async () => {
    await admin.api.admin.servers.setSuspended({ uuid: other, suspended: true, reason: null });
    await expect(player.api.servers.terminalToken({ uuid: other })).rejects.toMatchObject({ code: "FORBIDDEN", message: "SUSPENDED" });
    expect((await player.api.servers.get({ uuid: other })).terminal.enabled).toBe(false);
    await admin.api.admin.servers.setSuspended({ uuid: other, suspended: false, reason: null });
  });
});
