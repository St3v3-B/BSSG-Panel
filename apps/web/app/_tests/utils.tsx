/** Testhulp: rendert componenten met een echte tRPC-client tegen een verse mock (in-process). */
import { buildRouter, type SessionCtx } from "@panel/api";
import { createMock, mockSession, type MockRole } from "@panel/api/mock";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { ReactElement } from "react";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

export function sessionFor(role: MockRole, patch: Partial<SessionCtx> = {}): SessionCtx | null {
  const s = mockSession(role);
  return s ? { ...s, ...patch } : null;
}

export function renderWithTrpc(ui: ReactElement, opts: { session: SessionCtx | null }) {
  const router = buildRouter(createMock());
  const calls: string[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: "http://panel.test/api/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const req = new Request(String(url), init as RequestInit);
          calls.push(new URL(req.url).pathname.replace("/api/trpc/", ""));
          return fetchRequestHandler({
            endpoint: "/api/trpc",
            req,
            router,
            createContext: ({ resHeaders }) => ({ session: opts.session, ip: null, userAgent: null, resHeaders }),
          });
        },
      }),
    ],
  });
  const result = render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
  return { ...result, calls, queryClient };
}
