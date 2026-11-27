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

  it("EXPLAIN van de hete queries op veel data (met en zonder de nieuwe indexen)", async () => {
    const { sql } = await import("drizzle-orm");
    const db = getDb();
    const N = Number(process.env.BENCH_ROWS ?? 20000);
    const tpl = await h.templateId("testgame");
    await db.execute(sql`insert into servers (uuid, name, owner_id, node_id, template_id, type, cpu_pct, ram_mb, disk_mb, status)
      select gen_random_uuid(), 'x' || g, ${admin.id}, ${nodeIds[0]}, ${tpl}, 'game', 100, 1024, 1024, 'offline' from generate_series(1, ${N}) g`);
    await db.execute(sql`insert into allocations (node_id, ip, port, server_id, is_primary)
      select ${nodeIds[0]}, '10.1.0.1', 30000 + s.id, s.id, true from servers s where s.name like 'x%'`);
    await db.execute(sql`insert into subusers (server_id, user_id, permissions) select s.id, ${admin.id}, '{}' from servers s where s.name like 'x%' and s.id % 3 = 0`);
    await db.execute(sql`insert into domains (server_id, hostname) select s.id, 'd' || s.id || '.test' from servers s where s.name like 'x%'`);
    await db.execute(sql`analyze`);
    const queries: Record<string, ReturnType<typeof sql>> = {
      "allocations where server_id in (50 ids)": sql`select * from allocations where server_id in (select id from servers order by id desc limit 50)`,
      "subusers where user_id": sql`select server_id from subusers where user_id = ${admin.id}`,
      "domains where server_id in (50 ids)": sql`select server_id, hostname from domains where server_id in (select id from servers order by id desc limit 50)`,
      "servers where status = install_failed": sql`select uuid from servers where status = 'install_failed'`,
    };
    const run = async (label: string) => {
      for (const [name, q] of Object.entries(queries)) {
        const rows = (await db.execute(sql`explain (analyze, format json) ${q}`)) as unknown as Array<Record<string, Array<{ "Execution Time": number; Plan: { "Node Type": string } }>>>;
        const e = Object.values(rows[0]!)[0]![0]!;
        console.log(`BENCH explain ${label.padEnd(12)} ${name.padEnd(42)} ${e["Execution Time"].toFixed(2).padStart(8)} ms  ${e.Plan["Node Type"]}`);
      }
    };
    await run("met index");
    for (const i of ["allocations_server_idx", "subusers_user_idx", "domains_server_idx", "servers_status_idx"]) await db.execute(sql.raw(`drop index ${i}`));
    await run("zonder index");
  }, 300_000);
});
