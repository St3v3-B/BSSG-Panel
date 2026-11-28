/** Unit-tests zonder database: crypto, TOTP, daemon-client, spec. */
import { randomBytes } from "node:crypto";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { DaemonClient, DaemonHttpError, DaemonUnreachableError } from "./daemon/client";
import { toTrpcError } from "./daemon";
import { decrypt, encrypt } from "./lib/crypto";
import { base32Decode, base32Encode, totpAt, verifyTotp } from "./lib/totp";
import { buildServerSpec, resolveVariables, validateVariables } from "./spec";
import { FakeDaemon } from "./test/fake-daemon";
import { safeRedirect } from "./discord";
import { sftpUsername } from "./servers-data";

describe("crypto", () => {
  it("AES-256-GCM heen en terug, formaat v1, manipulatie gedetecteerd", () => {
    const key = randomBytes(32);
    const enc = encrypt("geheim", key);
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(decrypt(enc, key)).toBe("geheim");
    expect(encrypt("geheim", key)).not.toBe(enc);
    const [v, iv, ct] = enc.split(":");
    const bad = Buffer.from(ct!, "base64");
    bad[0]! ^= 1;
    expect(() => decrypt(`${v}:${iv}:${bad.toString("base64")}`, key)).toThrow();
    expect(() => decrypt(enc, randomBytes(32))).toThrow();
  });
});

describe("TOTP (RFC 6238)", () => {
  // Testvector uit RFC 6238 (SHA-1): secret "12345678901234567890", T=59 → 94287082 (8 cijfers) → 287082
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("testvectoren", () => {
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });
  it("venster van ±1 stap", () => {
    const at = 1111111109_000;
    expect(verifyTotp(secret, "081804", at)).toBe(true);
    expect(verifyTotp(secret, "081804", at + 30_000)).toBe(true);
    expect(verifyTotp(secret, "081804", at + 90_000)).toBe(false);
    expect(verifyTotp(secret, "abc", at)).toBe(false);
  });
});

describe("daemon-client", () => {
  const fake = new FakeDaemon("tok");
  beforeAll(() => fake.start());
  afterAll(() => fake.stop());

  it("stuurt Bearer-token en parst JSON", async () => {
    const c = new DaemonClient({ nodeId: 1, baseUrl: fake.url, token: "tok" });
    expect((await c.system()).version).toBe("fake-1.0");
    expect(fake.last("GET", "/api/system")?.auth).toBe("Bearer tok");
  });

  it("HTTP-fout → DaemonHttpError met code uit Error-schema", async () => {
    const c = new DaemonClient({ nodeId: 1, baseUrl: fake.url, token: "fout" });
    const e = await c.system().catch((x) => x);
    expect(e).toBeInstanceOf(DaemonHttpError);
    expect(e).toMatchObject({ status: 401, code: "unauthorized" });
    const e404 = await new DaemonClient({ nodeId: 1, baseUrl: fake.url, token: "tok" }).getServer("00000000-0000-4000-8000-000000000000").catch((x) => x);
    expect((toTrpcError(e404) as Error).message).toMatch(/DAEMON_NOT_FOUND/);
  });

  it("timeout en geen verbinding → DaemonUnreachableError (DAEMON_UNREACHABLE)", async () => {
    fake.mode = "hang";
    const c = new DaemonClient({ nodeId: 7, baseUrl: fake.url, token: "tok", timeoutMs: 200 });
    const t = Date.now();
    const e = await c.system().catch((x) => x);
    fake.mode = "ok";
    expect(e).toBeInstanceOf(DaemonUnreachableError);
    expect(Date.now() - t).toBeLessThan(2000);
    const e2 = await new DaemonClient({ nodeId: 7, baseUrl: "http://127.0.0.1:1", token: "x" }).system().catch((x) => x);
    expect(e2).toBeInstanceOf(DaemonUnreachableError);
    expect((toTrpcError(e2) as Error).message).toBe("DAEMON_UNREACHABLE");
  });

  it("502/503/504 van een gateway telt als onbereikbaar", async () => {
    fake.override = () => ({ status: 502, body: { error: "bad_gateway" } });
    const e = await new DaemonClient({ nodeId: 1, baseUrl: fake.url, token: "tok" }).system().catch((x) => x);
    fake.override = null;
    expect(e).toBeInstanceOf(DaemonUnreachableError);
  });
});

