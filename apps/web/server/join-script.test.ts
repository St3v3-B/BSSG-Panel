/** deploy/join/join.sh met --dry-run tegen een nep-panel: alles landt in een tijdelijke map. */
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../../..");
const SCRIPT = join(REPO, "deploy/join/join.sh");
const TOKEN = "T".repeat(20) + "o".repeat(20);
const CODE = "good-code-" + "c".repeat(22);

let srv: Server, url = "", work = "";
const progress: Array<{ state: string; auth?: string }> = [];
let supports = true;
let corrupt = false;
let bin = Buffer.from("#!/bin/sh\necho fake daemon\n");
let files: Buffer;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "join-test-"));
  // Bestanden zoals de Dockerfile ze in files.tar.gz stopt.
  const stage = join(work, "stage");
  mkdirSync(stage);
  cpSync(join(REPO, "deploy/docker-compose.node.yml"), join(stage, "docker-compose.node.yml"));
  cpSync(join(REPO, "deploy/systemd"), join(stage, "systemd"), { recursive: true });
  mkdirSync(join(stage, "caddy"));
  writeFileSync(join(stage, "caddy/Caddyfile.node"), "# test\n");
  execFileSync("tar", ["-czf", join(work, "files.tar.gz"), "-C", stage, "."]);
  files = readFileSync(join(work, "files.tar.gz"));

  srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const send = (s: number, b: string | Buffer, t = "application/json") => res.writeHead(s, { "content-type": t }).end(b);
      if (req.url === "/api/join/exchange") {
        const j = JSON.parse(body) as { code: string; ip: string };
        if (j.code !== CODE) return send(404, '{"error":"invalid_code"}');
        return send(200, JSON.stringify({ node_token: TOKEN, panel_url: url, node_domain: "n2.panel.test", acme_email: "admin@panel.test", daemon_port: 8080, sftp_port: 2022, supports_domains: supports, public_port: supports ? 443 : 8443, dns_mode: "manual", ip: j.ip }));
      }
      if (req.url === "/api/join/progress") {
        progress.push({ ...JSON.parse(body), auth: req.headers.authorization });
        return send(204, "");
      }
      if (/^\/join\/daemon\/(amd64|arm64)$/.test(req.url!)) return send(200, bin, "application/octet-stream");
      if (/^\/join\/daemon\/(amd64|arm64)\.sha256$/.test(req.url!)) return send(200, (corrupt ? "0".repeat(64) : sha(bin)) + "\n", "text/plain");
      if (req.url === "/join/files.tar.gz") return send(200, files, "application/gzip");
      if (req.url === "/join/files.tar.gz.sha256") return send(200, sha(files) + "\n", "text/plain");
      send(404, "nope", "text/plain");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => {
  srv?.closeAllConnections();
  srv?.close();
  rmSync(work, { recursive: true, force: true });
});

