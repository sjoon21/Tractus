import type { View } from "../../App";
import { MODELS_LABEL } from "../../caps";
import { t } from "../../i18n";
import { Box, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

// 사이드바 아래 줄 (App에서 옮김, 동작 그대로): 설정 · 모델 · 노트 개수.
export function SidebarFooter({ viewKind, noteCount, go }: { viewKind: string; noteCount: number; go: (v: View) => Promise<void> }) {
  return (
    <>
    <footer className="flex items-center gap-0.5 border-t border-sidebar-border px-2 py-1.5">
      <Button variant="sidebar" size="sm" className="gap-1.5 text-muted-foreground aria-[current=true]:text-foreground" onClick={() => void go({ kind: "settings" })} aria-current={viewKind === "settings"}>
        <Settings aria-hidden />
        {t("설정")}
      </Button>
      <Button variant="sidebar" size="sm" className="gap-1.5 text-muted-foreground aria-[current=true]:text-foreground" onClick={() => void go({ kind: "models" })} aria-current={viewKind === "models"}>
        <Box aria-hidden />
        {MODELS_LABEL}
      </Button>
      <span className="ml-auto pr-2 text-[11px] text-subtle-foreground tabular-nums">{t("노트 {n}개", { n: noteCount })}</span>
    </footer>
    </>
  );
}
