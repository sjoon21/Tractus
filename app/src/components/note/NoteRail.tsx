// 오른쪽 패널 (MeetingView에서 옮김, 동작 그대로): 요약 · 회의록 · AI 질문 · 메모 탭의 본문.  // words-ok: 회의록은 문서 이름
// 탭 고르기는 도크(NoteDock)가 하고, 어느 탭이 열렸는지는 useRail이 들고 있다. 질문·메모·회의록 탭은 처음 열 때 만들고 그 뒤에는 숨겨도 둔다.
import type { MutableRefObject } from "react";
import { cn } from "@/components/ui/utils";
import type { Notify } from "../../App";
import { AskPanel } from "../../AskPanel";
import { LOCK_NOTICE, type AttachControls } from "../../attach";
import { EnhancedNote } from "../../EnhancedNote";
import { t } from "../../i18n";
import type { Segment } from "../../lib";
import { flushMemos, type EditKind, type SaveState } from "../../memo";
import { MemoEditor, type MemoTarget } from "../../MemoView";
import { MinutesPanel } from "../../MinutesPanel";
import type { Rail } from "../../note/useRail";
import { PanelResizer, PanelToggle } from "../../PanelToggle";
import { RAIL_LABEL, railLabel } from "../../rail";
import { CONVERT_FIRST, railNotice } from "../../recorded";
import { SummariesPanel } from "../../SummariesPanel";
import type { SummaryDoc } from "../../summaries";
import type { MeetingDetail } from "../../api";
import { TimeChip } from "./TimeChip";
import { PENDING } from "./styles";

