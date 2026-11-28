/** Instellingen in de tabel `settings` (panelnaam, logo, kleur, standaardlimieten). */
import type { ImagePolicy, ImageUpdateSettings, Limits, Settings } from "@panel/api";
import { eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { DEFAULT_PROMO, setSleepMotdConfig, type SleepMotdConfig } from "./sleep-motd";

export const SETTING_DEFAULTS = {
  panel_name: "Panel",
  logo_url: "", // leeg = geen logo (JSON-null wordt SQL-NULL)
  accent_color: "#22c55e",
  default_limits: { cpuPct: 200, ramMb: 2048, swapMb: 0, diskMb: 10_240 } satisfies Limits,
  image_update_default_policy: "notify" as ImagePolicy,
  image_update_window: { start: "04:00", end: "05:00" },
  sleep_motd_promo: DEFAULT_PROMO,
  sleep_motd_show_logo: true,
  sleep_motd_seed_logo: true,
  activity_retention_days: 90,
  terminal_enabled: true,
};

/** Webterminal/SSH-shell globaal aan (setting terminal_enabled, standaard aan). */
export async function getTerminalEnabled(): Promise<boolean> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "terminal_enabled"));
  return typeof r?.value === "boolean" ? r.value : SETTING_DEFAULTS.terminal_enabled;
}

export const DEFAULT_ACTIVITY_RETENTION_DAYS = SETTING_DEFAULTS.activity_retention_days;

/** Bewaartermijn van het activiteitenlog in dagen (0 = altijd). */
export async function getActivityRetentionDays(): Promise<number> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, "activity_retention_days"));
  const n = r?.value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : DEFAULT_ACTIVITY_RETENTION_DAYS;
}

/** MOTD-instellingen uit de DB; ververst ook de cache die buildServerSpec gebruikt. */
export async function getSleepMotdSettings(): Promise<SleepMotdConfig> {
  const rows = await getDb()
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, ["sleep_motd_promo", "sleep_motd_show_logo", "sleep_motd_seed_logo"]));
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const promo = m.get("sleep_motd_promo");
  const c: SleepMotdConfig = {
    promo: typeof promo === "string" ? promo : SETTING_DEFAULTS.sleep_motd_promo,
    showLogoIcon: typeof m.get("sleep_motd_show_logo") === "boolean" ? (m.get("sleep_motd_show_logo") as boolean) : true,
    seedLogoIcon: typeof m.get("sleep_motd_seed_logo") === "boolean" ? (m.get("sleep_motd_seed_logo") as boolean) : true,
  };
  setSleepMotdConfig(c);
  return c;
}

const POLICIES: readonly string[] = ["auto", "notify", "off"];

/** Globale instellingen voor image-updates (standaardbeleid en onderhoudsvenster, Europe/Amsterdam). */
export async function getImageUpdateSettings(): Promise<ImageUpdateSettings> {
  const rows = await getDb()
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, ["image_update_default_policy", "image_update_window"]));
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const pol = m.get("image_update_default_policy");
  const win = (m.get("image_update_window") ?? {}) as { start?: unknown; end?: unknown };
  const clock = (v: unknown, d: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  return {
    defaultPolicy: typeof pol === "string" && POLICIES.includes(pol) ? (pol as ImagePolicy) : SETTING_DEFAULTS.image_update_default_policy,
    windowStart: clock(win.start, SETTING_DEFAULTS.image_update_window.start),
    windowEnd: clock(win.end, SETTING_DEFAULTS.image_update_window.end),
  };
}

export async function ensureSettingDefaults(): Promise<void> {
  await getDb()
    .insert(schema.settings)
    .values(Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value: value as unknown })))
    .onConflictDoNothing();
  await getSleepMotdSettings();
}

export async function getSettings(): Promise<Settings> {
  const rows = await getDb()
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, Object.keys(SETTING_DEFAULTS)));
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const str = (k: string, d: string) => (typeof m.get(k) === "string" ? (m.get(k) as string) : d);
  const logo = m.get("logo_url");
  const accent = str("accent_color", SETTING_DEFAULTS.accent_color);
  const limits = m.get("default_limits") as Partial<Limits> | undefined;
  return {
    panelName: str("panel_name", SETTING_DEFAULTS.panel_name),
    logoUrl: typeof logo === "string" && logo ? logo : null,
    accentColor: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : SETTING_DEFAULTS.accent_color,
    defaultLimits: { ...SETTING_DEFAULTS.default_limits, ...(limits ?? {}) },
    imageUpdates: await getImageUpdateSettings(),
    sleepMotd: await getSleepMotdSettings(),
    activityRetentionDays: await getActivityRetentionDays(),
    terminalEnabled: typeof m.get("terminal_enabled") === "boolean" ? (m.get("terminal_enabled") as boolean) : SETTING_DEFAULTS.terminal_enabled,
  };
}
