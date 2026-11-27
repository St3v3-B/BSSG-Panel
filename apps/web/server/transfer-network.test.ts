import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { daemonUrlOverrides } from "./daemon";
import { getDb, schema } from "./db";
import { transferPollMs } from "./routers/transfer";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ templates: { "game/velocity.yaml": tpl("velocity.yaml"), "game/paper.yaml": tpl("paper.yaml") } });
const limits = { cpuPct: 100, ramMb: 1536, swapMb: 0, diskMb: 1024 };
const TOML = `bind = "0.0.0.0:25577"\n\n[servers]\nlobby = "127.0.0.1:34601"\ntry = [\n  "lobby"\n]\n`;
let admin: TestUser, alice: TestUser;
let d2: FakeDaemon;
let node2 = 0;

beforeAll(async () => {
  transferPollMs.value = 10;
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "290000000000000061", name: "alice" });
  const n = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  node2 = n.node.id;
  d2 = new FakeDaemon(n.token);
  daemonUrlOverrides.set(node2, await d2.start());
}, 180_000);
afterAll(async () => {
  daemonUrlOverrides.clear();
  await d2.stop();
});

describe("transfer van een Velocity-backend", () => {
  it("werkt velocity.toml van de proxy bij met het adres op de nieuwe node", async () => {
    const mk = async (name: string, slug: string, port: number) =>
      (await admin.api.admin.servers.create({ name, ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [await h.allocation(port)], variables: {}, startOnInstall: false })).uuid;
    const proxy = await mk("Proxy", "velocity", 34600);
    const lobby = await mk("Lobby", "paper", 34601);
    h.daemon.fs(proxy).files.set("/velocity.toml", TOML);
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "lobby", isDefault: true }], forcedHosts: [{ hostname: "lobby.mc.test", serverUuid: lobby }], restart: false });
    expect(h.daemon.fs(proxy).files.get("/velocity.toml")).toContain(`lobby = "panel-${lobby}:34601"`);
    expect(h.daemon.fs(proxy).files.get("/velocity.toml")).toContain('[forced-hosts]\n"lobby.mc.test" = ["lobby"]');
    expect(h.daemon.proxyNetworks.get(proxy)).toEqual([lobby]);

    h.daemon.servers.get(lobby)!.state = "offline";
    await getDb().insert(schema.allocations).values({ nodeId: node2, ip: "10.9.8.7", port: 35001 });
    await admin.api.admin.servers.transfer({ uuid: lobby, nodeId: node2 });
    const toml = h.daemon.fs(proxy).files.get("/velocity.toml")!;
    expect(toml).toContain('lobby = "10.9.8.7:35001"');
    // forced host blijft naar dezelfde backend wijzen
    expect(toml).toContain('[forced-hosts]\n"lobby.mc.test" = ["lobby"]');
    expect((await alice.api.servers.get({ uuid: proxy })).network.forcedHosts).toEqual([{ hostname: "lobby.mc.test", serverUuid: lobby }]);
    expect(toml).not.toContain(`panel-${lobby}`);
    // niet meer op deze node: van het gedeelde netwerk af (adres via de host op de nieuwe node)
    expect(h.daemon.proxyNetworks.get(proxy)).toBeUndefined();
  });

  it("proxy zelf verplaatst: backends op de oude node krijgen hun adres via de host", async () => {
    const mk = async (name: string, slug: string, port: number, ip = "127.0.0.1") =>
      (await admin.api.admin.servers.create({ name, ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId(slug), limits, allocationIds: [await h.allocation(port, ip)], variables: {}, startOnInstall: false })).uuid;
    const proxy = await mk("Proxy B", "velocity", 34610);
    const hub = await mk("Hub", "paper", 34611, "198.51.100.4");
    h.daemon.fs(proxy).files.set("/velocity.toml", TOML.replace("lobby", "hub").replace("lobby", "hub"));
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: hub, name: "hub", isDefault: true }], restart: false });
    expect(h.daemon.fs(proxy).files.get("/velocity.toml")).toContain(`hub = "panel-${hub}:34611"`);
    h.daemon.servers.get(proxy)!.state = "offline";
    await getDb().insert(schema.allocations).values({ nodeId: node2, ip: "10.9.8.7", port: 35010 });
    await admin.api.admin.servers.transfer({ uuid: proxy, nodeId: node2 });
    const toml = d2.fs(proxy).files.get("/velocity.toml")!;
    expect(toml).toContain('hub = "198.51.100.4:34611"');
    expect(d2.proxyNetworks.get(proxy)).toBeUndefined();
    expect(h.daemon.proxyNetworks.get(proxy)).toBeUndefined();
  });
});
