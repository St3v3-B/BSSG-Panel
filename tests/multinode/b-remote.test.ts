/**
 * Fase B: echte remote node (tweede machine) naast de lokale node, tegen het test-panel.
 * Bewijst: health, server aanmaken op node2, console-websocket (wss://<fqdn>), upload/download-URL's,
 * SFTP op de node-fqdn, de daemon die het panel aanroept (install/status/JWKS), en verplaatsen
 * tussen nodes in beide richtingen met een checksum over 30 MB data.
 */
import { readFileSync } from "node:fs";
import { Client as Ssh } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Console, DAEMON, adminLogin, env, login, startDaemon, stopDaemon, waitDaemonUp, waitFor } from "../integration/helpers";

const PLAYER = "200000000000000002";
let admin: Awaited<ReturnType<typeof adminLogin>>;
let player: Awaited<ReturnType<typeof login>>;
let playerId = 0;
let node2 = 0, localNode = 0;
let uuid = "";
let shortId = "";
let sha = "";
const NODE_DOMAIN2 = () => env("MN_NODE_DOMAIN");
const nodeToken = () => readFileSync(`${env("MN_WORK")}/node-token`, "utf8").trim();

const status = async () => (await player.api.servers.get.query({ uuid })).status;
const nodeName = async () => (await player.api.servers.get.query({ uuid })).node.name;

/** Console van de server, op de juiste node: remote via wss://<fqdn>, lokaal rechtstreeks naar de daemon. */
async function consoleFor(remote: boolean) {
  const t = await player.api.servers.consoleToken.mutate({ uuid });
  const url = remote ? t.socketUrl : `${DAEMON().replace(/^http/, "ws")}/api/servers/${uuid}/ws`;
  if (remote) expect(t.socketUrl).toBe(`wss://${NODE_DOMAIN2()}/api/servers/${uuid}/ws`);
  const c = new Console(url);
  await c.opened;
  c.send({ event: "auth", token: t.token });
  await c.waitFor("auth_success", (m) => m.event === "auth_success", 15_000);
  return c;
}

async function run(c: Console, cmd: string, expectLine: RegExp) {
  c.send({ event: "send_command", command: cmd });
  await waitFor(`console: ${cmd}`, async () => c.lines().find((l) => expectLine.test(l)), 30_000, 300);
  return c.lines().find((l) => expectLine.test(l))!;
}

function sftp(host: string, port: number, username: string, password: string) {
  return new Promise<{ put: (path: string, data: Buffer) => Promise<void>; list: (dir: string) => Promise<string[]>; end: () => void }>((resolve, reject) => {
    const c = new Ssh();
    c.on("ready", () =>
      c.sftp((err, s) => {
        if (err) return reject(err);
        resolve({
          put: (path, data) => new Promise((res, rej) => s.writeFile(path, data, (e) => (e ? rej(e) : res()))),
          list: (dir) => new Promise((res, rej) => s.readdir(dir, (e, l) => (e ? rej(e) : res(l.map((x) => x.filename))))),
          end: () => c.end(),
        });
      }),
    )
      .on("error", reject)
      .connect({ host, port, username, password, readyTimeout: 15_000 });
  });
}

const remoteDaemon = (path: string) => fetch(`https://${NODE_DOMAIN2()}${path}`, { headers: { authorization: `Bearer ${nodeToken()}` } });

beforeAll(async () => {
  startDaemon();
  await waitDaemonUp();
  admin = await adminLogin();
  player = await login(PLAYER, "speler");
  playerId = (await player.api.auth.me.query())!.user.id;
  const nodes = await admin.api.admin.nodes.list.query();
  node2 = nodes.find((n) => !n.isLocal)!.id;
  localNode = nodes.find((n) => n.isLocal)!.id;
});

afterAll(async () => {
  try {
    if (uuid && admin) await admin.api.admin.servers.delete.mutate({ uuid });
  } finally {
    await stopDaemon();
  }
});

