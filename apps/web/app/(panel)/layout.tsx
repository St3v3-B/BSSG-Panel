"use client";
import type { ReactNode } from "react";
import { AppHeader } from "@/app/_components/app-header";
import { AuthGate } from "@/app/_components/auth-gate";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      {(me) => (
        <div className="flex min-h-dvh flex-col">
          <AppHeader me={me} />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">{children}</main>
        </div>
      )}
    </AuthGate>
  );
}
