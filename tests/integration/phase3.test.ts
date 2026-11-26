/**
 * Integratietest fase 3: een PHP 8.3-website met domein en eigen MariaDB-database.
 * Echt certificaat en DNS test de orchestrator op de echte installatie (wp.bssg-srv.nl-achtig);
 * hier draait de router als fake, dus we controleren de routes via de daemon-API.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON, adminLogin, env, login, startDaemon, stopDaemon, waitDaemonUp, waitFor } from "./helpers";

const OWNER2 = "200000000000000004";
let admin: Awaited<ReturnType<typeof adminLogin>>;
let site: Awaited<ReturnType<typeof login>>;
let uuid = "";

const routes = async () =>
  (await (await fetch(`${DAEMON()}/api/routes`, { headers: { authorization: `Bearer ${env("NODE_TOKEN")}` } })).json()) as Array<{ host: string; server_uuid: string; redirect_to: string | null }>;

/** Draait een PHP-bestand uit public/ met de PHP-CLI in de sitecontainer. */
const php = (file: string) => execFileSync("docker", ["exec", `panel-${uuid}`, "php", `/home/container/public/${file}`], { encoding: "utf8" }).trim();

const dbScript = (host: string, user: string, pass: string, name: string) => `<?php
mysqli_report(MYSQLI_REPORT_OFF);
$m = @new mysqli(${JSON.stringify(host)}, ${JSON.stringify(user)}, ${JSON.stringify(pass)}, ${JSON.stringify(name)});
if ($m->connect_errno) { echo "FOUT ", $m->connect_errno; exit; }
$m->query("CREATE TABLE IF NOT EXISTS t (v VARCHAR(10))");
$m->query("INSERT INTO t VALUES ('hallo')");
echo $m->query("SELECT v FROM t LIMIT 1")->fetch_row()[0] === "hallo" ? "OK" : "FOUT data";
`;

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

describe("fase 3: website met domein en database", () => {
  it("admin maakt een PHP 8.3-site; installatie lukt", async () => {
    admin = await adminLogin();
    site = await login(OWNER2, "webbaas");
    const node = (await admin.api.admin.nodes.list.query()).find((n) => n.isLocal)!;
    const tpl = (await admin.api.admin.templates.list.query()).find((t) => t.slug === "php-8-3");
    expect(tpl, "php-8-3-template").toBeTruthy();
    const owner = (await admin.api.admin.users.list.query({ search: "webbaas" })).items.find((u) => u.discordId === OWNER2)!;
    const s = await admin.api.admin.servers.create.mutate({
      name: "IT site", ownerId: owner.id, nodeId: node.id, templateId: tpl!.id,
      limits: { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 2048 }, allocationIds: [], variables: {}, startOnInstall: true,
    });
    uuid = s.uuid;
    expect(s.type).toBe("web");
    expect(s.allocations).toEqual([]);
    await waitFor("site online", async () => {
      const st = (await site.api.servers.get.query({ uuid })).status;
      if (st === "install_failed") throw new Error("install_failed");
      return st === "online";
    }, 8 * 60_000, 3000);
  });

  it("standaardpagina staat in public/", async () => {
    const files = await site.api.files.list.query({ uuid, path: "/public" });
    expect(files.map((f) => f.name)).toContain("index.html");
  });

  it("domein + www-redirect komen als routes bij de daemon", async () => {
    await site.api.domains.add.mutate({ uuid, hostname: "site1.test" });
    await site.api.domains.add.mutate({ uuid, hostname: "www.site1.test", redirectTo: "site1.test" });
    const r = await routes();
    expect(r.find((x) => x.host === "site1.test")?.server_uuid).toBe(uuid);
    expect(r.find((x) => x.host === "www.site1.test")?.redirect_to).toBe("site1.test");
    expect((await site.api.domains.list.query({ uuid })).map((d) => d.hostname).sort()).toEqual(["site1.test", "www.site1.test"]);
  });

  it("eigen database is bereikbaar vanuit de site; die van een ander niet", async () => {
    const mine = await site.api.databases.create.mutate({ uuid, name: "wp" });
    expect(mine.host).toBe(env("MARIADB_CONTAINER"));
    await site.api.files.write.mutate({ uuid, path: "/public/db.php", content: dbScript(mine.host, mine.username, mine.password, mine.name) });
    await waitFor("database bereikbaar vanuit de site", async () => php("db.php") === "OK", 60_000, 3000);

    // Een tweede database: de gebruiker van de eerste mag er niet bij.
    const other = await site.api.databases.create.mutate({ uuid, name: "ander" });
    await site.api.files.write.mutate({ uuid, path: "/public/cross.php", content: dbScript(mine.host, mine.username, mine.password, other.name) });
    expect(php("cross.php")).toMatch(/^FOUT/);
  });

  it("verwijderen ruimt routes op", async () => {
    await admin.api.admin.servers.delete.mutate({ uuid });
    const gone = uuid;
    uuid = "";
    await waitFor("routes weg", async () => !(await routes()).some((x) => x.server_uuid === gone), 60_000, 2000);
  });
});
