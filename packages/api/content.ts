/** Minecraft-inhoud: welke templates plugins of mods ondersteunen, en bronnen/loaders daarvoor. */
import type { ContentKind, ContentSource } from "./schemas";

export interface ContentProfile {
  kind: ContentKind;
  directory: string;
  loaders: string[];
  sources: ContentSource[];
  /** Variabele met de Minecraft-versie (bij Velocity: de proxy-versie, geen spelversie). */
  versionVar: string;
  modpacks: boolean;
}

const PROFILES: Record<string, ContentProfile> = {
  paper: { kind: "plugin", directory: "/plugins", loaders: ["paper", "spigot", "bukkit"], sources: ["modrinth", "hangar"], versionVar: "MINECRAFT_VERSION", modpacks: false },
  folia: { kind: "plugin", directory: "/plugins", loaders: ["folia"], sources: ["modrinth", "hangar"], versionVar: "MINECRAFT_VERSION", modpacks: false },
  velocity: { kind: "plugin", directory: "/plugins", loaders: ["velocity"], sources: ["modrinth", "hangar"], versionVar: "VELOCITY_VERSION", modpacks: false },
  fabric: { kind: "mod", directory: "/mods", loaders: ["fabric"], sources: ["modrinth"], versionVar: "MINECRAFT_VERSION", modpacks: true },
};

export const contentProfile = (templateSlug: string): ContentProfile | null => PROFILES[templateSlug] ?? null;
