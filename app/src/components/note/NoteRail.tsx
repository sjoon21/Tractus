// 오른쪽 패널: 요약 · 회의록 · AI 질문 · 메모 탭의 틀. 탭 고르기는 도크(NoteDock)가 하고, 어느 탭이 열렸는지는 useRail이 들고 있다.  // words-ok: 회의록은 문서 이름
// 질문·메모·회의록 탭은 처음 열 때 만들고 그 뒤에는 숨겨도 둔다(스트리밍·쓰던 글이 이어지게). 탭 안은 rail/의 탭 컴포넌트가 그리고,
// 노트 단위로 공통인 값은 NoteViewContext로 받는다. 여기는 탭 하나에만 필요한 것만 props로 받는다.
import type { ComponentProps } from "react";
import { cn } from "@/components/ui/utils";
import type { Rail } from "../../note/useRail";
import { useNoteView } from "../../note/NoteViewContext";
import { PanelResizer, PanelToggle } from "../../PanelToggle";
import { RAIL_LABEL, railLabel } from "../../rail";
import type { SummaryDoc } from "../../summaries";
import { AskTab } from "./rail/AskTab";
import { MemoTab } from "./rail/MemoTab";
import { MinutesTab } from "./rail/MinutesTab";
import { SummaryTab } from "./rail/SummaryTab";

export function NoteRail({
  rail,
  onSelectSummary,
  sendToMemo,
  onCite,
  memoTab,
}: {
  rail: Rail;
  /** 요약 탭에서 고른 요약 (인쇄가 쓴다) */
  onSelectSummary: (d: SummaryDoc | null) => void;
  /** 요약을 내 메모 끝에 붙인다 */
  sendToMemo: (markdown: string) => Promise<void>;
  /** 질문 답의 근거를 눌렀다 */
  onCite: (m: string, segId: string, sec: number) => void;
  memoTab: ComponentProps<typeof MemoTab>;
}) {
  const { memoNote } = useNoteView();
  const { tabNow, askSeen, memoSeen, minutesSeen, railCollapsed } = rail;
  return (
    <aside className="summary-col relative flex min-h-0 flex-col border-l border-border bg-background max-[1180px]:overflow-visible max-[1180px]:border-t max-[1180px]:border-l-0" aria-label={railLabel(memoNote)}>
      <PanelToggle side="right" />
      {!railCollapsed && <PanelResizer side="right" className="max-[1180px]:hidden" />}
      <div id="rail-body" className="rail-body flex min-h-0 flex-1 flex-col overflow-y-auto max-[1180px]:overflow-visible" hidden={railCollapsed}>
        <div className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center bg-background/90 pr-12 pl-5 backdrop-blur-md" data-tauri-drag-region>
          <h2 className="m-0 text-[13px] font-semibold">{RAIL_LABEL[tabNow]}</h2>
        </div>
        <div className={cn("flex flex-1 flex-col px-5 pt-2", tabNow === "ask" ? "pb-0" : "pb-10")}>
          <div id="panel-summary" role="tabpanel" aria-labelledby="tab-summary" hidden={tabNow !== "summary"}>
            <SummaryTab onSelect={onSelectSummary} sendToMemo={sendToMemo} />
          </div>
          {minutesSeen && !memoNote && (
            <div id="panel-minutes" role="tabpanel" aria-labelledby="tab-minutes" hidden={tabNow !== "minutes"}>
              <MinutesTab />
            </div>
          )}
          {askSeen && (
            <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" className="rail-ask flex flex-1 flex-col" hidden={tabNow !== "ask"}>
              <AskTab onCite={onCite} />
            </div>
          )}
          {memoSeen && !memoNote && (
            <div id="panel-memo" role="tabpanel" aria-labelledby="tab-memo" className="rail-memo" hidden={tabNow !== "memo"}>
              <MemoTab {...memoTab} />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
