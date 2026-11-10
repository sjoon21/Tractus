// 녹음 단추 오른쪽 ▾: 녹음 방식(대면 녹음 / 화상·하이브리드)을 고른다. 사이드바의 상시 선택 단추를 대신한다(v3.105, DESIGN.md §5 `설명보다 상태`).
// 메뉴 규칙(키보드·바깥 누르기·Esc)은 Popover·ItemMenu가 맡는다. 설명은 항목의 title에만 둔다.
import { useState } from "react";
import { ChevronDown, Monitor, Users } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { REC_MODES, type RecMode } from "./lib";
import { ItemMenu, Popover } from "./Popover";

/** 녹음 방식 아이콘 (녹음 단추 안에 지금 방식을 보인다) */
export function RecModeIcon({ mode, className }: { mode: RecMode; className?: string }) {
  const Icon = mode === "hybrid" ? Monitor : Users;
  return <Icon className={className} aria-hidden />;
}

export function RecordModeMenu({ mode, onPick, className }: { mode: RecMode; onPick: (m: RecMode) => void; className?: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = REC_MODES.find((m) => m.mode === mode) ?? REC_MODES[0];
  return (
    <>
      <button
        type="button"
        className={cn(buttonVariants({ variant: "outline", size: "icon" }), "w-6 bg-background", className)}
        aria-label={t("녹음 방식: {mode}", { mode: current.label })}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title={t("녹음 방식: {mode}", { mode: current.label })}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <ChevronDown aria-hidden />
      </button>
      {anchor && (
        <Popover anchor={anchor} label={t("녹음 방식")} onClose={() => setAnchor(null)}>
          {(close) => (
            <ItemMenu
              close={close}
              entries={REC_MODES.map((m) => ({ id: m.mode, label: m.label, title: m.note, checked: m.mode === mode, onSelect: () => onPick(m.mode) }))}
            />
          )}
        </Popover>
      )}
    </>
  );
}
