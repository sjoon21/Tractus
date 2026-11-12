// 오른쪽 패널의 요약 탭: 변환 전 노트에는 안내만, 그 밖에는 SummariesPanel.
import { flushMemos } from "../../../memo";
import { useNoteView } from "../../../note/NoteViewContext";
import { railNotice } from "../../../recorded";
import { SummariesPanel } from "../../../SummariesPanel";
import type { SummaryDoc } from "../../../summaries";
import { PENDING } from "../styles";
import { TimeChip } from "../TimeChip";

export function SummaryTab({ onSelect, sendToMemo }: { onSelect: (d: SummaryDoc | null) => void; sendToMemo: (markdown: string) => Promise<void> }) {
  const n = useNoteView();
  if (n.recorded)
    return (
      <p className={PENDING} role="status">
        {railNotice("summary", true)}
      </p>
    );
  return (
    <SummariesPanel
      id={n.id}
      memoNote={n.memoNote}
      rev={n.summaryRev}
      prepare={async () => !n.attach?.lock && (await flushMemos())} // 메모(메모 노트의 본문, 녹음 노트의 메모 탭)는 쓰던 글을 먼저 저장한다 (요약이 저장된 글을 읽는다). 저장하지 못하면 요약하지 않는다 (오류는 편집기가 보인다)
      blocked={n.busy || !!n.attach?.lock}
      editSeq={n.edit.editSeq}
      editSeqRef={n.edit.editSeqRef}
      editKinds={n.edit.editKinds}
      chip={(ids) => <TimeChip ids={ids} starts={n.railStarts} onSeek={n.seekTo} memo={n.memoLines.size > 0 ? { lines: n.memoLines, onPick: n.openMemoLine, tagged: !n.memoNote } : null} />}
      notify={n.notify}
      onRunning={n.setRunning.summary}
      onSelect={onSelect}
      onChanged={n.onChanged}
      onToMemo={n.memoNote || n.recorded ? undefined : sendToMemo}
    />
  );
}