describe("remote node", () => {
  it("node2 is online en staat met versie op het dashboard", async () => {
    const h = await waitFor("node2 online", async () => {
      const n = await admin.api.admin.nodes.get.query({ id: node2 });
      return n.health.online ? n.health : null;
    }, 60_000, 2000);
    expect(h.version).toBeTruthy();
    expect(h.cpuCount).toBeGreaterThan(0);
    const dash = await admin.api.admin.dashboard.query();
    expect(dash.nodes.map((n) => [n.nodeId, n.online])).toEqual(expect.arrayContaining([[localNode, true], [node2, true]]));
  });

  it("allocations per node; server aanmaken op node2 en installatie wordt door de daemon gemeld", async () => {
    await admin.api.admin.allocations.create.mutate({ nodeId: node2, ip: "0.0.0.0", ports: "25570-25573" });
    await admin.api.admin.allocations.create.mutate({ nodeId: localNode, ip: "127.0.0.1", ports: env("IT_GAME_PORT") });
    const a2 = await admin.api.admin.allocations.list.query({ nodeId: node2 });
    expect(a2.map((a) => a.port)).toEqual([25570, 25571, 25572, 25573]);
    const tpl = (await admin.api.admin.templates.list.query()).find((t) => t.slug === "it-sleeper")!;
    const d = await admin.api.admin.servers.create.mutate({
      name: "mn-test",
      ownerId: playerId,
      nodeId: node2,
      templateId: tpl.id,
      limits: { cpuPct: 100, ramMb: 256, swapMb: 0, diskMb: 2000 },
      allocationIds: [a2[0]!.id],
      variables: {},
      startOnInstall: true,
    });
    uuid = d.uuid;
    shortId = d.shortId;
    expect(d.node.fqdn).toBe(NODE_DOMAIN2());
    expect(d.sftp.host).toBe(NODE_DOMAIN2());
    // Install- en statusmeldingen komen via PANEL_URL (reverse tunnel) bij het panel.
    await waitFor("server online", async () => (await status()) === "online", 240_000, 3000);
    expect((await remoteDaemon(`/api/servers/${uuid}`)).status).toBe(200);
  });

  it("console via wss://<node fqdn> (JWT door de daemon gecontroleerd met de sleutel van het panel)", async () => {
    const c = await consoleFor(true);
    expect(await run(c, "echo mn-hello-$((40+2))", /^mn-hello-42$/)).toBeTruthy();
    c.close();
  });

  it("upload- en download-URL's wijzen naar de node-fqdn en werken één keer", async () => {
    const up = await player.api.files.uploadUrl.mutate({ uuid, directory: "/" });
    expect(new URL(up.url).host).toBe(NODE_DOMAIN2());
    const fd = new FormData();
    fd.append("files", new Blob(["via-upload"]), "up.txt");
    const r = await fetch(up.url, { method: "POST", body: fd });
    expect(r.status).toBe(204);
    const down = await player.api.files.downloadUrl.mutate({ uuid, path: "/up.txt" });
    expect(new URL(down.url).host).toBe(NODE_DOMAIN2());
    const g = await fetch(down.url);
    expect(g.status).toBe(200);
    expect(await g.text()).toBe("via-upload");
    expect((await fetch(down.url)).status).toBe(401);
    expect((await player.api.files.read.query({ uuid, path: "/up.txt" })).content).toBe("via-upload");
  });

  it("SFTP op de node-fqdn (de daemon vraagt het panel om authenticatie)", async () => {
    const det = await player.api.files.sftpDetails.query({ uuid });
    expect(det.host).toBe(NODE_DOMAIN2());
    expect(det.port).toBe(Number(env("MN_SFTP_PORT")));
    await player.api.account.setSftpPassword.mutate({ uuid, password: "geheim-wachtwoord-1" });
    const s = await sftp(det.host, det.port, det.username, "geheim-wachtwoord-1");
    await s.put("/via-sftp.txt", Buffer.from("sftp"));
    expect(await s.list("/")).toContain("via-sftp.txt");
    s.end();
    await expect(sftp(det.host, det.port, det.username, "fout-wachtwoord")).rejects.toThrow();
    expect(shortId).toBeTruthy();
  });

  it("verplaatsen node2 -> lokaal (draaiend): 30 MB data, checksum gelijk, server weer online, bron weg", async () => {
    const c = await consoleFor(true);
    await run(c, "mkdir -p /home/container/world && dd if=/dev/urandom of=/home/container/world/big.bin bs=1M count=30 2>/dev/null && echo made-big", /^made-big$/);
    sha = (await run(c, "sha256sum /home/container/world/big.bin | cut -c1-64 | sed 's/^/SHA=/'", /^SHA=[0-9a-f]{64}$/)).slice(4);
    c.close();
    const a = await admin.api.admin.allocations.list.query({ nodeId: localNode });
    await admin.api.admin.servers.transfer.mutate({ uuid, nodeId: localNode });
    expect(await nodeName()).toBe("node1");
    expect((await admin.api.admin.allocations.list.query({ nodeId: node2 })).filter((x) => x.serverUuid === uuid)).toEqual([]);
    expect((await admin.api.admin.allocations.list.query({ nodeId: localNode })).find((x) => x.serverUuid === uuid)?.id).toBe(a[0]!.id);
    expect((await remoteDaemon(`/api/servers/${uuid}`)).status).toBe(404); // bron verwijderd
    await waitFor("server online op lokaal", async () => (await status()) === "online", 120_000, 2000);
    const c2 = await consoleFor(false);
    expect(await run(c2, "sha256sum /home/container/world/big.bin | cut -c1-64 | sed 's/^/SHA=/'", /^SHA=[0-9a-f]{64}$/)).toBe(`SHA=${sha}`);
    expect(await run(c2, "cat /home/container/up.txt /home/container/via-sftp.txt; echo", /^via-uploadsftp$/)).toBeTruthy();
    c2.close();
  });

  it("verplaatsen lokaal -> node2 met gekozen allocation; mislukte verplaatsing laat de bron intact", async () => {
    const a2 = await admin.api.admin.allocations.list.query({ nodeId: node2 });
    const free = a2.filter((x) => x.serverUuid === null);
    expect(free.length).toBe(4);
    // Geen vrije allocation op het doel: foutmelding, server blijft op lokaal en draait door.
    await expect(admin.api.admin.servers.transfer.mutate({ uuid, nodeId: node2, allocationIds: [999999] })).rejects.toThrow(/ALLOCATION_NOT_FOUND/);
    expect(await nodeName()).toBe("node1");
    expect(await status()).toBe("online");
    await admin.api.admin.servers.transfer.mutate({ uuid, nodeId: node2, allocationIds: [free[2]!.id] });
    expect(await nodeName()).toBe("node2");
    const srv = await player.api.servers.get.query({ uuid });
    expect(srv.allocations[0]?.port).toBe(free[2]!.port);
    await waitFor("server online op node2", async () => (await status()) === "online", 120_000, 2000);
    const c = await consoleFor(true);
    expect(await run(c, "sha256sum /home/container/world/big.bin | cut -c1-64 | sed 's/^/SHA=/'", /^SHA=[0-9a-f]{64}$/)).toBe(`SHA=${sha}`);
    c.close();
    expect((await admin.api.admin.activity.search.query({ serverUuid: uuid })).items.filter((i) => i.action === "admin.server.transfer")).toHaveLength(2);
  });
});
