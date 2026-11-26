"use client";
import { ArrowDownToLine, Download, Eraser, Pause, Play, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LineKind } from "@/app/_hooks/use-console";
import { ConnectionIndicator } from "@/app/_components/console-panel";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import type { ConnState } from "@/app/_lib/console";
import { cn } from "@/lib/utils";

export interface LogLine {
  id: number;
  kind: LineKind;
  text: string;
}

export type LogLevel = "error" | "warn" | "normal";

/** Kleur van een logregel: fouten (error/fatal/HTTP 5xx), waarschuwingen (warn) of normaal. */
export function classifyLogLine(line: Pick<LogLine, "kind" | "text">): LogLevel {
  if (line.kind === "error") return "error";
  if (/\b(error|fatal|exception|crit(ical)?|emerg|alert)\b/i.test(line.text) || /"\s5\d\d\s|\sHTTP\/[\d.]+"?\s5\d\d\b/.test(line.text)) return "error";
  if (line.kind === "warning" || /\bwarn(ing)?\b/i.test(line.text)) return "warn";
  return "normal";
}

export const MAX_LOG_LINES = 5000;

/** Houdt logregels bij (gebufferd, max MAX_LOG_LINES) voor de handlers van useConsole. */
export function useLogLines() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const buffer = useRef<LogLine[]>([]);
  const nextId = useRef(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    timer.current = null;
    const add = buffer.current;
    buffer.current = [];
    if (add.length) setLines((cur) => [...cur, ...add].slice(-MAX_LOG_LINES));
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const push = useCallback(
    (kind: LineKind, text: string) => {
      for (const t of text.split(/\r?\n/)) buffer.current.push({ id: nextId.current++, kind, text: t });
      timer.current ??= setTimeout(flush, 50);
    },
    [flush],
  );
  const clear = useCallback(() => {
    buffer.current = [];
    setLines([]);
  }, []);
  return { lines, push, clear };
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: "text-red-400 bg-red-500/5",
  warn: "text-amber-300",
  normal: "",
};

/** Alleen-lezen logweergave (websites): filteren, volgen/pauzeren, wissen en downloaden. */
export function LogViewer({
  lines,
  onClear,
  fileName,
  state,
  retryInMs,
  tokenRefreshedAt,
  onRetry,
}: {
  lines: LogLine[];
  onClear: () => void;
  fileName: string;
  state: ConnState;
  retryInMs?: number;
  tokenRefreshedAt: Date | null;
  onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [frozen, setFrozen] = useState<LogLine[] | null>(null); // gepauzeerd: weergave staat stil
  const scroller = useRef<HTMLDivElement>(null);

  const source = frozen ?? lines;
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => (q ? source.filter((l) => l.text.toLowerCase().includes(q)) : source), [source, q]);

  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  const pause = () => {
    setFrozen(lines);
    setFollow(false);
  };
  const resume = () => {
    setFrozen(null);
    setFollow(true);
  };
  const download = () => {
    const blob = new Blob([lines.map((l) => l.text).join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const newSincePause = frozen ? lines.length - frozen.length : 0;

  return (
    <Card className="overflow-hidden p-0" data-testid="log-viewer">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <ConnectionIndicator state={state} retryInMs={retryInMs} onRetry={onRetry} tokenRefreshedAt={tokenRefreshedAt} />
        <div className="relative ml-auto w-full max-w-56 sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filteren…" aria-label="Logs filteren" className="h-8 pl-8 text-xs" />
        </div>
        {frozen ? (
          <Button size="sm" variant="outline" onClick={resume} aria-label="Volgen">
            <Play /> Volgen{newSincePause > 0 && ` (${newSincePause} nieuw)`}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={pause} aria-label="Pauzeren">
            <Pause /> Pauzeren
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" onClick={() => (onClear(), setFrozen(frozen ? [] : null))} aria-label="Weergave wissen" title="Weergave wissen">
          <Eraser />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={download} aria-label="Downloaden als .txt" title="Downloaden als .txt" disabled={lines.length === 0}>
          <Download />
        </Button>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!frozen && atBottom !== follow) setFollow(atBottom);
        }}
        className="h-[28rem] overflow-y-auto bg-[#0b0d10] py-2 font-mono text-xs leading-5 text-zinc-300"
        role="log"
        aria-live="off"
        data-testid="log-lines"
      >
        {shown.length === 0 ? (
          <p className="px-3 text-zinc-500">{q ? `Geen regels met “${query.trim()}”.` : "Nog geen logregels."}</p>
        ) : (
          shown.map((l) => {
            const level = classifyLogLine(l);
            return (
              <div key={l.id} className={cn("whitespace-pre-wrap break-all px-3", LEVEL_CLASS[level], l.kind === "install" && "text-sky-300/80", l.kind === "info" && "text-zinc-500")} data-level={level}>
                {l.kind === "install" && <span className="select-none text-sky-500/70">[install] </span>}
                {l.text}
              </div>
            );
          })
        )}
      </div>
      {!follow && !frozen && (
        <div className="border-t border-border px-3 py-1.5 text-right">
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setFollow(true)}>
            <ArrowDownToLine /> Naar het einde
          </Button>
        </div>
      )}
    </Card>
  );
}
