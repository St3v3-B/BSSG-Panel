"use client";
import { BookOpen, ChevronRight, KeyRound, Play, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CopyButton } from "@/app/_components/copy-button";
import { PageHeader } from "@/app/_components/page-header";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { apiBase, curlFor, EXAMPLE_LANGS, quickstart, type ExampleLang } from "@/app/_lib/api-examples";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

type Json = Record<string, unknown>;
interface Param {
  name: string;
  in: "path" | "query";
  required?: boolean;
  description?: string;
  schema?: Json;
}
interface Operation {
  operationId: string;
  tags: string[];
  summary: string;
  "x-permission"?: string | null;
  parameters?: Param[];
  requestBody?: { content: Record<string, { schema: Json }> };
  responses: Record<string, { content?: Record<string, { schema: Json }> }>;
}
export interface OpenApiDoc {
  openapi: string;
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, Operation>>;
}
export interface Endpoint {
  method: string;
  path: string;
  op: Operation;
}

/** Endpoints in documentvolgorde, gegroepeerd per tag. */
export function groupEndpoints(doc: OpenApiDoc): Array<{ tag: string; endpoints: Endpoint[] }> {
  const groups = new Map<string, Endpoint[]>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags[0] ?? "other";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push({ method: method.toUpperCase(), path, op });
    }
  }
  return [...groups].map(([tag, endpoints]) => ({ tag, endpoints }));
}

/** Een JSON-schema kort weergeven (types, geen patterns). */
export function schemaSketch(s: Json | undefined, depth = 0): unknown {
  if (!s || depth > 4) return "…";
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map((x) => schemaSketch(x, depth)).filter((x) => x !== "null").join(" | ") + ((s.anyOf as Json[]).some((x) => x.type === "null") ? " | null" : "");
  if (s.enum) return (s.enum as unknown[]).map((x) => String(x)).join(" | ");
  if (Array.isArray(s.type)) return (s.type as string[]).join(" | ");
  if (s.type === "object" || s.properties) {
    const props = (s.properties ?? {}) as Record<string, Json>;
    const req = new Set((s.required as string[]) ?? []);
    return Object.fromEntries(Object.entries(props).map(([k, v]) => [req.has(k) ? k : `${k}?`, schemaSketch(v, depth + 1)]));
  }
  if (s.type === "array") return [schemaSketch(s.items as Json, depth + 1)];
  if (s.type === "string" && s.format) return `string (${s.format})`;
  return s.type ?? "any";
}

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-info/15 text-info",
  POST: "bg-success/15 text-success",
  PUT: "bg-warning/15 text-warning",
  DELETE: "bg-destructive/15 text-destructive",
};

function Code({ children, testId }: { children: string; testId?: string }) {
  const t = useT();
  return (
    <div className="relative min-w-0">
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 pr-11 font-mono text-xs leading-relaxed" data-testid={testId}>
        {children}
      </pre>
      <div className="absolute right-1.5 top-1.5">
        <CopyButton value={children} label={t.common.copy} />
      </div>
    </div>
  );
}

