import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { geyserConfig } from "./lib/geyser";
import { mockExternal, type Handler } from "./test/external-fake";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" }, templates: { "game/paper.yaml": tpl("paper.yaml"), "game/velocity.yaml": tpl("velocity.yaml"), "game/fabric.yaml": tpl("fabric.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- nep GeyserMC-download-API ----
const bodies: Record<string, string> = { "geyser/spigot": "jar-geyser-spigot", "geyser/velocity": "jar-geyser-velocity", "floodgate/spigot": "jar-fg-spigot", "floodgate/velocity": "jar-fg-velocity" };
const names: Record<string, string> = { "geyser/spigot": "Geyser-Spigot.jar", "geyser/velocity": "Geyser-Velocity.jar", "floodgate/spigot": "floodgate-spigot.jar", "floodgate/velocity": "floodgate-velocity.jar" };
let tamper = false;
const world: Handler = (url) => {
  if (url.hostname !== "download.geysermc.org") return undefined;
  const m = /^\/v2\/projects\/(geyser|floodgate)\/versions\/latest\/builds\/latest(?:\/downloads\/(spigot|velocity))?$/.exec(url.pathname);
  if (!m) return { status: 404 };
  const [, project, platform] = m;
  if (platform) return { body: tamper ? "tampered" : bodies[`${project}/${platform}`]! };
  const downloads = Object.fromEntries(["spigot", "velocity"].map((p) => [p, { name: names[`${project}/${p}`], sha256: sha(bodies[`${project}/${p}`]!) }]));
  return { json: { project_id: project, version: "2.12.1", build: 1312, downloads } };
};
let ext: ReturnType<typeof mockExternal>;
let admin: TestUser, alice: TestUser, bob: TestUser;
let paper = "", proxy = "", backend = "", fab = "";
const files = (u: string) => h.daemon.fs(u).files;
const create = async (name: string, owner: TestUser, slug: string, port: number, extra: number[] = []) => {
  const a = await h.allocation(port);
  const more = await Promise.all(extra.map((p) => h.allocation(p)));
  return (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [a, ...more], variables: {}, startOnInstall: false })).uuid;
};

beforeAll(async () => {
  ext = mockExternal(world);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "200100000000000001", name: "alice" });
  bob = await h.user({ discordId: "200200000000000002", name: "bob" });
  paper = await create("Paper", alice, "paper", 36201);
  proxy = await create("Proxy", alice, "velocity", 36200);
  backend = await create("Backend", alice, "paper", 36202);
  fab = await create("Fab", alice, "fabric", 36203);
  await h.allocation(19132);
  await h.allocation(36210);
});
afterAll(() => ext.restore());

