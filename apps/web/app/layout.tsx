import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { TRPCProvider } from "@/lib/trpc-provider";
import { BrandingEffect } from "@/app/_components/branding";
import { THEME_SCRIPT } from "@/app/_lib/theme-script";
import { LocaleProvider } from "@/app/_lib/i18n";
import { LOCALE_COOKIE, parseLocale } from "@/app/_lib/i18n/config";
import "./globals.css";

// De panelnaam (auth.branding) zet de client in de tabtitel, zie _hooks/use-document-title.ts.
export const metadata: Metadata = { title: "Panel", applicationName: "BSSG Panel", appleWebApp: { capable: true, title: "Panel", statusBarStyle: "black-translucent" } };
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0f0e1a" },
    { media: "(prefers-color-scheme: light)", color: "#f6f5fb" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Taal uit de cookie panel_locale; zonder cookie Engels.
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <div className="app-bg" aria-hidden>
          <i />
          <i />
        </div>
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
