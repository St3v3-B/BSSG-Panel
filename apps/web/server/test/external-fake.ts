/**
 * Nep voor Modrinth/Hangar/PaperMC/Fabric: vervangt global fetch voor die hosts; al het andere
 * (de nep-daemon op 127.0.0.1) gaat gewoon door. Een niet-gemockte externe host faalt de test.
 */
import { vi } from "vitest";

export type Reply = { status?: number; json?: unknown; body?: Buffer | string; headers?: Record<string, string> };
export type Handler = (url: URL, init?: RequestInit) => Reply | undefined;

const EXTERNAL = ["api.modrinth.com", "cdn.modrinth.com", "hangar.papermc.io", "hangarcdn.papermc.io", "fill.papermc.io", "meta.fabricmc.net", "github.com", "evil.example", "raw.githubusercontent.com", "download.geysermc.org"];

export function mockExternal(handler: Handler) {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!EXTERNAL.includes(url.hostname)) return real(input, init);
    calls.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = handler(url, init);
    if (!r) return new Response("not mocked", { status: 599 });
    const body = r.json !== undefined ? JSON.stringify(r.json) : (r.body ?? "");
    return new Response(body as BodyInit, { status: r.status ?? 200, headers: r.headers });
  });
  return { calls, restore: () => vi.stubGlobal("fetch", real) };
}
