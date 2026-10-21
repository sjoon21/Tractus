// 녹음 중 남긴 메모·북마크 한 줄: 두 번 누르거나 연필로 글 고치기(메모만), 휴지통으로 지우기.
// 녹음 화면(녹음 프로그램 명령)과 노트(`tractus marks save`)가 함께 쓴다. 저장은 부모가 한다
import { useRef, useState, type ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GrowTextarea } from "@/components/ui/textarea";
import type { Memo } from "./lib";
import { MARK_EDIT_HINT, MARK_EDIT_LABEL, MEMO_TEXT_MAX, markDeleteLabel } from "./marks";

export function EditableMark({ memo, onSave, onDelete, children }: { memo: Memo; onSave: (text: string) => void; onDelete: () => void; children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const composing = useRef(false); // 한글 조합 중 Enter는 저장하지 않는다 (RecordView 메모 입력과 같은 이유)
  const done = useRef(false); // Enter로 끝낸 뒤 사라지며 생기는 blur가 한 번 더 저장하지 않게
  const isMemo = memo.kind === "memo";
  const open = () => {
    done.current = false;
    setEditing(true);
  };
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    if (value !== null && value.trim() !== (memo.text ?? "")) onSave(value);
  };

  return (
    <div className="group flex min-w-0 items-start gap-1">
      {editing ? (
        <GrowTextarea
          autoFocus
          className="flex-1 py-1.5"
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          defaultValue={memo.text ?? ""}
          maxLength={MEMO_TEXT_MAX}
          aria-label={MARK_EDIT_LABEL}
          title={MARK_EDIT_HINT}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composing.current && !e.nativeEvent.isComposing) {
              e.preventDefault();
              finish(e.currentTarget.value);
            } else if (e.key === "Escape") finish(null);
          }}
          onBlur={(e) => finish(e.currentTarget.value)}
        />
      ) : (
        <div className="min-w-0 flex-1" onDoubleClick={isMemo ? open : undefined} title={isMemo ? MARK_EDIT_HINT : undefined}>
          {children}
        </div>
      )}
      {!editing && (
        <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {isMemo && (
            <Button variant="ghost" size="icon-sm" aria-label={MARK_EDIT_LABEL} title={MARK_EDIT_LABEL} onClick={open}>
              <Pencil aria-hidden />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={markDeleteLabel(memo)} title={markDeleteLabel(memo)} onClick={onDelete}>
            <Trash2 aria-hidden />
          </Button>
        </span>
      )}
    </div>
  );
}
