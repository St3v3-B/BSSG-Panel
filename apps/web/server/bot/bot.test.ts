import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "../db";
import { OWNER, useHarness, type TestUser } from "../test/harness";
import { resolveServer, runCommand, suggest } from "./commands";
import { DiscordBot, startBot, type WsLike } from "./gateway";

const h = useHarness();
let admin: TestUser, owner: TestUser, power: TestUser, reader: TestUser, none: TestUser, stranger: TestUser, blocked: TestUser;
let uuid = "";
let other = "";

const mk = async (name: string, ownerId: number, port: number) => {
  const d = await admin.api.admin.servers.create({
    name,
    ownerId,
    nodeId: h.localNodeId,
    templateId: await h.templateId("testgame"),
    limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 },
    allocationIds: [await h.allocation(port)],
    variables: {},
    startOnInstall: false,
  });
  return d.uuid;
};

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, admin: true, totp: true });
  owner = await h.user({ discordId: "270000000000000001", name: "eig" });
  power = await h.user({ discordId: "270000000000000002", name: "p" });
  reader = await h.user({ discordId: "270000000000000003", name: "r" });
  none = await h.user({ discordId: "270000000000000004", name: "n" });
  stranger = await h.user({ discordId: "270000000000000005", name: "s" });
  blocked = await h.user({ discordId: "270000000000000006", name: "b", blocked: true });
  uuid = await mk("Survival", owner.id, 25591);
  other = await mk("Skyblock", owner.id, 25592);
  for (const u of [uuid, other]) h.daemon.servers.get(u)!.state = "offline";
  const [srv] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  await getDb().insert(schema.subusers).values([
    { serverId: srv!.id, userId: power.id, permissions: ["power", "console.read"] },
    { serverId: srv!.id, userId: reader.id, permissions: ["console.read"] },
    { serverId: srv!.id, userId: none.id, permissions: [] },
  ]);
});

const powerCalls = () => h.daemon.requests.filter((r) => r.path.endsWith("/power"));
const text = (r: { content?: string; embeds?: unknown[] }) => r.content ?? JSON.stringify(r.embeds);

describe("rechten van de bot-commando's", () => {
  it("/servers toont eigen en gedeelde servers, vreemden niets", async () => {
    expect(text(await runCommand(owner.discordId, "servers"))).toMatch(/Survival[\s\S]*Skyblock|Skyblock[\s\S]*Survival/);
    const p = text(await runCommand(power.discordId, "servers"));
    expect(p).toContain("Survival");
    expect(p).not.toContain("Skyblock");
    expect(text(await runCommand(stranger.discordId, "servers"))).toBe("You have no servers.");
  });

  it("onbekend of geblokkeerd account", async () => {
    expect(text(await runCommand("999999999999999999", "servers"))).toContain("do not have a panel account");
    expect(text(await runCommand(blocked.discordId, "servers"))).toContain("blocked");
    h.daemon.requests.length = 0;
    expect(text(await runCommand(blocked.discordId, "start", "Survival"))).toContain("blocked");
    expect(powerCalls()).toHaveLength(0);
  });

  it("eigenaar en subuser met power mogen starten/stoppen/herstarten", async () => {
    h.daemon.requests.length = 0;
    expect(text(await runCommand(owner.discordId, "start", "survival"))).toContain("Starting **Survival**");
    expect(text(await runCommand(power.discordId, "restart", "Survival"))).toContain("Restarting");
    expect(text(await runCommand(power.discordId, "stop", "Surv"))).toContain("Stopping");
    expect(powerCalls().map((r) => (r.body as { action: string }).action)).toEqual(["start", "restart", "stop"]);
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "bot.command"));
    expect(log.length).toBeGreaterThanOrEqual(3);
  });

  it("zonder power-recht, zonder toegang of zonder rechten geen actie", async () => {
    h.daemon.requests.length = 0;
    expect(text(await runCommand(reader.discordId, "start", "Survival"))).toContain("permission");
    expect(text(await runCommand(none.discordId, "stop", "Survival"))).toContain("permission");
    expect(text(await runCommand(stranger.discordId, "restart", "Survival"))).toContain("No server named");
    // admin-schap geeft via de bot niets extra's
    expect(text(await runCommand(admin.discordId, "start", "Survival"))).toContain("No server named");
    expect(powerCalls()).toHaveLength(0);
    // maar status mag een subuser zonder power wel
    expect(text(await runCommand(reader.discordId, "status", "Survival"))).toContain("Survival");
  });

  it("opgeschorte server: status ja, starten nee", async () => {
    await getDb().update(schema.servers).set({ suspendedAt: new Date(), suspendedReason: "test" }).where(eq(schema.servers.uuid, uuid));
    try {
      h.daemon.requests.length = 0;
      expect(text(await runCommand(owner.discordId, "start", "Survival"))).toContain("suspended");
      expect(text(await runCommand(owner.discordId, "status", "Survival"))).toContain("suspended");
      expect(powerCalls()).toHaveLength(0);
    } finally {
      await getDb().update(schema.servers).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.servers.uuid, uuid));
    }
  });

  it("afhandeling van namen en autocomplete", async () => {
    const list = await owner.api.servers.list();
    expect(resolveServer(list, "SKY")).toMatchObject({ name: "Skyblock" });
    expect(resolveServer(list, "S")).toHaveProperty("error"); // dubbelzinnig
    expect(resolveServer(list, list[0]!.shortId)).toMatchObject({ uuid: list[0]!.uuid });
    expect(text(await runCommand(owner.discordId, "start", " "))).toContain("Give a server name");
    expect(text(await runCommand(owner.discordId, "ban", "x"))).toBe("Unknown command.");
    expect((await suggest(owner.discordId, "sky")).map((s) => s.value)).toEqual(["Skyblock"]);
    expect(await suggest(stranger.discordId, "")).toEqual([]);
  });
});

