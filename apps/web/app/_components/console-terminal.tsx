"use client";
import "@xterm/xterm/css/xterm.css";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { useEffect, useRef, type RefObject } from "react";
import type { LineKind } from "@/app/_hooks/use-console";
import { cn } from "@/lib/utils";
import { getT } from "@/app/_lib/i18n";

export interface TerminalHandle {
  write(kind: LineKind, text: string): void;
  clear(): void;
}

function prefix(kind: LineKind): string {
  const c = getT().console;
  return { out: "", install: `\x1b[36m${c.prefixInstall}\x1b[0m `, info: `\x1b[34m${c.prefixDaemon}\x1b[0m `, warning: `\x1b[33m${c.prefixDaemon}\x1b[0m \x1b[33m`, error: `\x1b[31m${c.prefixError}\x1b[0m \x1b[31m` }[kind];
}

/** Alleen-lezen xterm.js-terminal. Regels die binnenkomen voordat xterm geladen is, worden gebufferd. */
export function ConsoleTerminal({ handleRef, className }: { handleRef: RefObject<TerminalHandle | null>; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let disposed = false;
    let buffer: Array<[LineKind, string]> = [];
    const write = (kind: LineKind, text: string) => {
      const line = prefix(kind) + text.replace(/\r?\n/g, "\r\n") + (kind === "warning" || kind === "error" ? "\x1b[0m" : "");
      term?.writeln(line);
    };
    handleRef.current = {
      write: (kind, text) => (term ? write(kind, text) : buffer.push([kind, text])),
      clear: () => (term ? term.reset() : (buffer = [])),
    };

    let ro: ResizeObserver | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !hostRef.current) return;
      term = new Terminal({
        disableStdin: true,
        convertEol: false,
        cursorBlink: false,
        cursorStyle: "underline",
        cursorInactiveStyle: "none",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
        fontSize: 13,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: { background: "#00000000", foreground: "#e4e4e7", selectionBackground: "#3f3f46" },
        allowTransparency: true,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try {
        fit.fit();
      } catch {
        /* nog geen afmetingen */
      }
      for (const [k, t] of buffer) write(k, t);
      buffer = [];
      ro = new ResizeObserver(() => {
        try {
          fit?.fit();
        } catch {
          /* genegeerd */
        }
      });
      ro.observe(hostRef.current);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      term?.dispose();
      handleRef.current = null;
    };
  }, [handleRef]);

  return <div ref={hostRef} className={cn("console-host h-full min-h-0 w-full overflow-hidden", className)} data-testid="console-terminal" />;
}
