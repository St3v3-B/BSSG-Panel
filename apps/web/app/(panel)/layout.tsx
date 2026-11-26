"use client";
import type { ReactNode } from "react";
import { AppHeader } from "@/app/_components/app-header";
import { AuthGate } from "@/app/_components/auth-gate";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      {(me) => (
        <div className="flex min-h-screen flex-col">
          <AppHeader me={me} />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
        </div>
      )}
    </AuthGate>
  );
}
