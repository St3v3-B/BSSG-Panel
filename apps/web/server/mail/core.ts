/**
 * Pure logica van de mailmodule: wachtwoordhashes (Dovecot-formaat), DKIM-sleutels, DNS-records per domein en
 * de beoordeling daarvan (dns_status). Geen database of daemon; zie router.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { MailDnsRecord, MailDnsStatus } from "@panel/api";
import type { DnsLookup } from "../lib/dns";

// ---------- wachtwoorden ----------

export const ARGON2_PARAMS = { algorithm: 2 /* Argon2id */, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const DOVECOT_PREFIX = "{ARGON2ID}";

/** `{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>` zoals Dovecot het leest. */
export async function hashMailPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("password too short");
  return DOVECOT_PREFIX + (await hash(password, ARGON2_PARAMS));
}

export async function verifyMailPassword(stored: string, password: string): Promise<boolean> {
  if (!stored.startsWith(DOVECOT_PREFIX)) return false;
  return verify(stored.slice(DOVECOT_PREFIX.length), password).catch(() => false);
}

// ---------- DKIM ----------

export interface DkimKey {
  /** PKCS#1 PEM ("BEGIN RSA PRIVATE KEY"), voor Rspamd. */
  privateKeyPem: string;
  /** Base64 DER (SubjectPublicKeyInfo), het p=-veld. */
  publicKey: string;
}

export function generateDkimKey(): DkimKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKey: Buffer.from(publicKey).toString("base64") };
}

export const dkimRecordName = (selector: string, domain: string) => `${selector}._domainkey.${domain}`;
export const dkimRecordValue = (publicKey: string) => `v=DKIM1; k=rsa; p=${publicKey}`;

/** Selector bij roteren: `dkim<yyyymmdd>`, met een volgletter als die al bestaat. */
export function nextSelector(existing: string[], now = new Date()): string {
  const base = `dkim${now.toISOString().slice(0, 10).replaceAll("-", "")}`;
  if (!existing.includes(base)) return base;
  for (const c of "bcdefghijklmnopqrstuvwxyz") if (!existing.includes(`${base}${c}`)) return `${base}${c}`;
  return `${base}-${Date.now().toString(36)}`;
}

// ---------- DNS-records ----------

export interface RecordContext {
  domain: string;
  mailHostname: string | null;
  ipv4: string | null;
  ipv6: string | null;
  dkim: { selector: string; publicKey: string } | null;
}

export type RecordId = MailDnsRecord["id"];
export type StoredCheck = Record<string, { status: string; actual: string[]; value?: string }>;

/** De te zetten records, nog zonder status. A/AAAA/PTR alleen als het IP bekend is (informatie/advies). */
export function buildRecords(c: RecordContext): Array<Omit<MailDnsRecord, "status" | "actual">> {
  const host = c.mailHostname ?? "";
  const out: Array<Omit<MailDnsRecord, "status" | "actual">> = [];
  if (c.mailHostname && c.ipv4) out.push({ id: "a", type: "A", name: host, value: c.ipv4, priority: null, required: false, where: "dns" });
  if (c.mailHostname && c.ipv6) out.push({ id: "aaaa", type: "AAAA", name: host, value: c.ipv6, priority: null, required: false, where: "dns" });
  out.push({ id: "mx", type: "MX", name: c.domain, value: host, priority: 10, required: true, where: "dns" });
  out.push({ id: "spf", type: "TXT", name: c.domain, value: "v=spf1 mx -all", priority: null, required: true, where: "dns" });
  if (c.dkim) out.push({ id: "dkim", type: "TXT", name: dkimRecordName(c.dkim.selector, c.domain), value: dkimRecordValue(c.dkim.publicKey), priority: null, required: true, where: "dns" });
  out.push({ id: "dmarc", type: "TXT", name: `_dmarc.${c.domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${c.domain}`, priority: null, required: true, where: "dns" });
  if (c.mailHostname && c.ipv4) out.push({ id: "ptr", type: "PTR", name: c.ipv4, value: host, priority: null, required: false, where: "hosting" });
  return out;
}

type Status = MailDnsRecord["status"];
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const dkimP = (txt: string) => /(?:^|;)\s*p=([^;]*)/i.exec(txt)?.[1]?.replace(/\s+/g, "") ?? null;

