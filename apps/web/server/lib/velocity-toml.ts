/**
 * velocity.toml bijwerken voor het Minecraft-netwerk: alleen `[servers]` (servers + `try`),
 * `[forced-hosts]` en `player-info-forwarding-mode`; de rest van het bestand (en commentaar in die
 * secties) blijft staan. Beide secties zijn van het panel: sleutels die er al stonden verdwijnen.
 */
export interface TomlMember {
  name: string;
  address: string;
}

const isHeader = (l: string) => /^\s*\[/.test(l);
const sectionHeader = (name: string) => (l: string) => new RegExp(`^\\s*\\[${name}\\]\\s*(#.*)?$`).test(l);
const isServersHeader = sectionHeader("servers");
const isForcedHeader = sectionHeader("forced-hosts");
const isKeyLine = (l: string) => /^\s*("[^"]*"|[A-Za-z0-9_.-]+)\s*=/.test(l);

export interface TomlForcedHost {
  hostname: string;
  /** Servernamen uit `[servers]`, in volgorde van proberen. */
  servers: string[];
}

/**
 * Vervangt de sleutelregels van sectie `[name]` door `body` (commentaar blijft); ontbreekt de sectie,
 * dan komt hij achteraan.
 */
function replaceSection(lines: string[], isHead: (l: string) => boolean, name: string, body: string[]): string[] {
  const si = lines.findIndex(isHead);
  if (si < 0) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", `[${name}]`, ...body, "");
    return lines;
  }
  let end = lines.findIndex((l, i) => i > si && isHeader(l));
  if (end < 0) end = lines.length;
  const kept: string[] = [];
  for (let i = si + 1; i < end; i++) {
    const l = lines[i]!;
    if (!isKeyLine(l)) {
      kept.push(l);
      continue;
    }
    // Meerregelige array: doorgaan tot de regel met de sluitende `]`.
    const value = l.slice(l.indexOf("=") + 1).replace(/#.*$/, "");
    if (value.trim().startsWith("[") && !value.includes("]")) while (i + 1 < end && !lines[++i]!.includes("]"));
  }
  const needBlank = end < lines.length && !(kept.length && kept[kept.length - 1]!.trim() === "");
  lines.splice(si + 1, end - si - 1, ...body, ...kept, ...(needBlank ? [""] : []));
  return lines;
}

/**
 * Members in volgorde van `try` (de standaardserver eerst). `forced` = de forced hosts; weggelaten
 * laat `[forced-hosts]` staan zoals hij is (oude aanroepers), een lege lijst maakt hem leeg.
 */
export function applyNetworkToml(src: string, members: TomlMember[], forced?: TomlForcedHost[]): string {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);

  // 1. Top-level player-info-forwarding-mode (vóór de eerste tabel).
  let firstTable = lines.findIndex(isHeader);
  if (firstTable < 0) firstTable = lines.length;
  const modeLine = 'player-info-forwarding-mode = "modern"';
  const mi = lines.slice(0, firstTable).findIndex((l) => /^\s*player-info-forwarding-mode\s*=/.test(l));
  if (mi >= 0) lines[mi] = modeLine;
  else lines.splice(firstTable, 0, modeLine, ...(firstTable < lines.length ? [""] : []));

  // 2. [servers]: sleutelregels (ook meerregelige arrays) vervangen, commentaar laten staan.
  const body = [...members.map((m) => `${m.name} = ${JSON.stringify(m.address)}`), `try = [${members.map((m) => JSON.stringify(m.name)).join(", ")}]`];
  let out = replaceSection(lines, isServersHeader, "servers", body);

  // 3. [forced-hosts]: alleen naar servers die in [servers] staan (anders weigert Velocity de config).
  if (forced) {
    const known = new Set(members.map((m) => m.name));
    const fbody = forced
      .map((f) => ({ hostname: f.hostname, servers: f.servers.filter((n) => known.has(n)) }))
      .filter((f) => f.servers.length)
      .map((f) => `${JSON.stringify(f.hostname)} = [${f.servers.map((n) => JSON.stringify(n)).join(", ")}]`);
    out = replaceSection(out, isForcedHeader, "forced-hosts", fbody);
  }
  return out.join(eol);
}
