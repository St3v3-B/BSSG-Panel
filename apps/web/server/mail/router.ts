/**
 * mail.*: domeinen, mailboxen, aliassen, DKIM, DNS-records, systeemcheck en wachtrij. Alles admin (de builder
 * dwingt dat af). Het panel schrijft in het schema `mail`; Postfix/Dovecot lezen de views (zie packages/db).
 * Daemon-aanroepen gaan naar de lokale node (mail/daemon.ts).
 */
import type { Ctx, Implementation, MailAlias, MailDnsRecords, MailDomain, MailDomainDetail, MailMailbox } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, sum } from "drizzle-orm";
import { logActivity } from "../activity";
import { DaemonHttpError, toTrpcError } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { CloudflareError, setMxRecord, setTxtByPrefix, zoneFor } from "../lib/cloudflare";
import { dns } from "../lib/dns";
import { lastReport, reportForEnable, requireMailHostname, runChecks } from "./checks";
import { buildRecords, dnsStatusOf, generateDkimKey, hashMailPassword, lookupRecords, nextSelector, splitGoto, toStored, withStoredStatus, type RecordContext } from "./core";
import { mailDaemon } from "./daemon";

type DomainRow = typeof schema.mailDomains.$inferSelect;
type MailboxRow = typeof schema.mailMailboxes.$inferSelect;
type AliasRow = typeof schema.mailAliases.$inferSelect;
type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

const ok = { ok: true as const };
const err = (code: TRPCError["code"], message: string): never => {
  throw new TRPCError({ code, message });
};

async function log(ctx: Ctx, action: string, metadata: Record<string, unknown>) {
  await logActivity({ action: `admin.mail.${action}`, userId: ctx.session?.userId ?? null, metadata, ip: ctx.ip, ctx });
}

/** Daemonfout → tRPC; 409 mail_not_configured → PRECONDITION_FAILED MAIL_NOT_CONFIGURED. */
async function daemonCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DaemonHttpError && e.code === "mail_not_configured") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_NOT_CONFIGURED", cause: e });
    throw toTrpcError(e);
  }
}

/** Zoals daemonCall, maar 404 (bestaat al niet) telt als geslaagd. */
async function daemonDelete(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 404) return;
    throw toTrpcError(e);
  }
}

// ---------- domeinen ----------

async function domainRow(id: number, tx: Tx | ReturnType<typeof getDb> = getDb(), lock = false): Promise<DomainRow> {
  const q = tx.select().from(schema.mailDomains).where(eq(schema.mailDomains.id, id));
  const [d] = lock ? await q.for("update") : await q;
  return d ?? err("NOT_FOUND", "MAIL_DOMAIN_NOT_FOUND");
}

async function usage(domainIds: number[]) {
  if (!domainIds.length) return new Map<number, { mailboxes: number; quotaMb: number; aliases: number }>();
  const db = getDb();
  const mb = await db
    .select({ id: schema.mailMailboxes.domainId, n: count(), q: sum(schema.mailMailboxes.quotaMb) })
    .from(schema.mailMailboxes)
    .where(inArray(schema.mailMailboxes.domainId, domainIds))
    .groupBy(schema.mailMailboxes.domainId);
  const al = await db.select({ id: schema.mailAliases.domainId, n: count() }).from(schema.mailAliases).where(inArray(schema.mailAliases.domainId, domainIds)).groupBy(schema.mailAliases.domainId);
  const out = new Map(domainIds.map((id) => [id, { mailboxes: 0, quotaMb: 0, aliases: 0 }]));
  for (const r of mb) Object.assign(out.get(r.id)!, { mailboxes: Number(r.n), quotaMb: Number(r.q ?? 0) });
  for (const r of al) out.get(r.id)!.aliases = Number(r.n);
  return out;
}

