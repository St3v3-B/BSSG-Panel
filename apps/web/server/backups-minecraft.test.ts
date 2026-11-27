import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as reportBackupRoute } from "@/app/api/remote/backups/[backup_id]/route";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const tpl = (n: string) => readFileSync(join(__dirname, "../../../templates/game", n), "utf8");
const h = useHarness({ templates: { "game/paper.yaml": tpl("paper.yaml") } });
let admin: TestUser, alice: TestUser;
let uuid = "";

const commands = () => h.daemon.requests.filter((r) => r.method === "POST" && r.path === `/api/servers/${uuid}/commands`).map((r) => (r.body as { commands: string[] }).commands);

const report = (id: number) =>
  reportBackupRoute(
    new Request(`http://panel.test/api/remote/backups/${id}`, { method: "POST", headers: { authorization: `Bearer ${h.env.NODE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ successful: false, error: "boom" }) }),
    { params: Promise.resolve({ backup_id: String(id) }) },
  );

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "290000000000000051", name: "alice" });
  await admin.api.admin.s3Targets.create({ name: "S3", endpoint: "http://127.0.0.1:9", bucket: "b", region: "us-east-1", pathStyle: true, accessKey: "AKTESTKEY", secretKey: "supersecretvalue" });
  const a = await h.allocation(34501, "127.0.0.1");
  uuid = (await admin.api.admin.servers.create({ name: "MC", ownerId: alice.id, nodeId: h.localNodeId, templateId: await h.templateId("paper"), limits: { cpuPct: 100, ramMb: 1536, swapMb: 0, diskMb: 1024 }, allocationIds: [a], variables: {}, startOnInstall: false })).uuid;
}, 180_000);

describe("Minecraft-backup", () => {
  it("draaiende server: save-off + save-all flush ervoor, save-on erna; offline: niets", async () => {
    h.daemon.override = (r) => (r.method === "POST" && r.path.endsWith("/backups") ? { status: 202 } : undefined);
    h.daemon.requests.length = 0;
    const off = await alice.api.backups.create({ uuid, name: "offline", includeDatabases: false });
    expect(commands()).toEqual([]);
    await report(off.id);
    expect(commands()).toEqual([]);

    h.daemon.servers.get(uuid)!.state = "online";
    const b = await alice.api.backups.create({ uuid, name: "online", includeDatabases: false });
    expect(commands()).toEqual([["save-off", "save-all flush"]]);
    await report(b.id);
    expect(commands()).toEqual([["save-off", "save-all flush"], ["save-on"]]);
    expect((await alice.api.backups.list({ uuid })).find((x) => x.id === b.id)).toMatchObject({ status: "failed", error: "boom" });
  });
});