export function ApiDocs({ origin: originProp }: { origin?: string }) {
  const t = useT();
  const d = t.devaccess.developers;
  const [origin, setOrigin] = useState(originProp ?? "");
  const [doc, setDoc] = useState<OpenApiDoc | null>(null);
  const [error, setError] = useState(false);
  const [lang, setLang] = useState<ExampleLang>("curl");
  const [key, setKey] = useState("");

  useEffect(() => {
    if (!originProp) setOrigin(window.location.origin);
    let stop = false;
    fetch("/api/v1/openapi.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: OpenApiDoc) => !stop && setDoc(j))
      .catch(() => !stop && setError(true));
    return () => {
      stop = true;
    };
  }, [originProp]);

  const groups = useMemo(() => (doc ? groupEndpoints(doc) : []), [doc]);
  const base = origin ? apiBase(origin) : "";

  return (
    <div className="mx-auto max-w-4xl min-w-0">
      <PageHeader title={d.title} description={d.description} />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-5 text-muted-foreground" /> {d.authTitle}
            </CardTitle>
            <CardDescription>{d.authText}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-[8rem_1fr] sm:items-center">
              <span className="text-xs text-muted-foreground">{d.baseUrl}</span>
              <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-1.5">
                <code className="min-w-0 flex-1 break-all font-mono text-sm" data-testid="api-base-url">
                  {base}
                </code>
                <CopyButton value={base} label={d.baseUrl} />
              </div>
              <span className="text-xs text-muted-foreground">Header</span>
              <code className="break-all font-mono text-sm">Authorization: Bearer &lt;key&gt;</code>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href="/account#api-keys">
                  <KeyRound /> {d.getKey}
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" data-testid="openapi-link">
                  <BookOpen /> {d.spec}
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{d.examples}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-1" role="tablist" aria-label={d.examples}>
              {EXAMPLE_LANGS.map((l) => (
                <Button key={l.id} role="tab" aria-selected={lang === l.id} size="sm" variant={lang === l.id ? "secondary" : "ghost"} onClick={() => setLang(l.id)}>
                  {l.label}
                </Button>
              ))}
            </div>
            {origin && <Code testId="api-example">{quickstart(origin, lang)}</Code>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{d.rateTitle}</CardTitle>
            <CardDescription>{d.rateText}</CardDescription>
          </CardHeader>
        </Card>

        <section className="space-y-3" aria-label={d.endpoints}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-lg font-semibold">{d.endpoints}</h2>
            <div className="w-full space-y-1 sm:w-80">
              <Label htmlFor="try-key" className="text-xs">
                {d.tryKey}
              </Label>
              <Input id="try-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="…" />
            </div>
          </div>
          {error ? (
            <p className="text-sm text-destructive">{d.loadError}</p>
          ) : !doc ? (
            <Skeleton className="h-40 rounded-xl" aria-label={d.loading} />
          ) : (
            groups.map((g) => (
              <div key={g.tag} className="space-y-2">
                <h3 className="text-sm font-medium text-muted-foreground">{(d.tags as Record<string, string>)[g.tag] ?? g.tag}</h3>
                {g.endpoints.map((e) => (
                  <EndpointCard key={`${e.method} ${e.path}`} e={e} origin={origin} apiKey={key} />
                ))}
              </div>
            ))
          )}
        </section>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SquareTerminal className="size-5 text-muted-foreground" /> {d.terminalTitle}
            </CardTitle>
            <CardDescription>{d.terminalText}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}

function EndpointCard({ e, origin, apiKey }: { e: Endpoint; origin: string; apiKey: string }) {
  const t = useT();
  const d = t.devaccess.developers;
  const summary = (d.ops as Record<string, string>)[e.op.operationId] ?? e.op.summary;
  const params = e.op.parameters ?? [];
  const body = e.op.requestBody?.content;
  const okStatus = Object.keys(e.op.responses).find((s) => s.startsWith("2")) ?? "200";
  const out = e.op.responses[okStatus]?.content?.["application/json"]?.schema;
  const perm = e.op["x-permission"];
  return (
    <details className="group min-w-0 rounded-lg border border-border bg-card" data-testid="api-endpoint" data-operation={e.op.operationId}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className={cn("w-14 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-xs font-semibold", METHOD_STYLE[e.method])}>{e.method}</span>
        <code className="min-w-0 break-all font-mono text-sm">{e.path}</code>
        <span className="w-full text-sm text-muted-foreground sm:ml-auto sm:w-auto">{summary}</span>
      </summary>
      <div className="space-y-3 border-t border-border p-3">
        <Badge variant="outline" className="font-normal">
          {perm ? d.permission(perm) : d.anyAccess}
        </Badge>
        {params.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{d.params}</div>
            <ul className="space-y-1 text-sm">
              {params.map((p) => (
                <li key={`${p.in}-${p.name}`} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="font-mono">{p.name}</code>
                  <span className="text-xs text-muted-foreground">
                    {p.in} · {String(schemaSketch(p.schema))}
                    {p.required ? ` · ${d.required}` : ""}
                  </span>
                  {p.description && <span className="text-xs text-muted-foreground">{p.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {body && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              {d.body} ({Object.keys(body)[0]})
            </div>
            <Code>{body["application/json"] ? JSON.stringify(schemaSketch(body["application/json"].schema), null, 2) : "<text>"}</Code>
          </div>
        )}
        {out && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              {d.response} ({okStatus})
            </div>
            <Code>{JSON.stringify(schemaSketch(out), null, 2)}</Code>
          </div>
        )}
        {origin && (
          <Code>
            {curlFor(origin, e.method, e.path, {
              query: params.filter((p) => p.in === "query").map((p) => p.name),
              jsonBody: !!body?.["application/json"],
              textBody: !!body?.["text/plain"],
            })}
          </Code>
        )}
        {e.method === "GET" && <TryIt e={e} apiKey={apiKey} />}
      </div>
    </details>
  );
}

/** "Probeer het" voor GET-endpoints met een geplakte sleutel (blijft in het geheugen van deze pagina). */
function TryIt({ e, apiKey }: { e: Endpoint; apiKey: string }) {
  const d = useT().devaccess.developers;
  const params = e.op.parameters ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: number; body: string } | null>(null);
  const send = async () => {
    let path = e.path;
    const qs = new URLSearchParams();
    for (const p of params) {
      const v = values[p.name] ?? (p.name === "path" ? "/" : "");
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(v));
      else if (v) qs.set(p.name, v);
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/v1${path}${qs.size ? `?${qs}` : ""}`, { headers: { authorization: `Bearer ${apiKey}` }, credentials: "omit" });
      const text = await r.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* geen JSON */
      }
      setResult({ status: r.status, body: pretty });
    } catch (err) {
      setResult({ status: 0, body: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      <p className="text-xs text-muted-foreground">{d.tryHint}</p>
      <div className="flex flex-wrap items-end gap-2">
        {params.map((p) => (
          <div key={p.name} className="min-w-0 flex-1 basis-40 space-y-1">
            <Label className="font-mono text-xs">{p.name}</Label>
            <Input value={values[p.name] ?? ""} placeholder={p.name === "path" ? "/" : p.name} onChange={(ev) => setValues((v) => ({ ...v, [p.name]: ev.target.value }))} className="font-mono" />
          </div>
        ))}
        <Button size="sm" onClick={send} disabled={!apiKey || busy} data-testid="try-send">
          {busy ? <Spinner /> : <Play />} {d.trySend}
        </Button>
      </div>
      {result && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{d.tryResult(result.status)}</div>
          <Code>{result.body}</Code>
        </div>
      )}
    </div>
  );
}
