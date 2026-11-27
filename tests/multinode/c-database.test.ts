/**
 * Fase C: een website met database verhuist tussen de lokale node en de remote node (en terug), zonder dat de
 * site het merkt. Elke node heeft zijn eigen MariaDB (naam MARIADB_CONTAINER op beide). Bewijst: beide nodes
 * melden hun MariaDB aan, de database gaat mee met dezelfde naam/gebruiker/wachtwoord, de data klopt na elke
 * verhuizing (via de site zelf), de bron-database is weg en de site verbindt nog steeds met dezelfde host.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client as Ssh } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminLogin, env, login, startDaemon, stopDaemon, waitDaemonUp, waitFor } from "../integration/helpers";

const OWNER = "200000000000000005";
const SITE_DOMAIN = "dbsite.mn.test"; // staat via /etc/hosts op het IP van de remote node (run.sh)
let admin: Awaited<ReturnType<typeof adminLogin>>;
let owner: Awaited<ReturnType<typeof login>>;
let node2 = 0, localNode = 0;
let uuid = "";
let dbName = "";
let dbUser = "";
let dbPass = "";
let dbHost = "";

const MDB = () => env("MARIADB_CONTAINER");
const ROOT_LOCAL = () => env("MARIADB_ROOT_PASSWORD");

const local = (...cmd: string[]) => execFileSync("docker", cmd, { encoding: "utf8" }).trim();
const localDatabases = () => local("exec", "-e", `MYSQL_PWD=${ROOT_LOCAL()}`, MDB(), "mariadb", "-uroot", "-N", "-e", "SHOW DATABASES");

function rexec(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = new Ssh();
    c.on("ready", () =>
      c.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => (out += d.toString())).stderr.on("data", (d: Buffer) => (out += d.toString()));
        stream.on("close", () => (c.end(), resolve(out.trim())));
      }),
    )
      .on("error", reject)
      .connect({ host: env("MN_NODE_HOST"), username: "root", privateKey: readFileSync(env("MN_SSH_KEY")), readyTimeout: 20_000 });
  });
}
const remoteDatabases = () => rexec(`docker exec -e MYSQL_PWD="$(sed -n 's/^MARIADB_ROOT_PASSWORD=//p' /etc/panel/panel.env)" ${MDB()} mariadb -uroot -N -e 'SHOW DATABASES'`);

/** Zoals een bezoeker op de lokale node: via de sitecontainer zelf. */
const localPhp = (q = "") => local("exec", `panel-${uuid}`, "sh", "-c", `curl -s "http://$(hostname -i | cut -d' ' -f1):8080/db.php${q}"`);
/** Op de remote node via Caddy (HTTPS, eigen CA; NODE_TLS_REJECT_UNAUTHORIZED=0). */
const remotePhp = async (q = "") => (await (await fetch(`https://${SITE_DOMAIN}/db.php${q}`)).text()).trim();

const script = (host: string, user: string, pass: string, name: string) => `<?php
mysqli_report(MYSQLI_REPORT_OFF);
$m = @new mysqli(${JSON.stringify(host)}, ${JSON.stringify(user)}, ${JSON.stringify(pass)}, ${JSON.stringify(name)});
if ($m->connect_errno) { echo "FOUT ", $m->connect_errno; exit; }
$m->set_charset("utf8mb4");
$m->query("CREATE TABLE IF NOT EXISTS t (v VARCHAR(40) CHARACTER SET utf8mb4)");
if (isset($_GET['add'])) $m->query("INSERT INTO t VALUES ('" . $m->real_escape_string($_GET['add']) . "')");
echo "OK:" . $m->query("SELECT GROUP_CONCAT(v ORDER BY v) FROM t")->fetch_row()[0];
`;

const nodeName = async () => (await owner.api.servers.get.query({ uuid })).node.name;

