import type { DaemonServerStats } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { pollAllNow } from "./node-cache";
import { collectStats, defaultFetcher, HOUR, MINUTE, prune, QUARTER, resetStatsHistory, rollup, statsHistory, type NodeStatsFetcher } from "./stats-history";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, sub: TestUser, subNone: TestUser, stranger: TestUser;
let uuid = "";
let uuid2 = "";
let serverId = 0;
let serverId2 = 0;

const MB = 1024 * 1024;
const T0 = Date.parse("2026-11-27T10:00:00Z");
const min = (n: number) => new Date(T0 + n * 60_000);

const stat = (u: string, o: Partial<DaemonServerStats> = {}): DaemonServerStats => ({
  uuid: u, cpu_pct: 10, memory_bytes: 100 * MB, memory_limit_bytes: 1024 * MB, network_rx_bytes: 0, network_tx_bytes: 0, disk_bytes: 5 * MB, disk_limit_bytes: 2048 * MB, uptime_ms: 60_000, ...o,
});

async function rows(res: number, id = serverId) {
  return getDb().select().from(schema.serverStats).where(and(eq(schema.serverStats.serverId, id), eq(schema.serverStats.resolution, res))).orderBy(schema.serverStats.bucket);
}

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "230000000000000001", name: "Speler" });
  sub = await h.user({ discordId: "230000000000000002", name: "sub" });
  subNone = await h.user({ discordId: "230000000000000003", name: "subzonder" });
  stranger = await h.user({ discordId: "230000000000000004", name: "vreemd" });
  const make = async (name: string, port: number) =>
    admin.api.admin.servers.create({
      name, ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"),
      limits: { cpuPct: 200, ramMb: 1024, swapMb: 0, diskMb: 2048 }, allocationIds: [await h.allocation(port)], variables: {}, startOnInstall: false,
    });
  uuid = (await make("Grafiek", 25601)).uuid;
  uuid2 = (await make("Tweede", 25602)).uuid;
  const ids = await getDb().select({ id: schema.servers.id, uuid: schema.servers.uuid }).from(schema.servers);
  serverId = ids.find((r) => r.uuid === uuid)!.id;
  serverId2 = ids.find((r) => r.uuid === uuid2)!.id;
  await getDb().insert(schema.subusers).values([
    { serverId, userId: sub.id, permissions: ["console.read"] },
    { serverId, userId: subNone.id, permissions: ["files.read"] },
    { serverId: serverId2, userId: sub.id, permissions: ["files.read"] },
  ]);
});

beforeEach(async () => {
  resetStatsHistory();
  h.daemon.reset();
  await getDb().delete(schema.serverStats);
});

