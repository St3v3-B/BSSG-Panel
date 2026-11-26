import { CircleAlert, HardDrive } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { errorText, isDiskExceeded, isForbidden } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Fout van een bestandsactie; schijf vol en ontbrekende rechten krijgen een eigen titel. */
export function FileActionError({ error, text, onDismiss }: { error?: unknown; text?: string; onDismiss?: () => void }) {
  const t = useT();
  const disk = text ? text === t.files.uploadDisk : isDiskExceeded(error);
  const title = disk ? t.files.errDisk : !text && isForbidden(error) ? t.files.errForbidden : t.files.errAction;
  return (
    <Alert variant="destructive" data-testid={disk ? "disk-exceeded" : "file-error"}>
      {disk ? <HardDrive /> : <CircleAlert />}
      <div className="flex-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{text ?? errorText(error)}</AlertDescription>
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-xs underline-offset-2 hover:underline">
          {t.common.close}
        </button>
      )}
    </Alert>
  );
}
