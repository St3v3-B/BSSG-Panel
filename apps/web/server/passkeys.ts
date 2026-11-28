/**
 * Passkeys (WebAuthn) met @simplewebauthn/server.
 * - Login zonder gebruikersnaam (discoverable credentials, userVerification required). Een passkey met
 *   user verification is zelf al phishing-bestendig multi-factor: de sessie is meteen geverifieerd
 *   (sessions.totp_verified = true). De admin-regel blijft: admin vereist nog steeds TOTP aan (builder).
 * - Tweede stap: een pending sessie verifieert zich met een passkey van dezelfde gebruiker i.p.v. TOTP.
 * - Registreren alleen met een volledig geverifieerde sessie (toegang `user`), nooit met een API-sleutel,
 *   nooit voor het noodaccount.
 * Challenges staan 5 minuten in `webauthn_challenges` en worden bij gebruik verwijderd (eenmalig).
 * RP ID = PANEL_DOMAIN; origin = https://PANEL_DOMAIN (bij een .test-domein ook http://).
 */
import { createHmac } from "node:crypto";
import type { Ctx, Implementation, Passkey, PasskeyOptions, PasskeyResponse } from "@panel/api";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { logActivity } from "./activity";
import { apiKeyOf, forbidApiKey } from "./apikey";
import { secureFor } from "./context";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { getLimiter } from "./lib/ratelimit";
import { isNewLoginIp } from "./login";
import { notify } from "./notify";
import { assertNotLocked, failKeys, TOTP_WINDOW_SECONDS } from "./routers/auth";
import { createSession, rotateSession, sessionCookie } from "./session";
import { getSettings } from "./settings";

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS = 20;
/** Opties-aanvragen per IP per venster (login zonder sessie). */
export const PASSKEY_OPTIONS_IP_MAX = 30;
/** Mislukte passkey-logins per IP binnen het venster, daarna TOO_MANY_ATTEMPTS. */
export const PASSKEY_LOGIN_IP_MAX = 10;
export const PASSKEY_WINDOW_SECONDS = 900;

type Purpose = "register" | "login" | "verify";
type PasskeyRow = typeof schema.passkeys.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
const ok = { ok: true as const };

const invalidPasskey = (code: "UNAUTHORIZED" | "BAD_REQUEST" = "BAD_REQUEST") => new TRPCError({ code, message: "INVALID_PASSKEY" });
const tooMany = () => new TRPCError({ code: "TOO_MANY_REQUESTS", message: "TOO_MANY_ATTEMPTS" });
const emergencyForbidden = () => new TRPCError({ code: "FORBIDDEN", message: "EMERGENCY_ACCOUNT" });
const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "PASSKEY_NOT_FOUND" });

/** RP ID en toegestane origins, uit PANEL_DOMAIN (niets hardcoded). */
export function relyingParty(): { rpID: string; origins: string[] } {
  const e = getEnv();
  const rpID = e.PANEL_DOMAIN;
  return { rpID, origins: e.isTestDomain ? [`https://${rpID}`, `http://${rpID}`] : [`https://${rpID}`] };
}

export const toPasskey = (r: PasskeyRow): Passkey => ({ id: r.id, name: r.name, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, transports: r.transports ?? [], backedUp: r.backedUp });

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === "23505" || x?.cause?.code === "23505";
};

async function userById(id: number): Promise<UserRow> {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED" });
  return u;
}

const passkeysOf = (userId: number) => getDb().select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId)).orderBy(asc(schema.passkeys.id));

/** Willekeurig-ogende, stabiele user handle (geen persoonsgegevens); bestaande passkeys behouden hun handle. */
function userHandleFor(userId: number, existing: PasskeyRow[]): string {
  return existing[0]?.userHandle ?? createHmac("sha256", getEnv().encryptionKey).update(`webauthn-user:${userId}`).digest("base64url");
}

// ---------- challenges ----------

async function storeChallenge(challenge: string, purpose: Purpose, opts: { userId?: number; sessionId?: string } = {}): Promise<void> {
  const db = getDb();
  await db.delete(schema.webauthnChallenges).where(lt(schema.webauthnChallenges.expiresAt, new Date())).catch(() => {});
  await db.insert(schema.webauthnChallenges).values({ challenge, purpose, userId: opts.userId ?? null, sessionId: opts.sessionId ?? null, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) });
}

