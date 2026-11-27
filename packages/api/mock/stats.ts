/** Nepgeschiedenis voor `servers.statsHistory` / `statsSparklines`: deterministisch per server en tijdstip. */
import type * as s from "../schemas";

const STEPS: Record<s.StatsRange, { spanS: number; stepS: number }> = {
  "1h": { spanS: 3600, stepS: 60 },
  "24h": { spanS: 86_400, stepS: 300 },
  "7d": { spanS: 7 * 86_400, stepS: 1800 },
  "30d": { spanS: 30 * 86_400, stepS: 7200 },
};

function seedOf(uuid: string): number {
  let h = 2166136261;
  for (const c of uuid) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 2 ** 32;
}

/** Ruis in [0,1) die alleen van (seed, t) afhangt, zodat herladen dezelfde grafiek geeft. */
function noise(seed: number, t: number): number {
  const x = Math.sin(seed * 9301 + t * 0.000_123_7) * 43758.5453;
  return x - Math.floor(x);
}

interface MockServer {
  uuid: string;
  status: s.ServerStatus;
  limits: s.Limits;
}

/** Eén meting op tijdstip t (ms), of null als de server toen niet draaide. */
function sample(x: MockServer, t: number, now: number) {
  const seed = seedOf(x.uuid);
  const running = x.status === "online" || x.status === "starting";
  // Gestopte servers: niets in de laatste 5 uur. Iedereen: een herstart (gat van 20 min) 3 uur geleden en een storing 4 dagen geleden.
  if (!running && now - t < 5 * 3600_000) return null;
  const ago = now - t;
  if (ago > 3 * 3600_000 && ago < 3 * 3600_000 + 20 * 60_000) return null;
  if (ago > 4 * 86_400_000 && ago < 4 * 86_400_000 + 3 * 3600_000) return null;
  const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
  const evening = Math.max(0, Math.sin(((hour - 12) / 24) * Math.PI * 2)); // druk rond 18-21 uur
  const cpuCap = x.limits.cpuPct || 400;
  const n = noise(seed, t);
  const spike = n > 0.97 ? 0.35 : 0;
  const cpu = Math.min(cpuCap, cpuCap * (0.08 + 0.35 * evening + 0.12 * n + spike));
  const ram = x.limits.ramMb * 1024 * 1024;
  const gc = ((t / 60_000 + seed * 100) % 37) / 37; // zaagtand van de garbage collector
  const mem = ram * (0.45 + 0.2 * evening + 0.12 * gc);
  const disk = x.limits.diskMb * 1024 * 1024 * (0.3 + 0.1 * seed) + (t / 86_400_000) * 25e6 % 2e9;
  const rx = (20_000 + 900_000 * evening) * (0.6 + 0.8 * noise(seed + 1, t));
  const tx = rx * (2.5 + noise(seed + 2, t));
  return { cpu, mem, disk, rx, tx };
}

export function mockHistory(x: MockServer, range: s.StatsRange, nowMs = Date.now()): s.StatsHistory {
  const { spanS, stepS } = STEPS[range];
  const step = stepS * 1000;
  const end = Math.floor(nowMs / step) * step + step;
  const from = end - spanS * 1000;
  const points: s.StatsPoint[] = [];
  for (let t = from; t < end; t += step) {
    const v = t > nowMs ? null : sample(x, t, nowMs);
    const peak = v ? 1 + 0.25 * noise(seedOf(x.uuid) + 3, t) : 1;
    points.push({
      t: new Date(t),
      cpuPct: v ? v.cpu : null,
      cpuMaxPct: v ? Math.min(x.limits.cpuPct || Infinity, v.cpu * peak * (stepS > 60 ? 1.3 : 1)) : null,
      memoryBytes: v ? Math.round(v.mem) : null,
      memoryMaxBytes: v ? Math.round(Math.min(x.limits.ramMb * 1024 * 1024, v.mem * (stepS > 60 ? 1.1 : 1))) : null,
      diskBytes: v ? Math.round(v.disk) : null,
      rxBytesPerSec: v ? v.rx : null,
      txBytesPerSec: v ? v.tx : null,
    });
  }
  return {
    range,
    stepSeconds: stepS,
    from: new Date(from),
    to: new Date(end),
    cpuLimitPct: x.limits.cpuPct,
    memoryLimitBytes: x.limits.ramMb * 1024 * 1024,
    diskLimitBytes: x.limits.diskMb * 1024 * 1024,
    points,
  };
}

export function mockSparkline(x: MockServer, nowMs = Date.now()): s.StatsSparkline {
  const h = mockHistory(x, "1h", nowMs);
  return { cpuPct: h.points.map((p) => p.cpuPct), memoryBytes: h.points.map((p) => p.memoryBytes) };
}
