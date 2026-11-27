"use client";
import { Activity, Check, FileCode2, Languages, LayoutDashboard, LogOut, Menu, Server, Settings, Shield, User, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Me } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/app/_components/branding";
import { Dialog, DialogClose, DialogDescription, DialogTitle, DialogTrigger, SheetContent } from "@/app/_components/ui/dialog";
import { ThemeToggle } from "@/app/_components/theme";
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
import { LOCALE_NAME, LocaleSwitcher } from "@/app/_components/locale-switcher";
import { LOCALES, useLocale, useT } from "@/app/_lib/i18n";

const ADMIN_ICON = { nodes: Server, users: Users, templates: FileCode2, activity: Activity, settings: Settings } as const;

interface NavItem {
  href: string;
  label: string;
  active: boolean;
  icon: ComponentType<{ className?: string }>;
}

function useNav(me: Me) {
  const pathname = usePathname() ?? "/";
  const t = useT();
  const inAdmin = me.isAdmin && (pathname === "/admin" || pathname.startsWith("/admin/"));
  const user: NavItem[] = [{ href: "/", label: t.nav.myServers, active: pathname === "/" || pathname.startsWith("/servers"), icon: Server }];
  const admin: NavItem[] = [
    { href: "/admin", label: t.admin2.nav.dashboard, active: pathname === "/admin", icon: LayoutDashboard },
    { href: "/admin/servers", label: t.admin2.nav.servers, active: pathname.startsWith("/admin/servers"), icon: Server },
    ...(["nodes", "users", "templates", "activity", "settings"] as const).map((k) => ({
      href: `/admin/${k}`,
      label: t.admin2.nav[k],
      active: pathname.startsWith(`/admin/${k}`),
      icon: ADMIN_ICON[k],
    })),
  ];
  return { pathname, inAdmin, user, admin };
}

export function AppHeader({ me }: { me: Me }) {
  const t = useT();
  const { inAdmin, user, admin } = useNav(me);
  return (
    <header className="pt-safe sticky top-0 z-40 border-b border-border bg-background/75 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-3 sm:gap-4 sm:px-6">
        <MobileNav me={me} />
        <Link href={inAdmin ? "/admin" : "/"} className="flex min-w-0 items-center gap-2" aria-label={t.nav.toOverview}>
          <BrandMark className="max-w-[10.5rem] sm:max-w-none" />
          {inAdmin && <Badge variant="warning" className="hidden sm:inline-flex">Admin</Badge>}
        </Link>
        <nav className="scrollbar-none ml-2 hidden items-center gap-1 overflow-x-auto text-sm md:flex">
          {(inAdmin ? admin : user).map((n) => (
            <NavLink key={n.href} href={n.href} active={n.active}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {me.isAdmin && (
            <Button asChild variant="outline" size="sm" className="hidden md:inline-flex" data-testid="admin-toggle">
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
          <ThemeToggle className="hidden md:grid" />
          <UserMenu me={me} />
        </div>
      </div>
    </header>
  );
}

/** Uitschuifbare navigatielade voor schermen onder md. */
function MobileNav({ me }: { me: Me }) {
  const t = useT();
  const { pathname, user, admin } = useNav(me);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const logout = trpc.auth.logout.useMutation({ onSettled: () => window.location.assign("/login") });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="-ml-1 md:hidden" aria-label={t.nav.menu} data-testid="nav-open">
          <Menu className="size-5" />
        </Button>
      </DialogTrigger>
      <SheetContent data-testid="nav-drawer">
        <DialogTitle className="sr-only">{t.nav.menu}</DialogTitle>
        <DialogDescription className="sr-only">{t.nav.menu}</DialogDescription>
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <BrandMark />
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t.nav.closeMenu}>
              <X className="size-5" />
            </Button>
          </DialogClose>
        </div>
        <nav className="flex-1 space-y-6 overflow-y-auto p-3" aria-label={t.nav.menu}>
          <DrawerSection title={t.nav.panelSection} items={user} />
          {me.isAdmin && <DrawerSection title={t.nav.adminSection} items={admin} />}
          <div className="space-y-1">
            <DrawerLink href="/account" active={pathname === "/account"} icon={User} label={t.nav.account} />
          </div>
        </nav>
        <div className="space-y-3 border-t border-border p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">{t.theme.label}</span>
            <ThemeToggle className="md:grid" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Languages className="size-4" /> {t.common.language}
            </span>
            <LocaleSwitcher />
          </div>
          <Button variant="outline" className="w-full" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut /> {t.nav.logout}
          </Button>
        </div>
      </SheetContent>
    </Dialog>
  );
}

function DrawerSection({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <div className="space-y-1">
      <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</div>
      {items.map((n) => (
        <DrawerLink key={n.href} href={n.href} active={n.active} icon={n.icon} label={n.label} />
      ))}
    </div>
  );
}

function DrawerLink({ href, active, icon: Icon, label }: { href: string; active: boolean; icon: NavItem["icon"]; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
        active ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-accent",
      )}
    >
      <Icon className="size-4.5" /> {label}
    </Link>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={cn("whitespace-nowrap rounded-lg px-3 py-1.5 transition-colors", active ? "bg-primary/12 font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
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
        <Button variant="ghost" className="h-10 gap-2 px-1.5 sm:px-2 md:h-9" aria-label={t.nav.userMenu} data-testid="user-menu">
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
