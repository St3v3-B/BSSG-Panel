import { POST as event } from "@/app/api/remote/servers/[uuid]/event/route";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decide, evaluateAlarms } from "./alarms";
import { getDb, schema } from "./db";
import { delivery, flushNotify, resetNotify } from "./notify";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, stranger: TestUser;
let uuid = "";
let serverId = 0;
const MIN = 60_000;
/** Nep-klok: alles relatief aan een vast tijdstip (op een minuutgrens). */
const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);
const at = (minute: number) => new Date(T0 + minute * MIN);
const MIB = 1024 * 1024;

/** Eén 1-minuutmeting: CPU in "100 = één core", geheugen en disk in MiB. */
async function sample(minute: number, o: { cpu?: number; memMb?: number; diskMb?: number }) {
  const mem = (o.memMb ?? 100) * MIB;
  await getDb()
    .insert(schema.serverStats)
    .values({ serverId, resolution: 60, bucket: at(minute), samples: 1, cpuPct: o.cpu ?? 5, cpuMaxPct: o.cpu ?? 5, memoryBytes: mem, memoryMaxBytes: mem, diskBytes: (o.diskMb ?? 10) * MIB, rxBytesPerSec: null, txBytesPerSec: null })
    .onConflictDoUpdate({ target: [schema.serverStats.serverId, schema.serverStats.resolution, schema.serverStats.bucket], set: { cpuPct: o.cpu ?? 5, memoryBytes: mem, diskBytes: (o.diskMb ?? 10) * MIB } });
}
/** Meting voor minuten [from, to] en daarna evalueren op elke minuut, zoals de scheduler. */
async function run(from: number, to: number, o: Parameters<typeof sample>[1]) {
  let notified = 0;
  for (let m = from; m <= to; m++) {
    await sample(m, o);
    notified += (await evaluateAlarms(new Date(T0 + m * MIN + 5_000))).notified;
    // In het echt zitten er minuten tussen; het samenvoegvenster van notify() loopt op de echte klok.
    await flushNotify();
    resetNotify();
  }
  await flushNotify();
  return notified;
}
const alarmMsgs = async () => {
  await flushNotify();
  return (await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id))).filter((n) => n.event === "usage_alarm");
};

beforeAll(async () => {
  delivery.inline = true;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "292000000000000001", name: "speler" });
  stranger = await h.user({ discordId: "292000000000000002", name: "vreemde" });
  const s = await admin.api.admin.servers.create({
    name: "Alarm",
    ownerId: player.id,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 200, ramMb: 1000, swapMb: 0, diskMb: 1000 },
    allocationIds: [await h.allocation(35001)],
    variables: {},
    startOnInstall: false,
  });
  uuid = s.uuid;
  serverId = (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid)))[0]!.id;
});
beforeEach(async () => {
  resetNotify();
  const db = getDb();
  await db.delete(schema.serverStats);
  await db.delete(schema.serverAlarmState);
  await db.delete(schema.serverAlarms);
  await db.delete(schema.notifications);
  await db.delete(schema.settings).where(eq(schema.settings.key, "alarm_defaults"));
});

describe("decide (puur)", () => {
  const pts = (vals: number[], endMinute = 9) => vals.map((v, i) => ({ t: T0 + (endMinute - vals.length + 1 + i) * MIN, v }));
  const now = new Date(T0 + 9 * MIN + 5000);
  it("CPU/RAM: pas na N minuten boven de drempel; gaten tot 20% mogen", () => {
    expect(decide("cpu", 80, 5, pts([90, 90, 90, 90, 90]), now, false).kind).toBe("trigger");
    expect(decide("cpu", 80, 5, pts([90, 90, 90, 90]), now, false).kind).toBe("none"); // pas 4 minuten
    expect(decide("cpu", 80, 5, [...pts([90, 90], 6), ...pts([90, 90], 9)], now, false).kind).toBe("trigger"); // gat in het midden
    expect(decide("cpu", 80, 5, pts([90, 90, 90]), now, false).kind).toBe("none");
    expect(decide("cpu", 80, 5, pts([90, 90, 79, 90, 90]), now, false).kind).toBe("none");
    expect(decide("cpu", 80, 1, pts([81]), now, false).kind).toBe("trigger");
  });
  it("hysterese: actief blijft actief tussen drempel-10 en drempel; uit pas eronder", () => {
    expect(decide("ram", 80, 5, pts([75, 72, 71, 74, 75]), now, true).kind).toBe("update");
    expect(decide("ram", 80, 5, pts([65, 60, 69, 68, 69]), now, true).kind).toBe("resolve");
    // geen metingen meer (server gestopt): stil uit
    expect(decide("ram", 80, 5, [], now, true)).toEqual({ kind: "resolve", value: 0, quiet: true });
  });
  it("disk: laatste meting, hysterese 5", () => {
    expect(decide("disk", 90, 5, pts([91]), now, false).kind).toBe("trigger");
    expect(decide("disk", 90, 5, pts([87]), now, true).kind).toBe("update");
    expect(decide("disk", 90, 5, pts([84]), now, true).kind).toBe("resolve");
    expect(decide("disk", 90, 5, [], now, true).kind).toBe("none");
  });
});

