/**
 * Host van staging → host van productie in een SQL-dump (mariadb-dump), voor publiceren.
 *
 * Veilig voor geserialiseerde PHP-data (WordPress-opties, widgets, …): elke stringwaarde in een INSERT-regel wordt
 * ontsleuteld (backslash-escapes), en als het een geserialiseerde waarde is, wordt die volledig geparsed en
 * opnieuw opgebouwd met de juiste lengtes (`s:<bytes>:"…";`), ook genest. Een waarde die op geserialiseerde data
 * lijkt maar niet te parsen is, blijft ONGEWIJZIGD (geteld als `skipped`) in plaats van stuk te gaan.
 * Alleen `://<host>` en `:\/\/<host>` (JSON) worden vervangen, en alleen als de host daar eindigt
 * (`staging.test` raakt `staging.test.example` niet). `_binary '…'`-waarden blijven ongemoeid.
 *
 * Alles werkt op bytes (latin1: één teken = één byte), zodat lengtes in bytes kloppen voor UTF-8-inhoud.
 */

export interface RewriteStats {
  replaced: number;
  skipped: number;
}

export interface Rewriter {
  from: string;
  to: string;
  stats: RewriteStats;
  value(v: string): string;
}

const HOST_RE = /^[a-z0-9.-]{1,253}$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function makeRewriter(from: string, to: string, stats: RewriteStats = { replaced: 0, skipped: 0 }): Rewriter {
  if (!HOST_RE.test(from) || !HOST_RE.test(to)) throw new Error("invalid host");
  const tail = "(?![A-Za-z0-9-]|\\.[A-Za-z0-9])";
  const plain = new RegExp(`:(//|\\\\/\\\\/)${escapeRe(from)}${tail}`, "g");
  const replacePlain = (v: string) =>
    v.replace(plain, (_m, sep: string) => {
      stats.replaced++;
      return `:${sep}${to}`;
    });
  const r: Rewriter = {
    from,
    to,
    stats,
    value(v: string): string {
      if (!v.includes(from)) return v;
      if (/^[aOsbidNE]:/.test(v) || v === "N;") {
        const before = { ...stats };
        try {
          const p = parse(v, 0, r);
          if (p.end === v.length) return p.out;
        } catch {
          /* geen geldige serialisatie */
        }
        Object.assign(stats, before);
      }
      // Bevat (ergens) geserialiseerde data die we niet kunnen parsen: niet aanraken.
      if (/[aOs]:\d+:[{"]/.test(v)) {
        stats.skipped++;
        return v;
      }
      return replacePlain(v);
    },
  };
  return r;
}

class Bad extends Error {}

function readUntil(s: string, i: number, ch: string): [string, number] {
  const j = s.indexOf(ch, i);
  if (j < 0) throw new Bad();
  return [s.slice(i, j), j + 1];
}
function readInt(s: string, i: number, end: string): [number, number] {
  const [t, j] = readUntil(s, i, end);
  if (!/^-?\d{1,10}$/.test(t)) throw new Bad();
  return [Number(t), j];
}
function expect(s: string, i: number, lit: string): number {
  if (s.slice(i, i + lit.length) !== lit) throw new Bad();
  return i + lit.length;
}

/** Eén geserialiseerde waarde vanaf positie i; geeft de herschreven tekst en het einde. */
function parse(s: string, i: number, r: Rewriter, depth = 0): { out: string; end: number } {
  if (depth > 64) throw new Bad();
  const t = s[i];
  switch (t) {
    case "N":
      return { out: "N;", end: expect(s, i, "N;") };
    case "b":
    case "i":
    case "d": {
      const j = expect(s, i, `${t}:`);
      const [v, end] = readUntil(s, j, ";");
      if (!/^[-+0-9.eEINFNA]{1,64}$/.test(v)) throw new Bad();
      return { out: `${t}:${v};`, end };
    }
    case "r":
    case "R": {
      const [n, end] = readInt(s, expect(s, i, `${t}:`), ";");
      return { out: `${t}:${n};`, end };
    }
    case "s": {
      const [len, j] = readInt(s, expect(s, i, "s:"), ":");
      if (len < 0) throw new Bad();
      const k = expect(s, j, '"');
      if (k + len + 2 > s.length) throw new Bad();
      const content = s.slice(k, k + len);
      const end = expect(s, k + len, '";');
      const next = r.value(content);
      return { out: `s:${next.length}:"${next}";`, end };
    }
    case "E": {
      // enum: E:<len>:"Class:Case"; (geen hosts erin)
      const [len, j] = readInt(s, expect(s, i, "E:"), ":");
      const k = expect(s, j, '"');
      const end = expect(s, k + len, '";');
      return { out: s.slice(i, end), end };
    }
    case "a": {
      const [n, j] = readInt(s, expect(s, i, "a:"), ":");
      let k = expect(s, j, "{");
      const parts: string[] = [];
      for (let x = 0; x < n * 2; x++) {
        const p = parse(s, k, r, depth + 1);
        parts.push(p.out);
        k = p.end;
      }
      const end = expect(s, k, "}");
      return { out: `a:${n}:{${parts.join("")}}`, end };
    }
    case "O": {
      const [clen, j] = readInt(s, expect(s, i, "O:"), ":");
      const k0 = expect(s, j, '"');
      const cls = s.slice(k0, k0 + clen);
      const [n, k1] = readInt(s, expect(s, k0 + clen, '":'), ":");
      let k = expect(s, k1, "{");
      const parts: string[] = [];
      for (let x = 0; x < n * 2; x++) {
        const p = parse(s, k, r, depth + 1);
        parts.push(p.out);
        k = p.end;
      }
      const end = expect(s, k, "}");
      return { out: `O:${clen}:"${cls}":${n}:{${parts.join("")}}`, end };
    }
    default:
      // C: (Serializable met eigen formaat) en onbekend: niet veilig te herschrijven.
      throw new Bad();
  }
}

// ---------- SQL-regels ----------

const UNESCAPE: Record<string, string> = { "0": "\0", "'": "'", '"': '"', b: "\b", n: "\n", r: "\r", t: "\t", Z: "\x1a", "\\": "\\" };

function unescapeSql(raw: string): string {
  return raw.replace(/\\(.)/gs, (_m, c: string) => UNESCAPE[c] ?? c);
}
function escapeSql(v: string): string {
  return v.replace(/[\0\n\r\\'"\x1a]/g, (c) => (c === "\0" ? "\\0" : c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\x1a" ? "\\Z" : `\\${c}`));
}

/** Herschrijft de stringwaarden van één dumpregel (alleen INSERT-regels met de host erin). */
export function rewriteSqlLine(line: string, r: Rewriter): string {
  if (!line.startsWith("INSERT INTO") || !line.includes(r.from)) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const q = line.indexOf("'", i);
    if (q < 0) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, q);
    // Einde van de string: eerste ' die niet ge-escaped is.
    let j = q + 1;
    while (j < line.length && line[j] !== "'") j += line[j] === "\\" ? 2 : 1;
    if (j >= line.length) return line; // geen geldige regel: ongemoeid laten
    const raw = line.slice(q + 1, j);
    const binary = /_binary\s*$/.test(out);
    if (!binary && raw.includes(r.from)) {
      const v = unescapeSql(raw);
      const next = r.value(v);
      out += `'${next === v ? raw : escapeSql(next)}'`;
    } else {
      out += `'${raw}'`;
    }
    i = j + 1;
  }
  return out;
}

/**
 * Stroom-versie: per regel (mariadb-dump schrijft elke INSERT op één regel). `append` (optioneel) komt aan het
 * eind van de dump, bijvoorbeeld een UPDATE van siteurl/home.
 */
export function rewriteDump(src: ReadableStream<Uint8Array>, r: Rewriter, append?: string): ReadableStream<Uint8Array> {
  let rest: Buffer = Buffer.alloc(0);
  const conv = (line: Buffer) => Buffer.from(rewriteSqlLine(line.toString("latin1"), r), "latin1");
  return src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        let buf = rest.length ? Buffer.concat([rest, Buffer.from(chunk)]) : Buffer.from(chunk);
        for (;;) {
          const nl = buf.indexOf(10);
          if (nl < 0) break;
          c.enqueue(conv(buf.subarray(0, nl + 1)));
          buf = buf.subarray(nl + 1);
        }
        rest = Buffer.from(buf);
      },
      flush(c) {
        if (rest.length) c.enqueue(conv(rest));
        if (append) c.enqueue(Buffer.from(`\n${append}\n`, "utf8"));
      },
    }),
  );
}

/** Zekerheid voor WordPress: siteurl/home ook als de opties-tabel buiten de dump om iets afwijkends heeft. */
export function wordpressSiteUrlSql(prefix: string, from: string, to: string): string {
  if (!/^[A-Za-z0-9_]{1,40}$/.test(prefix) || !HOST_RE.test(from) || !HOST_RE.test(to)) throw new Error("invalid input");
  return `UPDATE \`${prefix}options\` SET option_value = REPLACE(option_value, '://${from}', '://${to}') WHERE option_name IN ('siteurl', 'home');`;
}

/** `$table_prefix` uit wp-config.php (null als niet te vinden). */
export function wordpressPrefix(config: string): string | null {
  const m = /\$table_prefix\s*=\s*['"]([A-Za-z0-9_]{1,40})['"]\s*;/.exec(config);
  return m ? m[1]! : null;
}
