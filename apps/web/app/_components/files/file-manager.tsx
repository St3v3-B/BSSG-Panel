"use client";
import {
  Archive,
  ChevronRight,
  Download,
  File as FileIcon,
  FileArchive,
  FilePlus,
  Folder,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { FileEntry, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { FileActionError } from "@/app/_components/files/file-action-error";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/_components/ui/dropdown-menu";
import { Input } from "@/app/_components/ui/input";
import { Progress } from "@/app/_components/ui/progress";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { QueryError } from "@/app/_components/query-error";
import { formatBytes, formatDate } from "@/app/_lib/format";
import { breadcrumbs, fileNameError, isArchive, isEditable, joinPath, parentPath, startDownload, UploadError, uploadErrorText, uploadFiles } from "@/app/_lib/files";

type Prompt = { kind: "mkdir" } | { kind: "newfile" } | { kind: "rename"; entry: FileEntry };

export interface FileManagerProps {
  server: Pick<ServerDetail, "uuid" | "permissions">;
  path: string;
  onNavigate: (path: string) => void;
  onEdit: (path: string) => void;
  /** Voor tests: upload-implementatie vervangen. */
  upload?: typeof uploadFiles;
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name, "nl")));
}

export function FileManager({ server, path, onNavigate, onEdit, upload = uploadFiles }: FileManagerProps) {
  const uuid = server.uuid;
  const canWrite = server.permissions.includes("files.write");
  const utils = trpc.useUtils();
  const list = trpc.files.list.useQuery({ uuid, path }, { retry: false });
  const entries = useMemo(() => sortEntries(list.data ?? []), [list.data]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [error, setError] = useState<{ error?: unknown; text?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ names: string; fraction: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => utils.files.list.invalidate({ uuid, path });
  const fail = (e: unknown) => setError({ error: e });
  const done = (msg?: string) => {
    setError(null);
    setNotice(msg ?? null);
    setSelected(new Set());
    void refresh();
  };

  const mkdir = trpc.files.mkdir.useMutation({ onSuccess: () => (setPrompt(null), done("Map aangemaakt.")), onError: fail });
  const write = trpc.files.write.useMutation({ onError: fail });
  const rename = trpc.files.rename.useMutation({ onSuccess: () => (setPrompt(null), done("Hernoemd.")), onError: fail });
  const del = trpc.files.delete.useMutation({ onSuccess: () => (setConfirmDelete(null), done("Verwijderd.")), onError: fail });
  const compress = trpc.files.compress.useMutation({ onSuccess: (r) => done(`Ingepakt als ${r.archive.name}.`), onError: fail });
  const decompress = trpc.files.decompress.useMutation({ onSuccess: () => done("Uitgepakt."), onError: fail });
  const uploadUrl = trpc.files.uploadUrl.useMutation();
  const downloadUrl = trpc.files.downloadUrl.useMutation();
  const busy = mkdir.isPending || rename.isPending || del.isPending || compress.isPending || decompress.isPending || write.isPending;

  const toggle = (p: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.path));

  async function doUpload(files: File[]) {
    if (!canWrite || files.length === 0) return;
    setError(null);
    setNotice(null);
    setUploading({ names: files.length === 1 ? files[0]!.name : `${files.length} bestanden`, fraction: 0 });
    try {
      const signed = await uploadUrl.mutateAsync({ uuid, directory: path });
      await upload(signed.url, path, files, (fraction) => setUploading((u) => (u ? { ...u, fraction } : u)));
      done(files.length === 1 ? `${files[0]!.name} geüpload.` : `${files.length} bestanden geüpload.`);
    } catch (e) {
      setError(e instanceof UploadError ? { text: uploadErrorText(e) } : { error: e });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function doDownload(p: string) {
    try {
      const signed = await downloadUrl.mutateAsync({ uuid, path: p });
      startDownload(signed.url, p);
    } catch (e) {
      fail(e);
    }
  }

  function submitPrompt(name: string) {
    if (!prompt) return;
    if (prompt.kind === "mkdir") mkdir.mutate({ uuid, path: joinPath(path, name) });
    else if (prompt.kind === "newfile") {
      const p = joinPath(path, name);
      write.mutate(
        { uuid, path: p, content: "" },
        {
          onSuccess: () => {
            setPrompt(null);
            done();
            onEdit(p);
          },
        },
      );
    } else rename.mutate({ uuid, from: prompt.entry.path, to: joinPath(path, name) });
  }

  return (
    <div className="space-y-4" data-testid="file-manager">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" aria-label="Pad">
          {breadcrumbs(path).map((c, i, all) => (
            <span key={c.path} className="inline-flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
              <button
                type="button"
                onClick={() => onNavigate(c.path)}
                className={cn("rounded px-1.5 py-0.5 font-mono hover:bg-muted", i === all.length - 1 ? "text-foreground" : "text-muted-foreground")}
              >
                {i === 0 ? "home" : c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => void list.refetch()} aria-label="Vernieuwen" title="Vernieuwen">
            <RefreshCw className={cn(list.isFetching && "animate-spin")} />
          </Button>
          {canWrite && (
            <>
              <Button variant="outline" size="sm" onClick={() => setPrompt({ kind: "mkdir" })}>
                <FolderPlus /> Nieuwe map
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPrompt({ kind: "newfile" })}>
                <FilePlus /> Nieuw bestand
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
                <Upload /> Uploaden
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                data-testid="upload-input"
                onChange={(e) => void doUpload(Array.from(e.target.files ?? []))}
              />
            </>
          )}
        </div>
      </div>

      {error && <FileActionError error={error.error} text={error.text} onDismiss={() => setError(null)} />}
      {notice && !error && (
        <p className="text-sm text-success" role="status">
          {notice}
        </p>
      )}
      {uploading && (
        <div className="space-y-1.5 rounded-lg border border-border p-3 text-sm" data-testid="upload-progress">
          <div className="flex items-center gap-2">
            <Spinner /> {uploading.names} uploaden… {Math.round(uploading.fraction * 100)}%
          </div>
          <Progress value={uploading.fraction * 100} />
        </div>
      )}
      {prompt && <NamePrompt key={prompt.kind + (prompt.kind === "rename" ? prompt.entry.path : "")} prompt={prompt} pending={busy} onCancel={() => setPrompt(null)} onSubmit={submitPrompt} />}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" data-testid="selection-bar">
          <span className="mr-auto">{selected.size} geselecteerd</span>
          {confirmDelete ? (
            <>
              <span className="text-destructive">{confirmDelete.length === 1 ? "Dit item" : `${confirmDelete.length} items`} definitief verwijderen?</span>
              <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ uuid, paths: confirmDelete })}>
                {del.isPending && <Spinner />} Verwijderen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                Annuleren
              </Button>
            </>
          ) : (
            <>
              {selected.size === 1 && !entries.find((e) => selected.has(e.path))?.isDirectory && (
                <Button size="sm" variant="outline" onClick={() => void doDownload([...selected][0]!)}>
                  <Download /> Downloaden
                </Button>
              )}
              {canWrite && (
                <>
                  <Button size="sm" variant="outline" disabled={compress.isPending} onClick={() => compress.mutate({ uuid, root: path, paths: [...selected] })}>
                    {compress.isPending ? <Spinner /> : <Archive />} Inpakken
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete([...selected])}>
                    <Trash2 /> Verwijderen
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Wissen
              </Button>
            </>
          )}
        </div>
      )}

      <Card
        className={cn("overflow-hidden", dragOver && "border-primary ring-2 ring-primary/30")}
        onDragOver={(e) => {
          if (!canWrite || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (!canWrite) return;
          e.preventDefault();
          setDragOver(false);
          void doUpload(Array.from(e.dataTransfer.files));
        }}
      >
        {list.error ? (
          <div className="p-4">
            <QueryError error={list.error} title="Map laden mislukt" />
          </div>
        ) : list.isPending ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="file-table">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox
                      aria-label="Alles selecteren"
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))}
                    />
                  </th>
                  <th className="px-2 py-2.5 font-medium">Naam</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Grootte</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">Gewijzigd</th>
                  <th className="w-12 px-2 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {path !== "/" && (
                  <tr className="hover:bg-muted/30">
                    <td />
                    <td colSpan={4} className="px-2 py-2">
                      <button type="button" className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground" onClick={() => onNavigate(parentPath(path))}>
                        <Folder className="size-4" /> ..
                      </button>
                    </td>
                  </tr>
                )}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      Deze map is leeg.{canWrite && " Sleep bestanden hierheen om te uploaden."}
                    </td>
                  </tr>
                )}
                {entries.map((e) => (
                  <FileRow
                    key={e.path}
                    entry={e}
                    selected={selected.has(e.path)}
                    canWrite={canWrite}
                    onToggle={() => toggle(e.path)}
                    onOpen={() => (e.isDirectory ? onNavigate(e.path) : isEditable(e) ? onEdit(e.path) : void doDownload(e.path))}
                    onEdit={() => onEdit(e.path)}
                    onDownload={() => void doDownload(e.path)}
                    onRename={() => setPrompt({ kind: "rename", entry: e })}
                    onDecompress={() => decompress.mutate({ uuid, path: e.path })}
                    onDelete={() => {
                      setSelected(new Set([e.path]));
                      setConfirmDelete([e.path]);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!canWrite && <p className="text-xs text-muted-foreground">Je kunt bestanden bekijken en downloaden, maar niet wijzigen (geen recht files.write).</p>}
    </div>
  );
}

function FileRow(props: {
  entry: FileEntry;
  selected: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDecompress: () => void;
  onDelete: () => void;
}) {
  const { entry: e, canWrite } = props;
  const Icon = e.isDirectory ? Folder : isArchive(e.name) ? FileArchive : FileIcon;
  return (
    <tr className={cn("hover:bg-muted/30", props.selected && "bg-primary/5")} data-testid="file-row">
      <td className="px-4 py-2">
        <Checkbox aria-label={`${e.name} selecteren`} checked={props.selected} onChange={props.onToggle} />
      </td>
      <td className="px-2 py-2">
        <button type="button" onClick={props.onOpen} className="inline-flex min-w-0 items-center gap-2 text-left hover:underline">
          <Icon className={cn("size-4 shrink-0", e.isDirectory ? "text-info" : "text-muted-foreground")} />
          <span className="truncate">{e.name}</span>
          {e.isSymlink && <Link2 className="size-3.5 text-muted-foreground" aria-label="symlink" />}
        </button>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-2 text-right text-muted-foreground sm:table-cell">{e.isDirectory ? "–" : formatBytes(e.size)}</td>
      <td className="hidden whitespace-nowrap px-4 py-2 text-muted-foreground md:table-cell">{formatDate(e.modifiedAt)}</td>
      <td className="px-2 py-1 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Acties voor ${e.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!e.isDirectory && isEditable(e) && (
              <DropdownMenuItem onSelect={props.onEdit}>
                <Pencil /> {canWrite ? "Bewerken" : "Bekijken"}
              </DropdownMenuItem>
            )}
            {!e.isDirectory && (
              <DropdownMenuItem onSelect={props.onDownload}>
                <Download /> Downloaden
              </DropdownMenuItem>
            )}
            {canWrite && (
              <>
                <DropdownMenuItem onSelect={props.onRename}>
                  <Pencil /> Hernoemen
                </DropdownMenuItem>
                {isArchive(e.name) && (
                  <DropdownMenuItem onSelect={props.onDecompress}>
                    <Archive /> Uitpakken
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onDelete} className="text-destructive">
                  <Trash2 /> Verwijderen
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

function NamePrompt({ prompt, pending, onSubmit, onCancel }: { prompt: Prompt; pending: boolean; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(prompt.kind === "rename" ? prompt.entry.name : "");
  const [touched, setTouched] = useState(false);
  const err = fileNameError(name);
  const label = prompt.kind === "mkdir" ? "Naam van de nieuwe map" : prompt.kind === "newfile" ? "Naam van het nieuwe bestand" : `Nieuwe naam voor ${prompt.entry.name}`;
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (!err) onSubmit(name.trim());
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-3" data-testid="name-prompt">
      <div className="min-w-56 flex-1 space-y-1">
        <Input
          autoFocus
          aria-label={label}
          placeholder={label}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          aria-invalid={(touched && !!err) || undefined}
        />
        {touched && err && <p className="text-xs text-destructive">{err}</p>}
      </div>
      <Button type="submit" disabled={pending}>
        {pending && <Spinner />} {prompt.kind === "rename" ? "Hernoemen" : "Aanmaken"}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Annuleren
      </Button>
    </form>
  );
}
