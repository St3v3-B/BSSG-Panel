import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appById, CATALOG, phpStr } from "./catalog";
import { AppError, checkPublic, deps, install, resolveSource, type InstallOptions } from "./engine";
import { localTarget } from "./local-target";
import { fakeFetch, makeTarGz, sha, WP_FILES } from "./test-fixtures";

const realFetch = deps.fetch;
let root = "";
afterEach(() => {
  deps.fetch = realFetch;
  if (root) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "site-"));
  mkdirSync(join(root, "public"));
  mkdirSync(join(root, "nginx"));
});

const wp = appById("wordpress")!;
const tgz = makeTarGz("wordpress", WP_FILES);
const WP_ROUTES = {
  "https://wordpress.org/latest.tar.gz": { body: tgz },
  "https://wordpress.org/latest.tar.gz.sha1": { body: sha(tgz) + "\n" },
};

function opts(over: Partial<InstallOptions> = {}): InstallOptions & { steps: string[]; rolledBack: number } {
  const steps: string[] = [];
  const o = {
    def: wp,
    target: localTarget(root),
    replaceExisting: false,
    siteName: "My Site",
    domains: ["blog.panel.test"],
    admin: null,
    tmpName: ".panel-app-1",
    step: (k: string, s: string) => void steps.push(`${k}:${s}`),
    provisionDb: async () => ({ db: { host: "panel-mariadb", port: 3306, name: "s1_wordpress", user: "u1_abc", password: "p'w\\x" }, rollback: async () => void (o.rolledBack += 1) }),
    genPassword: () => "GeneratedPw123",
    steps,
    rolledBack: 0,
    ...over,
  };
  return o as never;
}

describe("catalogue", () => {
  it("every definition is complete and only uses https hosts it lists", () => {
    expect(CATALOG.map((a) => a.id)).toEqual(["wordpress", "grav", "nextcloud"]);
    for (const a of CATALOG) {
      expect(a.templatePrefix).toBe("php-");
      const urls = a.source.kind === "url" ? [a.source.url, a.source.checksumUrl] : [`https://api.github.com/repos/${a.source.repo}/releases/latest`];
      for (const u of urls) {
        expect(u.startsWith("https://")).toBe(true);
        expect(a.hosts).toContain(new URL(u).hostname);
      }
      expect(a.maxBytes).toBeGreaterThan(a.downloadMb * 1024 ** 2);
    }
  });

  it("phpStr escapes quotes and backslashes", () => {
    expect(phpStr(`a'b\\c`)).toBe(`'a\\'b\\\\c'`);
  });
});

