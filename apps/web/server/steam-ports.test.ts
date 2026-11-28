import { readFileSync } from "node:fs";
import { parseTemplate } from "@panel/api";
import { eq, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { buildServerSpec } from "./spec";
import { templateRow } from "./templates";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const yaml = (slug: string) => readFileSync(new URL(`../../../templates/game/${slug}.yaml`, import.meta.url), "utf8");
const SLUGS = ["valheim", "satisfactory", "palworld", "rust", "cs2", "terraria"] as const;

function row(slug: string, id = 1) {
  const r = parseTemplate(yaml(slug));
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { ...templateRow(r.spec, yaml(slug)), id: 100 + id, createdAt: new Date(), updatedAt: new Date() };
}
const limits = { cpuPct: 200, ramMb: 4096, swapMb: 0, diskMb: 8192 };

describe("template → ServerSpec met protocol", () => {
  it("Valheim: game + query UDP, QUERY_PORT in de env, stop/install-timeouts", () => {
    const s = buildServerSpec({ uuid: "u", template: row("valheim"), variables: { SERVER_PASSWORD: "geheim1" }, limits, allocations: [{ ip: "127.0.0.1", port: 2457, isPrimary: false }, { ip: "127.0.0.1", port: 2456, isPrimary: true }] });
    expect(s.allocations).toEqual([{ ip: "127.0.0.1", port: 2456, primary: true, protocol: "udp" }, { ip: "127.0.0.1", port: 2457, primary: false, protocol: "udp" }]);
    expect(s.environment).toMatchObject({ QUERY_PORT: "2457", SERVER_PASSWORD: "geheim1", WORLD_NAME: "Dedicated" });
    expect(s.stop).toEqual({ type: "signal", value: "SIGINT", timeout_seconds: 90 });
    expect(s.install.timeout_minutes).toBe(60);
    expect(s.sleep).toBeNull();
  });

  it("Rust: extra poorten per rol, zonder allocation primair + offset", () => {
    const s = buildServerSpec({ uuid: "u", template: row("rust", 2), variables: {}, limits, allocations: [{ ip: "127.0.0.1", port: 28015, isPrimary: true }, { ip: "127.0.0.1", port: 28017, isPrimary: false }] });
    expect(s.allocations.map((a) => `${a.port}/${a.protocol ?? "both"}`)).toEqual(["28015/udp", "28017/udp"]);
    expect(s.environment).toMatchObject({ QUERY_PORT: "28017", RCON_PORT: "28016", APP_PORT: "28082" });
  });

  it("CS2 en Satisfactory: both voor game + API/RCON; Terraria alleen TCP", () => {
    const cs = buildServerSpec({ uuid: "u", template: row("cs2", 3), variables: {}, limits, allocations: [{ ip: "127.0.0.1", port: 27015, isPrimary: true }] });
    expect(cs.allocations[0]).toEqual({ ip: "127.0.0.1", port: 27015, primary: true }); // both = veld weg (daemon: tcp + udp)
    expect(cs.stop).toEqual({ type: "command", value: "quit" });
    expect(cs.install.timeout_minutes).toBe(360);
    const sf = buildServerSpec({ uuid: "u", template: row("satisfactory", 4), variables: {}, limits, allocations: [{ ip: "127.0.0.1", port: 7777, isPrimary: true }, { ip: "127.0.0.1", port: 8888, isPrimary: false }] });
    expect(sf.allocations.map((a) => `${a.port}/${a.protocol ?? "both"}`)).toEqual(["7777/both", "8888/tcp"]);
    expect(sf.environment.RELIABLE_PORT).toBe("8888");
    const tr = buildServerSpec({ uuid: "u", template: row("terraria", 5), variables: {}, limits, allocations: [{ ip: "127.0.0.1", port: 7777, isPrimary: true }] });
    expect(tr.allocations).toEqual([{ ip: "127.0.0.1", port: 7777, primary: true, protocol: "tcp" }]);
  });

  it("template zonder ports: protocol van de allocation (standaard both, zoals voorheen)", () => {
    const paper = { ...row("valheim", 6), sourceYaml: "schema: 1\n" };
    const s = buildServerSpec({ uuid: "u", template: paper, variables: {}, limits, allocations: [{ ip: "127.0.0.1", port: 25565, isPrimary: true }, { ip: "127.0.0.1", port: 19132, isPrimary: false, protocol: "udp" }] });
    expect(s.allocations.map((a) => a.protocol ?? "both")).toEqual(["both", "udp"]);
    expect(s.environment.QUERY_PORT).toBeUndefined();
  });
});

const h = useHarness({ templates: Object.fromEntries(SLUGS.map((s) => [`game/${s}.yaml`, yaml(s)])) });
let admin: TestUser, player: TestUser;

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000101", name: "speler" });
});

