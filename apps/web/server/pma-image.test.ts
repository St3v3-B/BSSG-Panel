/**
 * De echte phpMyAdmin-image (deploy/phpmyadmin) met onze config en signon.php, op HTTP-niveau:
 * zonder token geen toegang, met een (eenmalig) token wel. Het "panel" is een nep-endpoint in een eigen container.
 * Alles draait op een eigen netwerk met labels panel.test=true + een eigen panel.instance; opruimen op beide labels.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT, reapStale } from "./test/docker-pg";

const run = promisify(execFile);
const docker = async (...args: string[]) => (await run("docker", args, { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
const instance = `${AGENT}-${process.pid}-${randomBytes(3).toString("hex")}`;
const labels = ["--label", "panel.test=true", "--label", `panel.instance=${instance}`, "--label", `panel.agent=${AGENT}`, "--label", `panel.api.pid=${process.pid}`];
const filter = ["--filter", "label=panel.test=true", "--filter", `label=panel.instance=${instance}`];
const net = `pma-test-${instance}`;
const dbName = `pma-mdb-${instance}`;
const ROOT_PW = "rootpw-" + randomBytes(6).toString("hex");
const SHARED = randomBytes(24).toString("hex");
const TOKEN = "good" + randomBytes(24).toString("hex");
const PMA_PW = "Pw-" + randomBytes(10).toString("hex");

/** Nep-panel: alleen /api/pma/exchange, eenmalig token, verplicht Bearer. */
const FAKE_PANEL = `
const http = require("http");
let used = false;
let usedDb = false;
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method !== "POST" || req.url !== "/api/pma/exchange") return send(404, { error: "not_found" });
    if (req.headers.authorization !== "Bearer " + process.env.SHARED) return send(401, { error: "unauthorized" });
    let t; try { t = JSON.parse(b).token; } catch {}
    if (t === process.env.TOKEN && !used) { used = true; return send(200, { user: "pma_u1", password: process.env.PMA_PW }); }
    if (t === "dbtk" + process.env.TOKEN.slice(4) && !usedDb) { usedDb = true; return send(200, { user: "pma_u1", password: process.env.PMA_PW }); }
    if (t === "nodb" + process.env.TOKEN.slice(4)) return send(403, { error: "no_databases" });
    send(401, { error: "invalid_token" });
  });
}).listen(3000);
`;

let port = 0;
let base = "";
const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
const sql = (q: string, user = "root", pw = ROOT_PW, db = "") => docker("exec", "-e", `MYSQL_PWD=${pw}`, dbName, "mariadb", "-h127.0.0.1", `-u${user}`, "-N", "-B", ...(db ? [db] : []), "-e", q);
const get = (path: string, cookie?: string) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  await reapStale().catch(() => {});
  const image = `panel-phpmyadmin-test:${instance}`;
  await docker("build", "-t", image, ...labels, resolve(__dirname, "../../../deploy/phpmyadmin"));
  await docker("network", "create", ...labels, net);
  await docker("run", "-d", "--rm", ...labels, "--network", net, "--name", dbName, "-e", `MARIADB_ROOT_PASSWORD=${ROOT_PW}`, "mariadb:11", "--innodb-buffer-pool-size=32M", "--performance-schema=OFF");
  await docker("run", "-d", "--rm", ...labels, "--network", net, "--network-alias", "panel", "--name", `pma-panel-${instance}`, "-e", `SHARED=${SHARED}`, "-e", `TOKEN=${TOKEN}`, "-e", `PMA_PW=${PMA_PW}`, "node:24-alpine", "node", "-e", FAKE_PANEL);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await docker(
    "run", "-d", "--rm", ...labels, "--network", net, "--name", `pma-${instance}`, "-p", `127.0.0.1:${port}:80`,
    "-e", `PMA_ABSOLUTE_URI=${base}/phpmyadmin/`, "-e", `PMA_DB_HOST=${dbName}`, "-e", "PMA_PANEL_URL=http://panel:3000",
    "-e", `PMA_SHARED_SECRET=${SHARED}`, "-e", `PMA_BLOWFISH_SECRET=${randomBytes(24).toString("hex")}`, "-e", "HIDE_PHP_VERSION=1",
    "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "NET_BIND_SERVICE",
    image,
  );
  for (let i = 0; ; i++) {
    try {
      await sql("select 1");
      break;
    } catch (e) {
      if (i > 120) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await sql("CREATE DATABASE s1_site; CREATE DATABASE s2_other; CREATE TABLE s1_site.klanten (id INT PRIMARY KEY, naam VARCHAR(20)); INSERT INTO s1_site.klanten VALUES (1,'Alice');");
  await sql(`CREATE USER 'pma_u1'@'%' IDENTIFIED BY '${PMA_PW}'; GRANT ALL PRIVILEGES ON \`s1\\_site\`.* TO 'pma_u1'@'%';`);
  for (let i = 0; ; i++) {
    try {
      if ((await get("/signon.php")).status === 400) break;
    } catch {}
    if (i > 60) throw new Error("phpMyAdmin start niet");
    await new Promise((r) => setTimeout(r, 1000));
  }
}, 600_000);

