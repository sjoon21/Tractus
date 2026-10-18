// PDF 인쇄용 문서 (docs/roadmap.md §3 6.5). 화면 데이터를 인쇄 레이아웃에 맞게 다듬는다 (print.test.ts).
// 레이아웃은 PrintSheet.tsx + styles.css @media print, 인쇄는 macOS 인쇄 대화상자의 'PDF로 저장'.
import { t } from "./i18n";
import { isMemo, memoLineNumbers } from "./memo";
import { printSummary, type PrintSummary, type SummaryDoc } from "./summaries";
import { dayParts, evidenceLabel, fmtTime, segText, speakerName, speakerStats, type NoteMemo, type Segment, type Speakers, type SummaryLike } from "./lib";

export interface PrintDoc {
  title: string;
  /** "2026년 10월 2일 (금) 14:05" — created_at에 적힌 회의 현지 시각 그대로 */
  date: string;
  duration: string;
  speakers: string[];
  /** 메모 노트: 길이·시각·참석자가 없다 */
  memo: boolean;
  summary: {
    lead: string;
    decisions: { text: string; at: string | null }[];
    actions: { text: string; meta: string; at: string | null }[];
    topics: { text: string; at: string | null }[];
  } | null;
  /** 선택한 요약이 새 스키마(요약 유형)일 때 (옛 요약이면 null, summary가 대신 쓰인다) */
  generic: PrintSummary | null;
  /** speaker: 발언이 바뀔 때만 (화자 없는 회의는 늘 null) */
  rows: { id: string; time: string; speaker: string | null; text: string }[];
  /** 녹음 노트에 사용자가 적은 메모의 줄 (대화 내용 뒤 `메모` 섹션). 없으면 빈 목록 */
  memoLines: { id: string; text: string }[];
}

/** selected: 요약 탭에서 고른 요약 하나만 인쇄한다 (null이면 요약 없이). 생략하면 d.summary (옛 요약) */
export function printDoc(d: {
  info: { title: string; created_at: string; duration_sec: number; kind?: string };
  segments: Segment[];
  speakers: Speakers;
  summary: SummaryLike | null;
  note_memo?: NoteMemo | null;
}, selected?: SummaryDoc | null): PrintDoc {
  const p = dayParts(d.info.created_at.slice(0, 10));
  const hm = /T(\d{2}:\d{2})/.exec(d.info.created_at)?.[1];
  const memo = isMemo(d.info);
  // 메모는 시각이 없다: 근거 표시도 붙이지 않는다
  const starts = new Map(memo ? [] : d.segments.map((s) => [s.id, s.start]));
  const lineOf = memo ? undefined : memoLineNumbers(d.note_memo);
  const at = (ids: string[]) => evidenceLabel(ids, starts, lineOf);
  const speakers = speakerStats(d.segments, d.speakers).map((s) => s.display);
  const diarized = speakers.length > 0;
  const s = selected === undefined ? d.summary : (selected?.legacy ?? null);
  const generic = selected && !selected.legacy ? printSummary(selected, at) : null;
  return {
    title: d.info.title || t("제목 없음"),
    date: p.weekday ? t("{month} {day}일 ({weekday})", p) + (hm ? ` ${hm}` : "") : "",
    duration: memo ? "" : fmtTime(d.info.duration_sec),
    speakers,
    memo,
    summary: s && {
      lead: s.summary,
      decisions: s.decisions.map((x) => ({ text: x.text, at: at(x.segment_ids) })),
      actions: s.action_items.map((x) => ({ text: x.task, meta: [x.owner, x.due].filter(Boolean).join(" · "), at: at(x.segment_ids) })),
      topics: s.topics.map((x) => ({ text: x.title, at: at(x.segment_ids) })),
    },
    generic,
    rows: d.segments.map((seg, i) => {
      const turn = diarized && (i === 0 || (d.segments[i - 1].speaker ?? null) !== (seg.speaker ?? null));
      return { id: seg.id, time: memo ? "" : fmtTime(seg.start), speaker: turn ? (speakerName(seg.speaker, d.speakers) ?? t("알 수 없음")) : null, text: segText(seg) };
    }),
    memoLines: memo ? [] : (d.note_memo?.lines ?? []).map((l) => ({ id: l.id, text: l.text })),
  };
}