describe("evaluateAlarms", () => {
  const own = (o: Partial<{ cpuPct: number | null; ramPct: number | null; diskPct: number | null; durationMinutes: number; enabled: boolean }> = {}) =>
    player.api.servers.updateAlarms({ uuid, notifyOffline: true, config: { enabled: true, cpuPct: 80, ramPct: null, diskPct: null, durationMinutes: 5, ...o } });

  it("CPU boven X% gedurende N minuten: één melding, geen herhaling zolang hij hoog blijft", async () => {
    await own();
    // 200% limiet, 170 = 85%: pas in minuut 4 (5 metingen) een melding.
    expect(await run(0, 3, { cpu: 170 })).toBe(0);
    expect(await run(4, 4, { cpu: 170 })).toBe(1);
    expect(await run(5, 20, { cpu: 190 })).toBe(0);
    const msgs = await alarmMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ title: "High cpu usage", level: "warning", link: `/servers/${uuid}/stats` });
    const a = await player.api.servers.alarms({ uuid });
    expect(a.active).toEqual([expect.objectContaining({ metric: "cpu", thresholdPct: 80, valuePct: 95 })]);
    expect(a.useDefaults).toBe(false);
    const list = await admin.api.admin.alarms.active();
    expect(list).toEqual([expect.objectContaining({ server: { uuid, name: "Alarm" }, metric: "cpu", owner: expect.objectContaining({ id: player.id }) })]);
  });

  it("hysterese en cooldown: schommelen rond de drempel spamt niet", async () => {
    await own();
    expect(await run(0, 4, { cpu: 170 })).toBe(1); // 85% → melding
    // Net onder de drempel (75%): blijft actief, geen "weer normaal".
    expect(await run(5, 15, { cpu: 150 })).toBe(0);
    expect((await player.api.servers.alarms({ uuid })).active).toHaveLength(1);
    // Ruim onder drempel - hysterese (60%): uit, met "weer normaal" (want de "te hoog" ging uit).
    expect(await run(16, 20, { cpu: 120 })).toBe(1);
    expect((await player.api.servers.alarms({ uuid })).active).toHaveLength(0);
    // Binnen de cooldown (60 min) opnieuw hoog: actief, maar geen melding (en dus ook geen "weer normaal").
    expect(await run(21, 25, { cpu: 170 })).toBe(0);
    expect((await player.api.servers.alarms({ uuid })).active).toHaveLength(1);
    expect(await run(26, 30, { cpu: 100 })).toBe(0);
    // Na de cooldown wel weer.
    expect(await run(70, 74, { cpu: 170 })).toBe(1);
    const msgs = await alarmMsgs();
    expect(msgs.map((m) => m.title)).toEqual(["High cpu usage", "Cpu usage back to normal", "High cpu usage"].map((t) => t.replace("Cpu", "CPU")));
  });

  it("RAM en disk; een gestopte server gaat stil uit", async () => {
    await own({ cpuPct: null, ramPct: 90, diskPct: 80, durationMinutes: 3 });
    expect(await run(0, 2, { memMb: 950, diskMb: 850 })).toBe(2); // disk meteen (minuut 0), RAM na 3 minuten
    const titles = (await alarmMsgs()).map((m) => m.title).sort();
    expect(titles).toEqual(["High disk usage", "High memory usage"]);
    // Geen metingen meer: RAM stil uit; disk houdt zijn toestand (gemeten bij de laatste start).
    for (let m = 3; m <= 15; m++) await evaluateAlarms(new Date(T0 + m * MIN + 5000));
    const active = (await player.api.servers.alarms({ uuid })).active.map((x) => x.metric);
    expect(active).toEqual(["disk"]);
    expect((await alarmMsgs())).toHaveLength(2);
  });

  it("standaard van de admin: uit = niets; aan = geldt voor servers zonder eigen instelling; eigen 'uit' wint", async () => {
    expect(await run(0, 12, { cpu: 199 })).toBe(0);
    await expect(player.api.admin.alarms.setDefaults({ enabled: true, cpuPct: 50, ramPct: null, diskPct: null, durationMinutes: 2, cooldownMinutes: 30 })).rejects.toThrow(/NOT_ADMIN/);
    const d = await admin.api.admin.alarms.setDefaults({ enabled: true, cpuPct: 50, ramPct: null, diskPct: null, durationMinutes: 2, cooldownMinutes: 30 });
    expect(d).toMatchObject({ enabled: true, cpuPct: 50, cooldownMinutes: 30 });
    expect(await admin.api.admin.alarms.defaults()).toEqual(d);
    const a = await player.api.servers.alarms({ uuid });
    expect(a).toMatchObject({ useDefaults: true, config: { enabled: true, cpuPct: 50, durationMinutes: 2 }, notifyOffline: true });
    expect(await run(13, 14, { cpu: 199 })).toBe(1);
    // Eigen instelling "uit": de actieve toestand verdwijnt stil.
    await own({ enabled: false });
    await run(15, 16, { cpu: 199 });
    expect((await player.api.servers.alarms({ uuid })).active).toEqual([]);
    expect(await admin.api.admin.alarms.active()).toEqual([]);
    // Terug naar de standaard.
    expect((await player.api.servers.updateAlarms({ uuid, config: null, notifyOffline: true })).useDefaults).toBe(true);
  });

  it("rechten: alleen eigenaar of admin; log", async () => {
    await expect(stranger.api.servers.alarms({ uuid })).rejects.toThrow(/NO_ACCESS/);
    await expect(stranger.api.servers.updateAlarms({ uuid, config: null, notifyOffline: false })).rejects.toThrow(/NO_ACCESS/);
    await expect(stranger.api.admin.alarms.active()).rejects.toThrow(/NOT_ADMIN/);
    const before = (await admin.api.admin.activity.search({ serverUuid: uuid, action: "server.alarms.update" })).items.length;
    await admin.api.servers.updateAlarms({ uuid, config: { enabled: true, cpuPct: 90, ramPct: 90, diskPct: 95, durationMinutes: 10 }, notifyOffline: true });
    const log = await admin.api.admin.activity.search({ serverUuid: uuid, action: "server.alarms.update" });
    expect(log.items).toHaveLength(before + 1);
    expect(log.items[0]!.user?.id).toBe(admin.id);
  });
});

