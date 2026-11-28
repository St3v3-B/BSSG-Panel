/** Minimale Cloudflare-API-client (v4): token controleren, zones, DNS-records zetten. */

let base = "https://api.cloudflare.com/client/v4";
/** Alleen voor tests. */
export function setCloudflareBase(url: string | null): void {
  base = url ?? "https://api.cloudflare.com/client/v4";
}

export class CloudflareError extends Error {}

interface CfResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; total_pages: number };
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CloudflareError(`Cloudflare onbereikbaar: ${(e as Error).message}`);
  }
  let j: CfResponse<T>;
  try {
    j = (await res.json()) as CfResponse<T>;
  } catch {
    throw new CloudflareError(`Cloudflare gaf HTTP ${res.status}`);
  }
  if (!res.ok || !j.success) throw new CloudflareError(j.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`);
  return j;
}

export interface Zone {
  id: string;
  name: string;
}

export async function listZones(token: string): Promise<Zone[]> {
  const out: Zone[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await cf<Array<{ id: string; name: string }>>(token, "GET", `/zones?per_page=50&page=${page}`);
    out.push(...r.result.map((z) => ({ id: z.id, name: z.name })));
    if (!r.result_info || r.result_info.page >= r.result_info.total_pages) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Zone waar de hostnaam onder valt (langste match). */
export function zoneFor(zones: Zone[], hostname: string): Zone | null {
  return zones.filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  data?: { priority?: number; weight?: number; port?: number; target?: string };
}

/**
 * Zorgt dat `name` precies één A-record naar `ip` heeft, zonder proxy. Botsende AAAA- en
 * CNAME-records op dezelfde naam gaan weg (een CNAME kan niet naast een A bestaan, en een oude
 * AAAA breekt Let's Encrypt). Geeft een korte samenvatting terug.
 */
export async function setARecord(token: string, zoneId: string, name: string, ip: string): Promise<{ created: number; updated: number; deleted: number }> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&name=${encodeURIComponent(name)}`);
  const recs = r.result.filter((x) => x.name === name);
  const stats = { created: 0, updated: 0, deleted: 0 };
  for (const x of recs.filter((x) => x.type === "AAAA" || x.type === "CNAME")) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    stats.deleted++;
  }
  const as = recs.filter((x) => x.type === "A");
  const body = { type: "A", name, content: ip, ttl: 1, proxied: false };
  if (as.length === 0) {
    await cf(token, "POST", `/zones/${zoneId}/dns_records`, body);
    stats.created++;
  } else {
    if (as[0]!.content !== ip || as[0]!.proxied) {
      await cf(token, "PUT", `/zones/${zoneId}/dns_records/${as[0]!.id}`, body);
      stats.updated++;
    }
    for (const x of as.slice(1)) {
      await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
      stats.deleted++;
    }
  }
  return stats;
}

/** Zorgt voor precies één SRV-record `name` → `0 5 <port> <target>`. */
export async function setSrvRecord(token: string, zoneId: string, name: string, port: number, target: string): Promise<{ created: number; updated: number; deleted: number }> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&name=${encodeURIComponent(name)}`);
  const recs = r.result.filter((x) => x.name === name && x.type === "SRV");
  const stats = { created: 0, updated: 0, deleted: 0 };
  const data = { priority: 0, weight: 5, port, target };
  const body = { type: "SRV", name, ttl: 1, data };
  if (recs.length === 0) {
    await cf(token, "POST", `/zones/${zoneId}/dns_records`, body);
    stats.created++;
    return stats;
  }
  const d = recs[0]!.data;
  if (!d || d.priority !== 0 || d.weight !== 5 || d.port !== port || d.target?.replace(/\.$/, "") !== target) {
    await cf(token, "PUT", `/zones/${zoneId}/dns_records/${recs[0]!.id}`, body);
    stats.updated++;
  }
  for (const x of recs.slice(1)) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    stats.deleted++;
  }
  return stats;
}

/** Zorgt dat er een TXT-record `name` met precies deze waarde bestaat (andere TXT-records op de naam blijven staan). */
export async function addTxtRecord(token: string, zoneId: string, name: string, value: string): Promise<boolean> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&type=TXT&name=${encodeURIComponent(name)}`);
  if (r.result.some((x) => x.name === name && x.content.replace(/^"|"$/g, "") === value)) return false;
  await cf(token, "POST", `/zones/${zoneId}/dns_records`, { type: "TXT", name, content: value, ttl: 60 });
  return true;
}

/** Verwijdert TXT-records `name` met deze waarde. */
export async function removeTxtRecord(token: string, zoneId: string, name: string, value: string): Promise<number> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&type=TXT&name=${encodeURIComponent(name)}`);
  let n = 0;
  for (const x of r.result.filter((x) => x.name === name && x.content.replace(/^"|"$/g, "") === value)) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    n++;
  }
  return n;
}

/** Verwijdert alle A-records op `name` (bij het afmelden van een node). */
export async function removeARecord(token: string, zoneId: string, name: string): Promise<number> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&type=A&name=${encodeURIComponent(name)}`);
  let n = 0;
  for (const x of r.result.filter((x) => x.name === name)) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    n++;
  }
  return n;
}

/** Zorgt voor precies één MX-record op `name` → `target` met deze prioriteit (andere MX-records op de naam gaan weg). */
export async function setMxRecord(token: string, zoneId: string, name: string, target: string, priority: number): Promise<{ created: number; updated: number; deleted: number }> {
  const r = await cf<Array<CfRecord & { priority?: number }>>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&type=MX&name=${encodeURIComponent(name)}`);
  const recs = r.result.filter((x) => x.name === name && x.type === "MX");
  const stats = { created: 0, updated: 0, deleted: 0 };
  const keep = recs.find((x) => x.content.replace(/\.$/, "").toLowerCase() === target && x.priority === priority);
  if (!keep) {
    await cf(token, "POST", `/zones/${zoneId}/dns_records`, { type: "MX", name, content: target, priority, ttl: 1 });
    stats.created++;
  }
  for (const x of recs.filter((x) => x !== keep)) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    stats.deleted++;
  }
  return stats;
}

/**
 * Zorgt dat er op `name` precies één TXT-record begint met `prefix` (hoofdletterongevoelig, bv. `v=spf1`) en dat het
 * `value` is. Andere TXT-records op de naam (zonder dat prefix) blijven staan.
 */
export async function setTxtByPrefix(token: string, zoneId: string, name: string, prefix: string, value: string): Promise<{ created: number; updated: number; deleted: number }> {
  const r = await cf<CfRecord[]>(token, "GET", `/zones/${zoneId}/dns_records?per_page=100&type=TXT&name=${encodeURIComponent(name)}`);
  const unq = (c: string) => c.replace(/^"|"$/g, "").replace(/"\s*"/g, "");
  const recs = r.result.filter((x) => x.name === name && x.type === "TXT" && unq(x.content).toLowerCase().startsWith(prefix.toLowerCase()));
  const stats = { created: 0, updated: 0, deleted: 0 };
  const keep = recs.find((x) => unq(x.content) === value);
  if (!keep) {
    await cf(token, "POST", `/zones/${zoneId}/dns_records`, { type: "TXT", name, content: value, ttl: 1 });
    stats.created++;
  }
  for (const x of recs.filter((x) => x !== keep)) {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${x.id}`);
    stats.deleted++;
  }
  return stats;
}
