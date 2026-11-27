"use client";
import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc";

/**
 * phpMyAdmin openen met single sign-on. De mutation geeft een eenmalige URL; om popup-blokkers te omzeilen
 * openen we eerst synchroon (binnen de klik) een leeg tabblad en zetten daarna pas de locatie.
 */
export function usePhpMyAdmin() {
  const info = trpc.databases.phpMyAdminInfo.useQuery(undefined, { staleTime: 60_000, retry: false });
  const mutation = trpc.databases.phpMyAdminUrl.useMutation();
  const [error, setError] = useState<unknown>(null);
  const open = useCallback(async () => {
    setError(null);
    const win = window.open("about:blank", "_blank");
    try {
      const { url } = await mutation.mutateAsync();
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
  }, [mutation]);
  return { info: info.data ?? null, open, pending: mutation.isPending, error };
}
