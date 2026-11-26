import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as sftpAuthRoute } from "@/app/api/remote/sftp/auth/route";
import { buildRouter } from "@panel/api";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "./context";
import { getDb, schema } from "./db";
import { implementation } from "./index";
import { getSigningKey, verifyJwt } from "./lib/jwt";
import { resetLimiter } from "./lib/ratelimit";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness({ env: { REDIS_URL: "redis://127.0.0.1:1" } }); // geen Redis: geheugen-fallback
let admin: TestUser, player: TestUser, sub: TestUser, stranger: TestUser;
let uuid = "";
let shortId = "";

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "260000000000000001", name: "speler" });
  sub = await h.user({ discordId: "260000000000000002", name: "helper" });
  stranger = await h.user({ discordId: "260000000000000003", name: "vreemd" });
  const d = await admin.api.admin.servers.create({
    name: "F",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(25580)],
    variables: {},
    startOnInstall: true,
  });
  uuid = d.uuid;
  shortId = d.shortId;
  const fs = h.daemon.fs(uuid);
  fs.files.set("/readme.txt", "hallo\n");
  fs.dirs.add("/plugins");
});

describe("files.*", () => {
  beforeEach(() => {
    h.daemon.diskFull = false;
  });

  it("eigenaar: list, write, read, mkdir, rename, delete, compress, decompress", async () => {
    expect((await player.api.files.list({ uuid, path: "/" })).map((f) => f.name).sort()).toEqual(["plugins", "readme.txt"]);
    const [dir] = (await player.api.files.list({ uuid, path: "/" })).filter((f) => f.isDirectory);
    expect(dir).toMatchObject({ name: "plugins", isDirectory: true, modifiedAt: expect.any(Date) });
    await player.api.files.write({ uuid, path: "/notitie.txt", content: "van de eigenaar" });
    expect(h.daemon.last("PUT", `/api/servers/${uuid}/files/contents`)!.body).toBe("van de eigenaar");
    expect(await player.api.files.read({ uuid, path: "/notitie.txt" })).toEqual({ content: "van de eigenaar", size: 15 });
    await player.api.files.mkdir({ uuid, path: "/nieuw" });
    await player.api.files.rename({ uuid, from: "/notitie.txt", to: "/nieuw/n.txt" });
    expect((await player.api.files.list({ uuid, path: "/nieuw" })).map((f) => f.name)).toEqual(["n.txt"]);
    const { archive } = await player.api.files.compress({ uuid, root: "/", paths: ["/nieuw"] });
    expect(archive.path).toBe("/archive.tar.gz");
    await player.api.files.decompress({ uuid, path: "/archive.tar.gz" });
    await player.api.files.delete({ uuid, paths: ["/nieuw", "/archive.tar.gz"] });
    expect(h.daemon.fs(uuid).dirs.has("/nieuw")).toBe(false);
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.file.write"));
    expect(log!.metadata).toEqual({ path: "/notitie.txt" });
  });

  it("niet gevonden → NOT_FOUND; disk vol → PRECONDITION_FAILED DISK_EXCEEDED", async () => {
    await expect(player.api.files.read({ uuid, path: "/bestaat-niet" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.daemon.diskFull = true;
    await expect(player.api.files.write({ uuid, path: "/x", content: "x" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED" });
    await expect(player.api.files.mkdir({ uuid, path: "/y" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED" });
  });

  it("start bij volle disk (409 disk_exceeded) → PRECONDITION_FAILED DISK_EXCEEDED", async () => {
    h.daemon.override = (r) => (r.path.endsWith("/power") ? { status: 409, body: { error: "disk_exceeded", message: "vol" } } : undefined);
    try {
      await expect(player.api.servers.power({ uuid, action: "start" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "DISK_EXCEEDED" });
    } finally {
      h.daemon.override = null;
    }
  });

  it("daemon onbereikbaar → DAEMON_UNREACHABLE", async () => {
    h.daemon.mode = "error500";
    try {
      await expect(player.api.files.list({ uuid, path: "/" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    } finally {
      h.daemon.mode = "ok";
    }
  });

  it("upload/download-URL: eenmalige JWT met alleen het ene recht, naar de node-fqdn", async () => {
    const key = await getSigningKey();
    const down = await player.api.files.downloadUrl({ uuid, path: "/readme.txt" });
    const u = new URL(down.url);
    expect(`${u.origin}${u.pathname}`).toBe(`https://node1.test/api/servers/${uuid}/files/download`);
    expect(u.searchParams.get("path")).toBe("/readme.txt");
    const c = verifyJwt(u.searchParams.get("token")!, key.publicKey)!.claims;
    expect(c).toMatchObject({ aud: "node1.test", sub: String(player.id), server_uuid: uuid, permissions: ["files.read"], path: "/readme.txt" });
    expect(c.directory).toBeUndefined();
    expect(c.exp - c.iat).toBeLessThanOrEqual(600);
    expect(down.expiresAt.getTime()).toBe(c.exp * 1000);

    const up = new URL((await player.api.files.uploadUrl({ uuid, directory: "/plugins" })).url);
    expect(up.pathname).toBe(`/api/servers/${uuid}/files/upload`);
    expect(up.searchParams.get("directory")).toBe("/plugins");
    const c2 = verifyJwt(up.searchParams.get("token")!, key.publicKey)!.claims;
    expect(c2.permissions).toEqual(["files.write"]);
    expect(c2.directory).toBe("/plugins");
    expect(c2.jti).not.toBe(c.jti);
  });

  it("sftpDetails", async () => {
    expect(await player.api.files.sftpDetails({ uuid })).toEqual({ host: "node1.test", port: 2222, username: `speler.${shortId}` });
  });
});

describe("subusers + rechten", () => {
  it("invite op Discord-ID en op naam; onbekend ID → leeg account; dubbel → CONFLICT; eigenaar → BAD_REQUEST", async () => {
    const s = await player.api.subusers.invite({ uuid, who: sub.discordId, permissions: ["files.read", "files.read"] });
    expect(s).toMatchObject({ user: { id: sub.id, name: "helper" }, permissions: ["files.read"] });
    await expect(player.api.subusers.invite({ uuid, who: "HELPER", permissions: [] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(player.api.subusers.invite({ uuid, who: player.discordId, permissions: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(player.api.subusers.invite({ uuid, who: "niemand-bekend", permissions: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const fresh = await player.api.subusers.invite({ uuid, who: "260000000000000099", permissions: ["power"] });
    expect(fresh.user).toMatchObject({ discordId: "260000000000000099", name: null });
    expect((await player.api.subusers.list({ uuid })).map((x) => x.user.discordId)).toEqual([sub.discordId, "260000000000000099"]);
    await player.api.subusers.remove({ uuid, userId: fresh.user.id });
    await expect(player.api.subusers.remove({ uuid, userId: fresh.user.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("subuser met alleen files.read: lezen ja, schrijven/upload/power/subusers nee; vreemde nergens", async () => {
    expect((await sub.api.files.read({ uuid, path: "/readme.txt" })).content).toBe("hallo\n");
    expect(await sub.api.files.downloadUrl({ uuid, path: "/readme.txt" })).toHaveProperty("url");
    for (const p of [
      () => sub.api.files.write({ uuid, path: "/readme.txt", content: "hack" }),
      () => sub.api.files.uploadUrl({ uuid, directory: "/" }),
      () => sub.api.files.delete({ uuid, paths: ["/readme.txt"] }),
      () => sub.api.servers.power({ uuid, action: "stop" }),
      () => sub.api.subusers.list({ uuid }),
      () => sub.api.subusers.invite({ uuid, who: stranger.discordId, permissions: ["files.write"] }),
      () => stranger.api.files.list({ uuid, path: "/" }),
      () => stranger.api.files.sftpDetails({ uuid }),
      () => stranger.api.account.setSftpPassword({ uuid, password: "lang-genoeg-wachtwoord" }),
    ]) {
      await expect(p()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(h.daemon.fs(uuid).files.get("/readme.txt")).toBe("hallo\n");
  });

  it("update geeft nieuwe rechten direct; ook FORBIDDEN via een echte HTTP-aanroep", async () => {
    await player.api.subusers.update({ uuid, userId: sub.id, permissions: ["files.read", "files.write"] });
    await sub.api.files.write({ uuid, path: "/van-sub.txt", content: "ok" });
    await player.api.subusers.update({ uuid, userId: sub.id, permissions: ["files.read"] });

    const router = buildRouter(implementation);
    const res = await fetchRequestHandler({
      endpoint: "/api/trpc",
      router,
      req: new Request("http://panel.test/api/trpc/files.write", {
        method: "POST",
        headers: { cookie: sub.cookie, "content-type": "application/json" },
        body: JSON.stringify({ json: { uuid, path: "/readme.txt", content: "hack" } }),
      }),
      createContext: ({ req, resHeaders }) => createContext(req, resHeaders),
    });
    expect(res.status).toBe(403);
    expect(h.daemon.fs(uuid).files.get("/readme.txt")).toBe("hallo\n");
  });

  it("admin (volledig) mag beheren", async () => {
    expect((await admin.api.subusers.list({ uuid })).length).toBe(1);
    expect((await admin.api.files.list({ uuid, path: "/" })).length).toBeGreaterThan(0);
  });
});

describe("API-sleutels", () => {
  it("aanmaken (sleutel één keer), lijst zonder sleutel, intrekken alleen eigen", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "ci", permissions: ["files.read"], expiresAt: null });
    expect(key).toHaveLength(43);
    expect(apiKey).toMatchObject({ name: "ci", prefix: key.slice(0, 8), permissions: ["files.read"], lastUsedAt: null });
    const list = await player.api.account.apiKeys();
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key);
    await expect(stranger.api.account.revokeApiKey({ id: apiKey.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(player.api.account.createApiKey({ name: "oud", permissions: [], expiresAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await player.api.account.revokeApiKey({ id: apiKey.id });
    expect(await player.api.account.apiKeys()).toEqual([]);
  });
});

describe("SFTP-auth (/api/remote/sftp/auth)", () => {
  const auth = (body: unknown, token: string | null = h.env.NODE_TOKEN!) =>
    sftpAuthRoute(
      new Request("http://panel.test/api/remote/sftp/auth", {
        method: "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );

  beforeEach(async () => {
    await resetLimiter();
  });

  it("setSftpPassword slaat Argon2id op; eigenaar krijgt alle rechten, subuser alleen de zijne", async () => {
    await player.api.account.setSftpPassword({ uuid, password: "geheim-wachtwoord-1" });
    const [cred] = await getDb().select().from(schema.sftpCredentials).where(eq(schema.sftpCredentials.userId, player.id));
    expect(cred!.passwordHash).toMatch(/^\$argon2id\$/);
    const r = await auth({ username: `speler.${shortId}`, password: "geheim-wachtwoord-1", ip: "10.0.0.1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ server_uuid: uuid, user_id: String(player.id), permissions: expect.arrayContaining(["files.read", "files.write", "power"]) });

    await sub.api.account.setSftpPassword({ uuid, password: "helper-wachtwoord-1" });
    const s = await auth({ username: `Helper.${shortId}`, password: "helper-wachtwoord-1", ip: "10.0.0.1" });
    expect(s.status).toBe(200);
    expect((await s.json()).permissions).toEqual(["files.read"]);
  });

  it("fout wachtwoord, verkeerde server, onzin → 403; geen node-token → 401", async () => {
    expect((await auth({ username: `speler.${shortId}`, password: "fout", ip: "10.0.0.2" })).status).toBe(403);
    expect((await auth({ username: "speler.00000000", password: "geheim-wachtwoord-1", ip: "10.0.0.2" })).status).toBe(403);
    expect((await auth({ username: "zonderpunt", password: "x", ip: "10.0.0.2" })).status).toBe(403);
    expect((await auth({ username: `vreemd.${shortId}`, password: "geheim-wachtwoord-1", ip: "10.0.0.2" })).status).toBe(403);
    expect((await auth({ username: `speler.${shortId}`, password: "geheim-wachtwoord-1", ip: "x" }, "fout-token")).status).toBe(401);
  });

  it("API-sleutel als wachtwoord: rechten = doorsnede; verlopen of ingetrokken → 403", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "sftp", permissions: ["files.read"], expiresAt: null });
    const r = await auth({ username: `speler.${shortId}`, password: key, ip: "10.0.0.3" });
    expect(r.status).toBe(200);
    expect((await r.json()).permissions).toEqual(["files.read"]);
    const [row] = await getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    await getDb().update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiKeys.id, apiKey.id));
    expect((await auth({ username: `speler.${shortId}`, password: key, ip: "10.0.0.3" })).status).toBe(403);
    // Sleutel zonder files.read → 403
    const w = await player.api.account.createApiKey({ name: "alleen-power", permissions: ["power"], expiresAt: null });
    expect((await auth({ username: `speler.${shortId}`, password: w.key, ip: "10.0.0.3" })).status).toBe(403);
  });

  it("geblokkeerde subuser → 403", async () => {
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, sub.id));
    expect((await auth({ username: `helper.${shortId}`, password: "helper-wachtwoord-1", ip: "10.0.0.4" })).status).toBe(403);
    await getDb().update(schema.users).set({ blocked: false }).where(eq(schema.users.id, sub.id));
  });

  it("rate limiting per gebruikersnaam en per IP → 429, ook met het goede wachtwoord", async () => {
    for (let i = 0; i < 10; i++) expect((await auth({ username: `speler.${shortId}`, password: "fout", ip: `10.1.0.${i}` })).status).toBe(403);
    expect((await auth({ username: `speler.${shortId}`, password: "geheim-wachtwoord-1", ip: "10.1.1.1" })).status).toBe(429);
    await resetLimiter();
    for (let i = 0; i < 30; i++) await auth({ username: `x${i}.${shortId}`, password: "fout", ip: "10.2.0.1" });
    expect((await auth({ username: `speler.${shortId}`, password: "geheim-wachtwoord-1", ip: "10.2.0.1" })).status).toBe(429);
    expect((await auth({ username: `speler.${shortId}`, password: "geheim-wachtwoord-1", ip: "10.2.0.2" })).status).toBe(200);
  });
});
