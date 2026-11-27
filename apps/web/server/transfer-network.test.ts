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
    await alice.api.servers.updateNetwork({ uuid: proxy, members: [{ serverUuid: lobby, name: "lobby", isDefault: true }], restart: false });
    expect(h.daemon.fs(proxy).files.get("/velocity.toml")).toContain('lobby = "127.0.0.1:34601"');

    h.daemon.servers.get(lobby)!.state = "offline";
    await getDb().insert(schema.allocations).values({ nodeId: node2, ip: "10.9.8.7", port: 35001 });
    await admin.api.admin.servers.transfer({ uuid: lobby, nodeId: node2 });
    const toml = h.daemon.fs(proxy).files.get("/velocity.toml")!;
    expect(toml).toContain('lobby = "10.9.8.7:35001"');
    expect(toml).not.toContain("127.0.0.1:34601");
  });
});
