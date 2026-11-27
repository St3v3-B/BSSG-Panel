/**
 * Modrinth-modpack (.mrpack): `modrinth.index.json` lezen, paden valideren en het plan voor
 * bestanden en overrides opstellen. Niets uit het pakket wordt uitgevoerd.
 */
import { z } from "zod";
import { readZip, ZipError, type ZipEntry } from "./zip";

export class MrpackError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** Hosts die de mrpack-specificatie voor downloads toestaat (plus de redirect-hosts van GitHub). */
export const PACK_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"] as const;

export const PACK_LIMITS = { maxEntries: 20_000, maxEntryBytes: 50 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxIndexBytes: 4 * 1024 * 1024, maxFiles: 2000 };

/**
 * Relatief pad binnen de serverroot, of een fout (PATH_ESCAPES). Afgewezen: absoluut, `..`, backslash,
 * stationsletters, NUL en andere stuurtekens, lege segmenten.
 */
export function safeRelPath(p: string): string {
  const bad = () => new MrpackError("PATH_ESCAPES", `invalid path in modpack: ${JSON.stringify(p.slice(0, 120))}`);
  if (!p || p.length > 400 || p.startsWith("/") || /[\\\u0000-\u001f]/.test(p) || /^[A-Za-z]:/.test(p)) throw bad();
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s.length > 255)) throw bad();
  return parts.join("/");
}

const PackFile = z.object({
  path: z.string(),
  hashes: z.object({ sha1: z.string().regex(/^[0-9a-fA-F]{40}$/).optional(), sha512: z.string().regex(/^[0-9a-fA-F]{128}$/) }),
  env: z.object({ client: z.string().optional(), server: z.string().optional() }).optional(),
  downloads: z.array(z.string()).min(1),
  fileSize: z.number().int().min(0).max(PACK_LIMITS.maxEntryBytes),
});
const Index = z.object({
  formatVersion: z.literal(1),
  game: z.literal("minecraft"),
  versionId: z.string(),
  name: z.string().max(200),
  files: z.array(PackFile).max(PACK_LIMITS.maxFiles),
  dependencies: z.record(z.string(), z.string()),
});

export interface PackPlan {
  name: string;
  minecraftVersion: string;
  loaderVersion: string;
  /** Te downloaden bestanden (server-kant). */
  files: Array<{ path: string; sha512: string; sha1?: string; size: number; urls: string[] }>;
  skipped: number;
  /** In volgorde van toepassen: `overrides/` eerst, `server-overrides/` daarna. */
  overrides: Array<{ path: string; entry: ZipEntry }>;
}

export function planPack(buf: Buffer): PackPlan {
  let entries: ZipEntry[];
  try {
    entries = readZip(buf, PACK_LIMITS);
  } catch (e) {
    if (e instanceof ZipError) throw new MrpackError("BAD_MODPACK", e.message);
    throw e;
  }
  const idx = entries.find((e) => e.name === "modrinth.index.json");
  if (!idx) throw new MrpackError("BAD_MODPACK", "modrinth.index.json not found");
  if (idx.size > PACK_LIMITS.maxIndexBytes) throw new MrpackError("BAD_MODPACK", "index too large");
  let parsed: z.infer<typeof Index>;
  try {
    parsed = Index.parse(JSON.parse(idx.read().toString("utf8")));
  } catch (e) {
    throw new MrpackError("BAD_MODPACK", `invalid modrinth.index.json: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
  }
  const deps = parsed.dependencies;
  const loader = deps["fabric-loader"];
  if (!loader) throw new MrpackError("UNSUPPORTED_LOADER", `only Fabric packs can be imported (pack needs: ${Object.keys(deps).filter((k) => k !== "minecraft").join(", ") || "unknown"})`);
  const mc = deps["minecraft"];
  if (!mc) throw new MrpackError("BAD_MODPACK", "pack has no minecraft dependency");

  const files: PackPlan["files"] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const f of parsed.files) {
    const path = safeRelPath(f.path); // alle paden controleren, ook van overgeslagen bestanden
    if (f.env?.server === "unsupported") {
      skipped++;
      continue;
    }
    if (seen.has(path)) throw new MrpackError("BAD_MODPACK", `duplicate path: ${path}`);
    seen.add(path);
    files.push({ path, sha512: f.hashes.sha512, sha1: f.hashes.sha1, size: f.fileSize, urls: f.downloads });
  }

  const overrides: PackPlan["overrides"] = [];
  for (const dir of ["overrides/", "server-overrides/"]) {
    for (const e of entries) {
      if (!e.name.startsWith(dir) || e.isDirectory) continue;
      overrides.push({ path: safeRelPath(e.name.slice(dir.length)), entry: e });
    }
  }
  // Ook elke andere ingang moet een veilige naam hebben (een pakket met `../x` is verdacht, niet alleen die in overrides).
  for (const e of entries) {
    if (e.name !== "modrinth.index.json" && !e.name.startsWith("overrides/") && !e.name.startsWith("server-overrides/") && !e.name.startsWith("client-overrides/")) {
      if (e.name.split("/").includes("..") || e.name.startsWith("/") || e.name.includes("\\")) throw new MrpackError("PATH_ESCAPES", `invalid entry name: ${JSON.stringify(e.name.slice(0, 120))}`);
    }
  }
  return { name: parsed.name, minecraftVersion: mc, loaderVersion: loader, files, skipped, overrides };
}
