import type { UserPublic } from "@panel/api";
import { cn } from "@/lib/utils";

export function displayName(u: Pick<UserPublic, "name" | "discordId">): string {
  return u.name ?? `Discord ${u.discordId}`;
}

export function UserAvatar({ user, className }: { user: Pick<UserPublic, "name" | "discordId" | "avatarUrl">; className?: string }) {
  const initial = (user.name ?? "?").slice(0, 1).toUpperCase();
  return user.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={user.avatarUrl} alt="" className={cn("size-8 rounded-full object-cover", className)} />
  ) : (
    <span className={cn("grid size-8 place-items-center rounded-full bg-muted text-sm font-medium text-muted-foreground", className)} aria-hidden>
      {initial}
    </span>
  );
}
