/** Bedrock (Geyser) na een transfer: UDP-allocation en Geyser-config verhuizen mee en de Bedrock-status blijft aan. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { daemonUrlOverrides } from "./daemon";
import { getDb, schema } from "./db";
import { transferPollMs } from "./routers/transfer";
import { mockExternal, type Handler } from "./test/external-fake";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ env: { NODE_PUBLIC_IP: "203.0.113.10" }, templates: { "game/paper.yaml": tpl("paper.yaml"), "game/velocity.yaml": tpl("velocity.yaml") } });
const limits = { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// Nep GeyserMC-download-API (zoals in bedrock.test.ts).
const bodies: Record<string, string> = { "geyser/spigot": "jar-geyser-spigot", "geyser/velocity": "jar-geyser-velocity", "floodgate/spigot": "jar-fg-spigot", "floodgate/velocity": "jar-fg-velocity" };
const geyserApi: Handler = (url) => {
  if (url.hostname !== "download.geysermc.org") return undefined;
  const m = /^\/v2\/projects\/(geyser|floodgate)\/versions\/latest\/builds\/latest(?:\/downloads\/(spigot|velocity))?$/.exec(url.pathname);
  if (!m) return { status: 404 };
  const [, project, platform] = m;
  if (platform) return { body: bodies[`${project}/${platform}`]! };
  const downloads = Object.fromEntries(["spigot", "velocity"].map((p) => [p, { name: `${project}-${p}.jar`, sha256: sha(bodies[`${project}/${p}`]!) }]));
  return { json: { project_id: project, version: "2.12.1", build: 1312, downloads } };
};

let ext: ReturnType<typeof mockExternal>;
let admin: TestUser, alice: TestUser;
let d2: FakeDaemon;
let node2 = 0;
let port = 36400;

beforeAll(async () => {
  transferPollMs.value = 10;
  ext = mockExternal(geyserApi);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "330000000000000001", name: "alice" });
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  node2 = n.node.id;
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
});
afterAll(async () => {
  ext.restore();
  daemonUrlOverrides.clear();
  await d2.stop();
});
beforeEach(async () => {
  d2.reset();
  await getDb().delete(schema.allocations).where(and(eq(schema.allocations.nodeId, node2), isNull(schema.allocations.serverId)));
});

const node2Alloc = async (p: number, ip = "0.0.0.0") => (await getDb().insert(schema.allocations).values({ nodeId: node2, ip, port: p }).returning())[0]!.id;
const row = async (uuid: string) => (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!;

/** Paper-server op de lokale node met Bedrock aan op `bedrockPort`. */
async function paperWithBedrock(bedrockPort: number, state: "online" | "offline" = "offline") {
  const java = await h.allocation(port++);
  const bedrock = await h.allocation(bedrockPort);
  const s = await admin.api.admin.servers.create({ name: "Paper", ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId("paper"), limits, allocationIds: [java], variables: {}, startOnInstall: false });
  const st = await alice.api.servers.setBedrock({ uuid: s.uuid, enabled: true, allocationId: bedrock });
  expect(st).toMatchObject({ enabled: true, port: bedrockPort });
  h.daemon.servers.get(s.uuid)!.state = state;
  return s.uuid;
}

