// 글만 있는 노트 아래 가운데에 떠 있는 `녹음 추가` 단추 (docs/desktop.md §2.11). 노트 칸의 스크롤 영역 끝에 sticky로 붙는다
import { Mic } from "lucide-react";
import { ADD_RECORDING, ADD_TITLE, type AttachControls, type AttachTarget } from "./attach";
import { Button } from "@/components/ui/button";

/** 녹음 노트이거나, 제어가 없거나, 녹음·변환 중(lock: 노트에 LOCK_NOTICE가 보인다)이면 그리지 않는다 */
export function RecordPill({ memoNote, attach, target }: { memoNote: boolean; attach?: AttachControls; target: AttachTarget }) {
  if (!memoNote || !attach || attach.lock) return null;
  return (
    <div className="pointer-events-none sticky bottom-0 z-10 flex shrink-0 justify-center pt-2 pb-5">
      <Button variant="outline" size="lg" className="pointer-events-auto rounded-full shadow-pop" disabled={!!attach.blocked} title={attach.blocked ?? ADD_TITLE} onClick={() => attach.onRecord(target)}>
        <span aria-hidden className="size-2 rounded-full bg-rec" />
        <Mic aria-hidden />
        {ADD_RECORDING}
      </Button>
    </div>
  );
}
