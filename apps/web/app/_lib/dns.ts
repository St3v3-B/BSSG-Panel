/** Teksten voor het domeinscherm: statussen, waarschuwingen en uitleg per DNS-provider. */
import type { DnsCheck, DnsStatus, SslStatus } from "@panel/api";
import type { BadgeVariant } from "@/app/_components/ui/badge";

type RecordStatus = DnsCheck["records"][number]["status"];
type Warning = DnsCheck["warnings"][number];

export const RECORD_STATUS: Record<RecordStatus, { label: string; variant: BadgeVariant }> = {
  ok: { label: "ok", variant: "success" },
  missing: { label: "ontbreekt", variant: "destructive" },
  wrong_ip: { label: "verkeerd IP", variant: "destructive" },
  cloudflare_proxy: { label: "achter Cloudflare-proxy", variant: "warning" },
  unexpected: { label: "moet weg", variant: "warning" },
};

export const DNS_STATUS: Record<DnsStatus, { label: string; variant: BadgeVariant }> = {
  unchecked: { label: "DNS nog niet gecontroleerd", variant: "secondary" },
  missing: { label: "DNS ontbreekt", variant: "destructive" },
  wrong_ip: { label: "DNS wijst verkeerd", variant: "destructive" },
  cloudflare_proxy: { label: "Cloudflare-proxy aan", variant: "warning" },
  ok: { label: "DNS ok", variant: "success" },
};

export const SSL_STATUS: Record<SslStatus, { label: string; variant: BadgeVariant; hint: string }> = {
  pending: { label: "SSL wacht", variant: "secondary", hint: "Het certificaat wordt aangevraagd zodra de DNS klopt." },
  dns_wrong: { label: "SSL wacht op DNS", variant: "warning", hint: "Let's Encrypt kan het domein nog niet bereiken: zet eerst de records goed." },
  issuing: { label: "SSL aanvragen…", variant: "info", hint: "Het certificaat wordt nu aangevraagd. Dit duurt meestal minder dan een minuut." },
  active: { label: "SSL actief", variant: "success", hint: "De site is bereikbaar via https met een geldig certificaat." },
  failed: { label: "SSL mislukt", variant: "destructive", hint: "Het aanvragen is mislukt. Controleer de DNS; het panel probeert het later opnieuw." },
};

export const WARNINGS: Record<Warning, { title: string; text: string }> = {
  cloudflare_proxy: {
    title: "Oranje wolk staat aan",
    text: "Het record wijst naar Cloudflare in plaats van naar de server. Zet in Cloudflare bij dit record de wolk op grijs (\"DNS only\"). Wil je de proxy houden, zet dan de SSL-modus op Full (strict) zodra het certificaat actief is.",
  },
  stale_aaaa: {
    title: "Er staat nog een AAAA-record",
    text: "De server heeft geen IPv6. Bezoekers en Let's Encrypt kunnen op het oude IPv6-adres vastlopen: verwijder het AAAA-record.",
  },
  cname_at_apex: {
    title: "CNAME op het kale domein",
    text: "Een CNAME op het hoofddomein (@) breekt vaak e-mail en andere records. Gebruik voor @ een A-record naar het IP hieronder.",
  },
};

const PROVIDERS: Record<string, { name: string; steps: string[] }> = {
  cloudflare: {
    name: "Cloudflare",
    steps: ["Log in op dash.cloudflare.com en kies het domein.", "Ga naar DNS → Records en klik op Add record.", "Vul type, naam en waarde in zoals hieronder; zet de wolk op grijs (DNS only).", "Sla op. Cloudflare past het meestal binnen een minuut toe."],
  },
  transip: {
    name: "TransIP",
    steps: ["Log in op het TransIP-controlepaneel en kies Domein & Hosting.", "Klik op het domein en open het tabblad DNS.", "Voeg de records hieronder toe (naam, TTL 1 uur, type, waarde) en klik op Opslaan.", "Verwijder oude A-, AAAA- of CNAME-records met dezelfde naam."],
  },
  hostinger: {
    name: "Hostinger",
    steps: ["Log in op hPanel en ga naar Domeinen → het domein → DNS / Nameservers.", "Verwijder bestaande A- en CNAME-records voor @ en www (die wijzen naar Hostinger).", "Voeg de records hieronder toe en sla op."],
  },
  strato: {
    name: "Strato",
    steps: ["Log in bij Strato en ga naar Domeinen → Domeinbeheer.", "Klik bij het domein op het tandwiel en kies DNS-instellingen.", "Pas het A-record aan (\"Andere IP-adres\") en zet het CNAME-record voor www; sla op.", "Strato kan er tot een uur over doen."],
  },
  versio: {
    name: "Versio",
    steps: ["Log in bij Versio en ga naar Domeinen → het domein → DNS-beheer.", "Bewerk of voeg de records hieronder toe en klik op Opslaan."],
  },
  other: {
    name: "je domeinprovider",
    steps: ["Log in bij de partij waar je het domein hebt gekocht en zoek naar DNS-beheer of DNS-records.", "Voeg de records hieronder toe en verwijder oude records met dezelfde naam.", "Wijzigingen zijn meestal binnen een uur zichtbaar."],
  },
};

export function providerHelp(provider: string) {
  return PROVIDERS[provider] ?? PROVIDERS.other!;
}

/** Het kale domein bij www.x of de www-variant bij x. */
export function wwwCounterpart(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
}
