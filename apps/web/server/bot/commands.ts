/**
 * Slash-commando's van de Discord-bot. Geen eigen rechtenlogica: elk commando gaat door dezelfde
 * tRPC-procedures als het panel (`servers.list/get/power`), met een sessie voor het account dat
 * bij het Discord-ID hoort. Dus: eigenaar of subuser, `power` voor start/stop/restart,
 * opgeschorte servers alleen-lezen. De bot is nooit admin (geen TOTP via Discord) en kent geen
 * admin-commando's.
 */
import { buildRouter, createCallerFactory, type Ctx, type ServerSummary } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { implementation } from "../index";
import { logActivity } from "../activity";

// Lui opbouwen: server/index.ts importeert (via de scheduler/boot) ook deze module, dus bij het
// laden is `implementation` nog niet klaar.
function makeCallerFactory() {
  return createCallerFactory(buildRouter(implementation));
}
let cachedFactory: ReturnType<typeof makeCallerFactory> | null = null;
const caller = (ctx: Ctx) => (cachedFactory ??= makeCallerFactory())(ctx);

export const COMMANDS = [
  { name: "servers", description: "List your servers and their status", type: 1 },
  { name: "status", description: "Show the status of a server", type: 1, options: [{ name: "name", description: "Server name", type: 3, required: true, autocomplete: true }] },
  { name: "start", description: "Start a server", type: 1, options: [{ name: "name", description: "Server name", type: 3, required: true, autocomplete: true }] },
  { name: "stop", description: "Stop a server", type: 1, options: [{ name: "name", description: "Server name", type: 3, required: true, autocomplete: true }] },
  { name: "restart", description: "Restart a server", type: 1, options: [{ name: "name", description: "Server name", type: 3, required: true, autocomplete: true }] },
] as const;

export interface Reply {
  content?: string;
  embeds?: { title?: string; description?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[] }[];
}

const STATUS_ICON: Record<string, string> = {
  online: "🟢", starting: "🟡", stopping: "🟡", installing: "🛠️", sleeping: "😴", offline: "⚫", disk_exceeded: "🔴", install_failed: "🔴", unknown: "❔",
};
const COLOR: Record<string, number> = { online: 0x3ba55d, starting: 0xf0a232, stopping: 0xf0a232, offline: 0x95a5a6, disk_exceeded: 0xed4245, install_failed: 0xed4245 };

/** Een sessie voor het account bij dit Discord-ID, of een uitleg waarom dat niet kan. */
export async function apiForDiscordUser(discordId: string): Promise<{ api: ReturnType<typeof caller>; userId: number } | { error: string }> {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.discordId, discordId));
  if (!u) return { error: "You do not have a panel account yet. Log in to the panel once with Discord first." };
  if (u.blocked) return { error: "Your account is blocked." };
  const ctx: Ctx = {
    session: {
      sessionId: "discord-bot",
      userId: u.id,
      discordId,
      isAdmin: false, // de bot kan geen TOTP controleren: nooit admin
      isOwner: false,
      isEmergency: false,
      blocked: false,
      totpEnabled: u.totpEnabled,
      totpVerified: true, // Discord-identiteit; admin-rechten zijn juist uitgesloten
    },
    ip: null,
    userAgent: "discord-bot",
    resHeaders: new Headers(),
  };
  return { api: caller(ctx), userId: u.id };
}

/** Naam → server: exacte naam, dan shortId, dan unieke prefix (hoofdletterongevoelig). */
export function resolveServer(list: ServerSummary[], query: string): ServerSummary | { error: string } {
  const q = query.trim().toLowerCase();
  const pick = (m: ServerSummary[]) => (m.length === 1 ? m[0]! : null);
  const found =
    pick(list.filter((s) => s.name.toLowerCase() === q)) ??
    pick(list.filter((s) => s.shortId.toLowerCase() === q || s.uuid.toLowerCase() === q)) ??
    pick(list.filter((s) => s.name.toLowerCase().startsWith(q)));
  if (found) return found;
  const many = list.filter((s) => s.name.toLowerCase().startsWith(q) || s.name.toLowerCase() === q);
  if (many.length > 1) return { error: `Several servers match "${query}": ${many.map((s) => s.name).join(", ")}. Be more specific.` };
  return { error: `No server named "${query}" found among your servers.` };
}

