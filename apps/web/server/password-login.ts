/**
 * Backup-login met eigen gebruikersnaam + wachtwoord, als reserve naast Discord. Standaard uit per
 * gebruiker (users.login_username = null). Wachtwoord als Argon2id in users.password_hash (dezelfde kolom
 * als het noodaccount; dat heeft nooit een login_username, zie de check-constraint).
 * Na de login geldt dezelfde TOTP-stap als bij Discord: met TOTP aan is de sessie `pending`.
 */
import { hash, verify } from "@node-rs/argon2";
import type { Ctx, Implementation, PasswordLoginStatus } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, eq, ne } from "drizzle-orm";
import { logActivity } from "./activity";
import { forbidApiKey } from "./apikey";
import { secureFor } from "./context";
import { getDb, schema } from "./db";
import { randomToken } from "./lib/crypto";
import { getLimiter } from "./lib/ratelimit";
import { isNewLoginIp } from "./login";
import { notify } from "./notify";
import { checkCode, invalidCode } from "./routers/auth";
import { createSession, sessionCookie } from "./session";

/** Mislukte pogingen per IP / per gebruikersnaam binnen het venster, daarna TOO_MANY_ATTEMPTS. */
export const PASSWORD_LOGIN_IP_MAX = 10;
export const PASSWORD_LOGIN_USER_MAX = 5;
export const PASSWORD_LOGIN_WINDOW_SECONDS = 900;
/** Bytes voor een door de admin gegenereerd wachtwoord (base64url: 24 tekens). */
const GENERATED_BYTES = 18;

type UserRow = typeof schema.users.$inferSelect;
const ok = { ok: true as const };

const hashPw = (pw: string) => hash(pw, { algorithm: 2 });
// Dummy-hash zodat een onbekende naam even lang duurt als een bekende.
let dummy: Promise<string> | null = null;
const getDummy = () => (dummy ??= hashPw(randomToken(24)));

const invalid = () => new TRPCError({ code: "UNAUTHORIZED", message: "INVALID_CREDENTIALS" });
const tooMany = () => new TRPCError({ code: "TOO_MANY_REQUESTS", message: "TOO_MANY_ATTEMPTS" });
const taken = () => new TRPCError({ code: "CONFLICT", message: "USERNAME_TAKEN" });
const emergencyForbidden = () => new TRPCError({ code: "FORBIDDEN", message: "EMERGENCY_ACCOUNT" });

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === "23505" || x?.cause?.code === "23505";
};

export function passwordLoginStatus(u: Pick<UserRow, "loginUsername" | "passwordHash" | "passwordSetAt" | "passwordSetByAdmin" | "isEmergency">): PasswordLoginStatus {
  const enabled = !u.isEmergency && u.loginUsername !== null && u.passwordHash !== null;
  return enabled
    ? { enabled: true, username: u.loginUsername, updatedAt: u.passwordSetAt, setByAdmin: u.passwordSetByAdmin }
    : { enabled: false, username: null, updatedAt: null, setByAdmin: false };
}

async function userById(id: number): Promise<UserRow | undefined> {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  return u;
}

/** Zet naam + wachtwoord. CONFLICT `USERNAME_TAKEN` als een ander de naam al heeft. */
async function setCredentials(u: UserRow, username: string, password: string, setByAdmin: boolean): Promise<PasswordLoginStatus> {
  if (u.isEmergency) throw emergencyForbidden();
  const db = getDb();
  const [other] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.loginUsername, username), ne(schema.users.id, u.id)));
  if (other) throw taken();
  const passwordHash = await hashPw(password);
  try {
    const [row] = await db
      .update(schema.users)
      .set({ loginUsername: username, passwordHash, passwordSetAt: new Date(), passwordSetByAdmin: setByAdmin })
      .where(eq(schema.users.id, u.id))
      .returning();
    return passwordLoginStatus(row!);
  } catch (e) {
    if (isUniqueViolation(e)) throw taken();
    throw e;
  }
}

async function clearCredentials(u: UserRow): Promise<PasswordLoginStatus> {
  // Nooit het wachtwoord van het noodaccount wissen.
  if (u.isEmergency) throw emergencyForbidden();
  const [row] = await getDb()
    .update(schema.users)
    .set({ loginUsername: null, passwordHash: null, passwordSetAt: null, passwordSetByAdmin: false })
    .where(eq(schema.users.id, u.id))
    .returning();
  return passwordLoginStatus(row!);
}

export interface PasswordLoginCtx {
  ip: string | null;
  userAgent: string | null;
  secure: boolean;
}

