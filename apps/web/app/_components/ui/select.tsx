import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native select in shadcn-stijl: toegankelijk en eenvoudig te testen. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "flex h-11 w-full rounded-lg border border-input bg-background/40 px-3 py-1 text-sm shadow-xs md:h-9 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
