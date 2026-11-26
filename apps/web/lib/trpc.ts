"use client";
/**
 * tRPC-client voor de UI. Gebruik: `import { trpc } from "@/lib/trpc"` en dan
 * `trpc.servers.list.useQuery()`. Typen komen rechtstreeks uit het contract.
 * Eigenaar: orchestrator (skelet).
 */
import type { AppRouter } from "@panel/api";
import { createTRPCReact } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
