"use client";
import { CheckCircle2, Clock3, Inbox, Send, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import type { MailQueueItem } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { formatBytes, formatDuration } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./forms";
import { useNow } from "./primitives";

function Recipients({ list }: { list: string[] }) {
  const t = useT().mail.queue;
  const [open, setOpen] = useState(false);
  const shown = open ? list : list.slice(0, 1);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((r) => (
        <span key={r} className="max-w-full truncate rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-xs">
          {r}
        </span>
      ))}
      {list.length > 1 && !open && (
        <button type="button" onClick={() => setOpen(true)} className="rounded-md px-1.5 py-0.5 text-xs text-primary hover:bg-primary/10">
          {t.moreRecipients(list.length - 1)}
        </button>
      )}
    </div>
  );
}

/** Kolommen vanaf md: afzender, ontvangers, grootte, leeftijd, reden, actie. */
const QCOLS = "md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_5rem_6rem_minmax(0,1.6fr)_2.5rem] md:gap-x-4";

function ageTone(ms: number) {
  return ms > 24 * 3600_000 ? "text-destructive" : ms > 3600_000 ? "text-warning" : "text-muted-foreground";
}

export function MailQueue() {
  const t = useT().mail.queue;
  const utils = trpc.useUtils();
  const now = useNow(15_000);
  const q = trpc.mail.queue.list.useQuery(undefined, { refetchInterval: 15_000 });
  const [filter, setFilter] = useState<"all" | "deferred">("all");
  const [flushing, setFlushing] = useState(false);
  const [deleting, setDeleting] = useState<MailQueueItem | null>(null);
  const refresh = () => {
    void utils.mail.queue.list.invalidate();
    void utils.mail.status.invalidate();
  };
  const flush = trpc.mail.queue.flush.useMutation({ onSuccess: () => (setFlushing(false), refresh()) });
  const del = trpc.mail.queue.delete.useMutation({
    onMutate: ({ queueId }) => utils.mail.queue.list.setData(undefined, (old) => old?.filter((x) => x.queueId !== queueId)),
    onSuccess: () => setDeleting(null),
    onSettled: refresh,
  });

  if (q.error) return <QueryError error={q.error} />;
  const items = q.data ?? [];
  const deferred = items.filter((i) => i.reason);
  const list = filter === "deferred" ? deferred : items;
  const actionBar = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div role="radiogroup" aria-label={t.filterLabel} className="inline-flex w-fit gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {(["all", "deferred"] as const).map((f) => (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={filter === f}
            onClick={() => setFilter(f)}
            className={cn("inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7", filter === f ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
          >
            {f === "all" ? t.filterAll : t.filterDeferred}
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums">{f === "all" ? items.length : deferred.length}</span>
          </button>
        ))}
      </div>
      <Button className="sm:ml-auto" variant="outline" onClick={() => (flush.reset(), setFlushing(true))} disabled={items.length === 0} data-testid="queue-flush">
        <Zap /> {t.flush}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="mail-queue">
      {!q.data ? (
        <Card className="space-y-3 p-4" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState icon={CheckCircle2} title={t.emptyTitle}>
            {t.emptyText}
          </EmptyState>
        </Card>
      ) : (
        <>
          {actionBar}
          {flush.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.flushed}
            </p>
          )}
          {list.length === 0 ? (
            <Card>
              <EmptyState icon={Inbox} title={t.emptyTitle} />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div aria-hidden className={cn("grid border-b border-border bg-muted/30 px-4 py-2.5 text-xs font-medium text-muted-foreground max-md:hidden", QCOLS)}>
                <span>{t.sender}</span>
                <span>{t.recipients}</span>
                <span className="text-right">{t.size}</span>
                <span>{t.age}</span>
                <span>{t.reason}</span>
                <span />
              </div>
              <ul className="divide-y divide-border" data-testid="queue-table" aria-label={t.title}>
                {list.map((i) => {
                  const age = Math.max(0, now - i.arrivalTime.getTime());
                  return (
                    <li key={i.queueId} className={cn("grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/30", QCOLS)} data-testid="queue-row">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-sm" title={i.sender}>{i.sender || "<>"}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{i.queueId}</div>
                      </div>
                      <div className="col-span-3 min-w-0 max-md:order-3 md:col-span-1">
                        <Recipients list={i.recipients} />
                      </div>
                      <div className="whitespace-nowrap pt-0.5 text-right text-sm tabular-nums max-md:order-1">{formatBytes(i.size)}</div>
                      <div className={cn("col-span-3 whitespace-nowrap text-sm tabular-nums max-md:order-4 md:col-span-1 md:pt-0.5", ageTone(age))}>
                        <span className="inline-flex items-center gap-1">
                          <Clock3 className="size-3.5" aria-hidden />
                          <span className="sr-only">{t.age}:</span>
                          {formatDuration(age)}
                        </span>
                      </div>
                      <div className="col-span-3 min-w-0 max-md:order-5 md:col-span-1">
                        {i.reason ? (
                          <div className="min-w-0">
                            <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">{t.deferred}</span>
                            <p className="line-clamp-2 break-words text-xs text-muted-foreground" title={i.reason}>
                              {i.reason}
                            </p>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                            <Send className="size-3" aria-hidden /> {t.noReason}
                          </span>
                        )}
                      </div>
                      <Button variant="ghost" size="icon-sm" className="-mt-1 text-muted-foreground hover:text-destructive max-md:order-2" aria-label={t.deleteLabel(i.queueId)} onClick={() => (del.reset(), setDeleting(i))} data-testid="queue-delete">
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </>
      )}
      <ConfirmDialog open={flushing} onOpenChange={setFlushing} icon={<Zap />} title={t.flushTitle} description={t.flushText} actionLabel={t.flushGo} pending={flush.isPending} error={flush.error} onConfirm={() => flush.mutate()} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        icon={<Trash2 />}
        tone="destructive"
        title={t.deleteTitle}
        description={deleting ? t.deleteText(deleting.queueId) : ""}
        actionLabel={t.deleteGo}
        pending={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate({ queueId: deleting.queueId })}
      />
    </div>
  );
}
