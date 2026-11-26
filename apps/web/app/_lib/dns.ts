/** Hulp voor het domeinscherm: statussen, waarschuwingen en uitleg per DNS-provider (teksten in i18n). */
import type { DnsCheck, DnsStatus, SslStatus } from "@panel/api";
import type { BadgeVariant } from "@/app/_components/ui/badge";
import { getT } from "@/app/_lib/i18n";

type RecordStatus = DnsCheck["records"][number]["status"];

const RECORD_VARIANT: Record<RecordStatus, BadgeVariant> = { ok: "success", missing: "destructive", wrong_ip: "destructive", cloudflare_proxy: "warning", unexpected: "warning" };
const DNS_VARIANT: Record<DnsStatus, BadgeVariant> = { unchecked: "secondary", missing: "destructive", wrong_ip: "destructive", cloudflare_proxy: "warning", ok: "success" };
const SSL_VARIANT: Record<SslStatus, BadgeVariant> = { pending: "secondary", dns_wrong: "warning", issuing: "info", active: "success", failed: "destructive" };

export const recordStatus = (s: RecordStatus) => ({ label: getT().dns.record[s], variant: RECORD_VARIANT[s] });
export const dnsStatus = (s: DnsStatus) => ({ label: getT().dns.dns[s], variant: DNS_VARIANT[s] });
export const sslStatus = (s: SslStatus) => ({ ...getT().dns.ssl[s], variant: SSL_VARIANT[s] });
export const warningText = (w: DnsCheck["warnings"][number]) => getT().dns.warnings[w];

export function providerHelp(provider: string): { name: string; steps: string[] } {
  const p = getT().dns.providers as Record<string, { name: string; steps: string[] }>;
  return p[provider] ?? p.other!;
}

/** Het kale domein bij www.x of de www-variant bij x. */
export function wwwCounterpart(hostname: string): string {
  return hostname.startsWith("www.") ? hostname.slice(4) : `www.${hostname}`;
}
