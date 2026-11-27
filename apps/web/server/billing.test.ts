import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMonths, billingTick, pickNode, setBillingClock } from "./billing/core";
import { assertPlanBackupRoom } from "./billing/plans";
import { mollieWebhookToken, setBillingFetch, stripeSignatureHeader, verifyStripeSignature, SignatureError } from "./billing/providers";
import { handleWebhook } from "./billing/webhooks";
import { getDb, schema } from "./db";
import { reserveDatabase } from "./routers/quotas";
import { FakeBilling } from "./test/fake-billing";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
const fake = new FakeBilling();
const DAY = 86_400_000;
let now = new Date("2026-12-01T10:00:00Z");
const at = (d: Date) => {
  now = d;
};
let admin: TestUser, alice: TestUser, bob: TestUser;
let gameId = 0, webId = 0;
const WHSEC = "whsec_test_0123456789abcdef";

const gamePlan = (o: Record<string, unknown> = {}) => ({
  name: "Starter",
  description: "Kleine server",
  type: "game" as const,
  templateIds: [gameId],
  nodeIds: null,
  ramMb: 1024,
  cpuPct: 100,
  diskMb: 2048,
  maxDatabases: 1,
  maxBackups: 2,
  allocations: 2,
  priceCents: 500,
  currency: "EUR",
  visible: true,
  sortOrder: 0,
  ...o,
});

async function serverRow(uuid: string) {
  const [s] = await getDb().select().from(schema.servers).where(eq(schema.servers.uuid, uuid));
  return s;
}
async function subRow(id: number) {
  const [s] = await getDb().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, id));
  return s!;
}
async function invoicesOf(subId: number) {
  return getDb().select().from(schema.invoices).where(eq(schema.invoices.subscriptionId, subId)).orderBy(schema.invoices.id);
}

function stripeEvent(invoiceId: number, o: { id?: string; type?: string; paid?: boolean } = {}) {
  return JSON.stringify({
    id: o.id ?? `evt_${invoiceId}_${Math.random().toString(36).slice(2)}`,
    type: o.type ?? "checkout.session.completed",
    data: { object: { id: "cs_test_x", payment_status: o.paid === false ? "unpaid" : "paid", client_reference_id: String(invoiceId), metadata: { invoice_id: String(invoiceId) } } },
  });
}
const stripeHook = (body: string, sig: string | null) =>
  handleWebhook("stripe", new Request("http://panel.test/api/billing/stripe", { method: "POST", headers: sig ? { "stripe-signature": sig, "content-type": "application/json" } : {}, body }));
const mollieHook = (query: string, id: string) =>
  handleWebhook("mollie", new Request(`http://panel.test/api/billing/mollie?${query}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${id}` }));

beforeAll(async () => {
  setBillingFetch(fake.fetch);
  setBillingClock(() => now);
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  alice = await h.user({ discordId: "310000000000000001", name: "alice" });
  bob = await h.user({ discordId: "310000000000000002", name: "bob" });
  gameId = await h.templateId("testgame");
  webId = await h.templateId("testweb");
  for (let p = 32000; p < 32012; p++) await h.allocation(p);
});

afterAll(() => {
  setBillingFetch(null);
  setBillingClock(null);
});

