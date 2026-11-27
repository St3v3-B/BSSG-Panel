/**
 * content.*: plugins en mods (Modrinth/Hangar), modpacks (.mrpack) en de versiekiezer voor Minecraft-servers.
 * Downloads gebeuren hier in het panel (hash-controle, host-allowlist, groottelimiet); het bestand gaat
 * via de daemon-bestands-API naar `plugins/` of `mods/`. Niets wordt uitgevoerd.
 */
import { contentProfile, type ContentHit, type ContentInfo, type ContentKind, type ContentProfile, type Implementation, type InstalledContent, type ModpackResult } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { ExternalError, fetchBytes, fetchJson } from "../lib/http";
import { PACK_HOSTS, PACK_LIMITS, MrpackError, planPack } from "../lib/mrpack";
import { DOWNLOAD_HOSTS, MAX_FILE_BYTES, downloadVerified, safeFilename, sourceClient, verifyHash, type FileTarget, type Filter } from "../lib/mc-sources";
import { fabricGameVersions, fabricLoaderVersions, fillBuilds, fillVersions, latestGameVersion } from "../lib/mc-versions";
import { requireServer, serverVariables, type ServerAccess } from "../servers-data";
import { setVariables } from "./network";

const ok = { ok: true as const };
type Ctx = Parameters<typeof requireServer>[0];
type Row = typeof schema.serverContent.$inferSelect;

const bad = (message: string, code: "BAD_REQUEST" | "NOT_FOUND" | "PRECONDITION_FAILED" | "CONFLICT" = "BAD_REQUEST") => new TRPCError({ code, message });

