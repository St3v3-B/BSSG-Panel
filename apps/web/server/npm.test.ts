/**
 * Nginx Proxy Manager (panelkant): instellingen per node (versleuteld, nooit terug naar de browser), config voor de
 * daemon (alleen met het node-token), statusmeldingen, dashboard-alerts, "Test verbinding", rechten en de grenzen met
 * de HTTP(S)-relay.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as npmConfig } from "@/app/api/remote/npm/route";
import { POST as npmReport } from "@/app/api/remote/npm/status/route";
import { getDb, schema } from "./db";
import { daemonUrlOverrides } from "./daemon";
import { exchangeJoinCode } from "./join";
import { FakeDaemon } from "./test/fake-daemon";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, player: TestUser;
let nodeB = 0, tokenB = "";
let d2: FakeDaemon;

const req = (path: string, token: string, body?: unknown) =>
  new Request(`http://panel.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({}) } as never;
const nodeRow = async (id: number) => (await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0]!;
const npmRefreshes = (d: FakeDaemon) => d.requests.filter((r) => r.method === "POST" && r.path === "/api/npm/refresh").length;

const settings = { url: "http://127.0.0.1:81", email: "npm-admin@panel.test", password: "npm-good", forwardHost: null, forwardPort: null, ssl: "http" as const, forceSsl: true };

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000002", name: "speler" });
  const b = await admin.api.admin.nodes.create({ name: "node2", fqdn: "node2.test", daemonPort: 8080, sftpPort: 2023, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
  nodeB = b.node.id;
  tokenB = b.token;
  d2 = new FakeDaemon(b.token);
  daemonUrlOverrides.set(nodeB, await d2.start());
}, 180_000);
afterAll(async () => {
  daemonUrlOverrides.clear();
  await d2?.stop();
});

describe("Nginx Proxy Manager", () => {
  it("alleen admins (met TOTP)", async () => {
    await expect(player.api.admin.nodes.npmStatus({ id: nodeB })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.admin.nodes.setNpm({ id: nodeB, settings })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.admin.nodes.testNpm({ id: nodeB, ...settings })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("zonder instellingen: direct, config enabled=false", async () => {
    const st = await admin.api.admin.nodes.npmStatus({ id: nodeB });
    expect(st).toEqual({ settings: null, report: null, modeCommand: null });
    expect((await admin.api.admin.nodes.get({ id: nodeB })).httpMode).toBe("direct");
    const res = await npmConfig(req("/api/remote/npm", tokenB), params);
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("eerste keer zonder wachtwoord of Cloudflare zonder token: geweigerd", async () => {
    const { password: _p, ...noPw } = settings;
    await expect(admin.api.admin.nodes.setNpm({ id: nodeB, settings: noPw })).rejects.toMatchObject({ message: "NPM_PASSWORD_REQUIRED" });
    await expect(admin.api.admin.nodes.setNpm({ id: nodeB, settings: { ...settings, ssl: "cloudflare" } })).rejects.toMatchObject({ message: "CLOUDFLARE_TOKEN_REQUIRED" });
    await expect(admin.api.admin.nodes.setNpm({ id: nodeB, settings: { ...settings, url: "ftp://x" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("aanzetten: versleuteld bewaard, nooit terug naar de browser, daemon gepord", async () => {
    const before = npmRefreshes(d2);
    const st = await admin.api.admin.nodes.setNpm({ id: nodeB, settings: { ...settings, ssl: "cloudflare", cloudflareToken: "cf-secret-token" } });
    expect(st.settings).toEqual({ url: "http://127.0.0.1:81", email: "npm-admin@panel.test", forwardHost: null, forwardPort: null, ssl: "cloudflare", forceSsl: true, hasPassword: true, hasCloudflareToken: true });
    expect(st.modeCommand).toMatch(/--http-mode npm$/);
    expect(JSON.stringify(st)).not.toContain("npm-good");
    expect(JSON.stringify(st)).not.toContain("cf-secret-token");
    const row = await nodeRow(nodeB);
    expect(row.npmPasswordEnc).toBeTruthy();
    expect(row.npmPasswordEnc).not.toContain("npm-good");
    expect(row.npmCloudflareTokenEnc).not.toContain("cf-secret-token");
    expect(JSON.stringify(row.npmSettings)).not.toContain("npm-good");
    expect(row.supportsDomains).toBe(true);
    expect(row.publicPort).toBe(443);
    await vi.waitFor(() => expect(npmRefreshes(d2)).toBeGreaterThan(before));
    // Ook niet via nodes.get/list of in het activiteitenlog.
    const all = JSON.stringify([await admin.api.admin.nodes.get({ id: nodeB }), await admin.api.admin.nodes.list()]);
    expect(all).not.toContain("npm-good");
    expect((await admin.api.admin.nodes.get({ id: nodeB })).httpMode).toBe("npm");
    const logs = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "admin.node.npm"));
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain("npm-good");
    expect(JSON.stringify(logs)).not.toContain("cf-secret-token");
  });

  it("opnieuw opslaan zonder wachtwoord houdt het oude; Cloudflare-token wissen met \"\"", async () => {
    const { password: _p, ...noPw } = settings;
    const st = await admin.api.admin.nodes.setNpm({ id: nodeB, settings: { ...noPw, cloudflareToken: "" } });
    expect(st.settings).toMatchObject({ hasPassword: true, hasCloudflareToken: false, ssl: "http" });
    const cfg = await (await npmConfig(req("/api/remote/npm", tokenB), params)).json();
    expect(cfg).toMatchObject({ enabled: true, url: "http://127.0.0.1:81", email: "npm-admin@panel.test", password: "npm-good", ssl: "http", cloudflare_token: "", force_ssl: true, fixed_hosts: ["node2.test"] });
  });

  it("config alleen met het node-token; de lokale node krijgt ook het panel-domein", async () => {
    expect((await npmConfig(req("/api/remote/npm", "wrong-token"), params)).status).toBe(401);
    await admin.api.admin.nodes.setNpm({ id: h.localNodeId, settings });
    const cfg = await (await npmConfig(req("/api/remote/npm", h.env.NODE_TOKEN!), params)).json();
    expect(cfg.fixed_hosts).toEqual([h.env.NODE_DOMAIN, h.env.PANEL_DOMAIN]);
    expect((await admin.api.admin.nodes.npmStatus({ id: h.localNodeId })).modeCommand).toMatch(/install\.sh --http-mode npm$/);
    await admin.api.admin.nodes.setNpm({ id: h.localNodeId, settings: null });
  });

  it("statusmelding van de daemon: zichtbaar in npmStatus en als dashboard-alert", async () => {
    const report = { http_mode: "npm", configured: true, state: "ok", version: "2.17.1", proxy_hosts: 5, managed_hosts: 2, conflicts: ["shop.node2.test"], hosts: [{ host: "node2.test", ssl: "active" }, { host: "shop.node2.test", ssl: "failed", error: "already exists", conflict: true }] };
    expect((await npmReport(req("/api/remote/npm/status", tokenB, report), params)).status).toBe(204);
    const st = await admin.api.admin.nodes.npmStatus({ id: nodeB });
    expect(st.report).toMatchObject({ state: "ok", version: "2.17.1", proxyHosts: 5, managedHosts: 2, conflicts: ["shop.node2.test"], httpMode: "npm" });
    expect(st.report!.hosts).toEqual([{ host: "node2.test", ssl: "active", error: null }, { host: "shop.node2.test", ssl: "failed", error: "already exists" }]);
    let dash = await admin.api.admin.dashboard();
    expect(dash.alerts.find((a) => a.kind === "npm_error" && a.nodeId === nodeB)?.message).toMatch(/1 domain\(s\) already exist/);

    await npmReport(req("/api/remote/npm/status", tokenB, { ...report, state: "login_failed", error: "NPM answered 401: Invalid email or password", conflicts: [] }), params);
    dash = await admin.api.admin.dashboard();
    expect(dash.alerts.find((a) => a.kind === "npm_error" && a.nodeId === nodeB)?.message).toMatch(/login failed/);

    await npmReport(req("/api/remote/npm/status", tokenB, { ...report, http_mode: "direct", conflicts: [] }), params);
    dash = await admin.api.admin.dashboard();
    expect(dash.alerts.find((a) => a.kind === "npm_error" && a.nodeId === nodeB)?.message).toMatch(/mode command/);

    await npmReport(req("/api/remote/npm/status", tokenB, { ...report, conflicts: [] }), params);
    dash = await admin.api.admin.dashboard();
    expect(dash.alerts.find((a) => a.kind === "npm_error" && a.nodeId === nodeB)).toBeUndefined();
    expect((await npmReport(req("/api/remote/npm/status", tokenB, { nope: 1 }), params)).status).toBe(400);
  });

  it("Test verbinding via de daemon, met het bewaarde wachtwoord als het ontbreekt", async () => {
    expect(await admin.api.admin.nodes.testNpm({ id: nodeB })).toEqual({ state: "ok", error: null, version: "2.17.1", proxyHosts: 3, managedHosts: 1 });
    const sent = d2.requests.filter((r) => r.path === "/api/npm/test").at(-1)!.body as Record<string, string>;
    expect(sent).toEqual({ url: "http://127.0.0.1:81", email: "npm-admin@panel.test", password: "npm-good" });
    expect(await admin.api.admin.nodes.testNpm({ id: nodeB, password: "wrong" })).toMatchObject({ state: "login_failed" });
    daemonUrlOverrides.set(nodeB, "http://127.0.0.1:1");
    await expect(admin.api.admin.nodes.testNpm({ id: nodeB })).rejects.toMatchObject({ message: expect.stringMatching(/DAEMON_UNREACHABLE/) });
    daemonUrlOverrides.set(nodeB, d2.url);
  });

  it("niet samen met een HTTP(S)-relay; NPM-node is geen relay-kandidaat", async () => {
    await expect(admin.api.admin.nodes.setHttpRelay({ id: nodeB, relayNodeId: h.localNodeId })).rejects.toMatchObject({ message: expect.stringMatching(/^RELAY_NOT_ALLOWED.*Nginx Proxy Manager/) });
    const c = await admin.api.admin.nodes.create({ name: "node3", fqdn: "node3.test", daemonPort: 8080, sftpPort: 2024, maxRamMb: 0, maxDiskMb: 0, s3TargetId: null });
    const st = await admin.api.admin.nodes.relayStatus({ id: c.node.id });
    expect(st.candidates.map((x) => x.id)).not.toContain(nodeB);
    await expect(admin.api.admin.nodes.setHttpRelay({ id: c.node.id, relayNodeId: nodeB })).rejects.toMatchObject({ message: expect.stringMatching(/Nginx Proxy Manager/) });
    await admin.api.admin.nodes.setHttpRelay({ id: c.node.id, relayNodeId: h.localNodeId });
    await expect(admin.api.admin.nodes.setNpm({ id: c.node.id, settings })).rejects.toMatchObject({ message: expect.stringMatching(/^NPM_NOT_ALLOWED/) });
    await admin.api.admin.nodes.setHttpRelay({ id: c.node.id, relayNodeId: null });
    await admin.api.admin.nodes.delete({ id: c.node.id });
  });

  it("join van een node achter NPM: http_mode npm", async () => {
    const j = await admin.api.admin.nodes.createJoin({ name: "node4", fqdn: "node4.test" });
    await admin.api.admin.nodes.setNpm({ id: j.node.id, settings });
    const code = j.joinCommand.split(" ").at(-1)!;
    const r = await exchangeJoinCode(code, "203.0.113.44");
    expect(r).toMatchObject({ http_mode: "npm", supports_domains: true, public_port: 443 });
  });

  it("uitzetten: terug naar direct, geheimen weg", async () => {
    const st = await admin.api.admin.nodes.setNpm({ id: nodeB, settings: null });
    expect(st.settings).toBeNull();
    const row = await nodeRow(nodeB);
    expect(row.npmPasswordEnc).toBeNull();
    expect(row.npmCloudflareTokenEnc).toBeNull();
    expect((await admin.api.admin.nodes.get({ id: nodeB })).httpMode).toBe("direct");
    expect(await (await npmConfig(req("/api/remote/npm", tokenB), params)).json()).toEqual({ enabled: false });
  });
});