afterAll(async () => {
  const ids = (await docker("ps", "-aq", ...filter).catch(() => "")).split("\n").filter(Boolean);
  if (ids.length) await docker("rm", "-f", ...ids).catch(() => {});
  const nets = (await docker("network", "ls", "-q", ...filter).catch(() => "")).split("\n").filter(Boolean);
  if (nets.length) await docker("network", "rm", ...nets).catch(() => {});
  const imgs = (await docker("images", "-q", ...filter).catch(() => "")).split("\n").filter(Boolean);
  if (imgs.length) await docker("rmi", "-f", ...imgs).catch(() => {});
}, 120_000);

describe("phpMyAdmin-image met single sign-on", () => {
  it("zonder token of sessie geen toegang: alles stuurt terug naar het panel", async () => {
    for (const p of ["/index.php", "/index.php?route=/database/structure&db=s1_site", "/index.php?route=/server/databases", "/"]) {
      const r = await get(p);
      expect([301, 302, 303, 307, 308, 401, 403]).toContain(r.status);
      const body = await r.text();
      expect(body).not.toContain("klanten");
      expect(body).not.toContain("s1_site");
      if (r.status < 400) expect(r.headers.get("location") ?? "").toMatch(/^(\/|https?:\/\/[^/]+\/?)(\?.*)?$|login|phpmyadmin/i);
    }
    // Het inlogformulier met vrije serverkeuze bestaat niet (auth_type signon).
    const html = await (await get("/index.php")).text();
    expect(html).not.toMatch(/pma_username|pma_servername/);
  });

  it("signon.php: zonder of met een ongeldig token geen sessie", async () => {
    expect((await get("/signon.php")).status).toBe(400);
    expect((await get("/signon.php?token=kort")).status).toBe(400);
    expect((await get("/signon.php?token=" + "x".repeat(40))).status).toBe(401);
    const nodb = await get("/signon.php?token=nodb" + TOKEN.slice(4));
    expect(nodb.status).toBe(403);
    expect((await get("/signon.php?token=" + "x".repeat(40))).headers.getSetCookie().join()).not.toContain("PanelPmaSignon");
  });

  it("een vervalst sessiecookie geeft geen toegang", async () => {
    const r = await get("/index.php?route=/server/databases", "PanelPmaSignon=" + "a".repeat(26));
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(await r.text()).not.toContain("s1_site");
  });

  it("met een geldig token: ingelogd, ziet alleen de eigen database; token werkt maar één keer", async () => {
    const r = await get("/signon.php?token=" + TOKEN);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("index.php");
    // Inbedden in het panel (zelfde domein) mag, andere sites niet.
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // session_regenerate_id geeft twee Set-Cookie-headers; de laatste geldt.
    const sc = r.headers.getSetCookie().filter((c) => c.startsWith("PanelPmaSignon=")).pop() ?? "";
    expect(sc).toMatch(/^PanelPmaSignon=[^;]+/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/path=\/phpmyadmin\//i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const cookie = sc.split(";")[0]!;
    // Hergebruik van het token: 401, geen nieuwe sessie.
    const again = await get("/signon.php?token=" + TOKEN);
    expect(again.status).toBe(401);
    // Caddy haalt /phpmyadmin weg; hier praten we direct met de container (pad zonder prefix).
    const home = await get("/index.php", cookie);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("s1_site");
    expect(html).not.toContain("s2_other");
    expect(html).not.toMatch(/mysql<|information_schema</);
    expect(html).toContain("themes/bssg");
    expect(home.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // Het thema-script staat vóór de stylesheets in de <head> (geen flits bij licht thema).
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toMatch(/<head>\s*<script src="[^"]*panel-theme\.js/);
    expect(html).not.toContain("cross_framing_protection");
    expect(html).not.toContain('id="cfs-style"');
    // En echt bewerken: de tabel lezen via de databasepagina's (token van phpMyAdmin uit de pagina).
    const tok = /name="token" value="([a-f0-9]+)"/.exec(html)?.[1] ?? /token=([a-f0-9]{32})/.exec(html)?.[1];
    expect(tok).toBeTruthy();
    const tbl = await (await get(`/index.php?route=/sql&db=s1_site&table=klanten&token=${tok}&ajax_request=true&_nocache=1`, cookie)).text();
    expect(tbl).toContain("Alice");
    // Een andere database blijft dicht voor deze gebruiker (MariaDB zelf weigert).
    const other = await (await get(`/index.php?route=/database/structure&db=s2_other&token=${tok}&ajax_request=true`, cookie)).text();
    expect(other).not.toContain("s2_other</");
    expect(other).toMatch(/denied|Access|#1044|error/i);
  });

  it("signon.php met ?db= springt naar die database; rare namen niet", async () => {
    const r = await get("/signon.php?db=s1_site&token=dbtk" + TOKEN.slice(4));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("index.php?route=/database/structure&db=s1_site");
    const bad = await get("/signon.php?db=" + encodeURIComponent("x&route=/server") + "&token=dbtk" + TOKEN.slice(4));
    expect(bad.headers.get("location") ?? "").not.toContain("route=/server");
  });

  it("panel-koppeling: thema-script en terugkeerpagina worden geserveerd", async () => {
    const js = await get("/panel-theme.js");
    expect(js.status).toBe(200);
    const src = await js.text();
    expect(src).toContain("panel_theme");
    expect(src).toContain("panel-embed");
    const ret = await get("/panel-return.html");
    expect(ret.status).toBe(200);
    expect(await ret.text()).toContain("panel-return.js");
    expect(await (await get("/panel-return.js")).text()).toContain("postMessage");
  });

  it("het thema bssg wordt geserveerd met het panellogo", async () => {
    const css = await (await get("/themes/bssg/css/theme.css")).text();
    expect(css).toContain("--pb-primary");
    expect(css).toContain("html.panel-light");
    expect(css).toContain("html.panel-embed");
    for (const img of ["logo_left.png", "logo_right.png"]) {
      const r = await get("/themes/bssg/img/" + img);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
    }
    // Eenvoudige check dat het logo niet het standaard phpMyAdmin-logo is (die is 165 px breed).
    const logo = Buffer.from(await (await get("/themes/bssg/img/logo_left.png")).arrayBuffer());
    expect(logo.readUInt32BE(16)).toBe(56);
  });

  it("geen versiecontrole of externe verwijzingen in de hoofdpagina; PHP-versie verborgen", async () => {
    const r = await get("/signon.php");
    expect(r.headers.get("x-powered-by")).toBeNull();
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
});
