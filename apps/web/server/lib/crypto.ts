/** AES-256-GCM voor `_enc`-kolommen ("v1:<iv b64>:<ciphertext+tag b64>") en hulpjes. */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "../env";

export function encrypt(plain: string, key: Buffer = getEnv().encryptionKey): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(enc: string, key: Buffer = getEnv().encryptionKey): string {
  const [v, ivB64, ctB64] = enc.split(":");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("onbekend versleutelformaat");
  const iv = Buffer.from(ivB64, "base64");
  const all = Buffer.from(ctB64, "base64");
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8");
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
