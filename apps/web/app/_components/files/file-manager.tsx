"use client";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FileArchive,
  FilePlus,
  Folder,
  FolderInput,
  FolderPlus,
  KeyRound,
  Link2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useMemo, useRef, useState, type FormEvent } from "react";
import type { ArchiveFormat, FileEntry, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ChmodDialog } from "@/app/_components/files/chmod-dialog";
import { FileActionError } from "@/app/_components/files/file-action-error";
import { FileSearchForm, FileSearchResults, type SearchQuery } from "@/app/_components/files/file-search";
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
import {
  breadcrumbs,
  fileNameError,
  isArchive,
  isEditable,
  joinPath,
  normalizePath,
  parentPath,
  startArchiveDownload,
  startDownload,
  UploadError,
  uploadErrorText,
  uploadFiles,
} from "@/app/_lib/files";
import { useT } from "@/app/_lib/i18n";

type Prompt = { kind: "mkdir" } | { kind: "newfile" } | { kind: "rename"; entry: FileEntry };

export interface FileManagerProps {
  server: Pick<ServerDetail, "uuid" | "permissions">;
  path: string;
  onNavigate: (path: string) => void;
  onEdit: (path: string) => void;
  /** Voor tests: upload-implementatie vervangen. */
  upload?: typeof uploadFiles;
  /** Voor tests: archief-download vervangen. */
  downloadArchive?: (url: string) => void;
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name, "nl")));
}