describe("verzamelen", () => {
  it("één batch per node, één rij per server per minuut; netwerk als bytes/s uit de tellers", async () => {
    let calls = 0;
    let rx = 1_000;
    const fetcher: NodeStatsFetcher = async () => {
      calls++;
      return [stat(uuid, { network_rx_bytes: rx, network_tx_bytes: rx * 2, uptime_ms: calls * 60_000 }), stat("00000000-0000-4000-8000-000000000999")];
    };
    expect(await collectStats(min(0), fetcher)).toBe(1); // onbekende uuid genegeerd
    rx += 6_000; // 6000 bytes in 60 s
    await collectStats(min(1), fetcher);
    await collectStats(new Date(T0 + 60_000 + 10_000), fetcher); // dezelfde minuut nog eens: geen dubbele rij
    expect(calls).toBe(3);
    const r = await rows(MINUTE);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ samples: 1, cpuPct: 10, memoryBytes: 100 * MB, diskBytes: 5 * MB, rxBytesPerSec: null, txBytesPerSec: null });
    expect(r[1]!.rxBytesPerSec).toBeCloseTo(100);
    expect(r[1]!.txBytesPerSec).toBeCloseTo(200);
  });

  it("herstart (teller terug) of een gat: geen netwerkwaarde in plaats van een negatieve", async () => {
    const seq = [stat(uuid, { network_rx_bytes: 50_000, uptime_ms: 600_000 }), stat(uuid, { network_rx_bytes: 100, uptime_ms: 5_000 }), stat(uuid, { network_rx_bytes: 700, uptime_ms: 65_000 })];
    let i = 0;
    const fetcher: NodeStatsFetcher = async () => [seq[i++]!];
    for (let m = 0; m < 3; m++) await collectStats(min(m), fetcher);
    const r = await rows(MINUTE);
    expect(r.map((x) => x.rxBytesPerSec)).toEqual([null, null, 10]);
  });

  it("node onbereikbaar: geen fout, geen rijen (gat in de grafiek)", async () => {
    const fetcher: NodeStatsFetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(collectStats(min(0), fetcher)).resolves.toBe(0);
    expect(await rows(MINUTE)).toHaveLength(0);
  });

  it("standaard-fetcher: GET /api/stats (één aanroep) en terugval per draaiende server bij een oudere daemon", async () => {
    // De servers bestaan opnieuw in de nep-daemon na reset: zet ze er weer in.
    const spec = (u: string) => ({ uuid: u, limits: { cpu_pct: 200, memory_mb: 1024, swap_mb: 0, disk_mb: 2048 } }) as never;
    h.daemon.servers.set(uuid, { spec: spec(uuid), state: "online", installedAt: null });
    h.daemon.servers.set(uuid2, { spec: spec(uuid2), state: "offline", installedAt: null });
    h.daemon.statsFor = (u) => ({ cpu_pct: u === uuid ? 42 : 1 });
    const [node] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, h.localNodeId));
    const got = await defaultFetcher(node!);
    expect(got.map((s) => [s.uuid, s.cpu_pct])).toEqual([[uuid, 42]]);
    expect(h.daemon.requests.filter((r) => r.path.includes("stats")).map((r) => r.path)).toEqual(["/api/stats"]);

    h.daemon.statsBatch = false;
    h.daemon.requests.length = 0;
    await pollAllNow(); // de node-monitor weet welke servers draaien
    const fb = await defaultFetcher(node!);
    expect(fb.map((s) => [s.uuid, s.cpu_pct])).toEqual([[uuid, 42]]);
    const paths = h.daemon.requests.filter((r) => r.path.includes("stats")).map((r) => r.path);
    expect(paths).toEqual(["/api/stats", `/api/servers/${uuid}/stats`]);
    // daarna onthoudt hij dat de batch ontbreekt
    h.daemon.requests.length = 0;
    await defaultFetcher(node!);
    expect(h.daemon.requests.filter((r) => r.path.includes("stats")).map((r) => r.path)).toEqual([`/api/servers/${uuid}/stats`]);
  });
});

