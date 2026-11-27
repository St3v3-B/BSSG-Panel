"use client";
import { ArrowLeft, Ban, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AdminError } from "@/app/_components/admin/nodes";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { formatCpuLimit, formatDate, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Admin-weergave van één server: gegevens, opschorten en template wisselen. */
export function AdminServerPage({ uuid }: { uuid: string }) {
  const t = useT();
  const s2 = t.admin2.server;
  const server = trpc.servers.get.useQuery({ uuid });
  const s = server.data;
  return (
    <div className="space-y-6" data-testid="admin-server-page">
      <Link href="/admin/servers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {s2.back}
      </Link>
      {server.error ? (
        <QueryError error={server.error} />
      ) : !s ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <PageHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {s.name}
                <StatusBadge status={s.status} />
                {s.suspended && (
                  <Badge variant="warning">
                    <Ban /> {t.admin2.list.suspended}
                  </Badge>
                )}
              </span>
            }
            description={<span className="font-mono text-xs">{s.uuid}</span>}
            actions={
              <Button asChild variant="outline">
                <Link href={`/servers/${s.uuid}`}>
                  <ExternalLink /> {s2.open}
                </Link>
              </Button>
            }
          />
          <Card>
            <CardContent className="grid gap-4 pt-6 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <Info label={s2.owner}>
                <Link href={`/admin/users/${s.owner.id}`} className="hover:underline">
                  {displayName(s.owner)}
                </Link>
              </Info>
              <Info label={s2.node}>{s.node.name}</Info>
              <Info label={s2.template}>{s.templateName}</Info>
              <Info label={s2.address}>{s.primaryAddress ?? "–"}</Info>
              <Info label={s2.limits}>
                {formatCpuLimit(s.limits.cpuPct)} · {formatMb(s.limits.ramMb)} · {s.limits.diskMb ? formatMb(s.limits.diskMb) : "∞"}
              </Info>
            </CardContent>
          </Card>
          <SuspendSection uuid={s.uuid} suspended={s.suspended} />
          <TemplateSection uuid={s.uuid} type={s.type} currentName={s.templateName} />
        </>
      )}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}

export function SuspendSection({ uuid, suspended }: { uuid: string; suspended: { reason: string | null; at: Date } | null }) {
  const t = useT();
  const s2 = t.admin2.server;
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const m = trpc.admin.servers.setSuspended.useMutation({
    onSuccess: () => {
      setConfirm(false);
      setReason("");
      void utils.servers.get.invalidate({ uuid });
      void utils.admin.servers.list.invalidate();
    },
  });
  return (
    <Card data-testid="suspend-section">
      <CardHeader>
        <CardTitle className="text-base">{s2.suspendTitle}</CardTitle>
        <CardDescription>{s2.suspendText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {suspended ? (
          <div className="text-sm" data-testid="suspended-info">
            <div className="font-medium">{s2.suspendedSince(formatDate(suspended.at))}</div>
            {suspended.reason && <div className="text-muted-foreground">{suspended.reason}</div>}
          </div>
        ) : (
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="suspend-reason">{s2.reasonLabel}</Label>
            <Input id="suspend-reason" value={reason} maxLength={500} placeholder={s2.reasonPlaceholder} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {m.error && <AdminError error={m.error} />}
        {m.isSuccess && !confirm && (
          <p className="text-sm text-success" role="status">
            {suspended ? s2.suspendDone : s2.unsuspendDone}
          </p>
        )}
        {confirm ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t.admin.confirm}</span>
            <Button variant={suspended ? "default" : "destructive"} disabled={m.isPending} onClick={() => m.mutate({ uuid, suspended: !suspended, reason: reason.trim() || null })}>
              {m.isPending && <Spinner />} {suspended ? s2.unsuspend : s2.suspend}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </Button>
          </div>
        ) : (
          <Button variant={suspended ? "default" : "outline"} className={suspended ? undefined : "text-destructive"} onClick={() => (m.reset(), setConfirm(true))}>
            {suspended ? s2.unsuspend : s2.suspend}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function TemplateSection({ uuid, type, currentName }: { uuid: string; type: "game" | "web"; currentName: string }) {
  const t = useT();
  const s2 = t.admin2.server;
  const utils = trpc.useUtils();
  const templates = trpc.admin.templates.list.useQuery();
  const options = templates.data?.filter((x) => x.type === type && x.name !== currentName) ?? [];
  const [templateId, setTemplateId] = useState<number | "">("");
  const [reinstall, setReinstall] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const m = trpc.admin.servers.changeTemplate.useMutation({
    onSuccess: () => {
      setConfirm(false);
      setTemplateId("");
      void utils.servers.get.invalidate({ uuid });
      void utils.admin.servers.list.invalidate();
    },
  });
  return (
    <Card data-testid="template-section">
      <CardHeader>
        <CardTitle className="text-base">{s2.templateTitle}</CardTitle>
        <CardDescription>{s2.templateText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {templates.error ? (
          <QueryError error={templates.error} />
        ) : options.length === 0 && templates.data ? (
          <p className="text-sm text-muted-foreground">{s2.templateNone}</p>
        ) : (
          <>
            <div className="max-w-md space-y-1.5">
              <Label htmlFor="new-template">{s2.templateSelect}</Label>
              <Select id="new-template" value={templateId} onChange={(e) => (setTemplateId(e.target.value ? Number(e.target.value) : ""), setConfirm(false))}>
                <option value="">–</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} (v{o.version})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {s2.current}: {currentName}
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={reinstall} onChange={(e) => setReinstall(e.target.checked)} className="mt-0.5" />
              <span>
                {s2.reinstall}
                <span className="block text-xs text-muted-foreground">{s2.reinstallHint}</span>
              </span>
            </label>
          </>
        )}
        {m.error && <AdminError error={m.error} />}
        {m.isSuccess && (
          <p className="text-sm text-success" role="status">
            {s2.templateDone}
          </p>
        )}
        {templateId !== "" &&
          (confirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t.admin.confirm}</span>
              <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate({ uuid, templateId, reinstall })}>
                {m.isPending && <Spinner />} {s2.templateChange}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                {t.common.cancel}
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => (m.reset(), setConfirm(true))}>
              {s2.templateChange}
            </Button>
          ))}
      </CardContent>
    </Card>
  );
}
