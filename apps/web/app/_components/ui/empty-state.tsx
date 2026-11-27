import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Lege toestand met icoon, titel, uitleg en optionele actie. */
export function EmptyState({ icon: Icon, title, children, action, className, ...props }: { icon: LucideIcon; title: ReactNode; action?: ReactNode } & Omit<ComponentProps<"div">, "title">) {
  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-12 text-center", className)} {...props}>
      <span className="relative grid size-16 place-items-center rounded-2xl border border-border bg-muted/60 text-primary shadow-card">
        <span aria-hidden className="absolute inset-0 -z-10 rounded-2xl bg-primary/20 blur-xl" />
        <Icon className="size-7" />
      </span>
      <div className="text-base font-semibold">{title}</div>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action}
    </div>
  );
}
