import type { HTMLAttributes } from "react";
import { forOs } from "../../platform";
import { cn } from "./utils";

/** 단축키 표기. 글자는 macOS 표기(`⌘K`)로 쓰고 Windows에서는 `Ctrl+K`로 보인다 (platform.forOs) */
export function Kbd({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      aria-hidden
      className={cn("pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-0.5 rounded-[4px] border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground", className)}
      {...props}
    >
      {typeof children === "string" ? forOs(children) : children}
    </kbd>
  );
}
