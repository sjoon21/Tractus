import type { InputHTMLAttributes } from "react";
import { cn } from "./utils";

// macOS 스위치 모양의 체크박스 (role="switch"). 네이티브 input이라 폼·테스트·키보드가 그대로다
export const switchClass =
  "relative h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-border-strong outline-none transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-white before:shadow-sm before:transition-transform checked:bg-[#34c759] checked:before:translate-x-3.5 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-default disabled:opacity-45";

export function Switch({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="checkbox" role="switch" className={cn(switchClass, className)} {...props} />;
}

/** 체크박스·라디오: 시스템 파랑 */
export const checkClass = "size-4 shrink-0 cursor-pointer accent-[var(--ring)] disabled:cursor-default";
