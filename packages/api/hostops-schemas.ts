/**
 * Schema's voor onderhoudsmodus per node (+ evacueren) en de import vanuit Pterodactyl/Pelican.
 * Eigenaar: orchestrator (gemaakt door agent hostops). Wordt via ./schemas.ts geëxporteerd.
 */
import { z } from "zod";

const Id = z.number().int().positive();
const Uuid = z.string().uuid();
const DiscordId = z.string().regex(/^\d{15,21}$/, "invalid Discord ID");
const ServerType = z.enum(["game", "web"]);

// ---------- onderhoud ----------

/**
 * Onderhoud van een node. Zolang dit gezet is komen er geen nieuwe servers op de node (admin, quotum,
 * pakketten, verplaatsen naar de node: PRECONDITION_FAILED `NODE_IN_MAINTENANCE`). `plannedStart`/`plannedEnd`
 * zijn alleen informatie voor de eigenaren (banner); tijden in de UI in Europe/Amsterdam.
 */
export const NodeMaintenance = z.object({
  since: z.date(),
  message: z.string().nullable(),
  plannedStart: z.date().nullable(),
  plannedEnd: z.date().nullable(),
});
export type NodeMaintenance = z.infer<typeof NodeMaintenance>;

export const MaintenanceInput = z.object({
  id: Id,
  message: z.string().trim().max(1000).nullable().default(null),
  plannedStart: z.date().nullable().default(null),
  plannedEnd: z.date().nullable().default(null),
  /** Eigenaren van servers op de node een melding sturen (inbox/Discord/e-mail volgens hun voorkeuren). */
  notifyOwners: z.boolean().default(true),
});

/** Mogelijke doelnode voor één server. `freeRamMb`/`freeDiskMb` null = onbeperkt. */
export const EvacuationTarget = z.object({
  nodeId: Id,
  name: z.string(),
  fits: z.boolean(),
  /** Waarom niet (`NO_DOMAINS`, `RAM`, `DISK`, `ALLOCATIONS`, `OFFLINE`, `MAINTENANCE`, `NOT_READY`); null als hij past. */
  reason: z.string().nullable(),
  freeRamMb: z.number().int().nullable(),
  freeDiskMb: z.number().int().nullable(),
  freeAllocations: z.number().int(),
  /** Zelfde HTTP(S)-modus als de bronnode (eigen 80/443 of via dezelfde relay). */
  sameHttpMode: z.boolean(),
});
export type EvacuationTarget = z.infer<typeof EvacuationTarget>;

export const EvacuationPlanItem = z.object({
  uuid: Uuid,
  name: z.string(),
  type: ServerType,
  ownerName: z.string().nullable(),
  ramMb: z.number().int(),
  diskMb: z.number().int(),
  /** Aantal allocations dat op het doel nodig is (incl. Bedrock). */
  allocations: z.number().int(),
  hasDomains: z.boolean(),
  /** Automatische keuze (rekening houdend met de servers ervoor in de lijst); null = past nergens. */
  suggestedNodeId: Id.nullable(),
  targets: z.array(EvacuationTarget),
});
export type EvacuationPlanItem = z.infer<typeof EvacuationPlanItem>;

export const EvacuationPlan = z.object({ nodeId: Id, items: z.array(EvacuationPlanItem) });
export type EvacuationPlan = z.infer<typeof EvacuationPlan>;

export const EvacuationItemStatus = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type EvacuationItemStatus = z.infer<typeof EvacuationItemStatus>;

/** Een DNS-record dat de eigenaar na de verhuizing moet aanpassen (of controleren). */
export const MovedDnsRecord = z.object({
  hostname: z.string(),
  /** `A` (website of Minecraft-domein) of `SRV` (Minecraft, poort veranderd). */
  type: z.enum(["A", "SRV"]),
  value: z.string().nullable(),
  /** Het IP/de poort is anders dan op de oude node. null = onbekend. */
  changed: z.boolean().nullable(),
});

