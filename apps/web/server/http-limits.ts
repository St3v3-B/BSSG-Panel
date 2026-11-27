/** Rate limits voor de HTTP-ingangen (OAuth-callback, test-login, tRPC-mutaties), via de gedeelde limiter. */
import { TRPCError } from "@trpc/server";
import { getLimiter } from "./lib/ratelimit";
import { clientIp } from "./login";

export const AUTH_IP_MAX = 20;
export const AUTH_IP_WINDOW_SECONDS = 60;
export const MUTATIONS_PER_MINUTE = 300;

/** Telt een verzoek voor `name` per IP; false als de limiet bereikt is. */
export async function allowPerIp(req: Request, name: string, max = AUTH_IP_MAX, windowSeconds = AUTH_IP_WINDOW_SECONDS): Promise<boolean> {
  return (await getLimiter().hit(`http:${name}:ip:${clientIp(req) ?? "unknown"}`, windowSeconds)) <= max;
}

/**
 * tRPC-mutaties (POST) per gebruiker, anoniem per IP. Ruim bemeten: bedoeld tegen runaway scripts,
 * niet tegen normaal gebruik. Gooit TOO_MANY_REQUESTS met message RATE_LIMITED.
 */
export async function limitMutations(req: Request, userId: number | null): Promise<void> {
  if (req.method !== "POST") return;
  const key = userId !== null ? `http:trpc:u:${userId}` : `http:trpc:ip:${clientIp(req) ?? "unknown"}`;
  if ((await getLimiter().hit(key, 60)) > MUTATIONS_PER_MINUTE) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
}
