"use client";
import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { FileEntry } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { FileActionError } from "@/app/_components/files/file-action-error";
import { Button } from "@/app/_components/ui/button";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { Input } from "@/app/_components/ui/input";
import { Spinner } from "@/app/_components/ui/spinner";
import { hasSpecialBits, isValidMode, modeHasBit, modeToOctal, modeToString, toggleModeBit } from "@/app/_lib/files";
import { useT } from "@/app/_lib/i18n";

/** Rechtendialoog voor één of meer items: octaal of met vinkjes, optioneel recursief. */
export function ChmodDialog({ uuid, entries, onClose, onDone }: { uuid: string; entries: FileEntry[]; onClose: () => void; onDone: (changed: number) => void }) {
  const t = useT();
  const first = entries[0]!;
  const firstDir = entries.find((e) => e.isDirectory);
  const firstFile = entries.find((e) => !e.isDirectory);
  const anyDir = !!firstDir;
  const [mode, setMode] = useState(() => modeToOctal(first.mode));
  const [dirMode, setDirMode] = useState(() => (firstDir ? modeToOctal(firstDir.mode) : "755"));
  const [recursive, setRecursive] = useState(false);
  const [confirmSpecial, setConfirmSpecial] = useState(false);
  const [touched, setTouched] = useState(false);
  const chmod = trpc.files.chmod.useMutation({ onSuccess: (r) => onDone(r.changed) });

  // Recursief: bestanden krijgen `mode`, mappen `dirMode`. Anders krijgt alles `mode`.
  const fileMode = mode;
  const toggleRecursive = (on: boolean) => {
    setRecursive(on);
    // Begint de selectie met een map, dan stond de modus van die map in het eerste veld.
    if (first.isDirectory) {
      setDirMode(on ? mode : dirMode);
      setMode(on ? (firstFile ? modeToOctal(firstFile.mode) : "644") : dirMode);
    }
  };
  const effectiveDir = recursive ? dirMode : mode;
  const special = hasSpecialBits(fileMode) || hasSpecialBits(effectiveDir);
  const valid = isValidMode(fileMode) && isValidMode(effectiveDir);
  const title = entries.length === 1 ? t.files.chmodTitle(first.name) : t.files.chmodTitle(t.files.chmodItems(entries.length));

  function submit(ev: FormEvent) {
    ev.preventDefault();
    setTouched(true);
    if (!valid || (special && !confirmSpecial)) return;
    chmod.mutate({ uuid, paths: entries.map((e) => e.path), mode: fileMode, dirMode: effectiveDir, recursive: anyDir && recursive, allowSpecial: special });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t.common.close} data-testid="chmod-dialog">
        <DialogTitle className="pr-8 text-base font-semibold">{title}</DialogTitle>
        <DialogDescription className="sr-only">{t.files.permissions}</DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-5">
          <ModeEditor label={recursive ? t.files.chmodFiles : undefined} idPrefix="file" value={mode} onChange={setMode} invalid={touched && !isValidMode(mode)} />
          {anyDir && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={recursive} onChange={(e) => toggleRecursive(e.target.checked)} />
              <span>
                {t.files.chmodRecursive}
                {recursive && <span className="block text-xs text-muted-foreground">{t.files.chmodRecursiveHint}</span>}
              </span>
            </label>
          )}
          {anyDir && recursive && <ModeEditor label={t.files.chmodFolders} idPrefix="dir" value={dirMode} onChange={setDirMode} invalid={touched && !isValidMode(dirMode)} />}
          {special && (
            <div className="space-y-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm" data-testid="chmod-special">
              <p className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> {t.files.chmodSpecialWarn}
              </p>
              <label className="flex items-center gap-2">
                <Checkbox checked={confirmSpecial} onChange={(e) => setConfirmSpecial(e.target.checked)} /> {t.files.chmodSpecialConfirm}
              </label>
            </div>
          )}
          {chmod.error && <FileActionError error={chmod.error} />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={chmod.isPending || !valid || (special && !confirmSpecial)}>
              {chmod.isPending && <Spinner />} {t.files.chmodApply}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const WHO = [
  { key: "chmodOwner", shift: 6 },
  { key: "chmodGroup", shift: 3 },
  { key: "chmodOthers", shift: 0 },
] as const;
const WHAT = [
  { key: "chmodRead", bit: 4 },
  { key: "chmodWrite", bit: 2 },
  { key: "chmodExec", bit: 1 },
] as const;
const SPECIAL = [
  { key: "chmodSetuid", bit: 0o4000 },
  { key: "chmodSetgid", bit: 0o2000 },
  { key: "chmodSticky", bit: 0o1000 },
] as const;

/** Octaal veld + vinkjes; beide sturen dezelfde waarde aan. */
export function ModeEditor({ label, idPrefix, value, onChange, invalid }: { label?: string; idPrefix: string; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const t = useT();
  const octalLabel = label ? `${label}: ${t.files.chmodOctal}` : t.files.chmodOctal;
  return (
    <fieldset className="space-y-3">
      {label && <legend className="mb-2 text-sm font-medium">{label}</legend>}
      <div className="flex items-center gap-3">
        <Input
          id={`${idPrefix}-octal`}
          aria-label={octalLabel}
          className="w-24 font-mono"
          inputMode="numeric"
          maxLength={4}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-7]/g, ""))}
          aria-invalid={invalid || undefined}
        />
        <code className="text-sm text-muted-foreground" data-testid={`${idPrefix}-mode-string`}>
          {modeToString(value)}
        </code>
      </div>
      {invalid && <p className="text-xs text-destructive">{t.files.chmodInvalid}</p>}
      <table className="text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th />
            {WHAT.map((w) => (
              <th key={w.key} className="px-3 pb-1 font-normal">
                {t.files[w.key]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((who) => (
            <tr key={who.key}>
              <td className="pr-3 py-1">{t.files[who.key]}</td>
              {WHAT.map((w) => {
                const bit = w.bit << who.shift;
                return (
                  <td key={w.key} className="px-3 py-1 text-center">
                    <Checkbox
                      aria-label={`${label ? `${label}: ` : ""}${t.files[who.key]} ${t.files[w.key].toLowerCase()}`}
                      checked={modeHasBit(value, bit)}
                      onChange={(e) => onChange(toggleModeBit(value, bit, e.target.checked))}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t.files.chmodSpecial}:</span>
        {SPECIAL.map((sp) => (
          <label key={sp.key} className="inline-flex items-center gap-1.5">
            <Checkbox
              aria-label={`${label ? `${label}: ` : ""}${t.files[sp.key]}`}
              checked={modeHasBit(value, sp.bit)}
              onChange={(e) => onChange(toggleModeBit(value, sp.bit, e.target.checked))}
            />
            <span className="font-mono">{t.files[sp.key]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