beforeAll(async () => {
  startDaemon();
  await waitDaemonUp();
  admin = await adminLogin();
  owner = await login(OWNER, "dbbaas");
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

describe("database-hosts per node en een site met database die verhuist", () => {
  it("elke node meldt zijn eigen MariaDB aan (daemon-beheerd, zonder rootwachtwoord in het panel)", async () => {
    const hosts = await waitFor("database-hosts van beide nodes", async () => {
      const l = await admin.api.admin.databaseHosts.list.query();
      return l.some((h) => h.nodeId === localNode && h.daemonManaged) && l.some((h) => h.nodeId === node2 && h.daemonManaged) ? l : null;
    }, 90_000, 2000);
    for (const nodeId of [localNode, node2]) {
      const h = hosts.find((x) => x.nodeId === nodeId)!;
      expect(h).toMatchObject({ host: MDB(), port: 3306, adminUser: "", daemonManaged: true });
      expect(await admin.api.admin.databaseHosts.test.mutate({ id: h.id })).toEqual({ ok: true, error: null });
    }
  });

  it("PHP-site op lokaal met een database en data", async () => {
    const tpl = (await admin.api.admin.templates.list.query()).find((t) => t.slug === "php-8-3");
    expect(tpl, "php-8-3-template").toBeTruthy();
    const u = (await admin.api.admin.users.list.query({ search: "dbbaas" })).items.find((x) => x.discordId === OWNER)!;
    const s = await admin.api.admin.servers.create.mutate({
      name: "mn db site", ownerId: u.id, nodeId: localNode, templateId: tpl!.id,
      limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 2048 }, allocationIds: [], variables: {}, startOnInstall: true,
    });
    uuid = s.uuid;
    await waitFor("site online", async () => {
      const st = (await owner.api.servers.get.query({ uuid })).status;
      if (st === "install_failed") throw new Error("install_failed");
      return st === "online";
    }, 10 * 60_000, 3000);
    await owner.api.domains.add.mutate({ uuid, hostname: SITE_DOMAIN });
    const d = await owner.api.databases.create.mutate({ uuid, name: "wp" });
    ({ name: dbName, username: dbUser, password: dbPass, host: dbHost } = d);
    expect(dbHost).toBe(MDB());
    expect((await admin.api.admin.databaseHosts.list.query()).find((h) => h.id === d.hostId)?.nodeId).toBe(localNode);
    await owner.api.files.write.mutate({ uuid, path: "/public/db.php", content: script(dbHost, dbUser, dbPass, dbName) });
    let last = "";
    await waitFor("site bereikt zijn database", async () => (last = localPhp("?add=before-move")) === "OK:before-move", 60_000, 3000).catch((e) => {
      throw new Error(`${(e as Error).message}; laatste uitvoer: ${last.slice(0, 300)}`);
    });
    expect(localPhp("?add=caf%C3%A9")).toBe("OK:before-move,café");
    expect(localDatabases()).toContain(dbName);
  });

  it("verhuizen lokaal -> node2: database gaat mee, site verbindt nog met dezelfde host, bron-database weg", async () => {
    await admin.api.admin.servers.transfer.mutate({ uuid, nodeId: node2 });
    expect(await nodeName()).toBe("node2");
    const d = (await owner.api.databases.list.query({ uuid }))[0]!;
    expect(d).toMatchObject({ name: dbName, username: dbUser, password: dbPass, host: dbHost, port: 3306 });
    expect((await admin.api.admin.databaseHosts.list.query()).find((h) => h.id === d.hostId)?.nodeId).toBe(node2);
    await waitFor("site online op node2", async () => (await owner.api.servers.get.query({ uuid })).status === "online", 180_000, 3000);
    let last = "";
    await waitFor("site op node2 bereikt zijn database", async () => (last = await remotePhp()) === "OK:before-move,café", 90_000, 3000).catch((e) => {
      throw new Error(`${(e as Error).message}; laatste uitvoer: ${last.slice(0, 300)}`);
    });
    expect(await remotePhp("?add=after-move")).toBe("OK:after-move,before-move,café");
    expect(await remoteDatabases()).toContain(dbName);
    expect(localDatabases()).not.toContain(dbName);
    expect(local("exec", "-e", `MYSQL_PWD=${ROOT_LOCAL()}`, MDB(), "mariadb", "-uroot", "-N", "-e", `SELECT COUNT(*) FROM mysql.user WHERE User='${dbUser}'`)).toBe("0");
  });

  it("verhuizen terug naar lokaal: data (ook de nieuwe) klopt, remote database weg", async () => {
    await admin.api.admin.servers.transfer.mutate({ uuid, nodeId: localNode });
    expect(await nodeName()).toBe("node1");
    await waitFor("site online op lokaal", async () => (await owner.api.servers.get.query({ uuid })).status === "online", 180_000, 3000);
    let last = "";
    await waitFor("site lokaal bereikt zijn database", async () => (last = localPhp()) === "OK:after-move,before-move,café", 90_000, 3000).catch((e) => {
      throw new Error(`${(e as Error).message}; laatste uitvoer: ${last.slice(0, 300)}`);
    });
    expect(await remoteDatabases()).not.toContain(dbName);
    expect(localDatabases()).toContain(dbName);
    const d = (await owner.api.databases.list.query({ uuid }))[0]!;
    expect((await admin.api.admin.databaseHosts.list.query()).find((h) => h.id === d.hostId)?.nodeId).toBe(localNode);
  });

  it("gebruiker kan de database nog resetten en verwijderen via het panel (op de juiste node)", async () => {
    const d = (await owner.api.databases.list.query({ uuid }))[0]!;
    const r = await owner.api.databases.resetPassword.mutate({ id: d.id });
    expect(r.password).not.toBe(dbPass);
    await owner.api.databases.delete.mutate({ id: d.id });
    expect(localDatabases()).not.toContain(dbName);
  });
});
