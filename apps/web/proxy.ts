// Eigenaar: orchestrator (skelet). De logica zit in server/proxy.ts (panel-api).
import type { NextRequest } from "next/server";
import { authProxy } from "@/server/proxy";

export function proxy(req: NextRequest) {
  return authProxy(req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/trpc|api/remote).*)"],
};
