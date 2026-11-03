// 알림(토스트) 한 줄 (App에서 옮김, 동작 그대로): 오류가 아니면 일정 시간 뒤 저절로 닫힌다.
import type { Toast } from "../App";
import { useEffect, useRef } from "react";
import { ErrorDetail } from "../ErrorDetail";
import { t } from "../i18n";
import { CircleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

export const TOAST_MS = 6000;

export function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (toast.error) return;
    const h = setTimeout(() => close.current(), TOAST_MS);
    return () => clearTimeout(h);
  }, [toast.error]);
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border border-border bg-popover py-1.5 pr-1.5 pl-3.5 text-[13px] text-popover-foreground shadow-pop animate-in fade-in-0 slide-in-from-bottom-2", toast.error && "border-destructive/40")} role={toast.error ? "alert" : "status"}>
      {toast.error && <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 flex-1 py-1">
        {toast.text}
        <ErrorDetail detail={toast.detail} />
      </div>
      {toast.action && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("알림 닫기")} onClick={onClose}>
        <X aria-hidden />
      </Button>
    </div>
  );
}
