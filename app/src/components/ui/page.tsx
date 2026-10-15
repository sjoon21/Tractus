import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./utils";

/** 설정·모델·검색 같은 화면의 머리: 뒤로 단추 + 제목 + 오른쪽 동작. 위 52px은 창 끌기 자리 */
export function PageHeader({ title, onBack, backLabel = "뒤로", actions, children }: { title: ReactNode; onBack?: () => void; backLabel?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur-md">
      <div data-tauri-drag-region className="flex h-[52px] items-center gap-2 px-4">
        {onBack && (
          <button type="button" onClick={onBack} aria-label={backLabel} title={backLabel} className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <h1 className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** 머리 아래 본문: 가운데 정렬한 읽기 폭 */
export function PageBody({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn("mx-auto flex w-full flex-col gap-8 px-6 py-8", wide ? "max-w-[880px]" : "max-w-[680px]", className)}>{children}</div>;
}
