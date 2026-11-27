/** files.*: via de daemon. Lezen vereist files.read, schrijven files.write. */
import type { DaemonFileEntry, DaemonSearchResult, FileEntry, FileSearchResult, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { call, daemonFor, nodeHost } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { signBrowserJwt, type TransferClaims } from "../lib/jwt";
import { requireServer, sftpUsername } from "../servers-data";

const ok = { ok: true as const };
export const MAX_READ_BYTES = 5 * 1024 * 1024;

export function toFileEntry(f: DaemonFileEntry): FileEntry {
  return {
    name: f.name,
    path: f.path,
    isDirectory: f.is_directory,
    isSymlink: f.is_symlink,
    size: f.size,
    mode: f.mode,
    mimeType: f.mime_type,
    modifiedAt: new Date(f.modified_at),
  };
}

export function toSearchResult(r: DaemonSearchResult): FileSearchResult {
  return {
    results: r.results.map((h) => ({ entry: toFileEntry(h.entry), matches: h.matches.map((m) => ({ line: m.line, text: m.text })) })),
    truncated: r.truncated,
    timedOut: r.timed_out,
  };
}

/** Basisnaam van een pad ("/a/b" → "b"). */
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? "";
const joinDir = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

/**
 * Eenmalige up/download-URL met een JWT die alleen het ene recht draagt. `query` gaat in de URL én
 * in de claims (de daemon vergelijkt); `claims` alleen in de JWT.
 */
async function signedUrl(
  ctx: Parameters<Implementation["files"]["uploadUrl"]>[0]["ctx"],
  uuid: string,
  kind: "upload" | "download" | "archive",
  query: { path?: string; directory?: string },
  claims: TransferClaims = {},
) {
  const perm = kind === "upload" ? "files.write" : "files.read";
  const a = await requireServer(ctx, uuid, perm, { mutates: kind === "upload" });
  const { token, claims: signed } = await signBrowserJwt({
    iss: getEnv().PANEL_URL,
    aud: a.bundle.node.fqdn,
    sub: String(ctx.session!.userId),
    serverUuid: uuid,
    permissions: [perm],
    extra: { ...query, ...claims },
  });
  const qs = new URLSearchParams({ ...(query as Record<string, string>), token });
  return { a, url: `https://${nodeHost(a.bundle.node)}/api/servers/${uuid}/files/${kind}?${qs}`, expiresAt: new Date(signed.exp * 1000) };
}

export const files: Implementation["files"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const list = await call(() => daemonFor(a.bundle.node).listFiles(input.uuid, input.path));
    return list.map(toFileEntry);
  },

  read: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const content = await call(() => daemonFor(a.bundle.node).readFile(input.uuid, input.path));
    const size = Buffer.byteLength(content);
    if (size > MAX_READ_BYTES) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "FILE_TOO_LARGE" });
    return { content, size };
  },

  write: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).writeFile(input.uuid, input.path, input.content));
    await logActivity({ action: "server.file.write", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return ok;
  },

  mkdir: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).mkdir(input.uuid, input.path));
    await logActivity({ action: "server.file.mkdir", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return ok;
  },

  rename: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).rename(input.uuid, input.from, input.to));
    await logActivity({ action: "server.file.rename", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { from: input.from, to: input.to }, ip: ctx.ip, ctx });
    return ok;
  },

  delete: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).deleteFiles(input.uuid, input.paths));
    await logActivity({ action: "server.file.delete", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { paths: input.paths }, ip: ctx.ip, ctx });
    return ok;
  },

  compress: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    const archive = await call(() => daemonFor(a.bundle.node).compress(input.uuid, input.root, input.paths));
    await logActivity({ action: "server.file.compress", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { root: input.root, paths: input.paths, archive: archive.path }, ip: ctx.ip, ctx });
    return { archive: toFileEntry(archive) };
  },

  decompress: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    await call(() => daemonFor(a.bundle.node).decompress(input.uuid, input.path));
    await logActivity({ action: "server.file.decompress", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return ok;
  },

  uploadUrl: async ({ input, ctx }) => {
    const { a, url, expiresAt } = await signedUrl(ctx, input.uuid, "upload", { directory: input.directory });
    await logActivity({ action: "server.file.upload_url", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { directory: input.directory }, ip: ctx.ip, ctx });
    return { url, expiresAt };
  },

  downloadUrl: async ({ input, ctx }) => {
    const { a, url, expiresAt } = await signedUrl(ctx, input.uuid, "download", { path: input.path });
    await logActivity({ action: "server.file.download", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return { url, expiresAt };
  },

  search: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const r = await call(() => daemonFor(a.bundle.node).searchFiles(input.uuid, { path: input.path, query: input.query, content: input.content, limit: input.limit }));
    return toSearchResult(r);
  },

  chmod: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    const r = await call(() =>
      daemonFor(a.bundle.node).chmod(input.uuid, {
        paths: input.paths,
        mode: input.mode,
        ...(input.dirMode ? { dir_mode: input.dirMode } : {}),
        recursive: input.recursive,
        allow_special: input.allowSpecial,
      }),
    );
    await logActivity({
      action: "server.file.chmod",
      userId: ctx.session!.userId,
      serverId: a.bundle.server.id,
      metadata: { paths: input.paths, mode: input.mode, dirMode: input.dirMode ?? null, recursive: input.recursive, changed: r.changed },
      ip: ctx.ip,
      ctx,
    });
    return { changed: r.changed };
  },

  move: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write", { mutates: true });
    const dest = input.destination;
    for (const p of input.paths) {
      if (dest === p || dest.startsWith(`${p.replace(/\/+$/, "")}/`)) throw new TRPCError({ code: "BAD_REQUEST", message: "MOVE_INTO_SELF" });
    }
    const client = daemonFor(a.bundle.node);
    const moved: string[] = [];
    try {
      for (const p of input.paths) {
        const to = joinDir(dest, baseName(p));
        if (to === p) continue;
        await call(() => client.rename(input.uuid, p, to));
        moved.push(p);
      }
    } finally {
      if (moved.length) {
        await logActivity({ action: "server.file.move", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { paths: moved, destination: dest }, ip: ctx.ip, ctx });
      }
    }
    return ok;
  },

  archiveUrl: async ({ input, ctx }) => {
    const archive = { root: input.root, paths: input.paths, format: input.format };
    const { a, url, expiresAt } = await signedUrl(ctx, input.uuid, "archive", {}, { archive });
    await logActivity({ action: "server.file.download_archive", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: archive, ip: ctx.ip, ctx });
    return { url, expiresAt };
  },

  sftpDetails: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, ctx.session!.userId));
    return { host: a.bundle.node.fqdn, port: a.bundle.node.sftpPort, username: sftpUsername(u!.name, u!.discordId, input.uuid) };
  },
};
