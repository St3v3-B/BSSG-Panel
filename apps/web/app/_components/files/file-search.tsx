"use client";
import { File as FileIcon, Folder, FolderOpen, Search, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { FileSearchHit } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Spinner } from "@/app/_components/ui/spinner";
import { QueryError } from "@/app/_components/query-error";
import { formatBytes } from "@/app/_lib/format";
import { isEditable, parentPath } from "@/app/_lib/files";
import { useT } from "@/app/_lib/i18n";

export interface SearchQuery {
  query: string;
  content: boolean;
}

/** Zoekveld in de werkbalk van de filemanager. */
export function FileSearchForm({ onSearch }: { onSearch: (q: SearchQuery) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [content, setContent] = useState(false);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const q = query.trim();
    if (q) onSearch({ query: q, content });
  };
  return (
    <form role="search" onSubmit={submit} className="flex flex-wrap items-center gap-2" data-testid="file-search-form">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label={t.files.search}
          placeholder={content ? t.files.searchContentPlaceholder : t.files.searchPlaceholder}
          className="h-8 w-56 pl-8 text-sm"
          maxLength={200}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={t.files.searchContentHint}>
        <Checkbox checked={content} onChange={(e) => setContent(e.target.checked)} /> {t.files.searchContent}
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={!query.trim()}>
        {t.files.search}
      </Button>
    </form>
  );
}

/** Resultaten van files.search; klik opent de map of het bestand. */
export function FileSearchResults({
  uuid,
  path,
  search,
  onClose,
  onNavigate,
  onEdit,
}: {
  uuid: string;
  path: string;
  search: SearchQuery;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onEdit: (path: string) => void;
}) {
  const t = useT();
  const q = trpc.files.search.useQuery({ uuid, path, query: search.query, content: search.content }, { retry: false, staleTime: 10_000 });
  const open = (h: FileSearchHit) => {
    if (h.entry.isDirectory) onNavigate(h.entry.path);
    else if (isEditable(h.entry)) onEdit(h.entry.path);
    else onNavigate(parentPath(h.entry.path));
  };
  const results = q.data?.results ?? [];
  return (
    <Card className="overflow-hidden" data-testid="file-search-results">
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 text-sm">
        <Search className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">“{search.query}”</span> <span className="text-muted-foreground">{t.files.searchIn(path)}</span>
          {q.data && <span className="text-muted-foreground"> · {t.files.searchResults(results.length)}</span>}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t.files.searchClose} title={t.files.searchClose}>
          <X />
        </Button>
      </div>
      {q.error ? (
        <div className="p-4">
          <QueryError error={q.error} title={t.files.searchFailed} />
        </div>
      ) : q.isPending ? (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Spinner /> {t.common.loading}
        </div>
      ) : (
        <>
          {(q.data.truncated || q.data.timedOut) && (
            <p className="border-b border-border px-4 py-2 text-xs text-warning" role="status">
              {q.data.timedOut ? t.files.searchTimedOut : t.files.searchTruncated(results.length)}
            </p>
          )}
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t.files.searchNone}</p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto text-sm">
              {results.map((h) => (
                <li key={h.entry.path} className="flex items-start gap-2 px-4 py-2 hover:bg-muted/30" data-testid="search-hit">
                  <button type="button" onClick={() => open(h)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                    {h.entry.isDirectory ? <Folder className="mt-0.5 size-4 shrink-0 text-info" /> : <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono hover:underline">{h.entry.path}</span>
                      {h.matches.map((m) => (
                        <span key={m.line} className="block truncate font-mono text-xs text-muted-foreground">
                          <span className="mr-2 text-foreground/60">{t.files.searchLine(m.line)}</span>
                          {m.text}
                        </span>
                      ))}
                    </span>
                    {!h.entry.isDirectory && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(h.entry.size)}</span>}
                  </button>
                  {!h.entry.isDirectory && (
                    <Button variant="ghost" size="icon-sm" onClick={() => onNavigate(parentPath(h.entry.path))} aria-label={`${t.files.openFolder}: ${parentPath(h.entry.path)}`} title={t.files.openFolder}>
                      <FolderOpen />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