/** Challenge uit clientDataJSON; null als die niet te lezen is. */
export function challengeOf(response: PasskeyResponse): string | null {
  try {
    const c = (JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)) as { challenge?: unknown }).challenge;
    return typeof c === "string" && c.length > 0 && c.length <= 200 ? c : null;
  } catch {
    return null;
  }
}

/** Verbruikt de challenge (eenmalig); geeft hem terug als hij bestond, niet verlopen was en bij doel/gebruiker/sessie hoort. */
async function consumeChallenge(response: PasskeyResponse, purpose: Purpose, opts: { userId?: number; sessionId?: string } = {}): Promise<string | null> {
  const c = challengeOf(response);
  if (!c) return null;
  const rows = await getDb()
    .delete(schema.webauthnChallenges)
    .where(
      and(
        eq(schema.webauthnChallenges.challenge, c),
        eq(schema.webauthnChallenges.purpose, purpose),
        gt(schema.webauthnChallenges.expiresAt, new Date()),
        opts.userId !== undefined ? eq(schema.webauthnChallenges.userId, opts.userId) : undefined,
        opts.sessionId !== undefined ? eq(schema.webauthnChallenges.sessionId, opts.sessionId) : undefined,
      ),
    )
    .returning({ challenge: schema.webauthnChallenges.challenge });
  return rows[0]?.challenge ?? null;
}

// ---------- verificatie ----------

/**
 * Controleert een authenticatie-response tegen een opgeslagen passkey en werkt teller + laatst gebruikt bij.
 * Geeft false bij elke fout (handtekening, origin, RP ID, user verification, teller, gelijktijdig gebruik).
 */
async function checkAssertion(pk: PasskeyRow, response: PasskeyResponse, challenge: string, requireUserVerification: boolean): Promise<boolean> {
  const { rpID, origins } = relyingParty();
  let newCounter: number;
  try {
    const r = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification,
      credential: { id: pk.credentialId, publicKey: isoBase64URL.toBuffer(pk.publicKey), counter: pk.counter, transports: pk.transports as AuthenticatorTransportFuture[] },
    });
    if (!r.verified) return false;
    newCounter = r.authenticationInfo.newCounter;
    // De bibliotheek weigert een niet-stijgende teller al; dit is een extra vangnet.
    if ((newCounter > 0 || pk.counter > 0) && newCounter <= pk.counter) return false;
  } catch {
    return false;
  }
  // Alleen bijwerken als de teller intussen niet veranderd is (twee gelijktijdige logins met dezelfde response).
  const upd = await getDb()
    .update(schema.passkeys)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(and(eq(schema.passkeys.id, pk.id), eq(schema.passkeys.counter, pk.counter)))
    .returning({ id: schema.passkeys.id });
  return upd.length === 1;
}

const userHandleMatches = (response: PasskeyResponse, pk: PasskeyRow): boolean => {
  const h = (response.response as { userHandle?: unknown }).userHandle;
  return h === undefined || h === null || h === "" || h === pk.userHandle;
};

export interface PasskeyLoginCtx {
  ip: string | null;
  userAgent: string | null;
  secure: boolean;
}

/** Passkey-login zonder sessie → sessiecookie (geverifieerd). */
export async function passkeyLogin(c: PasskeyLoginCtx, response: PasskeyResponse): Promise<{ setCookie: string; userId: number }> {
  const l = getLimiter();
  const ipKey = `pklogin:fail:ip:${c.ip ?? "unknown"}`;
  if ((await l.get(ipKey)) >= PASSKEY_LOGIN_IP_MAX) {
    await logActivity({ action: "auth.passkey_login.limited", ip: c.ip });
    throw tooMany();
  }
  const fail = async (userId: number | null, reason: string) => {
    await l.hit(ipKey, PASSKEY_WINDOW_SECONDS);
    await logActivity({ action: "auth.passkey_login.failed", userId, ip: c.ip, metadata: { reason, userAgent: c.userAgent?.slice(0, 200) ?? null } });
    return invalidPasskey("UNAUTHORIZED");
  };

  const challenge = await consumeChallenge(response, "login");
  if (!challenge) throw await fail(null, "challenge");
  const db = getDb();
  const [row] = await db.select({ pk: schema.passkeys, u: schema.users }).from(schema.passkeys).innerJoin(schema.users, eq(schema.users.id, schema.passkeys.userId)).where(eq(schema.passkeys.credentialId, response.id));
  if (!row || row.u.isEmergency) throw await fail(null, "unknown_credential");
  if (!userHandleMatches(response, row.pk)) throw await fail(row.u.id, "user_handle");
  if (!(await checkAssertion(row.pk, response, challenge, true))) throw await fail(row.u.id, "verification");
  const u = row.u;
  if (u.blocked) {
    await logActivity({ action: "auth.login.blocked", userId: u.id, ip: c.ip, metadata: { via: "passkey" } });
    throw new TRPCError({ code: "FORBIDDEN", message: "BLOCKED" });
  }

  const newIp = await isNewLoginIp(u.id, c.ip);
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, u.id));
  const { token } = await createSession(u.id, { ip: c.ip, userAgent: c.userAgent, totpVerified: true });
  await logActivity({ action: "auth.login", userId: u.id, ip: c.ip, metadata: { via: "passkey", passkeyId: row.pk.id } });
  if (newIp && c.ip) await notify({ kind: "login_new_ip", ip: c.ip, userAgent: c.userAgent?.slice(0, 300) ?? null }, { server: null, hooks: [], admin: false, users: [u.id] });
  return { setCookie: sessionCookie(token, c.secure), userId: u.id };
}

