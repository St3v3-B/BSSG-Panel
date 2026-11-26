/**
 * Auth-middleware (Next.js "proxy"), aangeroepen vanuit apps/web/proxy.ts. Eigenaar: panel-api.
 * Fase 0: laat alles door. Draait in de Edge-achtige proxy-runtime: alleen lichte checks
 * (cookie aanwezig?), de echte controle zit in de tRPC-context.
 */
import { NextResponse, type NextRequest } from "next/server";

export function authProxy(_req: NextRequest): NextResponse {
  return NextResponse.next();
}
