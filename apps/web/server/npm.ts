/**
 * Node achter Nginx Proxy Manager (HTTP_MODE=npm, zie daemon/proxy/npm.go). NPM bezit 80/443 en de certificaten; de
 * daemon van de node beheert daar de proxy hosts voor alle domeinen van de node (node-domein, sites, game-domeinen met
 * HTTP en op de lokale node het panel-domein) en stuurt ze naar zijn HTTP-only Caddy.
 *
 * Keuze: het panel bewaart de instellingen (geheimen versleuteld: npm_password_enc, npm_cloudflare_token_enc) en geeft
 * ze alleen aan de daemon van die node via GET /api/remote/npm (node-token), net als het relay-geheim. Ze gaan nooit
 * terug naar de browser; de admin ziet alleen hasPassword/hasCloudflareToken. "Test verbinding" loopt via de daemon,
 * want de NPM-adminpoort (bv. http://127.0.0.1:81) is alleen vanaf de node bereikbaar.
 */
import type { DashboardAlert as DashboardAlertSchema, NodeNpmInput, NodeNpmStatus, NpmTestResult } from "@panel/api";
import type { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { decrypt, encrypt } from "./lib/crypto";
import { publicPanelUrl } from "./routers/nodes";

type NodeRow = typeof schema.nodes.$inferSelect;
type NpmReport = NonNullable<NodeRow["npmStatus"]>;
type DashboardAlert = z.infer<typeof DashboardAlertSchema>;

const STATES = new Set(["unconfigured", "ok", "login_failed", "unreachable", "error"]);
const SSL = new Set(["pending", "dns_wrong", "issuing", "active", "failed"]);

/** Commando voor op de node (of de panel-machine) om Caddy achter NPM te zetten (of terug naar direct). */
export function npmModeCommand(n: Pick<NodeRow, "isLocal">, mode: "npm" | "direct"): string {
  if (n.isLocal) return `cd ${process.env.PANEL_REPO_DIR || "/opt/panel"} && sudo bash deploy/install.sh --http-mode ${mode}`;
  return `curl -fsSL ${publicPanelUrl()}/join | sudo bash -s -- --http-mode ${mode}`;
}

/** admin.nodes.npmStatus */
export function npmStatus(n: NodeRow): NodeNpmStatus {
  const st = n.npmSettings;
  const r = n.npmStatus;
  return {
    settings: st
      ? {
          url: st.url,
          email: st.email,
          forwardHost: st.forwardHost,
          forwardPort: st.forwardPort,
          ssl: st.ssl,
          forceSsl: st.forceSsl,
          hasPassword: !!n.npmPasswordEnc,
          hasCloudflareToken: !!n.npmCloudflareTokenEnc,
        }
      : null,
    report:
      st && r
        ? {
            state: (STATES.has(r.state) ? r.state : "error") as NonNullable<NodeNpmStatus["report"]>["state"],
            error: r.error,
            version: r.version,
            proxyHosts: r.proxyHosts,
            managedHosts: r.managedHosts,
            conflicts: r.conflicts,
            hosts: r.hosts.map((h) => ({ host: h.host, ssl: (SSL.has(h.ssl) ? h.ssl : "pending") as "pending", error: h.error })),
            httpMode: r.httpMode,
            reportedAt: new Date(r.reportedAt),
          }
        : null,
    modeCommand: st || n.npmStatus?.httpMode === "npm" ? npmModeCommand(n, st ? "npm" : "direct") : null,
  };
}

const notAllowed = (why: string) => new TRPCError({ code: "BAD_REQUEST", message: `NPM_NOT_ALLOWED: ${why}` });

/** admin.nodes.setNpm; null = terug naar direct (Caddy op 80/443). */
export async function setNpm(n: NodeRow, input: NodeNpmInput | null): Promise<NodeRow> {
  const db = getDb();
  if (input === null) {
    const [row] = (await db
      .update(schema.nodes)
      .set({ npmSettings: null, npmPasswordEnc: null, npmCloudflareTokenEnc: null })
      .where(eq(schema.nodes.id, n.id))
      .returning()) as [NodeRow];
    return row;
  }
  if (n.httpRelayNodeId) throw notAllowed("this node runs its HTTP(S) through a relay node; switch the relay off first");
  const [client] = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.httpRelayNodeId, n.id)).limit(1);
  if (client) throw notAllowed("other nodes relay their HTTP(S) through this node");
  const passwordEnc = input.password ? encrypt(input.password) : n.npmPasswordEnc;
  if (!passwordEnc) throw new TRPCError({ code: "BAD_REQUEST", message: "NPM_PASSWORD_REQUIRED" });
  const cfEnc = input.cloudflareToken === undefined ? n.npmCloudflareTokenEnc : input.cloudflareToken === "" ? null : encrypt(input.cloudflareToken);
  if (input.ssl === "cloudflare" && !cfEnc) throw new TRPCError({ code: "BAD_REQUEST", message: "CLOUDFLARE_TOKEN_REQUIRED" });
  const settings = {
    url: input.url.replace(/\/$/, ""),
    email: input.email,
    forwardHost: input.forwardHost,
    forwardPort: input.forwardPort,
    ssl: input.ssl,
    forceSsl: input.forceSsl,
  };
  const changed = JSON.stringify(settings) !== JSON.stringify(n.npmSettings) || passwordEnc !== n.npmPasswordEnc || cfEnc !== n.npmCloudflareTokenEnc;
  const [row] = (await db
    .update(schema.nodes)
    // Achter NPM heeft de node domeinondersteuning en is hij op 443 bereikbaar (via NPM).
    .set({ npmSettings: settings, npmPasswordEnc: passwordEnc, npmCloudflareTokenEnc: cfEnc, supportsDomains: true, publicPort: 443, ...(changed ? { npmStatus: null } : {}) })
    .where(eq(schema.nodes.id, n.id))
    .returning()) as [NodeRow];
  return row;
}

