// join.sh (dry-run) tegen een nep-panel: HTTP(S) via een relay-node en het omzetten van een geïnstalleerde node.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const SRC = join(__dirname, "../../../deploy/join/join.sh");
const hasDocker = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let panel: Server;
let url = "";
let answer: Record<string, unknown> = {};
const files: Record<string, Buffer> = {};

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), "join-relay-"));
  mkdirSync(join(work, "files/systemd"), { recursive: true });
  writeFileSync(join(work, "files/systemd/panel-daemon.service"), "[Unit]\nDescription=test\n");
  writeFileSync(join(work, "files/docker-compose.node.yml"), "services: {}\n");
  execFileSync("tar", ["-czf", join(work, "files.tar.gz"), "-C", join(work, "files"), "."]);
  files["/join/files.tar.gz"] = readFileSync(join(work, "files.tar.gz"));
  files["/join/daemon/amd64"] = Buffer.from("#!/bin/sh\necho daemon\n");
  files["/join/daemon/arm64"] = files["/join/daemon/amd64"];
  for (const [k, v] of Object.entries({ ...files })) files[`${k}.sha256`] = Buffer.from(`${createHash("sha256").update(v).digest("hex")}  x\n`);
  panel = createServer((req, res) => {
    const p = req.url!.split("?")[0]!;
    if (req.method === "POST" && p === "/api/join/exchange") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    if (req.method === "POST" && p === "/api/join/progress") return res.writeHead(204).end();
    const f = files[p];
    if (f) return res.writeHead(200).end(f);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => panel.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
});
afterAll(() => panel?.close());

const base = (over: Record<string, unknown> = {}) => ({
  node_token: "t".repeat(43), panel_url: "https://panel.test", node_domain: "node2.test", acme_email: "admin@panel.test",
  daemon_port: 8080, sftp_port: 2022, supports_domains: true, public_port: 443, dns_mode: "manual", ...over,
});
const join_ = (root: string, ...args: string[]) => run("bash", [SRC, "--dry-run", "--yes", "--root", root, "--ip", "192.0.2.50", "--panel-url", url, ...args], { env: { ...process.env, JOIN_SKIP_WAIT: "1" } });

