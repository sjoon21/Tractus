// 대화 내용 한 줄 (MeetingView): 시각 · 문장 · 수정 배지 · 화자 칩 · 스마트 교정 제안. 한 줄만 다시 그리도록 memo로 감싼다.
import { memo, useEffect, useRef } from "react";
import { clickSeekTime, fmtTime, isImeKey, segText, type Segment } from "../../lib";
import { t } from "../../i18n";
import { SpeakerChip, spkStyle } from "../../Speakers";
import { SegmentEditor } from "../../TranscriptTools";
import { PolishDiff } from "../../PolishControls";
import { AI_EDITED, type PolishSuggestion } from "../../polish";

export const SegmentRow = memo(function SegmentRow({
  seg,
  index,
  isActive,
  isEditing,
  isFind,
  order,
  onSeek,
  onEdit,
  onEditDone,
  speaker,
  slot,
  turnStart,
  flow,
  onChip,
  suggestion,
  glowing,
  deciding,
  onDecide,
}: {
  seg: Segment;
  index: number;
  isActive: boolean;
  isEditing: boolean;
  /** 찾기의 현재 일치 (Highlight API가 없을 때도 보이게 행 테두리) */
  isFind: boolean;
  order: number;
  onSeek: (t: number) => void;
  onEdit: (seg: Segment) => void;
  onEditDone: (seg: Segment, raw: string | null) => void;
  /** 화자 있는 회의만: 표시 이름(화자 미상이면 null). 화자 없는 회의는 undefined → 칩을 그리지 않는다 */
  speaker?: string | null;
  slot?: number;
  turnStart: boolean;
  /** 같은 발언에서 바로 이어진 줄: 문단처럼 붙여 그린다 (lib.transcriptRows) */
  flow: boolean;
  onChip: (seg: Segment, anchor: HTMLElement) => void;
  /** AI 다듬기 제안 (줄 아래 diff + 받기·버리기) */
  suggestion?: PolishSuggestion;
  /** AI가 아직 보지 않은 줄: 은은하게 빛난다 */
  glowing: boolean;
  deciding: boolean;
  onDecide: (ids: string[], accept: boolean) => void;
}) {
  const diarized = speaker !== undefined;
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // 키보드로 편집을 끝내면 초점을 세그먼트로 돌려준다 (마우스로 다른 곳을 눌러 끝냈으면 그대로 둔다)
  useEffect(() => {
    if (!isEditing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [isEditing]);
  const edited = seg.corrected_text != null;
  return (
    <li
      className={`seg ${isActive ? "is-active" : ""} ${diarized && turnStart ? "is-turn" : ""} ${flow ? "is-flow" : ""} ${isFind ? "is-find" : ""} ${glowing ? "is-glow" : ""} ${suggestion ? "has-polish" : ""}`}
      data-seg={index}
      data-seg-id={seg.id}
      style={{ "--i": Math.min(order, 16), ...(diarized ? spkStyle(slot) : {}) } as React.CSSProperties}
    >
      {diarized && <SpeakerChip seg={seg} display={speaker} turnStart={turnStart} onOpen={onChip} />}
      {isEditing ? (
        <div className="seg-button is-editing">
          <time className="seg-time tnum">{fmtTime(seg.start)}</time>
          <SegmentEditor
            initial={segText(seg)}
            onDone={(raw, viaKey) => {
              refocus.current = viaKey;
              onEditDone(seg, raw);
            }}
          />
        </div>
      ) : (
        <button
          ref={button}
          className="seg-button"
          onClick={(e) => {
            // 드래그로 글을 골랐으면 이동하지 않는다. 키보드(detail 0)·시간 칸은 세그먼트 시작, 단어 타이밍이 있으면 누른 단어
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
            onSeek(clickSeekTime(seg, e.detail ? caretOffset(e.currentTarget, e.clientX, e.clientY) : null));
          }}
          onDoubleClick={() => onEdit(seg)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.metaKey || isImeKey(e.nativeEvent)) return;
            e.preventDefault();
            onEdit(seg);
          }}
          aria-current={isActive}
          aria-keyshortcuts="Enter"
          aria-description={t("Enter로 대화 내용 수정")}
        >
          <time className="seg-time tnum">{fmtTime(seg.start)}</time>
          <span className="seg-body">
            <span className="seg-text">{segText(seg)}</span>
            {edited && (
              <span className={`seg-edited ${seg.corrected_by === "ai" ? "is-ai" : ""}`} title={t("수정 전: {text}", { text: seg.text })}>
                {seg.corrected_by === "ai" ? AI_EDITED : t("수정됨")}
              </span>
            )}
          </span>
        </button>
      )}
      {suggestion && !isEditing && <PolishDiff s={suggestion} busy={deciding} onDecide={onDecide} />}
    </li>
  );
});

/** 누른 지점이 문장 글자 노드의 몇 번째 글자인지. 문장 밖(시간 칸)이거나 지원하지 않으면 null */
function caretOffset(button: HTMLElement, x: number, y: number): number | null {
  const node = button.querySelector(".seg-text")?.firstChild;
  const r = node ? document.caretRangeFromPoint?.(x, y) : null;
  return r && r.startContainer === node ? r.startOffset : null;
}
