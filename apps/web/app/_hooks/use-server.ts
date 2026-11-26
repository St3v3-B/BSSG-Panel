"use client";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc";

/** De server van de huidige route (/servers/[uuid]/…); gedeeld via de react-query-cache. */
export function useServer() {
  const { uuid } = useParams<{ uuid: string }>();
  const query = trpc.servers.get.useQuery({ uuid }, { retry: false, staleTime: 10_000 });
  return { uuid, ...query };
}
