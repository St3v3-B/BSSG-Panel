/**
 * Auth-middleware (Next.js "proxy"), aangeroepen vanuit apps/web/proxy.ts. Eigenaar: panel-api.
 * Alleen een lichte check: zonder sessiecookie gaan pagina's naar /login. De echte controle
 * (sessie geldig, TOTP, admin) zit in de tRPC-context en de procedures.
 */
import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_PREFIXES = ["/login", "/api/", "/_next/", "/join"];

export function authProxy(req: NextRequest): NextResponse {
  if (process.env.PANEL_MOCK === "1") return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p))) return NextResponse.next();
  // Bestanden uit public/ (logo, iconen) zijn openbaar.
  if (/\.[a-z0-9]{2,5}$/i.test(pathname)) return NextResponse.next();
  if (req.cookies.has("panel_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname === "/" ? "" : `?redirectTo=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}
