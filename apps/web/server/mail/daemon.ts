/**
 * Client voor `/api/mail/*` van de lokale daemon (zie INTERFACE van de mailmodule). Gebruikt de gewone
 * daemon-fetchlaag (DaemonClient: Bearer node-token, timeouts, DaemonUnreachableError/DaemonHttpError).

 * Types komen uit packages/api/openapi.yaml (gegenereerd).
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { DaemonClient } from "../daemon";
import { getEnv } from "../env";

export type {
  DaemonMailCheck,
  DaemonMailCheckReport,
  DaemonMailCheckRequest,
  DaemonMailQueueItem,
  DaemonMailQuotaItem,
  DaemonMailStatus,
} from "@panel/api";
import type {
  DaemonMailCheckReport,
  DaemonMailCheckRequest,
  DaemonMailQueueItem,
  DaemonMailQuotaItem,
  DaemonMailStatus,
} from "@panel/api";

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
