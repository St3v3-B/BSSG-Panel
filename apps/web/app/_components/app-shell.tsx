"use client";
import { Check, ChevronRight, Languages, LogOut, Menu, PanelLeftClose, PanelLeftOpen, User, X } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Me } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/app/_components/branding";
import { Dialog, DialogClose, DialogDescription, DialogTitle, DialogTrigger, SheetContent } from "@/app/_components/ui/dialog";
import { ThemeToggle } from "@/app/_components/theme";
import { Button } from "@/app/_components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/app/_components/ui/dropdown-menu";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { LOCALE_NAME, LocaleSwitcher } from "@/app/_components/locale-switcher";
import { useNav, type NavItem, type NavSection } from "@/app/_components/nav-items";
import { LOCALES, useLocale, useT } from "@/app/_lib/i18n";

const COLLAPSE_KEY = "panel.sidebar.collapsed";

/** Paginakader: persistente zijbalk (md en breder), smalle balk bovenaan en uitschuifbare lade op mobiel. */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {}
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {}
      return !c;
    });
  return (
    <div className="flex min-h-dvh">
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-card/40 transition-[width] duration-200 motion-reduce:transition-none md:flex",
          collapsed ? "w-16" : "w-64",
        )}
        data-testid="sidebar"
        data-collapsed={collapsed}
      >
        <SidebarBody me={me} collapsed={collapsed} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar me={me} collapsed={collapsed} onToggle={toggle} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ me, collapsed, onToggle }: { me: Me; collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const { crumbs } = useNav(me.isAdmin);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <header className="pt-safe sticky top-0 z-40 border-b border-border bg-background/75 backdrop-blur-xl">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-6 md:h-12">
        <MobileNav me={me} />
        <Button variant="ghost" size="icon" className="hidden md:inline-flex" onClick={onToggle} aria-label={collapsed ? t.nav.expandSidebar : t.nav.collapseSidebar} aria-expanded={!collapsed} aria-controls="app-sidebar" data-testid="sidebar-toggle">
          <ToggleIcon className="size-4.5" />
        </Button>
        <Link href="/" className="flex min-w-0 items-center md:hidden" aria-label={t.nav.toOverview}>
          <BrandMark className="max-w-[10.5rem]" />
        </Link>
        <nav aria-label={t.nav.breadcrumb} className="hidden min-w-0 md:block">
          <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
                <li className={cn("truncate", i === crumbs.length - 1 && "font-medium text-foreground")} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                  {c}
                </li>
              </Fragment>
            ))}
          </ol>
        </nav>
        <div className="ml-auto flex items-center gap-2 md:hidden">
          <UserMenu me={me} />
        </div>
        <div id="topbar-slot" className="ml-auto hidden items-center gap-2 md:flex" />
      </div>
    </header>
  );
}

/** Inhoud van de zijbalk: ook bij de lade hergebruikt via `inDrawer`. */
function SidebarBody({ me, collapsed, inDrawer = false }: { me: Me; collapsed: boolean; inDrawer?: boolean }) {
  const t = useT();
  const { sections, account } = useNav(me.isAdmin);
  const logout = trpc.auth.logout.useMutation({ onSettled: () => (window.location.assign("/login"), undefined) });
  return (
    <div id={inDrawer ? undefined : "app-sidebar"} className="flex min-h-0 flex-1 flex-col">
      {!inDrawer && (
        <div className={cn("pt-safe flex h-14 shrink-0 items-center border-b border-border md:h-[calc(3rem+1px)]", collapsed ? "justify-center px-2" : "px-4")}>
          <Link href="/" aria-label={t.nav.toOverview} className="flex min-w-0 items-center rounded-lg">
            <BrandMark showName={!collapsed} className="max-w-[10.5rem]" />
          </Link>
        </div>
      )}
      <nav className="scrollbar-none flex-1 space-y-5 overflow-y-auto overflow-x-hidden p-2.5" aria-label={t.nav.menu}>
        {sections.map((s, i) => (
          <Section key={s.id} section={s} first={i === 0} collapsed={collapsed} touch={inDrawer} />
        ))}
        {inDrawer && (
          <ul className="space-y-0.5">
            <NavRow item={account} collapsed={false} touch />
          </ul>
        )}
      </nav>
      <div className="space-y-2 border-t border-border p-2.5">
        {inDrawer ? (
          <div className="space-y-3 p-1.5">
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
        ) : (
          <>
            <div className={cn("flex items-center gap-2", collapsed ? "flex-col" : "justify-between px-1")}>
              <ThemeToggle />
              {!collapsed && <LocaleSwitcher />}
            </div>
            <UserMenu me={me} sidebar collapsed={collapsed} />
          </>
        )}
      </div>
    </div>
  );
}

function Section({ section, first, collapsed, touch }: { section: NavSection; first: boolean; collapsed: boolean; touch: boolean }) {
  const titleId = `nav-sec-${section.id}${touch ? "-m" : ""}`;
  return (
    <div role="group" aria-labelledby={titleId} className="space-y-1">
      <div id={titleId} className={cn("px-3 pb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground", collapsed && "sr-only")}>
        {section.title}
      </div>
      {collapsed && !first && <div className="mx-3 border-t border-border" aria-hidden />}
      <ul className="space-y-0.5">
        {section.items.map((it) => (
          <NavRow key={it.href} item={it} collapsed={collapsed} touch={touch} />
        ))}
      </ul>
    </div>
  );
}

function NavRow({ item, collapsed, touch }: { item: NavItem; collapsed: boolean; touch: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link
        href={item.href}
        aria-current={item.current ? "page" : undefined}
        aria-label={collapsed ? item.label : undefined}
        title={collapsed ? item.label : undefined}
        className={cn(
          "flex items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          touch ? "min-h-11" : "min-h-9",
          collapsed && "justify-center px-0",
          item.active ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-accent",
        )}
      >
        <Icon className="size-4.5 shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
      {!collapsed && item.children && item.active && (
        <ul className="ml-5 mt-0.5 space-y-0.5 border-l border-border pl-2" data-testid="nav-subitems">
          {item.children.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                aria-current={c.current ? "page" : undefined}
                className={cn(
                  "flex items-center rounded-lg px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  touch ? "min-h-10" : "min-h-8",
                  c.active ? "font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <span className="truncate">{c.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Uitschuifbare navigatielade voor schermen onder md; dezelfde navigatie als de zijbalk. */
function MobileNav({ me }: { me: Me }) {
  const t = useT();
  const { pathname } = useNav(me.isAdmin);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
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
        <SidebarBody me={me} collapsed={false} inDrawer />
      </SheetContent>
    </Dialog>
  );
}

function UserMenu({ me, sidebar = false, collapsed = false }: { me: Me; sidebar?: boolean; collapsed?: boolean }) {
  const { t, locale, setLocale } = useLocale();
  const logout = trpc.auth.logout.useMutation({
    // volledige reload: wist alle gecachte queries
    onSettled: () => window.location.assign("/login"),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn("gap-2", sidebar ? cn("h-11 w-full justify-start px-2", collapsed && "justify-center") : "h-10 px-1.5 sm:px-2")}
          aria-label={t.nav.userMenu}
          data-testid="user-menu"
        >
          <UserAvatar user={me.user} className="size-7 shrink-0" />
          {sidebar && !collapsed && <span className="min-w-0 flex-1 truncate text-left text-sm">{displayName(me.user)}</span>}
          {!sidebar && <span className="hidden max-w-40 truncate text-sm sm:inline">{displayName(me.user)}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={sidebar ? "start" : "end"} side={sidebar ? "top" : "bottom"}>
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
