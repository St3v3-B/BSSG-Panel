/** Beschikbare versies uit de PaperMC Fill API (v3) en de Fabric meta API, een uur gecachet. */
import { fetchJson } from "./http";

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();
export const resetVersionCache = () => cache.clear();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) {
    // Bron even onbereikbaar: liever een oude lijst dan een kapotte kiezer.
    if (hit) return hit.value as T;
    throw e;
  }
}

export interface Version {
  id: string;
  stable: boolean;
}

const FILL = "https://fill.papermc.io/v3/projects";
const FABRIC = "https://meta.fabricmc.net/v2/versions";
const RELEASE = /^[0-9]+(\.[0-9]+){1,2}$/;

/** `paper`, `folia` of `velocity`; nieuwste eerst. */
export function fillVersions(project: string): Promise<Version[]> {
  return cached(`fill:${project}`, async () => {
    const r = await fetchJson<{ versions: Array<{ version: { id: string } }> }>(`${FILL}/${project}/versions`, { hosts: ["fill.papermc.io"] });
    return r.versions.map((v) => ({ id: v.version.id, stable: project === "velocity" || /^[0-9]+(\.[0-9]+)*$/.test(v.version.id) }));
  });
}

/** Buildnummers (nieuwste eerst). */
export function fillBuilds(project: string, version: string): Promise<string[]> {
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) return Promise.resolve([]);
  return cached(`fill:${project}:${version}`, async () => {
    const r = await fetchJson<Array<{ id: number }>>(`${FILL}/${project}/versions/${version}/builds`, { hosts: ["fill.papermc.io"] });
    return r.map((b) => b.id).sort((a, b) => b - a).map(String);
  });
}

/** Spelversies voor Fabric; alleen id's die de templatevariabele accepteert (geen snapshots als `24w14a`). */
export function fabricGameVersions(): Promise<Version[]> {
  return cached("fabric:game", async () => {
    const r = await fetchJson<Array<{ version: string; stable: boolean }>>(`${FABRIC}/game`, { hosts: ["meta.fabricmc.net"] });
    return r.filter((v) => RELEASE.test(v.version)).map((v) => ({ id: v.version, stable: v.stable }));
  });
}

export function fabricLoaderVersions(): Promise<Version[]> {
  return cached("fabric:loader", async () => {
    const r = await fetchJson<Array<{ version: string; stable: boolean }>>(`${FABRIC}/loader`, { hosts: ["meta.fabricmc.net"] });
    return r.map((v) => ({ id: v.version, stable: v.stable }));
  });
}

/** Nieuwste stabiele spelversie voor een template (voor `latest`). */
export async function latestGameVersion(templateSlug: string): Promise<string | null> {
  const list = templateSlug === "fabric" ? await fabricGameVersions() : templateSlug === "velocity" ? [] : await fillVersions(templateSlug);
  return list.find((v) => v.stable)?.id ?? null;
}
