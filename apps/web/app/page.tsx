"use client";
// Fase 0: lege pagina die laat zien dat de tRPC-keten (mock) werkt. panel-ui vervangt dit.
import { trpc } from "@/lib/trpc";

export default function Home() {
  const branding = trpc.auth.branding.useQuery();
  const servers = trpc.servers.list.useQuery();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold" data-testid="panel-name">
        {branding.data?.panelName ?? "…"}
      </h1>
      <ul className="mt-6 space-y-2" data-testid="server-list">
        {servers.data?.map((s) => (
          <li key={s.uuid} className="rounded-md border border-border bg-card p-3">
            {s.name} <span className="text-muted-foreground">· {s.status}</span>
          </li>
        ))}
        {servers.error && <li className="text-destructive">{servers.error.message}</li>}
      </ul>
    </main>
  );
}
