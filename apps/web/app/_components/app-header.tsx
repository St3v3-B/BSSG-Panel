"use client";
import { Check, Languages, LayoutDashboard, LogOut, Shield, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import type { Me } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/app/_components/branding";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/_components/ui/dropdown-menu";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { LOCALE_NAME } from "@/app/_components/locale-switcher";
import { LOCALES, useLocale, useT } from "@/app/_lib/i18n";

export function AppHeader({ me }: { me: Me }) {
  const pathname = usePathname() ?? "/";
  const t = useT();
  const inAdmin = me.isAdmin && (pathname === "/admin" || pathname.startsWith("/admin/"));
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href={inAdmin ? "/admin" : "/"} className="flex items-center gap-2" aria-label={t.nav.toOverview}>
          <BrandMark />
          {inAdmin && <Badge variant="warning">Admin</Badge>}
        </Link>
        <nav className="ml-2 hidden items-center gap-1 overflow-x-auto text-sm sm:flex">
          {inAdmin ? (
            <>
              <NavLink href="/admin" active={pathname === "/admin" || pathname.startsWith("/admin/servers")}>
                {t.admin.nav.servers}
              </NavLink>
              {(["nodes", "users", "templates", "activity"] as const).map((k) => (
                <NavLink key={k} href={`/admin/${k}`} active={pathname.startsWith(`/admin/${k}`)}>
                  {t.admin.nav[k]}
                </NavLink>
              ))}
            </>
          ) : (
            <NavLink href="/" active={pathname === "/" || pathname.startsWith("/servers")}>
              {t.nav.myServers}
            </NavLink>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {me.isAdmin && (
            <Button asChild variant="outline" size="sm" data-testid="admin-toggle">
              {inAdmin ? (
                <Link href="/">
                  <LayoutDashboard /> {t.nav.userSide}
                </Link>
              ) : (
                <Link href="/admin">
                  <Shield /> {t.nav.admin}
                </Link>
              )}
            </Button>
          )}
          <UserMenu me={me} />
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cn("rounded-md px-3 py-1.5 transition-colors", active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </Link>
  );
}

function UserMenu({ me }: { me: Me }) {
  const { t, locale, setLocale } = useLocale();
  const logout = trpc.auth.logout.useMutation({
    // volledige reload: wist alle gecachte queries
    onSettled: () => window.location.assign("/login"),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2" aria-label={t.nav.userMenu} data-testid="user-menu">
          <UserAvatar user={me.user} className="size-7" />
          <span className="hidden max-w-40 truncate text-sm sm:inline">{displayName(me.user)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <div className="font-medium">{displayName(me.user)}</div>
          <div className="text-xs font-normal text-muted-foreground">
            {me.isOwner ? t.nav.roleOwner : me.isAdmin ? t.nav.roleAdmin : t.nav.roleUser}
            {" · "}
            {me.totpEnabled ? t.nav.totpOn : t.nav.totpOff}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <User /> {t.nav.account}
          </Link>
        </DropdownMenuItem>
        {me.isAdmin && (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <Shield /> {t.nav.admin}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
          <Languages className="size-3.5" /> {t.common.language}
        </DropdownMenuLabel>
        {LOCALES.map((l) => (
          <DropdownMenuItem key={l} lang={l} onSelect={() => locale !== l && setLocale(l)} data-testid={`locale-${l}`}>
            <Check className={locale === l ? "opacity-100" : "opacity-0"} /> {LOCALE_NAME[l]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logout.mutate()} disabled={logout.isPending} data-testid="logout">
          <LogOut /> {t.nav.logout}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
