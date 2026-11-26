/** tRPC-context: sessie uit het cookie, admin-schap vers uit admin_discord_ids. */
import type { Ctx } from "@panel/api";
import { ensureBooted } from "./boot";
import { clientIp } from "./login";
import { cookieSecure, loadSession, sessionTokenFrom } from "./session";

/** Extra verzoekinfo die niet in Ctx past (bv. of cookies Secure moeten). */
const reqInfo = new WeakMap<Headers, { secure: boolean }>();

export function secureFor(ctx: Ctx): boolean {
  return reqInfo.get(ctx.resHeaders)?.secure ?? true;
}

export async function createContext(req: Request, resHeaders: Headers): Promise<Ctx> {
  await ensureBooted();
  reqInfo.set(resHeaders, { secure: cookieSecure(req) });
  const token = sessionTokenFrom(req);
  return {
    session: token ? await loadSession(token) : null,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
    resHeaders,
  };
}