function toDomain(d: DomainRow, u: { mailboxes: number; quotaMb: number; aliases: number }): MailDomain {
  return {
    id: d.id,
    domain: d.domain,
    description: d.description,
    maxMailboxes: d.maxMailboxes,
    maxQuotaMb: d.maxQuotaMb,
    dnsStatus: d.dnsStatus === "ok" || d.dnsStatus === "error" ? d.dnsStatus : "pending",
    dnsCheckedAt: d.dnsCheckedAt,
    active: d.active,
    ownerUserId: d.ownerUserId,
    createdAt: d.createdAt,
    mailboxCount: u.mailboxes,
    aliasCount: u.aliases,
    quotaAllocatedMb: u.quotaMb,
  };
}

async function activeDkim(domainId: number) {
  const [k] = await getDb()
    .select()
    .from(schema.mailDkimKeys)
    .where(and(eq(schema.mailDkimKeys.domainId, domainId), eq(schema.mailDkimKeys.active, true)))
    .orderBy(desc(schema.mailDkimKeys.id))
    .limit(1);
  return k ?? null;
}

async function domainDetail(d: DomainRow): Promise<MailDomainDetail> {
  const k = await activeDkim(d.id);
  return { ...toDomain(d, (await usage([d.id])).get(d.id)!), dkim: k ? { selector: k.selector, publicKey: k.publicKey, createdAt: k.createdAt, rotatedAt: k.rotatedAt } : null };
}

/** Publieke IP's van de mailserver: panel.env, anders NODE_PUBLIC_IP, anders wat de systeemcheck vond. */
export async function mailIps(): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const env = getEnv();
  let ipv4 = env.MAIL_PUBLIC_IPV4 ?? env.NODE_PUBLIC_IP ?? null;
  let ipv6 = env.MAIL_PUBLIC_IPV6 ?? null;
  if (!ipv4 || !ipv6) {
    const r = await lastReport();
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    for (const c of r?.checks ?? []) {
      ipv4 ??= str(c.data?.ipv4) ?? str(c.data?.public_ipv4);
      ipv6 ??= str(c.data?.ipv6) ?? str(c.data?.public_ipv6);
    }
  }
  return { ipv4, ipv6 };
}

async function recordContext(d: DomainRow): Promise<RecordContext> {
  const k = await activeDkim(d.id);
  return { domain: d.domain, mailHostname: getEnv().MAIL_HOSTNAME ?? null, ...(await mailIps()), dkim: k ? { selector: k.selector, publicKey: k.publicKey } : null };
}

async function cloudflareFor(domain: string) {
  const providers = await getDb().select().from(schema.dnsProviders).orderBy(asc(schema.dnsProviders.id));
  for (const p of providers) {
    const z = zoneFor(p.zones, domain);
    if (z) return { provider: p, zone: z };
  }
  return null;
}

async function dnsView(d: DomainRow): Promise<MailDnsRecords> {
  const c = await recordContext(d);
  const cf = await cloudflareFor(d.domain);
  return {
    domainId: d.id,
    domain: d.domain,
    mailHostname: c.mailHostname,
    dnsStatus: toDomain(d, { mailboxes: 0, quotaMb: 0, aliases: 0 }).dnsStatus,
    checkedAt: d.dnsCheckedAt,
    records: withStoredStatus(buildRecords(c), d.dnsLastCheck ?? null),
    cloudflare: cf ? { providerId: cf.provider.id, zone: cf.zone.name } : null,
  };
}

/** Live DNS-controle; werkt dns_status bij. */
export async function checkDomainDns(d: DomainRow): Promise<MailDnsRecords> {
  const c = await recordContext(d);
  const records = await lookupRecords(buildRecords(c), c, dns());
  const status = c.mailHostname ? dnsStatusOf(records) : "pending";
  const [row] = await getDb()
    .update(schema.mailDomains)
    .set({ dnsStatus: status, dnsCheckedAt: new Date(), dnsLastCheck: toStored(records) })
    .where(eq(schema.mailDomains.id, d.id))
    .returning();
  const cf = await cloudflareFor(d.domain);
  return { domainId: d.id, domain: d.domain, mailHostname: c.mailHostname, dnsStatus: status, checkedAt: row?.dnsCheckedAt ?? new Date(), records, cloudflare: cf ? { providerId: cf.provider.id, zone: cf.zone.name } : null };
}

