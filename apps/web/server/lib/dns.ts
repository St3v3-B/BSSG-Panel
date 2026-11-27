/**
 * DNS-controle voor domeinen: vraagt 1.1.1.1 én 8.8.8.8 (unie van de antwoorden), herkent de
 * DNS-provider aan de NS-records en Cloudflare-proxy aan de IP-reeksen.
 */
import { Resolver } from "node:dns/promises";

export interface DnsLookup {
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  cname(name: string): Promise<string[]>;
  ns(name: string): Promise<string[]>;
  /** SRV-records als "prio weight port target" (target zonder punt). */
  srv(name: string): Promise<string[]>;
}

const RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/** Lege lijst bij NXDOMAIN/NODATA; andere fouten ook leeg (beide resolvers onbereikbaar = leeg). */
async function both(fn: (r: Resolver) => Promise<string[]>): Promise<string[]> {
  const out = await Promise.all(
    RESOLVERS.map(async (ip) => {
      const r = new Resolver({ timeout: 3000, tries: 2 });
      r.setServers([ip]);
      try {
        return await fn(r);
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(out.flat().map((x) => x.toLowerCase().replace(/\.$/, "")))].sort();
}

export const publicDns: DnsLookup = {
  a: (n) => both((r) => r.resolve4(n)),
  aaaa: (n) => both((r) => r.resolve6(n)),
  cname: (n) => both((r) => r.resolveCname(n)),
  ns: (n) => both((r) => r.resolveNs(n)),
  srv: (n) => both(async (r) => (await r.resolveSrv(n)).map((x) => `${x.priority} ${x.weight} ${x.port} ${x.name}`)),
};

let current: DnsLookup = publicDns;
export const dns = (): DnsLookup => current;
/** Alleen voor tests. */
export function setDnsLookup(l: DnsLookup | null): void {
  current = l ?? publicDns;
}

// ---------- Cloudflare ----------

/** https://www.cloudflare.com/ips-v4 */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];

const ip4 = (ip: string) => ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;

export function isCloudflareIp(ip: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const n = ip4(ip);
  return CLOUDFLARE_V4.some((c) => {
    const [base, bits] = c.split("/");
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (n & mask) === (ip4(base!) & mask);
  });
}

// ---------- provider ----------

const PROVIDERS: Array<[string, RegExp]> = [
  ["cloudflare", /\.ns\.cloudflare\.com$/],
  ["transip", /\.transip\.(nl|net|eu)$/],
  ["hostinger", /\.(dns-parking\.com|hostinger\.[a-z.]+)$/],
  ["strato", /\.(strato\.de|rzone\.de|stratoserver\.net)$/],
  ["versio", /\.versio\.(nl|eu|com)$/],
];

export function detectProvider(nameservers: string[]): string {
  for (const [name, re] of PROVIDERS) if (nameservers.some((n) => re.test(n))) return name;
  return "other";
}

/** Tweedelige publieke suffixen die we kennen (genoeg om de apex te bepalen). */
const TWO_PART = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "com.br", "co.za", "co.jp"]);

export function apexOf(hostname: string): string {
  const labels = hostname.replace(/^\*\./, "").split(".");
  const n = TWO_PART.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-n).join(".");
}

// ---------- check ----------

export interface RecordCheck {
  type: "A" | "AAAA" | "CNAME" | "TXT" | "SRV";
  name: string;
  expected: string | null;
  actual: string[];
  status: "missing" | "wrong_ip" | "cloudflare_proxy" | "unexpected" | "ok";
}

export interface CheckResult {
  records: RecordCheck[];
  nameservers: string[];
  provider: string;
  warnings: Array<"cloudflare_proxy" | "stale_aaaa" | "cname_at_apex">;
  dnsStatus: "missing" | "wrong_ip" | "cloudflare_proxy" | "ok";
}

export async function checkDomain(hostname: string, targetIp: string, l: DnsLookup = dns()): Promise<CheckResult> {
  const host = hostname.replace(/^\*\./, "");
  const apex = apexOf(host);
  const isApex = host === apex;
  const name = isApex ? "@" : host.slice(0, -(apex.length + 1));
  const [a, aaaa, cname, nameservers] = await Promise.all([l.a(host), l.aaaa(host), l.cname(host), l.ns(apex)]);
  const warnings: CheckResult["warnings"] = [];
  const records: RecordCheck[] = [];

  let aStatus: CheckResult["dnsStatus"];
  if (a.length === 0) aStatus = "missing";
  else if (a.some(isCloudflareIp)) aStatus = "cloudflare_proxy";
  else if (a.length === 1 && a[0] === targetIp) aStatus = "ok";
  else aStatus = "wrong_ip";
  if (aStatus === "cloudflare_proxy") warnings.push("cloudflare_proxy");
  records.push({ type: "A", name, expected: targetIp, actual: a, status: aStatus });

  // AAAA hoort er niet te zijn (de node doet geen IPv6): oude records breken Let's Encrypt.
  if (aaaa.length) {
    const cf = aStatus === "cloudflare_proxy";
    records.push({ type: "AAAA", name, expected: null, actual: aaaa, status: cf ? "cloudflare_proxy" : "unexpected" });
    if (!cf) warnings.push("stale_aaaa");
  }
  if (cname.length) {
    records.push({ type: "CNAME", name, expected: null, actual: cname, status: isApex ? "unexpected" : "ok" });
    if (isApex) warnings.push("cname_at_apex");
  }
  return { records, nameservers, provider: detectProvider(nameservers), warnings, dnsStatus: aStatus };
}

/** Naam van het SRV-record t.o.v. de apex ("@"-stijl): `_minecraft._tcp` of `_minecraft._tcp.play`. */
export function srvName(hostname: string): string {
  const host = hostname.replace(/^\*\./, "");
  const apex = apexOf(host);
  return host === apex ? "_minecraft._tcp" : `_minecraft._tcp.${host.slice(0, -(apex.length + 1))}`;
}

/** A-controle plus het SRV-record `_minecraft._tcp.<host>` → `0 5 <port> <host>`. */
export async function checkMinecraftDomain(hostname: string, targetIp: string, port: number, l: DnsLookup = dns()): Promise<CheckResult> {
  const r = await checkDomain(hostname, targetIp, l);
  const host = hostname.toLowerCase();
  const expected = `0 5 ${port} ${host}`;
  const actual = await l.srv(`_minecraft._tcp.${host}`);
  const status: RecordCheck["status"] = actual.length === 0 ? "missing" : actual.includes(expected) ? "ok" : "wrong_ip";
  r.records.push({ type: "SRV", name: srvName(host), expected, actual, status });
  if (r.dnsStatus === "ok" && status !== "ok") r.dnsStatus = status === "missing" ? "missing" : "wrong_ip";
  return r;
}