describe("samenvatten en opschonen", () => {
  async function seedMinutes(n: number, f: (i: number) => { cpu: number; mem: number; rx: number | null }, start = 0) {
    const vals = Array.from({ length: n }, (_, k) => {
      const i = start + k;
      const v = f(i);
      return { serverId, resolution: MINUTE, bucket: min(i), samples: 1, cpuPct: v.cpu, cpuMaxPct: v.cpu, memoryBytes: v.mem, memoryMaxBytes: v.mem, diskBytes: i, rxBytesPerSec: v.rx, txBytesPerSec: v.rx };
    });
    await getDb().insert(schema.serverStats).values(vals);
  }

  it("1 min → 15 min → 1 uur: gewogen gemiddelde, piek, laatste disk; netwerk-null telt niet mee", async () => {
    await seedMinutes(30, (i) => ({ cpu: i < 15 ? 10 : 40, mem: (i < 15 ? 100 : 300) * MB, rx: i === 0 ? null : 50 }));
    await rollup(min(31));
    const q = await rows(QUARTER);
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ bucket: min(0), samples: 15, cpuPct: 10, cpuMaxPct: 10, memoryBytes: 100 * MB, diskBytes: 14, rxBytesPerSec: 50 });
    expect(q[1]).toMatchObject({ bucket: min(15), samples: 15, cpuPct: 40, memoryBytes: 300 * MB, diskBytes: 29 });
    const hr = await rows(HOUR);
    expect(hr).toHaveLength(1);
    expect(hr[0]).toMatchObject({ bucket: min(0), samples: 30, cpuPct: 25, cpuMaxPct: 40, memoryBytes: 200 * MB, diskBytes: 29 });

    // De lopende bucket wordt bij de volgende tik bijgewerkt (idempotent, geen dubbele rijen).
    await seedMinutes(5, () => ({ cpu: 100, mem: 300 * MB, rx: 50 }), 30);
    await rollup(min(36));
    await rollup(min(36));
    const q2 = await rows(QUARTER);
    expect(q2).toHaveLength(3);
    expect(q2[2]).toMatchObject({ samples: 5, cpuPct: 100 });
    const hr2 = await rows(HOUR);
    expect(hr2[0]!.samples).toBe(35);
    expect(hr2[0]!.cpuPct).toBeCloseTo((15 * 10 + 15 * 40 + 5 * 100) / 35, 3);
  });

  it("opschonen per resolutie: 1 min na ~24 u, 15 min na ~7 d, 1 uur na ~30 d", async () => {
    const now = T0;
    const row = (res: number, agoH: number) => ({ serverId, resolution: res, bucket: new Date(now - agoH * 3600_000), samples: 1, cpuPct: 1, cpuMaxPct: 1, memoryBytes: 1, memoryMaxBytes: 1, diskBytes: 1 });
    await getDb().insert(schema.serverStats).values([row(MINUTE, 1), row(MINUTE, 23.5), row(MINUTE, 26), row(QUARTER, 24 * 6), row(QUARTER, 24 * 8), row(HOUR, 24 * 29), row(HOUR, 24 * 32)]);
    expect(await prune(new Date(now))).toBe(3);
    const left = await getDb().select().from(schema.serverStats);
    expect(left.map((r) => [r.resolution, Math.round((now - r.bucket.getTime()) / 3600_000)]).sort()).toEqual([[3600, 696], [60, 1], [60, 24], [900, 144]].sort());
  });
});

describe("statsHistory", () => {
  it("1h: 60 stappen van 1 min, gaten als null, limieten erbij", async () => {
    const vals = [0, 1, 2, 10].map((i) => ({ serverId, resolution: MINUTE, bucket: min(i), samples: 1, cpuPct: 20 + i, cpuMaxPct: 20 + i, memoryBytes: 10 * MB, memoryMaxBytes: 10 * MB, diskBytes: 7, rxBytesPerSec: 3, txBytesPerSec: 4 }));
    await getDb().insert(schema.serverStats).values(vals);
    const hist = await statsHistory(serverId, "1h", { cpuLimitPct: 200, memoryLimitBytes: 1024 * MB, diskLimitBytes: 2048 * MB }, new Date(T0 + 10 * 60_000 + 30_000));
    expect(hist.points).toHaveLength(60);
    expect(hist.stepSeconds).toBe(60);
    expect(hist.to.getTime()).toBe(T0 + 11 * 60_000);
    const last = hist.points.at(-1)!;
    expect(last).toMatchObject({ t: min(10), cpuPct: 30, memoryBytes: 10 * MB, diskBytes: 7, rxBytesPerSec: 3, txBytesPerSec: 4 });
    expect(hist.points.at(-2)!.cpuPct).toBeNull();
    expect(hist.points.filter((p) => p.cpuPct !== null)).toHaveLength(4);
    expect(hist).toMatchObject({ cpuLimitPct: 200, memoryLimitBytes: 1024 * MB });
  });

  it("24h: 288 stappen van 5 min uit de 1-min-rijen (gemiddelde en piek)", async () => {
    const vals = [0, 1, 2, 3, 4].map((i) => ({ serverId, resolution: MINUTE, bucket: min(i), samples: 1, cpuPct: i * 10, cpuMaxPct: i * 10, memoryBytes: MB, memoryMaxBytes: MB, diskBytes: i }));
    await getDb().insert(schema.serverStats).values(vals);
    const hist = await statsHistory(serverId, "24h", { cpuLimitPct: 0, memoryLimitBytes: 0, diskLimitBytes: 0 }, min(6));
    expect(hist.points).toHaveLength(288);
    const p = hist.points.find((x) => x.t.getTime() === T0)!;
    expect(p).toMatchObject({ cpuPct: 20, cpuMaxPct: 40, diskBytes: 4, rxBytesPerSec: null });
  });

  it("7d en 30d lezen de samengevatte rijen", async () => {
    await getDb().insert(schema.serverStats).values([
      { serverId, resolution: QUARTER, bucket: min(0), samples: 15, cpuPct: 10, cpuMaxPct: 50, memoryBytes: MB, memoryMaxBytes: 2 * MB, diskBytes: 1 },
      { serverId, resolution: HOUR, bucket: min(0), samples: 60, cpuPct: 30, cpuMaxPct: 90, memoryBytes: MB, memoryMaxBytes: 2 * MB, diskBytes: 1 },
    ]);
    const w = await statsHistory(serverId, "7d", { cpuLimitPct: 0, memoryLimitBytes: 0, diskLimitBytes: 0 }, min(5));
    expect(w.points).toHaveLength(336);
    expect(w.points.find((x) => x.cpuPct !== null)).toMatchObject({ t: min(0), cpuPct: 10, cpuMaxPct: 50 });
    const m = await statsHistory(serverId, "30d", { cpuLimitPct: 0, memoryLimitBytes: 0, diskLimitBytes: 0 }, min(5));
    expect(m.points).toHaveLength(360);
    expect(m.points.find((x) => x.cpuPct !== null)).toMatchObject({ cpuPct: 30, cpuMaxPct: 90 });
  });
});

