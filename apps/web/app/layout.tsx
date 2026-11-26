import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc-provider";
import { BrandingEffect } from "@/app/_components/branding";
import "./globals.css";

// De panelnaam (auth.branding) zet de client in de tabtitel, zie _hooks/use-document-title.ts.
export const metadata = { title: "Panel" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="nl" className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <TRPCProvider>
          <BrandingEffect />
          {children}
        </TRPCProvider>
      </body>
    </html>
  );
}
