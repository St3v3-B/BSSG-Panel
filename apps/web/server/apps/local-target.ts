/** SiteTarget on a local directory (the site's /home/container). For tests and the Docker end-to-end check. */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SiteTarget } from "./engine";

const run = promisify(execFile);

export function localTarget(root: string): SiteTarget {
  const p = (x: string) => {
    const full = resolve(root, `.${x}`);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) throw new Error("path escapes root");
    return full;
  };
  return {
    async listDir(path) {
      try {
        return (await readdir(p(path), { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") return null;
        throw e;
      }
    },
    async readText(path) {
      try {
        return await readFile(p(path), "utf8");
      } catch {
        return null;
      }
    },
    mkdir: async (path) => void (await mkdir(p(path), { recursive: false })),
    write: async (path, content) => writeFile(p(path), content),
    rename: (f, t) => rename(p(f), p(t)),
    remove: async (paths) => void (await Promise.all(paths.map((x) => rm(p(x), { recursive: true, force: true })))),
    async upload(dir, name, file) {
      await mkdir(p(dir), { recursive: true });
      await copyFile(file, join(p(dir), name));
    },
    async decompress(path) {
      const file = p(path);
      const dir = dirname(file);
      if (file.endsWith(".zip")) await run("python3", ["-I", "-m", "zipfile", "-e", file, dir]);
      else await run("tar", ["-xzf", file, "-C", dir]);
    },
  };
}
