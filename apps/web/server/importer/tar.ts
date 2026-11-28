/**
 * Minimale tar-schrijver (ustar + PAX voor lange paden) als ReadableStream, voor de import via SFTP:
 * bestanden worden één voor één gelezen en meteen als tar naar de daemon gestuurd (geen tijdelijke kopie).
 * Een bestand dat tijdens het lezen groeit of krimpt wordt afgekapt of met nullen aangevuld tot de opgegeven
 * grootte, zodat de tar altijd geldig blijft.
 */

export type TarEntry =
  | { type: "dir"; path: string; mode?: number; mtime?: number }
  | { type: "file"; path: string; size: number; mode?: number; mtime?: number; open: () => AsyncIterable<Uint8Array> };

const enc = new TextEncoder();
const BLOCK = 512;

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

function header(name: string, size: number, mode: number, mtime: number, flag: string, prefix = ""): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  put(name, 0, 100);
  put(octal(mode & 0o7777, 8), 100, 8);
  put(octal(1000, 8), 108, 8); // uid
  put(octal(1000, 8), 116, 8); // gid
  put(size > 0o77777777777 ? "" : octal(size, 12), 124, 12);
  put(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12);
  put("        ", 148, 8); // checksum-placeholder
  put(flag, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function pax(records: Record<string, string>): Uint8Array {
  let body = "";
  for (const [k, v] of Object.entries(records)) {
    const rest = ` ${k}=${v}\n`;
    let len = enc.encode(rest).length;
    len += String(len + String(len).length).length;
    body += `${len}${rest}`;
  }
  return enc.encode(body);
}

const pad = (n: number) => (n % BLOCK === 0 ? 0 : BLOCK - (n % BLOCK));

/** Normaliseert een pad: relatief, zonder `..`, met `/` als scheiding. Ongeldig → null. */
export function safeTarPath(p: string): string | null {
  const parts = p.split("/").filter((x) => x && x !== ".");
  if (parts.some((x) => x === "..")) return null;
  return parts.length ? parts.join("/") : null;
}

function* headers(path: string, size: number, mode: number, mtime: number, flag: string): Generator<Uint8Array> {
  const name = flag === "5" ? `${path}/` : path;
  const bytes = enc.encode(name);
  if (bytes.length > 100 || size > 0o77777777777) {
    const rec: Record<string, string> = { path: name };
    if (size > 0o77777777777) rec.size = String(size);
    const body = pax(rec);
    yield header("PaxHeader", body.length, 0o644, mtime, "x");
    yield body;
    if (pad(body.length)) yield new Uint8Array(pad(body.length));
    yield header(name.slice(-100), size, mode, mtime, flag);
  } else {
    yield header(name, size, mode, mtime, flag);
  }
}

/** Bouwt de tar-stroom; `onBytes` krijgt het aantal geschreven databytes (voor voortgang). */
export function tarStream(entries: AsyncIterable<TarEntry>, onBytes?: (n: number) => void): ReadableStream<Uint8Array> {
  async function* gen(): AsyncGenerator<Uint8Array> {
    for await (const e of entries) {
      const path = safeTarPath(e.path);
      if (!path) continue;
      const mtime = e.mtime ?? Date.now() / 1000;
      if (e.type === "dir") {
        yield* headers(path, 0, e.mode ?? 0o755, mtime, "5");
        continue;
      }
      yield* headers(path, e.size, e.mode ?? 0o644, mtime, "0");
      let left = e.size;
      for await (const chunk of e.open()) {
        if (left <= 0) break;
        const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
        left -= part.length;
        onBytes?.(part.length);
        yield part;
      }
      // Kleiner geworden tijdens het lezen: aanvullen tot de aangekondigde grootte.
      while (left > 0) {
        const n = Math.min(left, 64 * 1024);
        left -= n;
        yield new Uint8Array(n);
      }
      if (pad(e.size)) yield new Uint8Array(pad(e.size));
    }
    yield new Uint8Array(BLOCK * 2);
  }
  const it = gen();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const r = await it.next();
        if (r.done) ctrl.close();
        else ctrl.enqueue(r.value);
      } catch (e) {
        ctrl.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

/** Leest een tar (ustar/PAX) terug; alleen voor tests en de nep-daemon. */
export function parseTar(buf: Uint8Array): { files: Map<string, Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const dec = new TextDecoder();
  let off = 0;
  let paxPath: string | null = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, l: number) => dec.decode(h.subarray(a, a + l)).replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const flag = str(156, 1) || "0";
    const prefix = str(345, 155);
    let name = (prefix ? `${prefix}/` : "") + str(0, 100);
    off += BLOCK;
    const data = buf.subarray(off, off + size);
    off += size + pad(size);
    if (flag === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (paxPath) {
      name = paxPath;
      paxPath = null;
    }
    if (flag === "5") dirs.add(`/${name.replace(/\/$/, "")}`);
    else if (flag === "0" || flag === "") files.set(`/${name}`, data.slice());
  }
  return { files, dirs };
}