// ---------- procedures ----------

export const passkeyAuth: Pick<Implementation["auth"], "passkeyLoginOptions" | "passkeyLogin" | "passkeyVerifyOptions" | "passkeyVerify"> = {
  passkeyLoginOptions: async ({ ctx }) => {
    if ((await getLimiter().hit(`pklogin:opts:ip:${ctx.ip ?? "unknown"}`, PASSKEY_WINDOW_SECONDS)) > PASSKEY_OPTIONS_IP_MAX) throw tooMany();
    const opts = await generateAuthenticationOptions({ rpID: relyingParty().rpID, userVerification: "required", allowCredentials: [] });
    await storeChallenge(opts.challenge, "login");
    return opts as unknown as PasskeyOptions;
  },

  passkeyLogin: async ({ input, ctx }) => {
    const r = await passkeyLogin({ ip: ctx.ip, userAgent: ctx.userAgent, secure: secureFor(ctx) }, input.response);
    ctx.resHeaders.append("set-cookie", r.setCookie);
    return ok;
  },

  passkeyVerifyOptions: async ({ ctx }) => {
    forbidApiKey(ctx);
    const s = ctx.session!;
    const u = await userById(s.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    await assertNotLocked(failKeys(ctx, u.id));
    const mine = await passkeysOf(u.id);
    if (mine.length === 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_PASSKEYS" });
    const opts = await generateAuthenticationOptions({
      rpID: relyingParty().rpID,
      userVerification: "preferred",
      allowCredentials: mine.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
    });
    await storeChallenge(opts.challenge, "verify", { userId: u.id, sessionId: s.sessionId });
    return opts as unknown as PasskeyOptions;
  },

  passkeyVerify: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const s = ctx.session!;
    const u = await userById(s.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    const keys = failKeys(ctx, u.id);
    await assertNotLocked(keys);
    const fail = async (reason: string) => {
      for (const k of keys) await getLimiter().hit(k, TOTP_WINDOW_SECONDS);
      await logActivity({ action: "auth.totp.failed", userId: u.id, ip: ctx.ip, metadata: { passkey: true, reason }, ctx });
      return invalidPasskey();
    };
    const challenge = await consumeChallenge(input.response, "verify", { userId: u.id, sessionId: s.sessionId });
    if (!challenge) throw await fail("challenge");
    const [pk] = await getDb().select().from(schema.passkeys).where(and(eq(schema.passkeys.credentialId, input.response.id), eq(schema.passkeys.userId, u.id)));
    if (!pk) throw await fail("unknown_credential");
    // Tweede factor: bezit volstaat (security keys zonder pincode mogen); voor de login zonder naam is UV verplicht.
    if (!(await checkAssertion(pk, input.response, challenge, false))) throw await fail("verification");
    await getLimiter().reset(keys[0]!);
    await getDb().update(schema.sessions).set({ totpVerified: true }).where(eq(schema.sessions.id, s.sessionId));
    if (!apiKeyOf(ctx)) ctx.resHeaders.append("set-cookie", await rotateSession(s.sessionId, secureFor(ctx)));
    await logActivity({ action: "auth.totp.verified", userId: u.id, ip: ctx.ip, metadata: { via: "passkey", passkeyId: pk.id }, ctx });
    return ok;
  },
};

const selfForPasskeys = async (ctx: Ctx): Promise<UserRow> => {
  const u = await userById(ctx.session!.userId);
  if (u.isEmergency) throw emergencyForbidden();
  return u;
};

export const passkeyAccount: Implementation["account"]["passkeys"] = {
  list: async ({ ctx }) => (await passkeysOf(ctx.session!.userId)).map(toPasskey),

  registerOptions: async ({ ctx }) => {
    forbidApiKey(ctx);
    const u = await selfForPasskeys(ctx);
    const mine = await passkeysOf(u.id);
    if (mine.length >= MAX_PASSKEYS) throw new TRPCError({ code: "CONFLICT", message: "TOO_MANY_PASSKEYS" });
    const { panelName } = await getSettings();
    const label = u.name ?? u.discordId ?? `user${u.id}`;
    const opts = await generateRegistrationOptions({
      rpName: panelName,
      rpID: relyingParty().rpID,
      userName: label,
      userDisplayName: label,
      userID: isoBase64URL.toBuffer(userHandleFor(u.id, mine)),
      attestationType: "none",
      excludeCredentials: mine.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    });
    await storeChallenge(opts.challenge, "register", { userId: u.id, sessionId: ctx.session!.sessionId });
    return opts as unknown as PasskeyOptions;
  },

  register: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const u = await selfForPasskeys(ctx);
    const challenge = await consumeChallenge(input.response, "register", { userId: u.id, sessionId: ctx.session!.sessionId });
    const fail = async (reason: string) => {
      await logActivity({ action: "account.passkey.register_failed", userId: u.id, ip: ctx.ip, metadata: { reason }, ctx });
      return invalidPasskey();
    };
    if (!challenge) throw await fail("challenge");
    const { rpID, origins } = relyingParty();
    let info;
    try {
      const r = await verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: origins,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
      if (!r.verified) throw await fail("verification");
      info = r.registrationInfo;
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      throw await fail("verification");
    }
    const mine = await passkeysOf(u.id);
    if (mine.length >= MAX_PASSKEYS) throw new TRPCError({ code: "CONFLICT", message: "TOO_MANY_PASSKEYS" });
    try {
      const [row] = await getDb()
        .insert(schema.passkeys)
        .values({
          userId: u.id,
          credentialId: info.credential.id,
          publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
          counter: info.credential.counter,
          transports: (info.credential.transports ?? (input.response.response as { transports?: string[] }).transports ?? []).filter((t): t is string => typeof t === "string").slice(0, 10),
          userHandle: userHandleFor(u.id, mine),
          name: input.name,
          aaguid: info.aaguid,
          deviceType: info.credentialDeviceType,
          backedUp: info.credentialBackedUp,
        })
        .returning();
      await logActivity({ action: "account.passkey.register", userId: u.id, ip: ctx.ip, metadata: { passkeyId: row!.id, name: input.name, aaguid: info.aaguid }, ctx });
      return toPasskey(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new TRPCError({ code: "CONFLICT", message: "PASSKEY_EXISTS" });
      throw e;
    }
  },

  rename: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const uid = ctx.session!.userId;
    const [row] = await getDb().update(schema.passkeys).set({ name: input.name }).where(and(eq(schema.passkeys.id, input.id), eq(schema.passkeys.userId, uid))).returning();
    if (!row) throw notFound();
    await logActivity({ action: "account.passkey.rename", userId: uid, ip: ctx.ip, metadata: { passkeyId: row.id, name: input.name }, ctx });
    return toPasskey(row);
  },

  delete: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const uid = ctx.session!.userId;
    const gone = await getDb().delete(schema.passkeys).where(and(eq(schema.passkeys.id, input.id), eq(schema.passkeys.userId, uid))).returning({ id: schema.passkeys.id, name: schema.passkeys.name });
    if (gone.length === 0) throw notFound();
    await logActivity({ action: "account.passkey.delete", userId: uid, ip: ctx.ip, metadata: { passkeyId: input.id, name: gone[0]!.name }, ctx });
    return ok;
  },
};

export const passkeyAdmin: Pick<Implementation["admin"]["users"], "passkeys" | "deletePasskeys"> = {
  passkeys: async ({ input }) => {
    const [u] = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, input.id));
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
    return (await passkeysOf(input.id)).map(toPasskey);
  },

  deletePasskeys: async ({ input, ctx }) => {
    const [u] = await getDb().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, input.id));
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
    const gone = await getDb().delete(schema.passkeys).where(eq(schema.passkeys.userId, input.id)).returning({ id: schema.passkeys.id });
    await logActivity({ action: "admin.user.passkeys.delete", userId: ctx.session!.userId, ip: ctx.ip, metadata: { targetUserId: input.id, deleted: gone.length }, ctx });
    return { deleted: gone.length };
  },
};

