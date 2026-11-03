// 오른쪽 패널의 AI 질문 탭: 변환 전 노트와 녹음 추가 중에는 안내만, 그 밖에는 AskPanel.
import { AskPanel } from "../../../AskPanel";
import { LOCK_NOTICE } from "../../../attach";
import { useNoteView } from "../../../note/NoteViewContext";
import { railNotice } from "../../../recorded";
import { PENDING } from "../styles";

export function AskTab({ onCite }: { onCite: (m: string, segId: string, sec: number) => void }) {
  const n = useNoteView();
  if (n.recorded)
    return (
      <p className={PENDING} role="status">
        {railNotice("ask", true)}
      </p>
    );
  if (n.attach?.lock)
    // 녹음을 추가하는 동안에는 묻지 않는다: 메모 노트가 녹음 노트로 바뀌는 중이라 근거(메모 줄 ID)가 곧 바뀐다
    return (
      <p className={PENDING} role="status">
        {LOCK_NOTICE[n.attach.lock]}
      </p>
    );
  return <AskPanel scope={{ kind: "meeting", id: n.id, starts: n.starts, memoLines: n.memoLines.size > 0 ? n.memoLines : undefined, memoNote: n.memoNote }} onCite={onCite} />;
}
