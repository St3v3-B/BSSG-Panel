/** Rekenwerk voor de verbruiksgrafieken (los van React, zodat het makkelijk te testen is). */

/** Rondt naar boven af op 1, 2, 2.5 of 5 × 10^n (minimaal `min`). */
export function niceCeil(v: number, min = 1): number {
  if (!Number.isFinite(v) || v <= min) return min;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Zelfde idee voor bytes: 1, 2, 4, 8 × 1024^n (mooie labels als 512 MiB, 2 GiB). */
export function niceBytes(v: number): number {
  if (!Number.isFinite(v) || v <= 1024) return 1024;
  const p = 1024 ** Math.floor(Math.log(v) / Math.log(1024));
  for (const m of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) if (m * p >= v) return m * p;
  return 1024 * p;
}

/**
 * SVG-pad (viewBox `0 0 w h`) door de punten, onderbroken bij null. Een losse meting wordt een
 * kort streepje zodat hij zichtbaar blijft. `area` sluit elk stuk naar de basislijn.
 */
export function buildPath(values: (number | null)[], yMax: number, w: number, h: number, area = false): string {
  const n = values.length;
  if (!n || yMax <= 0) return "";
  const x = (i: number) => ((i + 0.5) / n) * w;
  const y = (v: number) => h - Math.min(1, Math.max(0, v / yMax)) * h;
  const segs: string[] = [];
  let cur: [number, number][] = [];
  const flush = () => {
    if (!cur.length) return;
    if (cur.length === 1) {
      const [px, py] = cur[0]!;
      const half = Math.min(w / n / 2, w / 200);
      cur = [[px - half, py], [px + half, py]];
    }
    const line = cur.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)} ${py.toFixed(2)}`).join("");
    segs.push(area ? `${line}L${cur.at(-1)![0].toFixed(2)} ${h}L${cur[0]![0].toFixed(2)} ${h}Z` : line);
    cur = [];
  };
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) flush();
    else cur.push([x(i), y(v)]);
  });
  flush();
  return segs.join("");
}

/** Gemiddelde, piek en laatste meting van een reeks (null = geen metingen). */
export function summarize(values: (number | null)[], peaks?: (number | null)[]): { avg: number; peak: number; last: number } | null {
  let sum = 0;
  let n = 0;
  let peak = -Infinity;
  let last: number | null = null;
  values.forEach((v, i) => {
    if (v === null) return;
    sum += v;
    n++;
    last = v;
    peak = Math.max(peak, peaks?.[i] ?? v, v);
  });
  return n ? { avg: sum / n, peak, last: last! } : null;
}

/** Index van de stap onder de cursor, of null buiten de grafiek. */
export function indexAt(clientX: number, left: number, width: number, n: number): number | null {
  if (width <= 0 || n <= 0) return null;
  const f = (clientX - left) / width;
  if (f < 0 || f > 1) return null;
  return Math.min(n - 1, Math.floor(f * n));
}
