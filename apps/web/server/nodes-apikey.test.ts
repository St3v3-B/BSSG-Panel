import { buildRouter, createCallerFactory } from "@panel/api";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createContext } from "./context";
import { getDb, schema } from "./db";
import { implementation } from "./index";
import { decrypt, sha256 } from "./lib/crypto";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
const caller = createCallerFactory(buildRouter(implementation));
let admin: TestUser, player: TestUser;
let uuid = "";

const withKey = async (key: string) => caller(await createContext(new Request("http://panel.test/api/trpc", { headers: { authorization: `Bearer ${key}` } }), new Headers()));

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "280000000000000001", name: "speler" });
  const d = await admin.api.admin.servers.create({
    name: "K", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 }, allocationIds: [await h.allocation(25590)], variables: {}, startOnInstall: true,
  });
  uuid = d.uuid;
  h.daemon.fs(uuid).files.set("/a.txt", "a");
});

describe("admin.nodes.create/update/delete/regenerateToken", () => {
  it("create: token één keer, hash + versleuteld opgeslagen, installcommando met PANEL_URL en NODE_TOKEN", async () => {
    const r = await admin.api.admin.nodes.create({ name: "node2", fqdn: "Node2.test", daemonPort: 8443, sftpPort: 2023, maxRamMb: 4096, maxDiskMb: 10000, s3TargetId: null });
    expect(r.node).toMatchObject({ name: "node2", fqdn: "node2.test", isLocal: false, diskQuotaMode: null });
    const [row] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, r.node.id));
    expect(row!.tokenHash).toBe(sha256(r.token));
    expect(decrypt(row!.tokenEnc!)).toBe(r.token);
    expect(r.installCommand).toContain(`NODE_TOKEN='${r.token}'`);
    expect(r.installCommand).toContain("PANEL_URL='http://127.0.0.1:3999'");
    expect(r.installCommand).toContain("deploy/install.sh --non-interactive");
    expect(r.installCommand).not.toMatch(/curl|wget/);
    await expect(admin.api.admin.nodes.create({ name: "node2", fqdn: "x.test", daemonPort: 1, sftpPort: 2, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(player.api.admin.nodes.create({ name: "n", fqdn: "n.test", daemonPort: 1, sftpPort: 2, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const t = await admin.api.admin.nodes.regenerateToken({ id: r.node.id });
    expect(t.token).not.toBe(r.token);
    const [row2] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, r.node.id));
    expect(row2!.tokenHash).toBe(sha256(t.token));

    const u = await admin.api.admin.nodes.update({ id: r.node.id, name: "node2b", fqdn: "node2b.test", daemonPort: 8443, sftpPort: 2023, maxRamMb: 1, maxDiskMb: 2, s3TargetId: null });
    expect(u).toMatchObject({ name: "node2b", fqdn: "node2b.test", maxRamMb: 1 });
    await admin.api.admin.nodes.delete({ id: r.node.id });
    await expect(admin.api.admin.nodes.get({ id: r.node.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lokale node: niet verwijderen, geen nieuw token, fqdn blijft uit env; node met servers niet verwijderen", async () => {
    await expect(admin.api.admin.nodes.delete({ id: h.localNodeId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(admin.api.admin.nodes.regenerateToken({ id: h.localNodeId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const u = await admin.api.admin.nodes.update({ id: h.localNodeId, name: "lokaal", fqdn: "anders.test", daemonPort: 1, sftpPort: 1, maxRamMb: 8000, maxDiskMb: 1, s3TargetId: null });
    expect(u).toMatchObject({ name: "lokaal", fqdn: "node1.test", sftpPort: 2222, maxRamMb: 8000 });
    const r = await admin.api.admin.nodes.create({ name: "node3", fqdn: "node3.test", daemonPort: 8080, sftpPort: 2022, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
    const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
    await getDb().update(schema.servers).set({ nodeId: r.node.id }).where(eq(schema.servers.id, srv!.id));
    await expect(admin.api.admin.nodes.delete({ id: r.node.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await getDb().update(schema.servers).set({ nodeId: h.localNodeId }).where(eq(schema.servers.id, srv!.id));
  });
});

describe("API-sleutel als login (Authorization: Bearer)", () => {
  it("rechten = doorsnede; geen eigenaarsacties; lastUsedAt; activiteit met method=api_key", async () => {
    const { key, apiKey } = await player.api.account.createApiKey({ name: "bot", permissions: ["files.read", "files.write"], expiresAt: null });
    const api = await withKey(key);
    expect((await api.auth.me())!.user.id).toBe(player.id);
    expect((await api.servers.list()).map((s) => s.uuid)).toEqual([uuid]);
    expect((await api.servers.get({ uuid })).permissions.sort()).toEqual(["files.read", "files.write"]);
    expect((await api.files.read({ uuid, path: "/a.txt" })).content).toBe("a");
    await api.files.write({ uuid, path: "/b.txt", content: "via sleutel" });
    await expect(api.servers.power({ uuid, action: "start" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.servers.rename({ uuid, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.subusers.list({ uuid })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.account.createApiKey({ name: "meer", permissions: ["power"], expiresAt: null })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.account.totpSetup()).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [row] = await getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
    const logs = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.file.write"));
    expect(logs.at(-1)!.metadata).toMatchObject({ path: "/b.txt", method: "api_key", apiKeyId: apiKey.id });
  });

  it("nooit admin via een sleutel; ongeldig, verlopen of geblokkeerd → geen toegang", async () => {
    const { key, apiKey } = await admin.api.account.createApiKey({ name: "admin-bot", permissions: ["files.read"], expiresAt: null });
    const api = await withKey(key);
    expect((await api.auth.me())!.isAdmin).toBe(false);
    await expect(api.admin.users.list({ limit: 10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // admin is geen eigenaar/subuser: via de sleutel geen toegang tot de server van een ander
    await expect(api.files.list({ uuid, path: "/" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const bad = await withKey(`${key.slice(0, 8)}${"x".repeat(35)}`);
    expect(await bad.auth.me()).toBeNull();
    await expect(bad.servers.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await getDb().update(schema.apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiKeys.id, apiKey.id));
    await expect((await withKey(key)).servers.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const p = await player.api.account.createApiKey({ name: "p", permissions: ["files.read"], expiresAt: null });
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, player.id));
    await expect((await withKey(p.key)).servers.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await getDb().update(schema.users).set({ blocked: false }).where(eq(schema.users.id, player.id));
  });
});
