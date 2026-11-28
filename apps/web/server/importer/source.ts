/**
 * Alleen-lezen client voor de Pterodactyl/Pelican-API's. Er bestaat bewust alleen `GET`: de bron wordt nooit
 * gewijzigd. Application API (`/api/application/...`, sleutel `ptla_`/`peli_`) voor gebruikers, nodes, eggs en servers;
 * optioneel de Client API (`/api/client/...`, sleutel `ptlc_`/`pacc_`) voor het downloaden van bestaande backups.
 *
 * Aangenomen API-vorm (Pterodactyl 1.x; Pelican 1.0 is hierop gebaseerd):
 * - lijsten: `{object: "list", data: [{object, attributes}], meta: {pagination: {current_page, total_pages}}}`,
 *   pagina's met `?page=N&per_page=100`;
 * - `GET /api/application/users` → attributes {id, external_id, uuid, username, email, first_name, last_name, root_admin};
 * - `GET /api/application/nodes` → {id, name, fqdn, scheme, daemon_sftp, daemon_listen};
 * - Pterodactyl: `GET /api/application/nests` + `GET /api/application/nests/{id}/eggs?include=variables`;
 *   Pelican: `GET /api/application/eggs?include=variables` (zonder nests; terugval naar nests als dat 404 geeft);
 *   egg: {id, name, description, docker_image, docker_images{label: image}, startup (Pelican ook startup_commands{}),
 *   config{files, startup{done}, stop}, script{install, entry, container}, relationships.variables};
 * - `GET /api/application/servers?include=allocations,variables` → {id, uuid, identifier, name, user, node, egg,
 *   suspended (of status "suspended"), allocation, limits{memory, swap, disk, cpu}, container{startup_command, image,
 *   environment}, relationships{allocations{data[{id, ip, port}]}, variables{data[{env_variable, server_value, default_value}]}}};
 * - Client API: `GET /api/client/servers/{identifier}/backups` en `.../backups/{uuid}/download` → {attributes: {url}}.
 */
import { TRPCError } from "@trpc/server";

export type SourceKind = "pterodactyl" | "pelican";

export interface SrcVariable {
  key: string;
  name: string;
  description: string;
  default: string;
  userEditable: boolean;
  rules: string;
}

export interface SrcEgg {
  id: number;
  nestName: string | null;
  name: string;
  description: string;
  dockerImages: string[];
  startup: string;
  stop: string | null;
  done: string[];
  configFiles: Record<string, { parser?: string; find?: Record<string, unknown> }>;
  install: { script: string; container: string; entry: string };
  variables: SrcVariable[];
}

export interface SrcServer {
  id: number;
  uuid: string;
  identifier: string;
  name: string;
  ownerId: number;
  eggId: number;
  nodeId: number;
  suspended: boolean;
  limits: { memory: number; swap: number; disk: number; cpu: number };
  allocations: Array<{ ip: string; port: number; primary: boolean }>;
  variables: Record<string, string>;
  image: string | null;
}

export interface Snapshot {
  users: Array<{ id: number; username: string; email: string | null; name: string | null; discordId: string | null }>;
  nodes: Array<{ id: number; name: string; fqdn: string; sftpPort: number }>;
  eggs: SrcEgg[];
  servers: SrcServer[];
  warnings: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const attrs = (item: unknown): Obj => obj(obj(item).attributes);
const relList = (a: Obj, name: string): Obj[] => {
  const r = obj(obj(a.relationships)[name]);
  return Array.isArray(r.data) ? (r.data as unknown[]).map(attrs) : [];
};

const DISCORD = /^\d{15,21}$/;

export class SourceClient {
  readonly base: string;
  /** Aantal verzoeken en hun methode (voor tests: alleen GET). */
  readonly log: Array<{ method: "GET"; path: string }> = [];