export function FileManager({ server, path, onNavigate, onEdit, upload = uploadFiles, downloadArchive = startArchiveDownload }: FileManagerProps) {
  const uuid = server.uuid;
  const t = useT();
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
  const [search, setSearch] = useState<SearchQuery | null>(null);
  const [chmodFor, setChmodFor] = useState<FileEntry[] | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = () => utils.files.list.invalidate({ uuid, path });
  const fail = (e: unknown) => setError({ error: e });
  const done = (msg?: string) => {
    setError(null);
    setNotice(msg ?? null);
    setSelected(new Set());
    void refresh();
  };

  const mkdir = trpc.files.mkdir.useMutation({ onSuccess: () => (setPrompt(null), done(t.files.folderCreated)), onError: fail });
  const write = trpc.files.write.useMutation({ onError: fail });
  const rename = trpc.files.rename.useMutation({ onSuccess: () => (setPrompt(null), done(t.files.renamed)), onError: fail });
  const del = trpc.files.delete.useMutation({ onSuccess: () => (setConfirmDelete(null), done(t.files.deleted)), onError: fail });
  const compress = trpc.files.compress.useMutation({ onSuccess: (r) => done(t.files.compressed(r.archive.name)), onError: fail });
  const decompress = trpc.files.decompress.useMutation({ onSuccess: () => done(t.files.decompressed), onError: fail });
  const move = trpc.files.move.useMutation({ onSuccess: (_r, v) => (setMoving(null), done(t.files.moved(v.paths.length))), onError: fail });
  const uploadUrl = trpc.files.uploadUrl.useMutation();
  const downloadUrl = trpc.files.downloadUrl.useMutation();
  const archiveUrl = trpc.files.archiveUrl.useMutation();
  const busy = mkdir.isPending || rename.isPending || del.isPending || compress.isPending || decompress.isPending || write.isPending || move.isPending;

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
    setUploading({ names: files.length === 1 ? files[0]!.name : t.files.nFiles(files.length), fraction: 0 });
    try {
      const signed = await uploadUrl.mutateAsync({ uuid, directory: path });
      await upload(signed.url, path, files, (fraction) => setUploading((u) => (u ? { ...u, fraction } : u)));
      done(t.files.uploaded(files.length === 1 ? files[0]!.name : t.files.nFiles(files.length)));
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

  async function doArchive(root: string, paths: string[], format: ArchiveFormat) {
    try {
      const signed = await archiveUrl.mutateAsync({ uuid, root, paths, format });
      downloadArchive(signed.url);
    } catch (e) {
      fail(e);
    }
  }
  /** De huidige map als archief (de map zelf als bovenste map in het archief; "/" = alles). */
  const downloadFolder = (format: ArchiveFormat) => (path === "/" ? doArchive("/", ["/"], format) : doArchive(parentPath(path), [path], format));
  const selectedEntries = () => entries.filter((e) => selected.has(e.path));
  const navigateFromSearch = (p: string) => {
    setSearch(null);
    onNavigate(p);
  };
  const editFromSearch = (p: string) => {
    setSearch(null);
    onEdit(p);
  };

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
        <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" aria-label={t.files.pathLabel}>
          {breadcrumbs(path).map((c, i, all) => (
            <span key={c.path} className="inline-flex items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3.5 text-muted-foreground" />}
              <button
                type="button"
                onClick={() => onNavigate(c.path)}
                className={cn("rounded px-1.5 py-0.5 font-mono hover:bg-muted", i === all.length - 1 ? "text-foreground" : "text-muted-foreground")}
              >
                {i === 0 ? t.files.home : c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <FileSearchForm key={path} onSearch={setSearch} />
          <ArchiveMenu label={t.files.downloadFolder} variant="ghost" onPick={(f) => void downloadFolder(f)} disabled={archiveUrl.isPending} />
          <Button variant="ghost" size="icon-sm" onClick={() => void list.refetch()} aria-label={t.common.refresh} title={t.common.refresh}>
            <RefreshCw className={cn(list.isFetching && "animate-spin")} />
          </Button>
          {canWrite && (
            <>
              <Button variant="outline" size="sm" onClick={() => setPrompt({ kind: "mkdir" })}>
                <FolderPlus /> {t.files.newFolder}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPrompt({ kind: "newfile" })}>
                <FilePlus /> {t.files.newFile}
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
                <Upload /> {t.files.upload}
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
            <Spinner /> {t.files.uploading(uploading.names, Math.round(uploading.fraction * 100))}
          </div>
          <Progress value={uploading.fraction * 100} />
        </div>
      )}
      {search && (
        <FileSearchResults key={`${path}|${search.query}|${search.content}`} uuid={uuid} path={path} search={search} onClose={() => setSearch(null)} onNavigate={navigateFromSearch} onEdit={editFromSearch} />
      )}
      {moving && <MovePrompt count={moving.length} initial={path} pending={move.isPending} onCancel={() => setMoving(null)} onSubmit={(destination) => move.mutate({ uuid, paths: moving, destination })} />}
      {chmodFor && (
        <ChmodDialog
          uuid={uuid}
          entries={chmodFor}
          onClose={() => setChmodFor(null)}
          onDone={(n) => {
            setChmodFor(null);
            done(t.files.chmodDone(n));
          }}
        />
      )}
      {prompt && <NamePrompt key={prompt.kind + (prompt.kind === "rename" ? prompt.entry.path : "")} prompt={prompt} pending={busy} onCancel={() => setPrompt(null)} onSubmit={submitPrompt} />}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm" data-testid="selection-bar">
          <span className="mr-auto">{t.files.selected(selected.size)}</span>
          {confirmDelete ? (
            <>
              <span className="text-destructive">{t.files.confirmDelete(confirmDelete.length)}</span>
              <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ uuid, paths: confirmDelete })}>
                {del.isPending && <Spinner />} {t.common.delete}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t.common.cancel}
              </Button>
            </>
          ) : (
            <>
              {selected.size === 1 && !entries.find((e) => selected.has(e.path))?.isDirectory ? (
                <Button size="sm" variant="outline" onClick={() => void doDownload([...selected][0]!)}>
                  <Download /> {t.files.download}
                </Button>
              ) : (
                <ArchiveMenu label={t.files.download} variant="outline" onPick={(f) => void doArchive(path, [...selected], f)} disabled={archiveUrl.isPending} />
              )}
              {canWrite && (
                <>
                  <Button size="sm" variant="outline" onClick={() => setMoving([...selected])}>
                    <FolderInput /> {t.files.move}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setChmodFor(selectedEntries())}>
                    <KeyRound /> {t.files.permissions}
                  </Button>
                  <Button size="sm" variant="outline" disabled={compress.isPending} onClick={() => compress.mutate({ uuid, root: path, paths: [...selected] })}>
                    {compress.isPending ? <Spinner /> : <Archive />} {t.files.compress}
                  </Button>
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete([...selected])}>
                    <Trash2 /> {t.common.delete}
                  </Button>
                </>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t.files.clearSelection}
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
            <QueryError error={list.error} title={t.files.loadFailed} />
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
                      aria-label={t.files.selectAll}
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.path)))}
                    />
                  </th>
                  <th className="px-2 py-2.5 font-medium">{t.files.colName}</th>
                  <th className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">{t.files.colSize}</th>
                  <th className="hidden px-4 py-2.5 font-medium md:table-cell">{t.files.colModified}</th>
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
                      {t.files.empty}{canWrite && t.files.dropHint}
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
                    onArchive={(f) => void doArchive(path, [e.path], f)}
                    onChmod={() => setChmodFor([e])}
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
      {!canWrite && <p className="text-xs text-muted-foreground">{t.files.readOnlyHint}</p>}
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
  onArchive: (format: ArchiveFormat) => void;
  onChmod: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { entry: e, canWrite } = props;
  const Icon = e.isDirectory ? Folder : isArchive(e.name) ? FileArchive : FileIcon;
  return (
    <tr className={cn("hover:bg-muted/30", props.selected && "bg-primary/5")} data-testid="file-row">
      <td className="px-3 py-2 sm:px-4">
        <Checkbox aria-label={t.files.select(e.name)} checked={props.selected} onChange={props.onToggle} />
      </td>
      <td className="w-full max-w-0 px-2 py-2">
        <button type="button" onClick={props.onOpen} className="flex min-h-7 w-full min-w-0 items-center gap-2.5 text-left hover:underline sm:min-h-0">
          <Icon className={cn("size-5 shrink-0 sm:size-4", e.isDirectory ? "text-info" : "text-muted-foreground")} />
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {e.isSymlink && <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="symlink" />}
        </button>
        <div className="truncate pl-[30px] text-xs text-muted-foreground sm:hidden">
          {e.isDirectory ? "–" : formatBytes(e.size)} · {formatDate(e.modifiedAt)}
        </div>
      </td>
      <td className="hidden whitespace-nowrap px-4 py-2 text-right text-muted-foreground sm:table-cell">{e.isDirectory ? "–" : formatBytes(e.size)}</td>
      <td className="hidden whitespace-nowrap px-4 py-2 text-muted-foreground md:table-cell">{formatDate(e.modifiedAt)}</td>
      <td className="px-2 py-1 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t.files.actions(e.name)}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!e.isDirectory && isEditable(e) && (
              <DropdownMenuItem onSelect={props.onEdit}>
                <Pencil /> {canWrite ? t.files.edit : t.files.view}
              </DropdownMenuItem>
            )}
            {e.isDirectory ? (
              <>
                <DropdownMenuItem onSelect={() => props.onArchive("zip")}>
                  <Download /> {t.files.downloadZip}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.onArchive("tar.gz")}>
                  <Download /> {t.files.downloadTarGz}
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onSelect={props.onDownload}>
                <Download /> {t.files.download}
              </DropdownMenuItem>
            )}
            {canWrite && (
              <>
                <DropdownMenuItem onSelect={props.onRename}>
                  <Pencil /> {t.files.rename}
                </DropdownMenuItem>
                {!e.isSymlink && (
                  <DropdownMenuItem onSelect={props.onChmod}>
                    <KeyRound /> {t.files.permissions}
                  </DropdownMenuItem>
                )}
                {isArchive(e.name) && (
                  <DropdownMenuItem onSelect={props.onDecompress}>
                    <Archive /> {t.files.extract}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onDelete} className="text-destructive">
                  <Trash2 /> {t.common.delete}
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
  const t = useT();
  const [name, setName] = useState(prompt.kind === "rename" ? prompt.entry.name : "");
  const [touched, setTouched] = useState(false);
  const err = fileNameError(name);
  const label = prompt.kind === "mkdir" ? t.files.promptMkdir : prompt.kind === "newfile" ? t.files.promptNewFile : t.files.promptRename(prompt.entry.name);
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
        {pending && <Spinner />} {prompt.kind === "rename" ? t.files.rename : t.common.create}
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t.common.cancel}
      </Button>
    </form>
  );
}

