/** Discord OAuth2 (authorization code, scope identify). */
import { allowPerIp } from "./http-limits";
import { getEnv } from "./env";
import { randomToken, safeEqual } from "./lib/crypto";
import { loginWithProfile, type DiscordProfile } from "./login";
import { cookie, cookieSecure, parseCookies } from "./session";

export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
export const DISCORD_API = "https://discord.com/api/v10";
export const STATE_COOKIE = "panel_oauth_state";

export const redirectUri = () => `https://${getEnv().PANEL_DOMAIN}/api/auth/discord/callback`;

/**
 * Alleen een strikt relatief pad binnen het panel (geen open redirect): begint met één `/`, geen
 * backslash of stuurtekens (ook niet na URL-decoderen; browsers strippen tab/CR/LF), en de URL
 * blijft op dezelfde origin.
 */
export function safeRedirect(to: string | null | undefined): string {
  if (!to || to.length > 2048) return "/";
  let cur = to;
  for (let i = 0; i < 3; i++) {
    if (/[\u0000-\u001f\u007f-\u009f\\]/.test(cur) || !/^\/(?![/\\])/.test(cur)) return "/";
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return "/";
    }
    if (next === cur) break;
    cur = next;
  }
  try {
    const u = new URL(to, "https://x.invalid");
    if (u.origin !== "https://x.invalid") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

/** Waar de browser heen moet; `/api/auth/discord/login` zet daar het state-cookie. */
export function loginUrl(redirectTo?: string): string {
  const r = safeRedirect(redirectTo);
  return r === "/" ? "/api/auth/discord/login" : `/api/auth/discord/login?redirectTo=${encodeURIComponent(r)}`;
}

export function startLogin(req: Request): Response {
  const env = getEnv();
  const url = new URL(req.url);
  const state = randomToken(24);
  const redirectTo = safeRedirect(url.searchParams.get("redirectTo"));
  const target = new URL(DISCORD_AUTHORIZE);
  target.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "none",
  }).toString();
  const value = `${state}.${Buffer.from(redirectTo).toString("base64url")}`;
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": cookie(STATE_COOKIE, value, { secure: cookieSecure(req), maxAgeSeconds: 600, path: "/api/auth/discord" }),
      "cache-control": "no-store",
    },
  });
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export function profileFrom(u: DiscordUser): DiscordProfile {
  return {
    discordId: u.id,
    name: (u.global_name || u.username || u.id).slice(0, 100),
    avatarUrl: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
  };
}

async function fetchProfile(code: string): Promise<DiscordProfile> {
  const env = getEnv();
  const tok = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tok.ok) throw new Error(`discord token ${tok.status}`);
  const { access_token } = (await tok.json()) as { access_token?: string };
  if (!access_token) throw new Error("discord returned no access_token");
  const me = await fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${access_token}` }, signal: AbortSignal.timeout(10_000) });
  if (!me.ok) throw new Error(`discord /users/@me ${me.status}`);
  const u = (await me.json()) as DiscordUser;
  if (!/^\d{15,21}$/.test(u.id ?? "")) throw new Error("onverwacht Discord-ID");
  return profileFrom(u);
}

function redirect(to: string, setCookies: string[]): Response {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  for (const c of setCookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

export async function finishLogin(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const secure = cookieSecure(req);
  const limited = !(await allowPerIp(req, "discord-callback"));
  const clearState = cookie(STATE_COOKIE, "", { secure, maxAgeSeconds: 0, path: "/api/auth/discord" });
  const stored = parseCookies(req.headers.get("cookie")).get(STATE_COOKIE);
  const [storedState, redirB64] = (stored ?? "").split(".");
  const redirectTo = safeRedirect(Buffer.from(redirB64 ?? "", "base64url").toString());
  const fail = (code: "blocked" | "discord" | "denied" | "state" | "ratelimit") =>
    redirect(`/login?error=${code}&redirectTo=${encodeURIComponent(redirectTo)}`, [clearState]);

  if (limited) return fail("ratelimit");
  if (url.searchParams.get("error")) return fail("denied");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !stored || !storedState || !safeEqual(storedState, state)) return fail("state");

  let profile: DiscordProfile;
  try {
    profile = await fetchProfile(code);
  } catch (e) {
    console.error("[auth] discord login failed:", e);
    return fail("discord");
  }
  const r = await loginWithProfile(profile, req, "discord");
  if (!r.ok) return fail("blocked");
  return redirect(r.totpPending ? `/login?totp=1&redirectTo=${encodeURIComponent(redirectTo)}` : redirectTo, [clearState, r.setCookie]);
}