  constructor(
    base: string,
    private readonly appKey: string,
    private readonly clientKey: string | null = null,
    private readonly timeoutMs = 20_000,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  /** Enige manier om de bron aan te roepen: GET met de juiste sleutel. */
  private async get(path: string, which: "app" | "client" = "app"): Promise<Obj> {
    const key = which === "app" ? this.appKey : this.clientKey;
    if (!key) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_CLIENT_KEY" });
    this.log.push({ method: "GET", path });
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs), redirect: "error", cache: "no-store" });
    } catch (e) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `SOURCE_UNREACHABLE: ${(e as Error).message}` });
    }
    if (res.status === 401 || res.status === 403) throw new TRPCError({ code: "BAD_REQUEST", message: `SOURCE_UNAUTHORIZED: ${path} gave ${res.status} (check the API key and its read permissions)` });
    if (res.status === 404) throw new SourceNotFound(path);
    if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `SOURCE_INVALID: ${path} gave HTTP ${res.status}` });
    try {
      return obj(await res.json());
    } catch {
      throw new TRPCError({ code: "BAD_REQUEST", message: `SOURCE_INVALID: ${path} did not return JSON (is this the panel URL?)` });
    }
  }

  /** Alle pagina's van een lijst. */
  private async list(path: string, which: "app" | "client" = "app", maxPages = 200): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await this.get(`${path}${sep}page=${page}&per_page=100`, which);
      if (!Array.isArray(body.data)) throw new TRPCError({ code: "BAD_REQUEST", message: `SOURCE_INVALID: ${path} is not a list` });
      out.push(...body.data);
      const pg = obj(obj(body.meta).pagination);
      const total = num(pg.total_pages, 1);
      if (page >= total || body.data.length === 0) break;
    }
    return out;
  }

  async snapshot(kind: SourceKind): Promise<Snapshot> {
    const warnings: string[] = [];
    const users = (await this.list("/api/application/users")).map(attrs).map((a) => {
      const ext = str(a.external_id).trim();
      const oauth = obj(a.oauth);
      const discord = [ext, str(oauth.discord), str(a.discord_id)].find((x) => DISCORD.test(x)) ?? null;
      const name = [str(a.first_name), str(a.last_name)].filter(Boolean).join(" ") || null;
      return { id: num(a.id), username: str(a.username), email: str(a.email) || null, name, discordId: discord };
    });
    const nodes = (await this.list("/api/application/nodes")).map(attrs).map((a) => ({ id: num(a.id), name: str(a.name), fqdn: str(a.fqdn), sftpPort: num(a.daemon_sftp, 2022) }));

    let eggItems: Array<{ egg: Obj; nest: string | null }> = [];
    let viaNests = kind === "pterodactyl";
    if (kind === "pelican") {
      try {
        eggItems = (await this.list("/api/application/eggs?include=variables")).map((e) => ({ egg: attrs(e), nest: null }));
      } catch (e) {
        if (!(e instanceof SourceNotFound)) throw e;
        viaNests = true;
      }
    }
    if (viaNests) {
      for (const n of (await this.list("/api/application/nests")).map(attrs)) {
        const eggs = await this.list(`/api/application/nests/${num(n.id)}/eggs?include=variables`);
        eggItems.push(...eggs.map((e) => ({ egg: attrs(e), nest: str(n.name) || null })));
      }
    }
    const eggs = eggItems.map(({ egg: a, nest }) => eggOf(a, nest));

    const servers = (await this.list("/api/application/servers?include=allocations,variables")).map(attrs).map((a): SrcServer => {
      const limits = obj(a.limits);
      const container = obj(a.container);
      const primaryId = num(a.allocation, -1);
      const allocs = relList(a, "allocations").map((x) => ({ id: num(x.id), ip: str(x.ip, "0.0.0.0"), port: num(x.port), primary: num(x.id) === primaryId }));
      if (allocs.length && !allocs.some((x) => x.primary)) allocs[0]!.primary = true;
      allocs.sort((x, y) => Number(y.primary) - Number(x.primary) || x.port - y.port);
      const vars: Record<string, string> = {};
      const rel = relList(a, "variables");
      if (rel.length) {
        for (const v of rel) {
          const k = str(v.env_variable);
          if (k) vars[k] = v.server_value === null || v.server_value === undefined ? str(v.default_value) : str(v.server_value);
        }
      } else {
        for (const [k, v] of Object.entries(obj(container.environment))) if (!/^(P_|STARTUP$)/.test(k)) vars[k] = str(v);
      }
      return {
        id: num(a.id),
        uuid: str(a.uuid),
        identifier: str(a.identifier) || str(a.uuid).slice(0, 8),
        name: str(a.name),
        ownerId: num(a.user),
        eggId: num(a.egg),
        nodeId: num(a.node),
        suspended: a.suspended === true || str(a.status) === "suspended",
        limits: { memory: num(limits.memory), swap: num(limits.swap), disk: num(limits.disk), cpu: num(limits.cpu) },
        allocations: allocs.map(({ ip, port, primary }) => ({ ip, port, primary })),
        variables: vars,
        image: str(container.image) || null,
      };
    });
    if (!users.length) warnings.push("The source returned no users.");
    for (const s of servers) if (!eggs.some((e) => e.id === s.eggId)) warnings.push(`Server ${s.name}: egg ${s.eggId} not found in the source.`);
    return { users, nodes, eggs, servers, warnings };
  }

  // ---------- Client API (backups) ----------

  /** Nieuwste geslaagde backup van een server, of null. */
  async latestBackup(identifier: string): Promise<{ uuid: string; name: string; bytes: number; completedAt: string } | null> {
    const items = (await this.list(`/api/client/servers/${encodeURIComponent(identifier)}/backups`, "client", 10)).map(attrs);
    const ok = items.filter((b) => b.is_successful === true && str(b.completed_at)).sort((a, b) => str(b.completed_at).localeCompare(str(a.completed_at)));
    const b = ok[0];
    return b ? { uuid: str(b.uuid), name: str(b.name), bytes: num(b.bytes), completedAt: str(b.completed_at) } : null;
  }

  /** Download-URL (ondertekend, kort geldig) van een backup. */
  async backupUrl(identifier: string, backupUuid: string): Promise<string> {
    const body = await this.get(`/api/client/servers/${encodeURIComponent(identifier)}/backups/${encodeURIComponent(backupUuid)}/download`, "client");
    const url = str(obj(body.attributes).url);
    if (!/^https?:\/\//.test(url)) throw new TRPCError({ code: "BAD_REQUEST", message: "SOURCE_INVALID: backup download gave no URL" });
    return url;
  }

  get hasClientKey(): boolean {
    return !!this.clientKey;
  }
}

