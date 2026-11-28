/**
 * Tab Spelers (`players.*`): online spelers, whitelist, operators en bans van Minecraft-servers.
 *
 * - Draaiend (`online`): vaste consolecommando's met strikt gevalideerde namen/IP's/redenen (geen
 *   stuurtekens), daarna leest het panel de JSON-bestanden opnieuw.
 * - Gestopt/slapend: het panel bewerkt whitelist.json, ops.json, banned-players.json, banned-ips.json en
 *   `white-list` in server.properties zelf via de bestands-API van de daemon.
 * - Online-lijst: server-list-ping (sample) als die alle spelers bevat; anders `list uuids` (Velocity:
 *   `glist all`) op de console en de nieuwe regels uit de backlog parsen. 5 s gecachet per server.
 */
import { createHash } from "node:crypto";
import { isBedrockPlayerName, isJavaPlayerName, isValidPlayerName, playersPlatform, type Implementation, type OnlinePlayer, type PlayerOp, type PlayersInfo, type PlayersOnline } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { logActivity } from "./activity";
import { DaemonHttpError, call, daemonFor } from "./daemon";
import { USER_AGENT } from "./lib/http";
import { requireServer, serverVariables, type ServerBundle } from "./servers-data";

/** Wachttijden (tests zetten ze kleiner). */
export const playersTiming = { settleMs: 700, listWaitMs: 3000, pollMs: 250, cacheMs: 5000 };

const bad = (message: string, code: "BAD_REQUEST" | "CONFLICT" | "PRECONDITION_FAILED" | "BAD_GATEWAY" = "BAD_REQUEST") => new TRPCError({ code, message });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const isIp = (s: string) => IPV4.test(s) || (s.includes(":") && IPV6.test(s));

// ---------- UUID's ----------

const dashed = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/** UUID die een offline-mode-server geeft: v3 (MD5) van `OfflinePlayer:<naam>`, zoals Java's UUID.nameUUIDFromBytes. */
export function offlineUuid(name: string): string {
  const b = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
  b[6] = (b[6]! & 0x0f) | 0x30;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return dashed(b.toString("hex"));
}

export function normUuid(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.toLowerCase();
  if (UUID_RE.test(s)) return s;
  if (/^[0-9a-f]{32}$/.test(s)) return dashed(s);
  return null;
}

/** Mojang: naam → (UUID, juiste schrijfwijze). null = bestaat niet. */
export async function mojangLookup(name: string): Promise<{ uuid: string; name: string } | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { headers: { "user-agent": USER_AGENT, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000), cache: "no-store" });
  } catch {
    throw bad("MOJANG_UNREACHABLE", "BAD_GATEWAY");
  }
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw bad("MOJANG_UNREACHABLE", "BAD_GATEWAY");
  const j = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null;
  const uuid = normUuid(j?.id);
  if (!uuid || typeof j?.name !== "string" || !isJavaPlayerName(j.name)) return null;
  return { uuid, name: j.name };
}

// ---------- bestanden ----------

const FILES = { whitelist: "/whitelist.json", ops: "/ops.json", bans: "/banned-players.json", ipBans: "/banned-ips.json", usercache: "/usercache.json", properties: "/server.properties" } as const;

async function readText(b: ServerBundle, path: string): Promise<string | null> {
  try {
    return await daemonFor(b.node).readFile(b.server.uuid, path);
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 404) return null;
    throw e;
  }
}

async function readList(b: ServerBundle, path: string): Promise<Array<Record<string, unknown>>> {
  const t = await call(() => readText(b, path));
  if (!t?.trim()) return [];
  try {
    const j = JSON.parse(t) as unknown;
    return Array.isArray(j) ? j.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  } catch {
    return [];
  }
}

const writeList = (b: ServerBundle, path: string, list: unknown[]) => call(() => daemonFor(b.node).writeFile(b.server.uuid, path, `${JSON.stringify(list, null, 2)}\n`));