describe("Bedrock (Geyser)", () => {
  it("config: Bedrock-poort, Java-kant en floodgate-auth", () => {
    const c = geyserConfig({ port: 19132, javaPort: 25565 });
    expect(c).toContain("port: 19132");
    expect(c).toContain("address: 0.0.0.0");
    expect(c).toContain("auth-type: floodgate");
    expect(c).toContain("port: 25565");
  });

  it("niet ondersteund (Fabric) en geen toegang voor vreemden", async () => {
    expect(await alice.api.servers.bedrock({ uuid: fab })).toMatchObject({ supported: false, enabled: false });
    await expect(alice.api.servers.setBedrock({ uuid: fab, enabled: true })).rejects.toThrow(/BEDROCK_NOT_SUPPORTED/);
    await expect(bob.api.servers.setBedrock({ uuid: paper, enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("hash-controle: afwijkende sha256 weigert en wijzigt niets", async () => {
    tamper = true;
    await expect(alice.api.servers.setBedrock({ uuid: paper, enabled: true })).rejects.toThrow(/HASH_MISMATCH/);
    tamper = false;
    expect(files(paper).has("/plugins/Geyser-Spigot.jar")).toBe(false);
    expect((await alice.api.servers.bedrock({ uuid: paper })).enabled).toBe(false);
    expect((await getDb().select().from(schema.allocations).where(eq(schema.allocations.port, 19132)))[0]!.serverId).toBeNull();
  });

  it("Paper aanzetten: 19132, jars, config, UDP-allocation in de spec", async () => {
    const before = await alice.api.servers.bedrock({ uuid: paper });
    expect(before.freeAllocations[0]).toMatchObject({ port: 19132 }); // 19132 eerst
    const r = await alice.api.servers.setBedrock({ uuid: paper, enabled: true });
    expect(r).toMatchObject({ supported: true, mode: "standalone", enabled: true, port: 19132, address: "127.0.0.1" });
    expect(files(paper).get("/plugins/Geyser-Spigot.jar")).toBe("jar-geyser-spigot");
    expect(files(paper).get("/plugins/floodgate-spigot.jar")).toBe("jar-fg-spigot");
    const cfg = files(paper).get("/plugins/Geyser-Spigot/config.yml")!;
    expect(cfg).toContain("port: 19132");
    expect(cfg).toContain("port: 36201"); // Java-kant = de server zelf
    expect(h.daemon.servers.get(paper)!.spec.allocations.map((a) => a.port).sort()).toEqual([19132, 36201]);
    const d = await alice.api.servers.get({ uuid: paper });
    expect(d.allocations.find((a) => a.port === 19132)).toMatchObject({ role: "bedrock", primary: false });
    expect(d.allocations[0]).toMatchObject({ port: 36201, role: "game", primary: true });
    const [log] = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "server.bedrock.enable"));
    expect(log).toBeTruthy();
  });

  it("opnieuw aanzetten houdt dezelfde poort; een andere vrije poort kiezen verhuist", async () => {
    expect((await alice.api.servers.setBedrock({ uuid: paper, enabled: true })).port).toBe(19132);
    const free = (await alice.api.servers.bedrock({ uuid: paper })).freeAllocations.find((f) => f.port === 36210)!;
    const r = await alice.api.servers.setBedrock({ uuid: paper, enabled: true, allocationId: free.id });
    expect(r.port).toBe(36210);
    expect(files(paper).get("/plugins/Geyser-Spigot/config.yml")).toContain("port: 36210");
    const old = (await getDb().select().from(schema.allocations).where(eq(schema.allocations.port, 19132)))[0]!;
    expect(old.serverId).toBeNull(); // oude poort vrij
    await expect(alice.api.servers.setBedrock({ uuid: backend, enabled: true, allocationId: free.id })).rejects.toThrow(/ALLOCATION_NOT_AVAILABLE/);
  });

  it("uitzetten: plugins weg, poort vrij, spec zonder Bedrock-poort", async () => {
    const r = await alice.api.servers.setBedrock({ uuid: paper, enabled: false });
    expect(r).toMatchObject({ enabled: false, port: null });
    expect(files(paper).has("/plugins/Geyser-Spigot.jar")).toBe(false);
    expect(files(paper).has("/plugins/floodgate-spigot.jar")).toBe(false);
    expect(h.daemon.servers.get(paper)!.spec.allocations.map((a) => a.port)).toEqual([36201]);
    expect(r.freeAllocations.map((f) => f.port)).toContain(36210);
    await alice.api.servers.setBedrock({ uuid: paper, enabled: false }); // idempotent
  });

  it("Velocity-netwerk: key.pem naar de backends, Floodgate weg bij uitzetten en bij verwijderen uit het netwerk", async () => {
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: backend, name: "smp", isDefault: true }], restart: false }).catch(() => {});
    // velocity.toml bestaat pas na installatie: zet hem neer zoals de install doet
    files(proxy).set("/velocity.toml", 'bind = "0.0.0.0:25577"\n[servers]\ntry = []\n');
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: backend, name: "smp", isDefault: true }], restart: false });
    expect((await alice.api.servers.bedrock({ uuid: backend })).mode).toBe("backend");
    await expect(alice.api.servers.setBedrock({ uuid: backend, enabled: true })).rejects.toThrow(/BEDROCK_VIA_PROXY/);

    const r = await alice.api.servers.setBedrock({ uuid: proxy, enabled: true });
    expect(r).toMatchObject({ mode: "proxy", enabled: true });
    expect(files(proxy).get("/plugins/Geyser-Velocity.jar")).toBe("jar-geyser-velocity");
    expect(files(proxy).get("/plugins/floodgate-velocity.jar")).toBe("jar-fg-velocity");
    expect(files(proxy).get("/plugins/Geyser-Velocity/config.yml")).toContain("auth-type: floodgate");
    const key = files(proxy).get("/plugins/floodgate/key.pem");
    expect(key).toBeTruthy();
    expect(files(backend).get("/plugins/floodgate/key.pem")).toBe(key);
    expect(files(backend).get("/plugins/floodgate-spigot.jar")).toBe("jar-fg-spigot");
    expect(files(backend).has("/plugins/Geyser-Spigot.jar")).toBe(false); // Geyser alleen op de proxy

    // opnieuw aanzetten: dezelfde sleutel
    await alice.api.servers.setBedrock({ uuid: proxy, enabled: true });
    expect(files(proxy).get("/plugins/floodgate/key.pem")).toBe(key);

    // lid verwijderen uit het netwerk: Floodgate weg
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [], restart: false });
    expect(files(backend).has("/plugins/floodgate-spigot.jar")).toBe(false);
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: backend, name: "smp", isDefault: true }], restart: false });
    expect(files(backend).has("/plugins/floodgate-spigot.jar")).toBe(true); // nieuw lid krijgt hem direct

    await alice.api.servers.setBedrock({ uuid: proxy, enabled: false });
    expect(files(proxy).has("/plugins/Geyser-Velocity.jar")).toBe(false);
    expect(files(backend).has("/plugins/floodgate-spigot.jar")).toBe(false);
  });

  it("geen vrije allocation: duidelijke fout", async () => {
    await getDb().update(schema.allocations).set({ serverId: (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, fab)))[0]!.id }).where(eq(schema.allocations.port, 36210));
    await getDb().update(schema.allocations).set({ serverId: (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, fab)))[0]!.id }).where(eq(schema.allocations.port, 19132));
    expect((await alice.api.servers.bedrock({ uuid: paper })).freeAllocations).toEqual([]);
    await expect(alice.api.servers.setBedrock({ uuid: paper, enabled: true })).rejects.toThrow(/NO_FREE_ALLOCATIONS/);
  });
});
