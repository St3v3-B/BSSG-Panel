"use client";
import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export function QueryError({ error, title }: { error: unknown; title?: string }) {
  const t = useT();
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <div>
        <AlertTitle>{title ?? t.common.loadFailed}</AlertTitle>
        <AlertDescription>{errorText(error)}</AlertDescription>
      </div>
    </Alert>
  );
}
