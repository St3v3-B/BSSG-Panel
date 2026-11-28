/**
 * phpMyAdmin single sign-on.
 *
 * Flow: de browser vraagt `databases.phpMyAdminUrl` (tRPC, ingelogd) -> eenmalig token (60 s, gebonden aan
 * de gebruiker) -> /phpmyadmin/signon.php?token=... -> het PHP-script wisselt het token server-to-server in via
 * POST /api/pma/exchange (Bearer PMA_SHARED_SECRET) voor `{user, password}` van het MariaDB-account
 * `pma_u<userId>`. Bij elke exchange krijgt dat account een nieuw wachtwoord en exact de grants die de
 * gebruiker op dat moment verdient, op elke node waar hij databases heeft (via de daemon van die node:
 * `PUT /api/db/pma-users/{user}`). De lokale MariaDB bereikt phpMyAdmin direct; remote nodes via een tunnel door het
 * panel en de daemon van die node (zie pma-tunnel.ts), zodat geen MariaDB een poort naar buiten opent.
 */
import { randomBytes } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { daemonFor, DaemonUnreachableError } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { safeEqual, sha256 } from "./lib/crypto";
import { getLimiter, getRedis } from "./lib/ratelimit";
import { ensureTunnel } from "./pma-tunnel";

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

/** Eén node in phpMyAdmin: zijn daemon-beheerde MariaDB en de databases die de gebruiker daar ziet. */
export interface PmaNodeAccess {
  nodeId: number;
  name: string;
  isLocal: boolean;
  /** Daemon-beheerde database-hosts van deze node (normaal één). */
  hostIds: number[];
  /** Unieke databasenamen, gesorteerd. */
  databases: string[];
}

export interface PmaAccess {
  /** Nodes in phpMyAdmin, lokale node eerst, daarna op naam. Niet-admins: alleen nodes met databases. */
  nodes: PmaNodeAccess[];
  /** Aantal databases op hosts die niet door een daemon beheerd worden (komen niet in phpMyAdmin). */
  external: number;
}

/**
 * Toegang: databases van servers waarvan de gebruiker eigenaar is, plus servers waar hij subuser is met
 * `database.manage`, plus (volledige admin) alle databases. Niet-admins krijgen geen toegang tot databases van
 * opgeschorte servers. Elke node met een daemon-beheerde MariaDB is een eigen server in phpMyAdmin; een volledige
 * admin krijgt al die nodes, ook zonder databases.
 */
export async function pmaAccess(userId: number, admin: boolean): Promise<PmaAccess> {
  const db = getDb();
  const sub = db
    .select({ id: schema.subusers.serverId })
    .from(schema.subusers)
    .where(and(eq(schema.subusers.userId, userId), sql`${DB_PERMISSION} = any(${schema.subusers.permissions})`));
  const rows = await db
    .select({ name: schema.databases.name, hostId: schema.databaseHosts.id, hostNodeId: schema.databaseHosts.nodeId, managed: schema.databaseHosts.daemonManaged })
    .from(schema.databases)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.databases.serverId))
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(admin ? undefined : and(or(eq(schema.servers.ownerId, userId), inArray(schema.servers.id, sub)), sql`${schema.servers.suspendedAt} is null`));
  // Alle daemon-beheerde hosts met hun node (ook zonder databases: voor admins).
  const hosts = await db
    .select({ hostId: schema.databaseHosts.id, nodeId: schema.nodes.id, name: schema.nodes.name, isLocal: schema.nodes.isLocal })
    .from(schema.databaseHosts)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.databaseHosts.nodeId))
    .where(eq(schema.databaseHosts.daemonManaged, true));
  const byHost = new Map(hosts.map((h) => [h.hostId, h]));
  const nodes = new Map<number, PmaNodeAccess & { set: Set<string> }>();
  const nodeOf = (h: (typeof hosts)[number]) => {
    let n = nodes.get(h.nodeId);
    if (!n) nodes.set(h.nodeId, (n = { nodeId: h.nodeId, name: h.name, isLocal: h.isLocal, hostIds: [], databases: [], set: new Set() }));
    if (!n.hostIds.includes(h.hostId)) n.hostIds.push(h.hostId);
    return n;
  };
  if (admin) for (const h of hosts) nodeOf(h);
  let external = 0;
  for (const r of rows) {
    const h = r.managed ? byHost.get(r.hostId) : undefined;
    if (!h) {
      external++;
      continue;
    }
    nodeOf(h).set.add(r.name);
  }
  const out = [...nodes.values()]
    .map(({ set, ...n }) => ({ ...n, hostIds: n.hostIds.sort((a, b) => a - b), databases: [...set].sort() }))
    .sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name) || a.nodeId - b.nodeId);
  return { nodes: out, external };
}

/** Heeft de gebruiker iets in phpMyAdmin te zoeken (admins altijd). */
export const pmaHasAccess = (a: PmaAccess, admin: boolean) => admin || a.nodes.some((n) => n.databases.length > 0);

