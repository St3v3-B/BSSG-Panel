// Eigenaar: orchestrator (skelet). Auth en context zitten in server/.
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, contextFor } from "@/lib/router";

export const dynamic = "force-dynamic";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: ({ resHeaders }) => contextFor(req, resHeaders),
    onError: ({ error, path }) => {
      if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[trpc] ${path}:`, error);
    },
  });

export { handler as GET, handler as POST };
