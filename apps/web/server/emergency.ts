/**
 * Noodaccount voor als Discord niet werkt: precies één gebruiker (users.is_emergency) met een
 * Argon2id-wachtwoord en verplichte TOTP. Instellen gaat alleen via de CLI (server/cli/emergency.ts).
 */
import { hash, verify } from "@node-rs/argon2";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt } from "drizzle-orm";
import { logActivity } from "./activity";
import { getDb, schema } from "./db";
import { decrypt, encrypt, randomToken } from "./lib/crypto";
import { getLimiter } from "./lib/ratelimit";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./lib/totp";
import { createSession, sessionCookie } from "./session";

export const EMERGENCY_MIN_PASSWORD = 14;
export const EMERGENCY_IP_MAX = 5;
export const EMERGENCY_GLOBAL_MAX = 20;
export const EMERGENCY_WINDOW_SECONDS = 900;
export const EMERGENCY_NAME = "Emergency account";
export const EMERGENCY_ALERT_DAYS = 7;

const hashPw = (pw: string) => hash(pw, { algorithm: 2 });

/** Zet (of vervangt) het wachtwoord en een nieuw TOTP-secret van het noodaccount. Geeft het secret terug. */
export async function setEmergencyCredentials(password: string): Promise<{ secret: string; otpauthUrl: string; created: boolean }> {
  if (password.length < EMERGENCY_MIN_PASSWORD) throw new Error(`password must be at least ${EMERGENCY_MIN_PASSWORD} characters`);
  const db = getDb();
  const passwordHash = await hashPw(password);
  const secret = generateTotpSecret();
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.isEmergency, true));
  const values = { passwordHash, totpSecretEnc: encrypt(secret), totpEnabled: true, blocked: false };
  if (existing) {
    await db.update(schema.users).set(values).where(eq(schema.users.id, existing.id));
    // Oude sessies van het noodaccount vervallen bij nieuwe gegevens.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, existing.id));
  } else {
    await db.insert(schema.users).values({ ...values, isEmergency: true, name: EMERGENCY_NAME });
  }
  const id = existing?.id ?? (await db.select().from(schema.users).where(eq(schema.users.isEmergency, true)))[0]!.id;
  await logActivity({ action: "emergency.credentials.set", userId: id, metadata: { via: "cli", created: !existing } });
  return { secret, otpauthUrl: otpauthUrl(secret, "emergency", "Panel"), created: !existing };
}

// Dummy-gegevens zodat een onbekend/niet ingesteld account precies evenveel werk kost.
let dummy: Promise<{ hash: string; secret: string }> | null = null;
const getDummy = () => (dummy ??= hashPw(randomToken(24)).then((h) => ({ hash: h, secret: generateTotpSecret() })));

const invalid = () => new TRPCError({ code: "UNAUTHORIZED", message: "INVALID_CREDENTIALS" });

export interface EmergencyCtx {
  ip: string | null;
  userAgent: string | null;
  secure: boolean;
}

/** Wachtwoord + TOTP; geeft het sessiecookie. Elke poging (goed of fout) wordt gelogd. */
export async function emergencyLogin(c: EmergencyCtx, input: { password: string; code: string }): Promise<{ setCookie: string; userId: number }> {
  const l = getLimiter();
  const ipKey = `emergency:fail:ip:${c.ip ?? "unknown"}`;
  const globalKey = "emergency:fail:global";
  if ((await l.get(ipKey)) >= EMERGENCY_IP_MAX || (await l.get(globalKey)) >= EMERGENCY_GLOBAL_MAX) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "TOO_MANY_ATTEMPTS" });
  }

  const db = getDb();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.isEmergency, true));
  const d = await getDummy();
  const configured = !!u?.passwordHash && !!u.totpSecretEnc && u.totpEnabled;
  // Beide controles lopen altijd, ook als het wachtwoord al fout is (gelijke doorlooptijd).
  const pwOk = await verify(configured ? u!.passwordHash! : d.hash, input.password).catch(() => false);
  const secret = configured ? decrypt(u!.totpSecretEnc!) : d.secret;
  const codeOk = verifyTotp(secret, input.code);
  const fresh = codeOk && configured ? (await l.hit(`emergency:used:${input.code}`, 90)) === 1 : true;
  const ok = configured && pwOk && codeOk && fresh && !u!.blocked;

  if (!ok) {
    await l.hit(ipKey, EMERGENCY_WINDOW_SECONDS);
    await l.hit(globalKey, EMERGENCY_WINDOW_SECONDS);
    await logActivity({ action: "auth.emergency_login.failed", userId: u?.id ?? null, ip: c.ip, metadata: { userAgent: c.userAgent?.slice(0, 200) ?? null } });
    throw invalid();
  }

  await l.reset(ipKey);
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u!.id));
  const { token } = await createSession(u!.id, { ip: c.ip, userAgent: c.userAgent, totpVerified: true });
  await logActivity({ action: "auth.emergency_login", userId: u!.id, ip: c.ip, metadata: { userAgent: c.userAgent?.slice(0, 200) ?? null } });
  return { setCookie: sessionCookie(token, c.secure), userId: u!.id };
}

/** Meldingen voor het admin-dashboard: noodlogins (en mislukte pogingen) van de afgelopen dagen. */
export async function emergencyAlerts(now = new Date()) {
  const since = new Date(now.getTime() - EMERGENCY_ALERT_DAYS * 86400_000);
  const rows = await getDb()
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.action, "auth.emergency_login"), gt(schema.activityLog.at, since)))
    .orderBy(desc(schema.activityLog.at))
    .limit(5);
  return rows.map((r) => ({
    kind: "emergency_login" as const,
    message: `Emergency account login${r.ip ? ` from ${r.ip}` : ""}`,
    at: r.at,
    serverUuid: null,
    nodeId: null,
  }));
}
