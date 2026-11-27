// Eigenaar: orchestrator. Rooktest van het skelet: de tRPC-route geeft mockdata terug.
import { describe, expect, it, vi } from "vitest";

describe("skelet", () => {
  it("tRPC-route serveert de mock", async () => {
    vi.stubEnv("PANEL_MOCK", "1");
    const { GET } = await import("@/app/api/trpc/[trpc]/route");
    const res = await GET(new Request("http://panel.test/api/trpc/auth.branding"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { data: { json: { panelName: string } } } };
    expect(body.result.data.json.panelName).toBeTruthy();
  }, 60_000);
});
