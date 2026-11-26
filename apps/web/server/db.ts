/**
 * Eén databaseverbinding per proces (ook over HMR heen, via globalThis).
 */
import { createDb, type Db } from "@panel/db";
import { getEnv } from "./env";

export { schema } from "@panel/db";
export type { Db };

const g = globalThis as unknown as { __panelDb?: { db: Db; url: string } };

export function getDb(): Db {
  const url = getEnv().DATABASE_URL;
  if (!g.__panelDb || g.__panelDb.url !== url) g.__panelDb = { db: createDb(url), url };
  return g.__panelDb.db;
}

/** Alleen voor tests: verbinding sluiten. */
export async function closeDb(): Promise<void> {
  const cur = g.__panelDb;
  g.__panelDb = undefined;
  if (cur) await (cur.db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}
