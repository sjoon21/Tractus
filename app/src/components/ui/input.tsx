import type { InputHTMLAttributes, Ref } from "react";
import { cn } from "./utils";

export const inputClass =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[13px] shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 off:opacity-50";

export function Input({ className, ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(inputClass, className)} {...props} />;
}
