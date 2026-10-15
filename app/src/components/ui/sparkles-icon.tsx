// AI 어시스턴트 아이콘: lucide Sparkles와 같은 도형을 직접 그려 부분마다 움직인다.
// 부모에 `group/ai`를 주면 가리킬 때 큰 별이 돌며 커지고, 작은 반짝임은 번갈아 깜빡이며, 선이 보라→하늘색으로 바뀐다.
// '동작 줄이기'에서는 base.css가 애니메이션을 끈다(색만 바뀐다)
import { useId, type CSSProperties } from "react";
import { cn } from "./utils";

const PART = "[transform-box:fill-box] origin-center";

export function SparklesIcon({ className }: { className?: string }) {
  const id = `ai-grad-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4 shrink-0 overflow-visible group-hover/ai:[stroke:var(--ai-grad)]", className)}
      style={{ "--ai-grad": `url(#${id})` } as CSSProperties}
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <path
        className={cn(PART, "group-hover/ai:animate-sparkle-turn")}
        d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
      />
      <g className={cn(PART, "group-hover/ai:animate-sparkle-twinkle")}>
        <path d="M20 2v4" />
        <path d="M22 4h-4" />
      </g>
      <circle className={cn(PART, "group-hover/ai:animate-sparkle-twinkle group-hover/ai:[animation-delay:300ms]")} cx="4" cy="20" r="2" />
    </svg>
  );
}
