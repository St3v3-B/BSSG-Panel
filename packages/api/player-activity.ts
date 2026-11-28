/**
 * Speleractiviteit per server (tab Activiteit): wie wanneer online was, piekuren, en start/stop/crash/sleep/wake.
 *
 * Bron: de daemon herkent join/leave in de console met de patronen uit de template (`player_events`, presets
 * hieronder) en meldt ze via `POST /api/remote/servers/{uuid}/players`. Het panel houdt sessies bij en sluit
 * ze bij stop/crash/slaap; een periodieke ping is het vangnet (bv. na een daemon-herstart). Lezen: players.read.
 */
import { z } from "zod";
import { playersPlatform } from "./players";
import { ServerRef } from "./schemas";

/** Patronen zoals de daemon ze krijgt (ServerSpec.player_events). */
export interface PlayerEventPatterns {
  join: string;
  leave: string;
  uuid?: string;
}

const NAME = String.raw`(?<name>\.?[A-Za-z0-9_]{1,16})`;
/** vanilla/Fabric/Forge: `[12:34:56] [Server thread/INFO]: `, `… (Minecraft) `, `… [logger]: `. */
const MC_SERVER_THREAD = String.raw`\[[^\]]+\] \[Server thread/INFO\](?: \[[^\]]+\]| \([^)]+\))?:? `;
const MC_ANY_THREAD = String.raw`\[[^\]]+\] \[[^\]/]+/INFO\](?: \[[^\]]+\]| \([^)]+\))?:? `;
/** Paper/Folia/Velocity: `[12:34:56 INFO]: `. */
const SHORT = String.raw`\[\d{2}:\d{2}:\d{2} INFO\]: `;

/**
 * Ingebouwde patronen. Ze dekken de hele regel en eisen de naam direct na het logvoorvoegsel: chat
 * (`<naam> …`, `[Not Secure] <naam> …`, `* naam …`, `[naam] …`) matcht daardoor nooit.
 * Velocity: alleen verbinden met/verbreken van de proxy (niet het wisselen tussen backends).
 */
export const PLAYER_EVENT_PRESETS = {
  minecraft: {
    join: `^(?:${MC_SERVER_THREAD}|${SHORT})${NAME} joined the game$`,
    leave: `^(?:${MC_SERVER_THREAD}|${SHORT})${NAME} left the game$`,
    uuid: `^(?:${MC_ANY_THREAD}|${SHORT})UUID of player ${NAME} is (?<uuid>[0-9a-fA-F-]{32,36})$`,
  },
  velocity: {
    join: `^${SHORT}\\[connected player\\] ${NAME} \\([^)]*\\) has connected$`,
    leave: `^${SHORT}\\[connected player\\] ${NAME} \\([^)]*\\) has disconnected$`,
  },
} as const satisfies Record<string, PlayerEventPatterns>;
export type PlayerEventPreset = keyof typeof PLAYER_EVENT_PRESETS;

/** Templateveld `player_events`: een preset, `none`, of eigen patronen. */
export const TemplatePlayerEvents = z.union([
  z.enum(["minecraft", "velocity", "none"]),
  z.object({ join: z.string().min(1).max(1000), leave: z.string().min(1).max(1000), uuid: z.string().min(1).max(1000).optional() }),
]);
export type TemplatePlayerEvents = z.infer<typeof TemplatePlayerEvents>;

/** Fouten in eigen patronen (JS-RegExp als benadering van RE2; de daemon controleert ook). */
export function playerEventErrors(v: TemplatePlayerEvents | undefined): string[] {
  if (!v || typeof v === "string") return [];
  const errs: string[] = [];
  const check = (field: string, p: string | undefined, groups: string[]) => {
    if (p === undefined) return;
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch (e) {
      errs.push(`${field}: ${(e as Error).message}`);
      return;
    }
    for (const g of groups) if (!re.source.includes(`(?<${g}>`)) errs.push(`${field}: group (?<${g}>…) missing`);
  };
  check("join", v.join, ["name"]);
  check("leave", v.leave, ["name"]);
  check("uuid", v.uuid, ["name", "uuid"]);
  return errs;
}

