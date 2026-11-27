"use client";
import { Check, Star, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Limits as LimitsT, ServerDetail, ServerType } from "@panel/api";
import { DiscordId, Limits } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { errorText } from "@/app/_lib/errors";
import { getT, useT } from "@/app/_lib/i18n";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function Field({ id, label, hint, error, children, className }: { id: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Controleert een variabelewaarde tegen het patroon uit de template. */
export function variableError(value: string, pattern: string | null): string | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern).test(value) ? null : getT().settings.pattern(pattern);
  } catch {
    return null; // ongeldig patroon in de template: niet blokkeren
  }
}

export function CreateServerForm({ onCreated, initialKind = "game" }: { onCreated: (server: ServerDetail) => void; initialKind?: ServerType }) {
  const utils = trpc.useUtils();
  const i18n = useT();
  const f = i18n.createForm;

  // ---------- data ----------
  const nodes = trpc.admin.nodes.list.useQuery();
  const templates = trpc.admin.templates.list.useQuery();
  const settings = trpc.admin.settings.get.useQuery();

  // ---------- state ----------
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [ownerSearch, setOwnerSearch] = useState("");
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [kind, setKind] = useState<ServerType>(initialKind);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [allocationIds, setAllocationIds] = useState<number[]>([]);
  const [limits, setLimits] = useState<Record<keyof LimitsT, string> | null>(null);
  const [startOnInstall, setStartOnInstall] = useState(true);
  const [submitted, setSubmitted] = useState(false);

  // standaard: de lokale (of eerste) node, de eerste template, limieten uit de instellingen
  useEffect(() => {
    if (nodeId == null && nodes.data?.length) setNodeId((nodes.data.find((n) => n.isLocal) ?? nodes.data[0])!.id);
    // Websites alleen op nodes met domeinondersteuning.
    const cur = nodes.data?.find((n) => n.id === nodeId);
    if (kind === "web" && cur && !cur.supportsDomains) {
      const ok = nodes.data?.find((n) => n.supportsDomains);
      if (ok) setNodeId(ok.id);
    }
  }, [nodes.data, nodeId, kind]);
  const kindTemplates = useMemo(() => (templates.data ?? []).filter((t) => t.type === kind), [templates.data, kind]);
  useEffect(() => {
    // bij wisselen tussen game-server en website: eerste template van dat soort
    if (!templates.data) return;
    if (templateId == null || !kindTemplates.some((t) => t.id === templateId)) setTemplateId(kindTemplates[0]?.id ?? null);
  }, [templates.data, kindTemplates, templateId]);
  useEffect(() => {
    const d = settings.data?.defaultLimits;
    if (d && !limits) setLimits({ cpuPct: String(d.cpuPct), ramMb: String(d.ramMb), swapMb: String(d.swapMb), diskMb: String(d.diskMb) });
  }, [settings.data, limits]);

  const template = trpc.admin.templates.get.useQuery({ id: templateId ?? 0 }, { enabled: templateId != null });
  const templateType = template.data?.type ?? templates.data?.find((t) => t.id === templateId)?.type;
  const templateVars = useMemo(() => (template.data?.id === templateId ? template.data.variables : []), [template.data, templateId]);
  useEffect(() => {
    setVariables(Object.fromEntries(templateVars.map((v) => [v.key, v.default])));
  }, [templateVars]);

  const allocations = trpc.admin.allocations.list.useQuery({ nodeId: nodeId ?? 0 }, { enabled: nodeId != null });
  const freeAllocations = (allocations.data ?? []).filter((a) => a.serverUuid === null);
  useEffect(() => setAllocationIds([]), [nodeId]);

  // ---------- eigenaar ----------
  const users = trpc.admin.users.list.useQuery({ limit: 20, search: ownerSearch.trim() || undefined }, { placeholderData: (prev) => prev });
  const [knownOwner, setKnownOwner] = useState<{ id: number; name: string | null; discordId: string; avatarUrl: string | null } | null>(null);
  const createUser = trpc.admin.users.create.useMutation({
    onSuccess: (u) => {
      setOwnerId(u.id);
      setKnownOwner(u);
      setOwnerSearch("");
      void utils.admin.users.list.invalidate();
    },
  });
  const searchIsDiscordId = DiscordId.safeParse(ownerSearch.trim()).success;
  const exactMatch = users.data?.items.find((u) => u.discordId === ownerSearch.trim());
  const owner = users.data?.items.find((u) => u.id === ownerId) ?? (knownOwner?.id === ownerId ? knownOwner : null);

  // ---------- validatie ----------
  const parsedLimits = limits
    ? Limits.safeParse({ cpuPct: Number(limits.cpuPct), ramMb: Number(limits.ramMb), swapMb: Number(limits.swapMb), diskMb: Number(limits.diskMb) })
    : null;
  const limitErrors: Partial<Record<keyof LimitsT, string>> = {};
  if (parsedLimits && !parsedLimits.success) {
    for (const issue of parsedLimits.error.issues) {
      const k = issue.path[0] as keyof LimitsT;
      limitErrors[k] ??= Number.isNaN(Number(limits?.[k])) ? f.limitNaN : issue.code === "too_small" ? f.limitLow : issue.code === "too_big" ? f.limitHigh : f.limitInvalid;
    }
  }
  const varErrors = Object.fromEntries(templateVars.map((v) => [v.key, variableError(variables[v.key] ?? "", v.pattern)]));
  const errors = {
    name: !name.trim() ? f.errName : name.length > 100 ? f.errNameMax : null,
    owner: ownerId == null ? f.errOwner : null,
    node: nodeId == null ? f.errNode : null,
    template: templateId == null ? f.errTemplate : null,
    allocations: templateType === "game" && allocationIds.length === 0 ? f.errPorts : null,
    limits: !parsedLimits || !parsedLimits.success ? f.errLimits : null,
    variables: Object.values(varErrors).some(Boolean) ? f.errVariables : null,
  };
  const valid = Object.values(errors).every((e) => !e);
  const show = (e: string | null) => (submitted ? e : null);

  const create = trpc.admin.servers.create.useMutation({
    onSuccess: (server) => {
      void utils.admin.servers.list.invalidate();
      void utils.servers.list.invalidate();
      void utils.admin.allocations.list.invalidate();
      onCreated(server);
    },
  });

  function submit() {
    setSubmitted(true);
    if (!valid || !parsedLimits?.success || ownerId == null || nodeId == null || templateId == null) return;
    create.mutate({
      name: name.trim(),
      ownerId,
      nodeId,
      templateId,
      limits: parsedLimits.data,
      allocationIds: templateType === "game" ? allocationIds : [],
      variables,
      startOnInstall,
    });
  }

  function toggleAllocation(id: number) {
    setAllocationIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }
  function makePrimary(id: number) {
    setAllocationIds((cur) => [id, ...cur.filter((x) => x !== id)]);
  }

  const loading = nodes.isPending || templates.isPending || settings.isPending;
  if (loading) return <Skeleton className="h-96 rounded-xl" />;
  const loadError = nodes.error ?? templates.error ?? settings.error;
  if (loadError) {
    return (
      <Alert variant="destructive">
        <div>
          <AlertTitle>{f.loadFailed}</AlertTitle>
          <AlertDescription>{errorText(loadError)}</AlertDescription>
        </div>
      </Alert>
    );
  }

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="create-server-form"
    >
      <Section title={f.general}>
        <Field id="server-name" label={f.name} error={show(errors.name)}>
          <Input id="server-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder={f.namePlaceholder} aria-invalid={!!show(errors.name) || undefined} />
        </Field>

        <div className="space-y-1.5">
          <Label htmlFor="owner-search">{f.owner}</Label>
          {owner && (
            <div className="flex items-center gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2" data-testid="selected-owner">
              <UserAvatar user={owner} className="size-7" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{displayName(owner)}</div>
                <div className="font-mono text-xs text-muted-foreground">{owner.discordId}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setOwnerId(null)}>
                {f.change}
              </Button>
            </div>
          )}
          {!owner && (
            <>
              <Input
                id="owner-search"
                value={ownerSearch}
                onChange={(e) => setOwnerSearch(e.target.value)}
                placeholder={f.ownerSearch}
                autoComplete="off"
              />
              <div className="max-h-56 overflow-y-auto rounded-md border border-border" role="listbox" aria-label={f.users}>
                {users.data?.items.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={ownerId === u.id}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setOwnerId(u.id);
                      setKnownOwner(u);
                    }}
                  >
                    <UserAvatar user={u} className="size-7" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{displayName(u)}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{u.discordId}</span>
                    </span>
                    {!u.name && <Badge variant="secondary">{f.notSignedIn}</Badge>}
                    {u.blocked && <Badge variant="destructive">{f.blocked}</Badge>}
                  </button>
                ))}
                {users.data && users.data.items.length === 0 && !searchIsDiscordId && (
                  <p className="px-3 py-3 text-sm text-muted-foreground">{f.noUsers}</p>
                )}
                {users.isPending && <p className="px-3 py-3 text-sm text-muted-foreground">{i18n.common.loading}</p>}
              </div>
              {searchIsDiscordId && !exactMatch && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm">
                  <span className="flex-1 text-muted-foreground">
                    {f.noAccountPre} <code className="font-mono text-foreground">{ownerSearch.trim()}</code>
                    {f.noAccountPost}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => createUser.mutate({ discordId: ownerSearch.trim() })} disabled={createUser.isPending}>
                    {createUser.isPending ? <Spinner /> : <UserPlus />} {f.precreate}
                  </Button>
                </div>
              )}
              {createUser.error && <p className="text-xs text-destructive">{errorText(createUser.error)}</p>}
              {show(errors.owner) && <p className="text-xs text-destructive">{errors.owner}</p>}
            </>
          )}
        </div>
      </Section>

      <Section title={f.kindSection}>
        <div className="inline-flex rounded-lg border border-border p-0.5" role="group" aria-label={f.kind}>
          {(["game", "web"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn("rounded-md px-3 py-1.5 text-sm", kind === k ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {k === "game" ? f.kindGame : f.kindWeb}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="server-node" label={f.node} error={show(errors.node)}>
            <Select id="server-node" value={nodeId ?? ""} onChange={(e) => setNodeId(e.target.value ? Number(e.target.value) : null)}>
              {nodes.data?.length === 0 && <option value="">{f.noNodes}</option>}
              {nodes.data?.map((n) => (
                <option key={n.id} value={n.id} disabled={kind === "web" && !n.supportsDomains}>
                  {n.name} ({n.fqdn}){kind === "web" && !n.supportsDomains ? ` - ${i18n.admin.nodes.join.noDomains}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {kind === "web" && templates.data && kindTemplates.length === 0 && <p className="self-end text-sm text-muted-foreground">{f.noWebTemplates}</p>}
          {kind === "game" && (
          <Field id="server-template" label={f.template} error={show(errors.template)} hint={templates.data?.find((t) => t.id === templateId)?.description ?? undefined}>
            <Select id="server-template" value={templateId ?? ""} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}>
              {templates.data && kindTemplates.length === 0 && <option value="">{f.noGameTemplates}</option>}
              {kindTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          )}
        </div>
        {errors.template && kind === "web" && show(errors.template) && <p className="text-xs text-destructive">{errors.template}</p>}
        {kind === "web" && kindTemplates.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={f.pickWebTemplate} data-testid="web-templates">
            {kindTemplates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === templateId}
                onClick={() => setTemplateId(t.id)}
                className={cn("rounded-lg border border-border p-3 text-left text-sm hover:border-foreground/30", t.id === templateId && "border-primary bg-primary/5")}
              >
                <span className="block font-medium">{t.name}</span>
                {t.description && <span className="block text-xs text-muted-foreground">{t.description}</span>}
              </button>
            ))}
          </div>
        )}

        {template.isFetching && templateVars.length === 0 ? (
          <Skeleton className="h-16" />
        ) : templateVars.length > 0 ? (
          <div className="space-y-4 rounded-lg border border-border p-4" data-testid="template-variables">
            <div className="text-sm font-medium">{f.variables}</div>
            <div className="grid gap-4 sm:grid-cols-2">
              {templateVars.map((v) => (
                <Field
                  key={v.key}
                  id={`var-${v.key}`}
                  label={v.name}
                  error={show(varErrors[v.key] ?? null)}
                  hint={
                    <>
                      <code className="font-mono">{v.key}</code>
                      {v.description && <> · {v.description}</>}
                      {v.userEditable && <> · {f.userEditable}</>}
                    </>
                  }
                >
                  <Input
                    id={`var-${v.key}`}
                    value={variables[v.key] ?? ""}
                    placeholder={v.default}
                    onChange={(e) => setVariables((cur) => ({ ...cur, [v.key]: e.target.value }))}
                    aria-invalid={!!show(varErrors[v.key] ?? null) || undefined}
                  />
                </Field>
              ))}
            </div>
          </div>
        ) : null}
      </Section>

      {templateType !== "web" && (
        <Section title={f.ports} description={f.portsText}>
          {allocations.isPending ? (
            <Skeleton className="h-20" />
          ) : freeAllocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{f.noPorts}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="allocations">
              {freeAllocations.map((a) => {
                const idx = allocationIds.indexOf(a.id);
                const selected = idx >= 0;
                return (
                  <div
                    key={a.id}
                    className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", selected ? "border-primary/50 bg-primary/5" : "border-border")}
                  >
                    <Checkbox id={`alloc-${a.id}`} checked={selected} onChange={() => toggleAllocation(a.id)} />
                    <label htmlFor={`alloc-${a.id}`} className="flex-1 cursor-pointer font-mono">
                      {a.ip}:{a.port}
                    </label>
                    {idx === 0 && (
                      <Badge>
                        <Star /> {f.primary}
                      </Badge>
                    )}
                    {idx > 0 && (
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => makePrimary(a.id)}>
                        {f.makePrimary}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {show(errors.allocations) && <p className="text-xs text-destructive">{errors.allocations}</p>}
        </Section>
      )}

      <Section title={f.limits} description={f.limitsText}>
        {limits && (
          <div className="grid gap-4 sm:grid-cols-4">
            {(
              [
                ["cpuPct", f.cpu],
                ["ramMb", f.ram],
                ["swapMb", f.swap],
                ["diskMb", f.disk],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} id={`limit-${k}`} label={label} error={show(limitErrors[k] ?? null)}>
                <Input
                  id={`limit-${k}`}
                  type="number"
                  inputMode="numeric"
                  value={limits[k]}
                  onChange={(e) => setLimits((cur) => (cur ? { ...cur, [k]: e.target.value } : cur))}
                  aria-invalid={!!show(limitErrors[k] ?? null) || undefined}
                />
              </Field>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={startOnInstall} onChange={(e) => setStartOnInstall(e.target.checked)} />
          {f.startOnInstall}
        </label>
      </Section>

      {create.error && (
        <Alert variant="destructive" data-testid="create-error">
          <div>
            <AlertTitle>{f.createFailed}</AlertTitle>
            <AlertDescription>{errorText(create.error)}</AlertDescription>
          </div>
        </Alert>
      )}
      {submitted && !valid && (
        <p className="text-sm text-destructive" data-testid="form-invalid">
          {f.invalid(Object.values(errors).filter(Boolean).join(", ").toLowerCase())}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={create.isPending || create.isSuccess}>
          {create.isPending ? <Spinner /> : <Check />} {f.submit}
        </Button>
      </div>
    </form>
  );
}