describe("spec en variabelen", () => {
  const vars = [
    { key: "A", name: "A", default: "1", user_editable: true, pattern: "^\\d+$" },
    { key: "B", name: "B", default: "x", user_editable: false },
  ];
  it("resolveVariables: opgeslagen waarde wint van default", () => {
    expect(resolveVariables(vars, { A: "5" })).toEqual({ A: "5", B: "x" });
  });
  it("validateVariables", () => {
    expect(validateVariables(vars, { A: "12" }, { onlyUserEditable: true })).toEqual([]);
    expect(validateVariables(vars, { A: "x" }, { onlyUserEditable: true })).toHaveLength(1);
    expect(validateVariables(vars, { B: "y" }, { onlyUserEditable: true })).toHaveLength(1);
    expect(validateVariables(vars, { B: "y" }, { onlyUserEditable: false })).toEqual([]);
    expect(validateVariables(vars, { C: "y" }, { onlyUserEditable: false })).toHaveLength(1);
  });
  it("buildServerSpec: primaire allocation eerst, web zonder allocations", () => {
    const template = {
      id: 1, slug: "t", name: "T", description: null, type: "game" as const, image: "img", startup: "run", stop: { type: "signal" as const, value: "SIGINT" },
      readyPattern: "ok", httpPort: null, variables: vars, installImage: "alp", installScript: "s", configFiles: [], version: 1, sourceYaml: "", createdAt: new Date(), updatedAt: new Date(),
    };
    const s = buildServerSpec({ uuid: "u", template, variables: {}, limits: { cpuPct: 0, ramMb: 64, swapMb: 0, diskMb: 0 }, allocations: [{ ip: "1.2.3.4", port: 2, isPrimary: false }, { ip: "1.2.3.4", port: 1, isPrimary: true }] });
    expect(s.allocations).toEqual([{ ip: "1.2.3.4", port: 1, primary: true }, { ip: "1.2.3.4", port: 2, primary: false }]);
    expect(s.environment).toEqual({ A: "1", B: "x" });
    const w = buildServerSpec({ uuid: "u", template: { ...template, type: "web", httpPort: 80 }, variables: {}, limits: { cpuPct: 0, ramMb: 64, swapMb: 0, diskMb: 0 }, allocations: [{ ip: "1.2.3.4", port: 2, isPrimary: true }] });
    expect(w.allocations).toEqual([]);
    expect(w.http_port).toBe(80);
  });
});

describe("kleine hulpjes", () => {
  it("safeRedirect laat alleen eigen paden toe", () => {
    expect(safeRedirect("/admin")).toBe("/admin");
    expect(safeRedirect("//evil")).toBe("/");
    for (const bad of ["/%09/evil.test", "/\t/evil.test", "/\\evil.test", "/%5Cevil.test", "/%2F/evil.test", "/%2Fevil.test", "/a\nb", "/%0d%0a/x", "/%252F/evil", "///evil", "evil.test", "/%zz"]) expect(safeRedirect(bad), bad).toBe("/");
    expect(safeRedirect("/servers/abc?tab=files#x")).toBe("/servers/abc?tab=files#x");
    expect(safeRedirect("https://evil")).toBe("/");
    expect(safeRedirect("/\\evil")).toBe("/");
    expect(safeRedirect(null)).toBe("/");
  });
  it("sftpUsername", () => {
    expect(sftpUsername("Steve Jansen!", "1", "abcdef12-0000")).toBe("stevejansen.abcdef12");
    expect(sftpUsername(null, "123456789012345678", "abcdef12-0000")).toBe("123456789012345678.abcdef12");
  });
});

describe("echte templates uit de repo", () => {
  it("paper.yaml parseert en wordt een geldige ServerSpec", async () => {
    const { readFileSync } = await import("node:fs");
    const { parseTemplate } = await import("@panel/api");
    const { templateRow } = await import("./templates");
    const yaml = readFileSync(new URL("../../../templates/game/paper.yaml", import.meta.url), "utf8");
    const r = parseTemplate(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = { ...templateRow(r.spec, yaml), id: 1, createdAt: new Date(), updatedAt: new Date() };
    const spec = buildServerSpec({ uuid: "u", template: row, variables: {}, limits: { cpuPct: 200, ramMb: 1536, swapMb: 0, diskMb: 4096 }, allocations: [{ ip: "127.0.0.1", port: 25565, isPrimary: true }], startOnInstall: true });
    expect(spec.type).toBe("game");
    expect(spec.limits.memory_mb).toBe(1536);
    expect(spec.allocations).toEqual([{ ip: "127.0.0.1", port: 25565, primary: true }]);
    expect(Object.keys(spec.environment)).toEqual(r.spec.variables.map((v) => v.key));
  });
});

describe("beveiligingsheaders en omgeving", () => {
  it("CSP en vaste headers", async () => {
    const { contentSecurityPolicy, securityHeaders } = await import("../next.config");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    // Monaco wordt meegeleverd (public/monaco): geen CDN in de CSP.
    expect(contentSecurityPolicy).not.toContain("cdn.jsdelivr.net");
    expect(contentSecurityPolicy).toMatch(/script-src 'self' 'unsafe-inline'(;| 'unsafe-eval';)/);
    expect(securityHeaders.map((x) => x.key)).toEqual(expect.arrayContaining(["X-Content-Type-Options", "Strict-Transport-Security", "Content-Security-Policy"]));
  });
  it("NODE_TOKEN: minimaal 32 tekens", async () => {
    const { parseEnv } = await import("./env");
    const { baseEnv } = await import("./test/harness");
    expect(() => parseEnv({ ...baseEnv(), NODE_TOKEN: "x".repeat(31) })).toThrow(/NODE_TOKEN/);
    expect(() => parseEnv({ ...baseEnv(), NODE_TOKEN: "x".repeat(32) })).not.toThrow();
  });
});
