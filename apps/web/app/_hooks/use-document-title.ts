"use client";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

/** Zet de tabtitel op "<pagina> · <panelnaam>" (panelnaam uit auth.branding). `null` = niets doen. */
export function useDocumentTitle(page?: string | null) {
  const branding = trpc.auth.branding.useQuery(undefined, { staleTime: 60_000 });
  const name = branding.data?.panelName;
  useEffect(() => {
    if (!name || page === null) return;
    document.title = page ? `${page} · ${name}` : name;
  }, [page, name]);
}
