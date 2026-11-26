"use client";
import Editor, { type OnMount } from "@monaco-editor/react";
import { ArrowLeft, Download, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { FileActionError } from "@/app/_components/files/file-action-error";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { formatBytes } from "@/app/_lib/format";
import { baseName, languageFor, startDownload } from "@/app/_lib/files";

/** Monaco-editor voor één bestand (files.read / files.write). Ctrl/Cmd+S slaat op. */
export function FileEditor({ uuid, path, readOnly, onClose }: { uuid: string; path: string; readOnly: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const file = trpc.files.read.useQuery({ uuid, path }, { retry: false, refetchOnWindowFocus: false, staleTime: Infinity });
  const [content, setContent] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState<string | null>(null);
  const write = trpc.files.write.useMutation({
    onSuccess: (_r, vars) => {
      setSavedContent(vars.content);
      utils.files.read.setData({ uuid, path }, { content: vars.content, size: new Blob([vars.content]).size });
    },
  });
  const downloadUrl = trpc.files.downloadUrl.useMutation({ onSuccess: (r) => startDownload(r.url, path) });

  useEffect(() => {
    if (file.data && content === null) {
      setContent(file.data.content);
      setSavedContent(file.data.content);
    }
  }, [file.data, content]);

  const dirty = content !== null && content !== savedContent;
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = () => {
    if (!readOnly && content !== null && !write.isPending) write.mutate({ uuid, path, content });
  };

  // waarschuwen bij weggaan met onopgeslagen wijzigingen
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const close = () => {
    if (dirty && !window.confirm("Je hebt onopgeslagen wijzigingen. Toch sluiten?")) return;
    onClose();
  };

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
  };

  return (
    <div className="space-y-3" data-testid="file-editor">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Terug naar de map">
            <ArrowLeft />
          </Button>
          <code className="truncate font-mono text-sm">{path}</code>
          {file.data && <span className="text-xs text-muted-foreground">{formatBytes(file.data.size)}</span>}
          {readOnly ? <Badge variant="secondary">alleen lezen</Badge> : dirty ? <Badge variant="warning">niet opgeslagen</Badge> : write.isSuccess ? <Badge variant="success">opgeslagen</Badge> : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => downloadUrl.mutate({ uuid, path })} disabled={downloadUrl.isPending}>
            <Download /> Downloaden
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={() => saveRef.current()} disabled={!dirty || write.isPending} data-testid="file-save">
              {write.isPending ? <Spinner /> : <Save />} Opslaan
            </Button>
          )}
        </div>
      </div>
      {write.error && <FileActionError error={write.error} onDismiss={() => write.reset()} />}
      {downloadUrl.error && <FileActionError error={downloadUrl.error} onDismiss={() => downloadUrl.reset()} />}
      {file.error ? (
        <QueryError error={file.error} title={`${baseName(path)} openen mislukt`} />
      ) : content === null ? (
        <Skeleton className="h-[60vh] rounded-xl" />
      ) : (
        <Card className="overflow-hidden p-0">
          <Editor
            height="65vh"
            theme="vs-dark"
            path={path}
            language={languageFor(baseName(path))}
            value={content}
            onChange={(v) => setContent(v ?? "")}
            onMount={onMount}
            loading={<Spinner className="size-6 text-muted-foreground" />}
            options={{ readOnly, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2 }}
          />
        </Card>
      )}
    </div>
  );
}
