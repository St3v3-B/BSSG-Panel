/**
 * Formaat van een template-YAML (zie templates/SCHEMA.md voor uitleg en voorbeeld).
 * Eigenaar: orchestrator.
 */
import { z } from "zod";
import { parse } from "yaml";
import { TemplatePlayerEvents, playerEventErrors } from "./player-activity";

const VarKey = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "variabelen in HOOFDLETTERS_MET_UNDERSCORES");

/** Variabelen die de daemon altijd zelf zet; templates mogen ze niet definiëren. */
export const BUILTIN_VARIABLES = ["SERVER_UUID", "SERVER_MEMORY", "SERVER_IP", "SERVER_PORT", "TZ"] as const;

/** Protocol van een poort: Docker publiceert tcp, udp of beide. */
export const PortProtocol = z.enum(["tcp", "udp", "both"]);
export type PortProtocol = z.infer<typeof PortProtocol>;

/**
 * Poorten van een game-template (zie templates/SCHEMA.md, "Ports"). Eerste = primaire allocation (`SERVER_PORT`);
 * de rest zijn extra allocations (query, RCON, ...) waarvan het panel de poort in `env` zet.
 */
export const TemplatePort = z.object({
  env: VarKey,
  name: z.string().min(1).optional(),
  protocol: PortProtocol.default("both"),
  /** Gebruikelijke afstand tot de primaire poort; zonder passende allocation krijgt `env` primair + offset (niet gepubliceerd). */
  offset: z.number().int().min(1).max(10000).optional(),
  /** Het spel leidt de poort zelf af (primair + offset): alleen een allocation met precies die poort telt. */
  exact: z.boolean().default(false),
  /** Zonder deze poort werkt de server niet: het panel weigert aanmaken met te weinig allocations. */
  required: z.boolean().default(false),
});
export type TemplatePort = z.infer<typeof TemplatePort>;

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
      /** timeout: seconden tot de daemon de container killt (standaard 30). */
      z.object({ type: z.literal("command"), value: z.string().min(1), timeout: z.number().int().min(5).max(600).optional() }),
      z.object({ type: z.literal("signal"), value: z.enum(["SIGTERM", "SIGINT", "SIGKILL", "SIGQUIT"]), timeout: z.number().int().min(5).max(600).optional() }),
    ]),
    /** Regex op stdout; eerste match zet de status op online. */
    ready_pattern: z.string().min(1),
    /** Alleen web: poort waarop de container HTTP serveert (Caddy-upstream). */
    http_port: z.number().int().min(1).max(65535).optional(),
    /** Minecraft Java-server die de daemon kan laten slapen (status-ping + login op de primaire poort). */
    sleep_capable: z.boolean().default(false),
    /**
     * Naam van een omgevingsvariabele in de image-config (bv. `PHP_VERSION`) waarvan major.minor gelijk moet
     * blijven voor een automatische image-update. Verschilt hij tussen oude en nieuwe image, dan is een
     * herinstallatie nodig (extensies zijn tegen de oude minor gebouwd) en meldt de daemon alleen.
     */
    image_version_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
    /**
     * Speleractiviteit: `minecraft` of `velocity` (presets), `none`, of eigen RE2-patronen `{join, leave, uuid?}` met
     * groepen `(?<name>…)` (en `(?<uuid>…)`). Ontbreekt: standaard per slug (Paper/Folia/Fabric/… minecraft, Velocity velocity).
     */
    player_events: TemplatePlayerEvents.optional(),
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
      /** Maximale duur in minuten (standaard 30 van de daemon); grote SteamCMD-downloads hebben meer nodig. */
      timeout_minutes: z.number().int().min(1).max(720).optional(),
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
    /** Aanbevolen limieten (standaard in het aanmaakformulier van de admin). */
    recommended: z.object({ memory_mb: z.number().int().min(64).optional(), disk_mb: z.number().int().min(0).optional() }).optional(),
    /** Alleen game: poorten met protocol; leeg = elke allocation tcp + udp (zoals voorheen). */
    ports: z.array(TemplatePort).default([]),
  })
  .superRefine((t, ctx) => {
    for (const v of t.variables) {
      if ((BUILTIN_VARIABLES as readonly string[]).includes(v.key))
        ctx.addIssue({ code: "custom", message: `${v.key} is built in and may not be defined as a variable`, path: ["variables"] });
    }
    for (const e of playerEventErrors(t.player_events)) ctx.addIssue({ code: "custom", message: e, path: ["player_events"] });
    if (t.ports.length) {
      if (t.type === "web") ctx.addIssue({ code: "custom", message: "web templates have no ports", path: ["ports"] });
      const [first, ...extra] = t.ports;
      if (first!.env !== "SERVER_PORT" || first!.offset !== undefined || first!.exact || first!.required)
        ctx.addIssue({ code: "custom", message: "ports[0] is the primary port: env SERVER_PORT, without offset/exact/required", path: ["ports", 0] });
      const seen = new Set<string>(t.variables.map((v) => v.key));
      extra.forEach((p, i) => {
        if ((BUILTIN_VARIABLES as readonly string[]).includes(p.env) || seen.has(p.env))
          ctx.addIssue({ code: "custom", message: `${p.env} is built in, a variable or already a port`, path: ["ports", i + 1, "env"] });
        seen.add(p.env);
        if (p.offset === undefined) ctx.addIssue({ code: "custom", message: "extra ports require offset", path: ["ports", i + 1, "offset"] });
      });
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
