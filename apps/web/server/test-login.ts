import { DiscordId } from "@panel/api";
import { z } from "zod";
import { ensureBooted } from "./boot";
import { testLoginEnabled } from "./env";
import { loginWithProfile } from "./login";

const Body = z.object({ discordId: DiscordId, name: z.string().min(1).max(100) });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export async function testLogin(req: Request): Promise<Response> {
  if (!testLoginEnabled()) return new Response("Not Found", { status: 404 });
  await ensureBooted();
  let input: z.output<typeof Body>;
  try {
    const r = Body.safeParse(await req.json());
    if (!r.success) return json(400, { error: "bad_request", message: r.error.issues.map((i) => i.message).join("; ") });
    input = r.data;
  } catch {
    return json(400, { error: "bad_request" });
  }
  const r = await loginWithProfile({ discordId: input.discordId, name: input.name, avatarUrl: null }, req, "test");
  if (!r.ok) return json(403, { error: "blocked" });
  return json(200, { ok: true, userId: r.userId, totpPending: r.totpPending }, { "set-cookie": r.setCookie });
}