/** Beoordeelt één record tegen wat de resolvers teruggeven. */
export function judge(r: Omit<MailDnsRecord, "status" | "actual">, actual: string[], c: RecordContext): { status: Status; actual: string[] } {
  switch (r.id) {
    case "a":
    case "aaaa":
      return { status: actual.length === 0 ? "missing" : actual.includes(r.value.toLowerCase()) ? "ok" : "wrong", actual };
    case "ptr":
      return { status: actual.length === 0 ? "missing" : actual.includes(r.value) ? "ok" : "wrong", actual };
    case "mx": {
      if (!r.value) return { status: "unchecked", actual };
      const hosts = actual.map((x) => x.split(" ").pop()!);
      return { status: actual.length === 0 ? "missing" : hosts.includes(r.value) ? "ok" : "wrong", actual };
    }
    case "spf": {
      const spf = actual.filter((x) => /^v=spf1(\s|$)/i.test(x.trim()));
      if (spf.length === 0) return { status: "missing", actual: spf };
      // Twee SPF-records is ongeldig (permerror).
      if (spf.length > 1) return { status: "wrong", actual: spf };
      const terms = norm(spf[0]!).split(" ");
      const allows =
        terms.includes("mx") || terms.includes("+mx") ||
        (!!c.mailHostname && (terms.includes(`a:${c.mailHostname}`) || terms.includes(`mx:${c.domain}`))) ||
        (!!c.ipv4 && terms.some((t) => t.replace(/^\+/, "") === `ip4:${c.ipv4}` || t.replace(/^\+/, "") === `ip4:${c.ipv4}/32`));
      return { status: allows ? "ok" : "wrong", actual: spf };
    }
    case "dkim": {
      const want = c.dkim?.publicKey ?? "";
      const keys = actual.filter((x) => /v=dkim1|p=/i.test(x));
      if (keys.length === 0) return { status: "missing", actual: keys };
      return { status: keys.some((x) => dkimP(x) === want) ? "ok" : "wrong", actual: keys };
    }
    case "dmarc": {
      const d = actual.filter((x) => /^v=dmarc1\s*(;|$)/i.test(x.trim()));
      if (d.length === 0) return { status: "missing", actual: d };
      return { status: d.length === 1 ? "ok" : "wrong", actual: d };
    }
  }
}

/** Live lookups voor alle records (1.1.1.1 + 8.8.8.8 via lib/dns). */
export async function lookupRecords(records: Array<Omit<MailDnsRecord, "status" | "actual">>, c: RecordContext, l: DnsLookup): Promise<MailDnsRecord[]> {
  const none = async () => [] as string[];
  const txt = l.txt?.bind(l) ?? none;
  return Promise.all(
    records.map(async (r) => {
      const actual =
        r.type === "A" ? await l.a(r.name)
        : r.type === "AAAA" ? await l.aaaa(r.name)
        : r.type === "MX" ? await (l.mx?.bind(l) ?? none)(r.name)
        : r.type === "PTR" ? await (l.ptr?.bind(l) ?? none)(r.name)
        : await txt(r.name);
      return { ...r, ...judge(r, actual, c) };
    }),
  );
}

/** ok = alle verplichte records goed; error = een verplicht record wijst ergens anders heen; anders pending. */
export function dnsStatusOf(records: Array<Pick<MailDnsRecord, "required" | "status">>): MailDnsStatus {
  const req = records.filter((r) => r.required);
  if (req.length && req.every((r) => r.status === "ok")) return "ok";
  if (req.some((r) => r.status === "wrong")) return "error";
  return "pending";
}

/** Records met de bewaarde status van de laatste controle (zonder lookup). */
export function withStoredStatus(records: Array<Omit<MailDnsRecord, "status" | "actual">>, stored: StoredCheck | null): MailDnsRecord[] {
  return records.map((r) => {
    const s = stored?.[r.id];
    // Een veranderde naam/waarde (bv. na DKIM-rotatie of een ander MAIL_HOSTNAME) is opnieuw te controleren.
    if (!s || s.value !== `${r.name}|${r.value}`) return { ...r, status: "unchecked" as const, actual: [] };
    return { ...r, status: s.status as Status, actual: s.actual };
  });
}

/** Wat er van een controle bewaard wordt (status + gevonden waarden + waarvoor gecontroleerd). */
export function toStored(records: MailDnsRecord[]): StoredCheck {
  return Object.fromEntries(records.map((r) => [r.id, { status: r.status, actual: r.actual, value: `${r.name}|${r.value}` }]));
}

// ---------- invoer ----------

/** Splitst de goto-kolom. */
export const splitGoto = (goto: string) => goto.split(",").map((x) => x.trim()).filter(Boolean);
