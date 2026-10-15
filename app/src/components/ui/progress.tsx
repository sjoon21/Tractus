import { cn } from "./utils";

/** 얇은 진행 막대. value(0..1)가 null이면 끝을 모르는 진행 */
export function Progress({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-border", className)}>
      {value === null ? (
        <div className="h-full w-[30%] animate-[progress-slide_1.3s_cubic-bezier(0.2,0,0,1)_infinite] rounded-full bg-foreground/70" />
      ) : (
        <div className="h-full origin-left rounded-full bg-foreground/70 transition-transform duration-200" style={{ transform: `scaleX(${value})` }} />
      )}
    </div>
  );
}