/** De patronen voor een template: expliciet veld, anders de standaard per slug (Minecraft/Velocity). null = niet bijgehouden. */
export function resolvePlayerEvents(slug: string, v: TemplatePlayerEvents | undefined): PlayerEventPatterns | null {
  const pick = v ?? (playersPlatform(slug) === "java" ? "minecraft" : playersPlatform(slug) === "proxy" ? "velocity" : "none");
  if (pick === "none") return null;
  if (typeof pick === "string") return { ...PLAYER_EVENT_PRESETS[pick] };
  return { join: pick.join, leave: pick.leave, ...(pick.uuid ? { uuid: pick.uuid } : {}) };
}

// ---------- tRPC ----------

/** Hoe lang het panel sessies en servergebeurtenissen bewaart. */
export const PLAYER_ACTIVITY_RETENTION_DAYS = 90;

export const SessionEndReason = z.enum(["leave", "server_stop", "crash", "sleep", "unknown"]);
export type SessionEndReason = z.infer<typeof SessionEndReason>;

export const PlayerSession = z.object({
  id: z.number().int(),
  name: z.string(),
  uuid: z.string().nullable(),
  joinedAt: z.date(),
  /** null = nog online. */
  leftAt: z.date().nullable(),
  endReason: SessionEndReason.nullable(),
});
export type PlayerSession = z.infer<typeof PlayerSession>;

export const ServerEventKind = z.enum(["start", "stop", "crash", "sleep", "wake"]);
export type ServerEventKind = z.infer<typeof ServerEventKind>;
export const ServerTimelineEvent = z.object({ at: z.date(), kind: ServerEventKind });
export type ServerTimelineEvent = z.infer<typeof ServerTimelineEvent>;

export const ActivityRange = z.enum(["day", "week"]);
export type ActivityRange = z.infer<typeof ActivityRange>;

export const ActivityTimeline = z.object({
  /** false: deze server/template houdt geen speleractiviteit bij (alles leeg). */
  tracked: z.boolean(),
  range: ActivityRange,
  from: z.date(),
  to: z.date(),
  /** Sessies die het venster overlappen, oudste eerst. */
  sessions: z.array(PlayerSession),
  events: z.array(ServerTimelineEvent),
  /** Meer sessies dan het maximum (2000): de oudste ontbreken. */
  truncated: z.boolean(),
});
export type ActivityTimeline = z.infer<typeof ActivityTimeline>;

export const ActivityPlayer = z.object({
  name: z.string(),
  uuid: z.string().nullable(),
  sessions: z.number().int(),
  /** Speeltijd in het venster (seconden). */
  totalSeconds: z.number().int(),
  firstSeen: z.date(),
  lastSeen: z.date(),
  online: z.boolean(),
});
export type ActivityPlayer = z.infer<typeof ActivityPlayer>;

export const ActivityPlayers = z.object({ tracked: z.boolean(), days: z.number().int(), players: z.array(ActivityPlayer) });
export type ActivityPlayers = z.infer<typeof ActivityPlayers>;

export const ActivityHeatmap = z.object({
  tracked: z.boolean(),
  days: z.number().int(),
  timezone: z.string(),
  /** 7 rijen (maandag … zondag) × 24 uur: gemiddeld aantal spelers tegelijk in dat uur. */
  cells: z.array(z.array(z.number())),
  max: z.number(),
});
export type ActivityHeatmap = z.infer<typeof ActivityHeatmap>;

export const ActivityCurrent = z.object({ tracked: z.boolean(), sessions: z.array(PlayerSession) });
export type ActivityCurrent = z.infer<typeof ActivityCurrent>;

export const TimelineInput = ServerRef.extend({ range: ActivityRange, /** einde van het venster; standaard nu */ end: z.date().optional() });
export const PlayersInput = ServerRef.extend({ days: z.number().int().min(1).max(PLAYER_ACTIVITY_RETENTION_DAYS).default(30) });
export const HeatmapInput = ServerRef.extend({ days: z.number().int().min(7).max(PLAYER_ACTIVITY_RETENTION_DAYS).default(28) });
