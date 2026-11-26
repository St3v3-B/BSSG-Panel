import { CircleAlert, HardDrive } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { errorText, isDiskExceeded, isForbidden } from "@/app/_lib/errors";

/** Fout van een bestandsactie; schijf vol en ontbrekende rechten krijgen een eigen titel. */
export function FileActionError({ error, text, onDismiss }: { error?: unknown; text?: string; onDismiss?: () => void }) {
  const disk = text ? /schijf.*vol/i.test(text) : isDiskExceeded(error);
  const title = disk ? "Schijf vol" : !text && isForbidden(error) ? "Geen rechten" : "Actie mislukt";
  return (
    <Alert variant="destructive" data-testid={disk ? "disk-exceeded" : "file-error"}>
      {disk ? <HardDrive /> : <CircleAlert />}
      <div className="flex-1">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{text ?? errorText(error)}</AlertDescription>
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-xs underline-offset-2 hover:underline">
          Sluiten
        </button>
      )}
    </Alert>
  );
}
