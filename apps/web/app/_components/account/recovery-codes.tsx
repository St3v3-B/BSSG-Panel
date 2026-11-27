"use client";
import { Download, KeyRound, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { isTotpCode, TotpCodeInput } from "@/app/_components/totp-code-input";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Eenmalige weergave van nieuwe herstelcodes. */
export function RecoveryCodesList({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const text = codes.join("\n");
  const download = () => {
    const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <Alert variant="warning">
        <TriangleAlert />
        <div>
          <AlertTitle>{t.account.recoveryShownTitle}</AlertTitle>
          <AlertDescription>{t.account.recoveryShownText}</AlertDescription>
        </div>
      </Alert>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border bg-muted/40 p-3 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c} data-testid="recovery-code">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 text-sm">
          <CopyButton value={text} label={t.account.recoveryCopy} /> {t.account.recoveryCopy}
        </span>
        <Button variant="outline" size="sm" onClick={download}>
          <Download /> {t.account.recoveryDownload}
        </Button>
        <Button size="sm" onClick={onDone} data-testid="recovery-saved">
          {t.account.recoverySaved}
        </Button>
      </div>
    </div>
  );
}

/** Aantal overgebleven codes en opnieuw genereren (vraagt een geldige TOTP-code). */
export function RecoveryCodesCard() {
  const t = useT();
  const utils = trpc.useUtils();
  const status = trpc.account.recoveryCodesStatus.useQuery();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [fresh, setFresh] = useState<string[] | null>(null);
  const regen = trpc.account.regenerateRecoveryCodes.useMutation({
    onSuccess: async (r) => {
      setFresh(r.recoveryCodes);
      setOpen(false);
      setCode("");
      await utils.account.recoveryCodesStatus.invalidate();
    },
    onError: () => setCode(""),
  });
  const left = status.data?.remaining;

  return (
    <div className="mt-6 space-y-3 border-t border-border pt-5" data-testid="recovery-card">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-muted-foreground" /> {t.account.recoveryTitle}
      </div>
      <p className="text-sm text-muted-foreground">{t.account.recoveryText}</p>
      {left !== undefined && (
        <p className="text-sm" data-testid="recovery-left">
          {t.account.recoveryLeft(left, status.data!.total)}
        </p>
      )}
      {left !== undefined && left <= 2 && (
        <Alert variant="warning" data-testid="recovery-low">
          <TriangleAlert />
          <div>
            <AlertTitle>{t.account.recoveryLowTitle}</AlertTitle>
            <AlertDescription>{t.account.recoveryLowText}</AlertDescription>
          </div>
        </Alert>
      )}
      {fresh ? (
        <RecoveryCodesList codes={fresh} onDone={() => setFresh(null)} />
      ) : open ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (isTotpCode(code)) regen.mutate({ code });
          }}
        >
          <Label htmlFor="recovery-regen-code">{t.account.currentCode}</Label>
          <TotpCodeInput id="recovery-regen-code" value={code} onChange={setCode} autoFocus disabled={regen.isPending} invalid={!!regen.error} className="max-w-48" />
          <p className="text-xs text-muted-foreground">{t.account.recoveryRegenWarn}</p>
          {regen.error && <p className="text-sm text-destructive">{errorText(regen.error)}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={!isTotpCode(code) || regen.isPending}>
              {regen.isPending && <Spinner />} {t.account.recoveryRegenerate}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)} data-testid="recovery-regen-open">
          {t.account.recoveryRegenerate}
        </Button>
      )}
    </div>
  );
}
