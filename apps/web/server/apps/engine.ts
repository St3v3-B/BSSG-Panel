/**
 * Install engine for the app catalogue: download + verify (server side, allow-listed hosts only),
 * hand the archive to the site through a `SiteTarget`, extract into public/, write the app's
 * files. Knows nothing about tRPC or the database; the router wires those in.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppCtx, AppDef, ArchiveFormat, ChecksumAlgo } from "./catalog";

export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Everything the engine needs from the site's file system (daemon in production, a directory in tests). */
export interface SiteTarget {
  /** null when the directory does not exist. */
  listDir(path: string): Promise<Array<{ name: string; isDirectory: boolean }> | null>;
  readText(path: string): Promise<string | null>;
  mkdir(path: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
  /** Puts a local file in `dir` under `name`. */
  upload(dir: string, name: string, localFile: string): Promise<void>;
  /** Extracts `path` (.zip/.tar.gz) into its own directory. */
  decompress(path: string): Promise<void>;
}

/** Replaceable in tests (no network there). */
export const deps: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = {
  fetch: (url, init) => fetch(url, init),
};

const MAX_REDIRECTS = 5;

function checkUrl(def: AppDef, raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("DOWNLOAD_FAILED", `invalid URL`);
  }
  if (u.protocol !== "https:" || !def.hosts.includes(u.hostname) || u.username || u.password) {
    throw new AppError("DOWNLOAD_FAILED", `host not allowed: ${u.hostname}`);
  }
  return u;
}

/** GET with manual redirects; every hop must be https on the app's host list. */
async function get(def: AppDef, url: string, accept?: string): Promise<Response> {
  let cur = checkUrl(def, url).toString();
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let res: Response;
    try {
      res = await deps.fetch(cur, { redirect: "manual", headers: { "user-agent": "panel-apps/1", ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(15 * 60_000) });
    } catch (e) {
      throw new AppError("DOWNLOAD_FAILED", (e as Error).message);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new AppError("DOWNLOAD_FAILED", "redirect without location");
      cur = checkUrl(def, new URL(loc, cur).toString()).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new AppError("DOWNLOAD_FAILED", `HTTP ${res.status} for ${new URL(cur).hostname}`);
    }
    return res;
  }
  throw new AppError("DOWNLOAD_FAILED", "too many redirects");
}

export interface ResolvedSource {
  url: string;
  format: ArchiveFormat;
  algo: ChecksumAlgo;
  checksum: string;
  version: string | null;
}

const HEX = { sha1: /^[0-9a-f]{40}$/i, sha256: /^[0-9a-f]{64}$/i } as const;

/** Latest download URL and the checksum from its checksum source. */
export async function resolveSource(def: AppDef): Promise<ResolvedSource> {
  const s = def.source;
  if (s.kind === "url") {
    const text = await (await get(def, s.checksumUrl)).text();
    const word = text.trim().split(/\s+/)[0] ?? "";
    if (!HEX[s.algo].test(word)) throw new AppError("CHECKSUM_UNAVAILABLE", "checksum file has an unexpected format");
    return { url: s.url, format: s.format, algo: s.algo, checksum: word.toLowerCase(), version: null };
  }
  const res = await get(def, `https://api.github.com/repos/${s.repo}/releases/latest`, "application/vnd.github+json");
  let j: { tag_name?: string; assets?: Array<{ name: string; digest?: string | null; browser_download_url: string }> };
  try {
    j = (await res.json()) as typeof j;
  } catch {
    throw new AppError("DOWNLOAD_FAILED", "release metadata is not JSON");
  }
  const a = j.assets?.find((x) => s.asset.test(x.name));
  if (!a) throw new AppError("DOWNLOAD_FAILED", "release asset not found");
  const m = /^sha256:([0-9a-f]{64})$/i.exec(a.digest ?? "");
  if (!m) throw new AppError("CHECKSUM_UNAVAILABLE", "release has no sha256 digest");
  return { url: a.browser_download_url, format: s.format, algo: "sha256", checksum: m[1]!.toLowerCase(), version: (j.tag_name ?? "").replace(/^v/, "") || null };
}

/** Streams the archive to a file in `dir` and returns it only if the checksum matches. */
export async function downloadVerified(def: AppDef, src: ResolvedSource, dir: string, onVerify?: () => Promise<void> | void): Promise<string> {
  const res = await get(def, src.url);
  if (!res.body) throw new AppError("DOWNLOAD_FAILED", "empty response");
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > def.maxBytes) throw new AppError("DOWNLOAD_TOO_LARGE", `download is ${len} bytes`);
  const file = join(dir, src.format === "zip" ? "app.zip" : "app.tar.gz");
  const hash = createHash(src.algo);
  let n = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      n += chunk.length;
      if (n > def.maxBytes) return cb(new AppError("DOWNLOAD_TOO_LARGE", "download exceeds the limit"));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), meter, createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("DOWNLOAD_FAILED", (e as Error).message);
  }
  await onVerify?.();
  const got = Buffer.from(hash.digest("hex"));
  const want = Buffer.from(src.checksum);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    await rm(file, { force: true });
    throw new AppError("CHECKSUM_MISMATCH", `${src.algo} of the download does not match the published checksum`);
  }
  return file;
}

const PLACEHOLDER = /Your website is live|Je website staat live/;

