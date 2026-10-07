// PDF 인쇄용 문서 (docs/roadmap.md §3 6.5). 화면 데이터를 인쇄 레이아웃에 맞게 다듬는다 (print.test.ts).
// 레이아웃은 PrintSheet.tsx + styles.css @media print, 인쇄는 macOS 인쇄 대화상자의 'PDF로 저장'.
import { dayParts, evidenceStart, fmtTime, segText, speakerName, speakerStats, type Segment, type Speakers, type SummaryLike } from "./lib";

export interface PrintDoc {
  title: string;
  /** "2026년 10월 2일 (금) 14:05" — created_at에 적힌 회의 현지 시각 그대로 */
  date: string;
  duration: string;
  speakers: string[];
  summary: {
    lead: string;
    decisions: { text: string; at: string | null }[];
    actions: { text: string; meta: string; at: string | null }[];
    topics: { text: string; at: string | null }[];
  } | null;
  /** speaker: 발언이 바뀔 때만 (화자 없는 회의는 늘 null) */
  rows: { id: string; time: string; speaker: string | null; text: string }[];
}

export function printDoc(d: {
  info: { title: string; created_at: string; duration_sec: number };
  segments: Segment[];
  speakers: Speakers;
  summary: SummaryLike | null;
}): PrintDoc {
  const p = dayParts(d.info.created_at.slice(0, 10));
  const hm = /T(\d{2}:\d{2})/.exec(d.info.created_at)?.[1];
  const starts = new Map(d.segments.map((s) => [s.id, s.start]));
  const at = (ids: string[]) => {
    const t = evidenceStart(ids, starts);
    return t === null ? null : fmtTime(t);
  };
  const speakers = speakerStats(d.segments, d.speakers).map((s) => s.display);
  const diarized = speakers.length > 0;
  const s = d.summary;
  return {
    title: d.info.title || "제목 없음",
    date: p.weekday ? `${p.month} ${p.day}일 (${p.weekday})${hm ? ` ${hm}` : ""}` : "",
    duration: fmtTime(d.info.duration_sec),
    speakers,
    summary: s && {
      lead: s.summary,
      decisions: s.decisions.map((x) => ({ text: x.text, at: at(x.segment_ids) })),
      actions: s.action_items.map((x) => ({ text: x.task, meta: [x.owner, x.due].filter(Boolean).join(" · "), at: at(x.segment_ids) })),
      topics: s.topics.map((x) => ({ text: x.title, at: at(x.segment_ids) })),
    },
    rows: d.segments.map((seg, i) => {
      const turn = diarized && (i === 0 || (d.segments[i - 1].speaker ?? null) !== (seg.speaker ?? null));
      return { id: seg.id, time: fmtTime(seg.start), speaker: turn ? (speakerName(seg.speaker, d.speakers) ?? "알 수 없음") : null, text: segText(seg) };
    }),
  };
}
