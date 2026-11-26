"use client";
import type { PowerAction, ServerDetail, ServerStatus, Stats } from "@panel/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { ConsoleConnection, MockSocket, socketFactory, type ConnState, type WsServerMessage } from "@/app/_lib/console";
import { errorInfo } from "@/app/_lib/errors";
import { getT } from "@/app/_lib/i18n";
import { toServerStatus } from "@/app/_lib/format";

export type LineKind = "out" | "install" | "info" | "warning" | "error";

export interface ConsoleHandlers {
  onLine: (kind: LineKind, text: string) => void;
  /** Nieuwe verbinding: de backlog volgt, dus de terminal mag leeg. */
  onReset: () => void;
}

export interface LiveStats extends Stats {
  rxPerSec: number | null;
  txPerSec: number | null;
  at: number;
}

const MiB = 1024 * 1024;

export function statsFromWs(m: WsServerMessage): Stats {
  return {
    cpuPct: m.cpu_pct ?? 0,
    memoryBytes: m.memory_bytes ?? 0,
    memoryLimitBytes: m.memory_limit_bytes ?? 0,
    networkRxBytes: m.network_rx_bytes ?? 0,
    networkTxBytes: m.network_tx_bytes ?? 0,
    diskBytes: m.disk_bytes ?? 0,
    diskLimitBytes: m.disk_limit_bytes ?? 0,
    uptimeMs: m.uptime_ms ?? 0,
  };
}

/** Live console + stats voor één server via de daemon-websocket (of de mock-socket). */
export function useConsole(server: ServerDetail | undefined, handlers: ConsoleHandlers) {
  const utils = trpc.useUtils();
  const tokenMut = trpc.servers.consoleToken.useMutation();
  const commandMut = trpc.servers.sendCommand.useMutation();
  const powerMut = trpc.servers.power.useMutation({
    onSettled: () => {
      if (server) void utils.servers.get.invalidate({ uuid: server.uuid });
      void utils.servers.list.invalidate();
    },
  });

  const [state, setState] = useState<ConnState>("idle");
  const [retryInMs, setRetryInMs] = useState<number | undefined>();
  const [closeCode, setCloseCode] = useState<number | undefined>();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [tokenRefreshedAt, setTokenRefreshedAt] = useState<Date | null>(null);

  const connRef = useRef<ConsoleConnection | null>(null);
  const handlersRef = useRef(handlers);
  const fetchRef = useRef(tokenMut.mutateAsync);
  const serverRef = useRef(server);
  useEffect(() => {
    handlersRef.current = handlers;
    fetchRef.current = tokenMut.mutateAsync;
    serverRef.current = server;
  });

  const uuid = server?.uuid;
  const canRead = !!server?.permissions.includes("console.read");

  useEffect(() => {
    const srv = serverRef.current;
    if (!uuid || !canRead || !srv) return;
    setStatus(null);
    setStats(null);
    const conn = new ConsoleConnection({
      fetchToken: () => fetchRef.current({ uuid }),
      createSocket: socketFactory({
        status: srv.status,
        permissions: srv.permissions,
        memoryLimitBytes: srv.limits.ramMb * MiB,
        diskLimitBytes: srv.limits.diskMb * MiB,
        flavor: srv.type,
      }),
      onState: (s, info) => {
        setState(s);
        setRetryInMs(info.retryInMs);
        setCloseCode(info.closeCode);
      },
      onTokenError: (err) => {
        const { code } = errorInfo(err);
        return code === "FORBIDDEN" || code === "NOT_FOUND" || code === "UNAUTHORIZED";
      },
      onTokenRefreshed: () => setTokenRefreshedAt(new Date()),
      onMessage: (msg, { fresh }) => {
        const h = handlersRef.current;
        switch (msg.event) {
          case "auth_success":
            if (fresh) h.onReset();
            break;
          case "console_output":
            if (msg.line != null) h.onLine("out", msg.line);
            break;
          case "install_output":
            if (msg.line != null) h.onLine("install", msg.line);
            break;
          case "daemon_message":
            if (msg.line != null) h.onLine(msg.level === "error" ? "error" : msg.level === "warning" ? "warning" : "info", msg.line);
            break;
          case "error":
            h.onLine("error", msg.message ?? getT().console.unknownError);
            break;
          case "status": {
            const st = toServerStatus(msg.state);
            setStatus(st);
            if (st !== "online" && st !== "starting" && st !== "stopping") setStats(null);
            break;
          }
          case "stats": {
            const next = statsFromWs(msg);
            const now = Date.now();
            setStats((prev) => {
              const dt = prev ? (now - prev.at) / 1000 : 0;
              const ok = prev && dt > 0.2 && next.networkRxBytes >= prev.networkRxBytes;
              return {
                ...next,
                at: now,
                rxPerSec: ok ? (next.networkRxBytes - prev.networkRxBytes) / dt : (prev?.rxPerSec ?? null),
                txPerSec: ok ? (next.networkTxBytes - prev.networkTxBytes) / dt : (prev?.txPerSec ?? null),
              };
            });
            break;
          }
        }
      },
    });
    connRef.current = conn;
    conn.start();
    return () => {
      conn.stop();
      connRef.current = null;
    };
  }, [uuid, canRead]);

  const sendCommand = useCallback(
    async (command: string) => {
      if (!uuid) return;
      if (connRef.current?.send({ event: "send_command", command })) return;
      await commandMut.mutateAsync({ uuid, command });
    },
    [uuid, commandMut],
  );

  const power = useCallback(
    async (action: PowerAction) => {
      if (!uuid) return;
      await powerMut.mutateAsync({ uuid, action });
      // In mock-modus is er geen daemon die de statuswijziging doorgeeft: laat de mock-socket hem naspelen.
      const sock = connRef.current?.currentSocket;
      if (sock instanceof MockSocket) sock.simulatePower(action);
    },
    [uuid, powerMut],
  );

  const retry = useCallback(() => connRef.current?.retryNow(), []);

  return {
    state,
    retryInMs,
    closeCode,
    status,
    stats,
    tokenRefreshedAt,
    sendCommand,
    power,
    powerPending: powerMut.isPending ? powerMut.variables?.action : undefined,
    powerError: powerMut.error,
    commandError: commandMut.error,
    retry,
  };
}
