/**
 * Elke node meldt zijn eigen MariaDB aan (hello.has_mariadb). Het panel houdt daarvoor een
 * `database_hosts`-rij per node bij (daemon_managed): host = MARIADB_CONTAINER (de naam waaronder sites de
 * database op elke node bereiken), poort 3306. Het panel verbindt er nooit zelf mee; alle beheer loopt via de daemon.
 */
import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { encrypt } from "./lib/crypto";

type NodeRow = typeof schema.nodes.$inferSelect;

export async function registerNodeDatabaseHost(node: Pick<NodeRow, "id" | "name" | "isLocal">): Promise<void> {
  const host = getEnv().MARIADB_CONTAINER;
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242001)`);
    const rows = await tx.select().from(schema.databaseHosts).where(eq(schema.databaseHosts.nodeId, node.id)).orderBy(asc(schema.databaseHosts.id));
    // Een bestaande beheerde rij, of (lokale node) de oude `local`-rij met directe verbinding: die wordt omgezet.
    const have = rows.find((r) => r.daemonManaged) ?? (node.isLocal ? rows.find((r) => r.name === "local") : undefined);
    if (have) {
      await tx.update(schema.databaseHosts).set({ daemonManaged: true, host, port: 3306, adminUser: "", adminPasswordEnc: encrypt("") }).where(eq(schema.databaseHosts.id, have.id));
      return;
    }
    await tx.insert(schema.databaseHosts).values({ name: node.isLocal ? "local" : node.name, host, port: 3306, adminUser: "", adminPasswordEnc: encrypt(""), nodeId: node.id, daemonManaged: true });
  });
}