describe.skipIf(!hasDocker)("join.sh met HTTP(S)-relay (dry-run)", () => {
  it("relay: Caddy zonder publieke poorten, DNS naar de relay-node, HTTP_MODE=relay", async () => {
    answer = base({ http_mode: "relay", dns_ip: "198.51.100.1" });
    const root = mkdtempSync(join(tmpdir(), "join-root-"));
    const { stdout } = await join_(root, "code-1");
    expect(stdout).toMatch(/HTTP: relay/);
    expect(stdout).toMatch(/node2\.test must point to 198\.51\.100\.1/);
    expect(stdout).toMatch(/COMPOSE_PROFILES=caddy-relay docker compose/);
    expect(stdout).toMatch(/ports 80\/443 of this machine are not used/);
    const env = readFileSync(join(root, "etc/panel/panel.env"), "utf8");
    expect(env).toMatch(/^HTTP_MODE=relay$/m);
    expect(env).toMatch(/^CADDY_ADMIN_URL=unix:\/\/\/run\/panel\/caddy-admin\.sock$/m);

    // Terug naar eigen poorten zonder join-code.
    const sw = await run("bash", [SRC, "--dry-run", "--root", root, "--http-mode", "direct"]);
    expect(sw.stdout).toMatch(/COMPOSE_PROFILES=caddy-relay docker compose .* rm -sf caddy-relay/);
    expect(sw.stdout).toMatch(/COMPOSE_PROFILES=caddy docker compose .* up -d --build/);
    expect(readFileSync(join(root, "etc/panel/panel.env"), "utf8")).toMatch(/^HTTP_MODE=direct$/m);
    expect(readFileSync(join(root, "etc/panel/panel.env"), "utf8").match(/^HTTP_MODE=/gm)).toHaveLength(1);
  });

  it("oud panel (zonder http_mode): direct zoals voorheen; --no-public-http weigert dan", async () => {
    answer = base();
    const root = mkdtempSync(join(tmpdir(), "join-root-"));
    const { stdout } = await join_(root, "code-2");
    expect(stdout).toMatch(/COMPOSE_PROFILES=caddy docker compose/);
    expect(readFileSync(join(root, "etc/panel/panel.env"), "utf8")).toMatch(/^HTTP_MODE=direct$/m);
    await expect(join_(mkdtempSync(join(tmpdir(), "join-root-")), "--no-public-http", "code-3")).rejects.toMatchObject({ stderr: expect.stringMatching(/not set to run its HTTP\(S\) through a relay node/) });
  });

  it("npm (van het panel): Caddy HTTP-only op NPM_CADDY_ADDR, alleen SFTP in de firewall, omzetten terug naar direct", async () => {
    answer = base({ http_mode: "npm", dns_ip: "192.0.2.50" });
    const root = mkdtempSync(join(tmpdir(), "join-root-"));
    const { stdout } = await join_(root, "code-4", "--npm-caddy-addr", "10.9.0.1:8081");
    expect(stdout).toMatch(/HTTP: npm/);
    expect(stdout).toMatch(/behind Nginx Proxy Manager: NPM keeps ports 80\/443/);
    expect(stdout).toMatch(/COMPOSE_PROFILES=caddy-npm docker compose/);
    const env = readFileSync(join(root, "etc/panel/panel.env"), "utf8");
    expect(env).toMatch(/^HTTP_MODE=npm$/m);
    expect(env).toMatch(/^NPM_CADDY_ADDR=10\.9\.0\.1:8081$/m);
    expect(env).not.toMatch(/NPM_PASSWORD|npm_password/i);
    const sw = await run("bash", [SRC, "--dry-run", "--root", root, "--http-mode", "direct"]);
    expect(sw.stdout).toMatch(/COMPOSE_PROFILES=caddy-npm docker compose .* rm -sf caddy-npm/);
    expect(sw.stdout).toMatch(/COMPOSE_PROFILES=caddy docker compose .* up -d --build/);
    expect(readFileSync(join(root, "etc/panel/panel.env"), "utf8")).toMatch(/^HTTP_MODE=direct$/m);
    const back = await run("bash", [SRC, "--dry-run", "--root", root, "--http-mode", "npm"]);
    expect(back.stdout).toMatch(/COMPOSE_PROFILES=caddy-npm docker compose .* up -d --build/);
    expect(back.stdout).toMatch(/Caddy listens without TLS on 10\.9\.0\.1:8081/);
  });

  it("--http-mode npm bij de join wint van direct; relay van het panel kan niet worden overschreven", async () => {
    answer = base({ http_mode: "direct", dns_ip: "192.0.2.50" });
    const root = mkdtempSync(join(tmpdir(), "join-root-"));
    const { stdout } = await join_(root, "code-5", "--http-mode", "npm");
    expect(stdout).toMatch(/using npm instead of direct/);
    expect(stdout).toMatch(/COMPOSE_PROFILES=caddy-npm docker compose/);
    expect(readFileSync(join(root, "etc/panel/panel.env"), "utf8")).toMatch(/^NPM_CADDY_ADDR=.+:8081$/m);
    answer = base({ http_mode: "relay", dns_ip: "198.51.100.1" });
    await expect(join_(mkdtempSync(join(tmpdir(), "join-root-")), "code-6", "--http-mode", "npm")).rejects.toMatchObject({ stderr: expect.stringMatching(/relay node/) });
    await expect(join_(mkdtempSync(join(tmpdir(), "join-root-")), "code-7", "--http-mode", "relay")).rejects.toMatchObject({ stderr: expect.stringMatching(/direct or npm/) });
  });
});