/** public/ counts as empty when missing, empty, or only the template's default page. */
export async function checkPublic(t: SiteTarget): Promise<{ publicEmpty: boolean; entries: number }> {
  const list = (await t.listDir("/public")) ?? [];
  if (list.length === 0) return { publicEmpty: true, entries: 0 };
  if (list.length === 1 && list[0]!.name === "index.html" && !list[0]!.isDirectory) {
    const c = await t.readText("/public/index.html");
    if (c !== null && PLACEHOLDER.test(c)) return { publicEmpty: true, entries: 1 };
  }
  return { publicEmpty: false, entries: list.length };
}

export interface DbInfo {
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export interface InstallOptions {
  def: AppDef;
  target: SiteTarget;
  replaceExisting: boolean;
  siteName: string;
  domains: string[];
  admin: { username: string; email: string } | null;
  /** Creates the database (only called for apps with a database). Returns how to undo it. */
  provisionDb: () => Promise<{ db: DbInfo; rollback: () => Promise<void> }>;
  step: (key: string, status: "running" | "done" | "failed") => Promise<void> | void;
  /** Directory name for temporary files on the site (`/.panel-app-<id>`). */
  tmpName: string;
  genPassword?: () => string;
}

export interface InstallOutcome {
  version: string;
  siteUrl: string | null;
  adminUrl: string | null;
  adminUsername: string | null;
  adminPassword: string | null;
  databaseName: string | null;
  notes: string[];
}

export const stepKeys = (def: AppDef): string[] => ["prepare", "download", "verify", "upload", "extract", ...(def.database ? ["database"] : []), "configure", "finish"];

/** Runs the whole installation. Throws AppError with a code; cleans up after itself. */
export async function install(o: InstallOptions): Promise<InstallOutcome> {
  const { def, target: t } = o;
  const work = await mkdtemp(join(tmpdir(), "panel-app-"));
  const tmp = `/${o.tmpName}`;
  let rollback: (() => Promise<void>) | null = null;
  let current = "prepare";
  const run = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    current = key;
    await o.step(key, "running");
    const r = await fn();
    await o.step(key, "done");
    return r;
  };
  try {
    const src = await run("prepare", async () => {
      const pub = await checkPublic(t);
      if (!pub.publicEmpty && !o.replaceExisting) throw new AppError("PUBLIC_NOT_EMPTY", "public/ is not empty");
      return resolveSource(def);
    });
    current = "download";
    await o.step("download", "running");
    const file = await downloadVerified(def, src, work, async () => {
      await o.step("download", "done");
      current = "verify";
      await o.step("verify", "running");
    });
    await o.step("verify", "done");
    const archive = src.format === "zip" ? "app.zip" : "app.tar.gz";
    await run("upload", async () => {
      await t.remove([tmp]).catch(() => {});
      await t.mkdir(tmp);
      await t.upload(tmp, archive, file);
    });
    await run("extract", async () => {
      await t.decompress(`${tmp}/${archive}`);
      const base = def.strip ? `${tmp}/${def.strip}` : tmp;
      const entries = (await t.listDir(base)) ?? [];
      const moving = entries.filter((e) => !(base === tmp && e.name === archive));
      if (moving.length === 0) throw new AppError("EXTRACT_FAILED", "the archive had no content");
      // Only now (download verified, archive unpacked) is public/ touched.
      const pub = (await t.listDir("/public")) ?? [];
      if (pub.length) {
        if (!o.replaceExisting && !(await checkPublic(t)).publicEmpty) throw new AppError("PUBLIC_NOT_EMPTY", "public/ is not empty");
        await t.remove(pub.map((e) => `/public/${e.name}`));
      } else if ((await t.listDir("/public")) === null) await t.mkdir("/public");
      for (const e of moving) await t.rename(`${base}/${e.name}`, `/public/${e.name}`);
      await t.remove([tmp]);
    });

    let db: DbInfo | null = null;
    if (def.database) {
      const p = await run("database", () => o.provisionDb());
      db = p.db;
      rollback = p.rollback;
    }
    const gen = o.genPassword ?? (() => randomBytes(18).toString("base64url"));
    const admin = o.admin && def.admin ? { ...o.admin, password: gen() } : null;
    const ctx: AppCtx = { siteName: o.siteName, domains: o.domains, db, admin };
    await run("configure", async () => {
      for (const d of def.dirs ?? []) await t.mkdir(`/${d}`).catch(() => {}); // exists is fine
      for (const f of def.files(ctx)) {
        const dir = f.path.split("/").slice(0, -1).join("/");
        if (dir) await t.mkdir(`/${dir}`).catch(() => {});
        await t.write(`/${f.path}`, f.content);
      }
    });
    const version = await run("finish", async () => {
      if (def.versionFile) {
        const txt = await t.readText(`/${def.versionFile.path}`);
        const m = txt ? def.versionFile.pattern.exec(txt) : null;
        if (m) return m[1]!;
      }
      return src.version ?? "latest";
    });
    const siteUrl = o.domains[0] ? `https://${o.domains[0]}` : null;
    return {
      version,
      siteUrl,
      adminUrl: siteUrl ? siteUrl + def.adminPath : null,
      adminUsername: admin?.username ?? null,
      adminPassword: admin?.password ?? null,
      databaseName: db?.name ?? null,
      notes: [...def.notes(ctx), ...(siteUrl ? [] : ["add_domain"])],
    };
  } catch (e) {
    await o.step(current, "failed");
    await t.remove([tmp]).catch(() => {});
    if (rollback) await rollback().catch(() => {});
    throw e instanceof AppError ? e : new AppError("INSTALL_FAILED", (e as Error).message ?? String(e));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
