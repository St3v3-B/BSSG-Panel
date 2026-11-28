/** OpenAPI 3.1-document van /api/v1, afgeleid van de routetabel en de zod-schema's uit het contract. */
import { z } from "zod";
import { REST_ROUTES, type RestRoute } from "./routes";

type Json = Record<string, unknown>;

function schemaOf(t: z.ZodType, io: "input" | "output"): Json {
  const s = z.toJSONSchema(t, {
    io,
    unrepresentable: "any",
    override: (c) => {
      const def = (c.zodSchema as unknown as { _zod: { def: { type: string } } })._zod.def;
      if (def.type === "date") {
        c.jsonSchema.type = "string";
        c.jsonSchema.format = "date-time";
      }
    },
  }) as Json;
  delete s.$schema;
  return s;
}

const ERROR = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string", description: "tRPC error code, e.g. UNAUTHORIZED, FORBIDDEN, NOT_FOUND, BAD_REQUEST, TOO_MANY_REQUESTS" },
    message: { type: "string", description: "Machine-readable reason, e.g. `MISSING_PERMISSION: power`, `DAEMON_UNREACHABLE`, `DISK_EXCEEDED`" },
  },
};

function operation(r: RestRoute): Json {
  const params: Json[] = [];
  for (const m of r.path.matchAll(/\{(\w+)\}/g)) {
    const name = m[1]!;
    params.push({ name, in: "path", required: true, schema: name === "uuid" ? { type: "string", format: "uuid" } : { type: "integer" } });
  }
  if (r.query) {
    const qs = schemaOf(r.query, "input") as { properties?: Record<string, Json>; required?: string[] };
    for (const [name, schema] of Object.entries(qs.properties ?? {})) {
      const { description, ...rest } = schema as Json & { description?: string };
      params.push({ name, in: "query", required: (qs.required ?? []).includes(name) && !("default" in rest), schema: rest, ...(description ? { description } : {}) });
    }
  }
  const responses: Json = {
    [String(r.status ?? 200)]: { description: "OK", content: { "application/json": { schema: schemaOf(r.output, "output") } } },
    "400": { $ref: "#/components/responses/Error" },
    "401": { $ref: "#/components/responses/Error" },
    "403": { $ref: "#/components/responses/Error" },
    "404": { $ref: "#/components/responses/Error" },
    "429": { $ref: "#/components/responses/RateLimited" },
  };
  const op: Json = {
    operationId: r.operationId,
    tags: [r.tag],
    summary: r.summary,
    description: r.permission ? `Requires the permission \`${r.permission}\` on the server (and in the key's scopes).` : "Requires access to the server (owner or subuser).",
    "x-permission": r.permission,
    parameters: params,
    responses,
  };
  if (r.body) {
    op.requestBody = {
      required: true,
      content: r.bodyKind === "text" ? { "text/plain": { schema: { type: "string" } } } : { "application/json": { schema: schemaOf(r.body, "input") } },
    };
  }
  return op;
}

export function buildOpenApi(baseUrl: string): Json {
  const paths: Record<string, Json> = {};
  for (const r of REST_ROUTES) {
    paths[r.path] ??= {};
    paths[r.path]![r.method.toLowerCase()] = operation(r);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Panel API",
      version: "1.0.0",
      description:
        "Scriptable access to your servers with an API key (Account → API keys). Send `Authorization: Bearer <key>`. " +
        "Permissions are exactly those in the panel: your own servers plus servers where you are a subuser, " +
        "intersected with the key's scopes and (optionally) limited to the key's servers. Keys never reach admin functions. " +
        "Rate limit: 120 requests per minute per key (429 with Retry-After). Errors are JSON `{error, message}`.",
    },
    servers: [{ url: `${baseUrl.replace(/\/+$/, "")}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [{ name: "account" }, { name: "servers" }, { name: "files" }, { name: "backups" }, { name: "databases" }],
    paths,
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: "API key from Account → API keys" } },
      schemas: { Error: ERROR },
      responses: {
        Error: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        RateLimited: {
          description: "Too many requests for this key",
          headers: { "Retry-After": { schema: { type: "integer" } } },
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  };
}
