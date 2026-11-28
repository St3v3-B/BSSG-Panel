import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYER_EVENT_PRESETS, parseTemplate } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as players } from "@/app/api/remote/servers/[uuid]/players/route";
import { POST as status } from "@/app/api/remote/servers/[uuid]/status/route";
import { getDb, schema } from "./db";
import { activityTiming, closeStaleSessions, heatmap, playersOverview, reconcileWithPing, syncPlayerEventSpecs, timeline } from "./player-activity";
import { runRetention } from "./retention";
import { upsertTemplate } from "./templates";
import { GAME_TEMPLATE, OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser, viewer: TestUser, helper: TestUser, stranger: TestUser;
let mc = "", plain = "";
let mcId = 0;

const MC = GAME_TEMPLATE.replace("slug: testgame", "slug: testmc").replace("name: Testspel", "name: Test-MC\nplayer_events: minecraft");

const req = (path: string, body: unknown, token: string | null = h.env.NODE_TOKEN!) =>
  new Request(`http://panel.test${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const post = (events: unknown[], uuid = mc, token?: string | null) => players(req(`/api/remote/servers/${uuid}/players`, { events }, token), params({ uuid }));
const setStatus = (state: string, uuid = mc) => status(req(`/api/remote/servers/${uuid}/status`, { state }), params({ uuid }));
const S = schema.playerSessions;
const sessions = async () => (await getDb().select().from(S).where(eq(S.serverId, mcId))).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id - b.id);
const t0 = () => new Date(Date.now() - 3600_000);
const at = (base: Date, s: number) => new Date(base.getTime() + s * 1000).toISOString();

beforeAll(async () => {
  const p = parseTemplate(MC);
  if (!p.ok) throw new Error(p.errors.join("; "));
  await upsertTemplate(p.spec, MC);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "291000000000000001", name: "speler" });
  viewer = await h.user({ discordId: "291000000000000002", name: "kijker" });
  helper = await h.user({ discordId: "291000000000000003", name: "helper" });
  stranger = await h.user({ discordId: "291000000000000004", name: "vreemd" });
  const mk = async (slug: string, port: number) =>
    (await admin.api.admin.servers.create({
      name: slug, ownerId: player.id, nodeId: h.localNodeId, templateId: await h.templateId(slug),
      limits: { cpuPct: 100, ramMb: 1024, swapMb: 0, diskMb: 2048 }, allocationIds: [await h.allocation(port)], variables: {}, startOnInstall: false,
    })).uuid;
  mc = await mk("testmc", 25700);
  plain = await mk("testgame", 25701);
  mcId = (await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, mc)))[0]!.id;
  await player.api.subusers.invite({ uuid: mc, who: viewer.discordId, permissions: ["players.read"] });
  await player.api.subusers.invite({ uuid: mc, who: helper.discordId, permissions: ["console.read", "power"] });
});

beforeEach(async () => {
  await getDb().delete(S);
  await getDb().delete(schema.serverEvents);
  await getDb().update(schema.servers).set({ status: "online" }).where(eq(schema.servers.id, mcId));
});

describe("template en spec", () => {
  it("player_events: preset in de spec voor Minecraft, niet voor andere templates", () => {
    expect(h.daemon.servers.get(mc)!.spec.player_events).toEqual(PLAYER_EVENT_PRESETS.minecraft);
    expect(h.daemon.servers.get(plain)!.spec.player_events).toBeUndefined();
  });

  it("templateschema: eigen patronen, groep name verplicht, ongeldige regex geweigerd", () => {
    const mk = (pe: string) => parseTemplate(GAME_TEMPLATE.replace("name: Testspel", () => `name: X\nplayer_events: ${pe}`));
    expect(mk(`{ join: '^(?<name>\\w+) joined$', leave: '^(?<name>\\w+) left$' }`).ok).toBe(true);
    expect(mk(`{ join: '^(\\w+) joined$', leave: '^(?<name>\\w+) left$' }`).ok).toBe(false);
    expect(mk(`{ join: '(', leave: '^(?<name>\\w+) left$' }`).ok).toBe(false);
    expect(mk("bogus").ok).toBe(false);
    expect(mk("none").ok).toBe(true);
  });

  it("presets zijn gelijk aan de patronen in de Go-parsertest", () => {
    const go = readFileSync(join(__dirname, "../../../daemon/internal/server/playerevents_test.go"), "utf8");
    for (const p of [PLAYER_EVENT_PRESETS.minecraft.join, PLAYER_EVENT_PRESETS.minecraft.leave, PLAYER_EVENT_PRESETS.minecraft.uuid, PLAYER_EVENT_PRESETS.velocity.join, PLAYER_EVENT_PRESETS.velocity.leave]) {
      expect(go).toContain("`" + p + "`");
    }
  });

  it("bestaande servers krijgen eenmalig de spec met player_events", async () => {
    const before = h.daemon.requests.filter((c) => c.method === "PUT" && c.path === `/api/servers/${mc}`).length;
    await getDb().update(schema.servers).set({ installedAt: new Date() }).where(eq(schema.servers.id, mcId));
    expect(await syncPlayerEventSpecs()).toBe(true);
    const puts = h.daemon.requests.filter((c) => c.method === "PUT" && c.path === `/api/servers/${mc}`);
    expect(puts.length).toBe(before + 1);
    expect((puts.at(-1)!.body as { player_events: unknown }).player_events).toEqual(PLAYER_EVENT_PRESETS.minecraft);
    expect(h.daemon.requests.some((c) => c.method === "PUT" && c.path === `/api/servers/${plain}`)).toBe(false);
    expect(await syncPlayerEventSpecs()).toBe(true);
    expect(h.daemon.requests.filter((c) => c.method === "PUT" && c.path === `/api/servers/${mc}`).length).toBe(before + 1);
  });
});

describe("remote /players", () => {
  it("auth met node-token, 404 voor onbekende server, 400 bij rommel", async () => {
    expect((await post([], mc, null)).status).toBe(401);
    expect((await post([], mc, "fout")).status).toBe(401);
    const other = "0b7c2d1e-1111-4222-8333-444455556666";
    expect((await post([], other)).status).toBe(404);
    expect((await post([{ type: "dance", at: new Date().toISOString() }])).status).toBe(400);
    expect((await post([{ type: "join", at: "gisteren", name: "Steve" }])).status).toBe(400);
    expect((await post(Array.from({ length: 101 }, () => ({ type: "join", at: new Date().toISOString(), name: "Steve" })))).status).toBe(400);
  });

  it("join/leave: sessies openen en sluiten, dubbele events idempotent", async () => {
    const b = t0();
    const joins = [
      { type: "join", at: at(b, 0), name: "Steve", player_uuid: "069A79F444E94726A5BEFCA90E38AAF5" },
      { type: "join", at: at(b, 5), name: "Alex" },
      { type: "join", at: at(b, 6), name: "steve" }, // al online (naam hoofdletterongevoelig)
    ];
    expect((await post(joins)).status).toBe(204);
    expect((await post(joins)).status).toBe(204); // retry van dezelfde batch
    let s = await sessions();
    expect(s.map((x) => [x.name, x.playerUuid, x.leftAt])).toEqual([["Steve", "069a79f4-44e9-4726-a5be-fca90e38aaf5", null], ["Alex", null, null]]);
    await post([{ type: "leave", at: at(b, 60), name: "Alex", reason: "leave" }, { type: "leave", at: at(b, 61), name: "Nobody" }]);
    // retry van join+leave: geen nieuwe open sessie voor Alex
    await post([{ type: "join", at: at(b, 5), name: "Alex" }, { type: "leave", at: at(b, 60), name: "Alex", reason: "leave" }]);
    s = await sessions();
    expect(s).toHaveLength(2);
    const alex = s.find((x) => x.name === "Alex")!;
    expect([alex.leftAt?.toISOString(), alex.endReason]).toEqual([at(b, 60), "leave"]);
    // Alex komt terug: nieuwe sessie
    await post([{ type: "join", at: at(b, 120), name: "Alex" }]);
    expect((await sessions()).filter((x) => !x.leftAt).map((x) => x.name).sort()).toEqual(["Alex", "Steve"]);
  });

  it("stopped (crash) sluit alle open sessies; leave tijdens stoppen krijgt server_stop", async () => {
    const b = t0();
    await post([
      { type: "join", at: at(b, 0), name: "Steve" },
      { type: "join", at: at(b, 1), name: "Alex" },
      { type: "leave", at: at(b, 100), name: "Alex", reason: "server_stop" },
      { type: "stopped", at: at(b, 101), reason: "crash" },
    ]);
    const s = await sessions();
    expect(s.map((x) => [x.name, x.endReason, x.leftAt?.toISOString()])).toEqual([["Steve", "crash", at(b, 101)], ["Alex", "server_stop", at(b, 100)]]);
  });

  it("stopped (sleep) en tijden in de toekomst worden begrensd", async () => {
    await post([{ type: "join", at: new Date(Date.now() + 3600_000).toISOString(), name: "Steve" }]);
    const [s] = await sessions();
    expect(s!.joinedAt.getTime()).toBeLessThanOrEqual(Date.now());
    await post([{ type: "stopped", at: new Date().toISOString(), reason: "sleep" }]);
    expect((await sessions())[0]!.endReason).toBe("sleep");
  });
});

describe("servergebeurtenissen en vangnet", () => {
  const kinds = async () => (await getDb().select().from(schema.serverEvents).where(eq(schema.serverEvents.serverId, mcId))).sort((a, b) => a.id - b.id).map((e) => e.kind);

  it("statusovergangen: start, stop, sleep, wake", async () => {
    await getDb().update(schema.servers).set({ status: "offline" }).where(eq(schema.servers.id, mcId));
    for (const st of ["starting", "online", "stopping", "offline", "starting", "online", "sleeping", "starting", "online", "offline"]) expect((await setStatus(st)).status).toBe(204);
    expect(await kinds()).toEqual(["start", "stop", "start", "sleep", "wake", "stop"]);
  });

  it("closeStaleSessions: na de wachttijd dicht op het tijdstip van de stop, crash uit het activiteitenlog", async () => {
    const b = new Date(Date.now() - 600_000);
    await post([{ type: "join", at: at(b, 0), name: "Steve" }]);
    await setStatus("offline"); // stop-event nu: nog binnen de wachttijd
    expect(await closeStaleSessions()).toBe(0);
    const stopAt = new Date(Date.now() - 120_000);
    await getDb().update(schema.serverEvents).set({ at: stopAt }).where(eq(schema.serverEvents.serverId, mcId));
    await getDb().insert(schema.activityLog).values({ action: "server.crashed", serverId: mcId, at: new Date(stopAt.getTime() + 2000) });
    expect(await closeStaleSessions()).toBe(1);
    const [s] = await sessions();
    expect([s!.endReason, s!.leftAt?.getTime()]).toEqual(["crash", stopAt.getTime()]);
    await getDb().delete(schema.activityLog).where(and(eq(schema.activityLog.serverId, mcId), eq(schema.activityLog.action, "server.crashed")));
  });

  it("closeStaleSessions: zonder stop-event (daemon was weg) sluit met unknown; draaiende server blijft open", async () => {
    await post([{ type: "join", at: at(t0(), 0), name: "Steve" }]);
    expect(await closeStaleSessions()).toBe(0); // status online
    await getDb().update(schema.servers).set({ status: "offline" }).where(eq(schema.servers.id, mcId));
    expect(await closeStaleSessions()).toBe(1);
    expect((await sessions())[0]!.endReason).toBe("unknown");
  });

  it("reconcileWithPing: opent ontbrekende sessies, sluit vertrokken spelers alleen bij een complete ping", async () => {
    await post([{ type: "join", at: at(t0(), 0), name: "Steve" }, { type: "join", at: at(t0(), 1), name: "Alex" }]);
    // incompleet (3 online, 2 genoemd): alleen openen
    let r = await reconcileWithPing(mcId, { online: 3, sample: [{ name: "Steve", id: "069a79f4-44e9-4726-a5be-fca90e38aaf5" }, { name: "Builder_99", id: "61699b2e-d327-4a01-9f1e-0ea8c3f06bc6" }] });
    expect(r).toEqual({ opened: 1, closed: 0 });
    // compleet: Alex is weg
    r = await reconcileWithPing(mcId, { online: 2, sample: [{ name: "Steve", id: "069a79f4-44e9-4726-a5be-fca90e38aaf5" }, { name: "Builder_99", id: "61699b2e-d327-4a01-9f1e-0ea8c3f06bc6" }] });
    expect(r).toEqual({ opened: 0, closed: 1 });
    expect((await sessions()).find((x) => x.name === "Alex")!.endReason).toBe("unknown");
    // wie net vertrok wordt niet heropend door een oude ping; anonieme spelers tellen niet
    r = await reconcileWithPing(mcId, { online: 3, sample: [{ name: "Alex", id: "00000000-0000-0000-0000-000000000000" }] });
    expect(r).toEqual({ opened: 0, closed: 0 });
    await post([{ type: "leave", at: new Date().toISOString(), name: "Builder_99" }]);
    r = await reconcileWithPing(mcId, { online: 1, sample: [{ name: "Steve", id: "x" }, { name: "Builder_99", id: "61699b2e-d327-4a01-9f1e-0ea8c3f06bc6" }] });
    expect(r.opened).toBe(0);
    expect(await reconcileWithPing(mcId, null)).toEqual({ opened: 0, closed: 0 });
  });
});

describe("aggregaties", () => {
  // Vaste week: maandag 2026-11-16 00:00 Amsterdam = 2026-11-15T23:00Z
  const MON = new Date("2026-11-15T23:00:00Z");
  const now = new Date("2026-11-22T23:00:00Z"); // precies een week later (maandag 00:00)
  const H = 3600_000;
  const ins = (name: string, fromH: number, toH: number | null, reason = "leave") =>
    getDb().insert(S).values({ serverId: mcId, name, joinedAt: new Date(MON.getTime() + fromH * H), leftAt: toH === null ? null : new Date(MON.getTime() + toH * H), endReason: toH === null ? null : reason });

  it("players: speeltijd, sessies, laatst gezien, online eerst", async () => {
    await ins("Steve", 20, 22); // ma 20-22
    await ins("Steve", 44, 45); // di 20-21
    await ins("Alex", 20.5, 21);
    await ins("Old", -200, -199); // buiten het venster
    const p = await playersOverview(mcId, 7, now);
    expect(p.map((x) => [x.name, x.sessions, x.totalSeconds])).toEqual([["Steve", 2, 3 * 3600], ["Alex", 1, 1800]]);
    expect(p[0]!.lastSeen.toISOString()).toBe(new Date(MON.getTime() + 45 * H).toISOString());
    await ins("Live", 160, null);
    const q = await playersOverview(mcId, 7, now);
    expect(q[0]).toMatchObject({ name: "Live", online: true, totalSeconds: 8 * 3600 });
  });

  it("heatmap: gemiddeld aantal spelers per weekdag × uur in Amsterdamse tijd", async () => {
    await ins("Steve", 20, 22);
    await ins("Alex", 20.5, 21);
    const m = await heatmap(mcId, 7, now);
    expect(m.cells).toHaveLength(7);
    expect(m.cells[0]![20]).toBe(1.5); // ma 20:00: Steve heel uur + Alex half
    expect(m.cells[0]![21]).toBe(1);
    expect(m.cells[1]![20]).toBe(0);
    expect(m.max).toBe(1.5);
    // over twee weken gemiddeld: de helft
    expect((await heatmap(mcId, 14, now)).cells[0]![20]).toBe(0.75);
  });

  it("timeline: sessies in het venster, crash uit het activiteitenlog, stop rond een crash weggelaten", async () => {
    await ins("Steve", 140, 150);
    await ins("Alex", 100, 101);
    await ins("Ancient", 10, 11);
    const crashAt = new Date(MON.getTime() + 150 * H);
    await getDb().insert(schema.serverEvents).values([
      { serverId: mcId, kind: "start", at: new Date(MON.getTime() + 145 * H) },
      { serverId: mcId, kind: "stop", at: new Date(crashAt.getTime() + 1000) },
      { serverId: mcId, kind: "sleep", at: new Date(MON.getTime() + 160 * H) },
    ]);
    const [log] = await getDb().insert(schema.activityLog).values({ action: "server.crashed", serverId: mcId, at: crashAt }).returning();
    const t = await timeline(mcId, "day", now, new Date(now.getTime() + 1000));
    expect(t.from.toISOString()).toBe(new Date(now.getTime() - 24 * H).toISOString());
    expect(t.sessions.map((s) => s.name)).toEqual(["Steve"]);
    expect(t.events.map((e) => e.kind)).toEqual(["start", "crash", "sleep"]);
    const w = await timeline(mcId, "week", now, new Date(now.getTime() + 1000));
    expect(w.sessions.map((s) => s.name)).toEqual(["Ancient", "Alex", "Steve"]);
    await getDb().delete(schema.activityLog).where(eq(schema.activityLog.id, log!.id));
  });
});

describe("procedures en rechten", () => {
  it("eigenaar en subuser met players.read mogen; zonder recht FORBIDDEN, vreemde geen toegang", async () => {
    await post([{ type: "join", at: at(t0(), 0), name: "Steve" }]);
    for (const u of [player, viewer]) {
      expect((await u.api.playerActivity.current({ uuid: mc })).sessions.map((s) => s.name)).toEqual(["Steve"]);
      const tl = await u.api.playerActivity.timeline({ uuid: mc, range: "day" });
      expect(tl.tracked).toBe(true);
      expect(tl.sessions).toHaveLength(1);
      expect((await u.api.playerActivity.players({ uuid: mc })).players[0]).toMatchObject({ name: "Steve", online: true, sessions: 1 });
      expect((await u.api.playerActivity.heatmap({ uuid: mc })).cells).toHaveLength(7);
    }
    await expect(helper.api.playerActivity.timeline({ uuid: mc, range: "week" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(helper.api.playerActivity.current({ uuid: mc })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.api.playerActivity.players({ uuid: mc })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect(stranger.api.playerActivity.heatmap({ uuid: mc })).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_FOUND/) });
    await expect((await h.anon()).playerActivity.current({ uuid: mc })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("server zonder player_events: tracked false en leeg", async () => {
    const r = await player.api.playerActivity.timeline({ uuid: plain, range: "day" });
    expect([r.tracked, r.sessions, r.events]).toEqual([false, [], []]);
    expect(await player.api.playerActivity.current({ uuid: plain })).toEqual({ tracked: false, sessions: [] });
    expect((await player.api.playerActivity.players({ uuid: plain })).tracked).toBe(false);
    expect((await player.api.playerActivity.heatmap({ uuid: plain })).max).toBe(0);
  });
});

describe("retention", () => {
  it("verwijdert afgesloten sessies en servergebeurtenissen ouder dan 90 dagen", async () => {
    const old = new Date(Date.now() - 91 * 24 * 3600_000);
    const fresh = new Date(Date.now() - 89 * 24 * 3600_000);
    await getDb().insert(S).values([
      { serverId: mcId, name: "Old", joinedAt: old, leftAt: old, endReason: "leave" },
      { serverId: mcId, name: "Fresh", joinedAt: fresh, leftAt: fresh, endReason: "leave" },
      { serverId: mcId, name: "Open", joinedAt: old, leftAt: null },
    ]);
    await getDb().insert(schema.serverEvents).values([{ serverId: mcId, kind: "start", at: old }, { serverId: mcId, kind: "stop", at: fresh }]);
    const r = await runRetention();
    expect(r.playerSessions).toBeGreaterThanOrEqual(1);
    expect(r.serverEvents).toBeGreaterThanOrEqual(1);
    expect((await sessions()).map((s) => s.name).sort()).toEqual(["Fresh", "Open"]);
    expect((await getDb().select().from(schema.serverEvents).where(eq(schema.serverEvents.serverId, mcId))).map((e) => e.kind)).toEqual(["stop"]);
  });
});

void activityTiming;