// Asynchroon: het nep-panel draait in dit proces en moet kunnen antwoorden terwijl het script loopt.
function join_(args: string[], root: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const p = spawn("bash", [SCRIPT, "--dry-run", "--yes", "--root", root, "--ip", "203.0.113.5", "--panel-url", url, ...args], { env: { ...process.env, JOIN_SKIP_WAIT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    const t = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.on("close", (status) => (clearTimeout(t), resolveP({ status, stdout, stderr })));
  });
}

describe("join.sh --dry-run", () => {
  it("installeert daemon (sha256 geverifieerd), unit en env; meldt voortgang met het token", async () => {
    progress.length = 0;
    supports = true;
    const root = join(work, "r1");
    const r = await join_([CODE], root);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(TOKEN); // het token verschijnt nergens in de uitvoer
    const binPath = join(root, "usr/local/bin/panel-daemon");
    expect(sha(readFileSync(binPath))).toBe(sha(bin));
    expect(statSync(binPath).mode & 0o777).toBe(0o755);
    expect(existsSync(join(root, "etc/systemd/system/panel-daemon.service"))).toBe(true);
    expect(existsSync(join(root, "opt/panel-node/docker-compose.node.yml"))).toBe(true);
    const envp = join(root, "etc/panel/panel.env");
    expect(statSync(envp).mode & 0o777).toBe(0o600);
    const env = readFileSync(envp, "utf8");
    expect(env).toContain(`NODE_TOKEN=${TOKEN}`);
    expect(env).toContain("NODE_DOMAIN=n2.panel.test");
    expect(env).toMatch(/MARIADB_ROOT_PASSWORD=[0-9a-f]{48}/);
    expect(env).toContain("CADDY_ADMIN_URL=unix:///run/panel/caddy-admin.sock");
    expect(env).not.toContain("DAEMON_TLS_PORT");
    expect(r.stdout).toContain("COMPOSE_PROFILES=caddy");
    expect(r.stdout).toContain("[dry-run] systemctl restart panel-daemon.service");
    expect(progress.map((p) => p.state)).toEqual(["docker", "dns", "download", "daemon", "certificate", "ready"]);
    expect(progress.every((p) => p.auth === `Bearer ${TOKEN}`)).toBe(true);
    // Opnieuw draaien houdt het MariaDB-wachtwoord.
    const pw = /MARIADB_ROOT_PASSWORD=(\w+)/.exec(env)![1];
    expect((await join_([CODE], root)).status).toBe(0);
    expect(readFileSync(envp, "utf8")).toContain(`MARIADB_ROOT_PASSWORD=${pw}`);
  });

  it("zonder domeinondersteuning: geen Caddy-profiel, daemon serveert https op de publieke poort", async () => {
    supports = false;
    const root = join(work, "r2");
    const r = await join_([CODE], root);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const env = readFileSync(join(root, "etc/panel/panel.env"), "utf8");
    expect(env).toContain("DAEMON_TLS_PORT=8443");
    expect(env).not.toContain("CADDY_ADMIN_URL");
    expect(r.stdout).toMatch(/COMPOSE_PROFILES= docker compose/);
    expect(r.stdout).toContain("https://n2.panel.test:8443");
    supports = true;
  });

  it("verkeerde sha256 stopt, laat geen binary achter en meldt failed", async () => {
    progress.length = 0;
    corrupt = true;
    const root = join(work, "r3");
    const r = await join_([CODE], root);
    corrupt = false;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("sha256 mismatch");
    expect(existsSync(join(root, "usr/local/bin/panel-daemon"))).toBe(false);
    expect(progress.at(-1)).toMatchObject({ state: "failed" });
  });

  it("ongeldige code: duidelijke fout, niets geïnstalleerd", async () => {
    const root = join(work, "r4");
    const r = await join_(["bad-code-" + "x".repeat(22)], root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("did not accept the join code");
    expect(existsSync(join(root, "etc/panel"))).toBe(false);
  });

  it("--uninstall weigert zonder markering van het join-script; met markering ruimt hij op", async () => {
    const root = join(work, "r5");
    mkdirSync(join(root, "etc/panel"), { recursive: true });
    writeFileSync(join(root, "etc/panel/panel.env"), "NODE_TOKEN=x\n");
    expect((await join_(["--uninstall"], root)).status).not.toBe(0);
    const ok = await join_([CODE], join(work, "r6"));
    expect(ok.status).toBe(0);
    const u = await join_(["--uninstall"], join(work, "r6"));
    expect(u.status, u.stderr).toBe(0);
    expect(u.stdout).toContain("[dry-run] systemctl disable --now panel-daemon.service");
    expect(u.stdout).toContain("[dry-run] rm -f");
    expect(u.stdout).not.toContain("rm -rf"); // zonder --purge geen data of configuratie weg
    expect(existsSync(join(work, "r6/etc/panel/panel.env"))).toBe(true); // zonder --purge blijft de configuratie
  });
});
