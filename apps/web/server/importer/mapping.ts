/**
 * Mapping van de import: eggs → templates (voorstel op naam, docker-image, startcommando en variabelen),
 * een egg omzetten naar template-YAML (templates/SCHEMA.md), en gebruikers → accounts (Discord-ID, e-mail, naam).
 */
import { BUILTIN_VARIABLES, parseTemplate } from "@panel/api";
import { stringify } from "yaml";
import type { SrcEgg } from "./source";

export interface TemplateLite {
  id: number;
  slug: string;
  name: string;
  type: "game" | "web";
  image: string;
  startup: string;
  variables: Array<{ key: string }>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length > 1));
const repo = (img: string) => img.replace(/[:@].*$/, "").toLowerCase();
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const startupTokens = (s: string) => tokens(s.replace(/\{\{[^}]*\}\}|\$\{[^}]*\}|-X[a-z]+\S*/gi, " "));

/** Score 0–100 van een template voor een egg, met de redenen. */
export function scoreTemplate(egg: SrcEgg, t: TemplateLite): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const en = norm(egg.name);
  const names = [norm(t.name), norm(t.slug.replace(/-/g, " "))];
  if (names.includes(en)) {
    score += 60;
    reasons.push("name");
  } else if (names.some((n) => n && en && (n.includes(en) || en.split(" ").includes(n)))) {
    score += 40;
    reasons.push("name");
  } else {
    const j = Math.max(...names.map((n) => jaccard(tokens(n), tokens(en))));
    if (j > 0) {
      score += Math.round(30 * j);
      reasons.push("name");
    }
  }
  if (egg.dockerImages.some((i) => i.toLowerCase() === t.image.toLowerCase())) {
    score += 25;
    reasons.push("image");
  } else if (egg.dockerImages.some((i) => repo(i) === repo(t.image))) {
    score += 15;
    reasons.push("image");
  }
  const sj = jaccard(startupTokens(egg.startup), startupTokens(t.startup));
  if (sj > 0.2) {
    score += Math.round(15 * sj);
    reasons.push("startup");
  }
  const keys = new Set(t.variables.map((v) => v.key));
  const shared = egg.variables.filter((v) => keys.has(v.key)).length;
  if (shared) {
    score += Math.min(10, shared * 5);
    reasons.push("variables");
  }
  return { score: Math.min(100, score), reasons };
}

export function suggestTemplate(egg: SrcEgg, templates: TemplateLite[]) {
  let best: { templateId: number; templateName: string; score: number; reasons: string[] } | null = null;
  for (const t of templates) {
    if (t.type !== "game") continue;
    const s = scoreTemplate(egg, t);
    if (s.score > 0 && (!best || s.score > best.score)) best = { templateId: t.id, templateName: t.name, score: s.score, reasons: s.reasons };
  }
  return best;
}

/** Drempel waarboven het voorstel automatisch gekozen wordt. */
export const AUTO_SCORE = 50;

// ---------- egg → template-YAML ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VAR_RE = /^[A-Z][A-Z0-9_]*$/;
export const varKey = (k: string) => {
  const s = k.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^[^A-Z]+/, "");
  return s || "VAR";
};

