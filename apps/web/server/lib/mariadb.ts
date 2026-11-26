/**
 * Beheer van databases op een MariaDB-host: per database een eigen gebruiker met rechten op
 * alleen die database. Namen worden door ons gemaakt en gecontroleerd ([a-zA-Z0-9_]).
 */
import { createConnection, type Connection } from "mariadb";
import { decrypt } from "./crypto";

export interface HostConn {
  host: string;
  port: number;
  adminUser: string;
  adminPasswordEnc: string;
}

const SAFE = /^[A-Za-z0-9_]{1,64}$/;
const ident = (s: string) => {
  if (!SAFE.test(s)) throw new Error(`ongeldige naam: ${s}`);
  return `\`${s}\``;
};

export async function withHost<T>(h: HostConn, fn: (c: Connection) => Promise<T>): Promise<T> {
  const c = await createConnection({ host: h.host, port: h.port, user: h.adminUser, password: decrypt(h.adminPasswordEnc), connectTimeout: 5000 });
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

export async function createDatabase(h: HostConn, db: string, user: string, password: string): Promise<void> {
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

export async function setPassword(h: HostConn, user: string, password: string): Promise<void> {
  await withHost(h, (c) => c.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [user, password]));
}

export async function dropDatabase(h: HostConn, db: string, user: string): Promise<void> {
  await withHost(h, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(db)}`);
    await c.query(`DROP USER IF EXISTS ?@'%'`, [user]);
  });
}

export async function testHost(h: HostConn): Promise<{ ok: boolean; error: string | null }> {
  try {
    await withHost(h, (c) => c.query("SELECT 1"));
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 500) };
  }
}
