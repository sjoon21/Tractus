import type { Ref, TextareaHTMLAttributes } from "react";
import { cn } from "./utils";

export const textareaClass =
  "w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-[13px] leading-relaxed shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 off:opacity-50";

export function Textarea({ className, ref, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(textareaClass, className)} {...props} />;
}
