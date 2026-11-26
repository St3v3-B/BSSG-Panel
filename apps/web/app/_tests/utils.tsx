/** Testhulp: rendert componenten met een echte tRPC-client tegen een verse mock (in-process). */
import { buildRouter, type Implementation, type SessionCtx } from "@panel/api";
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

/** `patch` kan procedures van de mock vervangen, bv. om een fout als DISK_EXCEEDED na te bootsen. */
export function renderWithTrpc(ui: ReactElement, opts: { session: SessionCtx | null; patch?: (mock: Implementation) => void }) {
  const mock = createMock();
  opts.patch?.(mock);
  const router = buildRouter(mock);
  const calls: string[] = [];
  const bodies: Array<{ path: string; input: unknown }> = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: "http://panel.test/api/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const req = new Request(String(url), init as RequestInit);
          const path = new URL(req.url).pathname.replace("/api/trpc/", "");
          calls.push(path);
          if (req.method === "POST") {
            const raw = JSON.parse(await req.clone().text()) as Record<string, { json: unknown }>;
            path.split(",").forEach((p, i) => bodies.push({ path: p, input: superjson.deserialize(raw[String(i)] as never) }));
          }
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
  return { ...result, calls, bodies, queryClient };
}
