/** Templates uit TEMPLATES_DIR/{game,web}/*.yaml inlezen en in de database bijwerken. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTemplate, type TemplateSpec } from "@panel/api";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";

export function templateRow(spec: TemplateSpec, yaml: string) {
  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description ?? null,
    type: spec.type,
    image: spec.image,
    startup: spec.startup,
    stop: spec.stop,
    readyPattern: spec.ready_pattern,
    httpPort: spec.http_port ?? null,
    variables: spec.variables.map((v) => ({
      key: v.key,
      name: v.name,
      ...(v.description !== undefined ? { description: v.description } : {}),
      default: v.default,
      user_editable: v.user_editable,
      ...(v.pattern !== undefined ? { pattern: v.pattern } : {}),
    })),
    installImage: spec.install.image,
    installScript: spec.install.script,
    configFiles: spec.config_files,
    version: spec.version,
    sourceYaml: yaml,
  };
}

export interface TemplateLoadResult {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  errors: string[];
}

/** Nieuw → invoegen; bestaand met hogere `version` → bijwerken; anders niets. */
export async function upsertTemplate(spec: TemplateSpec, yaml: string): Promise<"inserted" | "updated" | "unchanged"> {
  const db = getDb();
  const row = templateRow(spec, yaml);
  const [existing] = await db.select({ id: schema.templates.id, version: schema.templates.version }).from(schema.templates).where(eq(schema.templates.slug, spec.slug));
  if (!existing) {
    const ins = await db.insert(schema.templates).values(row).onConflictDoNothing().returning({ id: schema.templates.id });
    return ins.length ? "inserted" : "unchanged";
  }
  if (spec.version <= existing.version) return "unchanged";
  await db.update(schema.templates).set({ ...row, updatedAt: new Date() }).where(eq(schema.templates.id, existing.id));
  return "updated";
}

export async function loadTemplatesFromDir(dir: string): Promise<TemplateLoadResult> {
  const res: TemplateLoadResult = { inserted: [], updated: [], unchanged: [], errors: [] };
  for (const kind of ["game", "web"] as const) {
    let files: string[];
    try {
      files = (await readdir(join(dir, kind))).filter((f) => /\.ya?ml$/.test(f)).sort();
    } catch {
      continue; // map bestaat niet
    }
    for (const f of files) {
      const path = join(dir, kind, f);
      const yaml = await readFile(path, "utf8");
      const parsed = parseTemplate(yaml);
      if (!parsed.ok) {
        res.errors.push(`${kind}/${f}: ${parsed.errors.join("; ")}`);
        continue;
      }
      if (parsed.spec.type !== kind) {
        res.errors.push(`${kind}/${f}: type ${parsed.spec.type} does not belong in ${kind}/`);
        continue;
      }
      const r = await upsertTemplate(parsed.spec, yaml);
      res[r].push(parsed.spec.slug);
    }
  }
  return res;
}
