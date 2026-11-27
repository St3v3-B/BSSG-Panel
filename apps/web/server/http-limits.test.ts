import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as discordCallback } from "@/app/api/auth/discord/callback/route";
import { POST as testLoginRoute } from "@/app/api/auth/test/login/route";
import { POST as trpcPost } from "@/app/api/trpc/[trpc]/route";
import { AUTH_IP_MAX, MUTATIONS_PER_MINUTE } from "./http-limits";
import { createContext } from "./context";
import { useHarness } from "./test/harness";

const h = useHarness();

const testLogin = (ip: string, discordId = "630000000000000001") =>
  testLoginRoute(new Request("http://panel.test/api/auth/test/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ discordId, name: "RL" }) }));
const callback = (ip: string) => discordCallback(new NextRequest("http://panel.test/api/auth/discord/callback?code=x&state=y", { headers: { "x-forwarded-for": ip } }));
const post = (cookie: string | null, ip = "203.0.113.77") =>
  createContext(new Request("http://panel.test/api/trpc/auth.logout", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "x-forwarded-for": ip } }), new Headers());

describe("rate limits op de HTTP-ingangen", () => {
  it("test-login per IP: daarna 429, ander IP kan nog", async () => {
    for (let i = 0; i < AUTH_IP_MAX; i++) expect((await testLogin("192.0.2.10")).status).toBe(200);
    const res = await testLogin("192.0.2.10");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await testLogin("192.0.2.11")).status).toBe(200);
  });

  it("Discord-callback per IP: daarna redirect naar /login?error=ratelimit", async () => {
    for (let i = 0; i < AUTH_IP_MAX; i++) expect((await callback("192.0.2.20")).headers.get("location")).toContain("error=state");
    expect((await callback("192.0.2.20")).headers.get("location")).toContain("error=ratelimit");
    expect((await callback("192.0.2.21")).headers.get("location")).toContain("error=state");
  });

  it("tRPC-mutaties per gebruiker (niet per IP), queries tellen niet", async () => {
    const a = await h.user({ discordId: "630000000000000002" });
    const b = await h.user({ discordId: "630000000000000003" });
    for (let i = 0; i < MUTATIONS_PER_MINUTE; i++) await post(a.cookie);
    await expect(post(a.cookie)).rejects.toThrow(/RATE_LIMITED/);
    await expect(post(a.cookie, "198.51.100.5")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(post(b.cookie)).resolves.toBeTruthy(); // andere gebruiker, zelfde IP
    // GET (query) telt niet
    await expect(createContext(new Request("http://panel.test/api/trpc/auth.me", { headers: { cookie: a.cookie } }), new Headers())).resolves.toBeTruthy();
  });

  it("de route geeft een nette TOO_MANY_REQUESTS-fout met RATE_LIMITED", async () => {
    const u = await h.user({ discordId: "630000000000000004" });
    const call = () =>
      trpcPost(new Request("http://panel.test/api/trpc/account.revokeOtherSessions", { method: "POST", headers: { cookie: u.cookie, "content-type": "application/json" }, body: "{}" }));
    for (let i = 0; i < MUTATIONS_PER_MINUTE; i++) await post(u.cookie);
    const res = await call();
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("RATE_LIMITED");
  });

  it("anoniem per IP", async () => {
    for (let i = 0; i < MUTATIONS_PER_MINUTE; i++) await post(null, "192.0.2.99");
    await expect(post(null, "192.0.2.99")).rejects.toThrow(/RATE_LIMITED/);
  });
});
