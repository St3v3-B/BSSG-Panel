/**
 * Browser-JWT's (EdDSA/Ed25519) voor de daemon-websocket en up/downloads.
 * Het sleutelpaar staat versleuteld in settings.jwt_signing_key_enc.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import type { BrowserJwtClaims } from "@panel/api";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { decrypt, encrypt } from "./crypto";

const SETTING = "jwt_signing_key_enc";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

const g = globalThis as unknown as { __panelJwtKey?: SigningKey };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function fromPem(pem: string): SigningKey {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const kid = createHash("sha256").update(x).digest("base64url").slice(0, 16);
  return { kid, privateKey, publicKey };
}

/** Laadt of maakt het sleutelpaar (idempotent, ook bij gelijktijdige starts). */
export async function ensureSigningKey(): Promise<SigningKey> {
  const db = getDb();
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await db.insert(schema.settings).values({ key: SETTING, value: encrypt(pem) }).onConflictDoNothing();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, SETTING));
  if (!row || typeof row.value !== "string") throw new Error("JWT key missing in settings");
  g.__panelJwtKey = fromPem(decrypt(row.value));
  return g.__panelJwtKey;
}

export async function getSigningKey(): Promise<SigningKey> {
  return g.__panelJwtKey ?? ensureSigningKey();
}

export function resetSigningKeyCache(): void {
  g.__panelJwtKey = undefined;
}

export async function jwks(): Promise<{ keys: Array<{ kty: "OKP"; crv: "Ed25519"; x: string; kid: string; alg: "EdDSA"; use: "sig" }> }> {
  const k = await getSigningKey();
  const x = (k.publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { keys: [{ kty: "OKP", crv: "Ed25519", x, kid: k.kid, alg: "EdDSA", use: "sig" }] };
}

export const JWT_TTL_SECONDS = 600;

/** Extra claims voor up/download: de URL-parameters, zodat de daemon kan zien dat ze niet zijn aangepast. */
export type TransferClaims = Pick<BrowserJwtClaims, "path" | "directory" | "archive" | "purpose">;

export async function signBrowserJwt(c: { iss: string; aud: string; sub: string; serverUuid: string; permissions: string[]; ttlSeconds?: number; extra?: TransferClaims }): Promise<{ token: string; claims: BrowserJwtClaims & TransferClaims }> {
  const k = await getSigningKey();
  const iat = Math.floor(Date.now() / 1000);
  const claims: BrowserJwtClaims & TransferClaims = {
    iss: c.iss,
    aud: c.aud,
    sub: c.sub,
    server_uuid: c.serverUuid,
    permissions: c.permissions,
    jti: randomUUID(),
    iat,
    exp: iat + Math.min(c.ttlSeconds ?? JWT_TTL_SECONDS, JWT_TTL_SECONDS),
    ...c.extra,
  };
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: k.kid }));
  const body = b64url(JSON.stringify(claims));
  const sig = sign(null, Buffer.from(`${head}.${body}`), k.privateKey);
  return { token: `${head}.${body}.${b64url(sig)}`, claims };
}

/** Controle zoals de daemon hem doet; voor tests. */
export function verifyJwt(token: string, publicKey: KeyObject): { header: Record<string, unknown>; claims: BrowserJwtClaims & TransferClaims } | null {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return null;
  if (!verify(null, Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url"))) return null;
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(b, "base64url").toString()) };
}
