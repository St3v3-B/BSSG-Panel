"use client";
import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc";

/** Database-namen die signon.php accepteert voor een directe sprong (zelfde regel als daar). */
export const PMA_DB_RE = /^[A-Za-z0-9_]{1,64}$/;

/** Eenmalige sign-on-URL (relatief), optioneel direct naar een database. */
export function pmaUrl(rel: string, db?: string | null) {
  return db && PMA_DB_RE.test(db) ? `${rel}&db=${encodeURIComponent(db)}` : rel;
}

/**
 * phpMyAdmin met single sign-on. `signIn` geeft een eenmalige URL (voor de ingebedde weergave op /databases);
 * `open` opent phpMyAdmin los in een nieuw tabblad. Om popup-blokkers te omzeilen openen we dat tabblad
 * synchroon (binnen de klik) en zetten we daarna pas de locatie.
 */
export function usePhpMyAdmin() {
  const info = trpc.databases.phpMyAdminInfo.useQuery(undefined, { staleTime: 60_000, retry: false });
  const mutation = trpc.databases.phpMyAdminUrl.useMutation();
  const [error, setError] = useState<unknown>(null);
  const signIn = useCallback(
    async (db?: string | null) => {
      const { url } = await mutation.mutateAsync();
      return pmaUrl(url, db);
    },
    [mutation],
  );
  const open = useCallback(
    async (db?: string | null) => {
      setError(null);
      const win = window.open("about:blank", "_blank");
      try {
        // Absoluut maken t.o.v. het panel: het nieuwe tabblad staat nog op about:blank.
        const url = new URL(await signIn(db), window.location.origin).toString();
        if (win && !win.closed) {
          win.opener = null;
          win.location.href = url;
        } else {
          // Geblokkeerd: dan in dit tabblad verder (het token blijft 60 s geldig).
          window.location.assign(url);
        }
      } catch (e) {
        win?.close();
        setError(e);
      }
    },
    [signIn],
  );
  return { info: info.data ?? null, infoLoading: info.isLoading, open, signIn, pending: mutation.isPending, error };
}
