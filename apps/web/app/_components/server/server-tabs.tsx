"use client";
import { Database, FolderOpen, Globe, Settings, SquareTerminal, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Permission, ServerDetail } from "@panel/api";
import { cn } from "@/lib/utils";

export interface ServerTab {
  key: string;
  href: string;
  label: string;
  icon: typeof Globe;
}

/** Welke tabbladen deze gebruiker op deze server ziet (op basis van type en rechten). */
export function serverTabs(server: Pick<ServerDetail, "uuid" | "type" | "isOwner" | "permissions">): ServerTab[] {
  const base = `/servers/${server.uuid}`;
  const has = (p: Permission) => server.permissions.includes(p);
  const tabs: ServerTab[] = [{ key: "console", href: base, label: "Console", icon: SquareTerminal }];
  if (has("files.read")) tabs.push({ key: "files", href: `${base}/files`, label: "Bestanden", icon: FolderOpen });
  if (server.type === "web" && has("domain.manage")) tabs.push({ key: "domains", href: `${base}/domains`, label: "Domeinen", icon: Globe });
  if (has("database.manage")) tabs.push({ key: "databases", href: `${base}/databases`, label: "Databases", icon: Database });
  if (server.isOwner) tabs.push({ key: "users", href: `${base}/users`, label: "Gebruikers", icon: Users });
  tabs.push({ key: "settings", href: `${base}/settings`, label: "Instellingen", icon: Settings });
  return tabs;
}

export function ServerTabs({ server }: { server: ServerDetail }) {
  const pathname = usePathname() ?? "";
  const tabs = serverTabs(server);
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1" aria-label="Serveronderdelen">
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
