/**
 * Beveiligde uitgaande HTTP voor Modrinth/Hangar/PaperMC/Fabric: alleen https, vaste host-allowlist
 * (ook na redirects), time-out en groottelimiet. Gedownloade inhoud wordt nooit uitgevoerd.
 */
export const USER_AGENT = "bssg-panel/1.0";

export class ExternalError extends Error {
  constructor(readonly code: "EXTERNAL_FETCH_FAILED" | "EXTERNAL_TOO_LARGE" | "EXTERNAL_HOST_NOT_ALLOWED" | "HASH_MISMATCH" | "EXTERNAL_BAD_RESPONSE", message: string) {
    super(`${code}: ${message}`);
  }
}

export interface FetchOptions {
  /** Toegestane hostnamen (exact). */
  hosts: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
}

function checkUrl(raw: string, hosts: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ExternalError("EXTERNAL_HOST_NOT_ALLOWED", `invalid URL`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !hosts.includes(u.hostname)) throw new ExternalError("EXTERNAL_HOST_NOT_ALLOWED", u.hostname);
  return u;
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new ExternalError("EXTERNAL_TOO_LARGE", `${len} > ${maxBytes}`);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ExternalError("EXTERNAL_TOO_LARGE", `> ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** GET met handmatige redirects (max 3), elk doel opnieuw tegen de allowlist gecontroleerd. */
export async function fetchBytes(url: string, o: FetchOptions): Promise<Buffer> {
  let target = checkUrl(url, o.hosts).toString();
  const signal = AbortSignal.timeout(o.timeoutMs ?? 20_000);
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await fetch(target, { headers: { "user-agent": USER_AGENT, accept: "*/*" }, redirect: "manual", signal, cache: "no-store" });
    } catch (e) {
      throw new ExternalError("EXTERNAL_FETCH_FAILED", (e as Error).message);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "redirect without location");
      target = checkUrl(new URL(loc, target).toString(), o.hosts).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ExternalError("EXTERNAL_FETCH_FAILED", `${new URL(target).hostname} answered ${res.status}`);
    }
    try {
      return await readLimited(res, o.maxBytes);
    } catch (e) {
      if (e instanceof ExternalError) throw e;
      throw new ExternalError("EXTERNAL_FETCH_FAILED", (e as Error).message);
    }
  }
  throw new ExternalError("EXTERNAL_FETCH_FAILED", "too many redirects");
}

export async function fetchJson<T = unknown>(url: string, o: Omit<FetchOptions, "maxBytes"> & { maxBytes?: number }): Promise<T> {
  const buf = await fetchBytes(url, { ...o, maxBytes: o.maxBytes ?? 8 * 1024 * 1024, timeoutMs: o.timeoutMs ?? 10_000 });
  try {
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    throw new ExternalError("EXTERNAL_BAD_RESPONSE", "not JSON");
  }
}
