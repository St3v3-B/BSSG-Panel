"use client";
import { ChevronRight, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { ConsoleTerminal, type TerminalHandle } from "@/app/_components/console-terminal";
import { CommandHistory, type ConnState } from "@/app/_lib/console";
import { errorText } from "@/app/_lib/errors";
import { cn } from "@/lib/utils";

const STATE_TEXT: Record<ConnState, string> = {
  idle: "Niet verbonden",
  connecting: "Verbinden…",
  authenticating: "Aanmelden…",
  connected: "Verbonden",
  reconnecting: "Verbinding verbroken",
  denied: "Geen toegang tot de console",
  closed: "Gesloten",
};

export function ConnectionIndicator({ state, retryInMs, onRetry, tokenRefreshedAt }: { state: ConnState; retryInMs?: number; onRetry: () => void; tokenRefreshedAt: Date | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [since, setSince] = useState(() => Date.now());
  useEffect(() => setSince(Date.now()), [state, retryInMs]);
  useEffect(() => {
    if (state !== "reconnecting") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state]);
  const left = retryInMs != null ? Math.max(0, Math.ceil((retryInMs - (now - since)) / 1000)) : null;
  const dot =
    state === "connected" ? "bg-success" : state === "reconnecting" || state === "denied" ? "bg-destructive" : "bg-warning animate-pulse";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="console-state" data-state={state}>
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      <span>
        {STATE_TEXT[state]}
        {state === "reconnecting" && left != null && <> · opnieuw over {left} s</>}
        {state === "connected" && tokenRefreshedAt && (
          <span className="hidden md:inline"> · token vernieuwd om {tokenRefreshedAt.toLocaleTimeString("nl-NL", { timeZone: "Europe/Amsterdam" })}</span>
        )}
      </span>
      {(state === "reconnecting" || state === "denied") && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onRetry}>
          <RefreshCw /> Nu opnieuw
        </Button>
      )}
    </div>
  );
}

export function ConsolePanel({
  terminalRef,
  state,
  retryInMs,
  tokenRefreshedAt,
  onRetry,
  canWrite,
  onSend,
  serverUuid,
}: {
  terminalRef: RefObject<TerminalHandle | null>;
  state: ConnState;
  retryInMs?: number;
  tokenRefreshedAt: Date | null;
  onRetry: () => void;
  canWrite: boolean;
  onSend: (cmd: string) => Promise<void>;
  serverUuid: string;
}) {
  const history = useMemo(() => {
    let initial: string[] = [];
    try {
      initial = JSON.parse(sessionStorage.getItem(`console-history:${serverUuid}`) ?? "[]") as string[];
    } catch {
      /* geen storage */
    }
    return new CommandHistory(Array.isArray(initial) ? initial : []);
  }, [serverUuid]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    const cmd = value.trim();
    if (!cmd || sending) return;
    history.push(cmd);
    try {
      sessionStorage.setItem(`console-history:${serverUuid}`, JSON.stringify(history.all));
    } catch {
      /* genegeerd */
    }
    setValue("");
    setError(null);
    setSending(true);
    try {
      await onSend(cmd);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setValue(history.prev(value));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setValue(history.next());
    }
  }

  return (
    <Card className="flex h-[32rem] flex-col overflow-hidden bg-black/40 lg:h-[36rem]">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span className="text-sm font-medium">Console</span>
        <ConnectionIndicator state={state} retryInMs={retryInMs} onRetry={onRetry} tokenRefreshedAt={tokenRefreshedAt} />
      </div>
      <div className="relative min-h-0 flex-1 px-3 py-2">
        <ConsoleTerminal handleRef={terminalRef} />
        {state === "denied" && (
          <div className="absolute inset-0 grid place-items-center bg-background/70 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <WifiOff className="size-4" /> De daemon weigert de verbinding (geen rechten of server onbekend).
            </span>
          </div>
        )}
      </div>
      <form
        className="flex items-center gap-2 border-t border-border bg-background/40 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!canWrite}
          maxLength={2000}
          autoComplete="off"
          spellCheck={false}
          aria-label="Commando"
          placeholder={canWrite ? "Typ een commando… (↑/↓ voor geschiedenis)" : "Je hebt geen recht om commando's te sturen"}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          data-testid="console-input"
        />
        {error && <span className="max-w-60 truncate text-xs text-destructive" title={error}>{error}</span>}
        <Button type="submit" size="sm" variant="secondary" disabled={!canWrite || !value.trim() || sending}>
          Versturen
        </Button>
      </form>
    </Card>
  );
}
