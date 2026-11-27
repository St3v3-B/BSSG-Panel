"use client";
import { Archive, CalendarClock, Database, FolderOpen, Globe, Network, PackagePlus, Puzzle, ScrollText, Settings, SquareTerminal, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ContentKind, Permission, ServerDetail } from "@panel/api";
import { ALL_PERMISSIONS } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { getT, useT } from "@/app/_lib/i18n";

export interface ServerTab {
  key: string;
  href: string;
  label: string;
  icon: typeof Globe;
}

/** Welke tabbladen deze gebruiker op deze server ziet (op basis van type en rechten). */
export function serverTabs(server: Pick<ServerDetail, "uuid" | "type" | "isOwner" | "permissions"> & { domainsAllowed?: boolean; network?: Pick<ServerDetail["network"], "role">; content?: ContentKind | null }): ServerTab[] {
  const base = `/servers/${server.uuid}`;
  const has = (p: Permission) => server.permissions.includes(p);
  const l = getT().server.tabs;
  const tabs: ServerTab[] = [server.type === "web" ? { key: "console", href: base, label: l.logs, icon: ScrollText } : { key: "console", href: base, label: l.console, icon: SquareTerminal }];
  if (has("files.read")) tabs.push({ key: "files", href: `${base}/files`, label: l.files, icon: FolderOpen });
  if (server.content && has("files.read")) tabs.push({ key: "content", href: `${base}/content`, label: server.content === "plugin" ? l.plugins : l.mods, icon: Puzzle });
  if ((server.type === "web" || server.domainsAllowed) && has("domain.manage")) tabs.push({ key: "domains", href: `${base}/domains`, label: l.domains, icon: Globe });
  if (server.network?.role === "proxy" && (server.isOwner || ALL_PERMISSIONS.every(has))) tabs.push({ key: "network", href: `${base}/network`, label: l.network, icon: Network });
  if (server.type === "web" && has("files.write")) tabs.push({ key: "apps", href: `${base}/apps`, label: l.apps, icon: PackagePlus });
  if (has("database.manage")) tabs.push({ key: "databases", href: `${base}/databases`, label: l.databases, icon: Database });
  if (has("backup.create") || has("backup.restore")) tabs.push({ key: "backups", href: `${base}/backups`, label: l.backups, icon: Archive });
  if (has("schedule.manage")) tabs.push({ key: "schedules", href: `${base}/schedules`, label: l.schedules, icon: CalendarClock });
  if (server.isOwner) tabs.push({ key: "users", href: `${base}/users`, label: l.users, icon: Users });
  tabs.push({ key: "settings", href: `${base}/settings`, label: l.settings, icon: Settings });
  return tabs;
}

export function ServerTabs({ server }: { server: ServerDetail }) {
  const pathname = usePathname() ?? "";
  const t = useT();
  const hasFiles = server.type === "game" && server.permissions.includes("files.read");
  const info = trpc.content.info.useQuery({ uuid: server.uuid }, { enabled: hasFiles, staleTime: 5 * 60_000, retry: false });
  const tabs = serverTabs({ ...server, content: info.data?.supported ? info.data.kind : null });
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1" aria-label={t.server.tabsLabel}>
      {tabs.map((t) => {
        const active = t.key === "console" ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors [&_svg]:size-4",
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon /> {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
