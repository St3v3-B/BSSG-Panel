import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative flex w-full gap-3 rounded-lg border px-4 py-3 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      warning: "border-warning/40 bg-warning/10 text-warning",
      info: "border-info/40 bg-info/10 text-info",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Alert({ className, variant, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("font-medium leading-tight", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-1 text-sm opacity-90 [&_p]:leading-relaxed", className)} {...props} />;
}
