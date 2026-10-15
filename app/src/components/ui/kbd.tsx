import type { HTMLAttributes } from "react";
import { cn } from "./utils";

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      aria-hidden
      className={cn("pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded-[4px] border border-border bg-muted px-1 font-sans text-[10.5px] font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}