export const EvacuationItem = z.object({
  id: Id,
  serverUuid: Uuid,
  serverName: z.string(),
  targetNodeId: Id.nullable(),
  targetNodeName: z.string().nullable(),
  /** Doel automatisch gekozen (bij het starten van deze verhuizing). */
  auto: z.boolean(),
  status: EvacuationItemStatus,
  error: z.string().nullable(),
  /** Nieuw adres (ip:poort) van een game-server na de verhuizing. */
  newAddress: z.string().nullable(),
  dns: z.array(MovedDnsRecord),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});
export type EvacuationItem = z.infer<typeof EvacuationItem>;

export const Evacuation = z.object({
  id: Id,
  nodeId: Id,
  status: z.enum(["running", "completed", "cancelled"]),
  concurrency: z.number().int(),
  createdAt: z.date(),
  finishedAt: z.date().nullable(),
  items: z.array(EvacuationItem),
});
export type Evacuation = z.infer<typeof Evacuation>;

export const EvacuateInput = z.object({
  id: Id,
  /** Tegelijk verhuizen (1–5). */
  concurrency: z.number().int().min(1).max(5).default(1),
  /** `nodeId: null` = automatisch kiezen op het moment van verhuizen. */
  items: z.array(z.object({ uuid: Uuid, nodeId: Id.nullable() })).min(1).max(500),
});

// ---------- import (Pterodactyl / Pelican) ----------

export const ImportSourceKind = z.enum(["pterodactyl", "pelican"]);
export type ImportSourceKind = z.infer<typeof ImportSourceKind>;

export const ImportConnectInput = z.object({
  kind: ImportSourceKind,
  /** Basis-URL van het bronpanel, bv. https://panel.example.com */
  url: z.string().trim().url().max(500),
  /** Application API-sleutel (alleen lezen nodig). Versleuteld bewaard tot de import klaar is of ontkoppeld wordt. */
  apiKey: z.string().trim().min(8).max(500),
  /** Optioneel: Client API-sleutel van een admin, om bestaande backups te downloaden. */
  clientApiKey: z.string().trim().min(8).max(500).nullable().default(null),
  /** Optioneel: SFTP-login op de bron-nodes (Wings). Gebruikersnaam zonder `.<id>`; het panel plakt die er per server achter. */
  sftp: z
    .object({
      username: z.string().trim().min(1).max(100),
      password: z.string().min(1).max(500),
      /** Overschrijft de host (standaard de FQDN van de bron-node). */
      host: z.string().trim().max(253).nullable().default(null),
      port: z.number().int().min(1).max(65535).nullable().default(null),
    })
    .nullable()
    .default(null),
});

export const ImportUserAction = z.enum(["link", "create", "skip"]);
export const ImportEggAction = z.enum(["template", "skip"]);
export const ImportItemStatus = z.enum(["pending", "creating", "copying", "done", "failed", "skipped"]);
export type ImportItemStatus = z.infer<typeof ImportItemStatus>;
export const ImportFileMethod = z.enum(["backup", "sftp", "none"]);
export type ImportFileMethod = z.infer<typeof ImportFileMethod>;

export const ImportUser = z.object({
  /** ID in het bronpanel. */
  id: z.number().int(),
  username: z.string(),
  email: z.string().nullable(),
  /** Discord-ID gevonden in de bron (external_id of OAuth); null = onbekend. */
  sourceDiscordId: z.string().nullable(),
  serverCount: z.number().int(),
  action: ImportUserAction,
  /** `link`: account in dit panel. */
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  /** `create`: Discord-ID voor het nieuwe account. */
  discordId: z.string().nullable(),
  /** Hoe het account automatisch gevonden is. */
  matchedBy: z.enum(["discord", "email", "name"]).nullable(),
});
export type ImportUser = z.infer<typeof ImportUser>;

