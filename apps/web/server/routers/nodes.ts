/** admin.nodes.create/update/delete/regenerateToken: token als hash + versleuteld (token_enc). */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { encrypt, randomToken, sha256 } from "../lib/crypto";
import { call, daemonFor } from "../daemon";
import { removeARecord } from "../lib/cloudflare";
import { cloudflareFor, issueJoinCode, joinCommand, joinStatus, suggestFqdn, uninstallCommand } from "../join";
import { nodeById, nodeOut, parsePorts } from "./admin";
import { assertRelayCandidate, newRelaySecret, pokeRelay, relayStatus, setHttpRelay } from "../relay";

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

/** On->off mag alleen zonder websites en domeinen op de node; servers met alleen de vlag domainsAllowed worden teruggezet. */
async function assertNoDomains(nodeId: number): Promise<void> {
  const db = getDb();
  const [web] = await db.select({ n: count() }).from(schema.servers).where(and(eq(schema.servers.nodeId, nodeId), eq(schema.servers.type, "web")));
  const [dom] = await db.select({ n: count() }).from(schema.domains).innerJoin(schema.servers, eq(schema.servers.id, schema.domains.serverId)).where(eq(schema.servers.nodeId, nodeId));
  if ((web?.n ?? 0) > 0 || (dom?.n ?? 0) > 0) throw new TRPCError({ code: "CONFLICT", message: `NODE_HAS_DOMAINS: ${web?.n ?? 0} website(s) and ${dom?.n ?? 0} domain(s) on this node` });
}

const RESERVED_PORTS = new Set([80, 22]);

