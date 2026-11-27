/**
 * velocity.toml bijwerken voor het Minecraft-netwerk: alleen `[servers]` (servers + `try`) en
 * `player-info-forwarding-mode`; de rest van het bestand (en commentaar in `[servers]`) blijft staan.
 */
export interface TomlMember {
  name: string;
  address: string;
}

const isHeader = (l: string) => /^\s*\[/.test(l);
const isServersHeader = (l: string) => /^\s*\[servers\]\s*(#.*)?$/.test(l);
const isKeyLine = (l: string) => /^\s*("[^"]*"|[A-Za-z0-9_.-]+)\s*=/.test(l);

/** Members in volgorde van `try` (de standaardserver eerst). */
export function applyNetworkToml(src: string, members: TomlMember[]): string {
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
  const si = lines.findIndex(isServersHeader);
  if (si < 0) {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", "[servers]", ...body, "");
    return lines.join(eol);
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
  return lines.join(eol);
}
