/**
 * Template + servervariabelen + limieten + allocations → ServerSpec voor de daemon.
 * `{{VAR}}` laat het panel staan; de daemon vervangt die (startup en config_files).
 */
import { parseTemplate, type DaemonServerSpec, type Limits } from "@panel/api";
import type { schema } from "./db";

type TemplateRow = typeof schema.templates.$inferSelect;
type TemplateVar = TemplateRow["variables"][number];

export interface SpecAllocation {
  ip: string;
  port: number;
  isPrimary: boolean;
}

export interface SpecInput {
  uuid: string;
  template: TemplateRow;
  variables: Record<string, string>;
  limits: Limits;
  allocations: SpecAllocation[];
  startOnInstall?: boolean;
  skipInstall?: boolean;
  /** Slaapstand van de server (servers.sleep_enabled / sleep_idle_minutes). */
  sleep?: { enabled: boolean; idleMinutes: number };
}

const sleepCache = new Map<string, boolean>();
/**
 * sleep_capable uit de template. De templates-tabel heeft er (nog) geen kolom voor, dus uit de
 * opgeslagen YAML (gecachet per template-id + versie).
 */
export function templateSleepCapable(t: Pick<TemplateRow, "id" | "version" | "sourceYaml" | "type">): boolean {
  if (t.type !== "game") return false;
  const k = `${t.id}:${t.version}`;
  let v = sleepCache.get(k);
  if (v === undefined) {
    const r = parseTemplate(t.sourceYaml);
    v = r.ok && r.spec.sleep_capable === true;
    sleepCache.set(k, v);
  }
  return v;
}

export const SLEEP_MOTD = "Server is sleeping - join to start it";
export const SLEEP_KICK = "The server is starting, please reconnect in a minute.";

/** Spec-veld `sleep`: alleen als aan én de template het ondersteunt. */
export function sleepSpec(t: Parameters<typeof templateSleepCapable>[0], sleep?: SpecInput["sleep"]): DaemonServerSpec["sleep"] {
  if (!sleep?.enabled || !templateSleepCapable(t)) return null;
  return { idle_minutes: sleep.idleMinutes, motd: SLEEP_MOTD, kick_message: SLEEP_KICK };
}

/** Waarden per variabele: opgeslagen waarde, anders de default uit de template. */
export function resolveVariables(vars: TemplateVar[], stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of vars) out[v.key] = stored[v.key] ?? v.default;
  return out;
}

/** Controleert nieuwe waarden; geeft foutmeldingen terug (leeg = goed). */
export function validateVariables(vars: TemplateVar[], values: Record<string, string>, opts: { onlyUserEditable: boolean }): string[] {
  const errors: string[] = [];
  const byKey = new Map(vars.map((v) => [v.key, v]));
  for (const [k, val] of Object.entries(values)) {
    const v = byKey.get(k);
    if (!v) {
      errors.push(`${k}: unknown variable`);
      continue;
    }
    if (opts.onlyUserEditable && !v.user_editable) errors.push(`${k}: cannot be changed by the user`);
    if (val.length > 2000) errors.push(`${k}: te lang`);
    if (v.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(`^(?:${v.pattern})$`);
      } catch {
        errors.push(`${k}: pattern in the template is invalid`);
      }
      if (re && !re.test(val)) errors.push(`${k}: does not match ${v.pattern}`);
    }
  }
  return errors;
}

export function buildServerSpec(i: SpecInput): DaemonServerSpec {
  const t = i.template;
  const allocations = [...i.allocations]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.port - b.port)
    .map((a, idx) => ({ ip: a.ip, port: a.port, primary: idx === 0 }));
  return {
    uuid: i.uuid,
    type: t.type,
    image: t.image,
    startup: t.startup,
    stop: { type: t.stop.type, value: t.stop.value },
    ready_pattern: t.readyPattern,
    environment: resolveVariables(t.variables, i.variables),
    limits: { cpu_pct: i.limits.cpuPct, memory_mb: i.limits.ramMb, swap_mb: i.limits.swapMb, disk_mb: i.limits.diskMb, pids: 512 },
    allocations: t.type === "web" ? [] : allocations,
    http_port: t.type === "web" ? (t.httpPort ?? null) : null,
    install: { image: t.installImage, script: t.installScript },
    config_files: t.configFiles.map((c) => ({ path: c.path, format: c.format, set: { ...c.set } })),
    start_on_install: i.startOnInstall ?? false,
    skip_install: i.skipInstall ?? false,
    sleep: sleepSpec(t, i.sleep),
  };
}
