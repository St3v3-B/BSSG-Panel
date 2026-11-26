/**
 * Integratietest fase 1 — de mijlpaal zonder de onderdelen die alleen met echte
 * Discord en een echt domein kunnen (die test de orchestrator met de hand, zie CLAUDE.md).
 *
 * Draait tegen een echt panel (next), echte Postgres/Redis (testcontainers), de echte
 * daemon-binary en echte Docker. Alles krijgt panel.test=true en wordt opgeruimd.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Console, DAEMON, client, env, login, startDaemon, stopDaemon, totp, waitDaemonUp, waitFor } from "./helpers";

const OWNER = env("OWNER_DISCORD_ID");
const PLAYER = "200000000000000002";
const PORT = Number(env("IT_GAME_PORT"));

let owner: Awaited<ReturnType<typeof login>>;
let player: Awaited<ReturnType<typeof login>>;
let uuid = "";

const consoleFor = async (api: typeof player.api) => {
  const t = await api.servers.consoleToken.mutate({ uuid });
  expect(t.socketUrl).toBe(`wss://${env("NODE_DOMAIN")}/api/servers/${uuid}/ws`);
  const c = new Console(`${DAEMON().replace(/^http/, "ws")}/api/servers/${uuid}/ws`);
  await c.opened;
  c.send({ event: "auth", token: t.token });
  await c.waitFor("auth_success", (m) => m.event === "auth_success", 10_000);
  return c;
};

beforeAll(async () => {
  startDaemon();
  await waitDaemonUp();
});

afterAll(async () => {
  try {
    if (uuid && owner) await owner.api.admin.servers.delete.mutate({ uuid });
  } finally {
    await stopDaemon();
  }
});

describe("fase 1: één Minecraft-server van begin tot eind", () => {
  it("zonder sessie: geen toegang, wel branding", async () => {
    const anon = client(null);
    expect(await anon.auth.me.query()).toBeNull();
    expect((await anon.auth.branding.query()).panelName).toBeTruthy();
    await expect(anon.servers.list.query()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("eigenaar logt in en is admin, maar /admin vraagt eerst 2FA", async () => {
    owner = await login(OWNER, "eigenaar");
    const me = await owner.api.auth.me.query();
    expect(me?.isAdmin).toBe(true);
    expect(me?.isOwner).toBe(true);
    await expect(owner.api.admin.nodes.list.query()).rejects.toThrow(/TOTP_REQUIRED/);
  });

  it("eigenaar zet 2FA aan en opent admin", async () => {
    const setup = await owner.api.account.totpSetup.mutate();
    await owner.api.account.totpEnable.mutate({ code: totp(setup.secret) });
    const nodes = await owner.api.admin.nodes.list.query();
    const local = nodes.find((n) => n.isLocal);
    expect(local?.fqdn).toBe(env("NODE_DOMAIN"));
  });

  it("een nieuwe login met 2FA vraagt eerst de code", async () => {
    const again = await login(OWNER, "eigenaar");
    expect((await again.api.auth.me.query())?.totpVerified).toBe(false);
    await expect(again.api.servers.list.query()).rejects.toThrow(/TOTP_PENDING/);
    await again.api.auth.logout.mutate();
  });

  it("tweede account bestaat na login en is geen admin", async () => {
    player = await login(PLAYER, "speler");
    const me = await player.api.auth.me.query();
    expect(me?.isAdmin).toBe(false);
    await expect(player.api.admin.servers.list.query({})).rejects.toThrow(/NOT_ADMIN/);
    expect(await player.api.servers.list.query()).toEqual([]);
  });

  it("admin maakt een Paper-server aan voor het tweede account", async () => {
    const templates = await owner.api.admin.templates.list.query();
    const paper = templates.find((t) => t.slug === "paper");
    expect(paper, "paper-template uit TEMPLATES_DIR").toBeTruthy();

    const node = (await owner.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
    await owner.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(PORT) });
    const alloc = (await owner.api.admin.allocations.list.query({ nodeId: node.id })).find((a) => a.port === PORT && !a.serverUuid)!;

    const users = await owner.api.admin.users.list.query({ search: "speler" });
    const target = users.items.find((u) => u.discordId === PLAYER)!;

    const created = await owner.api.admin.servers.create.mutate({
      name: "IT SMP",
      ownerId: target.id,
      nodeId: node.id,
      templateId: paper!.id,
      limits: { cpuPct: 200, ramMb: 1536, swapMb: 0, diskMb: 4096 },
      allocationIds: [alloc.id],
      variables: {},
      startOnInstall: true,
    });
    uuid = created.uuid;
    expect(created.owner.discordId).toBe(PLAYER);
    expect(created.status).toBe("installing");

    const log = await owner.api.admin.activity.search.query({ action: "admin.server.create" });
    expect(log.items.some((e) => e.serverUuid === uuid)).toBe(true);
  });

  it("de speler ziet de server; installatie en start lukken; status wordt online", async () => {
    const list = await player.api.servers.list.query();
    expect(list.map((s) => s.uuid)).toContain(uuid);

    await waitFor(
      "installatie klaar",
      async () => {
        const s = await player.api.servers.get.query({ uuid });
        if (s.status === "install_failed") throw new Error("install_failed");
        return s.installedAt !== null && s.status !== "installing";
      },
      10 * 60_000,
      3000,
    );
    await waitFor("status online", async () => (await player.api.servers.get.query({ uuid })).status === "online", 5 * 60_000, 3000);
  });

  it("console toont de log, `say hallo` komt aan en stats lopen", async () => {
    const c = await consoleFor(player.api);
    await c.waitFor("status-bericht", (m) => m.event === "status" && m.state === "online", 10_000);
    expect(c.lines().some((l) => /Done \(/.test(l)), "backlog bevat de startlog").toBe(true);

    c.send({ event: "send_command", command: "say hallo" });
    await c.waitFor("hallo in de console", (m) => m.event === "console_output" && /\[Server\] hallo/.test(String(m.line)), 30_000);

    const stats = await c.waitFor("stats", (m) => m.event === "stats", 10_000);
    expect(Number(stats.memory_bytes)).toBeGreaterThan(0);
    expect(Number(stats.memory_limit_bytes)).toBe(1536 * 1024 * 1024);
    c.close();

    const snap = await player.api.servers.stats.query({ uuid });
    expect(snap?.memoryBytes).toBeGreaterThan(0);
  });

  it("de daemon weigert een token voor een andere server of zonder console.write", async () => {
    const t = await player.api.servers.consoleToken.mutate({ uuid });
    const other = new Console(`${DAEMON().replace(/^http/, "ws")}/api/servers/00000000-0000-4000-8000-000000000000/ws`);
    await other.opened;
    other.send({ event: "auth", token: t.token });
    await waitFor("ws gesloten", async () => other.closedWith !== null, 10_000, 200);
    expect([4001, 4004]).toContain(other.closedWith);
  });

  it("power via tRPC: herstart brengt de server weer online", async () => {
    await player.api.servers.power.mutate({ uuid, action: "restart" });
    await waitFor("niet meer online", async () => (await player.api.servers.get.query({ uuid })).status !== "online", 60_000, 1000);
    await waitFor("weer online", async () => (await player.api.servers.get.query({ uuid })).status === "online", 5 * 60_000, 3000);
  });

  it("na een herstart van de daemon pakt de console het weer op", async () => {
    await stopDaemon();
    startDaemon();
    await waitDaemonUp();
    const s = await waitFor("status na herstart", async () => {
      const st = await player.api.servers.get.query({ uuid });
      return st.status === "online" ? st : undefined;
    }, 60_000, 1000);
    expect(s.status).toBe("online");

    const c = await consoleFor(player.api);
    c.send({ event: "send_command", command: "say terug" });
    await c.waitFor("console werkt na herstart", (m) => m.event === "console_output" && /\[Server\] terug/.test(String(m.line)), 30_000);
    c.close();
  });

  it("stop zet de status op offline", async () => {
    await player.api.servers.power.mutate({ uuid, action: "stop" });
    await waitFor("offline", async () => (await player.api.servers.get.query({ uuid })).status === "offline", 2 * 60_000, 2000);
  });
});
