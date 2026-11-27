import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { parsePhpIni, renderNginxConf, renderPhpIni, validTimezone, PHP_DEFAULTS } from "./lib/php-settings";
import { tick } from "./scheduler";
import { OWNER, useHarness, WEB_TEMPLATE, type TestUser } from "./test/harness";

const PHP_TEMPLATE = WEB_TEMPLATE.replace("slug: testweb", "slug: php-8-3").replace("name: Testsite", "name: PHP 8.3");
const h = useHarness({ templates: { "web/php-8-3.yaml": PHP_TEMPLATE } });
let admin: TestUser, owner: TestUser, sched: TestUser, other: TestUser;
let php = "", plain = "", game = "";
const limits = { cpuPct: 100, ramMb: 512, swapMb: 0, diskMb: 1024 };
const setState = (uuid: string, state: "online" | "offline") => (h.daemon.servers.get(uuid)!.state = state);
const mk = async (tpl: string, name: string, allocationIds: number[] = []) =>
  (await admin.api.admin.servers.create({ name, ownerId: owner.id, nodeId: h.localNodeId, templateId: await h.templateId(tpl), limits, allocationIds, variables: {}, startOnInstall: false })).uuid;

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  owner = await h.user({ discordId: "310000000000000001", name: "siteowner" });
  sched = await h.user({ discordId: "310000000000000002", name: "cron" });
  other = await h.user({ discordId: "310000000000000003", name: "vreemde" });
  php = await mk("php-8-3", "PHP site");
  plain = await mk("testweb", "Plain site");
  game = await mk("testgame", "Game", [await h.allocation(25700)]);
  await owner.api.subusers.invite({ uuid: php, who: sched.discordId, permissions: ["schedule.manage"] });
  await owner.api.subusers.invite({ uuid: plain, who: sched.discordId, permissions: ["schedule.manage"] });
}, 120_000);

const S = { memoryLimitMb: 384, uploadMaxMb: 128, maxExecutionTime: 90, maxInputVars: 5000, displayErrors: true, timezone: "UTC", opcache: false, disabledExtensions: ["exif" as const] };

describe("php-settings lib", () => {
  it("render/parse round trip and validation", () => {
    const ini = renderPhpIni(S);
    expect(ini).toMatch(/^; Managed by the panel/);
    expect(ini).toContain("post_max_size = 128M");
    expect(parsePhpIni(ini, PHP_DEFAULTS)).toEqual({ ...S, disabledExtensions: [] });
    expect(renderNginxConf(S)).toContain("client_max_body_size 128M;");
    expect(validTimezone("Europe/Amsterdam")).toBe(true);
    expect(validTimezone("Mars/Olympus")).toBe(false);
    expect(validTimezone("UTC\nevil = 1")).toBe(false);
  });
});

