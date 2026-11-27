import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OWNER, useHarness, type TestUser } from "./test/harness";
import { githubTransport, githubRepo, resetCiCache, summarizeRuns } from "./updates";

const h = useHarness();
let admin: TestUser, player: TestUser;

const sha = (c: string) => c.repeat(40);
const ORIGIN = "git@github.com:St3v3-B/BSSG-Panel.git";
let upgradeRunning = false;
let started: unknown[] = [];
let ghCalls: string[] = [];
let ghRuns: Record<string, Array<{ status: string; conclusion: string | null }>> = {};
const realFetch = githubTransport.fetch;

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  player = await h.user({ discordId: "290000000000000021", name: "speler" });
});

beforeEach(() => {
  resetCiCache();
  upgradeRunning = false;
  started = [];
  ghCalls = [];
  ghRuns = { [sha("a")]: [{ status: "completed", conclusion: "success" }], [sha("b")]: [{ status: "in_progress", conclusion: null }] };
  h.daemon.override = (r) => {
    if (r.path.startsWith("/api/panel-upgrade/status")) {
      return {
        status: 200,
        body: {
          current: { sha: sha("c"), date: "2026-11-26T10:00:00+01:00", message: "current" },
          commits: [
            { sha: sha("b"), date: "2026-11-27T10:00:00+01:00", message: "second", author: "Steve" },
            { sha: sha("a"), date: "2026-11-27T09:00:00+01:00", message: "first", author: null },
          ],
          fetch_error: null,
          origin: ORIGIN,
          upgrade: { state: "success", from: sha("c"), to: sha("b"), ref: "origin/main", step: "done", started: "2026-11-26T12:00:00Z", finished: "2026-11-26T12:05:00Z" },
          log_tail: "line1\nline2",
          daemon_version: "9.9",
          daemon_commit: sha("c"),
        },
      };
    }
    if (r.path === "/api/panel-upgrade" && r.method === "POST") {
      const ref = (r.body as { ref?: string }).ref;
      if (upgradeRunning) return { status: 409, body: { error: "conflict", message: "an upgrade is already running" } };
      started.push(ref);
      return { status: 202, body: { unit: "panel-upgrade-20261127T100000Z", started_at: "2026-11-27T10:00:00Z" } };
    }
    return undefined;
  };
  githubTransport.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    ghCalls.push(u);
    const m = /commits\/([0-9a-f]+)\/check-runs/.exec(u);
    return new Response(JSON.stringify({ check_runs: ghRuns[m![1]!] ?? [] }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  githubTransport.fetch = realFetch;
  delete process.env.PANEL_GITHUB_REPO;
  delete process.env.PANEL_COMMIT;
});

describe("admin.updates", () => {
  it("status: versie, beschikbare commits met CI, laatste run en log; CI gecachet", async () => {
    process.env.PANEL_COMMIT = sha("c");
    process.env.PANEL_COMMIT_DATE = "2026-11-26T10:00:00+01:00";
    process.env.PANEL_COMMIT_MESSAGE = "current";
    const s = await admin.api.admin.updates.status({});
    expect(s).toMatchObject({ enabled: true, canUpgrade: true, daemonVersion: "9.9", githubRepo: "St3v3-B/BSSG-Panel", error: null, logTail: "line1\nline2" });
    expect(s.current).toEqual({ sha: sha("c"), date: "2026-11-26T10:00:00+01:00", message: "current" });
    expect(s.available.map((a) => [a.message, a.ci])).toEqual([["second", "pending"], ["first", "success"]]);
    expect(s.upgrade).toMatchObject({ state: "success", to: sha("b") });
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls[0]).toContain("/repos/St3v3-B/BSSG-Panel/commits/");
    await admin.api.admin.updates.status({ refresh: false });
    expect(ghCalls.length).toBe(2); // second call served from the cache
  });

  it("GitHub onbereikbaar: ci unknown, status werkt nog", async () => {
    githubTransport.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const s = await admin.api.admin.updates.status({});
    expect(s.available.map((a) => a.ci)).toEqual(["unknown", "unknown"]);
  });

  it("alleen admin", async () => {
    await expect(player.api.admin.updates.status({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(player.api.admin.updates.start({ onlyIfCiGreen: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("start: CI niet groen blokkeert, uitgezet niet; ref wordt gevalideerd", async () => {
    await expect(admin.api.admin.updates.start({ onlyIfCiGreen: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CI_NOT_GREEN" });
    expect(started).toEqual([]);
    await expect(admin.api.admin.updates.start({ ref: "main; reboot", onlyIfCiGreen: false })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "INVALID_REF" });
    expect((await admin.api.admin.updates.start({ onlyIfCiGreen: false })).unit).toBe("panel-upgrade-20261127T100000Z");
    expect(started).toEqual(["origin/main"]);
    // een groene commit mag op CI
    expect(await admin.api.admin.updates.start({ ref: sha("a"), onlyIfCiGreen: true })).toBeTruthy();
    expect(started).toEqual(["origin/main", sha("a")]);
    const log = await admin.api.admin.activity.search({ action: "admin.updates.start" });
    expect(log.items.length).toBeGreaterThanOrEqual(2);
  });

  it("start: al bezig → UPGRADE_RUNNING", async () => {
    upgradeRunning = true;
    await expect(admin.api.admin.updates.start({ onlyIfCiGreen: false })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "UPGRADE_RUNNING" });
  });

  it("setEnabled(false) blokkeert start en staat in de status; weer aan kan", async () => {
    await admin.api.admin.updates.setEnabled({ enabled: false });
    expect((await admin.api.admin.updates.status({})).enabled).toBe(false);
    await expect(admin.api.admin.updates.start({ onlyIfCiGreen: false })).rejects.toMatchObject({ message: "UPDATES_DISABLED" });
    await admin.api.admin.updates.setEnabled({ enabled: true });
    expect((await admin.api.admin.updates.status({})).enabled).toBe(true);
    expect((await admin.api.admin.activity.search({ action: "admin.updates.setEnabled" })).items).toHaveLength(2);
  });

  it("daemon zonder checkout (404 not_local) of onbereikbaar: canUpgrade false met reden", async () => {
    h.daemon.override = (r) => (r.path.startsWith("/api/panel-upgrade") ? { status: 404, body: { error: "not_local", message: "x" } } : undefined);
    const s = await admin.api.admin.updates.status({});
    expect(s).toMatchObject({ canUpgrade: false, available: [] });
    expect(s.error).toMatch(/NOT_LOCAL/i);
  });

  it("afgeronde upgrade komt één keer in het activiteitenlog", async () => {
    await admin.api.admin.updates.status({});
    await admin.api.admin.updates.status({});
    await new Promise((r) => setTimeout(r, 100));
    expect((await admin.api.admin.activity.search({ action: "admin.updates.success" })).items).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("githubRepo: uit https/ssh-remote, env wint", () => {
    expect(githubRepo("https://github.com/St3v3-B/BSSG-Panel.git")).toBe("St3v3-B/BSSG-Panel");
    expect(githubRepo(ORIGIN)).toBe("St3v3-B/BSSG-Panel");
    expect(githubRepo("https://gitlab.com/a/b")).toBeNull();
    process.env.PANEL_GITHUB_REPO = "foo/bar";
    expect(githubRepo(ORIGIN)).toBe("foo/bar");
  });
  it("summarizeRuns", () => {
    expect(summarizeRuns([])).toBe("none");
    expect(summarizeRuns([{ status: "completed", conclusion: "success" }, { status: "queued", conclusion: null }])).toBe("pending");
    expect(summarizeRuns([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }])).toBe("failure");
    expect(summarizeRuns([{ status: "completed", conclusion: "skipped" }, { status: "completed", conclusion: "success" }])).toBe("success");
  });
});