/** Uurlijks (scheduler): domeinen waarvan de laatste DNS-controle ouder is dan een uur. */
export async function recheckStaleDomains(now = new Date(), limit = 20): Promise<number> {
  if (!getEnv().MAIL_HOSTNAME) return 0;
  const stale = await getDb()
    .select()
    .from(schema.mailDomains)
    .where(and(eq(schema.mailDomains.active, true), or(isNull(schema.mailDomains.dnsCheckedAt), lt(schema.mailDomains.dnsCheckedAt, new Date(now.getTime() - 3_600_000)))))
    .orderBy(asc(schema.mailDomains.dnsCheckedAt))
    .limit(limit);
  for (const d of stale) await checkDomainDns(d);
  return stale.length;
}

/** DKIM-sleutel maken en naar de daemon sturen; de daemon-fout gaat door naar de aanroeper. */
async function pushDkim(domain: string, selector: string, privateKeyPem: string) {
  const d = await mailDaemon();
  await daemonCall(() => d.putDkim(domain, { selector, private_key_pem: privateKeyPem }));
}

/** Na `mail.enable`: alle actieve DKIM-sleutels opnieuw naar de daemon (best effort). */
async function syncAllDkim(): Promise<void> {
  const rows = await getDb()
    .select({ domain: schema.mailDomains.domain, selector: schema.mailDkimKeys.selector, key: schema.mailDkimKeys.privateKeyEnc })
    .from(schema.mailDkimKeys)
    .innerJoin(schema.mailDomains, eq(schema.mailDomains.id, schema.mailDkimKeys.domainId))
    .where(eq(schema.mailDkimKeys.active, true));
  for (const r of rows) await pushDkim(r.domain, r.selector, decrypt(r.key)).catch((e) => console.warn(`[mail] dkim ${r.domain}: ${(e as Error).message}`));
}

// ---------- adressen ----------

async function addressTaken(tx: Tx, address: string): Promise<boolean> {
  const [m] = await tx.select({ id: schema.mailMailboxes.id }).from(schema.mailMailboxes).where(eq(schema.mailMailboxes.address, address));
  if (m) return true;
  const [a] = await tx.select({ id: schema.mailAliases.id }).from(schema.mailAliases).where(eq(schema.mailAliases.address, address));
  return !!a;
}

/**
 * Aliasdoelen: geldig adres (zod), niet het alias zelf, en een doel in een van onze eigen domeinen moet bestaan
 * (mailbox of alias), anders kaatst de mail terug.
 */
async function validateTargets(tx: Tx, aliasAddress: string, goto: string[], allowNew: string[] = []): Promise<string[]> {
  const targets = [...new Set(goto.map((g) => g.trim().toLowerCase()))];
  if (targets.includes(aliasAddress)) err("BAD_REQUEST", "MAIL_INVALID_TARGET");
  const domains = [...new Set(targets.map((t) => t.split("@")[1]!))];
  const local = new Set((await tx.select({ d: schema.mailDomains.domain }).from(schema.mailDomains).where(inArray(schema.mailDomains.domain, domains))).map((r) => r.d));
  for (const t of targets) {
    if (!local.has(t.split("@")[1]!) || allowNew.includes(t)) continue;
    if (!(await addressTaken(tx, t))) err("BAD_REQUEST", "MAIL_INVALID_TARGET");
  }
  return targets;
}

/** Quota-regels van het domein; `exceptId` = mailbox die gewijzigd wordt. */
async function checkDomainLimits(tx: Tx, d: DomainRow, o: { addMailbox: boolean; quotaMb: number; exceptId?: number }) {
  const where = o.exceptId ? and(eq(schema.mailMailboxes.domainId, d.id), ne(schema.mailMailboxes.id, o.exceptId)) : eq(schema.mailMailboxes.domainId, d.id);
  const [u] = await tx.select({ n: count(), q: sum(schema.mailMailboxes.quotaMb) }).from(schema.mailMailboxes).where(where);
  const n = Number(u?.n ?? 0);
  const q = Number(u?.q ?? 0);
  if (o.addMailbox && d.maxMailboxes > 0 && n + 1 > d.maxMailboxes) err("PRECONDITION_FAILED", "MAIL_MAILBOX_LIMIT");
  if (d.maxQuotaMb > 0 && q + o.quotaMb > d.maxQuotaMb) err("PRECONDITION_FAILED", "MAIL_DOMAIN_QUOTA");
}

