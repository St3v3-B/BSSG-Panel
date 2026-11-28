/**
 * Testopzet: echte Postgres (Docker), nep-daemon, tijdelijke template-map, env, boot.
 * Gebruik in een testbestand:
 *   const h = useHarness();   // registreert beforeAll/afterAll
 *   const owner = await h.user({ discordId: h.env.OWNER_DISCORD_ID, admin: true, totp: true });
 *   await owner.api.admin.nodes.list();
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRouter, createCallerFactory, type Ctx } from "@panel/api";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { boot, resetBoot } from "../boot";
import { createContext } from "../context";
import { closeDb, getDb, schema } from "../db";
import { resetEnv } from "../env";
import { implementation } from "../index";
import { encrypt } from "../lib/crypto";
import { resetSigningKeyCache } from "../lib/jwt";
import { generateTotpSecret, totpNow } from "../lib/totp";
import { createSession, SESSION_COOKIE } from "../session";
import { startPostgres, type TestPg } from "./docker-pg";
import { FakeDaemon } from "./fake-daemon";

export const GAME_TEMPLATE = `schema: 1
slug: testgame
name: Testspel
description: Template voor tests
type: game
version: 1
image: example/game:1
startup: java -Xmx{{SERVER_MEMORY}}M -jar {{JAR_FILE}}
stop:
  type: command
  value: stop
ready_pattern: "Done \\\\("
variables:
  - key: JAR_FILE
    name: JAR-bestand
    default: server.jar
    user_editable: true
    pattern: "^[A-Za-z0-9._-]+\\\\.jar$"
  - key: SECRET_FLAG
    name: Alleen admin
    default: "off"
    user_editable: false
install:
  image: alpine:3.20
  script: |
    #!/bin/sh
    echo install
config_files:
  - path: server.properties
    format: properties
    set:
      server-port: "{{SERVER_PORT}}"
`;

export const WEB_TEMPLATE = `schema: 1
slug: testweb
name: Testsite
type: web
version: 1
image: nginx:alpine
startup: nginx -g 'daemon off;'
stop: { type: signal, value: SIGTERM }
ready_pattern: "start"
http_port: 8080
install: { image: alpine:3.20, script: "echo ok" }
`;

export const OWNER = "200000000000000001";
const caller = createCallerFactory(buildRouter(implementation));

export type Api = ReturnType<typeof caller>;

export interface TestUser {
  id: number;
  discordId: string;
  cookie: string;
  totpSecret: string | null;
  api: Api;
  ctx: Ctx;
}

export function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    PANEL_DOMAIN: "panel.test",
    NODE_DOMAIN: "node1.test",
    OWNER_DISCORD_ID: OWNER,
    DISCORD_CLIENT_ID: "test-client",
    DISCORD_CLIENT_SECRET: "test-secret",
    PANEL_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    NODE_TOKEN: randomBytes(32).toString("hex"),
    SFTP_PORT: "2222",
    DAEMON_PORT: "18080",
    PANEL_URL: "http://127.0.0.1:3999",
    PANEL_INSECURE_TEST_LOGIN: "1",
    ...over,
  };
}

const ENV_KEYS = Object.keys(baseEnv()).concat(["DATABASE_URL", "DAEMON_URL", "TEMPLATES_DIR", "NODE_PUBLIC_IP", "REDIS_URL", "MARIADB_ROOT_PASSWORD", "MARIADB_CONTAINER", "MARIADB_ADMIN_ADDR", "SESSION_IDLE_DAYS", "SESSION_MAX_DAYS", "MAIL_HOSTNAME", "MAIL_DB_PASSWORD", "MAIL_PUBLIC_IPV4", "MAIL_PUBLIC_IPV6"]);

export function applyEnv(vars: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  resetEnv();
}

export function makeTemplatesDir(files: Record<string, string> = { "game/testgame.yaml": GAME_TEMPLATE, "web/testweb.yaml": WEB_TEMPLATE }): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-api-templates-"));
  mkdirSync(join(dir, "game"));
  mkdirSync(join(dir, "web"));
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

export function useHarness(opts: { env?: Record<string, string>; templates?: Record<string, string> } = {}) {
  const h = {
    pg: null as TestPg | null,
    daemon: null as unknown as FakeDaemon,
    env: {} as Record<string, string>,
    templatesDir: "",
    localNodeId: 0,

    /** Maakt een gebruiker met sessie. `totp: true` zet TOTP aan (sessie geverifieerd tenzij `verified: false`). */
    async user(o: { discordId: string; name?: string; admin?: boolean; totp?: boolean; verified?: boolean; blocked?: boolean }): Promise<TestUser> {
      const db = getDb();
      const secret = o.totp ? generateTotpSecret() : null;
      const [u] = await db
        .insert(schema.users)
        .values({ discordId: o.discordId, name: o.name ?? `user-${o.discordId.slice(-4)}`, totpEnabled: !!o.totp, totpSecretEnc: secret ? encrypt(secret) : null, blocked: !!o.blocked })
        .onConflictDoUpdate({ target: schema.users.discordId, set: { totpEnabled: !!o.totp, totpSecretEnc: secret ? encrypt(secret) : null, blocked: !!o.blocked } })
        .returning();
      if (o.admin) await db.insert(schema.adminDiscordIds).values({ discordId: o.discordId }).onConflictDoNothing();
      const { token } = await createSession(u!.id, { ip: "127.0.0.1", userAgent: "vitest", totpVerified: o.totp ? o.verified !== false : false });
      const cookie = `${SESSION_COOKIE}=${token}`;
      const ctx = await h.ctxFor(cookie);
      return { id: u!.id, discordId: o.discordId, cookie, totpSecret: secret, api: caller(ctx), ctx };
    },

    async ctxFor(cookie: string | null): Promise<Ctx> {
      return createContext(new Request("http://panel.test/api/trpc", { headers: cookie ? { cookie, "user-agent": "vitest" } : {} }), new Headers());
    },

    /** Nieuwe caller met verse context (na wijzigingen aan sessie/admin-lijst). */
    async refresh(u: TestUser): Promise<TestUser> {
      // Na tokenrotatie (verifyTotp/totpEnable) staat het nieuwe cookie in de response-headers van de oude context.
      const rotated = u.ctx?.resHeaders.getSetCookie().filter((c) => c.startsWith(`${SESSION_COOKIE}=`)).pop();
      const cookie = rotated && !/Max-Age=0/.test(rotated) ? rotated.split(";")[0]!.replace(/%3D/g, "=") : u.cookie;
      const ctx = await h.ctxFor(cookie);
      return { ...u, cookie, ctx, api: caller(ctx) };
    },

    anon: async (): Promise<Api> => caller(await h.ctxFor(null)),

    totp: (u: TestUser) => totpNow(u.totpSecret!),

    async allocation(port: number, ip = "127.0.0.1"): Promise<number> {
      const [a] = await getDb().insert(schema.allocations).values({ nodeId: h.localNodeId, ip, port }).returning();
      return a!.id;
    },

    async templateId(slug: string): Promise<number> {
      const [t] = await getDb().select().from(schema.templates).where(eq(schema.templates.slug, slug));
      return t!.id;
    },
  };

  beforeAll(async () => {
    h.pg = await startPostgres();
    h.daemon = new FakeDaemon("");
    h.templatesDir = makeTemplatesDir(opts.templates && { "game/testgame.yaml": GAME_TEMPLATE, "web/testweb.yaml": WEB_TEMPLATE, ...opts.templates });
    h.env = baseEnv({ DATABASE_URL: h.pg.url, TEMPLATES_DIR: h.templatesDir, ...opts.env });
    h.daemon.token = h.env.NODE_TOKEN!;
    h.env.DAEMON_URL = await h.daemon.start();
    applyEnv(h.env);
    resetBoot();
    resetSigningKeyCache();
    await closeDb();
    await boot();
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.isLocal, true));
    h.localNodeId = n!.id;
  }, 120_000);

  afterAll(async () => {
    await closeDb().catch(() => {});
    await h.daemon?.stop().catch(() => {});
    await h.pg?.stop();
    if (h.templatesDir) rmSync(h.templatesDir, { recursive: true, force: true });
    resetBoot();
    resetSigningKeyCache();
  }, 60_000);

  return h;
}

export type Harness = ReturnType<typeof useHarness>;
