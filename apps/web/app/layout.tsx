import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc-provider";
import "./globals.css";

export const metadata = { title: "Panel" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="nl" className="dark">
      <body className="min-h-screen antialiased">
        <TRPCProvider>{children}</TRPCProvider>
      </body>
    </html>
  );
}