/** Knop met keuze tussen .zip en .tar.gz. */
function ArchiveMenu({ label, variant, onPick, disabled }: { label: string; variant: "outline" | "ghost"; onPick: (f: ArchiveFormat) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={variant} disabled={disabled}>
          {disabled ? <Spinner /> : <Download />} {label} <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPick("zip")}>{t.files.downloadZip}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onPick("tar.gz")}>{t.files.downloadTarGz}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MovePrompt({ count, initial, pending, onSubmit, onCancel }: { count: number; initial: string; pending: boolean; onSubmit: (dest: string) => void; onCancel: () => void }) {
  const t = useT();
  const [dest, setDest] = useState(initial);
  const [touched, setTouched] = useState(false);
  const err = dest.trim().startsWith("/") ? null : t.files.moveInvalid;
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    setTouched(true);
    if (!err) onSubmit(normalizePath(dest.trim()));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-start gap-2 rounded-lg border border-border p-3" data-testid="move-prompt">
      <div className="min-w-56 flex-1 space-y-1">
        <Input
          autoFocus
          aria-label={t.files.movePrompt}
          placeholder={t.files.movePrompt}
          className="font-mono"
          value={dest}
          onChange={(e) => setDest(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
          aria-invalid={(touched && !!err) || undefined}
        />
        {touched && err && <p className="text-xs text-destructive">{err}</p>}
      </div>
      <Button type="submit" disabled={pending}>
        {pending && <Spinner />} {t.files.move} ({count})
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        {t.common.cancel}
      </Button>
    </form>
  );
}
