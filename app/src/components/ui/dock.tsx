import type { ReactNode } from "react";
import { cn } from "./utils";

// 가운데 화면 아래에 뜨는 도크: 둥근 알약 하나에 자주 쓰는 것(패널 탭·도구)을 모은다. 안쪽은 DockGroup으로 나누고 그 사이에 구분선이 선다
// 좁으면 가로로 스크롤한다(줄을 바꾸지 않는다).

export function Dock({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  return (
    <div className="flex justify-center px-4 pt-2 pb-2">
      <div role="toolbar" aria-label={label} className={cn("flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-border bg-card px-1.5 py-1 shadow-pop", className)}>
        {children}
      </div>
    </div>
  );
}

/** 도크 안의 묶음: 앞 묶음과 구분선으로 나뉜다 */
export function DockGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex shrink-0 items-center gap-0.5 [&:not(:first-child)]:ml-1 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border [&:not(:first-child)]:pl-1.5", className)}>{children}</div>;
}
