/**
 * End-to-end check of the WordPress app against the real php-8.3 web template, run the way the daemon
 * runs it (install container as root, runtime as uid 1000, read-only rootfs, tmpfs /tmp) with a throw-away
 * MariaDB. Uses the real wordpress.org (download + checksum) and takes a few minutes (builds the PHP
 * extensions). Opt-in: APPS_E2E=1 TEST_AGENT=apps pnpm --filter @panel/web vitest run server/apps/wordpress.e2e
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplate } from "@panel/api";
import { createConnection } from "mariadb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT } from "../test/docker-pg";
import { appById } from "./catalog";
import { install } from "./engine";
import { localTarget } from "./local-target";

const run = process.env.APPS_E2E ? describe : describe.skip;
const inst = `${AGENT}-wpe2e-${process.pid}-${randomBytes(3).toString("hex")}`;
const labels = ["--label", "panel.test=true", "--label", `panel.instance=${inst}`, "--label", `panel.agent=${AGENT}`];
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8", timeout: 900_000 }).trim();
const ROOT_PW = "e2e-root-pw";
const parsed = parseTemplate(readFileSync(join(__dirname, "../../../../templates/web/php-8.3.yaml"), "utf8"));
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const tpl = parsed.spec;

let vol = "";
let port = 0;
let mariaPort = 0;
const net = `${inst}-net`;

const expand = (s: string, vars: Record<string, string>) => s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => vars[k] ?? "");

run("WordPress on the php-8.3 template (Docker)", () => {
  beforeAll(async () => {
    vol = mkdtempSync(join(tmpdir(), "wp-e2e-"));
    chmodSync(vol, 0o755);
    docker("network", "create", ...labels, net);
    docker("run", "-d", "--rm", "--name", `${inst}-db`, ...labels, "--network", net, "--network-alias", "panel-mariadb", "-e", `MARIADB_ROOT_PASSWORD=${ROOT_PW}`, "-p", "127.0.0.1::3306", "mariadb:11", "--innodb-buffer-pool-size=32M", "--performance-schema=OFF");
    mariaPort = Number(docker("port", `${inst}-db`, "3306/tcp").split("\n")[0]!.split(":").pop());
    const vars: Record<string, string> = { SERVER_MEMORY: "512", TZ: "Europe/Amsterdam" };
    for (const v of tpl.variables) vars[v.key] = v.default;
    const env = Object.entries({ HOME: "/home/container", ...vars }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // 1. the template's own install (builds mysqli/gd/intl/exif, default page)
    docker("run", "--rm", "--name", `${inst}-install`, "--user", "0:0", ...labels, ...env, "-v", `${vol}:/home/container`, "-w", "/home/container", "--entrypoint", "/bin/sh", tpl.install.image, "-c", tpl.install.script);
    // 2. the app install (real download from wordpress.org, real checksum)
    for (let i = 0; i < 60; i++) {
      try {
        await createConnection({ host: "127.0.0.1", port: mariaPort, user: "root", password: ROOT_PW }).then((c) => c.end());
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }, 900_000);

  afterAll(() => {
    try {
      const ids = docker("ps", "-aq", "--filter", "label=panel.test=true", "--filter", `label=panel.instance=${inst}`).split("\n").filter(Boolean);
      if (ids.length) docker("rm", "-f", ...ids);
      docker("network", "rm", net);
    } catch {
      /* best effort */
    }
    if (vol) rmSync(vol, { recursive: true, force: true });
  });

  it("installs, boots, completes the setup on the first request and lets the admin log in", async () => {
    const dbInfo = { host: "panel-mariadb", port: 3306, name: "s1_wordpress", user: "u1_wp", password: "Pw-" + randomBytes(6).toString("hex") };
    const out = await install({
      def: appById("wordpress")!,
      target: localTarget(vol),
      replaceExisting: false,
      siteName: "E2E Blog",
      domains: ["blog.panel.test"],
      admin: { username: "boss", email: "boss@panel.test" },
      tmpName: ".panel-app-1",
      step: () => {},
      provisionDb: async () => {
        const c = await createConnection({ host: "127.0.0.1", port: mariaPort, user: "root", password: ROOT_PW });
        await c.query(`CREATE DATABASE \`${dbInfo.name}\``);
        await c.query("CREATE USER ?@'%' IDENTIFIED BY ?", [dbInfo.user, dbInfo.password]);
        await c.query(`GRANT ALL ON \`${dbInfo.name}\`.* TO ?@'%'`, [dbInfo.user]);
        await c.end();
        return { db: dbInfo, rollback: async () => {} };
      },
    });
    expect(out.adminPassword).toBeTruthy();
    expect(out.version).toMatch(/^\d+\.\d+/);
    execFileSync("chown", ["-R", "1000:1000", vol]);

    // 3. runtime exactly like the daemon: uid 1000, read-only rootfs, tmpfs /tmp
    const vars: Record<string, string> = { SERVER_MEMORY: "512", TZ: "Europe/Amsterdam" };
    for (const v of tpl.variables) vars[v.key] = v.default;
    const env = Object.entries({ HOME: "/home/container", ...vars }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    docker("run", "-d", "-i", "--name", `${inst}-site`, "--user", "1000:1000", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "512m", "--network", net, ...labels, ...env, "-v", `${vol}:/home/container`, "-w", "/home/container", "-p", "127.0.0.1::8080", "--entrypoint", "/bin/sh", tpl.image, "-c", expand(tpl.startup, vars));
    port = Number(docker("port", `${inst}-site`, "8080/tcp").split("\n")[0]!.split(":").pop());
    for (let i = 0; i < 120; i++) {
      if (/PHP-FPM and nginx ready/.test(docker("logs", `${inst}-site`))) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const base = `http://127.0.0.1:${port}`;
    // (fetch cannot override Host, so the site address WordPress guesses is the mapped port.)
    const site = `https://127.0.0.1:${port}`;
    const hdr = { "x-forwarded-proto": "https" };
    // first request completes the setup (then redirects to itself)
    const first = await fetch(`${base}/`, { headers: hdr, redirect: "manual" });
    expect(first.status, await first.text()).toBe(302);
    const home = await fetch(`${base}/`, { headers: hdr });
    const html = await home.text();
    expect(home.status).toBe(200);
    expect(html).toContain("E2E Blog");
    expect(html).toContain(site); // https behind the proxy (X-Forwarded-Proto)
    expect(html).not.toContain(`http://127.0.0.1:${port}`);
    // the password file is gone, wp-config is outside public/
    expect(() => readFileSync(join(vol, ".panel-wp-setup.json"))).toThrow();
    expect((await fetch(`${base}/wp-config.php`, { headers: hdr })).status).toBe(404);
    // admin can log in
    const login = await fetch(`${base}/wp-login.php`, { method: "POST", headers: { ...hdr, "content-type": "application/x-www-form-urlencoded", cookie: "wordpress_test_cookie=WP%20Cookie%20check" }, body: new URLSearchParams({ log: "boss", pwd: out.adminPassword!, "wp-submit": "Log In", redirect_to: `${site}/wp-admin/` }), redirect: "manual" });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(`${site}/wp-admin/`);
    const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const dash = await fetch(`${base}/wp-admin/`, { headers: { ...hdr, cookie: cookies } });
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("Dashboard");
    // wrong password does not
    const bad = await fetch(`${base}/wp-login.php`, { method: "POST", headers: { ...hdr, "content-type": "application/x-www-form-urlencoded", cookie: "wordpress_test_cookie=WP%20Cookie%20check" }, body: new URLSearchParams({ log: "boss", pwd: "wrong", "wp-submit": "Log In" }), redirect: "manual" });
    expect(bad.status).toBe(200);
  }, 300_000);
});
