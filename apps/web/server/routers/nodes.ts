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

export const REPO_URL = "https://github.com/St3v3-B/BSSG-Panel.git";

/** URL waarmee een remote daemon het panel bereikt: PANEL_URL, tenzij die naar loopback wijst (lokale installatie). */
export function publicPanelUrl(): string {
  const env = getEnv();
  let loopback = false;
  try {
    loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(env.PANEL_URL).hostname);
  } catch {
    loopback = true;
  }
  return loopback && !env.isTestDomain ? `https://${env.PANEL_DOMAIN}` : env.PANEL_URL;
}

/** Instructie voor de node (als root): repo klonen en deploy/install.sh --node-only draaien. */
export function installCommand(n: Pick<NodeRow, "fqdn" | "daemonPort" | "sftpPort">, token: string): string {
  const env = getEnv();
  const dir = "/opt/panel-node";
  return [
    `# On ${n.fqdn} (Docker + git required), as root:`,
    `git clone --depth 1 ${REPO_URL} ${dir} 2>/dev/null || git -C ${dir} pull --ff-only`,
    `PANEL_URL='${publicPanelUrl()}' NODE_DOMAIN='${n.fqdn}' NODE_TOKEN='${token}' ACME_EMAIL='${env.ACME_EMAIL ?? `admin@${env.PANEL_DOMAIN}`}' DAEMON_PORT='${n.daemonPort}' SFTP_PORT='${n.sftpPort}' \\`,
    `  ${dir}/deploy/install.sh --node-only --non-interactive`,
  ].join("\n");
}

const uniqueErr = (e: unknown) => {
  const c = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
  if (c === "23505") return new TRPCError({ code: "CONFLICT", message: "NODE_EXISTS: name or fqdn already exists" });
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
    if (n.isLocal) throw new TRPCError({ code: "BAD_REQUEST", message: "LOCAL_NODE: the token is in panel.env (NODE_TOKEN)" });
    const t = newToken();
    await getDb().update(schema.nodes).set({ tokenHash: t.tokenHash, tokenEnc: t.tokenEnc }).where(eq(schema.nodes.id, n.id));
    await logActivity({ action: "admin.node.regenerate_token", userId: ctx.session!.userId, metadata: { id: n.id }, ip: ctx.ip, ctx });
    return { token: t.token, installCommand: installCommand(n, t.token) };
  },
};