const isUnique = (e: unknown) => (e as { code?: string })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505";

function toMailbox(m: MailboxRow, usedBytes: number | null = null): MailMailbox {
  return { id: m.id, domainId: m.domainId, localPart: m.localPart, address: m.address, name: m.name, quotaMb: m.quotaMb, usedBytes, lastLogin: m.lastLogin, active: m.active, createdAt: m.createdAt };
}

function toAlias(a: AliasRow): MailAlias {
  return { id: a.id, domainId: a.domainId, address: a.address, catchAll: a.address.startsWith("@"), goto: splitGoto(a.goto), active: a.active, createdAt: a.createdAt };
}

async function mailboxRow(id: number): Promise<MailboxRow> {
  const [m] = await getDb().select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.id, id));
  return m ?? err("NOT_FOUND", "MAIL_MAILBOX_NOT_FOUND");
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---------- procedures ----------

export const mail: Implementation["mail"] = {
  status: async () => {
    const env = getEnv();
    const db = getDb();
    const [[dc], [mc], [ac]] = await Promise.all([
      db.select({ n: count() }).from(schema.mailDomains),
      db.select({ n: count() }).from(schema.mailMailboxes),
      db.select({ n: count() }).from(schema.mailAliases),
    ]);
    const report = await lastReport();
    const base = {
      configured: !!env.MAIL_HOSTNAME,
      mailHostname: env.MAIL_HOSTNAME ?? null,
      lastCheck: report ? { checkedAt: report.checkedAt, ok: report.ok, failedRequired: report.checks.filter((c) => c.required && !c.ok).map((c) => c.id) } : null,
      counts: { domains: Number(dc?.n ?? 0), mailboxes: Number(mc?.n ?? 0), aliases: Number(ac?.n ?? 0) },
    };
    try {
      const st = await (await mailDaemon()).mailStatus(4000);
      return {
        ...base,
        reachable: true,
        enabled: !!st.enabled,
        containers: (st.containers ?? []).map((c) => ({ name: c.name, state: c.state, health: c.health ?? null })),
        queue: st.queue ? { active: st.queue.active, deferred: st.queue.deferred, hold: st.queue.hold } : null,
        vmailBytes: typeof st.vmail_bytes === "number" ? st.vmail_bytes : null,
      };
    } catch {
      return { ...base, reachable: false, enabled: false, containers: [], queue: null, vmailBytes: null };
    }
  },

  checks: {
    run: async ({ ctx }) => {
      const r = await runChecks();
      await log(ctx, "checks.run", { ok: r.ok, failed: r.checks.filter((c) => !c.ok).map((c) => c.id) });
      return r;
    },
    last: () => lastReport(),
  },

  enable: async ({ ctx }) => {
    requireMailHostname();
    const report = await reportForEnable();
    const failed = report.checks.filter((c) => c.required && !c.ok).map((c) => c.id);
    if (failed.length) {
      await log(ctx, "enable_refused", { failed });
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_CHECKS_FAILED" });
    }
    const d = await mailDaemon();
    await daemonCall(() => d.mailEnable());
    await syncAllDkim();
    await log(ctx, "enable", { checkedAt: report.checkedAt.toISOString() });
    return ok;
  },

  disable: async ({ ctx }) => {
    const d = await mailDaemon();
    await daemonCall(() => d.mailDisable());
    await log(ctx, "disable", {});
    return ok;
  },

  domains: {
    list: async () => {
      const rows = await getDb().select().from(schema.mailDomains).orderBy(asc(schema.mailDomains.domain));
      const u = await usage(rows.map((r) => r.id));
      return rows.map((r) => toDomain(r, u.get(r.id)!));
    },

    get: async ({ input }) => domainDetail(await domainRow(input.id)),

    create: async ({ input, ctx }) => {
      if (!input.firstMailbox && !input.postmasterTo) err("BAD_REQUEST", "MAIL_POSTMASTER_TARGET_REQUIRED");
      const domain = input.domain;
      const env = getEnv();
      if (env.MAIL_HOSTNAME === domain) err("BAD_REQUEST", "MAIL_DOMAIN_IS_HOSTNAME");
      const fm = input.firstMailbox;
      if (fm && input.maxQuotaMb > 0 && fm.quotaMb > input.maxQuotaMb) err("PRECONDITION_FAILED", "MAIL_DOMAIN_QUOTA");
      const passwordHash = fm ? await hashMailPassword(fm.password) : null;
      const key = generateDkimKey();
      const selector = "dkim";
      let row: DomainRow;
      try {
        row = await getDb().transaction(async (tx) => {
          const [d] = await tx.insert(schema.mailDomains).values({ domain, description: input.description, maxMailboxes: input.maxMailboxes, maxQuotaMb: input.maxQuotaMb }).returning();
          const target = fm ? `${fm.localPart}@${domain}` : input.postmasterTo!;
          if (fm) await tx.insert(schema.mailMailboxes).values({ domainId: d!.id, localPart: fm.localPart, address: target, name: fm.name, passwordHash: passwordHash!, quotaMb: fm.quotaMb });
          else await validateTargets(tx, `postmaster@${domain}`, [target]);
          for (const lp of ["postmaster", "abuse"]) {
            if (fm?.localPart === lp) continue;
            await tx.insert(schema.mailAliases).values({ domainId: d!.id, address: `${lp}@${domain}`, goto: target });
          }
          await tx.insert(schema.mailDkimKeys).values({ domainId: d!.id, selector, privateKeyEnc: encrypt(key.privateKeyPem), publicKey: key.publicKey, active: true });
          return d!;
        });
      } catch (e) {
        if (isUnique(e)) err("CONFLICT", "MAIL_DOMAIN_EXISTS");
        throw e;
      }
      // De sleutel staat in de database; lukt het nu niet bij de daemon, dan zet mail.enable hem later neer.
      let dkimPushed = true;
      await pushDkim(domain, selector, key.privateKeyPem).catch((e) => {
        dkimPushed = false;
        console.warn(`[mail] dkim ${domain}: ${(e as Error).message}`);
      });
      await log(ctx, "domain.create", { id: row.id, domain, firstMailbox: fm ? `${fm.localPart}@${domain}` : null, postmasterTo: fm ? null : input.postmasterTo, dkimPushed });
      return domainDetail(row);
    },

    update: async ({ input, ctx }) => {
      const row = await getDb().transaction(async (tx) => {
        const d = await domainRow(input.id, tx, true);
        const next = { ...d, ...Object.fromEntries(Object.entries({ description: input.description, maxMailboxes: input.maxMailboxes, maxQuotaMb: input.maxQuotaMb, active: input.active }).filter(([, v]) => v !== undefined)) } as DomainRow;
        const [u] = await tx.select({ n: count(), q: sum(schema.mailMailboxes.quotaMb) }).from(schema.mailMailboxes).where(eq(schema.mailMailboxes.domainId, d.id));
        if (next.maxMailboxes > 0 && Number(u?.n ?? 0) > next.maxMailboxes) err("PRECONDITION_FAILED", "MAIL_MAILBOX_LIMIT");
        if (next.maxQuotaMb > 0 && Number(u?.q ?? 0) > next.maxQuotaMb) err("PRECONDITION_FAILED", "MAIL_DOMAIN_QUOTA");
        const [r] = await tx
          .update(schema.mailDomains)
          .set({ description: next.description, maxMailboxes: next.maxMailboxes, maxQuotaMb: next.maxQuotaMb, active: next.active })
          .where(eq(schema.mailDomains.id, d.id))
          .returning();
        return r!;
      });
      await log(ctx, "domain.update", { id: row.id, domain: row.domain, changes: Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined)) });
      return toDomain(row, (await usage([row.id])).get(row.id)!);
    },

    delete: async ({ input, ctx }) => {
      const d = await domainRow(input.id);
      // Eerst uit (geen aflevering meer), dan Maildirs en DKIM bij de daemon weg, dan de rijen.
      await getDb().update(schema.mailDomains).set({ active: false }).where(eq(schema.mailDomains.id, d.id));
      const boxes = await getDb().select({ address: schema.mailMailboxes.address }).from(schema.mailMailboxes).where(eq(schema.mailMailboxes.domainId, d.id));
      const daemon = await mailDaemon();
      for (const b of boxes) await daemonDelete(() => daemon.deleteMailboxData(b.address));
      await daemonDelete(() => daemon.deleteDkim(d.domain));
      await getDb().delete(schema.mailDomains).where(eq(schema.mailDomains.id, d.id));
      await log(ctx, "domain.delete", { id: d.id, domain: d.domain, mailboxes: boxes.length });
      return ok;
    },

    dnsRecords: async ({ input }) => dnsView(await domainRow(input.id)),

    checkDns: async ({ input, ctx }) => {
      requireMailHostname();
      const r = await checkDomainDns(await domainRow(input.id));
      await log(ctx, "domain.check_dns", { id: r.domainId, domain: r.domain, dnsStatus: r.dnsStatus });
      return r;
    },

    rotateDkim: async ({ input, ctx }) => {
      const d = await domainRow(input.id);
      const existing = (await getDb().select({ s: schema.mailDkimKeys.selector }).from(schema.mailDkimKeys).where(eq(schema.mailDkimKeys.domainId, d.id))).map((r) => r.s);
      const selector = input.selector ?? nextSelector(existing);
      if (existing.includes(selector)) err("CONFLICT", "MAIL_DKIM_SELECTOR_EXISTS");
      const key = generateDkimKey();
      // Eerst de daemon: mislukt dat, dan blijft alles bij het oude.
      await pushDkim(d.domain, selector, key.privateKeyPem);
      const now = new Date();
      await getDb().transaction(async (tx) => {
        await tx.update(schema.mailDkimKeys).set({ active: false, rotatedAt: now }).where(and(eq(schema.mailDkimKeys.domainId, d.id), eq(schema.mailDkimKeys.active, true)));
        await tx.insert(schema.mailDkimKeys).values({ domainId: d.id, selector, privateKeyEnc: encrypt(key.privateKeyPem), publicKey: key.publicKey, active: true });
      });
      await log(ctx, "domain.rotate_dkim", { id: d.id, domain: d.domain, selector });
      return dnsView(await domainRow(d.id));
    },

    applyDns: async ({ input, ctx }) => {
      const host = requireMailHostname();
      const d = await domainRow(input.id);
      const cf = await cloudflareFor(d.domain);
      if (!cf) {
        const any = await getDb().select({ id: schema.dnsProviders.id }).from(schema.dnsProviders).limit(1);
        err("PRECONDITION_FAILED", any.length ? "MAIL_ZONE_NOT_FOUND" : "MAIL_NO_DNS_PROVIDER");
      }
      const { provider, zone } = cf!;
      const c = await recordContext(d);
      const token = decrypt(provider.apiTokenEnc);
      const inZone = (n: string) => n === zone.name || n.endsWith(`.${zone.name}`);
      const changes: Record<string, unknown> = {};
      try {
        for (const r of buildRecords(c)) {
          // Alleen de records van dit domein zelf; A/AAAA van de mailhost en PTR blijven handwerk.
          if (!inZone(r.name) || !(r.name === d.domain || r.name.endsWith(`.${d.domain}`))) continue;
          if (r.id === "mx") changes.mx = await setMxRecord(token, zone.id, r.name, host, r.priority ?? 10);
          else if (r.id === "spf") changes.spf = await setTxtByPrefix(token, zone.id, r.name, "v=spf1", r.value);
          else if (r.id === "dkim") changes.dkim = await setTxtByPrefix(token, zone.id, r.name, "v=DKIM1", r.value);
          else if (r.id === "dmarc") changes.dmarc = await setTxtByPrefix(token, zone.id, r.name, "v=DMARC1", r.value);
        }
      } catch (e) {
        if (e instanceof CloudflareError) err("BAD_GATEWAY", `CLOUDFLARE_ERROR: ${e.message}`);
        throw e;
      }
      await log(ctx, "domain.apply_dns", { id: d.id, domain: d.domain, zone: zone.name, providerId: provider.id, changes });
      return checkDomainDns(await domainRow(d.id));
    },
  },

  mailboxes: {
    list: async ({ input }) => {
      await domainRow(input.domainId);
      const q = input.search?.trim();
      const pattern = q ? `%${likeEscape(q.toLowerCase())}%` : null;
      const rows = await getDb()
        .select()
        .from(schema.mailMailboxes)
        .where(and(eq(schema.mailMailboxes.domainId, input.domainId), pattern ? or(ilike(schema.mailMailboxes.address, pattern), ilike(schema.mailMailboxes.name, pattern)) : undefined))
        .orderBy(asc(schema.mailMailboxes.localPart));
      let used = new Map<string, number>();
      if (rows.length) {
        try {
          const r = await (await mailDaemon()).mailboxQuota(rows.map((m) => m.address));
          used = new Map(r.items.map((i) => [i.address.toLowerCase(), i.used_bytes]));
        } catch {
          /* best effort: daemon onbereikbaar of stack uit */
        }
      }
      return rows.map((m) => toMailbox(m, used.get(m.address) ?? null));
    },

    create: async ({ input, ctx }) => {
      const passwordHash = await hashMailPassword(input.password);
      let m: MailboxRow;
      try {
        m = await getDb().transaction(async (tx) => {
          const d = await domainRow(input.domainId, tx, true);
          const address = `${input.localPart}@${d.domain}`;
          if (await addressTaken(tx, address)) err("CONFLICT", "MAIL_ADDRESS_EXISTS");
          await checkDomainLimits(tx, d, { addMailbox: true, quotaMb: input.quotaMb });
          const [r] = await tx.insert(schema.mailMailboxes).values({ domainId: d.id, localPart: input.localPart, address, name: input.name, passwordHash, quotaMb: input.quotaMb, active: input.active }).returning();
          return r!;
        });
      } catch (e) {
        if (isUnique(e)) err("CONFLICT", "MAIL_ADDRESS_EXISTS");
        throw e;
      }
      await log(ctx, "mailbox.create", { id: m.id, address: m.address, quotaMb: m.quotaMb });
      return toMailbox(m);
    },

    update: async ({ input, ctx }) => {
      const cur = await mailboxRow(input.id);
      const m = await getDb().transaction(async (tx) => {
        const d = await domainRow(cur.domainId, tx, true);
        if (input.quotaMb !== undefined) await checkDomainLimits(tx, d, { addMailbox: false, quotaMb: input.quotaMb, exceptId: cur.id });
        const set: Partial<MailboxRow> = {};
        if (input.name !== undefined) set.name = input.name;
        if (input.quotaMb !== undefined) set.quotaMb = input.quotaMb;
        if (input.active !== undefined) set.active = input.active;
        if (!Object.keys(set).length) return cur;
        const [r] = await tx.update(schema.mailMailboxes).set(set).where(eq(schema.mailMailboxes.id, cur.id)).returning();
        return r!;
      });
      await log(ctx, "mailbox.update", { id: m.id, address: m.address, changes: Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== undefined)) });
      return toMailbox(m);
    },

    setPassword: async ({ input, ctx }) => {
      const m = await mailboxRow(input.id);
      await getDb().update(schema.mailMailboxes).set({ passwordHash: await hashMailPassword(input.password) }).where(eq(schema.mailMailboxes.id, m.id));
      await log(ctx, "mailbox.set_password", { id: m.id, address: m.address });
      return ok;
    },

    delete: async ({ input, ctx }) => {
      const m = await mailboxRow(input.id);
      // Eerst inactief (geen aflevering/login meer), dan de Maildir weg; lukt dat niet, dan blijft hij inactief staan.
      await getDb().update(schema.mailMailboxes).set({ active: false }).where(eq(schema.mailMailboxes.id, m.id));
      const d = await mailDaemon();
      await daemonDelete(() => d.deleteMailboxData(m.address));
      await getDb().delete(schema.mailMailboxes).where(eq(schema.mailMailboxes.id, m.id));
      await log(ctx, "mailbox.delete", { id: m.id, address: m.address });
      return ok;
    },
  },

  aliases: {
    list: async ({ input }) => {
      await domainRow(input.domainId);
      const rows = await getDb()
        .select()
        .from(schema.mailAliases)
        .where(eq(schema.mailAliases.domainId, input.domainId))
        // Catch-all (`@…`) onderaan.
        .orderBy(sql`${schema.mailAliases.address} like '@%'`, asc(schema.mailAliases.address));
      return rows.map(toAlias);
    },

    create: async ({ input, ctx }) => {
      let a: AliasRow;
      try {
        a = await getDb().transaction(async (tx) => {
          const d = await domainRow(input.domainId, tx, true);
          const address = `${input.localPart ?? ""}@${d.domain}`;
          if (await addressTaken(tx, address)) err("CONFLICT", "MAIL_ADDRESS_EXISTS");
          const goto = await validateTargets(tx, address, input.goto);
          const [r] = await tx.insert(schema.mailAliases).values({ domainId: d.id, address, goto: goto.join(","), active: input.active }).returning();
          return r!;
        });
      } catch (e) {
        if (isUnique(e)) err("CONFLICT", "MAIL_ADDRESS_EXISTS");
        throw e;
      }
      await log(ctx, "alias.create", { id: a.id, address: a.address, goto: splitGoto(a.goto), catchAll: a.address.startsWith("@") });
      return toAlias(a);
    },

    update: async ({ input, ctx }) => {
      const a = await getDb().transaction(async (tx) => {
        const [cur] = await tx.select().from(schema.mailAliases).where(eq(schema.mailAliases.id, input.id)).for("update");
        if (!cur) err("NOT_FOUND", "MAIL_ALIAS_NOT_FOUND");
        const set: Partial<AliasRow> = {};
        if (input.goto) set.goto = (await validateTargets(tx, cur!.address, input.goto)).join(",");
        if (input.active !== undefined) set.active = input.active;
        if (!Object.keys(set).length) return cur!;
        const [r] = await tx.update(schema.mailAliases).set(set).where(eq(schema.mailAliases.id, cur!.id)).returning();
        return r!;
      });
      await log(ctx, "alias.update", { id: a.id, address: a.address, goto: splitGoto(a.goto), active: a.active });
      return toAlias(a);
    },

    delete: async ({ input, ctx }) => {
      const [a] = await getDb().delete(schema.mailAliases).where(eq(schema.mailAliases.id, input.id)).returning();
      if (!a) err("NOT_FOUND", "MAIL_ALIAS_NOT_FOUND");
      await log(ctx, "alias.delete", { id: a!.id, address: a!.address });
      return ok;
    },
  },

  queue: {
    list: async () => {
      const d = await mailDaemon();
      const r = await daemonCall(() => d.mailQueue());
      return (r.items ?? []).map((i) => {
        const at = new Date(i.arrival_time);
        return { queueId: i.queue_id, sender: i.sender, recipients: i.recipients ?? [], size: i.size, arrivalTime: Number.isNaN(at.getTime()) ? new Date(0) : at, reason: i.reason ?? null };
      });
    },
    flush: async ({ ctx }) => {
      const d = await mailDaemon();
      await daemonCall(() => d.flushQueue());
      await log(ctx, "queue.flush", {});
      return ok;
    },
    delete: async ({ input, ctx }) => {
      const d = await mailDaemon();
      try {
        await d.deleteQueueItem(input.queueId);
      } catch (e) {
        if (e instanceof DaemonHttpError && e.status === 404) err("NOT_FOUND", "MAIL_QUEUE_ITEM_NOT_FOUND");
        throw toTrpcError(e);
      }
      await log(ctx, "queue.delete", { queueId: input.queueId });
      return ok;
    },
  },
};

