"use client";
import { ALL_PERMISSIONS, type Permission } from "@panel/api/schemas";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { cn } from "@/lib/utils";
import { getT, useT } from "@/app/_lib/i18n";

/** Naam en uitleg van een recht in de huidige taal. */
export const permissionLabel = (p: Permission) => getT().permissions[p];

/** Vinkjes per recht, in de volgorde van het contract. */
export function PermissionPicker({ value, onChange, idPrefix, disabled }: { value: Permission[]; onChange: (v: Permission[]) => void; idPrefix: string; disabled?: boolean }) {
  const t = useT();
  const set = new Set(value);
  const all = ALL_PERMISSIONS.every((p) => set.has(p));
  const toggle = (p: Permission) => {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    // lezen hoort bij schrijven
    if (p === "files.write" && next.has("files.write")) next.add("files.read");
    if (p === "console.write" && next.has("console.write")) next.add("console.read");
    // een shell kan alle bestanden lezen en schrijven
    if (p === "terminal" && next.has("terminal")) (next.add("files.read"), next.add("files.write"));
    onChange(ALL_PERMISSIONS.filter((x) => next.has(x)));
  };
  return (
    <div className="space-y-2" data-testid="permission-picker">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={all} disabled={disabled} onChange={() => onChange(all ? [] : [...ALL_PERMISSIONS])} /> {t.permissions.all}
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {ALL_PERMISSIONS.map((p) => (
          <label
            key={p}
            htmlFor={`${idPrefix}-${p}`}
            className={cn("flex cursor-pointer items-start gap-2 rounded-md border border-border p-2.5 text-sm", set.has(p) && "border-primary/50 bg-primary/5")}
          >
            <Checkbox id={`${idPrefix}-${p}`} className="mt-0.5" checked={set.has(p)} disabled={disabled} onChange={() => toggle(p)} />
            <span>
              <span className="block font-medium">{t.permissions[p].label}</span>
              <span className="block text-xs text-muted-foreground">{t.permissions[p].hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