describe("hulpjes", () => {
  it("addMonths knipt op het einde van korte maanden en houdt de ankerdag", () => {
    const jan31 = new Date("2026-01-31T12:00:00Z");
    const feb = addMonths(jan31, 1);
    expect(feb.toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(addMonths(feb, 1, 31).toISOString()).toBe("2026-03-31T12:00:00.000Z");
    expect(addMonths(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("Stripe-signature: goed, fout, verlopen, ontbrekend", () => {
    const body = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    expect(() => verifyStripeSignature(stripeSignatureHeader(WHSEC, body, t), body, WHSEC)).not.toThrow();
    expect(() => verifyStripeSignature(stripeSignatureHeader("whsec_other_secret_xx", body, t), body, WHSEC)).toThrow(SignatureError);
    expect(() => verifyStripeSignature(stripeSignatureHeader(WHSEC, body, t), body + " ", WHSEC)).toThrow(SignatureError);
    expect(() => verifyStripeSignature(stripeSignatureHeader(WHSEC, body, t - 3600), body, WHSEC)).toThrow(/tolerance/);
    expect(() => verifyStripeSignature(null, body, WHSEC)).toThrow(SignatureError);
    expect(() => verifyStripeSignature("t=abc,v1=", body, WHSEC)).toThrow(SignatureError);
    // meerdere v1's (sleutelrotatie): één geldige volstaat
    const two = `t=${t},v1=${"0".repeat(64)},v1=${stripeSignatureHeader(WHSEC, body, t).split("v1=")[1]}`;
    expect(() => verifyStripeSignature(two, body, WHSEC)).not.toThrow();
  });
});

describe("pakketten (admin)", () => {
  it("alleen admins; validatie van type, templates, poorten en nodes", async () => {
    await expect(alice.api.admin.plans.list()).rejects.toThrow(/NOT_ADMIN/);
    await expect(alice.api.admin.plans.create(gamePlan())).rejects.toThrow(/NOT_ADMIN/);
    await expect(admin.api.admin.plans.create(gamePlan({ allocations: 0 }))).rejects.toThrow(/PLAN_INVALID: allocations/);
    await expect(admin.api.admin.plans.create(gamePlan({ templateIds: [webId] }))).rejects.toThrow(/PLAN_INVALID: templateIds/);
    await expect(admin.api.admin.plans.create(gamePlan({ templateIds: [9999] }))).rejects.toThrow(/PLAN_INVALID: templateIds/);
    await expect(admin.api.admin.plans.create(gamePlan({ nodeIds: [9999] }))).rejects.toThrow(/PLAN_INVALID: nodeIds/);
    await expect(admin.api.admin.plans.create(gamePlan({ type: "web", templateIds: [webId], allocations: 1 }))).rejects.toThrow(/PLAN_INVALID: allocations/);
    await expect(admin.api.admin.plans.create(gamePlan({ currency: "eur" }))).rejects.toThrow();
    await expect(admin.api.admin.plans.create(gamePlan({ ramMb: 10 }))).rejects.toThrow();
    const p = await admin.api.admin.plans.create(gamePlan());
    expect(p).toMatchObject({ name: "Starter", templates: [{ id: gameId, name: "Testspel" }], activeSubscriptions: 0 });
    const web = await admin.api.admin.plans.create(gamePlan({ name: "Site", type: "web", templateIds: [webId], allocations: 0, priceCents: 0, sortOrder: 2, ramMb: 128, diskMb: 256, cpuPct: 50 }));
    await admin.api.admin.plans.create(gamePlan({ name: "Verborgen", visible: false, sortOrder: 1 }));
    const u = await admin.api.admin.plans.update({ ...gamePlan({ description: "Nieuw" }), id: p.id });
    expect(u.description).toBe("Nieuw");
    expect((await admin.api.admin.plans.list()).map((x) => x.name)).toEqual(["Starter", "Verborgen", "Site"]);
    expect(web.type).toBe("web");
  });
});

describe("zonder facturatie", () => {
  it("pakketten uit: geen lijst en geen aanmaken", async () => {
    expect(await alice.api.billing.plans()).toEqual([]);
    expect(await alice.api.billing.status()).toMatchObject({ plansEnabled: false, canSubscribe: false, billingEnabled: false, hasSubscriptions: false });
    const [p] = await admin.api.admin.plans.list();
    await expect(alice.api.billing.subscribe({ planId: p!.id, name: "x", templateId: gameId })).rejects.toThrow(/PLANS_DISABLED/);
  });

  it("pakketten aan zonder zelf kiezen: zichtbaar, maar aanmaken geweigerd", async () => {
    await admin.api.admin.billing.update({ plansEnabled: true });
    expect((await alice.api.billing.plans()).map((p) => p.name)).toEqual(["Starter", "Site"]);
    expect((await alice.api.billing.status()).canSubscribe).toBe(false);
    const [p] = await alice.api.billing.plans();
    await expect(alice.api.billing.subscribe({ planId: p!.id, name: "x", templateId: gameId })).rejects.toThrow(/SELF_SERVICE_DISABLED/);
  });

  it("gratis zelf kiezen: server met pakketlimieten, poorten, geen factuur", async () => {
    await admin.api.admin.billing.update({ freeSelfService: true });
    const [p] = await alice.api.billing.plans();
    await expect(alice.api.billing.subscribe({ planId: p!.id, name: "x", templateId: webId })).rejects.toThrow(/TEMPLATE_NOT_ALLOWED/);
    const hidden = (await admin.api.admin.plans.list()).find((x) => !x.visible)!;
    await expect(alice.api.billing.subscribe({ planId: hidden.id, name: "x", templateId: gameId })).rejects.toThrow(/PLAN_NOT_FOUND/);
    await expect(alice.api.billing.subscribe({ planId: p!.id, name: "x", templateId: gameId, variables: { SECRET_FLAG: "on" } })).rejects.toThrow(/INVALID_VARIABLES/);
    const r = await alice.api.billing.subscribe({ planId: p!.id, name: "Gratis", templateId: gameId });
    expect(r.checkoutUrl).toBeNull();
    expect(r.subscription).toMatchObject({ status: "active", free: true, server: { name: "Gratis" }, plan: { id: p!.id } });
    const srv = (await serverRow(r.serverUuid))!;
    expect(srv).toMatchObject({ ownerId: alice.id, ramMb: 1024, cpuPct: 100, diskMb: 2048, swapMb: 0, suspendedAt: null });
    const spec = h.daemon.servers.get(r.serverUuid)!.spec;
    expect(spec.limits).toMatchObject({ memory_mb: 1024, disk_mb: 2048, cpu_pct: 100 });
    expect(spec.allocations).toHaveLength(2);
    expect(spec.start_on_install).toBe(true);
    expect(await invoicesOf(r.subscription.id)).toEqual([]);
    expect((await alice.api.billing.subscriptions()).map((s) => s.id)).toEqual([r.subscription.id]);
    expect((await alice.api.billing.status()).hasSubscriptions).toBe(true);
    // telt niet mee voor een quotum; eigen limieten wijzigen kan niet
    await admin.api.admin.users.setQuota({ id: alice.id, maxRamMb: 100, maxDiskMb: 100, maxCpuPct: 100, maxServers: 1, maxDatabases: 0, templateIds: null, nodeIds: null, maxPortsPerServer: 1 });
    expect((await alice.api.account.quota())!.usage).toMatchObject({ ramMb: 0, servers: 0 });
    await expect(alice.api.servers.updateOwnLimits({ uuid: r.serverUuid, limits: { ramMb: 512, diskMb: 512, cpuPct: 50 } })).rejects.toThrow(/PLAN_SERVER/);
    await admin.api.admin.users.clearQuota({ id: alice.id });
  });

  it("pakketlimieten voor databases en backups", async () => {
    const [sub] = await alice.api.billing.subscriptions();
    const srv = (await serverRow(sub!.server!.uuid))!;
    const [host] = await getDb().select().from(schema.databaseHosts);
    const ins = (name: string) => (tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]) =>
      tx.insert(schema.databases).values({ serverId: srv.id, hostId: host!.id, name, username: name, passwordEnc: "x" }).returning().then((r) => r[0]!);
    await reserveDatabase(alice.id, ins("plan_db1"), srv.id);
    await expect(reserveDatabase(alice.id, ins("plan_db2"), srv.id)).rejects.toThrow(/PLAN_LIMIT: databases/);
    await assertPlanBackupRoom(srv.id);
    await getDb().insert(schema.backups).values([{ serverId: srv.id, name: "a", s3Key: "a", status: "completed" }, { serverId: srv.id, name: "b", s3Key: "b", status: "failed" }]);
    await assertPlanBackupRoom(srv.id);
    await getDb().insert(schema.backups).values({ serverId: srv.id, name: "c", s3Key: "c", status: "completed" });
    await expect(assertPlanBackupRoom(srv.id)).rejects.toThrow(/PLAN_LIMIT: backups/);
    await expect(alice.api.backups.create({ uuid: srv.uuid })).rejects.toThrow(/PLAN_LIMIT: backups/);
    await getDb().delete(schema.backups).where(eq(schema.backups.serverId, srv.id));
    await getDb().delete(schema.databases).where(eq(schema.databases.serverId, srv.id));
  });

  it("admin kent een pakket gratis toe (ook verborgen pakketten); gebruiker zegt op en verwijdert", async () => {
    const hidden = (await admin.api.admin.plans.list()).find((x) => !x.visible)!;
    await expect(alice.api.admin.subscriptions.grant({ userId: bob.id, planId: hidden.id, name: "x", templateId: gameId })).rejects.toThrow(/NOT_ADMIN/);
    const r = await admin.api.admin.subscriptions.grant({ userId: bob.id, planId: hidden.id, name: "Cadeau", templateId: gameId, variables: { SECRET_FLAG: "on" } });
    expect(r.subscription).toMatchObject({ free: true, status: "active", user: { id: bob.id } });
    expect((await serverRow(r.serverUuid))!.ownerId).toBe(bob.id);
    await expect(alice.api.billing.cancel({ id: r.subscription.id })).rejects.toThrow(/SUBSCRIPTION_NOT_FOUND/);
    await expect(bob.api.billing.cancel({ id: r.subscription.id, deleteServer: true, confirmName: "fout" })).rejects.toThrow(/NAME_MISMATCH/);
    const c = await bob.api.billing.cancel({ id: r.subscription.id, deleteServer: true, confirmName: "Cadeau" });
    expect(c).toMatchObject({ status: "canceled", server: null });
    expect(await serverRow(r.serverUuid)).toBeUndefined();
    expect(h.daemon.servers.has(r.serverUuid)).toBe(false);
    await expect(admin.api.admin.plans.delete({ id: hidden.id })).rejects.toThrow(/PLAN_IN_USE/);
  });
});

describe("node-keuze", () => {
  it("kiest een node met genoeg RAM, disk en vrije poorten; anders NO_CAPACITY", async () => {
    const db = getDb();
    const [n2] = await db.insert(schema.nodes).values({ name: "groot", fqdn: "node2.test", tokenHash: "groot", maxRamMb: 8192, maxDiskMb: 100_000 }).returning();
    const [n3] = await db.insert(schema.nodes).values({ name: "vol", fqdn: "node3.test", tokenHash: "vol", maxRamMb: 512, maxDiskMb: 100_000 }).returning();
    const [n4] = await db.insert(schema.nodes).values({ name: "geenweb", fqdn: "node4.test", tokenHash: "geenweb", supportsDomains: false }).returning();
    for (const n of [n2!, n3!, n4!]) await db.insert(schema.allocations).values([{ nodeId: n.id, ip: "127.0.0.2", port: 40000 }, { nodeId: n.id, ip: "127.0.0.2", port: 40001 }]);
    const pick = (plan: Parameters<typeof pickNode>[1]) =>
      db
        .transaction(async (tx) => {
          const c = await pickNode(tx, plan);
          throw Object.assign(new Error("rollback"), { c });
        })
        .catch((e: Error & { c?: Awaited<ReturnType<typeof pickNode>> }) => {
          if (!e.c) throw e;
          return e.c;
        });
    const base = { type: "game" as const, ramMb: 1024, diskMb: 1024, allocations: 2 };
    // Alleen n2 en n3 toegestaan; n3 heeft te weinig RAM.
    expect((await pick({ ...base, nodeIds: [n2!.id, n3!.id] })).node.id).toBe(n2!.id);
    expect((await pick({ ...base, nodeIds: [n2!.id, n3!.id] })).allocations.map((a) => a.port)).toEqual([40000, 40001]);
    await expect(pick({ ...base, nodeIds: [n3!.id] })).rejects.toThrow(/NO_CAPACITY/);
    // Te veel poorten gevraagd.
    await expect(pick({ ...base, allocations: 3, nodeIds: [n2!.id, n4!.id] })).rejects.toThrow(/NO_CAPACITY/);
    // Websites niet op nodes zonder domeinen.
    await expect(pick({ type: "web", ramMb: 64, diskMb: 64, allocations: 0, nodeIds: [n4!.id] })).rejects.toThrow(/NO_CAPACITY/);
    // Bestaande servers tellen mee voor de capaciteit.
    await db.insert(schema.servers).values({ name: "bezet", ownerId: bob.id, nodeId: n2!.id, templateId: gameId, type: "game", cpuPct: 100, ramMb: 7600, diskMb: 1000, status: "offline" });
    await expect(pick({ ...base, nodeIds: [n2!.id, n3!.id] })).rejects.toThrow(/NO_CAPACITY/);
    // Zonder nodelijst: de lokale node (onbeperkt) gaat voor.
    expect((await pick({ ...base, nodeIds: null })).node.id).toBe(h.localNodeId);
    // Opruimen: de testnodes verstoren de rest niet (lokale node blijft onbeperkt eerst).
    await db.delete(schema.servers).where(eq(schema.servers.name, "bezet"));
    await db.delete(schema.nodes).where(inArray(schema.nodes.id, [n2!.id, n3!.id, n4!.id]));
  });

  it("subscribe zonder capaciteit → NO_CAPACITY en niets aangemaakt", async () => {
    await getDb().update(schema.nodes).set({ maxRamMb: 100 }).where(eq(schema.nodes.id, h.localNodeId));
    const [p] = await alice.api.billing.plans();
    const before = (await getDb().select().from(schema.servers)).length;
    await expect(alice.api.billing.subscribe({ planId: p!.id, name: "Te groot", templateId: gameId })).rejects.toThrow(/NO_CAPACITY/);
    expect((await getDb().select().from(schema.servers)).length).toBe(before);
    await getDb().update(schema.nodes).set({ maxRamMb: 0 }).where(eq(schema.nodes.id, h.localNodeId));
  });

  it("parallelle aanmeldingen delen poorten nooit dubbel", async () => {
    const [p] = await alice.api.billing.plans();
    const rs = await Promise.allSettled([1, 2, 3].map((i) => bob.api.billing.subscribe({ planId: p!.id, name: `P${i}`, templateId: gameId })));
    const ok = rs.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ serverUuid: string }>).value);
    expect(ok.length).toBeGreaterThan(0);
    const ports = (await getDb().select().from(schema.allocations).where(eq(schema.allocations.nodeId, h.localNodeId))).filter((a) => a.serverId !== null).map((a) => a.port);
    expect(new Set(ports).size).toBe(ports.length);
    for (const s of await bob.api.billing.subscriptions()) if (s.status === "active" && s.server) await bob.api.billing.cancel({ id: s.id, deleteServer: true, confirmName: s.server.name });
  });
});

describe("facturatie-instellingen", () => {
  it("aanzetten vereist een provider; sleutels versleuteld en alleen als hint terug", async () => {
    await expect(alice.api.admin.billing.get()).rejects.toThrow(/NOT_ADMIN/);
    await expect(admin.api.admin.billing.update({ billingEnabled: true })).rejects.toThrow(/BILLING_PROVIDER_NOT_CONFIGURED/);
    await expect(admin.api.admin.billing.update({ billingEnabled: true, provider: "stripe", stripeSecretKey: "sk_test_abcdefghijkl" })).rejects.toThrow(/BILLING_PROVIDER_NOT_CONFIGURED/);
    await expect(admin.api.admin.billing.update({ suspendAfterDays: 10, deleteAfterDays: 5 })).rejects.toThrow(/DELETE_BEFORE_SUSPEND/);
    const s = await admin.api.admin.billing.update({ billingEnabled: true, provider: "stripe", stripeSecretKey: "sk_test_abcdefghijkl", stripeWebhookSecret: WHSEC, issuer: { name: "Blokgenoten", address: "Straat 1\nUtrecht", email: "billing@panel.test", vatId: "", footer: "Dank!" } });
    expect(s).toMatchObject({ billingEnabled: true, provider: "stripe", stripe: { secretKey: { set: true, hint: "…ijkl" }, webhookSecret: { set: true } }, mollie: { apiKey: { set: false } } });
    expect(s.webhookUrls.stripe).toBe("http://127.0.0.1:3999/api/billing/stripe");
    expect(JSON.stringify(s)).not.toContain("sk_test_abcdefghijkl");
    const rows = await getDb().select().from(schema.settings).where(like(schema.settings.key, "billing_%_enc"));
    expect(rows.map((r) => r.key).sort()).toEqual(["billing_stripe_secret_key_enc", "billing_stripe_webhook_secret_enc"]);
    for (const r of rows) {
      expect(String(r.value)).toMatch(/^v1:/);
      expect(String(r.value)).not.toContain("sk_test");
    }
    expect(await alice.api.billing.status()).toMatchObject({ billingEnabled: true, canSubscribe: true });
  });
});

describe("betaalde cyclus (Stripe, nepklok)", () => {
  let subId = 0, uuid = "", firstInvoice = 0;

  it("aanmelden: checkout-URL, abonnement pending, server opgeschort tot betaald", async () => {
    at(new Date("2026-12-01T10:00:00Z"));
    const [p] = await alice.api.billing.plans();
    const r = await alice.api.billing.subscribe({ planId: p!.id, name: "Betaald", templateId: gameId });
    subId = r.subscription.id;
    uuid = r.serverUuid;
    expect(r.checkoutUrl).toBe(`https://checkout.stripe.test/c/${fake.last().id}`);
    expect(fake.last()).toMatchObject({ provider: "stripe", amount: "500", currency: "eur", auth: "Bearer sk_test_abcdefghijkl" });
    expect(r.subscription.status).toBe("pending");
    const [inv] = await invoicesOf(subId);
    firstInvoice = inv!.id;
    expect(inv).toMatchObject({ status: "open", amountCents: 500, currency: "EUR", number: "INV-2026-0001", customerName: "alice" });
    expect(fake.last().invoiceId).toBe(inv!.id);
    expect((await serverRow(uuid))!.suspendedReason).toBe("BILLING_UNPAID");
    expect(h.daemon.servers.get(uuid)!.spec.start_on_install).toBe(false);
    // installatie klaar
    h.daemon.servers.get(uuid)!.state = "offline";
    await getDb().update(schema.servers).set({ status: "offline" }).where(eq(schema.servers.uuid, uuid));
    await expect(alice.api.servers.power({ uuid, action: "start" })).rejects.toThrow(/SUSPENDED_BILLING_UNPAID/);
  });

  it("webhook met ongeldige of ontbrekende signature wordt geweigerd", async () => {
    const body = stripeEvent(firstInvoice);
    expect((await stripeHook(body, stripeSignatureHeader("whsec_wrong_secret_123", body))).status).toBe(400);
    expect((await stripeHook(body, null)).status).toBe(400);
    expect((await stripeHook(body, stripeSignatureHeader(WHSEC, body, Math.floor(Date.now() / 1000) - 1000))).status).toBe(400);
    expect((await stripeHook(body, stripeSignatureHeader(WHSEC, `${body}x`))).status).toBe(400);
    const [inv] = await invoicesOf(subId);
    expect(inv!.status).toBe("open");
    expect((await subRow(subId)).status).toBe("pending");
  });

  it("geldige webhook: betaald, periode start, server vrij en gestart; dubbel event doet niets", async () => {
    at(new Date("2026-12-01T10:05:00Z"));
    // Een event zonder betaling (bv. een ander type) verandert niets.
    const unpaid = stripeEvent(firstInvoice, { paid: false });
    expect((await stripeHook(unpaid, stripeSignatureHeader(WHSEC, unpaid))).status).toBe(200);
    expect((await invoicesOf(subId))[0]!.status).toBe("open");
    const body = stripeEvent(firstInvoice, { id: "evt_first" });
    const res = await stripeHook(body, stripeSignatureHeader(WHSEC, body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    const [inv] = await invoicesOf(subId);
    expect(inv).toMatchObject({ status: "paid", provider: "stripe" });
    expect(inv!.periodStart!.toISOString()).toBe("2026-12-01T10:05:00.000Z");
    expect(inv!.periodEnd!.toISOString()).toBe("2027-01-01T10:05:00.000Z");
    const s = await subRow(subId);
    expect(s).toMatchObject({ status: "active", anchorDay: 1 });
    expect(s.currentPeriodEnd!.toISOString()).toBe("2027-01-01T10:05:00.000Z");
    expect((await serverRow(uuid))!.suspendedAt).toBeNull();
    expect(h.daemon.requests.some((r) => r.method === "POST" && r.path === `/api/servers/${uuid}/power` && (r.body as { action?: string })?.action === "start")).toBe(true);
    const again = await stripeHook(body, stripeSignatureHeader(WHSEC, body));
    expect(await again.text()).toBe("duplicate");
  });

  it("verlenging: nieuwe factuur aan het einde van de periode, één keer", async () => {
    at(new Date("2026-12-20T00:00:00Z"));
    expect((await billingTick()).invoiced).toBe(0);
    at(new Date("2027-01-01T10:05:00Z"));
    const t = await billingTick();
    expect(t.invoiced).toBe(1);
    expect((await billingTick()).invoiced).toBe(0);
    const invs = await invoicesOf(subId);
    expect(invs).toHaveLength(2);
    expect(invs[1]).toMatchObject({ number: "INV-2027-0001", status: "overdue", amountCents: 500 });
    expect(invs[1]!.periodEnd!.toISOString()).toBe("2027-02-01T10:05:00.000Z");
    const s = await subRow(subId);
    expect(s.status).toBe("past_due");
    expect(s.pastDueSince!.toISOString()).toBe("2027-01-01T10:05:00.000Z");
    // server draait nog
    expect((await serverRow(uuid))!.suspendedAt).toBeNull();
    const list = await alice.api.billing.invoices({});
    expect(list.items.map((i) => i.status)).toEqual(["overdue", "paid"]);
  });

  it("na X dagen achterstand: gestopt en opgeschort met duidelijke melding", async () => {
    at(new Date("2027-01-07T10:00:00Z"));
    expect((await billingTick()).suspended).toBe(0);
    h.daemon.servers.get(uuid)!.state = "online";
    at(new Date("2027-01-08T10:06:00Z"));
    expect((await billingTick()).suspended).toBe(1);
    expect((await subRow(subId)).status).toBe("suspended");
    const srv = (await serverRow(uuid))!;
    expect(srv.suspendedReason).toBe("BILLING_OVERDUE");
    expect(h.daemon.servers.get(uuid)!.state).toBe("offline");
    await expect(alice.api.servers.power({ uuid, action: "start" })).rejects.toThrow(/SUSPENDED_BILLING_OVERDUE/);
    // admin-opschorting wordt niet overschreven door de facturatie (los getest hieronder); admins kunnen nog starten
    expect((await billingTick()).suspended).toBe(0);
  });

  it("betalen via pay + webhook heft de opschorting op", async () => {
    const [, inv] = await invoicesOf(subId);
    await expect(bob.api.billing.pay({ invoiceId: inv!.id })).rejects.toThrow(/INVOICE_NOT_FOUND/);
    const { url } = await alice.api.billing.pay({ invoiceId: inv!.id });
    expect(url).toContain("checkout.stripe.test");
    const body = stripeEvent(inv!.id);
    expect((await stripeHook(body, stripeSignatureHeader(WHSEC, body))).status).toBe(200);
    const s = await subRow(subId);
    expect(s).toMatchObject({ status: "active", pastDueSince: null });
    expect((await serverRow(uuid))!.suspendedAt).toBeNull();
    await expect(alice.api.billing.pay({ invoiceId: inv!.id })).rejects.toThrow(/INVOICE_NOT_OPEN/);
  });

  it("factuur bekijken: eigen of admin; anderen niet", async () => {
    const d = await alice.api.billing.invoice({ id: firstInvoice });
    expect(d).toMatchObject({ number: "INV-2026-0001", issuer: { name: "Blokgenoten" }, customer: { name: "alice" }, lines: [{ quantity: 1, unitCents: 500, totalCents: 500 }], canPay: false });
    await expect(bob.api.billing.invoice({ id: firstInvoice })).rejects.toThrow(/INVOICE_NOT_FOUND/);
    expect((await admin.api.billing.invoice({ id: firstInvoice })).number).toBe("INV-2026-0001");
    expect((await admin.api.admin.invoices.list({ userId: alice.id })).items).toHaveLength(2);
    await expect(alice.api.admin.invoices.list({})).rejects.toThrow(/NOT_ADMIN/);
  });

  it("opzeggen en weer verlengen; na de periode beëindigd, opgeschort en na Y dagen verwijderd", async () => {
    await expect(bob.api.billing.cancel({ id: subId })).rejects.toThrow(/SUBSCRIPTION_NOT_FOUND/);
    expect((await alice.api.billing.cancel({ id: subId })).cancelAtPeriodEnd).toBe(true);
    expect((await alice.api.billing.resume({ id: subId })).cancelAtPeriodEnd).toBe(false);
    await alice.api.billing.cancel({ id: subId });
    await admin.api.admin.billing.update({ deleteAfterDays: 10 });
    at(new Date("2027-02-01T10:06:00Z"));
    const t = await billingTick();
    expect(t).toMatchObject({ invoiced: 0, ended: 1 });
    const s = await subRow(subId);
    expect(s.status).toBe("canceled");
    expect(s.canceledAt!.toISOString()).toBe("2027-02-01T10:05:00.000Z");
    expect((await serverRow(uuid))!.suspendedReason).toBe("SUBSCRIPTION_ENDED");
    await expect(alice.api.billing.resume({ id: subId })).rejects.toThrow(/SUBSCRIPTION_ENDED/);
    at(new Date("2027-02-10T10:00:00Z"));
    expect((await billingTick()).deleted).toBe(0);
    at(new Date("2027-02-11T10:06:00Z"));
    expect((await billingTick()).deleted).toBe(1);
    expect(await serverRow(uuid)).toBeUndefined();
    expect(h.daemon.servers.has(uuid)).toBe(false);
    await admin.api.admin.billing.update({ deleteAfterDays: null });
  });

  it("nooit betaald: na de betaaltermijn opgeruimd, factuur vervallen", async () => {
    at(new Date("2027-03-01T08:00:00Z"));
    const [p] = await alice.api.billing.plans();
    const r = await alice.api.billing.subscribe({ planId: p!.id, name: "Vergeten", templateId: gameId });
    at(new Date("2027-03-02T08:00:00Z"));
    expect((await billingTick()).ended).toBe(0);
    at(new Date("2027-03-03T08:00:01Z"));
    expect((await billingTick()).ended).toBe(1);
    expect((await subRow(r.subscription.id)).status).toBe("canceled");
    expect((await invoicesOf(r.subscription.id))[0]!.status).toBe("void");
    expect(await serverRow(r.serverUuid)).toBeUndefined();
  });

  it("admin: handmatig betaald en vervallen; admin-opschorting blijft staan", async () => {
    at(new Date("2027-04-01T08:00:00Z"));
    const [p] = await bob.api.billing.plans();
    const r = await bob.api.billing.subscribe({ planId: p!.id, name: "Bobs", templateId: gameId });
    const [inv] = await invoicesOf(r.subscription.id);
    const paid = await admin.api.admin.invoices.markPaid({ id: inv!.id });
    expect(paid).toMatchObject({ status: "paid", provider: "manual" });
    await expect(admin.api.admin.invoices.markPaid({ id: inv!.id })).rejects.toThrow(/INVOICE_NOT_OPEN/);
    await expect(admin.api.admin.invoices.void({ id: inv!.id })).rejects.toThrow(/INVOICE_NOT_OPEN/);
    expect((await subRow(r.subscription.id)).status).toBe("active");
    // Admin schort zelf op; de volgende factuur wordt betaald, maar de admin-opschorting blijft.
    await admin.api.admin.servers.setSuspended({ uuid: r.serverUuid, suspended: true, reason: "misbruik" });
    at(new Date("2027-05-01T08:00:01Z"));
    await billingTick();
    const [, inv2] = await invoicesOf(r.subscription.id);
    expect(inv2!.status).toBe("overdue");
    const v = await admin.api.admin.invoices.void({ id: inv2!.id });
    expect(v.status).toBe("void");
    expect((await subRow(r.subscription.id)).status).toBe("active");
    expect((await serverRow(r.serverUuid))!.suspendedReason).toBe("misbruik");
    const subs = await admin.api.admin.subscriptions.list({ userId: bob.id, status: "active" });
    expect(subs.items.map((s) => s.id)).toContain(r.subscription.id);
    await admin.api.admin.subscriptions.cancel({ id: r.subscription.id, deleteServer: true });
    expect(await serverRow(r.serverUuid)).toBeUndefined();
  });

  it("server door de eigenaar verwijderd: abonnement beëindigd, geen nieuwe facturen", async () => {
    at(new Date("2027-06-01T08:00:00Z"));
    const [p] = await bob.api.billing.plans();
    const r = await bob.api.billing.subscribe({ planId: p!.id, name: "Weg", templateId: gameId });
    await admin.api.admin.invoices.markPaid({ id: (await invoicesOf(r.subscription.id))[0]!.id });
    await bob.api.servers.deleteOwn({ uuid: r.serverUuid, confirmName: "Weg" });
    at(new Date("2027-07-02T08:00:00Z"));
    const t = await billingTick();
    expect(t.ended).toBeGreaterThanOrEqual(1);
    expect((await subRow(r.subscription.id)).status).toBe("canceled");
    expect(await invoicesOf(r.subscription.id)).toHaveLength(1);
  });
});

describe("Mollie", () => {
  it("payment met webhook-token; ongeldig token geweigerd; alleen 'paid' bij Mollie telt", async () => {
    await admin.api.admin.billing.update({ provider: "mollie", mollieApiKey: "test_mollieabcdefghij" });
    at(new Date("2027-08-01T08:00:00Z"));
    const [p] = await alice.api.billing.plans();
    const r = await alice.api.billing.subscribe({ planId: p!.id, name: "Mollie", templateId: gameId });
    const c = fake.last();
    expect(r.checkoutUrl).toBe(`https://mollie.test/checkout/${c.id}`);
    expect(c).toMatchObject({ provider: "mollie", amount: "5.00", currency: "EUR", auth: "Bearer test_mollieabcdefghij" });
    const [inv] = await invoicesOf(r.subscription.id);
    const hook = new URL(c.webhookUrl!);
    expect(hook.pathname).toBe("/api/billing/mollie");
    expect(hook.searchParams.get("invoice")).toBe(String(inv!.id));
    expect(hook.searchParams.get("token")).toBe(mollieWebhookToken(inv!.id));
    // ongeldig token / andere factuur / onbekende payment
    expect((await mollieHook(`invoice=${inv!.id}&token=fout`, c.id)).status).toBe(400);
    expect((await mollieHook(`invoice=${inv!.id + 1}&token=${mollieWebhookToken(inv!.id + 1)}`, c.id)).status).toBe(400);
    expect((await mollieHook(`invoice=${inv!.id}&token=${mollieWebhookToken(inv!.id)}`, "tr_onbekend")).status).toBe(400);
    // nog niet betaald
    expect((await mollieHook(hook.search.slice(1), c.id)).status).toBe(200);
    expect((await invoicesOf(r.subscription.id))[0]!.status).toBe("open");
    fake.molliePaid(c.id);
    expect((await mollieHook(hook.search.slice(1), c.id)).status).toBe(200);
    expect((await invoicesOf(r.subscription.id))[0]).toMatchObject({ status: "paid", provider: "mollie", providerPaymentId: c.id });
    expect((await serverRow(r.serverUuid))!.suspendedAt).toBeNull();
  });

  it("provider tijdelijk stuk: subscribe lukt zonder checkout-URL, pay geeft PAYMENT_PROVIDER_ERROR", async () => {
    const [p] = await alice.api.billing.plans();
    fake.failNext = 500;
    const r = await alice.api.billing.subscribe({ planId: p!.id, name: "Later", templateId: gameId });
    expect(r.checkoutUrl).toBeNull();
    const [inv] = await invoicesOf(r.subscription.id);
    fake.failNext = 500;
    await expect(alice.api.billing.pay({ invoiceId: inv!.id })).rejects.toThrow(/PAYMENT_PROVIDER_ERROR/);
    expect((await alice.api.billing.pay({ invoiceId: inv!.id })).url).toContain("mollie.test");
    // gebruiker zegt een nooit betaald abonnement op: meteen weg
    const c = await alice.api.billing.cancel({ id: r.subscription.id });
    expect(c.status).toBe("canceled");
    expect(await serverRow(r.serverUuid)).toBeUndefined();
  });

  it("webhook van een niet-ingestelde provider → 404", async () => {
    await getDb().delete(schema.settings).where(eq(schema.settings.key, "billing_stripe_webhook_secret_enc"));
    const body = stripeEvent(1);
    expect((await stripeHook(body, stripeSignatureHeader(WHSEC, body))).status).toBe(404);
    const ev = await getDb().select().from(schema.billingEvents).where(and(eq(schema.billingEvents.provider, "stripe"), eq(schema.billingEvents.eventId, "evt_first")));
    expect(ev).toHaveLength(1);
  });
});
