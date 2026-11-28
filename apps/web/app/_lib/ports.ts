/** Weergave van het protocol en de rol van een poort (allocation of template-poort). */
import type { Allocation } from "@panel/api";
import type { Dict } from "@/app/_lib/i18n";

type Protocol = Allocation["protocol"];

export const protocolText = (p: Protocol, t: Dict) => t.ports[p];

/** " (UDP, Steam query)"; leeg voor een gewone TCP + UDP-poort zonder rol. */
export function portSuffix(a: { protocol?: Protocol; label?: string | null }, t: Dict): string {
  const parts = [a.protocol && a.protocol !== "both" ? protocolText(a.protocol, t) : null, a.label ?? null].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
