/**
 * Formaat van een template-YAML (zie templates/SCHEMA.md voor uitleg en voorbeeld).
 * Eigenaar: orchestrator.
 */
import { z } from "zod";
import { parse } from "yaml";

const VarKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "variabelen in HOOFDLETTERS_MET_UNDERSCORES");

/** Variabelen die de daemon altijd zelf zet; templates mogen ze niet definiëren. */
export const BUILTIN_VARIABLES = ["SERVER_UUID", "SERVER_MEMORY", "SERVER_IP", "SERVER_PORT", "TZ"] as const;

export const TemplateSpec = z
  .object({
    schema: z.literal(1),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}$/),
    name: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(["game", "web"]),
    /** Verhoog bij elke wijziging; het panel werkt de template bij als versie > opgeslagen versie. */
    version: z.number().int().min(1),
    /** Runtime-image. Moet als niet-root user draaien (uid 1000 aanbevolen). */
    image: z.string().min(1),
    /** Startcommando, uitgevoerd met /bin/sh -c in /home/container. {{VAR}} wordt vervangen. */
    startup: z.string().min(1),
    stop: z.discriminatedUnion("type", [
      z.object({ type: z.literal("command"), value: z.string().min(1) }),
      z.object({ type: z.literal("signal"), value: z.enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGQUIT"]) }),
    ]),
    /** Regex op stdout; eerste match zet de status op online. */
    ready_pattern: z.string().min(1),
    /** Alleen web: poort waarop de container HTTP serveert (Caddy-upstream). */
    http_port: z.number().int().min(1).max(65535).optional(),
    /** Minecraft Java-server die de daemon kan laten slapen (status-ping + login op de primaire poort). */
    sleep_capable: z.boolean().default(false),
    variables: z
      .array(
        z.object({
          key: VarKey,
          name: z.string().min(1),
          description: z.string().optional(),
          default: z.string(),
          user_editable: z.boolean().default(false),
          /** Regex waaraan de waarde moet voldoen (volledige match). */
          pattern: z.string().optional(),
        }),
      )
      .default([]),
    install: z.object({
      /** Image voor het install-script; draait met dezelfde map op /home/container. */
      image: z.string().min(1),
      /** Shell-script, uitgevoerd met /bin/sh. Variabelen staan in de env. Exit 0 = gelukt. */
      script: z.string().min(1),
    }),
    /** Bestanden die de daemon vóór elke start bijwerkt (bv. server-port in server.properties). */
    config_files: z
      .array(
        z.object({
          path: z.string().min(1),
          format: z.enum(["properties", "yaml", "json", "toml"]),
          /** sleutel (bij yaml/json met punten genest) → waarde, {{VAR}} wordt vervangen */
          set: z.record(z.string(), z.string()),
        }),
      )
      .default([]),
  })
  .superRefine((t, ctx) => {
    for (const v of t.variables) {
      if ((BUILTIN_VARIABLES as readonly string[]).includes(v.key))
        ctx.addIssue({ code: "custom", message: `${v.key} is built in and may not be defined as a variable`, path: ["variables"] });
    }
    if (t.type === "web" && !t.http_port) ctx.addIssue({ code: "custom", message: "web templates require http_port", path: ["http_port"] });
  });

export type TemplateSpec = z.infer<typeof TemplateSpec>;

export function parseTemplate(yamlText: string): { ok: true; spec: TemplateSpec } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { ok: false, errors: [`YAML: ${(e as Error).message}`] };
  }
  const r = TemplateSpec.safeParse(raw);
  if (r.success) return { ok: true, spec: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