export class SourceNotFound extends TRPCError {
  constructor(path: string) {
    super({ code: "BAD_REQUEST", message: `SOURCE_INVALID: ${path} not found (404)` });
  }
}

function eggOf(a: Obj, nest: string | null): SrcEgg {
  const images = Object.values(obj(a.docker_images)).map((x) => str(x)).filter(Boolean);
  if (!images.length && str(a.docker_image)) images.push(str(a.docker_image));
  const config = obj(a.config);
  let startupCfg: unknown = config.startup;
  if (typeof startupCfg === "string") {
    try {
      startupCfg = JSON.parse(startupCfg);
    } catch {
      startupCfg = {};
    }
  }
  const doneRaw = obj(startupCfg).done;
  const done = (Array.isArray(doneRaw) ? doneRaw : [doneRaw]).map((x) => str(x)).filter(Boolean);
  let files: unknown = config.files;
  if (typeof files === "string") {
    try {
      files = JSON.parse(files);
    } catch {
      files = {};
    }
  }
  const script = obj(a.script);
  const startupCommands = Object.values(obj(a.startup_commands)).map((x) => str(x)).filter(Boolean);
  return {
    id: num(a.id),
    nestName: nest,
    name: str(a.name),
    description: str(a.description),
    dockerImages: images,
    startup: str(a.startup) || startupCommands[0] || "",
    stop: str(config.stop) || null,
    done,
    configFiles: obj(files) as SrcEgg["configFiles"],
    install: { script: str(script.install), container: str(script.container, "alpine:3.20"), entry: str(script.entry, "ash") },
    variables: relList(a, "variables").map((v) => ({
      key: str(v.env_variable),
      name: str(v.name) || str(v.env_variable),
      description: str(v.description),
      default: str(v.default_value),
      userEditable: v.user_editable === true || v.user_editable === 1,
      rules: Array.isArray(v.rules) ? (v.rules as unknown[]).map((r) => str(r)).join("|") : str(v.rules),
    })),
  };
}
