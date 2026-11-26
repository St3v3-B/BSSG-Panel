/**
 * Integratietest fase 2: bestanden, rechten, SFTP en de softe disk-limiet.
 * Velocity + twee Paper-servers en "plugin laadt na herstart" test de orchestrator met de hand
 * (te zwaar voor deze machine naast de agents).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as Ssh } from "ssh2";
import { Console, DAEMON, adminLogin, env, login, startDaemon, stopDaemon, waitDaemonUp, waitFor } from "./helpers";

const PLAYER = "200000000000000002";
const SUB = "200000000000000003";
let admin: Awaited<ReturnType<typeof adminLogin>>;
let player: Awaited<ReturnType<typeof login>>;
let sub: Awaited<ReturnType<typeof login>>;
let uuid = "";
let shortId = "";

function sftp(username: string, password: string) {
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
      .connect({ host: "127.0.0.1", port: Number(env("SFTP_PORT")), username, password, readyTimeout: 10_000 });
  });
}

/** Controleert de tRPC-foutcode (niet de message). */
const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (err: unknown) => err as { data?: { code?: string } });
  expect(e, `verwacht ${code}`).not.toBeNull();
  expect(e!.data?.code).toBe(code);
};

const status = async () => (await player.api.servers.get.query({ uuid })).status;

beforeAll(async () => {
  startDaemon();
  await waitDaemonUp();
});

afterAll(async () => {
  try {
    if (uuid && admin) await admin.api.admin.servers.delete.mutate({ uuid });
  } finally {
    await stopDaemon();
  }
});

describe("fase 2: bestanden, rechten en limieten", () => {
  it("admin maakt een testserver met 1 GB disk-limiet voor de speler", async () => {
    admin = await adminLogin();
    player = await login(PLAYER, "speler");
    sub = await login(SUB, "helper");
    const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
    const tpl = (await admin.api.admin.templates.list.query()).find((t) => t.slug === "it-sleeper")!;
    const port = Number(env("IT_GAME_PORT")) + 1;
    await admin.api.admin.allocations.create.mutate({ nodeId: node.id, ip: "127.0.0.1", ports: String(port) });
    const alloc = (await admin.api.admin.allocations.list.query({ nodeId: node.id })).find((a) => a.port === port)!;
    const owner = (await admin.api.admin.users.list.query({ search: "speler" })).items.find((u) => u.discordId === PLAYER)!;
    const s = await admin.api.admin.servers.create.mutate({
      name: "IT files", ownerId: owner.id, nodeId: node.id, templateId: tpl.id,
      limits: { cpuPct: 100, ramMb: 128, swapMb: 0, diskMb: 1024 }, allocationIds: [alloc.id], variables: {}, startOnInstall: true,
    });
    uuid = s.uuid;
    shortId = s.shortId;
    await waitFor("online", async () => (await status()) === "online", 3 * 60_000, 2000);
  });

  it("eigenaar kan bestanden lezen en schrijven", async () => {
    const files = await player.api.files.list.query({ uuid, path: "/" });
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining(["readme.txt", "plugins"]));
    await player.api.files.write.mutate({ uuid, path: "/notitie.txt", content: "van de eigenaar" });
    expect((await player.api.files.read.query({ uuid, path: "/notitie.txt" })).content).toBe("van de eigenaar");
  });

  it("subuser met alleen files.read kan lezen maar niet opslaan", async () => {
    await player.api.subusers.invite.mutate({ uuid, who: SUB, permissions: ["files.read"] });
    expect((await sub.api.files.read.query({ uuid, path: "/readme.txt" })).content.trim()).toBe("hallo");
    await rejectsWith(sub.api.files.write.mutate({ uuid, path: "/readme.txt", content: "hack" }), "FORBIDDEN");
    await rejectsWith(sub.api.files.uploadUrl.mutate({ uuid, directory: "/" }), "FORBIDDEN");
    await rejectsWith(sub.api.servers.power.mutate({ uuid, action: "stop" }), "FORBIDDEN");
    expect((await player.api.files.read.query({ uuid, path: "/readme.txt" })).content.trim()).toBe("hallo");

    // Direct naar de daemon zonder geldig token: geweigerd.
    const r = await fetch(`${DAEMON()}/api/servers/${uuid}/files/contents?path=/readme.txt`, { method: "PUT", body: "hack" });
    expect(r.status).toBe(401);
  });

  it("download-URL werkt één keer", async () => {
    const { url } = await player.api.files.downloadUrl.mutate({ uuid, path: "/readme.txt" });
    const local = url.replace(/^https:\/\/[^/]+/, DAEMON());
    const r1 = await fetch(local);
    expect(r1.status).toBe(200);
    expect((await r1.text()).trim()).toBe("hallo");
    expect((await fetch(local)).status).toBe(401);
  });

  it("SFTP: eigenaar uploadt een plugin, subuser mag alleen lezen", async () => {
    await player.api.account.setSftpPassword.mutate({ uuid, password: "geheim-wachtwoord-1" });
    const p = await sftp(`speler.${shortId}`, "geheim-wachtwoord-1");
    await p.put("/plugins/test-plugin.jar", Buffer.from("nep-jar"));
    expect(await p.list("/plugins")).toContain("test-plugin.jar");
    p.end();
    expect((await player.api.files.list.query({ uuid, path: "/plugins" })).map((f) => f.name)).toContain("test-plugin.jar");

    await expect(sftp(`speler.${shortId}`, "fout-wachtwoord")).rejects.toThrow();

    await sub.api.account.setSftpPassword.mutate({ uuid, password: "helper-wachtwoord-1" });
    const s = await sftp(`helper.${shortId}`, "helper-wachtwoord-1");
    expect(await s.list("/")).toContain("readme.txt");
    await expect(s.put("/mag-niet.txt", Buffer.from("x"))).rejects.toThrow();
    s.end();
  });

  it("volschrijven: waarschuwing, stop, schrijven geweigerd; na verhogen start hij weer", async () => {
    const t = await player.api.servers.consoleToken.mutate({ uuid });
    const c = new Console(`${DAEMON().replace(/^http/, "ws")}/api/servers/${uuid}/ws`);
    await c.opened;
    c.send({ event: "auth", token: t.token });
    await c.waitFor("auth_success", (m) => m.event === "auth_success", 10_000);

    c.send({ event: "send_command", command: "dd if=/dev/zero of=/home/container/groot.bin bs=1M count=1100 2>&1; echo dd-klaar" });
    await c.waitFor("disk-waarschuwing", (m) => m.event === "daemon_message" && m.level === "warning", 3 * 60_000);
    await waitFor("gestopt wegens disk", async () => ["disk_exceeded", "offline"].includes(await status()), 3 * 60_000, 2000);
    c.close();

    await expect(player.api.files.write.mutate({ uuid, path: "/nog-meer.txt", content: "x" })).rejects.toThrow(/PRECONDITION_FAILED|disk/i);
    const p = await sftp(`speler.${shortId}`, "geheim-wachtwoord-1");
    await expect(p.put("/nog-meer.txt", Buffer.from("x"))).rejects.toThrow();
    p.end();
    await expect(player.api.servers.power.mutate({ uuid, action: "start" })).rejects.toThrow();

    await admin.api.admin.servers.updateLimits.mutate({ uuid, limits: { cpuPct: 100, ramMb: 128, swapMb: 0, diskMb: 2048 } });
    await waitFor("start na verhogen", async () => {
      await player.api.servers.power.mutate({ uuid, action: "start" }).catch(() => undefined);
      return (await status()) === "online";
    }, 3 * 60_000, 5000);
  });
});
