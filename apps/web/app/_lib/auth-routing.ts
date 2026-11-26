/**
 * Routebeveiliging aan de clientkant. De server dwingt de toegang af (tRPC-builder);
 * dit bepaalt alleen welk scherm de browser toont.
 */
import type { Me } from "@panel/api";

export type GateDecision =
  | { kind: "loading" }
  | { kind: "ok" }
  | { kind: "redirect"; to: string }
  | { kind: "blocked" };

export function loginHref(pathname: string | null | undefined): string {
  const p = pathname && pathname.startsWith("/") && !pathname.startsWith("//") && !pathname.startsWith("/login") ? pathname : "/";
  return p === "/" ? "/login" : `/login?redirectTo=${encodeURIComponent(p)}`;
}

/** Alleen interne paden toestaan als redirectTo (geen open redirect). */
export function safeRedirect(to: string | null | undefined): string {
  if (!to || !to.startsWith("/") || to.startsWith("//") || to.startsWith("/\\") || to.startsWith("/login")) return "/";
  return to;
}

/**
 * @param me       resultaat van auth.me (undefined = nog aan het laden)
 * @param account  resultaat van account.get (user-niveau): fout BLOCKED / TOTP_PENDING / UNAUTHORIZED
 */
export function decideGate(opts: {
  pathname: string;
  me: Me | null | undefined;
  meError?: unknown;
  accountError?: { blocked: boolean; totpPending: boolean; unauthorized: boolean } | null;
}): GateDecision {
  const { me, pathname, accountError } = opts;
  if (accountError?.blocked) return { kind: "blocked" };
  if (me === undefined) return opts.meError ? { kind: "redirect", to: loginHref(pathname) } : { kind: "loading" };
  if (me === null) return { kind: "redirect", to: loginHref(pathname) };
  if (me.totpEnabled && !me.totpVerified) return { kind: "redirect", to: loginHref(pathname) };
  if (accountError?.totpPending || accountError?.unauthorized) return { kind: "redirect", to: loginHref(pathname) };
  return { kind: "ok" };
}

export type AdminDecision = "ok" | "not_admin" | "totp_required";

/** /admin: alleen admins met 2FA aan én geverifieerd. */
export function decideAdmin(me: Me): AdminDecision {
  if (!me.isAdmin) return "not_admin";
  if (!me.totpEnabled || !me.totpVerified) return "totp_required";
  return "ok";
}
