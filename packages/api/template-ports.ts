/**
 * Poorten van een template (`ports` in templates/SCHEMA.md) koppelen aan de allocations van een server.
 * Puur (geen DB): gebruikt door het panel (ServerSpec, aanmaken) en de mock.
 */
import type { PortProtocol, TemplatePort } from "./template-schema";

export interface PortAllocation {
  ip: string;
  port: number;
  /** Protocol van de allocation zelf (admin); geldt als de template de poort niet beschrijft. */
  protocol?: PortProtocol | null;
}

export interface MappedPort {
  ip: string;
  port: number;
  primary: boolean;
  protocol: PortProtocol;
  /** Variabele van de template-poort (`SERVER_PORT`, `QUERY_PORT`, ...); null = extra allocation zonder rol. */
  env: string | null;
  name: string | null;
}

export interface PortMapping {
  /** Zelfde volgorde als de invoer (primair eerst). */
  allocations: MappedPort[];
  /** Extra poortvariabelen (zonder SERVER_PORT, die zet de daemon). */
  env: Record<string, string>;
  /** `env` van verplichte poorten zonder allocation. */
  missing: string[];
}

/**
 * Koppelt template-poorten aan allocations (`allocs[0]` = primair). Volgorde: eerst `exact`-poorten
 * (alleen primair + offset op hetzelfde IP), dan de rest: bij voorkeur primair + offset, anders de eerste
 * vrije extra allocation. Een poort zonder allocation krijgt primair + offset in de env (niet gepubliceerd).
 */
export function mapTemplatePorts(ports: readonly TemplatePort[], allocs: readonly PortAllocation[]): PortMapping {
  const out: MappedPort[] = allocs.map((a, i) => ({ ip: a.ip, port: a.port, primary: i === 0, protocol: a.protocol ?? "both", env: null, name: null }));
  const env: Record<string, string> = {};
  const missing: string[] = [];
  if (!ports.length || !out.length) {
    if (!out.length) for (const p of ports.slice(1)) if (p.required) missing.push(p.env);
    return { allocations: out, env, missing };
  }
  const [first, ...extra] = ports;
  const primary = out[0]!;
  Object.assign(primary, { protocol: first!.protocol, env: first!.env, name: first!.name ?? null });
  const used = new Set<number>([0]);
  const want = (p: TemplatePort) => primary.port + (p.offset ?? 0);
  const assign = (p: TemplatePort, i: number) => {
    used.add(i);
    Object.assign(out[i]!, { protocol: p.protocol, env: p.env, name: p.name ?? null });
    env[p.env] = String(out[i]!.port);
  };
  const byOffset = (p: TemplatePort) => out.findIndex((a, i) => !used.has(i) && a.ip === primary.ip && a.port === want(p));
  const order = [...extra.filter((p) => p.exact), ...extra.filter((p) => !p.exact)];
  const pending: TemplatePort[] = [];
  for (const p of order) {
    const i = byOffset(p);
    if (i >= 0) assign(p, i);
    else if (!p.exact) pending.push(p);
  }
  for (const p of pending) {
    const i = out.findIndex((_, j) => !used.has(j));
    if (i >= 0) assign(p, i);
  }
  for (const p of extra) {
    if (env[p.env] !== undefined) continue;
    env[p.env] = String(Math.min(65535, want(p)));
    if (p.required) missing.push(p.env);
  }
  return { allocations: out, env, missing };
}

/** Minimaal aantal allocations voor deze template (primair + verplichte extra's). */
export const minTemplatePorts = (ports: readonly TemplatePort[]) => 1 + ports.slice(1).filter((p) => p.required).length;
/** Aanbevolen aantal allocations: één per template-poort (minstens 1). */
export const recommendedTemplatePorts = (ports: readonly TemplatePort[]) => Math.max(1, ports.length);

/**
 * Kiest `wanted` allocations uit vrije allocations (gesorteerd op poort) zodat zoveel mogelijk extra poorten op
 * primair + offset vallen (eerst `exact`). Geeft de gekozen ids, primair eerst, of null als er te weinig zijn.
 */
export function pickTemplateAllocations<T extends { id: number; ip: string; port: number }>(free: readonly T[], ports: readonly TemplatePort[], wanted: number): T[] | null {
  if (wanted <= 0) return [];
  if (free.length < wanted) return null;
  const extra = ports.slice(1);
  if (!extra.length) return free.slice(0, wanted);
  const key = (ip: string, port: number) => `${ip}:${port}`;
  const idx = new Map(free.map((a) => [key(a.ip, a.port), a]));
  let best: { a: T; exact: number; any: number } | null = null;
  for (const a of free) {
    let exact = 0;
    let any = 0;
    for (const p of extra.slice(0, wanted - 1)) {
      if (!idx.has(key(a.ip, a.port + (p.offset ?? 0)))) continue;
      any++;
      if (p.exact) exact++;
    }
    if (!best || exact > best.exact || (exact === best.exact && any > best.any)) best = { a, exact, any };
  }
  const picked: T[] = [best!.a];
  for (const p of [...extra.filter((p) => p.exact), ...extra.filter((p) => !p.exact)]) {
    if (picked.length >= wanted) break;
    const m = idx.get(key(best!.a.ip, best!.a.port + (p.offset ?? 0)));
    if (m && !picked.includes(m)) picked.push(m);
  }
  for (const a of free) {
    if (picked.length >= wanted) break;
    if (!picked.includes(a)) picked.push(a);
  }
  return picked;
}
