"use client";
import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { Plug, PlugZap, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { CLOSE_TERMINAL, TerminalSession, terminalSocketFactory, type TerminalCloseInfo, type TerminalSocketFactory, type TerminalState } from "@/app/_lib/terminal";
import { cn } from "@/lib/utils";

/** Extra toetsen voor telefoons (geen Esc/Tab/Ctrl/pijltjes op het schermtoetsenbord). */
export const MOBILE_KEYS: Array<{ key: "esc" | "tab" | "ctrlC" | "ctrlD" | "up" | "down" | "left" | "right"; seq: string }> = [
  { key: "esc", seq: "\x1b" },
  { key: "tab", seq: "\t" },
  { key: "ctrlC", seq: "\x03" },
  { key: "ctrlD", seq: "\x04" },
  { key: "up", seq: "\x1b[A" },
  { key: "down", seq: "\x1b[B" },
  { key: "left", seq: "\x1b[D" },
  { key: "right", seq: "\x1b[C" },
];

/** Tekst bij het sluiten van de sessie. */
export function closeText(t: ReturnType<typeof useT>["devaccess"]["terminal"], info: TerminalCloseInfo): string {
  if (info.exitCode !== undefined) return t.exited(info.exitCode);
  switch (info.code) {
    case CLOSE_TERMINAL.idle:
      return t.closedIdle;
    case CLOSE_TERMINAL.tooMany:
      return t.closedTooMany;
    case CLOSE_TERMINAL.noPermission:
    case CLOSE_TERMINAL.tokenInvalid:
      return t.closedDenied;
  }
  return info.message ? `${t.closedGeneric} ${info.message}` : t.closedGeneric;
}

/** Interactieve xterm.js-shell in een tools-container van de server. */
export function WebTerminal({ uuid, createSocket = terminalSocketFactory }: { uuid: string; createSocket?: TerminalSocketFactory }) {
  const t = useT();
  const tt = t.devaccess.terminal;
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const session = useRef<TerminalSession | null>(null);
  const [state, setState] = useState<TerminalState>("idle");
  const [note, setNote] = useState<string | null>(null);
  const tokenM = trpc.servers.terminalToken.useMutation();
  const mutate = useRef(tokenM.mutateAsync);
  mutate.current = tokenM.mutateAsync;

  const connect = useCallback(() => {
    const x = term.current;
    if (!x) return;
    session.current?.stop();
    setNote(null);
    x.reset();
    const s = new TerminalSession({
      fetchToken: async (refresh) => {
        try {
          return await mutate.current({ uuid, refresh });
        } catch (e) {
          throw new Error(errorText(e));
        }
      },
      createSocket,
      onOutput: (d) => term.current?.write(d),
      onState: (st, info) => {
        setState(st);
        if (st === "connected") term.current?.focus();
        if (st === "closed") setNote(closeText(tt, info));
      },
    });
    session.current = s;
    void s.start(x.cols, x.rows);
  }, [uuid, createSocket, tt]);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !host.current) return;
      const x = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        fontSize: window.innerWidth < 640 ? 12 : 13,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: { background: "#00000000", foreground: "#e4e4e7", selectionBackground: "#52525b" },
        allowTransparency: true,
      });
      const f = new FitAddon();
      x.loadAddon(f);
      x.open(host.current);
      try {
        f.fit();
      } catch {
        /* nog geen afmetingen */
      }
      x.onData((d) => session.current?.write(d));
      x.onResize(({ cols, rows }) => session.current?.resize(cols, rows));
      term.current = x;
      fit.current = f;
      ro = new ResizeObserver(() => {
        try {
          f.fit();
        } catch {
          /* genegeerd */
        }
      });
      ro.observe(host.current);
      connect();
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      session.current?.stop();
      session.current = null;
      term.current?.dispose();
      term.current = null;
    };
    // connect hangt af van uuid; bij een andere server opnieuw opbouwen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);

  const dot = { idle: "bg-muted-foreground", connecting: "bg-warning animate-pulse", connected: "bg-success", closed: "bg-destructive" }[state];
  return (
    <Card className="dark flex h-[min(36rem,calc(100dvh-14rem))] min-h-[22rem] flex-col overflow-hidden border-white/10 bg-[oklch(0.125_0.02_275)] text-foreground lg:h-[38rem]" data-testid="web-terminal">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-white/[0.03] px-4 py-2">
        <span className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="terminal-state" data-state={state}>
          <span className={cn("size-2 rounded-full", dot)} aria-hidden /> {tt.states[state]}
        </span>
        <div className="flex items-center gap-1">
          {state === "connected" || state === "connecting" ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => session.current?.stop()} data-testid="terminal-disconnect">
              <X /> {tt.disconnect}
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={connect} data-testid="terminal-connect">
              {state === "idle" ? <Plug /> : <RotateCcw />} {state === "idle" ? tt.connect : tt.reconnect}
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 px-2 py-2 sm:px-3">
        <div ref={host} className="console-host h-full min-h-0 w-full overflow-hidden" data-testid="terminal-host" />
        {state === "closed" && note && (
          <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/90 px-3 py-2 text-sm" role="status" data-testid="terminal-note">
            <span className="flex min-w-0 items-center gap-2">
              <PlugZap className="size-4 shrink-0 text-muted-foreground" /> <span className="break-words">{note}</span>
            </span>
            <Button size="sm" variant="outline" onClick={connect}>
              <RotateCcw /> {tt.reconnect}
            </Button>
          </div>
        )}
      </div>
      <div className="scrollbar-none flex gap-1 overflow-x-auto border-t border-border bg-white/[0.03] px-2 py-1.5 md:hidden" aria-label={tt.keysLabel}>
        {MOBILE_KEYS.map((k) => (
          <Button
            key={k.key}
            variant="ghost"
            size="sm"
            className="h-9 min-w-11 shrink-0 px-2 font-mono text-xs"
            disabled={state !== "connected"}
            onClick={() => {
              session.current?.write(k.seq);
              term.current?.focus();
            }}
            aria-label={tt.keys[k.key].aria}
          >
            {tt.keys[k.key].label}
          </Button>
        ))}
      </div>
    </Card>
  );
}
