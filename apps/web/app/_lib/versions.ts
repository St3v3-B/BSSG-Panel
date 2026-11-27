/** Version helpers for the version picker. */

const parts = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));

/** Compares release-like versions ("1.21.4" < "1.21.10"); pre-release suffixes sort before the release. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (p === undefined) return typeof q === "string" ? 1 : -1; // "1.21" vs "1.21-rc1" / "1.21.1"
    if (q === undefined) return typeof p === "string" ? -1 : 1;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p).localeCompare(String(q));
  }
  return 0;
}

/** True when `next` is a lower version than `current`; `latest` or unknown values never count as a downgrade. */
export function isDowngrade(current: string, next: string): boolean {
  if (!current || !next || current === "latest" || next === "latest") return false;
  return compareVersions(next, current) < 0;
}
