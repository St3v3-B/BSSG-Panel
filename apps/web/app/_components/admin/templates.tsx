"use client";
import { CheckCircle2, Plus, Save, ShieldCheck, Trash2, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { TemplateDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { AdminError } from "@/app/_components/admin/nodes";
import { CodeEditor } from "@/app/_components/code-editor";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";
import { Table } from "@/app/_components/ui/table";

export function TemplatesAdmin() {
  const t = useT();
  const tp = t.admin.templates;
  const list = trpc.admin.templates.list.useQuery();
  return (
    <div className="space-y-4" data-testid="templates-admin">
      <Button asChild>
        <Link href="/admin/templates/new">
          <Plus /> {tp.add}
        </Link>
      </Button>
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">{tp.colName}</th>
                <th className="px-4 py-2.5 font-medium">{tp.colType}</th>
                <th className="px-4 py-2.5 font-medium">{tp.colVersion}</th>
                <th className="px-4 py-2.5 font-medium">{tp.colServers}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                    {tp.empty}
                  </td>
                </tr>
              )}
              {list.data.map((x) => (
                <tr key={x.id} className="hover:bg-muted/30" data-testid="template-row">
                  <td className="px-4 py-3">
                    <Link href={`/admin/templates/${x.id}`} className="font-medium hover:underline">
                      {x.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">{x.slug}</div>
                    {x.description && <div className="text-xs text-muted-foreground">{x.description}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={x.type === "web" ? "info" : "secondary"}>{x.type === "web" ? tp.web : tp.game}</Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums">v{x.version}</td>
                  <td className="px-4 py-3 tabular-nums">{x.serverCount}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

const NEW_YAML = "schema: 1\nslug: \nname: \ntype: game\n";

/** YAML-editor voor een template; `id` null = nieuwe template. */
export function TemplateEditor({ id, onCreated, onDeleted }: { id: number | null; onCreated: (t: TemplateDetail) => void; onDeleted: () => void }) {
  const t = useT();
  const tp = t.admin.templates;
  const utils = trpc.useUtils();
  const tpl = trpc.admin.templates.get.useQuery({ id: id ?? 0 }, { enabled: id != null, retry: false, refetchOnWindowFocus: false });
  const [yaml, setYaml] = useState<string | null>(id == null ? NEW_YAML : null);
  useEffect(() => {
    if (tpl.data && yaml === null) setYaml(tpl.data.yaml);
  }, [tpl.data, yaml]);
  const validate = trpc.admin.templates.validate.useMutation();
  const invalidate = () => Promise.all([utils.admin.templates.list.invalidate(), id != null && utils.admin.templates.get.invalidate({ id })]);
  const update = trpc.admin.templates.update.useMutation({ onSuccess: () => void invalidate() });
  const create = trpc.admin.templates.create.useMutation({ onSuccess: async (r) => (await invalidate(), onCreated(r)) });
  const [confirm, setConfirm] = useState(false);
  const del = trpc.admin.templates.delete.useMutation({ onSuccess: async () => (await invalidate(), onDeleted()) });

  if (tpl.error) return <QueryError error={tpl.error} />;
  if (yaml === null) return <Skeleton className="h-[60vh] rounded-xl" />;
  const saving = update.isPending || create.isPending;
  const error = update.error ?? create.error ?? del.error ?? validate.error;
  const reset = () => (validate.reset(), update.reset(), create.reset());

  return (
    <div className="space-y-4" data-testid="template-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{id == null ? tp.newTitle : (tpl.data?.name ?? "…")}</h1>
          {tpl.data && (
            <p className="text-sm text-muted-foreground">
              <code className="font-mono">{tpl.data.slug}</code> · v{tpl.data.version}
              {tpl.data.serverCount > 0 && <> · {tp.inUse(tpl.data.serverCount)}</>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => validate.mutate({ yaml })} disabled={validate.isPending}>
            {validate.isPending ? <Spinner /> : <ShieldCheck />} {tp.validate}
          </Button>
          <Button
            onClick={() => (id == null ? create.mutate({ yaml }) : update.mutate({ id, yaml }))}
            disabled={saving || !yaml.trim()}
            data-testid="template-save"
          >
            {saving ? <Spinner /> : <Save />} {t.common.save}
          </Button>
          {id != null &&
            (confirm ? (
              <>
                <Button variant="destructive" onClick={() => del.mutate({ id })} disabled={del.isPending}>
                  {del.isPending && <Spinner />} {tp.delete}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(false)}>
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)} aria-label={tp.delete}>
                <Trash2 />
              </Button>
            ))}
        </div>
      </div>
      {validate.data &&
        (validate.data.ok ? (
          <Alert className="border-success/40 bg-success/10 text-success" data-testid="validate-ok">
            <CheckCircle2 />
            <div>
              <AlertTitle>{tp.valid}</AlertTitle>
            </div>
          </Alert>
        ) : (
          <Alert variant="destructive" data-testid="validate-errors">
            <XCircle />
            <div>
              <AlertTitle>{tp.invalid}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs">
                  {validate.data.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </AlertDescription>
            </div>
          </Alert>
        ))}
      {update.isSuccess && (
        <p className="text-sm text-success" role="status">
          {tp.saved}
        </p>
      )}
      {error && <AdminError error={error} />}
      <Card className="overflow-hidden p-0">
        <CodeEditor
          height="65vh"
          theme="vs-dark"
          language="yaml"
          value={yaml}
          onChange={(v) => (setYaml(v ?? ""), reset())}
          options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, tabSize: 2 }}
        />
      </Card>
    </div>
  );
}
