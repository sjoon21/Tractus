import { useLayoutEffect, useRef, type Ref, type TextareaHTMLAttributes } from "react";
import { cn } from "./utils";

export const textareaClass =
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-[13px] leading-relaxed shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 off:opacity-50";

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(textareaClass, className)} {...props} />;
}

/** 한 줄에서 시작해 글에 맞춰 높이가 늘어나는 입력 (긴 메모가 옆으로 숨지 않게). Enter 처리는 부르는 쪽이 한다 */
export function GrowTextarea({ className, onInput, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const el = useRef<HTMLTextAreaElement>(null);
  const fit = (t: HTMLTextAreaElement) => {
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`; // 테두리까지
  };
  useLayoutEffect(() => {
    if (el.current) fit(el.current);
  }, [props.value]);
  return (
    <textarea
      ref={el}
      rows={1}
      className={cn(textareaClass, "resize-none overflow-hidden", className)}
      onInput={(e) => {
        fit(e.currentTarget);
        onInput?.(e);
      }}
      {...props}
    />
  );
}
