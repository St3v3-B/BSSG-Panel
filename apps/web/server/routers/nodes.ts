/** admin.nodes.create/update/delete/regenerateToken: token als hash + versleuteld (token_enc). */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { count, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { encrypt, randomToken, sha256 } from "../lib/crypto";
import { nodeById, nodeOut } from "./admin";

type NodeRow = typeof schema.nodes.$inferSelect;
const ok = { ok: true as const };

/** Instructie voor de node: deploy/install.sh uit een checkout van deze repository. */
export function installCommand(n: Pick<NodeRow, "fqdn" | "daemonPort" | "sftpPort">, token: string): string {
  const env = getEnv();
  return [
    `# Op ${n.fqdn}, als root, in een checkout van de panel-repository:`,
    `sudo PANEL_URL='${env.PANEL_URL}' NODE_DOMAIN='${n.fqdn}' NODE_TOKEN='${token}' DAEMON_PORT='${n.daemonPort}' SFTP_PORT='${n.sftpPort}' \\`,
    `  deploy/install.sh --non-interactive`,
  ].join("\n");
}

const uniqueErr = (e: unknown) => {
  const c = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
  if (c === "23505") return new TRPCError({ code: "CONFLICT", message: "NODE_EXISTS: naam of fqdn bestaat al" });
  return e;
};

const newToken = () => {
  const token = randomToken(32);
  return { token, tokenHash: sha256(token), tokenEnc: encrypt(token) };
};

export const nodeMutations: Pick<Implementation["admin"]["nodes"], "create" | "update" | "delete" | "regenerateToken"> = {
  create: async ({ input, ctx }) => {
    const t = newToken();
    let row: NodeRow;
    try {
      [row] = (await getDb()
        .insert(schema.nodes)
        .values({ ...input, fqdn: input.fqdn.toLowerCase(), tokenHash: t.tokenHash, tokenEnc: t.tokenEnc, isLocal: false })
        .returning()) as [NodeRow];
    } catch (e) {
      throw uniqueErr(e);
    }
    await logActivity({ action: "admin.node.create", userId: ctx.session!.userId, metadata: { id: row.id, name: row.name, fqdn: row.fqdn }, ip: ctx.ip, ctx });
    return { node: nodeOut(row), token: t.token, installCommand: installCommand(row, t.token) };
  },

  update: async ({ input, ctx }) => {
    const { id, ...rest } = input;
    const n = await nodeById(id);
    // De lokale node: fqdn en poorten komen bij elke start uit panel.env.
    const set = n.isLocal ? { name: rest.name, maxRamMb: rest.maxRamMb, maxDiskMb: rest.maxDiskMb, s3TargetId: rest.s3TargetId } : { ...rest, fqdn: rest.fqdn.toLowerCase() };
    let row: NodeRow;
    try {
      [row] = (await getDb().update(schema.nodes).set(set).where(eq(schema.nodes.id, id)).returning()) as [NodeRow];
    } catch (e) {
      throw uniqueErr(e);
    }
    await logActivity({ action: "admin.node.update", userId: ctx.session!.userId, metadata: { id, fields: Object.keys(set) }, ip: ctx.ip, ctx });
    return nodeOut(row);
  },

  delete: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "FORBIDDEN", message: "LOCAL_NODE" });
    const [c] = await getDb().select({ n: count() }).from(schema.servers).where(eq(schema.servers.nodeId, n.id));
    if ((c?.n ?? 0) > 0) throw new TRPCError({ code: "CONFLICT", message: "NODE_HAS_SERVERS" });
    await getDb().delete(schema.nodes).where(eq(schema.nodes.id, n.id));
    await logActivity({ action: "admin.node.delete", userId: ctx.session!.userId, metadata: { id: n.id, name: n.name, fqdn: n.fqdn }, ip: ctx.ip, ctx });
    return ok;
  },

  regenerateToken: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "BAD_REQUEST", message: "LOCAL_NODE: het token staat in panel.env (NODE_TOKEN)" });
    const t = newToken();
    await getDb().update(schema.nodes).set({ tokenHash: t.tokenHash, tokenEnc: t.tokenEnc }).where(eq(schema.nodes.id, n.id));
    await logActivity({ action: "admin.node.regenerate_token", userId: ctx.session!.userId, metadata: { id: n.id }, ip: ctx.ip, ctx });
    return { token: t.token, installCommand: installCommand(n, t.token) };
  },
};
