"use client";
import { Lock } from "lucide-react";
import { Card } from "@/app/_components/ui/card";
import { useT } from "@/app/_lib/i18n";

/** Getoond als de gebruiker een onderdeel van de server niet mag zien. */
export function NoPermission({ children }: { children: React.ReactNode }) {
  return (
    <Card className="grid min-h-48 place-items-center p-6 text-center text-sm text-muted-foreground" data-testid="no-permission">
      <div className="max-w-md space-y-2">
        <Lock className="mx-auto size-6" />
        <p>{children}</p>
        <p className="text-xs">{useT().server.askOwner}</p>
      </div>
    </Card>
  );
}
