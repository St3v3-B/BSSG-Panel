/**
 * Schema's voor de mailmodule (`mail.*`): domeinen, mailboxen, aliassen, DKIM, DNS-records,
 * systeemcheck, wachtrij. Wordt via ./schemas.ts geëxporteerd. Alles is admin in deze ronde.
 *
 * Fouten (message): CONFLICT `MAIL_DOMAIN_EXISTS` / `MAIL_ADDRESS_EXISTS`, PRECONDITION_FAILED
 * `MAIL_NOT_CONFIGURED` (MAIL_HOSTNAME leeg), `MAIL_CHECKS_FAILED` (enable met een rode verplichte check),
 * `MAIL_MAILBOX_LIMIT` (max_mailboxes bereikt), `MAIL_DOMAIN_QUOTA` (som van de quota > max_quota_mb),
 * `MAIL_NO_DNS_PROVIDER` / `MAIL_ZONE_NOT_FOUND` (applyDns), BAD_REQUEST `MAIL_INVALID_TARGET` (aliasdoel),
 * `MAIL_POSTMASTER_TARGET_REQUIRED`, BAD_GATEWAY `CLOUDFLARE_ERROR: …`, NOT_FOUND `MAIL_DOMAIN_NOT_FOUND` /
 * `MAIL_MAILBOX_NOT_FOUND` / `MAIL_ALIAS_NOT_FOUND`, INTERNAL_SERVER_ERROR `DAEMON_UNREACHABLE`, NOT_FOUND `MAIL_QUEUE_ITEM_NOT_FOUND`.
 */
import { z } from "zod";

const Id = z.number().int().positive();

// ---------- invoer ----------

/** Maildomein: kleine letters, minstens twee labels, geen wildcard. */
export const MailDomainName = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "invalid domain name");

/** Local part (deel voor de @): letters, cijfers en . _ + - ; niet beginnen/eindigen met een punt, geen "..". */
export const MailLocalPart = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*$/, "invalid local part");

/** Volledig e-mailadres (local part + domein, zelfde regels als hierboven). */
export const MailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "invalid e-mail address");

/** Minimaal 12 tekens (Argon2id in de database). */
export const MailPassword = z.string().min(12).max(200);

/** Quota in MB; 0 = onbeperkt (alleen bij domeinen). */
const QuotaMb = z.number().int().min(0).max(10_000_000);

// ---------- status en systeemcheck ----------

export const MailCheckId = z.enum(["outbound_25", "inbound_ports", "ptr", "fcrdns", "helo", "blacklists", "certificate", "ports_free", "clock", "disk"]);
export type MailCheckId = z.infer<typeof MailCheckId>;

export const MailCheck = z.object({
  id: MailCheckId,
  ok: z.boolean(),
  /** Verplicht: rood blokkeert `mail.enable`. */
  required: z.boolean(),
  detail: z.string(),
  /** Wat te doen (van de daemon). */
  hint: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});
export type MailCheck = z.infer<typeof MailCheck>;

export const MailCheckReport = z.object({
  checkedAt: z.date(),
  checks: z.array(MailCheck),
  /** Alle verplichte checks groen. */
  ok: z.boolean(),
});
export type MailCheckReport = z.infer<typeof MailCheckReport>;

export const MailContainer = z.object({ name: z.string(), state: z.string(), health: z.string().nullable() });
export type MailContainer = z.infer<typeof MailContainer>;

export const MailQueueCounts = z.object({ active: z.number().int(), deferred: z.number().int(), hold: z.number().int() });

export const MailStatus = z.object({
  /** MAIL_HOSTNAME gezet. */
  configured: z.boolean(),
  mailHostname: z.string().nullable(),
  /** false = daemon onbereikbaar of fout; dan zijn enabled/containers/queue onbekend (false/[]/null). */
  reachable: z.boolean(),
  enabled: z.boolean(),
  containers: z.array(MailContainer),
  queue: MailQueueCounts.nullable(),
  vmailBytes: z.number().int().nullable(),
  /** Samenvatting van het laatste systeemcheck-rapport (null = nooit gecontroleerd). */
  lastCheck: z.object({ checkedAt: z.date(), ok: z.boolean(), failedRequired: z.array(MailCheckId) }).nullable(),
  counts: z.object({ domains: z.number().int(), mailboxes: z.number().int(), aliases: z.number().int() }),
});
export type MailStatus = z.infer<typeof MailStatus>;

// ---------- domeinen ----------

export const MailDnsStatus = z.enum(["pending", "ok", "error"]);
export type MailDnsStatus = z.infer<typeof MailDnsStatus>;

export const MailDomain = z.object({
  id: Id,
  domain: z.string(),
  description: z.string().nullable(),
  /** 0 = onbeperkt. */
  maxMailboxes: z.number().int(),
  /** 0 = onbeperkt; bovengrens voor de som van de mailbox-quota. */
  maxQuotaMb: z.number().int(),
  dnsStatus: MailDnsStatus,
  dnsCheckedAt: z.date().nullable(),
  active: z.boolean(),
  ownerUserId: Id.nullable(),
  createdAt: z.date(),
  mailboxCount: z.number().int(),
  aliasCount: z.number().int(),
  /** Som van quota_mb van de mailboxen. */
  quotaAllocatedMb: z.number().int(),
});
export type MailDomain = z.infer<typeof MailDomain>;

