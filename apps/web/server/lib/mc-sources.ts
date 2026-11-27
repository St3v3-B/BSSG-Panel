/** Modrinth (API v2) en Hangar (API v1): zoeken, versies en downloadgegevens, genormaliseerd. */
import type { ContentHit, ContentSource } from "@panel/api";
import { createHash } from "node:crypto";
import { ExternalError, fetchBytes, fetchJson } from "./http";

export const MODRINTH_API = "https://api.modrinth.com/v2";
export const HANGAR_API = "https://hangar.papermc.io/api/v1";
/** Waar plugin- en mod-bestanden vandaan mogen komen. */
export const DOWNLOAD_HOSTS = ["cdn.modrinth.com", "hangarcdn.papermc.io", "hangar.papermc.io"] as const;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // gelijk aan de schrijflimiet van de daemon

export interface FileTarget {
  projectId: string;
  name: string;
  versionId: string;
  versionNumber: string;
  filename: string;
  size: number;
  url: string;
  hash: { algo: "sha512" | "sha256"; hex: string };
  dependencies: Array<{ projectId: string }>;
}

export interface Filter {
  loaders: string[];
  gameVersion: string | null;
  /** Fabric: alleen mods die aan de serverkant draaien. */
  serverSide: boolean;
}

export interface SourceClient {
  search(f: Filter, query: string, offset: number, modpacks?: boolean): Promise<{ hits: ContentHit[]; total: number }>;
  hit(projectId: string): Promise<ContentHit>;
  /** Nieuwste compatibele versie, of de opgegeven versie (die compatibel moet zijn). */
  target(projectId: string, f: Filter, versionId?: string): Promise<FileTarget>;
}

const PAGE = 20;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+() ~-]{0,150}\.jar$/;

export function safeFilename(name: string): string {
  if (!SAFE_NAME.test(name) || name.includes("..")) throw new ExternalError("EXTERNAL_BAD_RESPONSE", `unsafe file name: ${name.slice(0, 80)}`);
  return name;
}

/** Vergelijkt de hash van `data` met de verwachte waarde (hoofdletterongevoelig). */
export function verifyHash(data: Buffer, hash: FileTarget["hash"]): void {
  const got = createHash(hash.algo).update(data).digest("hex");
  if (got !== hash.hex.toLowerCase()) throw new ExternalError("HASH_MISMATCH", `${hash.algo} of the download does not match`);
}

/** Download + hashcontrole; geeft de bytes terug. */
export async function downloadVerified(t: FileTarget): Promise<Buffer> {
  const data = await fetchBytes(t.url, { hosts: DOWNLOAD_HOSTS, maxBytes: MAX_FILE_BYTES });
  verifyHash(data, t.hash);
  return data;
}

// ---------- Modrinth ----------

interface MrVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: string;
  loaders: string[];
  game_versions: string[];
  files: Array<{ hashes: { sha512?: string }; url: string; filename: string; primary: boolean; size: number }>;
  dependencies: Array<{ project_id: string | null; version_id: string | null; dependency_type: string }>;
}
interface MrProject { id: string; slug: string; title: string; description: string; downloads: number; icon_url: string | null; project_type?: string }

const mr = <T>(path: string) => fetchJson<T>(`${MODRINTH_API}${path}`, { hosts: ["api.modrinth.com"] });
const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));

async function mrAuthor(projectId: string): Promise<string> {
  try {
    const members = await mr<Array<{ role: string; user: { username: string } }>>(`/project/${encodeURIComponent(projectId)}/members`);
    return (members.find((m) => m.role === "Owner") ?? members[0])?.user.username ?? "";
  } catch {
    return "";
  }
}

const mrHit = (p: MrProject, author: string): ContentHit => ({
  source: "modrinth",
  projectId: p.id,
  name: p.title,
  description: p.description,
  author,
  downloads: p.downloads,
  iconUrl: p.icon_url,
  url: `https://modrinth.com/project/${p.slug}`,
});

function mrTarget(p: { id: string; title: string }, v: MrVersion): FileTarget {
  const f = v.files.find((x) => x.primary) ?? v.files[0];
  if (!f) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "version has no files");
  if (!f.hashes.sha512) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "version has no sha512 hash");
  return {
    projectId: p.id,
    name: p.title,
    versionId: v.id,
    versionNumber: v.version_number,
    filename: f.filename,
    size: f.size,
    url: f.url,
    hash: { algo: "sha512", hex: f.hashes.sha512 },
    dependencies: v.dependencies.filter((d) => d.dependency_type === "required" && d.project_id).map((d) => ({ projectId: d.project_id! })),
  };
}