/** Serversleutel in phpMyAdmin ($cfg['Servers'][key]): de lokale node is altijd 1 (zoals vroeger), andere nodes id + 1. */
export const pmaServerKey = (n: Pick<PmaNodeAccess, "nodeId" | "isLocal">) => (n.isLocal ? 1 : n.nodeId + 1);

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

/** Een offline remote node mag het inloggen niet ophouden (signon.php wacht hoogstens 30 s). */
const REMOTE_SYNC_TIMEOUT_MS = 12_000;

/** Eén server in het antwoord van de exchange (signon.php zet hiermee de signon-sessie van die server). */
export interface PmaExchangeServer {
  /** Sleutel in $cfg['Servers'] (lokaal 1). */
  id: number;
  /** Naam van de node (serverkeuze in phpMyAdmin). */
  name: string;
  local: boolean;
  /** Lokaal: 3306 op PMA_DB_HOST. Remote: de tunnelpoort op PMA_TUNNEL_HOST (het panel). */
  port: number;
  password: string;
}

/**
 * POST /api/pma/exchange {token, db?} met Bearer PMA_SHARED_SECRET ->
 * `{user, password, servers: [{id, name, local, port, password}], select, unavailable}`.
 * Per node met databases van de gebruiker (admin: alle nodes) een eigen wachtwoord voor `pma_u<id>`, gezet via de
 * daemon van die node. `select` is de server waar `db` staat (deep-link), anders de eerste. Nodes die niet
 * antwoorden staan in `unavailable` (namen) en ontbreken in `servers`; alleen als niets lukt is het antwoord een fout.
 * `user`/`password` bovenaan: compatibiliteit met een oudere signon.php (de eerste server).
 */
/** Zonder ensureBooted (zie pma-route.ts): dit bestand wordt door de routers geimporteerd. */
export async function pmaExchangeUnbooted(req: Request): Promise<Response> {
  try {
    const secret = getEnv().PMA_SHARED_SECRET;
    if (!secret) return error(404, "not_found");
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
    if (!m || !safeEqual(m[1]!, secret)) return error(401, "unauthorized");
    // Alleen bruikbaar met het gedeelde geheim, maar toch begrenzen (de container staat achter de gebruiker).
    if ((await getLimiter().hit(`pma-exchange:${clientIp(req)}`, 60)) > 120) return error(429, "too_many_attempts");
    const b = (await req.json().catch(() => null)) as { token?: unknown; db?: unknown } | null;
    const data = typeof b?.token === "string" ? await takeToken(b.token) : null;
    if (!data) return error(401, "invalid_token");
    const wantDb = typeof b?.db === "string" && /^[A-Za-z0-9_]{1,64}$/.test(b.db) ? b.db : null;
    const [u] = await getDb().select({ id: schema.users.id, blocked: schema.users.blocked }).from(schema.users).where(eq(schema.users.id, data.userId));
    if (!u || u.blocked) return error(401, "invalid_token");
    const user = pmaUsername(u.id);
    return await serialized(u.id, async () => {
      // Grants worden binnen de serialisatie berekend, zodat de laatste exchange ook de laatste stand krijgt.
      const access = await pmaAccess(u.id, data.admin);
      if (!pmaHasAccess(access, data.admin)) return error(403, "no_databases");
      const targets = access.nodes.filter((n) => data.admin || n.databases.length > 0);
      if (targets.length === 0) return error(503, "no_local_node");
      const nodeRows = await getDb().select().from(schema.nodes).where(inArray(schema.nodes.id, targets.map((t) => t.nodeId)));
      const results = await Promise.all(
        targets.map(async (t): Promise<{ ok: PmaExchangeServer; t: PmaNodeAccess } | { fail: unknown; t: PmaNodeAccess }> => {
          const node = nodeRows.find((n) => n.id === t.nodeId);
          const password = randomBytes(24).toString("base64url");
          try {
            if (!node) throw new Error("node missing");
            await daemonFor(node).dbSyncPmaUser(user, password, t.databases, t.isLocal ? undefined : REMOTE_SYNC_TIMEOUT_MS);
            const port = t.isLocal ? 3306 : await ensureTunnel(t.nodeId);
            return { ok: { id: pmaServerKey(t), name: t.name, local: t.isLocal, port, password }, t };
          } catch (e) {
            console.error(`[pma] sync on node ${t.nodeId} failed:`, (e as Error)?.message ?? e);
            return { fail: e, t };
          }
        }),
      );
      const servers = results.flatMap((r) => ("ok" in r ? [r.ok] : []));
      const unavailable = results.flatMap((r) => ("fail" in r ? [r.t.name] : []));
      if (servers.length === 0) {
        const unreachable = results.some((r) => "fail" in r && r.fail instanceof DaemonUnreachableError);
        return error(unreachable ? 503 : 502, "database_unavailable");
      }
      const withDb = wantDb ? results.find((r) => "ok" in r && r.t.databases.includes(wantDb)) : undefined;
      const select = withDb && "ok" in withDb ? withDb.ok.id : servers[0]!.id;
      return json(200, { user, password: servers[0]!.password, servers, select, unavailable });
    });
  } catch (e) {
    console.error("[pma] exchange:", e);
    return error(500, "internal");
  }
}
