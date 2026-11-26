/** Instellingen in de tabel `settings` (panelnaam, logo, kleur, standaardlimieten). */
import type { Limits, Settings } from "@panel/api";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "./db";

export const SETTING_DEFAULTS = {
  panel_name: "Panel",
  logo_url: "", // leeg = geen logo (JSON-null wordt SQL-NULL)
  accent_color: "#22c55e",
  default_limits: { cpuPct: 200, ramMb: 2048, swapMb: 0, diskMb: 10_240 } satisfies Limits,
};

export async function ensureSettingDefaults(): Promise<void> {
  await getDb()
    .insert(schema.settings)
    .values(Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value: value as unknown })))
    .onConflictDoNothing();
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
  };
}