const create = async (slug: string, allocationIds: number[], variables: Record<string, string> = {}) =>
  admin.api.admin.servers.create({ name: slug, ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds, variables, startOnInstall: false });

describe("panel: allocations met protocol en template-poorten", () => {
  it("admin.allocations.create met protocol; list toont het", async () => {
    await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "34000-34001", protocol: "udp" });
    await admin.api.admin.allocations.create({ nodeId: h.localNodeId, ip: "127.0.0.1", ports: "34002" });
    const list = (await admin.api.admin.allocations.list({ nodeId: h.localNodeId })).filter((a) => a.port >= 34000 && a.port <= 34002);
    expect(list.map((a) => `${a.port}/${a.protocol}`)).toEqual(["34000/udp", "34001/udp", "34002/both"]);
  });

  it("templates.get: ports en recommended", async () => {
    const t = await admin.api.admin.templates.get({ id: await h.templateId("valheim") });
    expect(t.ports.map((p) => `${p.env}/${p.protocol}`)).toEqual(["SERVER_PORT/udp", "QUERY_PORT/udp"]);
    expect(t.ports[1]).toMatchObject({ offset: 1, exact: true, name: "Steam query" });
    expect(t.recommended).toEqual({ ramMb: 4096, diskMb: 4096 });
  });

  it("Valheim aanmaken: spec met UDP en QUERY_PORT, detail met label, geen slaapstand", async () => {
    const d = await create("valheim", [await h.allocation(32456), await h.allocation(32457)], { SERVER_PASSWORD: "geheim1" });
    const spec = h.daemon.servers.get(d.uuid)!.spec;
    expect(spec.allocations).toEqual([{ ip: "127.0.0.1", port: 32456, primary: true, protocol: "udp" }, { ip: "127.0.0.1", port: 32457, primary: false, protocol: "udp" }]);
    expect(spec.environment.QUERY_PORT).toBe("32457");
    const g = await player.api.servers.get({ uuid: d.uuid });
    expect(g.allocations.map((a) => [a.port, a.protocol, a.label])).toEqual([[32456, "udp", "Game"], [32457, "udp", "Steam query"]]);
    expect(g.sleep.supported).toBe(false);
    await expect(player.api.servers.updateSleep({ uuid: d.uuid, enabled: true, idleMinutes: 10 })).rejects.toThrow(/SLEEP_NOT_SUPPORTED/);
  });

  it("Satisfactory: zonder de verplichte reliable port → PORTS_REQUIRED, ook bij updateAllocations", async () => {
    const a = await h.allocation(37777);
    await expect(create("satisfactory", [a])).rejects.toThrow(/PORTS_REQUIRED: RELIABLE_PORT/);
    const [row] = await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, a));
    expect(row!.serverId).toBeNull();
    const d = await create("satisfactory", [a, await h.allocation(38888)]);
    expect(h.daemon.servers.get(d.uuid)!.spec.environment.RELIABLE_PORT).toBe("38888");
    await expect(admin.api.admin.servers.updateAllocations({ uuid: d.uuid, allocationIds: [a] })).rejects.toThrow(/PORTS_REQUIRED/);
  });

  it("zelfbediening: kiest opeenvolgende poorten voor Valheim (query = game + 1) en minstens de verplichte", async () => {
    await getDb().delete(schema.allocations).where(isNull(schema.allocations.serverId));
    for (const p of [35000, 35002, 35003, 35010, 35011]) await h.allocation(p);
    await admin.api.admin.users.setQuota({ id: player.id, maxRamMb: 100000, maxDiskMb: 100000, maxCpuPct: 10000, maxServers: 10, maxDatabases: 0, templateIds: null, nodeIds: null, maxPortsPerServer: 4 });
    const own = { name: "v", nodeId: h.localNodeId, limits: { ramMb: 4096, diskMb: 4096, cpuPct: 100 }, variables: { SERVER_PASSWORD: "geheim1" } };
    const v = await player.api.servers.create({ ...own, templateId: await h.templateId("valheim"), ports: 2 });
    expect(h.daemon.servers.get(v.uuid)!.spec.allocations.map((a) => a.port).sort()).toEqual([35002, 35003]);
    const s = await player.api.servers.create({ ...own, name: "s", variables: {}, templateId: await h.templateId("satisfactory"), ports: 1 });
    expect(h.daemon.servers.get(s.uuid)!.spec.allocations).toHaveLength(2);
  });
});
