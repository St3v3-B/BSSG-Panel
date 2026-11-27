/**
 * Omgeving van het panel (zie deploy/panel.env.example). Wordt bij het eerste gebruik
 * gelezen en gevalideerd; `resetEnv()` is voor tests.
 */
import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const port = (def: number) =>
  optional.transform((v, ctx) => {
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      ctx.addIssue({ code: "custom", message: `invalid port: ${v}` });
      return z.NEVER;
    }
    return n;
  });
const required = z.string({ error: "missing" }).trim().min(1, "missing");
const domain = required.regex(/^[a-z0-9.-]+$/i, "invalid domain").transform((d) => d.toLowerCase());

const EnvSchema = z
  .object({
    PANEL_DOMAIN: domain,
    NODE_DOMAIN: domain,
    OWNER_DISCORD_ID: required.regex(/^\d{15,21}$/, "not a Discord ID"),
    DISCORD_CLIENT_ID: required,
    DISCORD_CLIENT_SECRET: required,
    PANEL_ENCRYPTION_KEY: required.refine((k) => Buffer.from(k, "base64").length === 32, "must be 32 bytes of base64"),
    NODE_TOKEN: required.min(32, "te kort (minimaal 32 tekens)"),
    NODE_PUBLIC_IP: optional,
    ACME_EMAIL: optional,
    MARIADB_ROOT_PASSWORD: optional,
    MARIADB_CONTAINER: optional.transform((v) => v ?? "panel-mariadb"),
    MARIADB_ADMIN_ADDR: optional,
    DATABASE_URL: optional.transform((v) => v ?? "postgres://panel:panel@postgres:5432/panel"),
    REDIS_URL: optional.transform((v) => v ?? "redis://redis:6379"),
    SFTP_PORT: port(2022),
    DAEMON_PORT: port(8080),
    PANEL_URL: optional,
    DAEMON_URL: optional,
    TEMPLATES_DIR: optional.transform((v) => v ?? "/app/templates"),
    PANEL_INSECURE_TEST_LOGIN: optional.transform((v) => v === "1" || v === "true"),
  })
  .transform((e) => ({
    ...e,
    PANEL_URL: (e.PANEL_URL ?? `https://${e.PANEL_DOMAIN}`).replace(/\/+$/, ""),
    DAEMON_URL: (e.DAEMON_URL ?? `https://${e.NODE_DOMAIN}`).replace(/\/+$/, ""),
    MARIADB_ADMIN_ADDR: e.MARIADB_ADMIN_ADDR ?? `${e.MARIADB_CONTAINER}:3306`,
    encryptionKey: Buffer.from(e.PANEL_ENCRYPTION_KEY, "base64"),
    isTestDomain: e.PANEL_DOMAIN.endsWith(".test"),
  }));

export type Env = z.output<typeof EnvSchema>;

export class EnvError extends Error {}

let cached: Env | null = null;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    throw new EnvError(`invalid environment: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const env = r.data;
  if (env.PANEL_INSECURE_TEST_LOGIN && !env.isTestDomain) {
    throw new EnvError("PANEL_INSECURE_TEST_LOGIN=1 is only allowed with a PANEL_DOMAIN ending in .test; the panel will not start");
  }
  return env;
}

export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Alleen voor tests. */
export function resetEnv(): void {
  cached = null;
}

/** Test-login staat aan (vlag én .test-domein). */
export function testLoginEnabled(): boolean {
  try {
    const e = getEnv();
    return e.PANEL_INSECURE_TEST_LOGIN && e.isTestDomain;
  } catch {
    return false;
  }
}
