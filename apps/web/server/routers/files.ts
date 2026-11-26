/** files.*: via de daemon. Lezen vereist files.read, schrijven files.write. */
import type { DaemonFileEntry, FileEntry, Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { call, daemonFor } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { signBrowserJwt } from "../lib/jwt";
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

/** Eenmalige up/download-URL met een JWT die alleen het ene recht draagt. */
async function signedUrl(ctx: Parameters<Implementation["files"]["uploadUrl"]>[0]["ctx"], uuid: string, kind: "upload" | "download", query: Record<string, string>) {
  const perm = kind === "upload" ? "files.write" : "files.read";
  const a = await requireServer(ctx, uuid, perm);
  const { token, claims } = await signBrowserJwt({
    iss: getEnv().PANEL_URL,
    aud: a.bundle.node.fqdn,
    sub: String(ctx.session!.userId),
    serverUuid: uuid,
    permissions: [perm],
    extra: query,
  });
  const qs = new URLSearchParams({ ...query, token });
  return { a, url: `https://${a.bundle.node.fqdn}/api/servers/${uuid}/files/${kind}?${qs}`, expiresAt: new Date(claims.exp * 1000) };
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
    const a = await requireServer(ctx, input.uuid, "files.write");
    await call(() => daemonFor(a.bundle.node).writeFile(input.uuid, input.path, input.content));
    await logActivity({ action: "server.file.write", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return ok;
  },

  mkdir: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    await call(() => daemonFor(a.bundle.node).mkdir(input.uuid, input.path));
    await logActivity({ action: "server.file.mkdir", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { path: input.path }, ip: ctx.ip, ctx });
    return ok;
  },

  rename: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    await call(() => daemonFor(a.bundle.node).rename(input.uuid, input.from, input.to));
    await logActivity({ action: "server.file.rename", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { from: input.from, to: input.to }, ip: ctx.ip, ctx });
    return ok;
  },

  delete: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    await call(() => daemonFor(a.bundle.node).deleteFiles(input.uuid, input.paths));
    await logActivity({ action: "server.file.delete", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { paths: input.paths }, ip: ctx.ip, ctx });
    return ok;
  },

  compress: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
    const archive = await call(() => daemonFor(a.bundle.node).compress(input.uuid, input.root, input.paths));
    await logActivity({ action: "server.file.compress", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { root: input.root, paths: input.paths, archive: archive.path }, ip: ctx.ip, ctx });
    return { archive: toFileEntry(archive) };
  },

  decompress: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.write");
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

  sftpDetails: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, ctx.session!.userId));
    return { host: a.bundle.node.fqdn, port: a.bundle.node.sftpPort, username: sftpUsername(u!.name, u!.discordId, input.uuid) };
  },
};
