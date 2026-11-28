"use client";
import { Activity, BookOpen, Database, FileCode2, Globe, Import, LayoutDashboard, Package, Receipt, Server, Settings, Users, type LucideIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePathname } from "next/navigation";
import { usePhpMyAdmin } from "@/app/_hooks/use-phpmyadmin";
import { useT } from "@/app/_lib/i18n";

export interface NavItem {
  href: string;
  label: string;
  /** De pagina (of een subpagina daarvan) is open. */
  active: boolean;
  /** Precies deze pagina is open (aria-current). */
  current: boolean;
  icon: LucideIcon;
  children?: NavItem[];
}

export interface NavSection {
  id: "panel" | "admin";
  title: string;
  items: NavItem[];
}

/** Enige bron voor de navigatie: gebruikt door de zijbalk (desktop) en de lade (mobiel). */
export function useNav(isAdmin: boolean) {
  const pathname = usePathname() ?? "/";
  const t = useT();
  const is = (href: string) => pathname === href || pathname === `${href}/`;
  const under = (href: string) => is(href) || pathname.startsWith(`${href}/`);
  const mk = (href: string, label: string, icon: LucideIcon, active: boolean, children?: NavItem[]): NavItem => ({ href, label, icon, active, current: is(href), children });

  const sub = t.admin2.sub;
  const settingsChildren = [
    mk("/admin/settings", sub.general, Settings, is("/admin/settings")),
    mk("/admin/settings/database-hosts", sub.databaseHosts, Settings, under("/admin/settings/database-hosts")),
    mk("/admin/settings/dns-providers", sub.dnsProviders, Settings, under("/admin/settings/dns-providers")),
    mk("/admin/settings/backup-storage", sub.s3Targets, Settings, under("/admin/settings/backup-storage")),
    mk("/admin/settings/image-updates", sub.imageUpdates, Settings, under("/admin/settings/image-updates")),
    mk("/admin/settings/email", t.notif2.smtpNav, Settings, under("/admin/settings/email")),
    mk("/admin/settings/updates", sub.updates, Settings, under("/admin/settings/updates")),
    mk("/admin/settings/billing", t.billing.nav.settings, Settings, under("/admin/settings/billing")),
  ];
  const n = t.admin2.nav;
  const pma = usePhpMyAdmin();
  const panelItems: NavItem[] = [{ ...mk("/", t.nav.myServers, Server, pathname === "/" || under("/servers")), current: pathname === "/" }];
  panelItems.push(mk("/status-pages", t.statusPage.navTitle, Globe, under("/status-pages")));
  panelItems.push(mk("/developers", t.devaccess.developers.nav, BookOpen, under("/developers")));
  if (pma.info?.visible) {
    panelItems.push(mk("/databases", t.phpmyadmin.nav, Database, under("/databases")));
  }
  // Pakketten/facturatie: alleen tonen als ze aanstaan (of de gebruiker al abonnementen/facturen heeft).
  const billing = trpc.billing.status.useQuery(undefined, { staleTime: 60_000, retry: false });
  const b = billing.data;
  if (b?.plansEnabled) panelItems.push(mk("/plans", t.billing.nav.plans, Package, under("/plans")));
  if (b && (b.billingEnabled || b.hasSubscriptions)) panelItems.push(mk("/billing", t.billing.nav.billing, Receipt, under("/billing")));
  const sections: NavSection[] = [{ id: "panel", title: t.nav.panelSection, items: panelItems }];
  if (isAdmin) {
    sections.push({
      id: "admin",
      title: t.nav.adminSection,
      items: [
        mk("/admin", n.dashboard, LayoutDashboard, is("/admin")),
        mk("/admin/servers", n.servers, Server, under("/admin/servers")),
        mk("/admin/nodes", n.nodes, Server, under("/admin/nodes")),
        mk("/admin/users", n.users, Users, under("/admin/users")),
        mk("/admin/templates", n.templates, FileCode2, under("/admin/templates")),
        mk("/admin/import", t.hostops.imp.nav, Import, under("/admin/import")),
        ...(b?.plansEnabled ? [mk("/admin/plans", t.billing.nav.adminPlans, Package, under("/admin/plans"))] : []),
        ...(b?.plansEnabled || b?.billingEnabled ? [mk("/admin/billing", t.billing.nav.adminBilling, Receipt, under("/admin/billing"))] : []),
        mk("/admin/activity", n.activity, Activity, under("/admin/activity")),
        mk("/admin/settings", n.settings, Settings, under("/admin/settings"), settingsChildren),
      ],
    });
  }
  const account = mk("/account", t.nav.account, Settings, is("/account"));
  /** Broodkruimels voor de smalle balk bovenaan. */
  const crumbs: string[] = [];
  for (const s of sections) {
    for (const it of s.items) {
      if (!it.active) continue;
      if (s.id === "admin") crumbs.push(t.nav.admin);
      crumbs.push(it.label);
      const c = it.children?.find((x) => x.current || (x.href !== "/admin/settings" && x.active));
      if (c) crumbs.push(c.label);
    }
  }
  if (account.active) crumbs.push(account.label);
  return { pathname, sections, account, crumbs };
}
