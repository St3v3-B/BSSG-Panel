/**
 * Mock voor mail.*: drie domeinen (ok / in afwachting / fout), ~15 mailboxen, aliassen met catch-all,
 * een systeemcheck met een paar rode checks, een wachtrij met vier berichten en de containerstatus.
 * In de mock slaagt `checks.run` altijd voor PTR/FCrDNS (de "provider heeft het opgelost").
 */
import { TRPCError } from "@trpc/server";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

const ok = { ok: true as const };
const H = 3600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms);
const notFound = (m: string): never => {
  throw new TRPCError({ code: "NOT_FOUND", message: m });
};

const MAIL_HOSTNAME = "mail.panel.test";
const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const PUBKEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxKLxoS2tFczGkPLPgizskuemMghRniWaoLcyehkd3qqGElvW/VDL5AaWTg0nLVkjRo9z+40RQzuVaE8AkAFmxZzow3x+VJYKdjykkJ0iT9wCS0DRTXu269V264Vf/3jvredZiKRkgwlL9xNAwxXFg0x/XFw005UWVRIkdgcKWTjpBP2dPwVZ4WWC+9aGVd+Gyn1o0CLelf4rEjGoXbAAEgAqeGUxrcIlbjXfbcmwIDAQAB";

const CHECK_HINTS: Record<s.MailCheckId, string> = {
  outbound_25: "Ask your provider to open outbound port 25, or configure a smarthost.",
  inbound_ports: "Open 25, 465, 587 and 993 in the firewall (and port-forward them if behind NAT).",
  ptr: `Set the reverse DNS (PTR) of ${IPV4} to ${MAIL_HOSTNAME} at your hosting provider.`,
  fcrdns: `Point the A record of ${MAIL_HOSTNAME} to ${IPV4}.`,
  helo: "The panel sets myhostname automatically after the PTR is correct.",
  blacklists: "Request delisting at the listed blacklist; mail stays off while listed on Spamhaus.",
  certificate: `Check the Caddy log; the A record of ${MAIL_HOSTNAME} and port 80 must be reachable.`,
  ports_free: "Stop the process that listens on the mail ports.",
  clock: "Enable NTP (timedatectl set-ntp true).",
  disk: "Free up space on the vmail volume.",
};

function sampleReport(fixed: boolean): s.MailCheckReport {
  const c = (id: s.MailCheckId, good: boolean, required: boolean, detail: string, data: Record<string, unknown> | null = null): s.MailCheck => ({
    id,
    ok: good,
    required,
    detail,
    hint: good ? null : CHECK_HINTS[id],
    data,
  });
  const checks: s.MailCheck[] = [
    c("outbound_25", true, true, "Connected to gmail-smtp-in.l.google.com:25 and outlook MX; banner received.", { hosts: ["gmail-smtp-in.l.google.com", "mx1.hotmail.com"] }),
    c("inbound_ports", true, true, "25, 465, 587 and 993 reachable on " + IPV4 + ".", { open: [25, 465, 587, 993], closed: [] }),
    fixed
      ? c("ptr", true, true, `${IPV4} → ${MAIL_HOSTNAME}`, { ipv4: IPV4, ptr: MAIL_HOSTNAME })
      : c("ptr", false, true, `${IPV4} → static.10.113.0.203.example.net (expected ${MAIL_HOSTNAME})`, { ipv4: IPV4, ptr: "static.10.113.0.203.example.net" }),
    fixed ? c("fcrdns", true, true, `${MAIL_HOSTNAME} → ${IPV4}`) : c("fcrdns", false, true, `PTR name static.10.113.0.203.example.net does not resolve to ${IPV4}.`),
    fixed ? c("helo", true, true, `myhostname = ${MAIL_HOSTNAME}`) : c("helo", false, true, `myhostname ${MAIL_HOSTNAME} differs from the PTR name.`),
    c("blacklists", true, true, "Not listed on Spamhaus ZEN, Barracuda, SpamCop or UCEPROTECT L1.", { listed: [] }),
    c("certificate", true, true, `Valid certificate for ${MAIL_HOSTNAME}, expires in 61 days.`, { expiresAt: new Date(Date.now() + 61 * D).toISOString() }),
    c("ports_free", true, true, "No other process on 25, 465, 587, 993."),
    c("clock", true, false, "Clock offset 0.03 s."),
    c("disk", false, false, "7% free on the vmail volume (3.5 GB of 50 GB).", { freeBytes: 3_500_000_000, totalBytes: 50_000_000_000 }),
  ];
  return { checkedAt: new Date(), checks, ok: checks.every((x) => x.ok || !x.required) };
}

