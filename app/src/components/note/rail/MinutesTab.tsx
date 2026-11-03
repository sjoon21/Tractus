// 오른쪽 패널의 회의록 탭 (녹음 노트만).  // words-ok: 회의록은 문서 이름
import { t } from "../../../i18n";
import { flushMemos } from "../../../memo";
import { MinutesPanel } from "../../../MinutesPanel";
import { useNoteView } from "../../../note/NoteViewContext";
import { makeBlockedReason } from "../../../recorded";
import { TimeChip } from "../TimeChip";

export function MinutesTab() {
  const n = useNoteView();
  return (
    <MinutesPanel
      id={n.id}
      rev={n.summaryRev}
      disabled={makeBlockedReason(n, t("저장이 끝난 뒤에 만들 수 있습니다"))}
      prepare={flushMemos}
      editSeq={n.edit.editSeq}
      editSeqRef={n.edit.editSeqRef}
      editKinds={n.edit.editKinds}
      chip={(ids) => <TimeChip ids={ids} starts={n.railStarts} onSeek={n.seekTo} memo={n.memoLines.size > 0 ? { lines: n.memoLines, onPick: n.openMemoLine, tagged: true } : null} />}
      notify={n.notify}
      onRunning={n.setRunning.minutes}
      onChanged={() => {
        n.refreshNote();
        n.onChanged();
      }}
    />
  );
}