/** Fouten van externe bronnen (en het mrpack-lezen) naar tRPC-fouten met een stabiele code in de melding. */
async function ext<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExternalError) {
      const code = e.code === "EXTERNAL_TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : e.message.includes("NO_COMPATIBLE_VERSION") || e.message.includes("INCOMPATIBLE_VERSION") || e.message.includes("EXTERNAL_DOWNLOAD_ONLY") ? "BAD_REQUEST" : "BAD_GATEWAY";
      throw new TRPCError({ code, message: e.message });
    }
    if (e instanceof MrpackError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

interface Mc {
  a: ServerAccess;
  profile: ContentProfile;
  slug: string;
  filter: Filter;
  gameVersion: string | null;
}

async function mcFor(ctx: Ctx, uuid: string, perm: "files.read" | "files.write"): Promise<Mc> {
  const a = await requireServer(ctx, uuid, perm, { mutates: perm === "files.write" });
  const slug = a.bundle.template.slug;
  const profile = contentProfile(slug);
  if (!profile || a.bundle.server.type !== "game") throw bad("CONTENT_NOT_SUPPORTED");
  const vars = await serverVariables(a.bundle.server.id);
  const def = a.bundle.template.variables.find((v) => v.key === profile.versionVar)?.default ?? "latest";
  let gameVersion: string | null = null;
  if (profile.versionVar === "MINECRAFT_VERSION") {
    const v = (vars[profile.versionVar] ?? def).trim();
    gameVersion = v && v !== "latest" ? v : await ext(() => latestGameVersion(slug));
  }
  return { a, profile, slug, gameVersion, filter: { loaders: profile.loaders, gameVersion, serverSide: profile.kind === "mod" } };
}

const toInstalled = (r: Row): InstalledContent => ({ id: r.id, source: r.source as InstalledContent["source"], projectId: r.projectId, name: r.name, versionId: r.versionId, versionNumber: r.versionNumber, filename: r.filename, kind: r.kind as ContentKind, installedAt: r.installedAt });

async function rows(serverId: number): Promise<Row[]> {
  return getDb().select().from(schema.serverContent).where(eq(schema.serverContent.serverId, serverId)).orderBy(schema.serverContent.name);
}

async function rowFor(serverId: number, id: number): Promise<Row> {
  const [r] = await getDb().select().from(schema.serverContent).where(and(eq(schema.serverContent.serverId, serverId), eq(schema.serverContent.id, id)));
  if (!r) throw bad("CONTENT_NOT_FOUND", "NOT_FOUND");
  return r;
}

const dirOf = (m: Mc) => m.profile.directory;

/** Download, controleer, schrijf; verwijdert daarna een eerder bestand van hetzelfde project met andere naam. */
async function place(m: Mc, t: FileTarget, source: Row["source"], previous: Row | null): Promise<Row> {
  const filename = safeFilename(t.filename);
  const data = await ext(() => downloadVerified(t));
  const d = daemonFor(m.a.bundle.node);
  const uuid = m.a.bundle.server.uuid;
  await call(() => d.writeFile(uuid, `${dirOf(m)}/${filename}`, data));
  if (previous && previous.filename !== filename) await call(() => d.deleteFiles(uuid, [`${dirOf(m)}/${previous.filename}`])).catch(() => {});
  const values = { serverId: m.a.bundle.server.id, source, projectId: t.projectId, name: t.name, versionId: t.versionId, versionNumber: t.versionNumber, filename, kind: m.profile.kind };
  const [row] = await getDb()
    .insert(schema.serverContent)
    .values(values)
    .onConflictDoUpdate({ target: [schema.serverContent.serverId, schema.serverContent.source, schema.serverContent.projectId], set: { name: values.name, versionId: values.versionId, versionNumber: values.versionNumber, filename, installedAt: new Date() } })
    .returning();
  return row!;
}

const log = (ctx: Ctx, m: Mc, action: string, metadata: Record<string, unknown>) => logActivity({ action, userId: ctx.session!.userId, serverId: m.a.bundle.server.id, metadata, ip: ctx.ip, ctx });

export const content: Implementation["content"] = {
  info: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const profile = a.bundle.server.type === "game" ? contentProfile(a.bundle.template.slug) : null;
    if (!profile) return { supported: false, kind: null, directory: null, loaders: [], sources: [], gameVersion: null, modpacks: false } satisfies ContentInfo;
    let gameVersion: string | null = null;
    if (profile.versionVar === "MINECRAFT_VERSION") {
      const vars = await serverVariables(a.bundle.server.id);
      const v = (vars[profile.versionVar] ?? a.bundle.template.variables.find((x) => x.key === profile.versionVar)?.default ?? "latest").trim();
      gameVersion = v && v !== "latest" ? v : await latestGameVersion(a.bundle.template.slug).catch(() => null);
    }
    return { supported: true, kind: profile.kind, directory: profile.directory, loaders: profile.loaders, sources: profile.sources, gameVersion, modpacks: profile.modpacks };
  },

  search: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.read");
    if (!m.profile.sources.includes(input.source)) throw bad("SOURCE_NOT_SUPPORTED");
    if (input.modpacks && (!m.profile.modpacks || input.source !== "modrinth")) throw bad("MODPACK_NOT_SUPPORTED");
    return ext(() => sourceClient(input.source).search(m.filter, input.query.trim(), input.offset, input.modpacks));
  },

  resolve: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.read");
    if (!m.profile.sources.includes(input.source)) throw bad("SOURCE_NOT_SUPPORTED");
    const client = sourceClient(input.source);
    return ext(async () => {
      const t = await client.target(input.projectId, m.filter, input.versionId);
      const installed = new Set((await rows(m.a.bundle.server.id)).filter((r) => r.source === input.source).map((r) => r.projectId));
      const hit: ContentHit = await client.hit(t.projectId);
      const dependencies = await Promise.all(
        t.dependencies.slice(0, 10).map(async (d) => ({ projectId: d.projectId, name: (await client.hit(d.projectId).catch(() => null))?.name ?? d.projectId, installed: installed.has(d.projectId) })),
      );
      return { hit, versionId: t.versionId, versionNumber: t.versionNumber, filename: t.filename, size: t.size, dependencies };
    });
  },

  install: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.write");
    if (!m.profile.sources.includes(input.source)) throw bad("SOURCE_NOT_SUPPORTED");
    const client = sourceClient(input.source);
    const have = new Map((await rows(m.a.bundle.server.id)).filter((r) => r.source === input.source).map((r) => [r.projectId, r]));
    const done: Row[] = [];
    const visit = async (projectId: string, versionId: string | undefined, depth: number) => {
      const t = await ext(() => client.target(projectId, m.filter, versionId));
      const existing = have.get(t.projectId) ?? null;
      if (existing && depth > 0) return; // afhankelijkheid staat er al
      if (input.withDependencies && depth < 3) {
        for (const d of t.dependencies.slice(0, 10)) if (!have.has(d.projectId) && !done.some((r) => r.projectId === d.projectId)) await visit(d.projectId, undefined, depth + 1);
      }
      const row = await place(m, t, input.source, existing);
      have.set(row.projectId, row);
      done.push(row);
    };
    await visit(input.projectId, input.versionId, 0);
    await log(ctx, m, "server.content.install", { source: input.source, items: done.map((r) => ({ projectId: r.projectId, name: r.name, version: r.versionNumber, filename: r.filename })) });
    return done.map(toInstalled);
  },

  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    return (await rows(a.bundle.server.id)).map(toInstalled);
  },

  checkUpdates: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.read");
    const out: Array<{ id: number; versionId: string; versionNumber: string }> = [];
    const all = (await rows(m.a.bundle.server.id)).slice(0, 60);
    await Promise.all(
      all.map(async (r) => {
        try {
          const t = await sourceClient(r.source as "modrinth" | "hangar").target(r.projectId, m.filter);
          if (t.versionId !== r.versionId) out.push({ id: r.id, versionId: t.versionId, versionNumber: t.versionNumber });
        } catch {
          /* project weg of tijdelijk onbereikbaar: geen update tonen */
        }
      }),
    );
    return out;
  },

  update: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.write");
    const r = await rowFor(m.a.bundle.server.id, input.id);
    const t = await ext(() => sourceClient(r.source as "modrinth" | "hangar").target(r.projectId, m.filter));
    if (t.versionId === r.versionId) return toInstalled(r);
    const row = await place(m, t, r.source, r);
    await log(ctx, m, "server.content.update", { source: r.source, projectId: r.projectId, name: row.name, from: r.versionNumber, to: row.versionNumber });
    return toInstalled(row);
  },

  uninstall: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.write");
    const r = await rowFor(m.a.bundle.server.id, input.id);
    try {
      await call(() => daemonFor(m.a.bundle.node).deleteFiles(m.a.bundle.server.uuid, [`${dirOf(m)}/${r.filename}`]));
    } catch (e) {
      if (!(e instanceof TRPCError) || e.code !== "NOT_FOUND") throw e;
    }
    await getDb().delete(schema.serverContent).where(eq(schema.serverContent.id, r.id));
    await log(ctx, m, "server.content.uninstall", { source: r.source, projectId: r.projectId, name: r.name, filename: r.filename });
    return ok;
  },

  importModpack: async ({ input, ctx }) => {
    const m = await mcFor(ctx, input.uuid, "files.write");
    if (!m.profile.modpacks) throw bad("MODPACK_NOT_SUPPORTED");
    // Eigenaar of admin: een modpack zet de versies en kan de installatie opnieuw draaien.
    await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const d = daemonFor(m.a.bundle.node);
    const uuid = m.a.bundle.server.uuid;

    let pack: Buffer;
    if (input.source.type === "file") {
      if (!/\.mrpack$/i.test(input.source.path)) throw bad("NOT_A_MRPACK");
      const path = input.source.path;
      try {
        pack = await d.readFileBytes(uuid, path);
      } catch (e) {
        if (e instanceof DaemonHttpError && e.status === 404) throw bad("FILE_NOT_FOUND", "NOT_FOUND");
        if (e instanceof DaemonHttpError && e.status === 413) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "FILE_TOO_LARGE: pick the modpack through Modrinth instead" });
        throw await call(() => Promise.reject(e));
      }
    } else {
      const src = input.source;
      pack = await ext(async () => {
        const q = [`loaders=${encodeURIComponent('["fabric"]')}`].join("&");
        const pid = encodeURIComponent(src.projectId);
        type V = { id: string; project_id: string; files: Array<{ url: string; filename: string; primary: boolean; hashes: { sha512?: string }; size: number }> };
        const v = src.versionId
          ? await fetchJson<V>(`https://api.modrinth.com/v2/version/${encodeURIComponent(src.versionId)}`, { hosts: ["api.modrinth.com"] })
          : (await fetchJson<V[]>(`https://api.modrinth.com/v2/project/${pid}/version?${q}`, { hosts: ["api.modrinth.com"] }))[0];
        if (!v) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "NO_COMPATIBLE_VERSION");
        const f = v.files.find((x) => x.primary) ?? v.files[0];
        if (!f || !f.hashes.sha512 || !/\.mrpack$/i.test(f.filename)) throw new ExternalError("EXTERNAL_BAD_RESPONSE", "NOT_A_MRPACK");
        const buf = await fetchBytes(f.url, { hosts: DOWNLOAD_HOSTS, maxBytes: 250 * 1024 * 1024, timeoutMs: 120_000 });
        verifyHash(buf, { algo: "sha512", hex: f.hashes.sha512 });
        return buf;
      });
    }

    const plan = await ext(async () => planPack(pack));

    // Serverbestanden: eerst alles valideren (hierboven), dan downloaden met hashcontrole.
    let installed = 0;
    const queue = [...plan.files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const url = f.urls.find((u) => {
          try {
            const h = new URL(u);
            return h.protocol === "https:" && (PACK_HOSTS as readonly string[]).includes(h.hostname);
          } catch {
            return false;
          }
        });
        if (!url) throw bad(`DOWNLOAD_HOST_NOT_ALLOWED: ${f.path}`);
        const data = await ext(async () => {
          const buf = await fetchBytes(url, { hosts: PACK_HOSTS, maxBytes: Math.min(MAX_FILE_BYTES, f.size + 1) });
          verifyHash(buf, { algo: "sha512", hex: f.sha512 });
          return buf;
        });
        await call(() => d.writeFile(uuid, `/${f.path}`, data));
        installed++;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    let applied = 0;
    for (const o of plan.overrides) {
      await call(() => d.writeFile(uuid, `/${o.path}`, o.entry.read()));
      applied++;
    }

    // Versies van het pakket overnemen (alleen variabelen die de template kent).
    const known = new Set(m.a.bundle.template.variables.map((v) => v.key));
    const vars: Record<string, string> = {};
    if (known.has("MINECRAFT_VERSION")) vars.MINECRAFT_VERSION = plan.minecraftVersion;
    if (known.has("LOADER_VERSION")) vars.LOADER_VERSION = plan.loaderVersion;
    for (const [k, v] of Object.entries(vars)) {
      const pat = m.a.bundle.template.variables.find((x) => x.key === k)?.pattern;
      if (pat && !new RegExp(pat).test(v)) throw bad(`UNSUPPORTED_PACK_VERSION: ${k}=${v}`, "PRECONDITION_FAILED");
    }
    await setVariables(m.a.bundle, vars);
    let reinstalled = false;
    if (input.reinstall) {
      await call(() => d.reinstall(uuid));
      await getDb().update(schema.servers).set({ status: "installing" }).where(eq(schema.servers.id, m.a.bundle.server.id));
      reinstalled = true;
    }
    await log(ctx, m, "server.content.modpack", { name: plan.name, minecraft: plan.minecraftVersion, loader: plan.loaderVersion, files: installed, overrides: applied, reinstalled });
    return { name: plan.name, minecraftVersion: plan.minecraftVersion, loaderVersion: plan.loaderVersion, filesInstalled: installed, filesSkipped: plan.skipped, overridesApplied: applied, reinstalled } satisfies ModpackResult;
  },

  versionOptions: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const slug = a.bundle.template.slug;
    const has = (k: string) => a.bundle.template.variables.some((v) => v.key === k);
    const none = { variables: { version: null, build: null, loader: null }, versions: [], builds: [], loaderVersions: [] };
    if (slug === "paper" || slug === "folia" || slug === "velocity") {
      const versionVar = slug === "velocity" ? "VELOCITY_VERSION" : "MINECRAFT_VERSION";
      const versions = await ext(() => fillVersions(slug));
      const builds = input.minecraftVersion && input.minecraftVersion !== "latest" ? await ext(() => fillBuilds(slug, input.minecraftVersion!)) : [];
      return { variables: { version: has(versionVar) ? versionVar : null, build: has("BUILD") ? "BUILD" : null, loader: null }, versions, builds, loaderVersions: [] };
    }
    if (slug === "fabric") {
      const [versions, loaderVersions] = await ext(() => Promise.all([fabricGameVersions(), fabricLoaderVersions()]));
      return { variables: { version: has("MINECRAFT_VERSION") ? "MINECRAFT_VERSION" : null, build: null, loader: has("LOADER_VERSION") ? "LOADER_VERSION" : null }, versions, builds: [], loaderVersions };
    }
    return none;
  },
};
