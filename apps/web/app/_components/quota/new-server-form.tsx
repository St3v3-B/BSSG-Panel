"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { QuotaMeters } from "@/app/_components/quota/quota-meters";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

function NumberField({ id, label, value, onChange, max, hint }: { id: string; label: string; value: number; onChange: (n: number) => void; max: number; hint: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min={1} max={max} value={Number.isNaN(value) ? "" : value} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Zelf een server maken (servers.create); de server dwingt het quotum opnieuw af. */
export function NewServerForm() {
  const t = useT().quota;
  const router = useRouter();
  const utils = trpc.useUtils();
  const quota = trpc.account.quota.useQuery();
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [ram, setRam] = useState<number | null>(null);
  const [disk, setDisk] = useState<number | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);
  const [ports, setPorts] = useState(1);
  const create = trpc.servers.create.useMutation({
    onSuccess: async (s) => {
      await Promise.all([utils.servers.list.invalidate(), utils.account.quota.invalidate()]);
      router.push(`/servers/${s.uuid}`);
    },
  });

  if (quota.isPending) return <Skeleton className="h-64 rounded-xl" />;
  const o = quota.data;
  if (!o) return <Alert variant="destructive"><AlertDescription>{t.noQuota}</AlertDescription></Alert>;

  const left = { ram: Math.max(0, o.quota.maxRamMb - o.usage.ramMb), disk: Math.max(0, o.quota.maxDiskMb - o.usage.diskMb), cpu: Math.max(0, o.quota.maxCpuPct - o.usage.cpuPct) };
  const tplId = templateId ?? o.templates[0]?.id ?? null;
  const tpl = o.templates.find((x) => x.id === tplId);
  // Websites alleen op nodes met domeinondersteuning.
  const eligible = o.nodes.filter((x) => tpl?.type !== "web" || x.supportsDomains);
  const node = nodeId != null && eligible.some((x) => x.id === nodeId) ? nodeId : (eligible[0]?.id ?? null);
  const ramV = ram ?? Math.min(1024, left.ram);
  const diskV = disk ?? Math.min(2048, left.disk);
  const cpuV = cpu ?? Math.min(100, left.cpu);
  const maxPorts = o.quota.maxPortsPerServer ?? 100;
  const full = o.usage.servers >= o.quota.maxServers;
  const valid = !!name.trim() && tplId !== null && node !== null && ramV >= 64 && ramV <= left.ram && diskV >= 64 && diskV <= left.disk && cpuV >= 1 && cpuV <= left.cpu && !full && (tpl?.type !== "game" || (ports >= 1 && ports <= maxPorts));

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <QuotaMeters overview={o} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.createTitle}</CardTitle>
          <CardDescription>{t.createDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) create.mutate({ name: name.trim(), templateId: tplId!, nodeId: node!, limits: { ramMb: ramV, diskMb: diskV, cpuPct: cpuV }, ports: tpl?.type === "game" ? ports : 1, variables: {} });
            }}
          >
            {full && <p className="text-sm text-destructive">{t.full}</p>}
            <div className="space-y-1.5">
              <Label htmlFor="own-name">{t.name}</Label>
              <Input id="own-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="own-template">{t.template}</Label>
                <Select id="own-template" value={tplId ?? ""} onChange={(e) => setTemplateId(Number(e.target.value))}>
                  {o.templates.length === 0 && <option value="">{t.noTemplates}</option>}
                  {o.templates.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="own-node">{t.node}</Label>
                <Select id="own-node" value={node ?? ""} onChange={(e) => setNodeId(Number(e.target.value))}>
                  {eligible.length === 0 && <option value="">{t.noNodes}</option>}
                  {eligible.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <NumberField id="own-ram" label={t.ram} value={ramV} onChange={setRam} max={left.ram} hint={t.remaining(String(left.ram))} />
              <NumberField id="own-disk" label={t.disk} value={diskV} onChange={setDisk} max={left.disk} hint={t.remaining(String(left.disk))} />
              <NumberField id="own-cpu" label={t.cpu} value={cpuV} onChange={setCpu} max={left.cpu} hint={t.remaining(String(left.cpu))} />
            </div>
            {tpl?.type === "game" && <NumberField id="own-ports" label={t.portsLabel} value={ports} onChange={setPorts} max={maxPorts} hint={t.portsHint} />}
            {create.error && <p className="text-sm text-destructive">{errorText(create.error)}</p>}
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending && <Spinner />} {t.submit}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
