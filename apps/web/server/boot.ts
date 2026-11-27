/**
 * Opstarttaken van het panel, aangeroepen vanuit instrumentation.ts. Eigenaar: panel-api.
 * Idempotent: veilig om bij elke start (en meerdere keren per proces) te draaien.
 *
 * 1. env valideren (test-login op een echt domein → weigeren te starten)
 * 2. migraties
 * 3. OWNER_DISCORD_ID in admin_discord_ids
 * 4. lokale node upserten (is_local, fqdn = NODE_DOMAIN, token_hash = sha256(NODE_TOKEN), poorten)
 * 4b. lokale MariaDB als database-host `local` (als MARIADB_ROOT_PASSWORD gezet is)
 * 5. standaardinstellingen
 * 6. Ed25519-sleutelpaar voor browser-JWT's
 * 7. templates uit TEMPLATES_DIR
 */
import { runMigrations } from "@panel/db/migrate";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { EnvError, getEnv } from "./env";
import { encrypt, sha256 } from "./lib/crypto";
import { ensureSigningKey } from "./lib/jwt";
import { startBot } from "./bot/gateway";
import { startScheduler } from "./scheduler";
import { ensureSettingDefaults } from "./settings";
import { loadTemplatesFromDir } from "./templates";

const g = globalThis as unknown as { __panelBoot?: Promise<void> };

export async function upsertLocalNode(): Promise<number> {
  const env = getEnv();
  const db = getDb();
  const values = {
    fqdn: env.NODE_DOMAIN,
    tokenHash: sha256(env.NODE_TOKEN),
    daemonPort: env.DAEMON_PORT,
    sftpPort: env.SFTP_PORT,
  };
  return db.transaction(async (tx) => {
    const [local] = await tx.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.isLocal, true)).for("update");
    if (local) {
      await tx.update(schema.nodes).set(values).where(eq(schema.nodes.id, local.id));
      return local.id;
    }
    const name = env.NODE_DOMAIN.split(".")[0] || "local";
    const [row] = await tx
      .insert(schema.nodes)
      .values({ ...values, name, isLocal: true })
      .onConflictDoUpdate({ target: schema.nodes.isLocal, targetWhere: eq(schema.nodes.isLocal, true), set: values })
      .returning({ id: schema.nodes.id });
    return row!.id;
  });
}

/** Lokale MariaDB als database-host `local` (host = MARIADB_CONTAINER, zoals sites hem zien), als die er nog niet is. */
export async function ensureLocalDatabaseHost(nodeId: number): Promise<void> {
  const env = getEnv();
  if (!env.MARIADB_ROOT_PASSWORD) return;
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242001)`);
    const [have] = await tx.select({ id: schema.databaseHosts.id }).from(schema.databaseHosts).where(eq(schema.databaseHosts.name, "local"));
    if (have) return;
    await tx.insert(schema.databaseHosts).values({ name: "local", host: env.MARIADB_CONTAINER, port: 3306, adminUser: "root", adminPasswordEnc: encrypt(env.MARIADB_ROOT_PASSWORD!), nodeId });
  });
}

async function runBoot(): Promise<void> {
  const env = getEnv();
  await runMigrations(env.DATABASE_URL);
  const db = getDb();
  await db.insert(schema.adminDiscordIds).values({ discordId: env.OWNER_DISCORD_ID }).onConflictDoNothing();
  const localNodeId = await upsertLocalNode();
  await ensureLocalDatabaseHost(localNodeId);
  await ensureSettingDefaults();
  await ensureSigningKey();
  const t = await loadTemplatesFromDir(env.TEMPLATES_DIR);
  for (const e of t.errors) console.warn(`[boot] template overgeslagen: ${e}`);
  if (t.inserted.length || t.updated.length) console.info(`[boot] templates nieuw: ${t.inserted.join(", ") || "-"}; bijgewerkt: ${t.updated.join(", ") || "-"}`);
  // Tests starten de tikker zelf (tick()); in het echte proces draait hij op de achtergrond.
  if (!process.env.VITEST) {
    startScheduler();
    startBot(env.DISCORD_BOT_TOKEN); // optioneel; zonder token of bij een fout blijft het panel gewoon draaien
  }
  if (env.PANEL_INSECURE_TEST_LOGIN) console.warn("[boot] PANEL_INSECURE_TEST_LOGIN is enabled (tests only)");
}

export async function boot(): Promise<void> {
  try {
    await ensureBooted();
  } catch (e) {
    // Onder Next: niet half opstarten met een foute configuratie.
    if (process.env.NEXT_RUNTIME === "nodejs" && e instanceof EnvError) {
      console.error(`[boot] ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

/** Draait boot één keer per proces; latere aanroepen wachten op dezelfde belofte. */
export function ensureBooted(): Promise<void> {
  g.__panelBoot ??= runBoot().catch((e) => {
    g.__panelBoot = undefined; // volgende aanroep probeert opnieuw
    throw e;
  });
  return g.__panelBoot;
}

/** Alleen voor tests. */
export function resetBoot(): void {
  g.__panelBoot = undefined;
}