/** Gebruikersnaam + wachtwoord → sessiecookie. Elke poging wordt gelogd (nooit het wachtwoord). */
export async function passwordLogin(c: PasswordLoginCtx, input: { username: string; password: string }): Promise<{ setCookie: string; userId: number; totpPending: boolean }> {
  const username = input.username.trim().toLowerCase();
  const l = getLimiter();
  const ipKey = `pwlogin:fail:ip:${c.ip ?? "unknown"}`;
  const userKey = `pwlogin:fail:u:${username}`;
  if ((await l.get(ipKey)) >= PASSWORD_LOGIN_IP_MAX || (await l.get(userKey)) >= PASSWORD_LOGIN_USER_MAX) {
    await logActivity({ action: "auth.password_login.limited", ip: c.ip, metadata: { username } });
    throw tooMany();
  }

  const db = getDb();
  const [u] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.loginUsername, username), eq(schema.users.isEmergency, false)));
  const configured = !!u?.loginUsername && !!u.passwordHash;
  // De hash-controle loopt altijd, ook bij een onbekende naam (gelijke doorlooptijd).
  const pwOk = await verify(configured ? u!.passwordHash! : await getDummy(), input.password).catch(() => false);
  const ua = c.userAgent?.slice(0, 200) ?? null;

  if (!configured || !pwOk) {
    await l.hit(ipKey, PASSWORD_LOGIN_WINDOW_SECONDS);
    await l.hit(userKey, PASSWORD_LOGIN_WINDOW_SECONDS);
    await logActivity({ action: "auth.password_login.failed", userId: configured ? u!.id : null, ip: c.ip, metadata: { username, userAgent: ua } });
    throw invalid();
  }
  // Pas na een juist wachtwoord, zodat het geen naam-orakel is.
  if (u!.blocked) {
    await logActivity({ action: "auth.login.blocked", userId: u!.id, ip: c.ip, metadata: { via: "password" } });
    throw new TRPCError({ code: "FORBIDDEN", message: "BLOCKED" });
  }

  // Alleen de naam-teller terugzetten: een eigen geldig account mag de IP-teller niet wissen.
  await l.reset(userKey);
  const newIp = await isNewLoginIp(u!.id, c.ip);
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u!.id));
  const { token } = await createSession(u!.id, { ip: c.ip, userAgent: c.userAgent, totpVerified: false });
  await logActivity({ action: "auth.login", userId: u!.id, ip: c.ip, metadata: { via: "password" } });
  if (newIp && c.ip) await notify({ kind: "login_new_ip", ip: c.ip, userAgent: c.userAgent?.slice(0, 300) ?? null }, { server: null, hooks: [], admin: false, users: [u!.id] });
  return { setCookie: sessionCookie(token, c.secure), userId: u!.id, totpPending: u!.totpEnabled };
}

// ---------- procedures ----------

export const passwordLoginAuth: Pick<Implementation["auth"], "passwordLogin"> = {
  passwordLogin: async ({ input, ctx }) => {
    const r = await passwordLogin({ ip: ctx.ip, userAgent: ctx.userAgent, secure: secureFor(ctx) }, input);
    ctx.resHeaders.append("set-cookie", r.setCookie);
    return ok;
  },
};

const self = async (ctx: Ctx): Promise<UserRow> => {
  const u = await userById(ctx.session!.userId);
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED" });
  return u;
};

export const passwordLoginAccount: Pick<Implementation["account"], "passwordLogin" | "setPasswordLogin" | "disablePasswordLogin"> = {
  passwordLogin: async ({ ctx }) => passwordLoginStatus(await self(ctx)),

  setPasswordLogin: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const u = await self(ctx);
    if (u.isEmergency) throw emergencyForbidden();
    if (u.totpEnabled && !(input.code && (await checkCode(ctx, u.id, u.totpSecretEnc, input.code)))) throw invalidCode();
    const status = await setCredentials(u, input.username, input.password, false);
    await logActivity({ action: "account.password_login.set", userId: u.id, ip: ctx.ip, metadata: { username: status.username, renamed: u.loginUsername !== status.username }, ctx });
    return status;
  },

  disablePasswordLogin: async ({ ctx }) => {
    forbidApiKey(ctx);
    const u = await self(ctx);
    const status = await clearCredentials(u);
    await logActivity({ action: "account.password_login.disable", userId: u.id, ip: ctx.ip, ctx });
    return status;
  },
};

const target = async (id: number): Promise<UserRow> => {
  const u = await userById(id);
  if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
  return u;
};

export const passwordLoginAdmin: Pick<Implementation["admin"]["users"], "getPasswordLogin" | "setPasswordLogin" | "disablePasswordLogin"> = {
  getPasswordLogin: async ({ input }) => passwordLoginStatus(await target(input.id)),

  setPasswordLogin: async ({ input, ctx }) => {
    const u = await target(input.id);
    if (u.isEmergency) throw emergencyForbidden();
    const password = randomToken(GENERATED_BYTES);
    const status = await setCredentials(u, input.username, password, true);
    await logActivity({ action: "admin.user.password_login.set", userId: ctx.session!.userId, ip: ctx.ip, metadata: { targetUserId: u.id, username: status.username }, ctx });
    return { password, status };
  },

  disablePasswordLogin: async ({ input, ctx }) => {
    const u = await target(input.id);
    const status = await clearCredentials(u);
    await logActivity({ action: "admin.user.password_login.disable", userId: ctx.session!.userId, ip: ctx.ip, metadata: { targetUserId: u.id }, ctx });
    return status;
  },
};
