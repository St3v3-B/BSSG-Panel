import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { errorText } from "@/app/_lib/errors";

export function QueryError({ error, title = "Laden mislukt" }: { error: unknown; title?: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <div>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{errorText(error)}</AlertDescription>
      </div>
    </Alert>
  );
}
