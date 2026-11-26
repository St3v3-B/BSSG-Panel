/**
 * Ingang van de echte backend. Eigenaar: panel-api.
 * Fase 0: alles NOT_IMPLEMENTED en geen sessie. panel-api vervangt dit.
 */
import { notImplemented, type Ctx, type Implementation } from "@panel/api";

export const implementation: Implementation = notImplemented();

export async function createContext(req: Request, resHeaders: Headers): Promise<Ctx> {
  return {
    session: null,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
    resHeaders,
  };
}
