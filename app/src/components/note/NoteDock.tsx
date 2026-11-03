// 노트 화면 아래의 도구 막대 (MeetingView에서 옮김, 동작 그대로): 오른쪽 패널 탭 · 스마트 교정(AI 서비스 선택) · 찾아 바꾸기.
// 탭 상태는 useRail이 들고 있고 여기서는 그리기만 한다.
import { TextSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dock, DockGroup } from "@/components/ui/dock";
import { cn } from "@/components/ui/utils";
import { t } from "../../i18n";
import { LlmServicePicker } from "../../LlmServicePicker";
import { flushMemos } from "../../memo";
import type { Rail } from "../../note/useRail";
import { PolishButton, type usePolish } from "../../PolishControls";
import { RAIL_LABEL, railKey } from "../../rail";

export function NoteDock({
  rail,
  memoNote,
  recorded,
  hasSegments,
  polish,
  polishOff,
  polishAgain,
  onFind,
}: {
  rail: Rail;
  memoNote: boolean;
  /** 변환 전 노트: 대화가 없어 교정·찾기를 보이지 않는다 */
  recorded: boolean;
  hasSegments: boolean;
  polish: ReturnType<typeof usePolish>;
  /** 스마트 교정을 못 쓰는 이유 (없으면 쓸 수 있다) */
  polishOff: string | null;
  /** 남은 제안이 있다: 다시 교정하면 새 제안으로 바뀐다 */
  polishAgain: boolean;
  onFind: () => void;
}) {
  const { tabs, tabNow, askSeen, memoSeen, minutesSeen, railCollapsed, showTab, pickTab } = rail;
  return (
    <Dock label={t("도구 막대")}>
      <DockGroup>
        <div
          role="tablist"
          aria-label={t("오른쪽 패널")}
          className="flex items-center gap-0.5"
          onKeyDown={(e) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return; // Shift+←→도 탭을 옮긴다: 막지 않으면 재생 단축키가 큰 폭으로 되감는다
            const next = railKey(tabs, tabNow, e.code);
            if (!next) return;
            // 재생 단축키(←→ 5초 이동)가 이 키를 다시 쓰지 않게 막는다: 전역 단축키는 defaultPrevented면 지나간다
            e.preventDefault();
            showTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}
        >
          {tabs.map((k) => (
            <button
              key={k}
              id={`tab-${k}`}
              role="tab"
              aria-selected={tabNow === k}
              aria-controls={k === "summary" || (k === "ask" ? askSeen : k === "minutes" ? minutesSeen : memoSeen) ? `panel-${k}` : undefined}
              tabIndex={tabNow === k ? 0 : -1}
              onClick={() => pickTab(k)}
              className={cn("h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-selected:bg-accent aria-selected:text-foreground", railCollapsed && "aria-selected:bg-transparent aria-selected:text-muted-foreground aria-selected:hover:bg-accent")}
            >
              {RAIL_LABEL[k]}
            </button>
          ))}
        </div>
      </DockGroup>
      {!memoNote && !recorded && hasSegments && (
        <DockGroup>
          <LlmServicePicker services={polish.services} disabled={polish.running} />
          <PolishButton running={polish.running} done={polish.done} total={polish.total} disabled={polishOff} again={polishAgain} onClick={() => void polish.start(flushMemos)} />
        </DockGroup>
      )}
      {!memoNote && !recorded && (
        <DockGroup>
          <Button variant="ghost" size="icon-sm" aria-label={t("찾아 바꾸기")} title={t("찾아 바꾸기 (⌘F)")} onClick={onFind} aria-keyshortcuts="Meta+F">
            <TextSearch aria-hidden />
          </Button>
        </DockGroup>
      )}
    </Dock>
  );
}