describe("offline-alarm = de bestaande crashmelding", () => {
  const post = (path: string, body: unknown) => new Request(`http://panel.test${path}`, { method: "POST", headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const crash = { type: "crashed", exit_code: 1, oom: false, log_tail: [], restart: "disabled", restart_attempt: 0 };
  const crashes = async () => {
    await flushNotify();
    return (await getDb().select().from(schema.notifications).where(eq(schema.notifications.userId, player.id))).filter((n) => n.event === "server_crashed");
  };

  it("standaard aan (één melding, geen extra alarm); uit = geen crashmelding voor de eigenaar", async () => {
    expect((await event(post(`/api/remote/servers/${uuid}/event`, crash), { params: Promise.resolve({ uuid }) })).status).toBe(204);
    expect(await crashes()).toHaveLength(1);
    await getDb().delete(schema.notifications);
    resetNotify();
    const r = await player.api.servers.updateAlarms({ uuid, config: null, notifyOffline: false });
    expect(r.notifyOffline).toBe(false);
    expect(r.useDefaults).toBe(false); // de standaard is vastgelegd, want "offline uit" moet ergens staan
    expect((await event(post(`/api/remote/servers/${uuid}/event`, crash), { params: Promise.resolve({ uuid }) })).status).toBe(204);
    expect(await crashes()).toHaveLength(0);
    // de crash staat wel in het activiteitenlog
    const log = await admin.api.admin.activity.search({ serverUuid: uuid, action: "server.crashed" });
    expect(log.items.length).toBeGreaterThanOrEqual(2);
  });
});