/** Vraagt de daemon de NPM-instellingen nu op te halen (best effort; anders binnen een minuut). */
export async function pokeNpm(n: NodeRow, timeoutMs = 4000): Promise<void> {
  try {
    await daemonFor(n).npmRefresh(timeoutMs);
  } catch {
    /* de node haalt het zelf op, of draait (nog) niet in HTTP_MODE=npm */
  }
}

/** admin.nodes.testNpm: inloggen vanaf de node; ontbrekende velden uit de bewaarde instellingen. */
export async function testNpm(n: NodeRow, input: { url?: string; email?: string; password?: string }): Promise<NpmTestResult> {
  const url = input.url || n.npmSettings?.url;
  const email = input.email || n.npmSettings?.email;
  const password = input.password || (n.npmPasswordEnc ? decrypt(n.npmPasswordEnc) : undefined);
  if (!url || !email) throw new TRPCError({ code: "BAD_REQUEST", message: "NPM_URL_REQUIRED" });
  if (!password) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NPM_PASSWORD_REQUIRED" });
  const r = await call(() => daemonFor(n).npmTest({ url, email, password }));
  return {
    state: (STATES.has(r.state) ? r.state : "error") as NpmTestResult["state"],
    error: r.error ?? null,
    version: r.version ?? null,
    proxyHosts: r.proxy_hosts,
    managedHosts: r.managed_hosts,
  };
}

export interface NpmRemoteConfig {
  enabled: boolean;
  url?: string;
  email?: string;
  password?: string;
  forward_host?: string;
  forward_port?: number;
  ssl?: "http" | "cloudflare";
  cloudflare_token?: string;
  force_ssl?: boolean;
  letsencrypt_email?: string;
  fixed_hosts?: string[];
}

/** GET /api/remote/npm voor een node. */
export function npmConfigFor(n: NodeRow): NpmRemoteConfig {
  const st = n.npmSettings;
  if (!st || !n.npmPasswordEnc) return { enabled: false };
  const env = getEnv();
  const fixed = [n.fqdn];
  if (n.isLocal && env.PANEL_DOMAIN && env.PANEL_DOMAIN !== n.fqdn) fixed.push(env.PANEL_DOMAIN);
  return {
    enabled: true,
    url: st.url,
    email: st.email,
    password: decrypt(n.npmPasswordEnc),
    forward_host: st.forwardHost ?? "",
    forward_port: st.forwardPort ?? 0,
    ssl: st.ssl,
    cloudflare_token: n.npmCloudflareTokenEnc ? decrypt(n.npmCloudflareTokenEnc) : "",
    force_ssl: st.forceSsl,
    letsencrypt_email: env.ACME_EMAIL ?? st.email,
    fixed_hosts: fixed,
  };
}

/** POST /api/remote/npm/status: wat de node over NPM meldt. */
export async function storeNpmReport(
  n: NodeRow,
  b: { http_mode?: string; state: string; error?: string | null; version?: string | null; proxy_hosts?: number; managed_hosts?: number; conflicts?: string[] | null; hosts?: { host: string; ssl: string; error?: string | null }[] | null },
): Promise<void> {
  const report: NpmReport = {
    state: b.state,
    error: b.error?.slice(0, 500) || null,
    version: b.version?.slice(0, 40) || null,
    proxyHosts: b.proxy_hosts ?? 0,
    managedHosts: b.managed_hosts ?? 0,
    conflicts: (b.conflicts ?? []).slice(0, 200),
    hosts: (b.hosts ?? []).slice(0, 500).map((h) => ({ host: h.host, ssl: h.ssl, error: h.error?.slice(0, 500) || null })),
    httpMode: b.http_mode ?? null,
    reportedAt: new Date().toISOString(),
  };
  await getDb().update(schema.nodes).set({ npmStatus: report }).where(eq(schema.nodes.id, n.id));
}

/** Dashboard-alerts voor nodes achter NPM: login mislukt, onbereikbaar, conflicten of nog niet omgezet. */
export function npmAlerts(nodes: NodeRow[], now: Date): DashboardAlert[] {
  const out: DashboardAlert[] = [];
  for (const n of nodes) {
    if (!n.npmSettings) continue;
    const r = n.npmStatus;
    let msg: string | null = null;
    if (!r) msg = null;
    else if (r.httpMode && r.httpMode !== "npm") msg = `Node ${n.name} is set to run behind Nginx Proxy Manager, but its Caddy still runs in ${r.httpMode} mode: run the mode command (Admin > Nodes)`;
    else if (r.state === "login_failed") msg = `Nginx Proxy Manager on node ${n.name}: login failed${r.error ? ` (${r.error})` : ""}`;
    else if (r.state === "unreachable") msg = `Nginx Proxy Manager on node ${n.name} is unreachable${r.error ? `: ${r.error}` : ""}`;
    else if (r.state === "error") msg = `Nginx Proxy Manager on node ${n.name}: ${r.error ?? "error"}`;
    else if (r.conflicts.length > 0) msg = `Nginx Proxy Manager on node ${n.name}: ${r.conflicts.length} domain(s) already exist there and are not managed by the panel (${r.conflicts.slice(0, 3).join(", ")})`;
    if (msg) out.push({ kind: "npm_error", message: msg, at: r ? new Date(r.reportedAt) : now, serverUuid: null, nodeId: n.id });
  }
  return out;
}
