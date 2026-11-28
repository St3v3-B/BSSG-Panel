/**
 * Openbare REST-API voor API-sleutels (zie server/rest/). `GET /api/v1/openapi.json` is het OpenAPI 3.1-document.
 * In mock-modus (PANEL_MOCK=1) draait hij tegen de mock, zodat de documentatiepagina werkt.
 */
import { appRouter, contextFor, isMock } from "@/lib/router";
import { getEnv } from "@/server/env";
import { handleRest, restContext } from "@/server/rest/handler";

export const dynamic = "force-dynamic";

const handler = (req: Request) =>
  handleRest(req, {
    router: appRouter,
    context: isMock ? (r, h) => (r.headers.get("authorization") ? contextFor(r, h) : Promise.resolve({ session: null, ip: null, userAgent: null, resHeaders: h })) : restContext,
    baseUrl: isMock ? undefined : getEnv().PANEL_URL,
  });

export { handler as GET, handler as POST, handler as PUT, handler as DELETE };