describe("tRPC-rechten", () => {
  it("statsHistory: eigenaar, admin en subuser met console.read; anderen FORBIDDEN", async () => {
    await collectStats(new Date(), async () => [stat(uuid)]);
    const own = await player.api.servers.statsHistory({ uuid, range: "1h" });
    expect(own.points.filter((p) => p.cpuPct === 10)).toHaveLength(1);
    expect(own.memoryLimitBytes).toBe(1024 * MB);
    await expect(sub.api.servers.statsHistory({ uuid, range: "24h" })).resolves.toMatchObject({ range: "24h" });
    await expect(admin.api.servers.statsHistory({ uuid, range: "7d" })).resolves.toMatchObject({ range: "7d" });
    await expect(subNone.api.servers.statsHistory({ uuid, range: "1h" })).rejects.toThrow(/MISSING_PERMISSION: console.read/);
    await expect(stranger.api.servers.statsHistory({ uuid, range: "1h" })).rejects.toThrow(/NO_ACCESS/);
    await expect(player.api.servers.statsHistory({ uuid: "00000000-0000-4000-8000-000000000000", range: "1h" })).rejects.toThrow(/SERVER_NOT_FOUND/);
    await expect(player.api.servers.statsHistory({ uuid, range: "2h" as never })).rejects.toThrow();
  });

  it("statsSparklines: alleen servers met console.read, 60 punten, één aanroep voor alles", async () => {
    await collectStats(new Date(), async () => [stat(uuid, { cpu_pct: 33 }), stat(uuid2, { cpu_pct: 44 })]);
    const own = await player.api.servers.statsSparklines({ uuids: [uuid, uuid2] });
    expect(Object.keys(own).sort()).toEqual([uuid, uuid2].sort());
    expect(own[uuid]!.cpuPct).toHaveLength(60);
    expect(own[uuid]!.cpuPct.at(-1)).toBe(33);
    expect(own[uuid2]!.memoryBytes.at(-1)).toBe(100 * MB);
    expect(Object.keys(await sub.api.servers.statsSparklines({ uuids: [uuid, uuid2] }))).toEqual([uuid]);
    expect(await subNone.api.servers.statsSparklines({ uuids: [uuid] })).toEqual({});
    expect(await stranger.api.servers.statsSparklines({ uuids: [uuid, uuid2] })).toEqual({});
    expect(Object.keys(await admin.api.servers.statsSparklines({ uuids: [uuid, uuid2] })).sort()).toEqual([uuid, uuid2].sort());
    expect(await player.api.servers.statsSparklines({ uuids: [] })).toEqual({});
  });

  it("verwijderde server: geschiedenis gaat mee (cascade)", async () => {
    await collectStats(new Date(), async () => [stat(uuid2)]);
    expect(await rows(MINUTE, serverId2)).toHaveLength(1);
    await getDb().delete(schema.servers).where(eq(schema.servers.id, serverId2));
    expect(await rows(MINUTE, serverId2)).toHaveLength(0);
  });
});
