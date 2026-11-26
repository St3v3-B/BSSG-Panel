/**
 * Het tRPC-contract van het panel: elke procedure met toegangsniveau en zod-schema's.
 *
 * Eigenaar: orchestrator. panel-api implementeert dit (apps/web/server/),
 * panel-ui bouwt ertegen (via de mock in ./mock). Wijzigingen alleen via de orchestrator.
 *
 * Toegangsniveaus (afgedwongen in ./trpc-builder.ts, dus niet per procedure opnieuw):
 * - public:  geen sessie nodig
 * - pending: sessie nodig, TOTP mag nog openstaan (voor login-stap 2)
 * - user:    sessie met afgeronde TOTP (als die aan staat), niet geblokkeerd
 * - admin:   user + in admin_discord_ids + TOTP aan én geverifieerd in deze sessie
 *
 * Rechten per server (Permission) controleert de implementatie zelf: de builder weet
 * niet welke server bedoeld is. Fouten: UNAUTHORIZED (geen sessie), FORBIDDEN
 * (geen recht; message "TOTP_REQUIRED" als 2FA ontbreekt), NOT_FOUND, CONFLICT,
 * BAD_REQUEST, PRECONDITION_FAILED (bv. disk vol), BAD_GATEWAY-achtig → "INTERNAL_SERVER_ERROR"
 * met message "DAEMON_UNREACHABLE" als de node niet antwoordt.
 */
import { z } from "zod";
import * as s from "./schemas";

export type Access = "public" | "pending" | "user" | "admin";

export interface ProcDef<
  K extends "query" | "mutation" = "query" | "mutation",
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  readonly kind: K;
  readonly access: Access;
  readonly input: I;
  readonly output: O;
}

const query = <I extends z.ZodType, O extends z.ZodType>(access: Access, input: I, output: O) =>
  ({ kind: "query", access, input, output }) as const satisfies ProcDef<"query", I, O>;
const mutation = <I extends z.ZodType, O extends z.ZodType>(access: Access, input: I, output: O) =>
  ({ kind: "mutation", access, input, output }) as const satisfies ProcDef<"mutation", I, O>;

const none = z.void();
const byId = z.object({ id: s.Id });
const server = s.ServerRef;
const serverPath = server.extend({ path: s.FilePath });

