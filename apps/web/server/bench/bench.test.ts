/**
 * Benchmark (alleen met BENCH=1): tijden van de hoofdaanroepen tegen nep-daemons die traag
 * antwoorden of niet reageren. Draaien: `BENCH=1 pnpm --filter @panel/web exec vitest run server/bench`.
 * Voor het cachemodel (`server/node-cache.ts`) wordt eerst één poll gedaan, zoals de monitor dat doet.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, it } from "vitest";
import { getDb, schema } from "../db";
import { daemonUrlOverrides } from "../daemon";
import { encrypt } from "../lib/crypto";
import { OWNER, useHarness } from "../test/harness";
import { FakeDaemon } from "../test/fake-daemon";
import { warmNodeCache } from "../test/warm";

const h = useHarness();
const SERVERS = Number(process.env.BENCH_SERVERS ?? 120);
let nodeIds: number[] = [];
let slow: FakeDaemon, dead: FakeDaemon;
let admin: Awaited<ReturnType<typeof h.user>>;
let sampleUuid = "";

beforeAll(async () => {
  admin = await h.user({ discordId: OWNER, name: "eigenaar", admin: true, totp: true });
  slow = new FakeDaemon("tok-slow");
  dead = new FakeDaemon("tok-dead");
  await slow.start();
  await dead.start();
  h.daemon.delayMs = 150;
  slow.delayMs = 800;
  dead.mode = "hang";
  const db = getDb();
  const mk = async (name: string, d: FakeDaemon, token: string) => {
    const [n] = await db.insert(schema.nodes).values({ name, fqdn: `${name}.test`, tokenHash: `hash-${name}`, tokenEnc: encrypt(token) }).returning();
    daemonUrlOverrides.set(n!.id, d.url);
    return n!.id;
  };
  nodeIds = [h.localNodeId, await mk("slow", slow, "tok-slow"), await mk("dead", dead, "tok-dead")];
  const tpl = await h.templateId("testgame");
  const rows = Array.from({ length: SERVERS }, (_, i) => ({
    uuid: randomUUID(), name: `srv-${i}`, ownerId: admin.id, nodeId: nodeIds[i % 3]!, templateId: tpl, type: "game" as const,
    cpuPct: 100, ramMb: 1024, diskMb: 1024, status: "offline" as const,
  }));
  const ins = await db.insert(schema.servers).values(rows).returning();
  sampleUuid = ins[0]!.uuid;
  for (const s of ins) {
    const d = s.nodeId === nodeIds[0] ? h.daemon : s.nodeId === nodeIds[1] ? slow : null;
    d?.servers.set(s.uuid, { spec: {} as never, state: "online", installedAt: null });
  }
  await db.insert(schema.allocations).values(ins.map((s, i) => ({ nodeId: s.nodeId, ip: "10.0.0.1", port: 20000 + i, serverId: s.id, isPrimary: true })));
  await warmNodeCache();
}, 120_000);

async function time(label: string, fn: () => Promise<unknown>, n = 5) {
  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  console.log(`BENCH ${label.padEnd(24)} min ${ts[0]!.toFixed(0).padStart(5)} ms   median ${ts[Math.floor(n / 2)]!.toFixed(0).padStart(5)} ms   max ${ts[n - 1]!.toFixed(0).padStart(5)} ms`);
}

describe.skipIf(!process.env.BENCH)("bench", () => {
  it("tijden", async () => {
    console.log(`BENCH ${SERVERS} servers, nodes: lokaal (150ms), slow (800ms), dead (hangt)`);
    await time("servers.list", () => admin.api.servers.list(), 3);
    await time("servers.get", () => admin.api.servers.get({ uuid: sampleUuid }));
    await time("admin.dashboard", () => admin.api.admin.dashboard(), 3);
    await time("admin.servers.list", () => admin.api.admin.servers.list({ limit: 50 }));
    await time("admin.nodes.list", () => admin.api.admin.nodes.list());
    await time("admin.nodes.get(dead)", () => admin.api.admin.nodes.get({ id: nodeIds[2]! }), 3);
    await time("admin.nodes.get(slow)", () => admin.api.admin.nodes.get({ id: nodeIds[1]! }), 3);
  }, 300_000);
});
