/**
 * Minecraft-spelers (tab Spelers): online-lijst, whitelist, operators en bans.
 * Lezen vereist `players.read`, wijzigen `players.manage`.
 */
import { z } from "zod";

/** Java-spelersnaam: precies wat Mojang toestaat. */
export const JAVA_PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
/** Bedrock-speler via Geyser/Floodgate: standaardprefix `.` + gamertag (spaties worden `_`), samen max 16. */
export const BEDROCK_PLAYER_NAME = /^\.[A-Za-z0-9_]{1,15}$/;

export const isJavaPlayerName = (n: string) => JAVA_PLAYER_NAME.test(n);
export const isBedrockPlayerName = (n: string) => BEDROCK_PLAYER_NAME.test(n);
/** Geldige naam; Bedrock-namen alleen als `floodgate` aan staat. */
export const isValidPlayerName = (n: string, floodgate: boolean) => isJavaPlayerName(n) || (floodgate && isBedrockPlayerName(n));

/** Welk soort spelerbeheer een template heeft: `java` (volledig), `proxy` (Velocity: alleen de online-lijst) of geen. */
export function playersPlatform(slug: string): "java" | "proxy" | null {
  if (slug === "paper" || slug === "folia" || slug === "fabric" || slug === "java-generic" || slug === "vanilla") return "java";
  if (slug === "velocity") return "proxy";
  return null;
}

/** Strikt: alleen deze tekens komen ooit in een consolecommando terecht. */
export const PlayerName = z.string().refine((n) => isJavaPlayerName(n) || isBedrockPlayerName(n), { message: "INVALID_PLAYER_NAME" });
/** Reden voor ban/kick: geen stuurtekens of regeleinden (anders een tweede commando), max 200. */
export const PlayerReason = z
  .string()
  .max(200)
  .refine((r) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(r), { message: "INVALID_REASON" })
  .transform((r) => r.trim());
export const PlayerIp = z.union([z.ipv4(), z.ipv6()]);
const MinecraftUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const PlayerOp = z.discriminatedUnion("action", [
  z.object({ action: z.literal("whitelistOn") }),
  z.object({ action: z.literal("whitelistOff") }),
  z.object({ action: z.literal("whitelistAdd"), name: PlayerName }),
  z.object({ action: z.literal("whitelistRemove"), name: PlayerName }),
  z.object({ action: z.literal("op"), name: PlayerName }),
  z.object({ action: z.literal("deop"), name: PlayerName }),
  z.object({ action: z.literal("ban"), name: PlayerName, reason: PlayerReason.optional() }),
  z.object({ action: z.literal("pardon"), name: PlayerName }),
  /** Draaiend: IP of naam van een online speler; gestopt alleen een IP. */
  z.object({ action: z.literal("banIp"), target: z.union([PlayerIp, PlayerName]), reason: PlayerReason.optional() }),
  z.object({ action: z.literal("pardonIp"), ip: PlayerIp }),
  /** Alleen bij een draaiende server. */
  z.object({ action: z.literal("kick"), name: PlayerName, reason: PlayerReason.optional() }),
]);
export type PlayerOp = z.infer<typeof PlayerOp>;
export type PlayerAction = PlayerOp["action"];

export const ListedPlayer = z.object({ name: z.string(), uuid: MinecraftUuid.nullable() });
export type ListedPlayer = z.infer<typeof ListedPlayer>;

export const PlayersInfo = z.object({
  /** false: geen Minecraft-server (of generiek Java zonder server.properties). */
  supported: z.boolean(),
  platform: z.enum(["java", "proxy"]).nullable(),
  /** Status `online`: wijzigingen via consolecommando's; anders direct in de JSON-bestanden. */
  running: z.boolean(),
  /** server.properties `online-mode` (achter Velocity met forwarding: true, de proxy logt in). Bepaalt offline-UUID's. */
  onlineMode: z.boolean(),
  /** Floodgate gevonden: Bedrock-namen met prefix `.` zijn toegestaan. */
  floodgate: z.boolean(),
  whitelistEnabled: z.boolean(),
  whitelist: z.array(ListedPlayer),
  ops: z.array(ListedPlayer.extend({ level: z.number().int().min(0).max(4) })),
  bans: z.array(ListedPlayer.extend({ reason: z.string().nullable(), source: z.string().nullable(), created: z.string().nullable(), expires: z.string().nullable() })),
  ipBans: z.array(z.object({ ip: z.string(), reason: z.string().nullable(), source: z.string().nullable(), created: z.string().nullable(), expires: z.string().nullable() })),
});
export type PlayersInfo = z.infer<typeof PlayersInfo>;

export const OnlinePlayer = z.object({
  name: z.string(),
  uuid: MinecraftUuid.nullable(),
  /** Velocity: de backend waar de speler op zit. */
  server: z.string().nullable(),
});
export type OnlinePlayer = z.infer<typeof OnlinePlayer>;

export const PlayersOnline = z.object({
  running: z.boolean(),
  online: z.number().int().nullable(),
  max: z.number().int().nullable(),
  players: z.array(OnlinePlayer),
  /** false: alleen een deel bekend (bv. ping-sample van 12 en `list` niet te lezen). */
  complete: z.boolean(),
  /** `ping`: server-list-ping; `console`: `list uuids` / Velocity `glist all` op de console. */
  source: z.enum(["ping", "console", "none"]),
});
export type PlayersOnline = z.infer<typeof PlayersOnline>;
