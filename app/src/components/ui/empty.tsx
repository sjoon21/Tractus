import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./utils";

/** 빈 상태 (DESIGN.md §5 `상자보다 여백`): 상자·아이콘 칩 없이 제목 한 줄 + 짧은 설명 + 단추 하나까지 */
export function Empty({ title, children, action, className, ...rest }: { title: ReactNode; children?: ReactNode; action?: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5 px-4 py-10 text-center", className)} {...rest}>
      <p className="m-0 text-[13px] font-medium">{title}</p>
      {children && <div className="max-w-[36ch] text-xs leading-relaxed text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