interface MockDomain {
  id: number;
  domain: string;
  description: string | null;
  maxMailboxes: number;
  maxQuotaMb: number;
  dnsStatus: s.MailDnsStatus;
  dnsCheckedAt: Date | null;
  active: boolean;
  createdAt: Date;
  dkim: s.MailDkim | null;
  /** Welke records in de mock "kloppen". */
  okRecords: Set<string>;
}

interface MockMailbox extends Omit<s.MailMailbox, "usedBytes"> {
  usedBytes: number | null;
}

export function createMailMock(d: { id: () => number }): Implementation["mail"] {
  let enabled = true;
  let report: s.MailCheckReport | null = { ...sampleReport(false), checkedAt: ago(25 * 60_000) };
  const domains: MockDomain[] = [
    { id: 1, domain: "panel.test", description: "Main domain", maxMailboxes: 0, maxQuotaMb: 0, dnsStatus: "ok", dnsCheckedAt: ago(40 * 60_000), active: true, createdAt: ago(120 * D), dkim: { selector: "dkim", publicKey: PUBKEY, createdAt: ago(120 * D), rotatedAt: null }, okRecords: new Set(["a", "aaaa", "mx", "spf", "dkim", "dmarc"]) },
    { id: 2, domain: "shop.panel.test", description: "Webshop", maxMailboxes: 10, maxQuotaMb: 20_480, dnsStatus: "pending", dnsCheckedAt: ago(2 * H), active: true, createdAt: ago(3 * D), dkim: { selector: "dkim", publicKey: PUBKEY, createdAt: ago(3 * D), rotatedAt: null }, okRecords: new Set(["a", "aaaa", "mx"]) },
    { id: 3, domain: "node1.test", description: null, maxMailboxes: 5, maxQuotaMb: 5_120, dnsStatus: "error", dnsCheckedAt: ago(5 * H), active: false, createdAt: ago(30 * D), dkim: { selector: "dkim20260901", publicKey: PUBKEY, createdAt: ago(30 * D), rotatedAt: ago(10 * D) }, okRecords: new Set(["a", "mx", "dkim"]) },
  ];
  const mb = (id: number, domainId: number, localPart: string, name: string, quotaMb: number, usedPct: number | null, lastLogin: Date | null, active = true, created = 60 * D): MockMailbox => {
    const dom = domains.find((x) => x.id === domainId)!;
    return { id, domainId, localPart, address: `${localPart}@${dom.domain}`, name, quotaMb, usedBytes: usedPct === null ? null : Math.round(quotaMb * 1024 * 1024 * usedPct), lastLogin, active, createdAt: ago(created) };
  };
  const mailboxes: MockMailbox[] = [
    mb(1, 1, "steve", "Steve", 10_240, 0.42, ago(12 * 60_000), true, 120 * D),
    mb(2, 1, "info", "Info", 2_048, 0.91, ago(3 * H)),
    mb(3, 1, "support", "Support desk", 5_120, 0.67, ago(20 * 60_000)),
    mb(4, 1, "billing", "Billing", 1_024, 0.12, ago(2 * D)),
    mb(5, 1, "kees", "Kees de Vries", 2_048, 0.33, ago(6 * D)),
    mb(6, 1, "anna", "Anna Jansen", 4_096, 0.78, ago(45 * 60_000)),
    mb(7, 1, "noreply", "No reply", 256, 0.01, null),
    mb(8, 1, "oud-personeel", "Former employee", 1_024, 0.55, ago(140 * D), false),
    mb(9, 2, "orders", "Orders", 4_096, 0.24, ago(4 * H), true, 3 * D),
    mb(10, 2, "klantenservice", "Klantenservice", 4_096, 0.05, ago(1 * D), true, 3 * D),
    mb(11, 2, "marketing", "Marketing", 2_048, null, null, true, 1 * D),
    mb(12, 2, "jan", "Jan Bakker", 1_024, 0.97, ago(15 * 60_000), true, 3 * D),
    mb(13, 3, "admin", "Node admin", 1_024, 0.02, ago(9 * D), true, 30 * D),
    mb(14, 3, "alerts", "Alerts", 2_048, 0.48, ago(30 * D), true, 30 * D),
    mb(15, 3, "test.user", "Test user", 512, 0, null, false, 20 * D),
  ];
  const al = (id: number, domainId: number, local: string | null, goto: string[], active = true): s.MailAlias => {
    const dom = domains.find((x) => x.id === domainId)!;
    return { id, domainId, address: `${local ?? ""}@${dom.domain}`, catchAll: local === null, goto, active, createdAt: ago(30 * D) };
  };
  const aliases: s.MailAlias[] = [
    al(1, 1, "postmaster", ["steve@panel.test"]),
    al(2, 1, "abuse", ["steve@panel.test"]),
    al(3, 1, "sales", ["anna@panel.test", "kees@panel.test"]),
    al(4, 1, "hello", ["info@panel.test"]),
    al(5, 1, null, ["info@panel.test"]),
    al(6, 2, "postmaster", ["orders@shop.panel.test"]),
    al(7, 2, "abuse", ["orders@shop.panel.test"]),
    al(8, 2, "webshop", ["orders@shop.panel.test", "steve@panel.test"], false),
    al(9, 3, "postmaster", ["admin@node1.test"]),
    al(10, 3, "abuse", ["admin@node1.test"]),
    al(11, 3, null, ["alerts@node1.test"], false),
  ];
  let queue: s.MailQueueItem[] = [
    { queueId: "4F2A31C0B1", sender: "orders@shop.panel.test", recipients: ["klant@example.com"], size: 18_240, arrivalTime: ago(35 * 60_000), reason: "connect to mx.example.com[192.0.2.25]:25: Connection timed out" },
    { queueId: "7B9D02E4A6", sender: "info@panel.test", recipients: ["someone@example.org", "other@example.org"], size: 4_512, arrivalTime: ago(2 * H), reason: "host mx.example.org[198.51.100.30] said: 451 4.7.1 Greylisted, please try again later" },
    { queueId: "9C1E5F7A23", sender: "alerts@node1.test", recipients: ["ops@example.net"], size: 2_048, arrivalTime: ago(6 * H), reason: "Host or domain name not found. Name service error for name=example.net type=MX" },
    { queueId: "A0B1C2D3E4", sender: "steve@panel.test", recipients: ["friend@example.com"], size: 1_204_880, arrivalTime: ago(30_000), reason: null },
  ];

  const domain = (id: number) => domains.find((x) => x.id === id) ?? notFound("MAIL_DOMAIN_NOT_FOUND");
  const toDomain = (x: MockDomain): s.MailDomain => ({
    id: x.id,
    domain: x.domain,
    description: x.description,
    maxMailboxes: x.maxMailboxes,
    maxQuotaMb: x.maxQuotaMb,
    dnsStatus: x.dnsStatus,
    dnsCheckedAt: x.dnsCheckedAt,
    active: x.active,
    ownerUserId: null,
    createdAt: x.createdAt,
    mailboxCount: mailboxes.filter((m) => m.domainId === x.id).length,
    aliasCount: aliases.filter((a) => a.domainId === x.id).length,
    quotaAllocatedMb: mailboxes.filter((m) => m.domainId === x.id).reduce((n, m) => n + m.quotaMb, 0),
  });
  const detail = (x: MockDomain): s.MailDomainDetail => ({ ...toDomain(x), dkim: x.dkim ? { ...x.dkim } : null });

  const records = (x: MockDomain): s.MailDnsRecords => {
    const st = (id: string, required: boolean, actualOk: string[], actualBad: string[]): Pick<s.MailDnsRecord, "status" | "actual"> =>
      x.dnsCheckedAt === null ? { status: "unchecked", actual: [] } : x.okRecords.has(id) ? { status: "ok", actual: actualOk } : actualBad.length ? { status: "wrong", actual: actualBad } : { status: required ? "missing" : "missing", actual: [] };
    const dkimValue = x.dkim ? `v=DKIM1; k=rsa; p=${x.dkim.publicKey}` : "";
    const ptrOk = report?.checks.find((c) => c.id === "ptr")?.ok ?? false;
    const recs: s.MailDnsRecord[] = [
      { id: "a", type: "A", name: MAIL_HOSTNAME, value: IPV4, priority: null, required: false, where: "dns", ...st("a", false, [IPV4], []) },
      { id: "aaaa", type: "AAAA", name: MAIL_HOSTNAME, value: IPV6, priority: null, required: false, where: "dns", ...st("aaaa", false, [IPV6], []) },
      { id: "mx", type: "MX", name: x.domain, value: MAIL_HOSTNAME, priority: 10, required: true, where: "dns", ...st("mx", true, [`10 ${MAIL_HOSTNAME}`], ["10 mx.oldhost.example"]) },
      { id: "spf", type: "TXT", name: x.domain, value: "v=spf1 mx -all", priority: null, required: true, where: "dns", ...st("spf", true, ["v=spf1 mx -all"], x.id === 3 ? ["v=spf1 include:_spf.example.com ~all"] : []) },
      { id: "dkim", type: "TXT", name: `${x.dkim?.selector ?? "dkim"}._domainkey.${x.domain}`, value: dkimValue, priority: null, required: true, where: "dns", ...st("dkim", true, [dkimValue], []) },
      { id: "dmarc", type: "TXT", name: `_dmarc.${x.domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${x.domain}`, priority: null, required: true, where: "dns", ...st("dmarc", true, [`v=DMARC1; p=none; rua=mailto:dmarc@${x.domain}`], []) },
      { id: "ptr", type: "PTR", name: IPV4, value: MAIL_HOSTNAME, priority: null, required: false, where: "hosting", status: ptrOk ? "ok" : "wrong", actual: [ptrOk ? MAIL_HOSTNAME : "static.10.113.0.203.example.net"] },
    ];
    return { domainId: x.id, domain: x.domain, mailHostname: MAIL_HOSTNAME, dnsStatus: x.dnsStatus, checkedAt: x.dnsCheckedAt, records: recs, cloudflare: x.id === 1 ? { providerId: 1, zone: "panel.test" } : null };
  };

  const dnsStatusOf = (x: MockDomain): s.MailDnsStatus => (["mx", "spf", "dkim", "dmarc"].every((r) => x.okRecords.has(r)) ? "ok" : x.okRecords.has("mx") ? "pending" : "error");

  const checkQuota = (dom: MockDomain, extraMb: number, exceptId?: number) => {
    if (dom.maxQuotaMb === 0) return;
    const used = mailboxes.filter((m) => m.domainId === dom.id && m.id !== exceptId).reduce((n, m) => n + m.quotaMb, 0);
    if (used + extraMb > dom.maxQuotaMb) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_DOMAIN_QUOTA" });
  };
  const addressTaken = (address: string) => mailboxes.some((m) => m.address === address) || aliases.some((a) => a.address === address);

  return {
    status: () => {
      const containers: s.MailContainer[] = enabled
        ? [
            { name: "panel-postfix", state: "running", health: "healthy" },
            { name: "panel-dovecot", state: "running", health: "healthy" },
            { name: "panel-rspamd", state: "running", health: "healthy" },
            { name: "panel-clamav", state: "running", health: "starting" },
            { name: "panel-unbound", state: "running", health: "healthy" },
            { name: "panel-mail-redis", state: "running", health: null },
          ]
        : [
            { name: "panel-postfix", state: "exited", health: null },
            { name: "panel-dovecot", state: "exited", health: null },
          ];
      return {
        configured: true,
        mailHostname: MAIL_HOSTNAME,
        reachable: true,
        enabled,
        containers,
        queue: enabled ? { active: 1, deferred: queue.filter((q) => q.reason).length, hold: 0 } : null,
        vmailBytes: mailboxes.reduce((n, m) => n + (m.usedBytes ?? 0), 0),
        lastCheck: report ? { checkedAt: report.checkedAt, ok: report.ok, failedRequired: report.checks.filter((c) => c.required && !c.ok).map((c) => c.id) } : null,
        counts: { domains: domains.length, mailboxes: mailboxes.length, aliases: aliases.length },
      };
    },
    checks: {
      run: async () => {
        await new Promise((r) => setTimeout(r, 1200));
        // Eerste run in de mock blijft rood; daarna "opgelost".
        report = sampleReport(report !== null && report.checkedAt.getTime() > Date.now() - 20 * 60_000);
        return report;
      },
      last: () => report,
    },
    enable: () => {
      if (!report || report.checks.some((c) => c.required && !c.ok)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_CHECKS_FAILED" });
      enabled = true;
      return ok;
    },
    disable: () => {
      enabled = false;
      return ok;
    },
    domains: {
      list: () => domains.map(toDomain),
      get: ({ input }) => detail(domain(input.id)),
      create: ({ input }) => {
        if (domains.some((x) => x.domain === input.domain)) throw new TRPCError({ code: "CONFLICT", message: "MAIL_DOMAIN_EXISTS" });
        if (!input.firstMailbox && !input.postmasterTo) throw new TRPCError({ code: "BAD_REQUEST", message: "MAIL_POSTMASTER_TARGET_REQUIRED" });
        const x: MockDomain = { id: d.id(), domain: input.domain, description: input.description, maxMailboxes: input.maxMailboxes, maxQuotaMb: input.maxQuotaMb, dnsStatus: "pending", dnsCheckedAt: null, active: true, createdAt: new Date(), dkim: { selector: "dkim", publicKey: PUBKEY, createdAt: new Date(), rotatedAt: null }, okRecords: new Set() };
        domains.push(x);
        let target = input.postmasterTo!;
        if (input.firstMailbox) {
          const f = input.firstMailbox;
          target = `${f.localPart}@${x.domain}`;
          mailboxes.push({ id: d.id(), domainId: x.id, localPart: f.localPart, address: target, name: f.name, quotaMb: f.quotaMb, usedBytes: null, lastLogin: null, active: true, createdAt: new Date() });
        }
        for (const lp of ["postmaster", "abuse"]) if (lp !== input.firstMailbox?.localPart) aliases.push({ id: d.id(), domainId: x.id, address: `${lp}@${x.domain}`, catchAll: false, goto: [target], active: true, createdAt: new Date() });
        return detail(x);
      },
      update: ({ input }) => {
        const x = domain(input.id);
        const mine = mailboxes.filter((m) => m.domainId === x.id);
        if (input.maxQuotaMb !== undefined && input.maxQuotaMb > 0 && mine.reduce((n, m) => n + m.quotaMb, 0) > input.maxQuotaMb) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_DOMAIN_QUOTA" });
        if (input.maxMailboxes !== undefined && input.maxMailboxes > 0 && mine.length > input.maxMailboxes) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_MAILBOX_LIMIT" });
        if (input.description !== undefined) x.description = input.description;
        if (input.maxMailboxes !== undefined) x.maxMailboxes = input.maxMailboxes;
        if (input.maxQuotaMb !== undefined) x.maxQuotaMb = input.maxQuotaMb;
        if (input.active !== undefined) x.active = input.active;
        return toDomain(x);
      },
      delete: ({ input }) => {
        const x = domain(input.id);
        domains.splice(domains.indexOf(x), 1);
        for (let i = mailboxes.length - 1; i >= 0; i--) if (mailboxes[i]!.domainId === x.id) mailboxes.splice(i, 1);
        for (let i = aliases.length - 1; i >= 0; i--) if (aliases[i]!.domainId === x.id) aliases.splice(i, 1);
        return ok;
      },
      dnsRecords: ({ input }) => records(domain(input.id)),
      checkDns: async ({ input }) => {
        const x = domain(input.id);
        await new Promise((r) => setTimeout(r, 600));
        // In de mock komt er bij elke controle een record bij, tot alles klopt.
        const next = ["a", "aaaa", "mx", "spf", "dkim", "dmarc"].find((r) => !x.okRecords.has(r));
        if (next) x.okRecords.add(next);
        x.dnsCheckedAt = new Date();
        x.dnsStatus = dnsStatusOf(x);
        return records(x);
      },
      rotateDkim: ({ input }) => {
        const x = domain(input.id);
        const now = new Date();
        const sel = input.selector ?? `dkim${now.toISOString().slice(0, 10).replaceAll("-", "")}`;
        x.dkim = { selector: sel, publicKey: PUBKEY, createdAt: x.dkim?.createdAt ?? now, rotatedAt: now };
        x.okRecords.delete("dkim");
        x.dnsStatus = dnsStatusOf(x);
        return records(x);
      },
      applyDns: ({ input }) => {
        const x = domain(input.id);
        if (x.id !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_NO_DNS_PROVIDER" });
        for (const r of ["mx", "spf", "dkim", "dmarc"]) x.okRecords.add(r);
        x.dnsCheckedAt = new Date();
        x.dnsStatus = dnsStatusOf(x);
        return records(x);
      },
    },
    mailboxes: {
      list: ({ input }) => {
        domain(input.domainId);
        const q = input.search?.toLowerCase();
        return mailboxes.filter((m) => m.domainId === input.domainId && (!q || m.address.includes(q) || m.name.toLowerCase().includes(q))).map((m) => ({ ...m }));
      },
      create: ({ input }) => {
        const dom = domain(input.domainId);
        const address = `${input.localPart}@${dom.domain}`;
        if (addressTaken(address)) throw new TRPCError({ code: "CONFLICT", message: "MAIL_ADDRESS_EXISTS" });
        if (dom.maxMailboxes > 0 && mailboxes.filter((m) => m.domainId === dom.id).length >= dom.maxMailboxes) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MAIL_MAILBOX_LIMIT" });
        checkQuota(dom, input.quotaMb);
        const m: MockMailbox = { id: d.id(), domainId: dom.id, localPart: input.localPart, address, name: input.name, quotaMb: input.quotaMb, usedBytes: null, lastLogin: null, active: input.active, createdAt: new Date() };
        mailboxes.push(m);
        return { ...m };
      },
      update: ({ input }) => {
        const m = mailboxes.find((x) => x.id === input.id) ?? notFound("MAIL_MAILBOX_NOT_FOUND");
        if (input.quotaMb !== undefined) checkQuota(domain(m.domainId), input.quotaMb, m.id);
        if (input.name !== undefined) m.name = input.name;
        if (input.quotaMb !== undefined) m.quotaMb = input.quotaMb;
        if (input.active !== undefined) m.active = input.active;
        return { ...m };
      },
      setPassword: ({ input }) => {
        mailboxes.find((x) => x.id === input.id) ?? notFound("MAIL_MAILBOX_NOT_FOUND");
        return ok;
      },
      delete: ({ input }) => {
        const i = mailboxes.findIndex((x) => x.id === input.id);
        if (i < 0) notFound("MAIL_MAILBOX_NOT_FOUND");
        mailboxes.splice(i, 1);
        return ok;
      },
    },
    aliases: {
      list: ({ input }) => {
        domain(input.domainId);
        return aliases.filter((a) => a.domainId === input.domainId).map((a) => ({ ...a, goto: [...a.goto] }));
      },
      create: ({ input }) => {
        const dom = domain(input.domainId);
        const address = `${input.localPart ?? ""}@${dom.domain}`;
        if (addressTaken(address)) throw new TRPCError({ code: "CONFLICT", message: "MAIL_ADDRESS_EXISTS" });
        if (input.goto.includes(address)) throw new TRPCError({ code: "BAD_REQUEST", message: "MAIL_INVALID_TARGET" });
        const a: s.MailAlias = { id: d.id(), domainId: dom.id, address, catchAll: input.localPart === null, goto: [...new Set(input.goto)], active: input.active, createdAt: new Date() };
        aliases.push(a);
        return { ...a };
      },
      update: ({ input }) => {
        const a = aliases.find((x) => x.id === input.id) ?? notFound("MAIL_ALIAS_NOT_FOUND");
        if (input.goto) {
          if (input.goto.includes(a.address)) throw new TRPCError({ code: "BAD_REQUEST", message: "MAIL_INVALID_TARGET" });
          a.goto = [...new Set(input.goto)];
        }
        if (input.active !== undefined) a.active = input.active;
        return { ...a, goto: [...a.goto] };
      },
      delete: ({ input }) => {
        const i = aliases.findIndex((x) => x.id === input.id);
        if (i < 0) notFound("MAIL_ALIAS_NOT_FOUND");
        aliases.splice(i, 1);
        return ok;
      },
    },
    queue: {
      list: () => queue.map((q) => ({ ...q, recipients: [...q.recipients] })),
      flush: () => {
        queue = queue.filter((q) => q.reason !== null && q.reason.includes("not found"));
        return ok;
      },
      delete: ({ input }) => {
        if (!queue.some((q) => q.queueId === input.queueId)) notFound("MAIL_QUEUE_ITEM_NOT_FOUND");
        queue = queue.filter((q) => q.queueId !== input.queueId);
        return ok;
      },
    },
  };
}
