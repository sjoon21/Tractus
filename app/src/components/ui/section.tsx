import type { ReactNode } from "react";
import { cn } from "./utils";

// macOS 시스템 설정처럼 묶은 목록: 제목 + 둥근 카드 안의 행들

export function Section({ title, icon, description, actions, children, className, id, tabIndex }: { title?: ReactNode; icon?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string; tabIndex?: number }) {
  return (
    <section id={id} tabIndex={tabIndex} className={cn("flex flex-col gap-2", className)} aria-label={typeof title === "string" ? title : undefined}>
      {(title || actions) && (
        <header className="flex items-end justify-between gap-3 px-1">
          <div className="min-w-0">
            {title && (
              <h2 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                {icon}
                {title}
              </h2>
            )}
            {description && <p className="m-0 mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

/** 한 행: 왼쪽 이름·설명, 오른쪽 조작. 아래로 늘어나는 내용(children 아래)은 below */
export function Row({ label, hint, control, below, className, htmlFor }: { label: ReactNode; hint?: ReactNode; control?: ReactNode; below?: ReactNode; className?: string; htmlFor?: string }) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-6">
        <Label htmlFor={htmlFor} className="min-w-0 flex-1">
          <span className="block text-[13px] text-foreground">{label}</span>
          {hint && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>}
        </Label>
        {control && <div className="flex shrink-0 items-center gap-2">{control}</div>}
      </div>
      {below && <div className="mt-3">{below}</div>}
    </div>
  );
}
