"use client";
import type { ReactNode } from "react";
import { AppShell } from "@/app/_components/app-shell";
import { AuthGate } from "@/app/_components/auth-gate";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      {(me) => (
        <AppShell me={me}>{children}</AppShell>
      )}
    </AuthGate>
  );
}
