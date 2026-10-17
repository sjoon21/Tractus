// 홈의 `Tractus 시작하기` 체크리스트 (온보딩 ①). 다 하거나 닫으면 사라지고, 설정 › 도움말에서 다시 볼 수 있다
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { markOnboard, ONBOARD_CLOSE, ONBOARD_TITLE, type Step, type StepId } from "./onboarding";

export function OnboardingCard({ steps, onStep }: { steps: Step[]; onStep: (id: StepId) => void }) {
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;
  return (
    <section aria-labelledby="onboard-title" className="rounded-lg border border-border bg-card/90 shadow-xs backdrop-blur-sm">
      <header className="flex items-center gap-3 px-4 pt-3.5 pb-2">
        <h2 id="onboard-title" className="m-0 text-[13px] font-semibold">
          {ONBOARD_TITLE}
        </h2>
        <span className="text-xs text-subtle-foreground tabular-nums">
          {done}/{steps.length}
        </span>
        <div className="ml-2 h-1 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
          <div className="h-full rounded-full bg-memo transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${(done / steps.length) * 100}%` }} />
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={ONBOARD_CLOSE} title={ONBOARD_CLOSE} onClick={() => markOnboard("dismissed")}>
          <X aria-hidden />
        </Button>
      </header>
      <ol className="m-0 list-none p-0 pb-1.5">
        {steps.map((s, n) => (
          <li key={s.id} className={cn("flex items-center gap-3 px-4 py-2", s.id === next && "bg-accent/40")}>
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-semibold tabular-nums",
                s.done ? "border-transparent bg-memo text-background" : "border-border-strong text-muted-foreground",
              )}
              aria-hidden
            >
              {s.done ? <Check className="size-3" strokeWidth={3} /> : n + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("m-0 text-[13px] font-medium", s.done && "text-muted-foreground line-through decoration-border-strong")}>
                {s.label}
                {s.done && <span className="sr-only"> (마침)</span>}
              </p>
              {!s.done && <p className="m-0 text-xs leading-5 text-muted-foreground">{s.hint}</p>}
            </div>
            {!s.done && (
              <Button variant={s.id === next ? "default" : "outline"} size="sm" onClick={() => onStep(s.id)}>
                {s.action}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
