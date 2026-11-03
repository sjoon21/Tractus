// 오른쪽 패널의 메모 탭 (녹음 노트만): 노트 완성 + 내가 적는 메모 편집기.
import type { MeetingDetail } from "../../../api";
import { EnhancedNote } from "../../../EnhancedNote";
import { t } from "../../../i18n";
import type { Segment } from "../../../lib";
import { flushMemos, type SaveState } from "../../../memo";
import { MemoEditor, type MemoTarget } from "../../../MemoView";
import { useNoteView } from "../../../note/NoteViewContext";
import { makeBlockedReason } from "../../../recorded";
import { TimeChip } from "../TimeChip";

export function MemoTab({
  target,
  body,
  segments,
  rev,
  onSaved,
  onState,
}: {
  /** 요약 칩·검색으로 고른 메모 줄 */
  target: MemoTarget | null;
  /** 내가 적은 메모 본문 */
  body: string;
  segments: Segment[];
  /** 편집기를 새 본문으로 다시 여는 key (요약을 메모에 붙였을 때 오른다) */
  rev: number;
  onSaved: (m: MeetingDetail) => void;
  onState: (s: SaveState) => void;
}) {
  const n = useNoteView();
  return (
    <EnhancedNote
      id={n.id}
      rev={n.summaryRev}
      disabled={makeBlockedReason(n, t("저장이 끝난 뒤에 완성할 수 있습니다"))}
      prepare={flushMemos}
      editSeq={n.edit.editSeq}
      editSeqRef={n.edit.editSeqRef}
      editKinds={n.edit.editKinds}
      chip={(ids) => <TimeChip ids={ids} starts={n.railStarts} onSeek={n.seekTo} />}
      onSeek={(sec) => n.seekTo(sec)}
      onMade={() => {
        n.refreshNote();
        n.onChanged();
      }}
      onRunning={n.setRunning.enhance}
      notify={n.notify}
      pick={target}
      mine={
        <>
          <p className="mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{t("내가 적는 메모입니다. 요약과 AI 질문에 대화 내용과 함께 쓰입니다.")}</p>
          <MemoEditor key={rev} variant="rail" id={n.id} initial={body} savedBody={body} segments={segments} target={target} notify={n.notify} onSaved={onSaved} onState={onState} />
        </>
      }
    />
  );
}
