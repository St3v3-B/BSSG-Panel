/** Helpers for app tests: tiny release archives and a fake network (no real downloads in tests). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** tar.gz with `files` under `top/`. */
export function makeTarGz(top: string, files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "fixture-"));
  for (const [f, c] of Object.entries(files)) {
    const full = join(dir, top, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
  const out = join(dir, "out.tgz");
  execFileSync("tar", ["-czf", out, "-C", dir, top]);
  return readFileSync(out);
}

export const sha = (b: Buffer | string, algo: "sha1" | "sha256" = "sha1") => createHash(algo).update(b).digest("hex");

export const WP_FILES = {
  "index.php": "<?php // wp",
  "wp-settings.php": "<?php // settings",
  "wp-includes/version.php": "<?php\n$wp_version = '9.9.1';\n",
  "wp-content/index.php": "<?php // silence",
};

type Route = { status?: number; body?: Buffer | string; headers?: Record<string, string> };

/** Fetch replacement serving fixed routes; unknown URLs → 404; records what was requested. */
export function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    seen.push(url);
    const r = routes[url];
    if (!r) return new Response("nope", { status: 404 });
    return new Response(r.body === undefined ? null : new Uint8Array(Buffer.from(r.body)), { status: r.status ?? 200, headers: { "content-length": String(Buffer.byteLength(r.body ?? "")), ...r.headers } });
  };
  return { fn, seen };
}
