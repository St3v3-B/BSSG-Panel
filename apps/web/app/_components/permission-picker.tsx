"use client";
import { ALL_PERMISSIONS, type Permission } from "@panel/api/schemas";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { cn } from "@/lib/utils";

export const PERMISSION_LABEL: Record<Permission, { label: string; hint: string }> = {
  "console.read": { label: "Console bekijken", hint: "Console en live verbruik zien" },
  "console.write": { label: "Commando's sturen", hint: "Commando's in de console typen" },
  power: { label: "Starten en stoppen", hint: "Start, stop, herstart en kill" },
  "files.read": { label: "Bestanden lezen", hint: "Bestanden bekijken en downloaden, ook via SFTP" },
  "files.write": { label: "Bestanden wijzigen", hint: "Uploaden, bewerken, verwijderen, ook via SFTP" },
  "backup.create": { label: "Backups maken", hint: "Backups maken en verwijderen" },
  "backup.restore": { label: "Backups terugzetten", hint: "Een backup terugzetten (overschrijft data)" },
  "database.manage": { label: "Databases", hint: "Databases aanmaken en wachtwoorden zien" },
  "domain.manage": { label: "Domeinen", hint: "Domeinen koppelen en DNS controleren" },
  "schedule.manage": { label: "Schema's", hint: "Geplande taken beheren" },
};

/** Vinkjes per recht, in de volgorde van het contract. */
export function PermissionPicker({ value, onChange, idPrefix, disabled }: { value: Permission[]; onChange: (v: Permission[]) => void; idPrefix: string; disabled?: boolean }) {
  const set = new Set(value);
  const all = ALL_PERMISSIONS.every((p) => set.has(p));
  const toggle = (p: Permission) => {
    const next = new Set(set);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    // lezen hoort bij schrijven
    if (p === "files.write" && next.has("files.write")) next.add("files.read");
    if (p === "console.write" && next.has("console.write")) next.add("console.read");
    onChange(ALL_PERMISSIONS.filter((x) => next.has(x)));
  };
  return (
    <div className="space-y-2" data-testid="permission-picker">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={all} disabled={disabled} onChange={() => onChange(all ? [] : [...ALL_PERMISSIONS])} /> Alles
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
              <span className="block font-medium">{PERMISSION_LABEL[p].label}</span>
              <span className="block text-xs text-muted-foreground">{PERMISSION_LABEL[p].hint}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
