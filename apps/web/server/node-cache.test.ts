import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { applyServerState, cfg, getNodeLive, MemoryStore, monitorNodesTick, pollAllNow, RedisStore, resetNodeCache, resolveStatus, setFetcher, type NodeLive } from "./node-cache";
import { startRedis } from "./test/docker-redis";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser;
let uuid = "";
const UUID_X = "11111111-1111-4111-8111-111111111111";

const live = (over: Partial<NodeLive> = {}): NodeLive => ({ nodeId: 1, checkedAt: 1000, lastSeenAt: 1000, online: true, error: null, system: null, servers: {}, ...over });

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "230000000000000001", name: "Speler" });
  const created = await admin.api.admin.servers.create({
    name: "SMP", ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 1024 }, allocationIds: [await h.allocation(25570)], variables: {}, startOnInstall: false,
  });
  uuid = created.uuid;
});

afterEach(() => {
  setFetcher(null);
  resetNodeCache(new MemoryStore());
  delete process.env.NODE_POLL_INTERVAL_MS;
  delete process.env.NODE_STALE_AFTER_MS;
});

describe("resolveStatus: versheid van de cache", () => {
  it("geen cache -> DB-status; vers -> cachewaarde; ouder dan de drempel -> unknown met lastSeenAt", () => {
    expect(resolveStatus(null, UUID_X, "offline", 5000)).toMatchObject({ status: "offline", lastSeenAt: null });
    const l = live({ servers: { [UUID_X]: { state: "online", installedAt: null, diskBytes: null } } });
    expect(resolveStatus(l, UUID_X, "offline", 1000 + cfg.staleAfterMs).status).toBe("online");
    const old = resolveStatus(l, UUID_X, "offline", 1001 + cfg.staleAfterMs);
    expect(old.status).toBe("unknown");
    expect(old.lastSeenAt).toEqual(new Date(1000));
    // server staat niet in de lijst van de daemon: DB-status
    expect(resolveStatus(l, "22222222-2222-4222-8222-222222222222", "offline", 2000).status).toBe("offline");
    // nooit bereikt
    expect(resolveStatus(live({ lastSeenAt: null, online: false }), UUID_X, "online", 2000)).toMatchObject({ status: "unknown", lastSeenAt: null });
  });
});

describe("lease", () => {
  it("MemoryStore: één eigenaar tegelijk, verlengen mag, na afloop neemt een ander over", async () => {
    let t = 0;
    const s = new MemoryStore(() => t);
    expect(await s.lease("a", 100)).toBe(true);
    expect(await s.lease("b", 100)).toBe(false);
    t = 50;
    expect(await s.lease("a", 100)).toBe(true); // verlengd tot 150
    t = 120;
    expect(await s.lease("b", 100)).toBe(false);
    t = 151;
    expect(await s.lease("b", 100)).toBe(true);
    expect(await s.lease("a", 100)).toBe(false);
  });

  it("RedisStore: atomaire lease en gedeelde cache tussen twee 'processen'", async () => {
    const redis = await startRedis();
    const r1 = new Redis(redis.url);
    const r2 = new Redis(redis.url);
    try {
      const a = new RedisStore(r1, "t:a");
      const b = new RedisStore(r2, "t:a");
      expect(await a.lease("p1", 400)).toBe(true);
      expect(await b.lease("p2", 400)).toBe(false);
      expect(await a.lease("p1", 400)).toBe(true);
      await a.set(7, live({ nodeId: 7 }));
      expect(await b.get(7)).toMatchObject({ nodeId: 7, online: true });
      await new Promise((r) => setTimeout(r, 500));
      expect(await b.lease("p2", 400)).toBe(true);
      expect(await a.lease("p1", 400)).toBe(false);
    } finally {
      r1.disconnect();
      r2.disconnect();
      await redis.stop();
    }
  });

  it("niet-leider pollt niet maar leest wat de leider in de gedeelde opslag zette", async () => {
    const store = new MemoryStore();
    await store.lease("andere-proces", 60_000);
    await store.set(h.localNodeId, live({ nodeId: h.localNodeId, checkedAt: Date.now(), lastSeenAt: Date.now(), servers: { [uuid]: { state: "online", installedAt: null, diskBytes: null } } }));
    resetNodeCache(store, "dit-proces");
    h.daemon.requests.length = 0;
    const r = await monitorNodesTick();
    expect(r).toEqual({ leader: false, polled: [] });
    expect(h.daemon.requests).toHaveLength(0);
    expect((await player.api.servers.list())[0]!.status).toBe("online");
  });
});