export function parseProperties(t: string | null): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of (t ?? "").split(/\r?\n/)) {
    if (/^\s*[#!]/.test(line)) continue;
    const i = line.search(/[=:]/);
    if (i <= 0) continue;
    m.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return m;
}

/** Zet `key=value` in server.properties en laat de rest (ook commentaar) staan. */
export function setProperty(t: string | null, key: string, value: string): string {
  const lines = (t ?? "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let found = false;
  const out = lines.map((l) => {
    const i = l.search(/[=:]/);
    if (!/^\s*[#!]/.test(l) && i > 0 && l.slice(0, i).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);
const nameOf = (v: unknown) => (typeof v === "string" ? v.slice(0, 32) : "");
const sameName = (a: unknown, n: string) => typeof a === "string" && a.toLowerCase() === n.toLowerCase();

/** Datum zoals Minecraft hem in banned-*.json schrijft (`yyyy-MM-dd HH:mm:ss Z`). */
export const mcDate = (d = new Date()) => `${d.toISOString().slice(0, 19).replace("T", " ")} +0000`;

// ---------- server ----------

interface Ctx2 {
  b: ServerBundle;
  platform: "java" | "proxy" | null;
}

async function liveState(b: ServerBundle): Promise<string> {
  return (await call(() => daemonFor(b.node).getServer(b.server.uuid, 2000))).state;
}

async function hasFloodgate(b: ServerBundle): Promise<boolean> {
  for (const dir of ["/plugins", "/mods"]) {
    try {
      const l = await daemonFor(b.node).listFiles(b.server.uuid, dir);
      if (l.some((f) => !f.is_directory && /^floodgate.*\.jar$/i.test(f.name))) return true;
    } catch {
      // map bestaat niet
    }
  }
  return false;
}

async function effectiveOnlineMode(b: ServerBundle, props: Map<string, string>): Promise<boolean> {
  const vars = await serverVariables(b.server.id);
  const v = (k: string) => vars[k] ?? b.template.variables.find((x) => x.key === k)?.default ?? "";
  // Achter Velocity met modern forwarding staat online-mode hier uit, maar logt de proxy in met echte UUID's.
  if (v("VELOCITY_FORWARDING") === "true") return true;
  return (props.get("online-mode") ?? "true") !== "false";
}

function entry(e: Record<string, unknown>) {
  return { name: nameOf(e.name), uuid: normUuid(e.uuid) };
}

async function buildInfo(c: Ctx2, running?: boolean): Promise<PlayersInfo> {
  const { b, platform } = c;
  const isRunning = running ?? (await liveState(b)) === "online";
  const empty: PlayersInfo = { supported: false, platform, running: isRunning, onlineMode: true, floodgate: false, whitelistEnabled: false, whitelist: [], ops: [], bans: [], ipBans: [] };
  if (!platform) return empty;
  if (platform === "proxy") return { ...empty, supported: true, floodgate: await hasFloodgate(b) };
  const propsText = await call(() => readText(b, FILES.properties));
  // Generiek Java: alleen als het echt een Minecraft-server is.
  if (propsText === null && b.template.slug === "java-generic") return empty;
  const props = parseProperties(propsText);
  const [wl, ops, bans, ipBans, floodgate, onlineMode] = await Promise.all([
    readList(b, FILES.whitelist),
    readList(b, FILES.ops),
    readList(b, FILES.bans),
    readList(b, FILES.ipBans),
    hasFloodgate(b),
    effectiveOnlineMode(b, props),
  ]);
  return {
    supported: true,
    platform,
    running: isRunning,
    onlineMode,
    floodgate,
    whitelistEnabled: props.get("white-list") === "true",
    whitelist: wl.map(entry).filter((e) => e.name),
    ops: ops.map((e) => ({ ...entry(e), level: Math.min(4, Math.max(0, Number.isInteger(e.level) ? (e.level as number) : 4)) })).filter((e) => e.name),
    bans: bans.map((e) => ({ ...entry(e), reason: str(e.reason), source: str(e.source, 64), created: str(e.created, 40), expires: str(e.expires, 40) })).filter((e) => e.name),
    ipBans: ipBans.filter((e) => typeof e.ip === "string" && e.ip.length <= 45).map((e) => ({ ip: e.ip as string, reason: str(e.reason), source: str(e.source, 64), created: str(e.created, 40), expires: str(e.expires, 40) })),
  };
}

// ---------- online ----------

/** Nieuwe regels in `after` t.o.v. `before` (twee vensters op dezelfde ringbuffer). */
export function newLines(before: string[], after: string[]): string[] {
  for (let k = Math.min(before.length, after.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (after[i] !== before[before.length - k + i]) {
        same = false;
        break;
      }
    }
    if (same) return after.slice(k);
  }
  return after;
}

const stripAnsi = (l: string) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/§./g, "");

/** `list uuids` (vanilla/Paper/Fabric): "There are 2 of a max of 20 players online: Steve (uuid), Alex (uuid)". */
export function parseList(lines: string[]): { online: number; max: number; players: OnlinePlayer[] } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = stripAnsi(lines[i]!);
    const m = /There are (\d+)(?: of a max(?: of)? |\/)(\d+) players online:?\s*(.*)$/.exec(l);
    if (!m) continue;
    const players: OnlinePlayer[] = [];
    for (const part of m[3]!.split(/,\s*/)) {
      const pm = /^(\.?[A-Za-z0-9_]{1,16})(?:\s*\(([0-9a-fA-F-]{32,36})\))?$/.exec(part.trim());
      if (pm) players.push({ name: pm[1]!, uuid: normUuid(pm[2]), server: null });
    }
    return { online: Number(m[1]), max: Number(m[2]), players };
  }
  return null;
}

/** Velocity `glist all`: "[lobby] (2): Steve, Alex" per backend, plus een totaalregel. */
export function parseGlist(lines: string[]): { online: number; players: OnlinePlayer[] } | null {
  const players: OnlinePlayer[] = [];
  let total: number | null = null;
  for (const raw of lines) {
    const l = stripAnsi(raw);
    const s = /(?:^|\s)\[([A-Za-z0-9_.-]{1,64})\] \((\d+)\):\s*(.*)$/.exec(l);
    if (s) {
      for (const n of s[3]!.split(/,\s*/)) if (isJavaPlayerName(n.trim()) || isBedrockPlayerName(n.trim())) players.push({ name: n.trim(), uuid: null, server: s[1]! });
      continue;
    }
    const t = /There (?:are|is) (\d+) players? (?:currently )?(?:connected|online)/i.exec(l);
    if (t) total = Number(t[1]);
  }
  if (total === null) return null;
  return { online: total, players };
}

async function consoleList(b: ServerBundle, proxy: boolean): Promise<string[] | null> {
  const d = daemonFor(b.node);
  const before = (await d.logs(b.server.uuid, 200)).lines;
  await d.sendCommands(b.server.uuid, [proxy ? "glist all" : "list uuids"]);
  const until = Date.now() + playersTiming.listWaitMs;
  while (Date.now() < until) {
    await sleep(playersTiming.pollMs);
    const fresh = newLines(before, (await d.logs(b.server.uuid, 200)).lines);
    if (proxy ? parseGlist(fresh) : parseList(fresh)) {
      // Velocity print de serverregels vóór de totaalregel; even wachten op de rest is niet nodig.
      return fresh;
    }
  }
  return null;
}

const cache = new Map<string, { at: number; value: Promise<PlayersOnline> }>();
export const clearPlayersCache = () => cache.clear();

async function fetchOnline(c: Ctx2): Promise<PlayersOnline> {
  const { b } = c;
  const proxy = c.platform === "proxy";
  const none: PlayersOnline = { running: false, online: null, max: null, players: [], complete: true, source: "none" };
  if ((await liveState(b)) !== "online") return none;
  const d = daemonFor(b.node);
  const ping = await d.players(b.server.uuid).catch(() => null);
  const sample = (ping?.sample ?? []).map((p) => ({ name: p.name, uuid: normUuid(p.id), server: null })).filter((p) => isJavaPlayerName(p.name) || isBedrockPlayerName(p.name));
  const named = sample.filter((p) => p.uuid !== ZERO_UUID);
  const fromPing: PlayersOnline = { running: true, online: ping?.online ?? null, max: ping?.max ?? null, players: named, complete: false, source: ping?.online != null ? "ping" : "none" };
  if (ping?.online === 0) return { ...fromPing, players: [], complete: true };
  if (!proxy && ping?.online != null && ping.sample && named.length >= ping.online) return { ...fromPing, complete: true };
  try {
    const lines = await consoleList(b, proxy);
    if (lines) {
      if (proxy) {
        const g = parseGlist(lines)!;
        return { running: true, online: g.online, max: ping?.max ?? null, players: g.players, complete: g.players.length >= g.online, source: "console" };
      }
      const l = parseList(lines)!;
      return { running: true, online: l.online, max: l.max, players: l.players, complete: l.players.length >= l.online, source: "console" };
    }
  } catch {
    // console niet bruikbaar: wat de ping gaf
  }
  return fromPing;
}

function onlineCached(c: Ctx2): Promise<PlayersOnline> {
  const hit = cache.get(c.b.server.uuid);
  if (hit && Date.now() - hit.at < playersTiming.cacheMs) return hit.value;
  const value = fetchOnline(c);
  cache.set(c.b.server.uuid, { at: Date.now(), value });
  value.catch(() => cache.delete(c.b.server.uuid));
  return value;
}

// ---------- beheer ----------

/** Consolecommando voor een actie. Alles is al door het schema gevalideerd; hier nogmaals, als vangnet. */
export function commandFor(op: PlayerOp, floodgate: boolean): string {
  const name = (n: string) => {
    if (!isValidPlayerName(n, floodgate)) throw bad(isBedrockPlayerName(n) ? "BEDROCK_NOT_AVAILABLE" : "INVALID_PLAYER_NAME");
    return n;
  };
  const reason = (r?: string) => {
    if (!r) return "";
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(r) || r.length > 200) throw bad("INVALID_REASON");
    return ` ${r}`;
  };
  const ip = (s: string) => {
    if (!isIp(s)) throw bad("INVALID_IP");
    return s;
  };
  switch (op.action) {
    case "whitelistOn":
      return "whitelist on";
    case "whitelistOff":
      return "whitelist off";
    case "whitelistAdd":
      return isBedrockPlayerName(op.name) ? `fwhitelist add ${name(op.name).slice(1)}` : `whitelist add ${name(op.name)}`;
    case "whitelistRemove":
      return isBedrockPlayerName(op.name) ? `fwhitelist remove ${name(op.name).slice(1)}` : `whitelist remove ${name(op.name)}`;
    case "op":
      return `op ${name(op.name)}`;
    case "deop":
      return `deop ${name(op.name)}`;
    case "ban":
      return `ban ${name(op.name)}${reason(op.reason)}`;
    case "pardon":
      return `pardon ${name(op.name)}`;
    case "banIp":
      return `ban-ip ${isIp(op.target) ? op.target : name(op.target)}${reason(op.reason)}`;
    case "pardonIp":
      return `pardon-ip ${ip(op.ip)}`;
    case "kick":
      return `kick ${name(op.name)}${reason(op.reason)}`;
  }
}

/** UUID + schrijfwijze voor een speler die nog niet online is (gestopte server). */
async function resolvePlayer(b: ServerBundle, name: string, onlineMode: boolean): Promise<{ name: string; uuid: string }> {
  const cached = (await readList(b, FILES.usercache)).find((e) => sameName(e.name, name));
  const cu = cached && normUuid(cached.uuid);
  if (cu) return { name: nameOf(cached.name), uuid: cu };
  if (isBedrockPlayerName(name)) throw bad("BEDROCK_PLAYER_UNKNOWN", "PRECONDITION_FAILED");
  if (!onlineMode) return { name, uuid: offlineUuid(name) };
  const m = await mojangLookup(name);
  if (!m) throw bad("PLAYER_NOT_FOUND", "PRECONDITION_FAILED");
  return m;
}

async function applyToFiles(b: ServerBundle, op: PlayerOp, info: PlayersInfo, source: string): Promise<void> {
  const without = (l: Array<Record<string, unknown>>, n: string) => l.filter((e) => !sameName(e.name, n));
  switch (op.action) {
    case "whitelistOn":
    case "whitelistOff": {
      const t = await call(() => readText(b, FILES.properties));
      await call(() => daemonFor(b.node).writeFile(b.server.uuid, FILES.properties, setProperty(t, "white-list", String(op.action === "whitelistOn"))));
      return;
    }
    case "whitelistAdd": {
      const p = await resolvePlayer(b, op.name, info.onlineMode);
      const l = await readList(b, FILES.whitelist);
      return writeList(b, FILES.whitelist, [...without(l, p.name), { uuid: p.uuid, name: p.name }]);
    }
    case "op": {
      const p = await resolvePlayer(b, op.name, info.onlineMode);
      const props = parseProperties(await call(() => readText(b, FILES.properties)));
      const level = Math.min(4, Math.max(1, Number(props.get("op-permission-level")) || 4));
      const l = await readList(b, FILES.ops);
      return writeList(b, FILES.ops, [...without(l, p.name), { uuid: p.uuid, name: p.name, level, bypassesPlayerLimit: false }]);
    }
    case "ban": {
      const p = await resolvePlayer(b, op.name, info.onlineMode);
      const l = await readList(b, FILES.bans);
      return writeList(b, FILES.bans, [...without(l, p.name), { uuid: p.uuid, name: p.name, created: mcDate(), source, expires: "forever", reason: op.reason || "Banned by an operator." }]);
    }
    case "whitelistRemove":
    case "deop":
    case "pardon": {
      const path = op.action === "whitelistRemove" ? FILES.whitelist : op.action === "deop" ? FILES.ops : FILES.bans;
      const l = await readList(b, path);
      const next = without(l, op.name);
      if (next.length !== l.length) await writeList(b, path, next);
      return;
    }
    case "banIp": {
      if (!isIp(op.target)) throw bad("IP_REQUIRED");
      const l = await readList(b, FILES.ipBans);
      return writeList(b, FILES.ipBans, [...l.filter((e) => e.ip !== op.target), { ip: op.target, created: mcDate(), source, expires: "forever", reason: op.reason || "Banned by an operator." }]);
    }
    case "pardonIp": {
      const l = await readList(b, FILES.ipBans);
      const next = l.filter((e) => e.ip !== op.ip);
      if (next.length !== l.length) await writeList(b, FILES.ipBans, next);
      return;
    }
    case "kick":
      throw bad("SERVER_NOT_RUNNING", "PRECONDITION_FAILED");
  }
}

const FILE_STATES = new Set(["offline", "sleeping", "install_failed"]);

export const players: Implementation["players"] = {
  info: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "players.read");
    return buildInfo({ b: a.bundle, platform: a.bundle.server.type === "game" ? playersPlatform(a.bundle.template.slug) : null });
  },

  online: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "players.read");
    const platform = a.bundle.server.type === "game" ? playersPlatform(a.bundle.template.slug) : null;
    if (!platform) return { running: false, online: null, max: null, players: [], complete: true, source: "none" };
    return onlineCached({ b: a.bundle, platform });
  },

  manage: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "players.manage", { mutates: true });
    const b = a.bundle;
    const platform = b.server.type === "game" ? playersPlatform(b.template.slug) : null;
    if (platform !== "java") throw bad("NOT_SUPPORTED");
    const state = await liveState(b);
    const running = state === "online";
    if (!running && !FILE_STATES.has(state)) throw bad("SERVER_BUSY", "CONFLICT");
    const before = await buildInfo({ b, platform }, running);
    if (!before.supported) throw bad("NOT_SUPPORTED");
    const op = input.op;
    if ("name" in op && isBedrockPlayerName(op.name) && !before.floodgate) throw bad("BEDROCK_NOT_AVAILABLE");
    if (op.action === "banIp" && isBedrockPlayerName(op.target) && !before.floodgate) throw bad("BEDROCK_NOT_AVAILABLE");
    let via: "console" | "files";
    if (running) {
      const cmd = commandFor(op, before.floodgate);
      await call(() => daemonFor(b.node).sendCommands(b.server.uuid, [cmd]));
      via = "console";
      cache.delete(b.server.uuid);
      await sleep(playersTiming.settleMs);
    } else {
      await applyToFiles(b, op, before, "Panel");
      via = "files";
    }
    const { action, ...rest } = op;
    await logActivity({ action: `server.players.${action}`, userId: ctx.session!.userId, serverId: b.server.id, metadata: { ...rest, via }, ip: ctx.ip, ctx });
    return buildInfo({ b, platform }, running);
  },
};
