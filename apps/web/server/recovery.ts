/** Herstelcodes voor 2FA: 10 eenmalige codes, alleen als SHA-256 opgeslagen. */
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "./db";
import { sha256 } from "./lib/crypto";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_WARN_AT = 2;
// Zonder 0/o/1/l/i: leesbaar overtypen. 10 tekens uit 31 = ~50 bits.
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** Herkent het formaat (na normaliseren) zodat een TOTP-code nooit als herstelcode wordt geprobeerd. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/[\s-]+/g, "");
  if (!/^[a-z0-9]{10}$/.test(s) || /^\d+$/.test(s)) return null;
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

type Tx = Pick<Db, "insert" | "delete" | "select" | "update">;

/** Vervangt alle codes van de gebruiker; geeft de nieuwe codes terug (platte tekst, één keer). */
export async function replaceRecoveryCodes(userId: number, tx: Tx = getDb()): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await tx.delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
  await tx.insert(schema.recoveryCodes).values(codes.map((c) => ({ userId, codeHash: sha256(c) })));
  return codes;
}

export async function remainingRecoveryCodes(userId: number): Promise<number> {
  const [r] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.recoveryCodes)
    .where(and(eq(schema.recoveryCodes.userId, userId), isNull(schema.recoveryCodes.usedAt)));
  return r?.n ?? 0;
}

/** Verbruikt een code atomair; geeft het aantal overgebleven codes, of null als de code ongeldig/gebruikt is. */
export async function consumeRecoveryCode(userId: number, input: string): Promise<number | null> {
  const code = normalizeRecoveryCode(input);
  if (!code) return null;
  const used = await getDb()
    .update(schema.recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.recoveryCodes.userId, userId), eq(schema.recoveryCodes.codeHash, sha256(code)), isNull(schema.recoveryCodes.usedAt)))
    .returning({ id: schema.recoveryCodes.id });
  if (used.length === 0) return null;
  return remainingRecoveryCodes(userId);
}

export async function clearRecoveryCodes(userId: number): Promise<void> {
  await getDb().delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, userId));
}
