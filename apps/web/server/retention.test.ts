import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { sha256 } from "./lib/crypto";
import { maybeRunRetention, retentionTuning, runRetention } from "./retention";
import { OWNER, useHarness, type TestUser } from "./test/harness";

const h = useHarness();
let admin: TestUser, user: TestUser;
const DAY = 24 * 3600_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const saved = { ...retentionTuning };

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  user = await h.user({ discordId: "310000000000000001", name: "gebruiker" });
  retentionTuning.batch = 3; // meerdere batches afdwingen
  retentionTuning.pauseMs = 0;
});
afterAll(() => Object.assign(retentionTuning, saved));

async function activity(n: number, at: Date, action: string) {
  await getDb().insert(schema.activityLog).values(Array.from({ length: n }, () => ({ action, userId: user.id, at })));
}
const countAction = async (action: string) => (await getDb().select({ id: schema.activityLog.id }).from(schema.activityLog).where(eq(schema.activityLog.action, action))).length;

describe("retentie", () => {
  it("instelling: standaard 90, aanpasbaar, 0 = altijd, alleen admin", async () => {
    expect((await admin.api.admin.settings.get()).activityRetentionDays).toBe(90);
    expect((await admin.api.admin.settings.update({ activityRetentionDays: 30 })).activityRetentionDays).toBe(30);
    await expect(admin.api.admin.settings.update({ activityRetentionDays: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(user.api.admin.settings.update({ activityRetentionDays: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await admin.api.admin.settings.get()).activityRetentionDays).toBe(30);
  });

  it("activiteitenlog: ouder dan de termijn weg (in batches), nieuwer blijft; 0 bewaart alles", async () => {
    await activity(10, ago(31), "test.retention.old");
    await activity(4, ago(29), "test.retention.recent");
    const r = await runRetention();
    expect(r.activity).toBeGreaterThanOrEqual(10);
    expect(await countAction("test.retention.old")).toBe(0);
    expect(await countAction("test.retention.recent")).toBe(4);

    await admin.api.admin.settings.update({ activityRetentionDays: 0 });
    await activity(2, ago(4000), "test.retention.ancient");
    expect((await runRetention()).activity).toBe(0);
    expect(await countAction("test.retention.ancient")).toBe(2);
    await admin.api.admin.settings.update({ activityRetentionDays: 90 });
  });

  it("maxBatches begrenst één run; de rest volgt bij de volgende", async () => {
    await admin.api.admin.settings.update({ activityRetentionDays: 1 });
    await runRetention(); // eerst alles van eerdere tests weg
    await activity(7, ago(2), "test.retention.capped");
    Object.assign(retentionTuning, { maxBatches: 1 });
    await runRetention();
    expect(await countAction("test.retention.capped")).toBe(4);
    Object.assign(retentionTuning, { maxBatches: saved.maxBatches });
    await runRetention();
    expect(await countAction("test.retention.capped")).toBe(0);
    await admin.api.admin.settings.update({ activityRetentionDays: 90 });
  });

  it("sessies: verlopen en inactieve weg, actieve blijven (de eigen sessie werkt nog)", async () => {
    const db = getDb();
    const [expired, idle, fresh] = await db
      .insert(schema.sessions)
      .values([
        { userId: user.id, tokenHash: sha256("ret-expired"), expiresAt: ago(1) },
        { userId: user.id, tokenHash: sha256("ret-idle"), expiresAt: new Date(Date.now() + 10 * DAY), lastSeenAt: ago(400) },
        { userId: user.id, tokenHash: sha256("ret-fresh"), expiresAt: new Date(Date.now() + 10 * DAY) },
      ])
      .returning({ id: schema.sessions.id });
    const r = await runRetention();
    expect(r.sessions).toBeGreaterThanOrEqual(2);
    const left = (await db.select({ id: schema.sessions.id }).from(schema.sessions).where(inArray(schema.sessions.id, [expired!.id, idle!.id, fresh!.id]))).map((x) => x.id);
    expect(left).toEqual([fresh!.id]);
    await expect(user.api.account.get()).resolves.toBeTruthy();
  });

  it("join-codes: oude verbruikte/verlopen weg, de nieuwste per node blijft", async () => {
    const db = getDb();
    const [n] = await db.insert(schema.nodes).values({ name: "ret-node", fqdn: "ret-node.test", tokenHash: sha256("ret-node-token") }).returning();
    const codes = await db
      .insert(schema.nodeJoinCodes)
      .values([
        { nodeId: n!.id, codeHash: sha256("c1"), expiresAt: ago(20), usedAt: ago(20) },
        { nodeId: n!.id, codeHash: sha256("c2"), expiresAt: ago(10) },
        { nodeId: n!.id, codeHash: sha256("c3"), expiresAt: ago(9) }, // nieuwste: blijft (join-status)
      ])
      .returning({ id: schema.nodeJoinCodes.id });
    await runRetention();
    const left = (await db.select({ id: schema.nodeJoinCodes.id }).from(schema.nodeJoinCodes).where(eq(schema.nodeJoinCodes.nodeId, n!.id))).map((x) => x.id);
    expect(left).toEqual([codes[2]!.id]);
    await db.delete(schema.nodes).where(eq(schema.nodes.id, n!.id));
  });

  it("maybeRunRetention draait hooguit eens per uur", async () => {
    const t0 = new Date();
    expect(await maybeRunRetention(t0)).not.toBeNull();
    expect(await maybeRunRetention(new Date(t0.getTime() + 60_000))).toBeNull();
    expect(await maybeRunRetention(new Date(t0.getTime() + 3600_000))).not.toBeNull();
  });
});
