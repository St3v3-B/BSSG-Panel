/**
 * Beheer van databases op een MariaDB-host: per database een eigen gebruiker met rechten op
 * alleen die database. Namen worden door ons gemaakt en gecontroleerd ([a-zA-Z0-9_]).
 */
import { createConnection, type Connection } from "mariadb";
import { eq } from "drizzle-orm";
import { DaemonHttpError, daemonFor, type DaemonClient } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { decrypt } from "./crypto";

export interface HostConn {
  host: string;
  port: number;
  adminUser: string;
  adminPasswordEnc: string;
  /** true: via de daemon van `nodeId` (nooit rechtstreeks verbinden). */
  daemonManaged?: boolean;
  nodeId?: number | null;
}

/** Daemon van de node van een daemon-beheerde host. */
export async function hostDaemon(h: Pick<HostConn, "nodeId">): Promise<DaemonClient> {
  if (!h.nodeId) throw new Error("database host has no node");
  const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, h.nodeId));
  if (!n) throw new Error("node of database host not found");
  return daemonFor(n);
}

/** Daemonfouten als gewone fouten; "bestaat al" (409) krijgt errno 1007 zoals MariaDB zelf. */
async function viaDaemon<T>(h: HostConn, fn: (d: DaemonClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await hostDaemon(h));
  } catch (e) {
    if (e instanceof DaemonHttpError) throw Object.assign(new Error(e.message), { errno: e.status === 409 ? 1007 : undefined });
    throw e;
  }
}

const SAFE = /^[A-Za-z0-9_]{1,64}$/;
const ident = (s: string) => {
  if (!SAFE.test(s)) throw new Error(`invalid name: ${s}`);
  return `\`${s}\``;
};

/**
 * Adres waarmee het panel zelf verbindt. `host` is de naam die sites gebruiken; voor de lokale
 * MariaDB (host = MARIADB_CONTAINER) is dat voor het panel MARIADB_ADMIN_ADDR.
 */
export function adminAddress(h: Pick<HostConn, "host" | "port">): { host: string; port: number } {
  const env = getEnv();
  if (h.host !== env.MARIADB_CONTAINER) return { host: h.host, port: h.port };
  const m = /^(.*):(\d+)$/.exec(env.MARIADB_ADMIN_ADDR);
  return m ? { host: m[1]!.replace(/^\[|\]$/g, ""), port: Number(m[2]) } : { host: env.MARIADB_ADMIN_ADDR, port: 3306 };
}

export async function withHost<T>(h: HostConn, fn: (c: Connection) => Promise<T>): Promise<T> {
  const c = await createConnection({ ...adminAddress(h), user: h.adminUser, password: decrypt(h.adminPasswordEnc), connectTimeout: 5000 });
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

export async function createDatabase(h: HostConn, db: string, user: string, password: string): Promise<void> {
  if (h.daemonManaged) return viaDaemon(h, (d) => d.dbCreate(db, user, password));
  await withHost(h, async (c) => {
    await c.query(`CREATE DATABASE ${ident(db)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    try {
      await c.query(`CREATE USER ?@'%' IDENTIFIED BY ?`, [user, password]);
      await c.query(`GRANT ALL PRIVILEGES ON ${ident(db)}.* TO ?@'%'`, [user]);
    } catch (e) {
      await c.query(`DROP USER IF EXISTS ?@'%'`, [user]).catch(() => {});
      await c.query(`DROP DATABASE IF EXISTS ${ident(db)}`).catch(() => {});
      throw e;
    }
  });
}

export async function setPassword(h: HostConn, user: string, password: string, db?: string): Promise<void> {
  if (h.daemonManaged) return viaDaemon(h, (d) => d.dbSetPassword(db ?? "_", user, password));
  await withHost(h, (c) => c.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [user, password]));
}

export async function dropDatabase(h: HostConn, db: string, user: string): Promise<void> {
  if (h.daemonManaged) return viaDaemon(h, (d) => d.dbDrop(db, user));
  await withHost(h, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(db)}`);
    await c.query(`DROP USER IF EXISTS ?@'%'`, [user]);
  });
}

export async function testHost(h: HostConn): Promise<{ ok: boolean; error: string | null }> {
  try {
    if (h.daemonManaged) {
      const st = await viaDaemon(h, (d) => d.dbStatus());
      return st.available ? { ok: true, error: null } : { ok: false, error: (st.error ?? "MariaDB unavailable").slice(0, 500) };
    }
    await withHost(h, (c) => c.query("SELECT 1"));
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 500) };
  }
}