// ---------- gateway met nep-Discord ----------

class FakeWs implements WsLike {
  sent: { op: number; d: any }[] = [];
  closed: number | null = null;
  onopen = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  push(p: unknown) {
    this.onmessage!({ data: JSON.stringify(p) });
  }
}

function setup(over: Partial<ConstructorParameters<typeof DiscordBot>[0]> = {}) {
  const sockets: FakeWs[] = [];
  const calls: { url: string; method: string; body: any; auth: string | null }[] = [];
  const logs: string[] = [];
  const bot = new DiscordBot({
    token: "TOKEN",
    makeSocket: () => {
      const s = new FakeWs();
      sockets.push(s);
      return s;
    },
    fetchFn: (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    ...over,
  });
  return { bot, sockets, calls, logs };
}
const interaction = (userId: string, name: string, value?: string, type = 2) => ({
  id: "i1", token: "t1", type, member: { user: { id: userId } },
  data: { name, options: value === undefined ? [] : [{ name: "name", value, focused: type === 4 }] },
});

describe("gateway", () => {
  it("handshake: identify zonder intents, commando's registreren na READY", async () => {
    const { bot, sockets, calls } = setup();
    bot.start();
    const ws = sockets[0]!;
    ws.push({ op: 10, d: { heartbeat_interval: 100000 } });
    expect(ws.sent[0]).toMatchObject({ op: 2, d: { token: "TOKEN", intents: 0 } });
    ws.push({ op: 0, s: 1, t: "READY", d: { user: { username: "panelbot" }, application: { id: "555" } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]).toMatchObject({ url: "https://discord.com/api/v10/applications/555/commands", method: "PUT", auth: "Bot TOKEN" });
    expect(calls[0]!.body.map((c: { name: string }) => c.name)).toEqual(["servers", "status", "start", "stop", "restart"]);
    bot.stop();
  });

  it("beantwoordt een commando ephemeral en zonder pings, via dezelfde rechtencontrole", async () => {
    const { bot, calls } = setup();
    await bot.onInteraction(interaction(reader.discordId, "start", "Survival"));
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/interactions/i1/t1/callback");
    expect(calls[0]!.body).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(calls[0]!.body.data.content).toContain("permission");
  });

  it("autocomplete en rate limit", async () => {
    const { bot, calls } = setup({ rateLimit: 2 });
    await bot.onInteraction(interaction(owner.discordId, "start", "sky", 4));
    expect(calls[0]!.body).toMatchObject({ type: 8, data: { choices: [{ name: "Skyblock", value: "Skyblock" }] } });
    await bot.onInteraction(interaction(owner.discordId, "servers"));
    await bot.onInteraction(interaction(owner.discordId, "servers"));
    expect(calls[2]!.body.data.content).toBe("Slow down a little.");
  });

  it("ongeldig token (4004) stopt de bot; andere sluitcodes geven een nieuwe poging", async () => {
    const { bot, sockets, logs } = setup();
    bot.start();
    sockets[0]!.onclose!({ code: 4004 });
    expect(logs.some((l) => l.includes("DISCORD_BOT_TOKEN"))).toBe(true);
    const b2 = setup();
    b2.bot.start();
    b2.sockets[0]!.onclose!({ code: 1006 });
    expect(b2.logs.some((l) => l.includes("retrying"))).toBe(true);
    b2.bot.stop();
  });

  it("een fout in het commando laat de bot en het panel draaien", async () => {
    const { bot, calls } = setup({
      run: async () => {
        throw new Error("kapot");
      },
    });
    bot.start();
    await expect(bot.onInteraction(interaction(owner.discordId, "servers"))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("startBot zonder token doet niets", () => {
    expect(() => startBot(undefined)).not.toThrow();
  });
});
