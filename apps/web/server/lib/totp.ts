/** RFC 6238 TOTP (SHA-1, 6 cijfers, 30 s), zonder externe dependency. */
import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("ongeldige base32");
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpAt(secret: string, counter: number): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(c).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

export const totpNow = (secret: string, at = Date.now()): string => totpAt(secret, Math.floor(at / 30_000));

/** Accepteert de huidige stap en één ervoor/erna (klokverschil). */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const step = Math.floor(at / 30_000);
  for (const d of [0, -1, 1]) if (totpAt(secret, step + d) === code) return true;
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