export const ImportEgg = z.object({
  id: z.number().int(),
  nestName: z.string().nullable(),
  name: z.string(),
  dockerImages: z.array(z.string()),
  startup: z.string(),
  variables: z.array(z.object({ key: z.string(), name: z.string(), default: z.string() })),
  serverCount: z.number().int(),
  action: ImportEggAction,
  templateId: Id.nullable(),
  /** Automatisch voorstel: template + score 0–100 + waarop het lijkt. */
  suggestion: z.object({ templateId: Id, templateName: z.string(), score: z.number().int(), reasons: z.array(z.string()) }).nullable(),
});
export type ImportEgg = z.infer<typeof ImportEgg>;

export const ImportServer = z.object({
  id: z.number().int(),
  uuid: z.string(),
  /** Korte id (8 tekens) in Pterodactyl/Pelican; ook de SFTP-achtervoegsel. */
  identifier: z.string(),
  name: z.string(),
  ownerId: z.number().int(),
  eggId: z.number().int(),
  sourceNodeId: z.number().int(),
  sourceNodeName: z.string().nullable(),
  limits: z.object({ ramMb: z.number().int(), swapMb: z.number().int(), diskMb: z.number().int(), cpuPct: z.number().int() }),
  allocations: z.array(z.object({ ip: z.string(), port: z.number().int(), primary: z.boolean() })),
  variables: z.record(z.string(), z.string()),
  suspended: z.boolean(),
  include: z.boolean(),
  targetNodeId: Id.nullable(),
  /** null = automatisch (zelfde poort als die vrij is, anders de eerste vrije). */
  allocationIds: z.array(Id).nullable(),
  status: ImportItemStatus,
  error: z.string().nullable(),
  method: ImportFileMethod.nullable(),
  newUuid: Uuid.nullable(),
  bytes: z.number(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
});
export type ImportServer = z.infer<typeof ImportServer>;

export const ImportSession = z.object({
  id: Id,
  kind: ImportSourceKind,
  url: z.string(),
  /** De sleutel is nog bewaard (versleuteld); na afronden/ontkoppelen false. */
  connected: z.boolean(),
  hasClientKey: z.boolean(),
  sftpUsername: z.string().nullable(),
  state: z.enum(["ready", "running", "done", "cancelled"]),
  fetchedAt: z.date(),
  defaultNodeId: Id.nullable(),
  nodes: z.array(z.object({ id: z.number().int(), name: z.string(), fqdn: z.string(), sftpPort: z.number().int() })),
  users: z.array(ImportUser),
  eggs: z.array(ImportEgg),
  servers: z.array(ImportServer),
  warnings: z.array(z.string()),
});
export type ImportSession = z.infer<typeof ImportSession>;

export const ImportMappingInput = z.object({
  defaultNodeId: Id.nullable().optional(),
  eggs: z.array(z.object({ id: z.number().int(), action: ImportEggAction, templateId: Id.nullable() })).optional(),
  users: z.array(z.object({ id: z.number().int(), action: ImportUserAction, accountId: Id.nullable(), discordId: DiscordId.nullable() })).optional(),
  servers: z.array(z.object({ id: z.number().int(), include: z.boolean(), targetNodeId: Id.nullable(), allocationIds: z.array(Id).nullable() })).optional(),
});

/** Wat een import zou doen (dry-run); schrijft niets. */
export const ImportPlan = z.object({
  createUsers: z.array(z.object({ sourceId: z.number().int(), username: z.string(), discordId: z.string() })),
  servers: z.array(
    z.object({
      sourceId: z.number().int(),
      name: z.string(),
      owner: z.string().nullable(),
      template: z.string().nullable(),
      node: z.string().nullable(),
      ports: z.array(z.number().int()),
      method: ImportFileMethod,
      variables: z.record(z.string(), z.string()),
      /** Variabelen van de bron die de template niet kent (vallen weg). */
      droppedVariables: z.array(z.string()),
      warnings: z.array(z.string()),
      /** Reden waarom deze server niet kan (dan wordt hij overgeslagen); null = gaat door. */
      blocked: z.string().nullable(),
    }),
  ),
  skipped: z.array(z.object({ sourceId: z.number().int(), name: z.string(), reason: z.string() })),
});
export type ImportPlan = z.infer<typeof ImportPlan>;