export const contract = {
  auth: {
    /** null als er geen sessie is. */
    me: query("public", none, s.Me.nullable()),
    branding: query("public", none, s.Branding),
    /** URL naar Discord OAuth2; de callback is de route handler /api/auth/discord/callback. */
    discordLoginUrl: query("public", z.object({ redirectTo: z.string().startsWith("/").optional() }), z.object({ url: z.string() })),
    verifyTotp: mutation("pending", z.object({ code: z.string().regex(/^\d{6}$/) }), s.Ok),
    /** Noodaccount (fase 4): wachtwoord + verplichte TOTP. Werkt ook als Discord plat ligt. */
    emergencyLogin: mutation("public", z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }), s.Ok),
    logout: mutation("pending", none, s.Ok),
  },

  account: {
    get: query("user", none, s.Me),
    /** Start 2FA-instelling: geeft een nieuw secret (nog niet actief). */
    totpSetup: mutation("user", none, z.object({ secret: z.string(), otpauthUrl: z.string() })),
    /** Bevestigt met een code; daarna is TOTP aan en deze sessie geverifieerd. */
    totpEnable: mutation("user", z.object({ code: z.string().regex(/^\d{6}$/) }), s.Ok),
    totpDisable: mutation("user", z.object({ code: z.string().regex(/^\d{6}$/) }), s.Ok),
    apiKeys: query("user", none, z.array(s.ApiKey)),
    /** `key` is de volledige sleutel en wordt maar één keer getoond. */
    createApiKey: mutation(
      "user",
      z.object({ name: z.string().min(1).max(100), permissions: z.array(s.Permission), expiresAt: z.date().nullable() }),
      z.object({ key: z.string(), apiKey: s.ApiKey }),
    ),
    revokeApiKey: mutation("user", byId, s.Ok),
    setSftpPassword: mutation("user", server.extend({ password: z.string().min(12).max(200) }), s.Ok),
  },

  servers: {
    /** Eigen servers plus servers waar je subuser bent. Admins zien hier ook alleen die van henzelf. */
    list: query("user", none, z.array(s.ServerSummary)),
    get: query("user", server, s.ServerDetail),
    /** Momentopname; live stats gaan via de websocket. Vereist console.read. */
    stats: query("user", server, s.Stats.nullable()),
    /** Vereist power. */
    power: mutation("user", server.extend({ action: s.PowerAction }), s.Ok),
    /** Vereist console.write. */
    sendCommand: mutation("user", server.extend({ command: z.string().min(1).max(2000) }), s.Ok),
    /** JWT (10 min) voor wss://$NODE_DOMAIN/api/servers/{uuid}/ws. Vereist console.read. */
    consoleToken: mutation("user", server, s.ConsoleToken),
    /** Alleen eigenaar. */
    rename: mutation("user", server.extend({ name: z.string().min(1).max(100) }), s.Ok),
    /** Alleen eigenaar; alleen userEditable-variabelen. Effect bij de volgende start. */
    updateVariables: mutation("user", server.extend({ variables: z.record(z.string(), z.string()) }), s.Ok),
    /** Alleen eigenaar. Wist de data niet, draait het install-script opnieuw. */
    reinstall: mutation("user", server, s.Ok),
    activity: query("user", server.extend(s.PageInput.shape), s.page(s.ActivityEntry)),
  },

  files: {
    list: query("user", serverPath, z.array(s.FileEntry)), // files.read
    read: query("user", serverPath, z.object({ content: z.string(), size: z.number() })), // files.read, max 5 MB tekst
    write: mutation("user", serverPath.extend({ content: z.string() }), s.Ok), // files.write
    mkdir: mutation("user", serverPath, s.Ok),
    rename: mutation("user", server.extend({ from: s.FilePath, to: s.FilePath }), s.Ok),
    delete: mutation("user", server.extend({ paths: z.array(s.FilePath).min(1) }), s.Ok),
    compress: mutation("user", server.extend({ root: s.FilePath, paths: z.array(s.FilePath).min(1) }), z.object({ archive: s.FileEntry })),
    decompress: mutation("user", serverPath, s.Ok),
    /** Directe upload-URL naar de daemon (JWT met files.write erin). */
    uploadUrl: mutation("user", server.extend({ directory: s.FilePath }), s.SignedUrl),
    downloadUrl: mutation("user", serverPath, s.SignedUrl),
    sftpDetails: query("user", server, z.object({ host: z.string(), port: z.number().int(), username: z.string() })),
  },

  domains: {
    list: query("user", server, z.array(s.Domain)),
    add: mutation(
      "user",
      server.extend({
        hostname: s.Hostname,
        targetPort: z.number().int().nullable().default(null),
        redirectTo: s.Hostname.nullable().default(null),
        wildcard: z.boolean().default(false),
        dnsProviderId: s.Id.nullable().default(null),
      }),
      s.Domain,
    ),
    update: mutation("user", byId.extend({ targetPort: z.number().int().nullable(), redirectTo: s.Hostname.nullable() }), s.Domain),
    remove: mutation("user", byId, s.Ok),
    /** DNS-lookup via 1.1.1.1 en 8.8.8.8, met providerherkenning. */
    check: mutation("user", byId, s.DnsCheck),
    /** Laatste check zonder opnieuw te zoeken. */
    lastCheck: query("user", byId, s.DnsCheck.nullable()),
    /** Zet de records via de gekoppelde DNS-provider (Cloudflare). */
    applyDns: mutation("user", byId, s.DnsCheck),
    /** Voor het domeinscherm: het IP waar records naar moeten wijzen. */
    target: query("user", server, z.object({ ip: z.string(), nodeFqdn: z.string() })),
  },

  databases: {
    list: query("user", server, z.array(s.Database)),
    create: mutation("user", server.extend({ name: z.string().regex(/^[a-zA-Z0-9_]{1,48}$/), hostId: s.Id.nullable().default(null) }), s.Database),
    resetPassword: mutation("user", byId, s.Database),
    delete: mutation("user", byId, s.Ok),
  },

  backups: {
    list: query("user", server, z.array(s.Backup)),
    create: mutation("user", server.extend({ name: z.string().max(100).nullable().default(null), includeDatabases: z.boolean().default(true) }), s.Backup),
    restore: mutation("user", byId, s.Ok), // backup.restore
    delete: mutation("user", byId, s.Ok), // backup.create
    downloadUrl: mutation("user", byId, s.SignedUrl),
  },

  schedules: {
    list: query("user", server, z.array(s.Schedule)),
    create: mutation("user", server.extend(s.ScheduleInput.shape), s.Schedule),
    update: mutation("user", byId.extend(s.ScheduleInput.shape), s.Schedule),
    delete: mutation("user", byId, s.Ok),
    runNow: mutation("user", byId, s.Ok),
  },

  subusers: {
    list: query("user", server, z.array(s.Subuser)),
    /** Op Discord-ID of op naam van een bekende gebruiker. Onbekend ID → leeg account. Alleen eigenaar. */
    invite: mutation("user", server.extend({ who: z.string().min(1), permissions: z.array(s.Permission) }), s.Subuser),
    update: mutation("user", server.extend({ userId: s.Id, permissions: z.array(s.Permission) }), s.Subuser),
    remove: mutation("user", server.extend({ userId: s.Id }), s.Ok),
  },

  admin: {
    dashboard: query("admin", none, z.object({ nodes: z.array(s.NodeHealth), alerts: z.array(s.DashboardAlert), serverCount: z.number().int(), userCount: z.number().int() })),

    nodes: {
      list: query("admin", none, z.array(s.Node)),
      get: query("admin", byId, s.Node.extend({ health: s.NodeHealth })),
      /** `token` en `installCommand` worden maar één keer getoond. */
      create: mutation("admin", s.NodeInput, z.object({ node: s.Node, token: z.string(), installCommand: z.string() })),
      update: mutation("admin", byId.extend(s.NodeInput.shape), s.Node),
      delete: mutation("admin", byId, s.Ok),
      regenerateToken: mutation("admin", byId, z.object({ token: z.string(), installCommand: z.string() })),
    },

    allocations: {
      list: query("admin", z.object({ nodeId: s.Id }), z.array(s.Allocation)),
      /** ports: "25565" of "25565-25600" of "25565,25570-25575" */
      create: mutation("admin", z.object({ nodeId: s.Id, ip: z.ipv4(), ports: z.string().min(1) }), z.object({ created: z.number().int() })),
      delete: mutation("admin", byId, s.Ok),
    },

    servers: {
      list: query("admin", s.PageInput.extend({ search: z.string().optional() }), s.page(s.ServerSummary)),
      /** Maakt de server aan en start de installatie. */
      create: mutation(
        "admin",
        z.object({
          name: z.string().min(1).max(100),
          ownerId: s.Id,
          nodeId: s.Id,
          templateId: s.Id,
          limits: s.Limits,
          /** Verplicht voor game-servers; de eerste is de primaire. Leeg voor web. */
          allocationIds: z.array(s.Id),
          variables: z.record(z.string(), z.string()).default({}),
          startOnInstall: z.boolean().default(true),
        }),
        s.ServerDetail,
      ),
      updateLimits: mutation("admin", server.extend({ limits: s.Limits }), s.Ok),
      updateOwner: mutation("admin", server.extend({ ownerId: s.Id }), s.Ok),
      updateAllocations: mutation("admin", server.extend({ allocationIds: z.array(s.Id) }), s.Ok),
      delete: mutation("admin", server, s.Ok),
      /** Verplaatsen naar een andere node (na v1-fase 4, contract staat alvast). */
      transfer: mutation("admin", server.extend({ nodeId: s.Id }), s.Ok),
    },

    templates: {
      list: query("admin", none, z.array(s.TemplateSummary)),
      get: query("admin", byId, s.TemplateDetail),
      /** YAML volgens templates/SCHEMA.md; slug uit de YAML. */
      create: mutation("admin", z.object({ yaml: z.string().min(1) }), s.TemplateDetail),
      update: mutation("admin", byId.extend({ yaml: z.string().min(1) }), s.TemplateDetail),
      delete: mutation("admin", byId, s.Ok),
      /** Valideert zonder op te slaan. */
      validate: mutation("admin", z.object({ yaml: z.string() }), z.object({ ok: z.boolean(), errors: z.array(z.string()) })),
    },

    users: {
      list: query("admin", s.PageInput.extend({ search: z.string().optional() }), s.page(s.AdminUser)),
      get: query("admin", byId, s.AdminUser),
      /** Vooraf aanmaken op Discord-ID; naam en avatar komen bij de eerste login. */
      create: mutation("admin", z.object({ discordId: s.DiscordId }), s.AdminUser),
      setBlocked: mutation("admin", byId.extend({ blocked: z.boolean() }), s.Ok),
      resetTotp: mutation("admin", byId, s.Ok),
    },

    admins: {
      list: query("admin", none, z.array(z.object({ discordId: s.DiscordId, user: s.UserPublic.nullable(), addedBy: s.UserPublic.nullable(), addedAt: z.date(), isOwner: z.boolean() }))),
      add: mutation("admin", z.object({ discordId: s.DiscordId }), s.Ok),
      /** De eigenaar (OWNER_DISCORD_ID) kan niet weg: FORBIDDEN. */
      remove: mutation("admin", z.object({ discordId: s.DiscordId }), s.Ok),
    },

    databaseHosts: {
      list: query("admin", none, z.array(s.DatabaseHost)),
      create: mutation("admin", s.DatabaseHostInput, s.DatabaseHost),
      update: mutation("admin", byId.extend(s.DatabaseHostInput.partial().shape), s.DatabaseHost),
      delete: mutation("admin", byId, s.Ok),
      test: mutation("admin", byId, z.object({ ok: z.boolean(), error: z.string().nullable() })),
    },

    s3Targets: {
      list: query("admin", none, z.array(s.S3Target)),
      create: mutation("admin", s.S3TargetInput, s.S3Target),
      update: mutation("admin", byId.extend(s.S3TargetInput.partial().shape), s.S3Target),
      delete: mutation("admin", byId, s.Ok),
      test: mutation("admin", byId, z.object({ ok: z.boolean(), error: z.string().nullable() })),
    },

    dnsProviders: {
      list: query("admin", none, z.array(s.DnsProvider)),
      create: mutation("admin", z.object({ type: z.literal("cloudflare"), name: z.string().min(1), apiToken: z.string().min(1) }), s.DnsProvider),
      delete: mutation("admin", byId, s.Ok),
      refreshZones: mutation("admin", byId, s.DnsProvider),
    },

    activity: {
      search: query(
        "admin",
        s.PageInput.extend({ userId: s.Id.optional(), serverUuid: s.Uuid.optional(), action: z.string().optional() }),
        s.page(s.ActivityEntry),
      ),
    },

    settings: {
      get: query("admin", none, s.Settings),
      update: mutation("admin", s.Settings.partial(), s.Settings),
    },
  },
} as const;

export type Contract = typeof contract;
