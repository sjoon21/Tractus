import type { Ref, SelectHTMLAttributes } from "react";
import { cn } from "./utils";

// 네이티브 select (키보드·화면 읽기·IME를 그대로 쓴다). 화살표는 배경 그림.
// 위치·크기는 임의 속성으로 쓴다: bg-[…]로 쓰면 cn(tailwind-merge)이 bg-transparent와 겹친다고 보고 지운다
export const selectClass =
  "h-8 min-w-0 appearance-none rounded-md border border-input bg-background bg-no-repeat [background-position:right_8px_center] [background-size:14px] pr-7 pl-2.5 text-[13px] shadow-xs outline-none transition-[border-color,box-shadow] [background-image:var(--chevron)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 off:opacity-50";

export function Select({ className, ref, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  return <select ref={ref} className={cn(selectClass, className)} {...props} />;
}
