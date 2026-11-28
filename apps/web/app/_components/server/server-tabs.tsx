"use client";
import { Archive, CalendarClock, History, ChartLine, Contact, Database, FolderOpen, GitBranch, Globe, Network, Smartphone, PackagePlus, Puzzle, ScrollText, Settings, SquareTerminal, Terminal as TerminalIcon, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import type { ContentKind, Permission, ServerDetail } from "@panel/api";
import { ALL_PERMISSIONS } from "@panel/api/schemas";
import { bedrockPlatform } from "@panel/api/network";
import { playersPlatform } from "@panel/api/players";
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
export function serverTabs(server: Pick<ServerDetail, "uuid" | "type" | "isOwner" | "permissions"> & { terminal?: Pick<ServerDetail["terminal"], "enabled">; domainsAllowed?: boolean; network?: Pick<ServerDetail["network"], "role">; content?: ContentKind | null; bedrock?: boolean; players?: boolean }): ServerTab[] {
  const base = `/servers/${server.uuid}`;
  const has = (p: Permission) => server.permissions.includes(p);
  const l = getT().server.tabs;
  const tabs: ServerTab[] = [server.type === "web" ? { key: "console", href: base, label: l.logs, icon: ScrollText } : { key: "console", href: base, label: l.console, icon: SquareTerminal }];
  if (has("console.read")) tabs.push({ key: "stats", href: `${base}/stats`, label: l.stats, icon: ChartLine });
  if (has("files.read")) tabs.push({ key: "files", href: `${base}/files`, label: l.files, icon: FolderOpen });
  if (server.players && has("players.read")) tabs.push({ key: "players", href: `${base}/players`, label: l.players, icon: Contact });
  if (server.players && has("players.read")) tabs.push({ key: "activity", href: `${base}/activity`, label: getT().playerActivity.tab, icon: History });
  if (has("terminal") && has("files.write") && server.terminal?.enabled) tabs.push({ key: "terminal", href: `${base}/terminal`, label: getT().devaccess.terminal.tab, icon: TerminalIcon });
  if (server.content && has("files.read")) tabs.push({ key: "content", href: `${base}/content`, label: server.content === "plugin" ? l.plugins : l.mods, icon: Puzzle });
  if ((server.type === "web" || server.domainsAllowed) && has("domain.manage")) tabs.push({ key: "domains", href: `${base}/domains`, label: l.domains, icon: Globe });
  if (server.network?.role === "proxy" && (server.isOwner || ALL_PERMISSIONS.every(has))) tabs.push({ key: "network", href: `${base}/network`, label: l.network, icon: Network });
  if (server.bedrock && (server.isOwner || has("files.write"))) tabs.push({ key: "bedrock", href: `${base}/bedrock`, label: l.bedrock, icon: Smartphone });
  if (server.type === "web" && has("files.write")) tabs.push({ key: "apps", href: `${base}/apps`, label: l.apps, icon: PackagePlus });
  if (server.type === "web" && has("deploy.read")) tabs.push({ key: "deploy", href: `${base}/deploy`, label: l.deploy, icon: GitBranch });
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
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    // houd het actieve tabblad zichtbaar op smalle schermen
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [pathname]);
  const hasFiles = server.type === "game" && server.permissions.includes("files.read");
  const info = trpc.content.info.useQuery({ uuid: server.uuid }, { enabled: hasFiles, staleTime: 5 * 60_000, retry: false });
  const tabs = serverTabs({ ...server, content: info.data?.supported ? info.data.kind : null, bedrock: server.type === "game" && !!bedrockPlatform(server.templateSlug), players: server.type === "game" && !!playersPlatform(server.templateSlug) });
  return (
    <nav ref={nav} className="scrollbar-none -mx-4 flex snap-x gap-1 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0" aria-label={t.server.tabsLabel}>
      {tabs.map((t) => {
        const active = t.key === "console" ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-11 snap-start items-center gap-2 whitespace-nowrap border-b-2 px-3.5 text-sm font-medium transition-colors [&_svg]:size-4",
              active ? "border-primary text-foreground [&_svg]:text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon /> {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
