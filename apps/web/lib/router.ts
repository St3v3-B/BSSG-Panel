/**
 * Kiest de implementatie: mock (PANEL_MOCK=1, voor panel-ui) of de echte uit server/.
 * Eigenaar: orchestrator (skelet).
 */
import "server-only";
import { buildRouter, type Ctx } from "@panel/api";
import { createMock, mockSession } from "@panel/api/mock";
import { createContext, implementation } from "@/server";

export const isMock = process.env.PANEL_MOCK === "1";

export const appRouter = buildRouter(isMock ? createMock() : implementation);

export async function contextFor(req: Request, resHeaders: Headers): Promise<Ctx> {
  if (isMock) {
    return { session: mockSession(), ip: "127.0.0.1", userAgent: req.headers.get("user-agent"), resHeaders };
  }
  return createContext(req, resHeaders);
}
