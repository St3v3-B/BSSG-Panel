/**
 * Client voor `/api/mail/*` van de lokale daemon (zie INTERFACE van de mailmodule). Gebruikt de gewone
 * daemon-fetchlaag (DaemonClient: Bearer node-token, timeouts, DaemonUnreachableError/DaemonHttpError).
 *
 * TODO(mail): na de merge van de daemon-agent staan deze endpoints in packages/api/openapi.yaml; vervang de
 * lokaal gedefinieerde types hieronder dan door de gegenereerde (`DaemonSchemas["MailCheckReport"]` enz.).
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { DaemonClient } from "../daemon";
import { getEnv } from "../env";

// ---------- TODO(mail): vervangen door DaemonSchemas[...] uit @panel/api ----------

export interface DaemonMailCheckRequest {
  mail_hostname: string;
  public_ipv4?: string | null;
  public_ipv6?: string | null;
}
export interface DaemonMailCheck {
  id: string;
  ok: boolean;
  required: boolean;
  detail: string;
  hint?: string;
  data?: Record<string, unknown>;
}
export interface DaemonMailCheckReport {
  checked_at: string;
  checks: DaemonMailCheck[];
}
export interface DaemonMailStatus {
  enabled: boolean;
  containers: Array<{ name: string; state: string; health?: string }>;
  queue: { active: number; deferred: number; hold: number };
  vmail_bytes?: number;
}
export interface DaemonMailQueueItem {
  queue_id: string;
  sender: string;
  recipients: string[];
  size: number;
  arrival_time: string;
  reason?: string;
}
export interface DaemonMailQuotaItem {
  address: string;
  used_bytes: number;
  limit_bytes: number;
}

// ---------- client ----------

export class MailDaemonClient extends DaemonClient {
  mailChecks(body: DaemonMailCheckRequest) {
    return this.request<DaemonMailCheckReport>("POST", "/api/mail/checks", body, 40_000);
  }
  mailStatus(timeoutMs = 5000) {
    return this.request<DaemonMailStatus>("GET", "/api/mail/status", undefined, timeoutMs);
  }
  mailEnable() {
    return this.request<void>("POST", "/api/mail/enable", undefined, 180_000);
  }
  mailDisable() {
    return this.request<void>("POST", "/api/mail/disable", undefined, 120_000);
  }
  mailReload() {
    return this.request<void>("POST", "/api/mail/reload", undefined, 60_000);
  }
  putDkim(domain: string, body: { selector: string; private_key_pem: string }) {
    return this.request<void>("PUT", `/api/mail/dkim/${encodeURIComponent(domain)}`, body, 30_000);
  }
  deleteDkim(domain: string) {
    return this.request<void>("DELETE", `/api/mail/dkim/${encodeURIComponent(domain)}`, undefined, 30_000);
  }
  mailQueue() {
    return this.request<{ items: DaemonMailQueueItem[] }>("GET", "/api/mail/queue", undefined, 15_000);
  }
  flushQueue() {
    return this.request<void>("POST", "/api/mail/queue/flush", undefined, 30_000);
  }
  deleteQueueItem(queueId: string) {
    return this.request<void>("DELETE", `/api/mail/queue/${encodeURIComponent(queueId)}`, undefined, 15_000);
  }
  mailboxQuota(addresses: string[], timeoutMs = 5000) {
    return this.request<{ items: DaemonMailQuotaItem[] }>("POST", "/api/mail/mailboxes/quota", { addresses }, timeoutMs);
  }
  deleteMailboxData(address: string) {
    return this.request<void>("DELETE", `/api/mail/mailboxes/${encodeURIComponent(address)}/data`, undefined, 60_000);
  }
}

/** De mailstack draait alleen op de lokale node: DAEMON_URL + NODE_TOKEN. */
export async function mailDaemon(): Promise<MailDaemonClient> {
  const env = getEnv();
  const [n] = await getDb().select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.isLocal, true));
  return new MailDaemonClient({ nodeId: n?.id ?? 0, baseUrl: env.DAEMON_URL, token: env.NODE_TOKEN });
}