describe("siteSettings.php", () => {
  it("defaults until saved; save writes ini + nginx include + disabled extensions; restart only when running", async () => {
    const before = await owner.api.siteSettings.php({ uuid: php });
    expect(before).toMatchObject({ managed: false, ramLimitMb: 512, settings: { memoryLimitMb: 256, uploadMaxMb: 64, timezone: "Europe/Amsterdam", opcache: true, disabledExtensions: [] } });
    setState(php, "offline");
    await owner.api.siteSettings.updatePhp({ uuid: php, settings: S });
    expect(h.daemon.requests.filter((r) => r.method === "POST" && r.path === `/api/servers/${php}/power`)).toHaveLength(0);
    const f = h.daemon.fs(php).files;
    expect(f.get("/php/00-panel.ini")).toContain("memory_limit = 384M");
    expect(f.get("/nginx/00-panel.conf")).toContain("client_max_body_size 128M;");
    expect(f.get("/php/.disabled-extensions")).toBe("exif\n");
    // the daemon spec and variables follow
    expect(h.daemon.last("PUT", `/api/servers/${php}`)!.body).toBeTruthy();
    const after = await owner.api.siteSettings.php({ uuid: php });
    expect(after).toMatchObject({ managed: true, settings: S });
    // restart when running
    setState(php, "online");
    await owner.api.siteSettings.updatePhp({ uuid: php, settings: { ...S, displayErrors: false } });
    expect(h.daemon.last("POST", `/api/servers/${php}/power`)!.body).toEqual({ action: "restart" });
    const log = (await admin.api.admin.activity.search({ serverUuid: php, action: "server.php.update" })).items;
    expect(log[0]!.metadata).toMatchObject({ restarted: true });
  });

  it("bounds, permissions, non-PHP sites, suspension", async () => {
    await expect(owner.api.siteSettings.updatePhp({ uuid: php, settings: { ...S, memoryLimitMb: 1024 } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "MEMORY_EXCEEDS_RAM" });
    await expect(owner.api.siteSettings.updatePhp({ uuid: php, settings: { ...S, timezone: "Mars/Olympus" } })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_TIMEZONE" });
    await expect(owner.api.siteSettings.updatePhp({ uuid: php, settings: { ...S, uploadMaxMb: 0 } })).rejects.toBeTruthy();
    await expect(owner.api.siteSettings.updatePhp({ uuid: php, settings: { ...S, maxExecutionTime: 301 } })).rejects.toBeTruthy();
    await expect(sched.api.siteSettings.updatePhp({ uuid: php, settings: S })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(other.api.siteSettings.php({ uuid: php })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(owner.api.siteSettings.php({ uuid: plain })).rejects.toMatchObject({ message: "NOT_PHP_SITE" });
    await expect(owner.api.siteSettings.php({ uuid: game })).rejects.toMatchObject({ message: "NOT_PHP_SITE" });
    await admin.api.admin.servers.setSuspended({ uuid: php, suspended: true, reason: "test" });
    await expect(owner.api.siteSettings.updatePhp({ uuid: php, settings: S })).rejects.toMatchObject({ code: "FORBIDDEN", message: "SUSPENDED" });
    expect(await owner.api.siteSettings.php({ uuid: php })).toBeTruthy(); // reading stays possible
    expect(await admin.api.siteSettings.updatePhp({ uuid: php, settings: S })).toEqual({ ok: true });
    await admin.api.admin.servers.setSuspended({ uuid: php, suspended: false, reason: null });
  });
});

describe("schedules exec", () => {
  const input = { name: "WP cron", cron: "*/5 * * * *", action: "exec" as const, payload: "php /home/container/public/wp-cron.php", active: true };

  it("only for websites, needs a command and schedule.manage", async () => {
    await expect(owner.api.schedules.create({ uuid: game, ...input })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "EXEC_WEB_ONLY" });
    await expect(owner.api.schedules.create({ uuid: php, ...input, payload: null })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "COMMAND_REQUIRED" });
    await expect(owner.api.schedules.create({ uuid: php, ...input, payload: "a\nb" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(other.api.schedules.create({ uuid: php, ...input })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await admin.api.admin.servers.setSuspended({ uuid: php, suspended: true, reason: "x" });
    await expect(sched.api.schedules.create({ uuid: php, ...input })).rejects.toMatchObject({ code: "FORBIDDEN", message: "SUSPENDED" });
    await admin.api.admin.servers.setSuspended({ uuid: php, suspended: false, reason: null });
    const s = await sched.api.schedules.create({ uuid: php, ...input });
    expect(s).toMatchObject({ action: "exec", payload: input.payload, lastOutput: null });
    await sched.api.schedules.delete({ id: s.id });
  });

  it("runNow stores result and output tail; failure and timeout are reported; tick runs it", async () => {
    setState(php, "online");
    const s = await sched.api.schedules.create({ uuid: php, ...input });
    h.daemon.execResult = { exit_code: 0, output: "x".repeat(6000) + "END", truncated: false, timed_out: false, duration_ms: 3 };
    await sched.api.schedules.runNow({ id: s.id });
    const req = h.daemon.last("POST", `/api/servers/${php}/exec`)!;
    expect(req.body).toEqual({ command: input.payload, timeout_seconds: 120 });
    let row = (await sched.api.schedules.list({ uuid: php })).find((x) => x.id === s.id)!;
    expect(row.lastResult).toBe("ok");
    expect(row.lastOutput!.length).toBe(4000);
    expect(row.lastOutput!.endsWith("END")).toBe(true);

    h.daemon.execResult = { exit_code: 2, output: "boom\n", truncated: false, timed_out: false, duration_ms: 3 };
    await expect(sched.api.schedules.runNow({ id: s.id })).rejects.toMatchObject({ message: expect.stringContaining("exit code 2") });
    row = (await sched.api.schedules.list({ uuid: php })).find((x) => x.id === s.id)!;
    expect(row).toMatchObject({ lastResult: "error: exit code 2", lastOutput: "boom\n" });

    h.daemon.execResult = { exit_code: -1, output: "", truncated: false, timed_out: true, duration_ms: 120000 };
    await expect(sched.api.schedules.runNow({ id: s.id })).rejects.toMatchObject({ message: expect.stringContaining("timeout") });

    h.daemon.execResult = { exit_code: 0, output: "tick", truncated: false, timed_out: false, duration_ms: 1 };
    await getDb().update(schema.schedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(schema.schedules.id, s.id));
    expect(await tick()).toBeGreaterThanOrEqual(1);
    row = (await sched.api.schedules.list({ uuid: php })).find((x) => x.id === s.id)!;
    expect(row).toMatchObject({ lastResult: "ok", lastOutput: "tick" });

    // site not running: error stored
    setState(php, "offline");
    await expect(sched.api.schedules.runNow({ id: s.id })).rejects.toBeTruthy();
    expect((await sched.api.schedules.list({ uuid: php })).find((x) => x.id === s.id)!.lastResult).toMatch(/^error: /);
    await sched.api.schedules.delete({ id: s.id });
  });
});