/** Pterodactyl-placeholders in config-bestanden naar die van dit panel. */
export function convertPlaceholders(v: string): string {
  return v
    .replace(/\{\{\s*server\.build\.default\.port\s*\}\}/g, "{{SERVER_PORT}}")
    .replace(/\{\{\s*server\.build\.default\.ip\s*\}\}/g, "{{SERVER_IP}}")
    .replace(/\{\{\s*server\.build\.memory\s*\}\}/g, "{{SERVER_MEMORY}}")
    .replace(/\{\{\s*server\.build\.env\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => `{{${varKey(k)}}}`)
    .replace(/\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g, (_m, k: string) => `{{${varKey(k)}}}`)
    .replace(/\{\{\s*config\.docker\.interface\s*\}\}/g, "0.0.0.0");
}

/** Laravel-validatieregels (bv. `required|string|in:a,b`) naar een regex voor `pattern`, als dat eenduidig kan. */
export function rulesToPattern(rules: string): string | undefined {
  const parts = rules.split("|").map((r) => r.trim());
  const nullable = parts.includes("nullable") || !parts.includes("required");
  const wrap = (re: string) => (nullable ? `^(${re})?$` : `^(${re})$`);
  const regex = parts.find((r) => r.startsWith("regex:"));
  if (regex) {
    const m = /^regex:\/(.*)\/[a-z]*$/.exec(regex);
    if (m) return m[1]!.startsWith("^") ? m[1]! : `^(${m[1]})$`;
  }
  const inRule = parts.find((r) => r.startsWith("in:"));
  if (inRule) return wrap(inRule.slice(3).split(",").map(escapeRe).join("|"));
  if (parts.includes("boolean")) return wrap("0|1|true|false");
  if (parts.includes("integer") || parts.includes("numeric")) return wrap("-?\\d+");
  return undefined;
}

export function slugFor(egg: SrcEgg): string {
  const base = norm(egg.name).replace(/ /g, "-").slice(0, 40) || "egg";
  return `egg-${base}`.replace(/-+$/, "");
}

/** Template-YAML uit een egg + wat de admin moet nakijken (als YAML-commentaar bovenaan). */
export function eggToTemplateYaml(egg: SrcEgg, kind: string): { yaml: string; errors: string[]; notes: string[] } {
  const notes: string[] = [];
  const builtins = new Set<string>(BUILTIN_VARIABLES);
  const variables = [];
  for (const v of egg.variables) {
    const key = varKey(v.key);
    if (key !== v.key) notes.push(`variable ${v.key} renamed to ${key}`);
    if (builtins.has(key)) {
      notes.push(`variable ${key} is built in and was left out`);
      continue;
    }
    const pattern = rulesToPattern(v.rules);
    variables.push({ key, name: v.name || key, ...(v.description ? { description: v.description } : {}), default: v.default, user_editable: v.userEditable, ...(pattern ? { pattern } : {}) });
  }
  const stop = !egg.stop || egg.stop.startsWith("^") ? { type: "signal", value: egg.stop === "^X" ? "SIGTERM" : "SIGINT" } : { type: "command", value: egg.stop };
  const ready = egg.done.length ? egg.done.map(escapeRe).join("|") : ".";
  if (!egg.done.length) notes.push("no 'done' text in the egg: the server counts as online on the first output line");
  const config_files = [];
  for (const [path, f] of Object.entries(egg.configFiles ?? {})) {
    const parser = f.parser ?? "file";
    const format = parser === "properties" || parser === "yaml" || parser === "json" ? parser : null;
    if (!format) {
      notes.push(`config file ${path} (parser ${parser}) is not supported and was left out`);
      continue;
    }
    const set: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.find ?? {})) {
      if (/[*[\]]/.test(k) || typeof v === "object") {
        notes.push(`config key ${path}:${k} uses wildcards or nested matches and was left out`);
        continue;
      }
      set[k] = convertPlaceholders(String(v));
    }
    if (Object.keys(set).length) config_files.push({ path, format, set });
  }
  // Eggs installeren naar /mnt/server; hier is dat /home/container. Bash-scripts via bash laten draaien.
  let script = (egg.install.script || "echo 'nothing to install'").replace(/\r\n/g, "\n").replace(/\/mnt\/server/g, "/home/container");
  if (/bash/.test(egg.install.entry)) {
    script = `#!/bin/sh\nset -e\ncat > /tmp/egg-install.sh <<'__EGG_INSTALL__'\n${script}\n__EGG_INSTALL__\nexec bash /tmp/egg-install.sh\n`;
    notes.push("the install script runs with bash: the install image must contain bash");
  }
  const image = egg.dockerImages[0] ?? "eclipse-temurin:21-jre";
  if (egg.dockerImages.length > 1) notes.push(`the egg offers ${egg.dockerImages.length} images; the first (${image}) was taken`);
  notes.push("check that the image runs as a non-root user (uid 1000)");
  const spec = {
    schema: 1,
    slug: slugFor(egg),
    name: egg.name || "Imported egg",
    description: `${egg.description ? `${egg.description.trim()} ` : ""}(imported from ${kind} egg "${egg.name}")`.slice(0, 500),
    type: "game",
    version: 1,
    image,
    startup: egg.startup || "./start.sh",
    stop,
    ready_pattern: ready,
    variables,
    install: { image: egg.install.container || "alpine:3.20", script },
    config_files,
  };
  const yaml = `# Converted from ${kind} egg "${egg.name}". Review before saving:\n${notes.map((n) => `# - ${n}\n`).join("")}${stringify(spec, { lineWidth: 0 })}`;
  const r = parseTemplate(yaml);
  return { yaml, errors: r.ok ? [] : r.errors, notes };
}

// ---------- variabelen ----------

/** Waarden van de bron naar de variabelen van de template: alleen sleutels die de template kent; de rest valt weg. */
export function mapVariables(src: Record<string, string>, template: { variables: Array<{ key: string; pattern?: string }> }): { values: Record<string, string>; dropped: string[]; invalid: string[] } {
  const keys = new Map(template.variables.map((v) => [v.key, v]));
  const values: Record<string, string> = {};
  const dropped: string[] = [];
  const invalid: string[] = [];
  for (const [k0, v] of Object.entries(src)) {
    const k = VAR_RE.test(k0) ? k0 : varKey(k0);
    const def = keys.get(k);
    if (!def) {
      dropped.push(k0);
      continue;
    }
    if (def.pattern) {
      let ok = true;
      try {
        ok = new RegExp(`^(?:${def.pattern})$`).test(v);
      } catch {
        ok = true;
      }
      if (!ok) {
        invalid.push(k);
        continue;
      }
    }
    values[k] = v;
  }
  return { values, dropped, invalid };
}