function friendly(e: unknown): string {
  if (e instanceof TRPCError) {
    const m = e.message;
    if (m === "SUSPENDED") return "This server is suspended; it can only be viewed.";
    if (m.startsWith("MISSING_PERMISSION")) return "You do not have permission for that on this server.";
    if (m === "NO_ACCESS" || e.code === "NOT_FOUND") return "No access to that server.";
    if (m === "DAEMON_UNREACHABLE") return "The node does not respond right now.";
    if (m === "DISK_EXCEEDED") return "The server is over its disk limit and cannot start.";
    if (e.code === "CONFLICT" || e.code === "PRECONDITION_FAILED") return `Not possible right now (${m.toLowerCase().replace(/_/g, " ")}).`;
  }
  console.error("[bot] command failed:", e);
  return "Something went wrong.";
}

const line = (s: ServerSummary) => `${STATUS_ICON[s.status] ?? "❔"} **${s.name}** \`${s.shortId}\` - ${s.status}${s.suspended ? " (suspended)" : ""}`;

const ACTIONS = { start: "start", stop: "stop", restart: "restart" } as const;
const PAST = { start: "Starting", stop: "Stopping", restart: "Restarting" } as const;

/** Voert een commando uit. `name` is het commando, `arg` de servernaam. Gooit niet. */
export async function runCommand(discordId: string, name: string, arg?: string): Promise<Reply> {
  const a = await apiForDiscordUser(discordId);
  if ("error" in a) return { content: a.error };
  try {
    const list = await a.api.servers.list();
    if (name === "servers") {
      if (!list.length) return { content: "You have no servers." };
      return { embeds: [{ title: "Your servers", description: list.slice(0, 40).map(line).join("\n").slice(0, 4000), color: 0x5865f2 }] };
    }
    if (!(name in ACTIONS) && name !== "status") return { content: "Unknown command." };
    if (!arg?.trim()) return { content: "Give a server name." };
    const s = resolveServer(list, arg);
    if ("error" in s) return { content: s.error };
    if (name === "status") {
      const d = await a.api.servers.get({ uuid: s.uuid });
      return {
        embeds: [
          {
            title: `${STATUS_ICON[d.status] ?? "❔"} ${d.name}`,
            color: COLOR[d.status] ?? 0x5865f2,
            fields: [
              { name: "Status", value: d.status + (d.suspended ? " (suspended)" : ""), inline: true },
              { name: "Address", value: d.primaryAddress ?? "-", inline: true },
              { name: "Node", value: d.nodeName, inline: true },
              { name: "Limits", value: `${d.limits.cpuPct}% CPU, ${d.limits.ramMb} MB RAM, ${d.limits.diskMb} MB disk` },
            ],
          },
        ],
      };
    }
    const action = ACTIONS[name as keyof typeof ACTIONS];
    await a.api.servers.power({ uuid: s.uuid, action });
    await logActivity({ action: "bot.command", userId: a.userId, metadata: { command: name, server: s.uuid } });
    return { content: `${PAST[name as keyof typeof PAST]} **${s.name}**...` };
  } catch (e) {
    return { content: friendly(e) };
  }
}

/** Voorstellen voor autocomplete (max 25), alleen van de eigen servers. */
export async function suggest(discordId: string, typed: string): Promise<{ name: string; value: string }[]> {
  const a = await apiForDiscordUser(discordId);
  if ("error" in a) return [];
  try {
    const q = typed.trim().toLowerCase();
    return (await a.api.servers.list())
      .filter((s) => s.name.toLowerCase().includes(q))
      .slice(0, 25)
      .map((s) => ({ name: s.name.slice(0, 100), value: s.name.slice(0, 100) }));
  } catch {
    return [];
  }
}
