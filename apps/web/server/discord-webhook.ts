/** Discord-webhooks: URL-controle, hint zonder token, en versturen (met retries of één poging). */
import { DISCORD_WEBHOOK_RE, type WebhookStatus } from "@panel/api";

export const isWebhookUrl = (u: string) => DISCORD_WEBHOOK_RE.test(u);

/** Hint zonder het token: `…/webhooks/<id>/…abcd`. */
export function hookStatus(url: string | null | undefined): WebhookStatus {
  if (!url) return { set: false, hint: null };
  const m = /\/webhooks\/(\d+)\/(.+)$/.exec(url);
  return { set: true, hint: m ? `…/webhooks/${m[1]}/…${m[2]!.slice(-4)}` : "…" };
}

export interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  url?: string;
  timestamp: string;
  footer: { text: string };
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  /** Bij 429: hoe lang Discord wil dat we wachten. */
  retryAfterMs?: number;
}

/** Vervangbaar in tests: geen echte Discord-aanroepen. */
export const transport: { fetch: typeof fetch; sleep: (ms: number) => Promise<void> } = {
  fetch: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const MAX_ATTEMPTS = 3;

/**
 * POST naar de webhook. 429 → wacht `retry_after` (max 10 s); 5xx of netwerkfout → backoff
 * (1 s, 2 s); andere 4xx (ongeldige of verwijderde webhook) → meteen opgeven. Geen redirects.
 * `maxAttempts: 1` voor de wachtrij (die zelf later opnieuw probeert).
 */
export async function sendWebhook(url: string, embeds: Embed[], opts: { username?: string; maxAttempts?: number } = {}): Promise<SendResult> {
  if (!isWebhookUrl(url)) return { ok: false, status: null, attempts: 0 };
  const max = opts.maxAttempts ?? MAX_ATTEMPTS;
  const body = JSON.stringify({ username: opts.username ?? "Panel", embeds, allowed_mentions: { parse: [] } });
  let status: number | null = null;
  let retryAfterMs: number | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    let wait = 1000 * 2 ** (attempt - 1);
    try {
      const res = await transport.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      if (res.ok) return { ok: true, status, attempts: attempt };
      if (res.status === 429) {
        const j = (await res.json().catch(() => null)) as { retry_after?: number } | null;
        retryAfterMs = Math.max(0, (j?.retry_after ?? 1) * 1000);
        wait = Math.min(10_000, retryAfterMs);
      } else if (res.status < 500) {
        return { ok: false, status, attempts: attempt };
      }
    } catch {
      status = null;
    }
    if (attempt < max) await transport.sleep(wait);
  }
  return { ok: false, status, attempts: max, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}
