/** Rendering and parsing of the panel-managed PHP ini and nginx include for PHP websites. */
import type { PhpSettings } from "@panel/api";

export const PHP_INI_PATH = "/php/00-panel.ini";
export const NGINX_CONF_PATH = "/nginx/00-panel.conf";
export const DISABLED_EXT_PATH = "/php/.disabled-extensions";
export const PHP_EXTENSIONS = ["gd", "intl", "exif", "mysqli"] as const;

export const PHP_DEFAULTS: PhpSettings = {
  memoryLimitMb: 256,
  uploadMaxMb: 64,
  maxExecutionTime: 120,
  maxInputVars: 3000,
  displayErrors: false,
  timezone: "Europe/Amsterdam",
  opcache: true,
  disabledExtensions: [],
};

const MARK = "; Managed by the panel (Settings > PHP). Do not edit: changes are overwritten when the settings are saved.\n; Put your own settings in another file in this folder, for example 50-custom.ini.\n";

export function renderPhpIni(s: PhpSettings): string {
  return (
    MARK +
    `memory_limit = ${s.memoryLimitMb}M\n` +
    `upload_max_filesize = ${s.uploadMaxMb}M\n` +
    `post_max_size = ${s.uploadMaxMb}M\n` +
    `max_execution_time = ${s.maxExecutionTime}\n` +
    `max_input_vars = ${s.maxInputVars}\n` +
    `display_errors = ${s.displayErrors ? "On" : "Off"}\n` +
    `date.timezone = ${s.timezone}\n` +
    `opcache.enable = ${s.opcache ? 1 : 0}\n`
  );
}

export function renderNginxConf(s: PhpSettings): string {
  return `# Managed by the panel (Settings > PHP): follows upload_max_filesize. Do not edit.\nclient_max_body_size ${s.uploadMaxMb}M;\n`;
}

export function renderDisabledExtensions(s: PhpSettings): string {
  return s.disabledExtensions.join("\n") + (s.disabledExtensions.length ? "\n" : "");
}

const mb = (v: string | undefined): number | undefined => {
  const m = /^(\d+)\s*([MG])$/i.exec(v?.trim() ?? "");
  return m ? Number(m[1]) * (m[2]!.toUpperCase() === "G" ? 1024 : 1) : undefined;
};
const int = (v: string | undefined): number | undefined => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

/** Reads values back from a managed ini; unknown or missing keys keep the fallback. */
export function parsePhpIni(text: string, fallback: PhpSettings): PhpSettings {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith(";")) kv.set(m[1]!, m[2]!);
  }
  const on = (k: string, d: boolean) => (kv.has(k) ? /^(on|1|true)$/i.test(kv.get(k)!) : d);
  return {
    ...fallback,
    memoryLimitMb: mb(kv.get("memory_limit")) ?? fallback.memoryLimitMb,
    uploadMaxMb: mb(kv.get("upload_max_filesize")) ?? fallback.uploadMaxMb,
    maxExecutionTime: int(kv.get("max_execution_time")) ?? fallback.maxExecutionTime,
    maxInputVars: int(kv.get("max_input_vars")) ?? fallback.maxInputVars,
    displayErrors: on("display_errors", fallback.displayErrors),
    timezone: kv.get("date.timezone") || fallback.timezone,
    opcache: on("opcache.enable", fallback.opcache),
  };
}

export function parseDisabledExtensions(text: string): PhpSettings["disabledExtensions"] {
  const set = new Set(text.split(/\s+/).filter(Boolean));
  return PHP_EXTENSIONS.filter((e) => set.has(e));
}

export function validTimezone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
