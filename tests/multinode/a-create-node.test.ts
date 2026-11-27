/** Fase A: admin maakt de remote node aan; het installcommando gaat naar $MN_WORK/install-command.txt. */
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { adminLogin, env } from "../integration/helpers";

it("admin.nodes.create geeft token + installcommando voor node2", async () => {
  const admin = await adminLogin();
  const r = await admin.api.admin.nodes.create.mutate({
    name: "node2",
    fqdn: env("MN_NODE_DOMAIN"),
    daemonPort: 8080,
    sftpPort: Number(env("MN_SFTP_PORT")),
    maxRamMb: 3000,
    maxDiskMb: 50000,
    s3TargetId: null,
  });
  expect(r.installCommand).toContain("git clone --depth 1 https://github.com/St3v3-B/BSSG-Panel.git /opt/panel-node");
  expect(r.installCommand).toContain("deploy/install.sh --node-only --non-interactive");
  expect(r.installCommand).toContain(`PANEL_URL='${env("IT_PANEL_URL")}'`);
  writeFileSync(`${env("MN_WORK")}/install-command.txt`, r.installCommand + "\n");
  writeFileSync(`${env("MN_WORK")}/node-token`, r.token);
  const nodes = await admin.api.admin.nodes.list.query();
  expect(nodes.find((n) => n.id === r.node.id)?.isLocal).toBe(false);
  // De node is nog niet geïnstalleerd: offline.
  expect((await admin.api.admin.nodes.get.query({ id: r.node.id })).health.online).toBe(false);
});
