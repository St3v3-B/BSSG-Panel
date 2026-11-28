/**
 * `<input type="datetime-local">` in Europe/Amsterdam, los van de tijdzone van de browser.
 * toLocalInput: Date → "YYYY-MM-DDTHH:mm" (Amsterdamse kloktijd); fromLocalInput: omgekeerd (zomer-/wintertijd goed).
 */
export const PANEL_TZ = "Europe/Amsterdam";

function parts(d: Date): Record<string, number> {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: PANEL_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Verschil (ms) tussen de Amsterdamse kloktijd en UTC op dat moment. */
function offsetAt(d: Date): number {
  const p = parts(d);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(d.getTime() / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInput(d: Date | null | undefined): string {
  if (!d) return "";
  const p = parts(d);
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}`;
}

export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Twee rondes: de offset hangt af van het moment zelf (rond de wisseling van zomer- naar wintertijd).
  let t = asUtc - offsetAt(new Date(asUtc));
  t = asUtc - offsetAt(new Date(t));
  return new Date(t);
}