export const MailDkim = z.object({
  selector: z.string(),
  /** Base64 DER (het p=-veld). */
  publicKey: z.string(),
  createdAt: z.date(),
  rotatedAt: z.date().nullable(),
});
export type MailDkim = z.infer<typeof MailDkim>;

export const MailDomainDetail = MailDomain.extend({ dkim: MailDkim.nullable() });
export type MailDomainDetail = z.infer<typeof MailDomainDetail>;

export const MailDomainCreateInput = z.object({
  domain: MailDomainName,
  description: z.string().trim().max(200).nullable().default(null),
  maxMailboxes: z.number().int().min(0).max(100_000).default(0),
  maxQuotaMb: QuotaMb.default(0),
  /** Optioneel meteen een eerste mailbox; postmaster@ en abuse@ wijzen er dan naar. */
  firstMailbox: z
    .object({ localPart: MailLocalPart, name: z.string().trim().max(100).default(""), password: MailPassword, quotaMb: QuotaMb.min(1).default(1024) })
    .nullable()
    .default(null),
  /** Doel voor postmaster@ en abuse@ als er geen eerste mailbox is (verplicht in dat geval). */
  postmasterTo: MailAddress.nullable().default(null),
});

export const MailDomainUpdateInput = z.object({
  id: Id,
  description: z.string().trim().max(200).nullable().optional(),
  maxMailboxes: z.number().int().min(0).max(100_000).optional(),
  maxQuotaMb: QuotaMb.optional(),
  active: z.boolean().optional(),
});

// ---------- DNS-records ----------

export const MailDnsRecordId = z.enum(["a", "aaaa", "mx", "spf", "dkim", "dmarc", "ptr"]);
export const MailDnsRecordStatus = z.enum(["ok", "missing", "wrong", "unchecked"]);

export const MailDnsRecord = z.object({
  id: MailDnsRecordId,
  type: z.enum(["A", "AAAA", "MX", "TXT", "PTR"]),
  /** Volledige naam (fqdn, zonder punt aan het eind); bij PTR het IP. */
  name: z.string(),
  /** Te zetten waarde (bij MX zonder prioriteit). */
  value: z.string(),
  priority: z.number().int().nullable(),
  /** false = alleen informatie/advies (A/AAAA van de mailhost, PTR); telt niet mee voor dns_status. */
  required: z.boolean(),
  status: MailDnsRecordStatus,
  /** Gevonden waarden bij de laatste controle. */
  actual: z.array(z.string()),
  /** Waar het record gezet moet worden: dns = bij de DNS-provider, hosting = PTR bij de provider van het IP. */
  where: z.enum(["dns", "hosting"]),
});
export type MailDnsRecord = z.infer<typeof MailDnsRecord>;

export const MailDnsRecords = z.object({
  domainId: Id,
  domain: z.string(),
  mailHostname: z.string().nullable(),
  dnsStatus: MailDnsStatus,
  checkedAt: z.date().nullable(),
  records: z.array(MailDnsRecord),
  /** Cloudflare-provider die de zone van het domein beheert (dan kan `applyDns`). */
  cloudflare: z.object({ providerId: Id, zone: z.string() }).nullable(),
});
export type MailDnsRecords = z.infer<typeof MailDnsRecords>;

// ---------- mailboxen ----------

export const MailMailbox = z.object({
  id: Id,
  domainId: Id,
  localPart: z.string(),
  address: z.string(),
  name: z.string(),
  quotaMb: z.number().int(),
  /** Uit doveadm via de daemon; null = onbekend (daemon onbereikbaar of mailbox nog leeg). */
  usedBytes: z.number().int().nullable(),
  lastLogin: z.date().nullable(),
  active: z.boolean(),
  createdAt: z.date(),
});
export type MailMailbox = z.infer<typeof MailMailbox>;

export const MailMailboxCreateInput = z.object({
  domainId: Id,
  localPart: MailLocalPart,
  name: z.string().trim().max(100).default(""),
  password: MailPassword,
  quotaMb: QuotaMb.min(1).default(1024),
  active: z.boolean().default(true),
});

export const MailMailboxUpdateInput = z.object({
  id: Id,
  name: z.string().trim().max(100).optional(),
  quotaMb: QuotaMb.min(1).optional(),
  active: z.boolean().optional(),
});

// ---------- aliassen ----------

export const MailAlias = z.object({
  id: Id,
  domainId: Id,
  /** `local@domein`, of `@domein` voor de catch-all. */
  address: z.string(),
  catchAll: z.boolean(),
  goto: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.date(),
});
export type MailAlias = z.infer<typeof MailAlias>;

export const MailAliasCreateInput = z.object({
  domainId: Id,
  /** null = catch-all (`@domein`). */
  localPart: MailLocalPart.nullable(),
  goto: z.array(MailAddress).min(1).max(50),
  active: z.boolean().default(true),
});

export const MailAliasUpdateInput = z.object({
  id: Id,
  goto: z.array(MailAddress).min(1).max(50).optional(),
  active: z.boolean().optional(),
});

// ---------- wachtrij ----------

export const MailQueueId = z.string().regex(/^[0-9A-Za-z]{5,32}$/, "invalid queue id");

export const MailQueueItem = z.object({
  queueId: z.string(),
  sender: z.string(),
  recipients: z.array(z.string()),
  size: z.number().int(),
  arrivalTime: z.date(),
  reason: z.string().nullable(),
});
export type MailQueueItem = z.infer<typeof MailQueueItem>;
