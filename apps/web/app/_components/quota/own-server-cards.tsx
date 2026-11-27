"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Eigen limieten wijzigen binnen het quotum (servers.updateOwnLimits). */
export function OwnLimitsCard({ server }: { server: ServerDetail }) {
  const all = useT();
  const t = all.quota;
  const utils = trpc.useUtils();
  const quota = trpc.account.quota.useQuery();
  const [ram, setRam] = useState(server.limits.ramMb);
  const [disk, setDisk] = useState(server.limits.diskMb);
  const [cpu, setCpu] = useState(server.limits.cpuPct);
  const save = trpc.servers.updateOwnLimits.useMutation({
    onSuccess: () => Promise.all([utils.servers.get.invalidate({ uuid: server.uuid }), utils.account.quota.invalidate()]),
  });
  const o = quota.data;
  if (!o) return null;
  // Wat er voor deze server nog kan: quotum min wat de andere servers gebruiken.
  const room = { ram: o.quota.maxRamMb - o.usage.ramMb + server.limits.ramMb, disk: o.quota.maxDiskMb - o.usage.diskMb + server.limits.diskMb, cpu: o.quota.maxCpuPct - o.usage.cpuPct + server.limits.cpuPct };
  const ok = (v: number, cur: number, max: number, min: number) => Number.isInteger(v) && v >= min && (v <= max || v <= cur);
  const valid = ok(ram, server.limits.ramMb, room.ram, 64) && ok(disk, server.limits.diskMb, room.disk, 64) && ok(cpu, server.limits.cpuPct, room.cpu, 1);
  const changed = ram !== server.limits.ramMb || disk !== server.limits.diskMb || cpu !== server.limits.cpuPct;
  const field = (id: string, label: string, v: number, set: (n: number) => void, max: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" value={Number.isNaN(v) ? "" : v} onChange={(e) => (set(e.target.value === "" ? NaN : Number(e.target.value)), save.reset())} />
      <p className="text-xs text-muted-foreground">{t.remaining(String(max))}</p>
    </div>
  );
  return (
    <Card data-testid="own-limits">
      <CardHeader>
        <CardTitle className="text-base">{t.limitsTitle}</CardTitle>
        <CardDescription>{t.limitsDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate({ uuid: server.uuid, limits: { ramMb: ram, diskMb: disk, cpuPct: cpu } });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {field("limit-ram", t.ram, ram, setRam, room.ram)}
            {field("limit-disk", t.disk, disk, setDisk, room.disk)}
            {field("limit-cpu", t.cpu, cpu, setCpu, room.cpu)}
          </div>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.limitsSaved}
            </p>
          )}
          <Button type="submit" disabled={!valid || !changed || save.isPending}>
            {save.isPending && <Spinner />} {all.common.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Eigen server verwijderen; de naam moet worden overgetypt. */
export function DeleteOwnCard({ server }: { server: ServerDetail }) {
  const t = useT().quota;
  const router = useRouter();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const del = trpc.servers.deleteOwn.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.servers.list.invalidate(), utils.account.quota.invalidate()]);
      router.push("/");
    },
  });
  return (
    <Card className="border-destructive/40" data-testid="delete-own">
      <CardHeader>
        <CardTitle className="text-base">{t.deleteTitle}</CardTitle>
        <CardDescription>{t.deleteDescription}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name === server.name) del.mutate({ uuid: server.uuid, confirmName: name });
          }}
        >
          <Label htmlFor="delete-confirm">{t.deleteConfirm(server.name)}</Label>
          <Input id="delete-confirm" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          {del.error && <p className="text-sm text-destructive">{errorText(del.error)}</p>}
          <Button type="submit" variant="destructive" disabled={name !== server.name || del.isPending}>
            {del.isPending && <Spinner />} {t.deleteButton}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