export function NoteRail({
  id,
  memoNote,
  recorded,
  hasSegments,
  rail,
  railStarts,
  starts,
  memoLines,
  memoTarget,
  noteBody,
  memoSegs,
  memoRev,
  editing,
  memoBusy,
  attach,
  summaryRev,
  bumpSummaryRev,
  edit,
  notify,
  onChanged,
  onCite,
  openMemoLine,
  seekTo,
  sendToMemo,
  onMemoSaved,
  setMemoSave,
  setSummaryRunning,
  setSelectedSummary,
  setMinutesRunning,
  setEnhanceRunning,
}: {
  id: string;
  memoNote: boolean;
  /** 변환 전 노트 */
  recorded: boolean;
  hasSegments: boolean;
  rail: Rail;
  /** 근거 칩의 시각 지도 (메모 노트는 비어 있다) */
  railStarts: Map<string, number>;
  starts: Map<string, number>;
  memoLines: Map<string, number>;
  memoTarget: MemoTarget | null;
  noteBody: string;
  memoSegs: Segment[];
  memoRev: number;
  /** 대화 내용을 저장하는 중 / 메모를 저장하는 중 */
  editing: boolean;
  memoBusy: boolean;
  attach?: AttachControls;
  summaryRev: number;
  bumpSummaryRev: () => void;
  /** 요약이 낡았는지 가리는 편집 횟수 (SummariesPanel) */
  edit: { editSeq: number; editSeqRef: MutableRefObject<number>; editKinds: MutableRefObject<EditKind[]> };
  notify: Notify;
  onChanged: () => void;
  onCite: (m: string, segId: string, sec: number) => void;
  openMemoLine: (segId: string | null) => void;
  seekTo: (sec: number, play?: boolean) => void;
  sendToMemo: (markdown: string) => Promise<void>;
  onMemoSaved: (m: MeetingDetail) => void;
  setMemoSave: (s: SaveState) => void;
  setSummaryRunning: (r: boolean) => void;
  setSelectedSummary: (d: SummaryDoc | null) => void;
  setMinutesRunning: (r: boolean) => void;
  setEnhanceRunning: (r: boolean) => void;
}) {
  const { tabNow, askSeen, memoSeen, minutesSeen, railCollapsed } = rail;
  const { editSeq, editSeqRef, editKinds } = edit;
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
      {recorded ? (
        <p className={PENDING} role="status">
          {railNotice("summary", true)}
        </p>
      ) : (
      <SummariesPanel
        id={id}
        memoNote={memoNote}
        rev={summaryRev}
        prepare={async () => !attach?.lock && (await flushMemos())} // 메모(메모 노트의 본문, 녹음 노트의 메모 탭)는 쓰던 글을 먼저 저장한다 (요약이 저장된 글을 읽는다). 저장하지 못하면 요약하지 않는다 (오류는 편집기가 보인다)
        blocked={editing || memoBusy || !!attach?.lock}
        editSeq={editSeq}
        editSeqRef={editSeqRef}
        editKinds={editKinds}
        chip={(ids) => <TimeChip ids={ids} starts={railStarts} onSeek={seekTo} memo={memoLines.size > 0 ? { lines: memoLines, onPick: openMemoLine, tagged: !memoNote } : null} />}
        starts={railStarts}
        memoLines={memoNote ? undefined : memoLines}
        notify={notify}
        onRunning={setSummaryRunning}
        onSelect={setSelectedSummary}
        onChanged={onChanged}
        onToMemo={memoNote || recorded ? undefined : sendToMemo}
      />
      )}
    </div>
    {minutesSeen && !memoNote && (
      <div id="panel-minutes" role="tabpanel" aria-labelledby="tab-minutes" hidden={tabNow !== "minutes"}>
        <MinutesPanel
          id={id}
          rev={summaryRev}
          disabled={recorded ? CONVERT_FIRST : !hasSegments ? t("인식된 대화가 없습니다") : editing || memoBusy ? t("저장이 끝난 뒤에 만들 수 있습니다") : null}
          prepare={flushMemos}
          editSeq={editSeq}
          editSeqRef={editSeqRef}
          editKinds={editKinds}
          chip={(ids) => <TimeChip ids={ids} starts={railStarts} onSeek={seekTo} memo={memoLines.size > 0 ? { lines: memoLines, onPick: openMemoLine, tagged: true } : null} />}
          notify={notify}
          onRunning={setMinutesRunning}
          onChanged={() => {
            bumpSummaryRev();
            onChanged();
          }}
        />
      </div>
    )}
    {askSeen && (
      <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" className="rail-ask flex flex-1 flex-col" hidden={tabNow !== "ask"}>
        {recorded ? (
          <p className={PENDING} role="status">
            {railNotice("ask", true)}
          </p>
        ) : attach?.lock ? (
          // 녹음을 추가하는 동안에는 묻지 않는다: 메모 노트가 녹음 노트로 바뀌는 중이라 근거(메모 줄 ID)가 곧 바뀐다
          <p className={PENDING} role="status">
            {LOCK_NOTICE[attach.lock]}
          </p>
        ) : (
          <AskPanel scope={{ kind: "meeting", id, starts, memoLines: memoLines.size > 0 ? memoLines : undefined, memoNote }} onCite={onCite} />
        )}
      </div>
    )}
    {memoSeen && !memoNote && (
      <div id="panel-memo" role="tabpanel" aria-labelledby="tab-memo" className="rail-memo" hidden={tabNow !== "memo"}>
        <EnhancedNote
          id={id}
          rev={summaryRev}
          disabled={recorded ? CONVERT_FIRST : !hasSegments ? t("인식된 대화가 없습니다") : editing || memoBusy ? t("저장이 끝난 뒤에 완성할 수 있습니다") : null}
          prepare={flushMemos}
          editSeq={editSeq}
          editSeqRef={editSeqRef}
          editKinds={editKinds}
          chip={(ids) => <TimeChip ids={ids} starts={railStarts} onSeek={seekTo} />}
          onSeek={(t) => seekTo(t)}
          onMade={() => {
            bumpSummaryRev();
            onChanged();
          }}
          onRunning={setEnhanceRunning}
          notify={notify}
          pick={memoTarget}
          mine={
            <>
              <p className="mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{t("내가 적는 메모입니다. 요약과 AI 질문에 대화 내용과 함께 쓰입니다.")}</p>
              <MemoEditor key={memoRev} variant="rail" id={id} initial={noteBody} savedBody={noteBody} segments={memoSegs} target={memoTarget} notify={notify} onSaved={onMemoSaved} onState={setMemoSave} />
            </>
          }
        />
      </div>
    )}
    </div>
    </div>
  </aside>
  );
}
