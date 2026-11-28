/** Mock voor de tab Spelers: per server een in-memory whitelist/ops/bans en een paar online spelers. */
import { TRPCError } from "@trpc/server";
import { playersPlatform, isBedrockPlayerName, type PlayersInfo, type PlayersOnline } from "../players";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

type I = Implementation;

interface Deps {
  server: (uuid: string) => { uuid: string; templateSlug: string; status: s.ServerStatus };
}

/** Deterministische nep-UUID uit een naam (mock; het echte panel vraagt Mojang of leidt de offline-UUID af). */
function fakeUuid(name: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ (name.charCodeAt(i % name.length) + i), 16777619) >>> 0;
    out.push((h & 15).toString(16));
  }
  const x = out.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

export function createPlayersMock(d: Deps) {
  const state = new Map<string, PlayersInfo & { online: Array<{ name: string; server: string | null }> }>();
  const get = (uuid: string) => {
    const x = d.server(uuid);
    const platform = playersPlatform(x.templateSlug);
    if (!state.has(uuid)) {
      const p = (n: string) => ({ name: n, uuid: fakeUuid(n) });
      state.set(uuid, {
        supported: !!platform,
        platform,
        running: x.status === "online",
        onlineMode: true,
        floodgate: x.templateSlug === "paper",
        whitelistEnabled: false,
        whitelist: [p("Steve"), p("Alex")],
        ops: [{ ...p("Steve"), level: 4 }],
        bans: [{ ...p("Griefer_42"), reason: "Griefing spawn", source: "Server", created: "2026-11-01 12:00:00 +0100", expires: null }],
        ipBans: [{ ip: "198.51.100.23", reason: "Bot attack", source: "Server", created: "2026-11-02 08:00:00 +0100", expires: null }],
        online: platform === "proxy" ? [{ name: "Steve", server: "lobby" }, { name: "Alex", server: "survival" }] : [{ name: "Steve", server: null }, { name: "Alex", server: null }, { name: ".PocketPlayer", server: null }],
      });
    }
    const st = state.get(uuid)!;
    st.running = x.status === "online";
    return st;
  };
  const info = (uuid: string): PlayersInfo => {
    const { online: _o, ...rest } = get(uuid);
    return structuredClone(rest);
  };
  const bad = (message: string, code: "BAD_REQUEST" | "PRECONDITION_FAILED" = "BAD_REQUEST") => new TRPCError({ code, message });

  const players: I["players"] = {
    info: ({ input }) => info(input.uuid),
    online: ({ input }): PlayersOnline => {
      const st = get(input.uuid);
      if (!st.running) return { running: false, online: null, max: null, players: [], complete: true, source: "none" };
      return { running: true, online: st.online.length, max: 20, players: st.online.map((o) => ({ name: o.name, uuid: isBedrockPlayerName(o.name) ? null : fakeUuid(o.name), server: o.server })), complete: true, source: "ping" };
    },
    manage: ({ input }) => {
      const st = get(input.uuid);
      if (st.platform !== "java") throw bad("NOT_SUPPORTED");
      const op = input.op;
      if ("name" in op && isBedrockPlayerName(op.name) && !st.floodgate) throw bad("BEDROCK_NOT_AVAILABLE");
      const entry = (n: string) => ({ name: n, uuid: isBedrockPlayerName(n) ? null : fakeUuid(n) });
      const drop = <T extends { name: string }>(l: T[], n: string) => l.filter((e) => e.name.toLowerCase() !== n.toLowerCase());
      switch (op.action) {
        case "whitelistOn":
        case "whitelistOff":
          st.whitelistEnabled = op.action === "whitelistOn";
          break;
        case "whitelistAdd":
          st.whitelist = [...drop(st.whitelist, op.name), entry(op.name)];
          break;
        case "whitelistRemove":
          st.whitelist = drop(st.whitelist, op.name);
          break;
        case "op":
          st.ops = [...drop(st.ops, op.name), { ...entry(op.name), level: 4 }];
          break;
        case "deop":
          st.ops = drop(st.ops, op.name);
          break;
        case "ban":
          st.bans = [...drop(st.bans, op.name), { ...entry(op.name), reason: op.reason || null, source: "Panel", created: new Date().toISOString(), expires: null }];
          st.online = drop(st.online, op.name);
          break;
        case "pardon":
          st.bans = drop(st.bans, op.name);
          break;
        case "banIp":
          if (!st.running && !/[.:]/.test(op.target)) throw bad("IP_REQUIRED");
          st.ipBans = [...st.ipBans.filter((b) => b.ip !== op.target), { ip: /[.:]/.test(op.target) ? op.target : "203.0.113.77", reason: op.reason || null, source: "Panel", created: new Date().toISOString(), expires: null }];
          break;
        case "pardonIp":
          st.ipBans = st.ipBans.filter((b) => b.ip !== op.ip);
          break;
        case "kick":
          if (!st.running) throw bad("SERVER_NOT_RUNNING", "PRECONDITION_FAILED");
          st.online = drop(st.online, op.name);
          break;
      }
      return info(input.uuid);
    },
  };
  return players;
}