export const nodeMutations: Pick<Implementation["admin"]["nodes"], "create" | "update" | "delete" | "regenerateToken" | "createJoin" | "joinCommand" | "joinStatus" | "updateDaemon" | "uninstallCommand" | "setHttpRelay" | "relayStatus"> = {
  setHttpRelay: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    const r = await setHttpRelay(n, input.relayNodeId);
    await logActivity({ action: "admin.node.http_relay", userId: ctx.session!.userId, metadata: { id: n.id, from: r.previous, to: input.relayNodeId, dns: r.dns.map((d) => ({ name: d.name, value: d.value, applied: d.applied })) }, ip: ctx.ip, ctx });
    return { node: nodeOut(r.node), dns: r.dns };
  },

  relayStatus: async ({ input }) => relayStatus(await nodeById(input.id)),

  createJoin: async ({ input, ctx }) => {
    const fqdn = (input.fqdn?.trim() || suggestFqdn(input.name)).toLowerCase();
    if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(fqdn)) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_FQDN" });
    const publicPort = input.supportsDomains ? 443 : (input.publicPort ?? 8443);
    if (!input.supportsDomains && (RESERVED_PORTS.has(publicPort) || publicPort === 443 || publicPort === input.daemonPort || publicPort === input.sftpPort)) throw new TRPCError({ code: "BAD_REQUEST", message: "INVALID_PUBLIC_PORT" });
    const ports = input.allocationPorts.trim();
    if (ports) parsePorts(ports);
    const relayId = input.httpRelayNodeId ?? null;
    if (relayId !== null) {
      if (!input.supportsDomains) throw new TRPCError({ code: "BAD_REQUEST", message: "RELAY_NOT_ALLOWED: a node behind an HTTP(S) relay supports domains" });
      const [a] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, relayId));
      assertRelayCandidate(a ?? null, null);
    }
    const cf = await cloudflareFor(fqdn);
    if (!input.supportsDomains && !cf) throw new TRPCError({ code: "BAD_REQUEST", message: "NO_DNS_PROVIDER: a node without domain support gets its certificate through a connected Cloudflare zone that covers the node domain" });
    const t = newToken();
    let row: NodeRow;
    try {
      [row] = (await getDb()
        .insert(schema.nodes)
        .values({
          name: input.name.trim(), fqdn, daemonPort: input.daemonPort, sftpPort: input.sftpPort, maxRamMb: input.maxRamMb, maxDiskMb: input.maxDiskMb, s3TargetId: input.s3TargetId,
          tokenHash: t.tokenHash, tokenEnc: t.tokenEnc, isLocal: false, supportsDomains: input.supportsDomains, publicPort,
          httpRelayNodeId: relayId, relaySecretEnc: relayId !== null ? newRelaySecret() : null,
          joinState: "waiting", joinUpdatedAt: new Date(),
          joinOptions: { allocationIp: null, allocationPorts: ports, dnsMode: cf ? "cloudflare" : "manual", dnsDone: false, allocationsCreated: 0 },
        })
        .returning()) as [NodeRow];
    } catch (e) {
      throw uniqueErr(e);
    }
    const { code, expiresAt } = await issueJoinCode(row.id);
    // De relay-node moet het node-domein al doorsturen voordat de node verbindt (certificaat, join-controle).
    if (relayId !== null) void pokeRelay([relayId]);
    await logActivity({ action: "admin.node.create", userId: ctx.session!.userId, metadata: { id: row.id, name: row.name, fqdn: row.fqdn, join: true, supportsDomains: row.supportsDomains, httpRelayNodeId: relayId }, ip: ctx.ip, ctx });
    return { node: nodeOut(row), joinCommand: joinCommand(code), expiresAt };
  },

  joinCommand: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "BAD_REQUEST", message: "LOCAL_NODE" });
    const { code, expiresAt } = await issueJoinCode(n.id);
    await logActivity({ action: "admin.node.join_code", userId: ctx.session!.userId, metadata: { id: n.id }, ip: ctx.ip, ctx });
    return { joinCommand: joinCommand(code), expiresAt };
  },

  joinStatus: async ({ input }) => joinStatus(await nodeById(input.id)),

  updateDaemon: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "BAD_REQUEST", message: "LOCAL_NODE: the local daemon is updated with deploy/install.sh" });
    await call(() => daemonFor(n).updateDaemon());
    await logActivity({ action: "admin.node.update_daemon", userId: ctx.session!.userId, metadata: { id: n.id }, ip: ctx.ip, ctx });
    return ok;
  },

  uninstallCommand: async ({ input }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "BAD_REQUEST", message: "LOCAL_NODE" });
    return { command: uninstallCommand() };
  },

  create: async ({ input, ctx }) => {
    const t = newToken();
    let row: NodeRow;
    try {
      [row] = (await getDb()
        .insert(schema.nodes)
        .values({ ...input, publicPort: input.supportsDomains ? 443 : input.publicPort, fqdn: input.fqdn.toLowerCase(), tokenHash: t.tokenHash, tokenEnc: t.tokenEnc, isLocal: false })
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
    if (n.httpRelayNodeId && !rest.supportsDomains) throw new TRPCError({ code: "BAD_REQUEST", message: "RELAY_ACTIVE: switch the HTTP(S) relay off first" });
    if (!n.isLocal && n.supportsDomains && !rest.supportsDomains) await assertNoDomains(n.id);
    const publicPort = rest.supportsDomains ? 443 : rest.publicPort === 443 ? 8443 : rest.publicPort;
    const set = n.isLocal ? { name: rest.name, maxRamMb: rest.maxRamMb, maxDiskMb: rest.maxDiskMb, s3TargetId: rest.s3TargetId } : { ...rest, publicPort, fqdn: rest.fqdn.toLowerCase() };
    let row: NodeRow;
    try {
      [row] = (await getDb().update(schema.nodes).set(set).where(eq(schema.nodes.id, id)).returning()) as [NodeRow];
    } catch (e) {
      throw uniqueErr(e);
    }
    if (!n.isLocal && n.supportsDomains && !row.supportsDomains) await getDb().update(schema.servers).set({ domainsAllowed: false }).where(eq(schema.servers.nodeId, n.id));
    await logActivity({ action: "admin.node.update", userId: ctx.session!.userId, metadata: { id, fields: Object.keys(set) }, ip: ctx.ip, ctx });
    return nodeOut(row);
  },

  delete: async ({ input, ctx }) => {
    const n = await nodeById(input.id);
    if (n.isLocal) throw new TRPCError({ code: "FORBIDDEN", message: "LOCAL_NODE" });
    const [c] = await getDb().select({ n: count() }).from(schema.servers).where(eq(schema.servers.nodeId, n.id));
    if ((c?.n ?? 0) > 0) throw new TRPCError({ code: "CONFLICT", message: "NODE_HAS_SERVERS" });
    const [client] = await getDb().select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.httpRelayNodeId, n.id)).limit(1);
    if (client) throw new TRPCError({ code: "CONFLICT", message: "NODE_IS_RELAY: other nodes relay their HTTP(S) through this node" });
    // Nette afmelding: het door het panel gemaakte A-record gaat weg; de rest (codes) verdwijnt met de rij.
    if (n.joinOptions?.dnsMode === "cloudflare") {
      try {
        const cf = await cloudflareFor(n.fqdn);
        if (cf) await removeARecord(cf.token, cf.zoneId, n.fqdn);
      } catch {
        /* DNS opruimen is best effort */
      }
    }
    await getDb().delete(schema.nodes).where(eq(schema.nodes.id, n.id));
    if (n.httpRelayNodeId) void pokeRelay([n.httpRelayNodeId]);
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
