// 요약·질문 답의 근거 칩: 누르면 그 대화의 시각으로, 메모 줄이면 편집기의 그 줄로 간다
import { CHIP } from "@/components/panel/chip";
import { citeLabel } from "../../ask";
import { evidenceStart, fmtTime } from "../../lib";
import { t } from "../../i18n";

/**
 * 메모의 근거 표시: 시각 대신 본문의 줄 (`3번째 줄`). 누르면 편집기에서 그 줄을 고른다.
 * tagged: 녹음 노트의 메모 줄 (`메모 3번째 줄`). 같은 항목에 시각 칩과 함께 나올 수 있어 `메모`를 붙인다
 */
export type MemoChips = { lines: Map<string, number>; onPick: (segId: string) => void; tagged?: boolean };

export function TimeChip({ ids, starts, onSeek, memo }: { ids: string[]; starts: Map<string, number>; onSeek: (t: number) => void; memo?: MemoChips | null }) {
  // 메모 줄 중 가장 앞의 줄 하나
  const line = memo && ids.filter((i) => memo.lines.has(i)).sort((a, b) => (memo.lines.get(a) ?? 0) - (memo.lines.get(b) ?? 0))[0];
  const at = evidenceStart(ids, starts); // 메모 노트는 시각이 없어(starts가 비어 있다) null
  if (at === null && !line) return null;
  return (
    <>
      {at !== null && (
        <button className={CHIP} onClick={() => onSeek(at)} title={t("근거 대화로 이동 ({time})", { time: fmtTime(at) })}>
          {fmtTime(at)}
        </button>
      )}
      {memo && line && (
        <button className={CHIP} onClick={() => memo.onPick(line)} title={t("메모의 줄로 이동")}>
          {citeLabel(0, { memo: true, line: memo.lines.get(line), tagged: memo.tagged })}
        </button>
      )}
    </>
  );
}