export const modrinth: SourceClient = {
  async search(f, query, offset, modpacks = false) {
    const facets: string[][] = [[modpacks ? "project_type:modpack" : "project_type:mod"], f.loaders.map((l) => `categories:${l}`)];
    if (f.gameVersion && !modpacks) facets.push([`versions:${f.gameVersion}`]);
    if (f.serverSide && !modpacks) facets.push(["server_side:required", "server_side:optional"]);
    const r = await mr<{ hits: Array<MrProject & { project_id: string; author: string }>; total_hits: number }>(
      `/search?query=${encodeURIComponent(query)}&facets=${enc(facets)}&limit=${PAGE}&offset=${offset}&index=${query ? "relevance" : "downloads"}`,
    );
    return { hits: r.hits.map((h) => mrHit({ ...h, id: h.project_id }, h.author)), total: r.total_hits };
  },
  async hit(projectId) {
    const p = await mr<MrProject>(`/project/${encodeURIComponent(projectId)}`);
    return mrHit(p, await mrAuthor(p.id));
  },
  async target(projectId, f, versionId) {
    const p = await mr<MrProject>(`/project/${encodeURIComponent(projectId)}`);
    let v: MrVersion;
    if (versionId) {
      v = await mr<MrVersion>(`/version/${encodeURIComponent(versionId)}`);
      if (v.project_id !== p.id) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "version belongs to another project");
      if (!v.loaders.some((l) => f.loaders.includes(l)) || (f.gameVersion && !v.game_versions.includes(f.gameVersion))) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "INCOMPATIBLE_VERSION");
    } else {
      const q = [`loaders=${enc(f.loaders)}`, f.gameVersion ? `game_versions=${enc([f.gameVersion])}` : ""].filter(Boolean).join("&");
      const list = await mr<MrVersion[]>(`/project/${encodeURIComponent(projectId)}/version?${q}`);
      const pick = list.find((x) => x.version_type === "release") ?? list[0];
      if (!pick) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "NO_COMPATIBLE_VERSION");
      v = pick;
    }
    return mrTarget(p, v);
  },
};

// ---------- Hangar ----------

interface HgProject { name: string; namespace: { owner: string; slug: string }; description: string; avatarUrl: string | null; stats: { downloads: number } }
interface HgVersion {
  name: string;
  channel?: { name?: string } | string;
  downloads: Record<string, { fileInfo?: { name: string; sizeBytes: number; sha256Hash: string }; downloadUrl?: string | null; externalUrl?: string | null } | undefined>;
  pluginDependencies?: Record<string, Array<{ name: string; required: boolean; namespace?: { owner: string; slug: string } | null }> | undefined>;
}

const hg = <T>(path: string) => fetchJson<T>(`${HANGAR_API}${path}`, { hosts: ["hangar.papermc.io"] });
export const hangarPlatform = (loaders: string[]) => (loaders.includes("velocity") ? "VELOCITY" : "PAPER");

const hgHit = (p: HgProject): ContentHit => ({
  source: "hangar",
  projectId: p.namespace.slug,
  name: p.name,
  description: p.description,
  author: p.namespace.owner,
  downloads: p.stats.downloads,
  iconUrl: p.avatarUrl,
  url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
});

const channelOf = (v: HgVersion) => (typeof v.channel === "string" ? v.channel : (v.channel?.name ?? ""));

export const hangar: SourceClient = {
  async search(f, query, offset) {
    const q = new URLSearchParams({ q: query, platform: hangarPlatform(f.loaders), limit: String(PAGE), offset: String(offset), sort: "-downloads" });
    if (f.gameVersion) q.set("version", f.gameVersion);
    const r = await hg<{ pagination: { count: number }; result: HgProject[] }>(`/projects?${q}`);
    return { hits: r.result.map(hgHit), total: r.pagination.count };
  },
  async hit(projectId) {
    return hgHit(await hg<HgProject>(`/projects/${encodeURIComponent(projectId)}`));
  },
  async target(projectId, f, versionId) {
    const platform = hangarPlatform(f.loaders);
    const p = await hg<HgProject>(`/projects/${encodeURIComponent(projectId)}`);
    let v: HgVersion | undefined;
    if (versionId) {
      v = await hg<HgVersion>(`/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`);
    } else {
      const q = new URLSearchParams({ platform, limit: "25" });
      if (f.gameVersion) q.set("platformVersion", f.gameVersion);
      const list = (await hg<{ result: HgVersion[] }>(`/projects/${encodeURIComponent(projectId)}/versions?${q}`)).result;
      v = list.find((x) => /release/i.test(channelOf(x)) && x.downloads[platform]) ?? list.find((x) => x.downloads[platform]);
    }
    const d = v?.downloads[platform];
    if (!v || !d) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "NO_COMPATIBLE_VERSION");
    if (!d.fileInfo?.sha256Hash) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "version has no sha256 hash");
    const url = d.downloadUrl ?? (d.externalUrl ? null : `${HANGAR_API}/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(v.name)}/${platform}/download`);
    if (!url) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "EXTERNAL_DOWNLOAD_ONLY");
    return {
      projectId: p.namespace.slug,
      name: p.name,
      versionId: v.name,
      versionNumber: v.name,
      filename: d.fileInfo.name,
      size: d.fileInfo.sizeBytes,
      url,
      hash: { algo: "sha256", hex: d.fileInfo.sha256Hash },
      dependencies: (v.pluginDependencies?.[platform] ?? []).filter((x) => x.required && x.namespace?.slug).map((x) => ({ projectId: x.namespace!.slug })),
    };
  },
};

export const sourceClient = (s: ContentSource): SourceClient => (s === "modrinth" ? modrinth : hangar);
