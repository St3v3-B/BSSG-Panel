/** Minecraft-netwerk: welke templates een proxy of backend zijn (op één plek, makkelijk uit te breiden). */

/** Template-slugs van proxy-servers. */
export const PROXY_TEMPLATE_SLUGS: readonly string[] = ["velocity"];
/** Template-slugs van game-servers die achter een proxy kunnen hangen. */
export const BACKEND_TEMPLATE_SLUGS: readonly string[] = ["paper", "folia", "fabric"];

export const isProxyTemplate = (slug: string) => PROXY_TEMPLATE_SLUGS.includes(slug);
export const isBackendTemplate = (slug: string) => BACKEND_TEMPLATE_SLUGS.includes(slug);

/** Standaardnaam voor een backend uit de servernaam: kleine letters, `[a-z0-9-]`, max 32 tekens. */
export function suggestBackendName(serverName: string): string {
  const n = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return n || "server";
}

/**
 * Bedrock-platform per template-slug (zoals GeyserMC ze noemt); `null` = geen Bedrock-ondersteuning.
 * `fabric`: Geyser-Fabric + Floodgate-Fabric (+ Fabric API) als mods, bij de Minecraft-versie via Modrinth.
 */
export function bedrockPlatform(slug: string): "spigot" | "velocity" | "fabric" | null {
  if (slug === "paper" || slug === "folia") return "spigot";
  if (slug === "velocity") return "velocity";
  if (slug === "fabric") return "fabric";
  return null;
}
