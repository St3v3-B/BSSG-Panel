import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc-provider";
import { BrandingEffect } from "@/app/_components/branding";
import { LocaleProvider } from "@/app/_lib/i18n";
import { LOCALE_COOKIE, parseLocale } from "@/app/_lib/i18n/config";
import "./globals.css";

// De panelnaam (auth.branding) zet de client in de tabtitel, zie _hooks/use-document-title.ts.
export const metadata = { title: "Panel" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Taal uit de cookie panel_locale; zonder cookie Engels.
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <TRPCProvider>
          <LocaleProvider initial={locale}>
            <BrandingEffect />
            {children}
          </LocaleProvider>
        </TRPCProvider>
      </body>
    </html>
  );
}
