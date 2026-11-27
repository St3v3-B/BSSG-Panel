"use client";
import { Database, ExternalLink, RotateCw } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Spinner } from "@/app/_components/ui/spinner";
import { usePhpMyAdmin } from "@/app/_hooks/use-phpmyadmin";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/**
 * phpMyAdmin ingebed in het panel (zelfde domein, /phpmyadmin/ via Caddy). Bij binnenkomst een eenmalige
 * sign-on; verloopt de phpMyAdmin-sessie, dan meldt panel-return.js dat via postMessage en loggen we opnieuw in.
 * Het thema volgt de keuze van het panel (panel-theme.js in phpMyAdmin leest dezelfde localStorage).
 */
export default function DatabasesPage() {
  return (
    <Suspense>
      <PhpMyAdminFrame />
    </Suspense>
  );
}

function PhpMyAdminFrame() {
  const t = useT();
  const router = useRouter();
  const db = useSearchParams()?.get("db") ?? null;
  const pma = usePhpMyAdmin();
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  const signIn = pma.signIn;

  const load = useCallback(
    async (target: string | null) => {
      setError(null);
      setLoaded(false);
      try {
        setSrc(await signIn(target));
      } catch (e) {
        setError(e);
      }
    },
    [signIn],
  );

  // Eén keer inloggen per bezoek (het token is eenmalig; StrictMode draait effecten dubbel).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load(db);
  }, [db, load]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { source?: string; action?: string } | null;
      if (d?.source !== "panel-pma") return;
      if (d.action === "reauth") void load(null);
      else if (d.action === "logout") router.push("/");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [load, router]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="phpmyadmin-page">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Database className="size-5 text-primary" aria-hidden /> phpMyAdmin
        </h1>
        <div className="flex items-center gap-2">
          {pma.info?.hasRemoteDatabases && <span className="hidden text-xs text-warning lg:inline">{t.phpmyadmin.navRemote}</span>}
          <Button size="sm" variant="ghost" onClick={() => void load(null)} disabled={pma.pending} data-testid="phpmyadmin-reload">
            <RotateCw /> {t.phpmyadmin.reload}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void pma.open(db)} disabled={pma.pending} data-testid="phpmyadmin-newtab">
            <ExternalLink /> {t.phpmyadmin.openTab}
          </Button>
        </div>
      </div>
      <Card className="relative min-h-[24rem] flex-1 overflow-hidden p-0">
        {error != null || pma.error != null ? (
          <div role="alert" className="grid h-full place-items-center p-6 text-center text-sm text-destructive">
            {errorText(error ?? pma.error)}
          </div>
        ) : (
          <>
            {src && (
              <iframe
                ref={frame}
                src={src}
                title={t.phpmyadmin.frameTitle}
                className="absolute inset-0 size-full border-0 bg-background"
                onLoad={() => setLoaded(true)}
                data-testid="phpmyadmin-frame"
              />
            )}
            {!loaded && (
              <div className="absolute inset-0 grid place-items-center bg-card" aria-live="polite">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner /> {t.phpmyadmin.loading}
                </span>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