describe("transfer met Bedrock", () => {
  it("Bedrock blijft aan: eigen UDP-allocation op het doel (zelfde poort), spec en Geyser-config met de nieuwe poorten", async () => {
    const uuid = await paperWithBedrock(19140, "online");
    const java = await node2Alloc(27101);
    await node2Alloc(19132);
    const same = await node2Alloc(19140);
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2 });

    const r = await row(uuid);
    expect(r.nodeId).toBe(node2);
    expect(r.bedrockAllocationId).toBe(same); // dezelfde poort als op de bron heeft voorrang
    const spec = d2.servers.get(uuid)!.spec;
    expect(spec.allocations).toEqual([
      { ip: "0.0.0.0", port: 27101, primary: true },
      { ip: "0.0.0.0", port: 19140, primary: false },
    ]);
    const cfg = d2.fs(uuid).files.get("/plugins/Geyser-Spigot/config.yml")!;
    expect(cfg).toContain("port: 19140");
    expect(cfg).toContain("port: 27101"); // Java-kant = de nieuwe primaire poort
    expect(d2.fs(uuid).files.get("/plugins/Geyser-Spigot.jar")).toBe("jar-geyser-spigot"); // plugins gingen mee met de data
    const st = await alice.api.servers.bedrock({ uuid });
    expect(st).toMatchObject({ supported: true, enabled: true, port: 19140, allocationId: same });
    const d = await alice.api.servers.get({ uuid });
    expect(d.allocations.map((a) => [a.port, a.role, a.primary])).toEqual([
      [27101, "game", true],
      [19140, "bedrock", false],
    ]);
    // De oude allocations (ook de Bedrock-poort) op de bron zijn vrij.
    const local = await admin.api.admin.allocations.list({ nodeId: h.localNodeId });
    expect(local.filter((a) => a.serverUuid === uuid)).toEqual([]);
    expect(d2.servers.get(uuid)!.state).toBe("starting");
    expect((await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, java)))[0]!.isPrimary).toBe(true);

    // Uitzetten na de transfer werkt op de nieuwe node.
    expect(await alice.api.servers.setBedrock({ uuid, enabled: false })).toMatchObject({ enabled: false });
    expect(d2.servers.get(uuid)!.spec.allocations.map((a) => a.port)).toEqual([27101]);
  });

  it("zonder dezelfde poort: 19132, anders de laagste vrije; opgegeven Java-allocation telt niet als Bedrock", async () => {
    const uuid = await paperWithBedrock(19141);
    const leftover = await node2Alloc(27110);
    const pick = await node2Alloc(27111);
    const b19132 = await node2Alloc(19132);
    await admin.api.admin.servers.transfer({ uuid, nodeId: node2, allocationIds: [pick] });
    expect((await row(uuid)).bedrockAllocationId).toBe(b19132);
    expect(d2.servers.get(uuid)!.spec.allocations.map((a) => a.port)).toEqual([27111, 19132]);
    expect(d2.fs(uuid).files.get("/plugins/Geyser-Spigot/config.yml")).toContain("port: 27111");

    const uuid2 = await paperWithBedrock(19142);
    const java2 = await node2Alloc(27120);
    await node2Alloc(27121);
    await admin.api.admin.servers.transfer({ uuid: uuid2, nodeId: node2, allocationIds: [java2] });
    expect((await row(uuid2)).bedrockAllocationId).toBe(leftover); // laagste vrije, niet de opgegeven Java-poort
  });

  it("geen vrije poort voor Bedrock op het doel: duidelijke fout vooraf, niets veranderd", async () => {
    const uuid = await paperWithBedrock(19143);
    await node2Alloc(27130);
    await node2Alloc(27131, "10.0.0.5"); // ander IP telt niet
    await expect(admin.api.admin.servers.transfer({ uuid, nodeId: node2 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("NO_FREE_BEDROCK_ALLOCATION") });
    const r = await row(uuid);
    expect(r.nodeId).toBe(h.localNodeId);
    expect(r.bedrockAllocationId).not.toBeNull();
    expect(d2.servers.has(uuid)).toBe(false);
    expect((await alice.api.servers.bedrock({ uuid })).enabled).toBe(true);
  });

  it("zonder Bedrock verandert er niets: één Java-allocation, geen Geyser-config", async () => {
    const java = await h.allocation(port++);
    const s = await admin.api.admin.servers.create({ name: "Plain", ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId("paper"), limits, allocationIds: [java], variables: {}, startOnInstall: false });
    h.daemon.servers.get(s.uuid)!.state = "offline";
    await node2Alloc(27140);
    await node2Alloc(27150);
    await admin.api.admin.servers.transfer({ uuid: s.uuid, nodeId: node2 });
    expect((await row(s.uuid)).bedrockAllocationId).toBeNull();
    expect(d2.servers.get(s.uuid)!.spec.allocations.map((a) => a.port)).toEqual([27140]);
    expect(d2.fs(s.uuid).files.has("/plugins/Geyser-Spigot/config.yml")).toBe(false);
  });
});