describe("monitor: poll en backoff", () => {
  it("onbereikbare node: backoff verdubbelt tot het maximum; herstel zet het interval terug", async () => {
    process.env.NODE_POLL_INTERVAL_MS = "1000";
    process.env.NODE_POLL_MAX_BACKOFF_MS = "4000";
    let fail = true;
    let calls = 0;
    setFetcher({
      system: async () => {
        calls++;
        if (fail) throw new Error("connect refused");
        return { version: "v", disk_quota_mode: "soft", cpu_count: 1, memory_total_bytes: 1, memory_used_bytes: 0, disk_total_bytes: 1, disk_free_bytes: 1 } as never;
      },
      servers: async () => [],
    });
    resetNodeCache(new MemoryStore());
    const t0 = Date.now();
    const polled = async (dt: number) => (await monitorNodesTick(t0 + dt)).polled.length;
    expect(await polled(0)).toBe(1); // mislukt, volgende na 2 s
    expect(await polled(1000)).toBe(0);
    expect(await polled(2000)).toBe(1); // mislukt, volgende na 4 s
    expect(await polled(5000)).toBe(0);
    expect(await polled(6000)).toBe(1); // mislukt, maximum 4 s
    expect(await polled(10_000)).toBe(1);
    const down = await getNodeLive(h.localNodeId);
    expect(down).toMatchObject({ online: false, lastSeenAt: null, error: "connect refused" });
    fail = false;
    expect(await polled(14_000)).toBe(1);
    expect(await polled(14_500)).toBe(0);
    expect(await polled(15_000)).toBe(1); // weer het gewone interval
    expect((await getNodeLive(h.localNodeId))).toMatchObject({ online: true, error: null });
    expect(calls).toBe(6);
    delete process.env.NODE_POLL_MAX_BACKOFF_MS;
  });

  it("mislukte poll bewaart de laatst bekende servers en lastSeenAt", async () => {
    h.daemon.servers.get(uuid)!.state = "online";
    await pollAllNow(1000);
    h.daemon.mode = "error500";
    await pollAllNow(2000);
    h.daemon.mode = "ok";
    const l = (await getNodeLive(h.localNodeId))!;
    expect(l).toMatchObject({ online: false, lastSeenAt: 1000, checkedAt: 2000 });
    expect(l.servers[uuid]!.state).toBe("online");
    expect(resolveStatus(l, uuid, "offline", 2000).status).toBe("online");
  });

  it("poll schrijft veranderde status terug naar de database", async () => {
    h.daemon.servers.get(uuid)!.state = "offline";
    await pollAllNow();
    const rows = await getDb().select({ s: schema.servers.status }).from(schema.servers);
    expect(rows.map((r) => r.s)).toContain("offline");
  });
});

describe("push-updates en geen daemon in het leespad", () => {
  it("applyServerState is direct zichtbaar in list/get, zonder daemon-verkeer", async () => {
    h.daemon.servers.get(uuid)!.state = "offline";
    await pollAllNow();
    await applyServerState(h.localNodeId, uuid, "starting");
    h.daemon.mode = "hang";
    h.daemon.requests.length = 0;
    try {
      const t = Date.now();
      expect((await player.api.servers.list())[0]!.status).toBe("starting");
      expect((await player.api.servers.get({ uuid })).status).toBe("starting");
      expect((await admin.api.admin.servers.list({ limit: 10 })).items[0]!.status).toBe("starting");
      const d = await admin.api.admin.dashboard();
      expect(d.nodes[0]!.online).toBe(true);
      expect((await admin.api.admin.nodes.get({ id: h.localNodeId })).health.online).toBe(true);
      expect(Date.now() - t).toBeLessThan(1000);
      expect(h.daemon.requests).toHaveLength(0);
    } finally {
      h.daemon.mode = "ok";
    }
  });

  it("power zet de cache meteen op starting/stopping", async () => {
    h.daemon.servers.get(uuid)!.state = "offline";
    await pollAllNow();
    await player.api.servers.power({ uuid, action: "start" });
    expect((await player.api.servers.get({ uuid })).status).toBe("starting");
    await player.api.servers.power({ uuid, action: "stop" });
    expect((await player.api.servers.list())[0]!.status).toBe("stopping");
  });
});

afterAll(() => resetNodeCache());
