/**
 * E-mail via SMTP (nodemailer). De admin stelt SMTP in onder Instellingen > E-mail; de instellingen
 * staan in `settings` (`smtp`: host/poort/beveiliging/gebruiker/afzender, `smtp_password_enc`:
 * wachtwoord, versleuteld). Zonder host is e-mail uit.
 */
import type { SmtpInput, SmtpSettings } from "@panel/api";
import { eq, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import { getDb, schema } from "./db";
import { decrypt, encrypt } from "./lib/crypto";

export const SMTP_KEY = "smtp";
export const SMTP_PASSWORD_KEY = "smtp_password_enc";

interface StoredSmtp {
  host: string;
  port: number;
  security: SmtpSettings["security"];
  username: string | null;
  from: string | null;
  fromName: string | null;
}

export interface SmtpConfig extends StoredSmtp {
  password: string | null;
}

const EMPTY: SmtpSettings = { host: null, port: 587, security: "starttls", username: null, passwordSet: false, from: null, fromName: null };

async function rows() {
  const r = await getDb().select().from(schema.settings).where(inArray(schema.settings.key, [SMTP_KEY, SMTP_PASSWORD_KEY]));
  return new Map(r.map((x) => [x.key, x.value]));
}

const isStored = (v: unknown): v is StoredSmtp => !!v && typeof v === "object" && typeof (v as StoredSmtp).host === "string" && typeof (v as StoredSmtp).port === "number";

/** Volledige configuratie (met wachtwoord) of null als SMTP niet is ingesteld. */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const m = await rows();
  const v = m.get(SMTP_KEY);
  if (!isStored(v) || !v.host) return null;
  const enc = m.get(SMTP_PASSWORD_KEY);
  let password: string | null = null;
  if (typeof enc === "string") {
    try {
      password = decrypt(enc);
    } catch {
      password = null;
    }
  }
  return { ...v, password };
}

/** Wat de admin ziet (zonder wachtwoord). */
export async function getSmtpSettings(): Promise<SmtpSettings> {
  const m = await rows();
  const v = m.get(SMTP_KEY);
  if (!isStored(v) || !v.host) return EMPTY;
  return { host: v.host, port: v.port, security: v.security, username: v.username, passwordSet: typeof m.get(SMTP_PASSWORD_KEY) === "string", from: v.from, fromName: v.fromName };
}

export async function setSmtpSettings(input: SmtpInput): Promise<SmtpSettings> {
  const db = getDb();
  if (input.host === null) {
    await db.delete(schema.settings).where(inArray(schema.settings.key, [SMTP_KEY, SMTP_PASSWORD_KEY]));
    return EMPTY;
  }
  const value: StoredSmtp = { host: input.host, port: input.port, security: input.security, username: input.username?.trim() || null, from: input.from, fromName: input.fromName?.trim() || null };
  await db.insert(schema.settings).values({ key: SMTP_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  if (input.password === null || input.password === "") await db.delete(schema.settings).where(eq(schema.settings.key, SMTP_PASSWORD_KEY));
  else if (input.password !== undefined) {
    const enc = encrypt(input.password);
    await db.insert(schema.settings).values({ key: SMTP_PASSWORD_KEY, value: enc }).onConflictDoUpdate({ target: schema.settings.key, set: { value: enc, updatedAt: new Date() } });
  }
  return getSmtpSettings();
}

export interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Vervangbaar in tests (bv. om een fout te forceren); standaard nodemailer. */
export const mailTransport = {
  create: (c: SmtpConfig) =>
    nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.security === "tls",
      requireTLS: c.security === "starttls",
      ignoreTLS: c.security === "none",
      auth: c.username ? { user: c.username, pass: c.password ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: "TLSv1.2" },
    }),
};

export class SmtpNotConfigured extends Error {
  constructor() {
    super("SMTP is not configured");
  }
}

const header = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

/** Verstuurt één mail; gooit bij een fout (de wachtrij beslist over opnieuw proberen). */
export async function sendMail(m: Mail, cfg?: SmtpConfig | null): Promise<void> {
  const c = cfg ?? (await getSmtpConfig());
  if (!c) throw new SmtpNotConfigured();
  const from = c.from ?? c.username;
  if (!from) throw new Error("no sender address configured");
  const t = mailTransport.create(c);
  try {
    await t.sendMail({
      from: c.fromName ? { name: header(c.fromName), address: from } : from,
      to: m.to,
      subject: header(m.subject).slice(0, 200),
      text: m.text,
      html: m.html,
      headers: { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" },
    });
  } finally {
    t.close();
  }
}

/** Een fout van de SMTP-server die opnieuw proberen niet oplost (5xx: adres bestaat niet, login fout). */
export function isPermanentMailError(e: unknown): boolean {
  const x = e as { responseCode?: number; code?: string };
  if (e instanceof SmtpNotConfigured) return true;
  if (x?.code === "EAUTH" || x?.code === "EENVELOPE") return true;
  return typeof x?.responseCode === "number" && x.responseCode >= 500 && x.responseCode < 600;
}

/** Korte, leesbare fout voor de admin (zonder wachtwoorden). */
export function mailErrorText(e: unknown): string {
  const x = e as { message?: string; code?: string };
  return `${x?.code ? `${x.code}: ` : ""}${(x?.message ?? String(e)).slice(0, 300)}`;
}
