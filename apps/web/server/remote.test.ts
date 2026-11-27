import { createPublicKey } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { GET as jwtKey } from "@/app/api/remote/jwt-key/route";
import { POST as hello } from "@/app/api/remote/node/hello/route";
import { POST as install } from "@/app/api/remote/servers/[uuid]/install/route";
import { POST as status } from "@/app/api/remote/servers/[uuid]/status/route";
import { getDb, schema } from "./db";
import { verifyJwt } from "./lib/jwt";
import { pollAllNow } from "./node-cache";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser;
let uuid = "";

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  player = await h.user({ discordId: "250000000000000001", name: "speler" });
  const d = await admin.api.admin.servers.create({
    name: "R",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(25570)],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
});

const req = (path: string, body?: unknown, token: string | null = h.env.NODE_TOKEN!) =>
  new Request(`http://panel.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const serverRow = async () => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!;

describe("remote-API", () => {
  it("weigert zonder of met verkeerd node-token (401)", async () => {
    expect((await jwtKey(req("/api/remote/jwt-key", undefined, null), params({}))).status).toBe(401);
    const r = await jwtKey(req("/api/remote/jwt-key", undefined, "fout"), params({}));
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ error: "unauthorized" });
  });

  it("jwt-key: JWKS waarmee een consoleToken te controleren is", async () => {
    const r = await jwtKey(req("/api/remote/jwt-key"), params({}));
    expect(r.status).toBe(200);
    const { keys } = (await r.json()) as { keys: Array<Record<string, string>> };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    const pub = createPublicKey({ key: keys[0]! as never, format: "jwk" });
    const t = await player.api.servers.consoleToken({ uuid });
    const v = verifyJwt(t.token, pub);
    expect(v?.header.kid).toBe(keys[0]!.kid);
  });

  it("node/hello werkt disk_quota_mode en versie bij", async () => {
    expect((await hello(req("/api/remote/node/hello", { version: "1.2.3", disk_quota_mode: "xfs" }), params({}))).status).toBe(204);
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, h.localNodeId));
    expect(n).toMatchObject({ daemonVersion: "1.2.3", diskQuotaMode: "xfs" });
    expect(n!.lastSeenAt).not.toBeNull();
    expect((await hello(req("/api/remote/node/hello", { version: "1" }), params({}))).status).toBe(400);
  });

  it("node/hello met has_mariadb registreert een daemon-beheerde database-host (idempotent, zet `local` om)", async () => {
    const hosts = () => getDb().select().from(schema.databaseHosts).where(eq(schema.databaseHosts.nodeId, h.localNodeId));
    await getDb().insert(schema.databaseHosts).values({ name: "local", host: "panel-mariadb", port: 3306, adminUser: "root", adminPasswordEnc: "x", nodeId: h.localNodeId });
    await hello(req("/api/remote/node/hello", { version: "1", disk_quota_mode: "soft", has_mariadb: false }), params({}));
    expect((await hosts()).map((x) => x.daemonManaged)).toEqual([false]);
    for (let i = 0; i < 2; i++) expect((await hello(req("/api/remote/node/hello", { version: "1", disk_quota_mode: "soft", has_mariadb: true }), params({}))).status).toBe(204);
    const rows = await hosts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "local", host: "panel-mariadb", port: 3306, daemonManaged: true, nodeId: h.localNodeId });
  });

  it("servers/{uuid}/install: gelukt → installed_at + offline; mislukt → install_failed; gelogd", async () => {
    expect((await install(req(`/api/remote/servers/${uuid}/install`, { successful: false, error: "boem" }), params({ uuid }))).status).toBe(204);
    expect((await serverRow()).status).toBe("install_failed");
    expect((await install(req(`/api/remote/servers/${uuid}/install`, { successful: true, error: null }), params({ uuid }))).status).toBe(204);
    const s = await serverRow();
    expect(s.status).toBe("offline");
    expect(s.installedAt).not.toBeNull();
    const log = (await admin.api.admin.activity.search({ serverUuid: uuid })).items.map((i) => i.action);
    expect(log).toEqual(expect.arrayContaining(["server.install.failed", "server.install.completed"]));
  });

  it("servers/{uuid}/status werkt de status bij; onbekende server 404; foute body 400", async () => {
    expect((await status(req(`/api/remote/servers/${uuid}/status`, { state: "online" }), params({ uuid }))).status).toBe(204);
    expect((await serverRow()).status).toBe("online");
    // De lijst leest de cache van de node-monitor: eerst een poll, dan wint wat de daemon meldt.
    h.daemon.servers.get(uuid)!.state = "offline";
    await pollAllNow();
    expect((await player.api.servers.list())[0]!.status).toBe("offline");
    // Een push werkt de cache direct bij, zonder te wachten op de volgende poll.
    await status(req(`/api/remote/servers/${uuid}/status`, { state: "starting" }), params({ uuid }));
    expect((await player.api.servers.list())[0]!.status).toBe("starting");
    await status(req(`/api/remote/servers/${uuid}/status`, { state: "online" }), params({ uuid }));
    const other = "00000000-0000-4000-8000-000000000000";
    expect((await status(req(`/api/remote/servers/${other}/status`, { state: "online" }), params({ uuid: other }))).status).toBe(404);
    expect((await status(req(`/api/remote/servers/${uuid}/status`, { state: "kapot" }), params({ uuid }))).status).toBe(400);
    expect((await status(req(`/api/remote/servers/niet-een-uuid/status`, { state: "online" }), params({ uuid: "niet-een-uuid" }))).status).toBe(404);
  });

  it("een andere node mag servers van deze node niet bijwerken", async () => {
    await getDb().insert(schema.nodes).values({ name: "andere", fqdn: "node9.test", tokenHash: (await import("./lib/crypto")).sha256("ander-token") });
    expect((await status(req(`/api/remote/servers/${uuid}/status`, { state: "offline" }, "ander-token"), params({ uuid }))).status).toBe(404);
    expect((await serverRow()).status).toBe("online");
  });
});