describe("install: WordPress", () => {
  it("downloads, verifies, extracts into public/, writes wp-config.php outside public/ and the one-time setup", async () => {
    const f = fakeFetch(WP_ROUTES);
    deps.fetch = f.fn;
    const o = opts({ admin: { username: "boss", email: "boss@panel.test" } });
    const r = await install(o);
    expect(r).toMatchObject({ version: "9.9.1", siteUrl: "https://blog.panel.test", adminUrl: "https://blog.panel.test/wp-admin/", adminUsername: "boss", adminPassword: "GeneratedPw123", databaseName: "s1_wordpress" });
    expect(r.notes).toEqual(["finish_in_browser"]);
    expect(readFileSync(join(root, "public/wp-includes/version.php"), "utf8")).toContain("9.9.1");
    expect(existsSync(join(root, "public/wp-config.php"))).toBe(false);
    const cfg = readFileSync(join(root, "wp-config.php"), "utf8");
    expect(cfg).toContain("define('DB_NAME', 's1_wordpress');");
    expect(cfg).toContain("define('DB_PASSWORD', 'p\\'w\\\\x');");
    expect(cfg).toContain("define('DB_HOST', 'panel-mariadb');");
    expect(cfg).toContain("define('FS_METHOD', 'direct');");
    expect(cfg).toContain("HTTP_X_FORWARDED_PROTO");
    expect(cfg).toContain("wp_install(");
    const salts = [...cfg.matchAll(/define\('(?:AUTH|SECURE_AUTH|LOGGED_IN|NONCE)_(?:KEY|SALT)\s*', '([^']{64})'\);/g)].map((m) => m[1]);
    expect(salts).toHaveLength(8);
    expect(new Set(salts).size).toBe(8);
    expect(JSON.parse(readFileSync(join(root, ".panel-wp-setup.json"), "utf8"))).toEqual({ title: "My Site", username: "boss", email: "boss@panel.test", password: "GeneratedPw123" });
    expect(existsSync(join(root, ".panel-app-1"))).toBe(false); // temp dir cleaned up
    expect(o.steps.filter((s) => s.endsWith(":failed"))).toEqual([]);
    expect(o.steps).toContain("verify:done");
    expect(f.seen).toEqual(["https://wordpress.org/latest.tar.gz.sha1", "https://wordpress.org/latest.tar.gz"]);
  });

  it("without admin: no setup file, no installer block, wizard note", async () => {
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    const r = await install(opts());
    expect(r.adminPassword).toBeNull();
    expect(r.notes).toEqual(["run_wizard"]);
    expect(existsSync(join(root, ".panel-wp-setup.json"))).toBe(false);
    expect(readFileSync(join(root, "wp-config.php"), "utf8")).not.toContain("wp_install(");
  });

  it("rejects a checksum mismatch and changes nothing (no database, no files)", async () => {
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz.sha1": { body: "0".repeat(40) } }).fn;
    writeFileSync(join(root, "public/mine.php"), "keep me");
    const o = opts({ replaceExisting: true });
    let dbCalls = 0;
    o.provisionDb = async () => (dbCalls++, { db: null as never, rollback: async () => {} });
    await expect(install(o)).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    expect(dbCalls).toBe(0);
    expect(readdirSync(join(root, "public"))).toEqual(["mine.php"]);
    expect(existsSync(join(root, "wp-config.php"))).toBe(false);
    expect(o.steps).toContain("verify:failed");
  });

  it("rejects a checksum file with garbage", async () => {
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz.sha1": { body: "<html>oops</html>" } }).fn;
    await expect(install(opts())).rejects.toMatchObject({ code: "CHECKSUM_UNAVAILABLE" });
  });

  it("protects a non-empty public/ and never even downloads", async () => {
    const f = fakeFetch(WP_ROUTES);
    deps.fetch = f.fn;
    writeFileSync(join(root, "public/index.php"), "<?php echo 'my site';");
    await expect(install(opts())).rejects.toMatchObject({ code: "PUBLIC_NOT_EMPTY" });
    expect(f.seen).toEqual([]);
    expect(readFileSync(join(root, "public/index.php"), "utf8")).toContain("my site");
  });

  it("replaces a non-empty public/ only with explicit confirmation", async () => {
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    writeFileSync(join(root, "public/old.php"), "old");
    await install(opts({ replaceExisting: true }));
    expect(existsSync(join(root, "public/old.php"))).toBe(false);
    expect(existsSync(join(root, "public/index.php"))).toBe(true);
  });

  it("treats the template's default page as empty", async () => {
    writeFileSync(join(root, "public/index.html"), "<title>Your website is live</title>");
    expect(await checkPublic(localTarget(root))).toEqual({ publicEmpty: true, entries: 1 });
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    await install(opts());
    expect(existsSync(join(root, "public/index.html"))).toBe(false);
    writeFileSync(join(root, "public/index.html"), "<h1>mine</h1>");
    expect((await checkPublic(localTarget(root))).publicEmpty).toBe(false);
  });

  it("rolls back the database when a later step fails", async () => {
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    const o = opts();
    const t = localTarget(root);
    o.target = { ...t, write: async (p, c) => (p === "/wp-config.php" ? Promise.reject(new Error("disk full")) : t.write(p, c)) };
    await expect(install(o)).rejects.toMatchObject({ code: "INSTALL_FAILED", message: "disk full" });
    expect(o.rolledBack).toBe(1);
    expect(o.steps).toContain("configure:failed");
  });
});

describe("downloads: only allow-listed sources", () => {
  it("refuses a redirect to another host and a downgrade to http", async () => {
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz": { status: 302, headers: { location: "https://evil.test/x.tgz" } } }).fn;
    await expect(install(opts())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", message: expect.stringContaining("host not allowed") });
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz": { status: 301, headers: { location: "http://wordpress.org/latest.tar.gz" } } }).fn;
    await expect(install(opts())).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
  });

  it("follows redirects within the allow-list", async () => {
    deps.fetch = fakeFetch({ ...WP_ROUTES, "https://wordpress.org/latest.tar.gz": { status: 302, headers: { location: "https://downloads.wordpress.org/release/wp.tar.gz" } }, "https://downloads.wordpress.org/release/wp.tar.gz": { body: tgz } }).fn;
    await expect(install(opts())).resolves.toBeTruthy();
  });

  it("enforces the size cap", async () => {
    const small = { ...wp, maxBytes: 100 };
    deps.fetch = fakeFetch(WP_ROUTES).fn;
    await expect(install(opts({ def: small }))).rejects.toMatchObject({ code: "DOWNLOAD_TOO_LARGE" });
  });

  it("reports HTTP errors", async () => {
    deps.fetch = fakeFetch({}).fn;
    await expect(install(opts())).rejects.toBeInstanceOf(AppError);
  });
});

describe("GitHub sources (Grav)", () => {
  const grav = appById("grav")!;
  const zipFile = (() => {
    // A tiny zip made with python (no zip tool needed on the machine).
    const dir = mkdtempSync(join(tmpdir(), "zipfix-"));
    const out = join(dir, "g.zip");
    const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w')\nz.writestr('grav-admin/index.php','<?php')\nz.writestr('grav-admin/user/config/site.yaml','title: x')\nz.writestr('grav-admin/system/defines.php',"<?php define('GRAV_VERSION', '9.0.1');")\nz.close()`;
    require("node:child_process").execFileSync("python3", ["-I", "-c", py, out]);
    return readFileSync(out);
  })();
  const release = (digest: string | null) => ({
    "https://api.github.com/repos/getgrav/grav/releases/latest": {
      body: JSON.stringify({ tag_name: "9.0.1", assets: [{ name: "grav-v9.0.1.zip", digest: "sha256:" + "1".repeat(64), browser_download_url: "https://x" }, { name: "grav-admin-v9.0.1.zip", digest, browser_download_url: "https://github.com/getgrav/grav/releases/download/9.0.1/grav-admin-v9.0.1.zip" }] }),
    },
    "https://github.com/getgrav/grav/releases/download/9.0.1/grav-admin-v9.0.1.zip": { status: 302, headers: { location: "https://release-assets.githubusercontent.com/abc" } },
    "https://release-assets.githubusercontent.com/abc": { body: zipFile },
  });

  it("uses the release asset digest as checksum and installs without a database", async () => {
    deps.fetch = fakeFetch(release("sha256:" + sha(zipFile, "sha256"))).fn;
    let dbCalls = 0;
    const o = opts({ def: grav, provisionDb: async () => (dbCalls++, null as never) });
    const r = await install(o);
    expect(dbCalls).toBe(0);
    expect(r).toMatchObject({ version: "9.0.1", databaseName: null, adminPassword: null });
    expect(r.notes).toContain("create_admin_on_first_visit");
    expect(existsSync(join(root, "public/user/config/site.yaml"))).toBe(true);
    expect(readFileSync(join(root, "nginx/grav.conf"), "utf8")).toContain("location ^~ /user/");
    expect(o.steps.some((s) => s.startsWith("database"))).toBe(false);
  });

  it("rejects a wrong digest and a release without digest", async () => {
    deps.fetch = fakeFetch(release("sha256:" + "2".repeat(64))).fn;
    await expect(install(opts({ def: grav }))).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
    deps.fetch = fakeFetch(release(null)).fn;
    await expect(resolveSource(grav)).rejects.toMatchObject({ code: "CHECKSUM_UNAVAILABLE" });
  });
});

describe("Nextcloud files", () => {
  it("autoconfig with database and admin, private directories, data dir outside public/", () => {
    const nc = appById("nextcloud")!;
    const files = nc.files({ siteName: "s", domains: ["cloud.panel.test"], db: { host: "panel-mariadb", port: 3306, name: "d", user: "u", password: "p" }, admin: { username: "root", email: "a@b.test", password: "pw" } });
    const auto = files.find((f) => f.path === "public/config/autoconfig.php")!.content;
    expect(auto).toContain("'dbhost' => 'panel-mariadb'");
    expect(auto).toContain("'adminlogin' => 'root'");
    expect(auto).toContain("'directory' => '/home/container/nextcloud-data'");
    expect(files.find((f) => f.path === "public/config/panel.config.php")!.content).toContain("'cloud.panel.test'");
    expect(files.find((f) => f.path === "nginx/nextcloud.conf")!.content).toContain("location ^~ /config/ { return 404; }");
    expect(nc.dirs).toEqual(["nextcloud-data"]);
  });
});
