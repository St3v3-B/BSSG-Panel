/**
 * phpMyAdmin single sign-on.
 *
 * Flow: de browser vraagt `databases.phpMyAdminUrl` (tRPC, ingelogd) -> eenmalig token (60 s, gebonden aan
 * de gebruiker) -> /phpmyadmin/signon.php?token=... -> het PHP-script wisselt het token server-to-server in via
 * POST /api/pma/exchange (Bearer PMA_SHARED_SECRET) voor `{user, password}` van het MariaDB-account
 * `pma_u<userId>`. Bij elke exchange krijgt dat account een nieuw wachtwoord en exact de grants die de
 * gebruiker op dat moment verdient (via de daemon van de lokale node: `PUT /api/db/pma-users/{user}`).
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { daemonFor, DaemonUnreachableError } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { safeEqual, sha256 } from "./lib/crypto";
import { getLimiter, getRedis } from "./lib/ratelimit";

// Lokale helpers: ./remote importeert (indirect) de routers en geeft een importcirkel met server/index.ts.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const error = (status: number, code: string) => json(status, { error: code });

const TOKEN_TTL_S = 60;
/** Permissie van een subuser die databases beheert (zie packages/api/schemas.ts Permission). */
export const DB_PERMISSION = "database.manage";

export const pmaEnabled = (): boolean => !!getEnv().PMA_SHARED_SECRET;
export const pmaUsername = (userId: number) => `pma_u${userId}`;

// ---------- eenmalige tokens (Redis, anders geheugen) ----------

interface TokenData {
  userId: number;
  /** Op het moment van uitgeven: volledige admin (admin + TOTP geverifieerd in die sessie). */
  admin: boolean;
}

const mem = new Map<string, { data: TokenData; until: number }>();
const key = (token: string) => `pma:token:${sha256(token)}`;

export async function issueToken(data: TokenData): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const r = getRedis();
  if (r?.status === "ready") {
    try {
      await r.set(key(token), JSON.stringify(data), "EX", TOKEN_TTL_S);
      return token;
    } catch {}
  }
  const now = Date.now();
  for (const [k, v] of mem) if (v.until < now) mem.delete(k);
  mem.set(key(token), { data, until: now + TOKEN_TTL_S * 1000 });
  return token;
}

/** Haalt het token op én verbruikt het (atomair); null bij onbekend, verlopen of al gebruikt. */
export async function takeToken(token: string): Promise<TokenData | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const k = key(token);
  const m = mem.get(k);
  if (m) {
    mem.delete(k);
    if (m.until >= Date.now()) return m.data;
  }
  const r = getRedis();
  if (r?.status === "ready") {
    try {
      const raw = await r.getdel(k);
      if (raw) return JSON.parse(raw) as TokenData;
    } catch {}
  }
  return null;
}

// ---------- wie ziet welke databases ----------

export interface PmaAccess {
  /** Databases op de lokale node waar de gebruiker toegang toe heeft (unieke namen). */
  local: string[];
  /** Aantal databases op andere nodes (komen niet in phpMyAdmin). */
  remote: number;
}

/**
 * Toegang: databases van servers waarvan de gebruiker eigenaar is, plus servers waar hij subuser is met
 * `database.manage`, plus (volledige admin) alle databases. Niet-admins krijgen geen toegang tot databases van
 * opgeschorte servers. Alleen databases op de daemon-beheerde host van de lokale node komen in `local`.
 */
export async function pmaAccess(userId: number, admin: boolean): Promise<PmaAccess> {
  const db = getDb();
  const sub = db
    .select({ id: schema.subusers.serverId })
    .from(schema.subusers)
    .where(and(eq(schema.subusers.userId, userId), sql`${DB_PERMISSION} = any(${schema.subusers.permissions})`));
  const rows = await db
    .select({ name: schema.databases.name, hostNodeId: schema.databaseHosts.nodeId, managed: schema.databaseHosts.daemonManaged, nodeLocal: schema.nodes.isLocal })
    .from(schema.databases)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.databases.serverId))
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.databaseHosts.nodeId))
    .where(admin ? undefined : and(or(eq(schema.servers.ownerId, userId), inArray(schema.servers.id, sub)), sql`${schema.servers.suspendedAt} is null`));
  const local = new Set<string>();
  let remote = 0;
  for (const r of rows) {
    if (r.managed && r.nodeLocal) local.add(r.name);
    else remote++;
  }
  return { local: [...local].sort(), remote };
}

// ---------- exchange ----------

/** Per gebruiker één sync tegelijk (DROP + CREATE van hetzelfde account mag niet door elkaar lopen). */
const syncing = new Map<number, Promise<unknown>>();
function serialized<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const run = (syncing.get(userId) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.finally(() => {
    if (syncing.get(userId) === tail) syncing.delete(userId);
  });
  syncing.set(userId, tail);
  return run;
}

const clientIp = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim();

/** POST /api/pma/exchange {token} met Bearer PMA_SHARED_SECRET -> {user, password}. */
/** Zonder ensureBooted (zie pma-route.ts): dit bestand wordt door de routers geimporteerd. */
export async function pmaExchangeUnbooted(req: Request): Promise<Response> {
  try {
    const secret = getEnv().PMA_SHARED_SECRET;
    if (!secret) return error(404, "not_found");
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m || !safeEqual(m[1]!, secret)) return error(401, "unauthorized");
    // Alleen bruikbaar met het gedeelde geheim, maar toch begrenzen (de container staat achter de gebruiker).
    if ((await getLimiter().hit(`pma-exchange:${clientIp(req)}`, 60)) > 120) return error(429, "too_many_attempts");
    const b = (await req.json().catch(() => null)) as { token?: unknown } | null;
    const data = typeof b?.token === "string" ? await takeToken(b.token) : null;
    if (!data) return error(401, "invalid_token");
    const [u] = await getDb().select({ id: schema.users.id, blocked: schema.users.blocked }).from(schema.users).where(eq(schema.users.id, data.userId));
    if (!u || u.blocked) return error(401, "invalid_token");
    const [node] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.isLocal, true));
    if (!node) return error(503, "no_local_node");
    const user = pmaUsername(u.id);
    const password = randomBytes(24).toString("base64url");
    return await serialized(u.id, async () => {
      // Grants worden binnen de serialisatie berekend, zodat de laatste exchange ook de laatste stand krijgt.
      const access = await pmaAccess(u.id, data.admin);
      if (!data.admin && access.local.length === 0) return error(403, "no_databases");
      try {
        await daemonFor(node).dbSyncPmaUser(user, password, access.local);
      } catch (e) {
        console.error("[pma] sync failed:", e);
        return error(e instanceof DaemonUnreachableError ? 503 : 502, "database_unavailable");
      }
      return json(200, { user, password });
    });
  } catch (e) {
    console.error("[pma] exchange:", e);
    return error(500, "internal");
  }
}
