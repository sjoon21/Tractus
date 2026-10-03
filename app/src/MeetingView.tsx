import { convertFileSrc } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, useJob, type MeetingDetail, type Summary } from "./api";
import type { Seek } from "./App";
import { evidenceStart, fmtTime, interleave, isTypingTarget, segmentIndexAt, STAGE_LABEL, type Memo, type Segment } from "./lib";

export function MeetingView({ id, seek, onChanged }: { id: string; seek?: Seek; onChanged: () => void }) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.loadMeeting(id);
      setDetail(d);
      setDuration(d.info.duration_sec);
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const summarize = useJob(() => {
    void load();
    onChanged();
  });

  const segments = detail?.segments ?? [];
  const rows = useMemo(() => interleave(segments, detail?.memos ?? []), [detail]);
  const starts = useMemo(() => new Map(segments.map((s) => [s.id, s.start])), [detail]);
  const active = segmentIndexAt(segments, t);

  const seekTo = useCallback((sec: number, play = true) => {
    setT(sec);
    setFollow(true);
    const a = audio.current;
    if (!a) return;
    a.currentTime = sec;
    if (play) void a.play().catch(() => {});
  }, []);

  // 검색 결과·시각 칩에서 들어온 시각으로 한 번만 이동 (재생은 사용자가 시작).
  // 요약을 만든 뒤 다시 읽어도(detail이 바뀌어도) 재생 위치를 되돌리지 않게 nonce로 거른다
  const appliedSeek = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || !seek || appliedSeek.current === seek.nonce) return;
    appliedSeek.current = seek.nonce;
    const sec = seek.segId !== undefined ? (starts.get(seek.segId) ?? seek.t ?? 0) : (seek.t ?? 0);
    seekTo(sec, false);
  }, [detail, seek, starts, seekTo]);

  // 현재 세그먼트 자동 스크롤. 사용자가 직접 스크롤하면 멈추고 "현재 위치로" 버튼을 보인다
  useEffect(() => {
    if (!follow || active < 0) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-seg="${active}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.top < 80 || box.bottom > window.innerHeight - 140) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [active, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTypingTarget(e.target) || e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      const a = audio.current;
      if (!a) return;
      if (a.paused) void a.play().catch(() => {});
      else a.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (error) return <p className="page-error">{error}</p>;
  if (!detail) return <p className="page-loading">불러오는 중…</p>;

  const { info, summary } = detail;
  const created = info.created_at ? new Date(info.created_at) : null;

  return (
    <div className="meeting">
      <article className="transcript-col" onWheel={() => playing && setFollow(false)}>
        <header className="meeting-head">
          <p className="eyebrow tnum">
            {created?.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
            {created && " · "}
            {created?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
          </p>
          <h1>{info.title || "제목 없음"}</h1>
          <p className="meeting-stats tnum">
            {fmtTime(info.duration_sec)} · 세그먼트 {info.segments}개{detail.memos.length > 0 && ` · 메모 ${detail.memos.length}개`}
          </p>
        </header>

        <ol className="transcript" ref={list}>
          {rows.map((r, i) =>
            r.kind === "seg" ? (
              <SegmentRow key={r.seg.id} seg={r.seg} index={r.index} isActive={r.index === active} order={i} onSeek={seekTo} />
            ) : (
              <MemoRow key={`m${i}`} memo={r.memo} onSeek={seekTo} />
            ),
          )}
        </ol>

        <div className="player" role="group" aria-label="오디오 플레이어">
          {detail.audio_path ? (
            <audio
              ref={audio}
              src={convertFileSrc(detail.audio_path, "media")}
              preload="metadata"
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={() => setAudioError("오디오를 재생할 수 없습니다")}
            />
          ) : null}
          <button
            className="play-button"
            onClick={() => (audio.current?.paused ? void audio.current.play().catch(() => {}) : audio.current?.pause())}
            disabled={!detail.audio_path || !!audioError}
            aria-label={playing ? "일시정지" : "재생"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <time className="tnum player-time">
            {fmtTime(t)} <span>/ {fmtTime(duration)}</span>
          </time>
          <div className="scrub" hidden={!detail.audio_path}>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(t, duration || 1)}
              onChange={(e) => seekTo(Number(e.target.value), playing)}
              aria-label="재생 위치"
              style={{ "--p": `${duration ? (t / duration) * 100 : 0}%` } as React.CSSProperties}
            />
            {detail.memos.map((m, i) => (
              <span key={i} className={`scrub-mark is-${m.kind}`} style={{ left: `${duration ? (m.t / duration) * 100 : 0}%` }} aria-hidden />
            ))}
          </div>
          {!follow && playing && (
            <button className="text-button follow-button" onClick={() => setFollow(true)}>
              현재 위치로
            </button>
          )}
          {(audioError || !detail.audio_path) && <span className="player-note">{audioError ?? "오디오 파일이 없습니다"}</span>}
        </div>
      </article>

      <aside className="summary-col" aria-label="요약">
        {summary ? (
          <SummaryPanel summary={summary} starts={starts} onSeek={seekTo} />
        ) : (
          <div className="summary-empty">
            <p className="eyebrow">요약</p>
            <p>아직 요약이 없습니다. 결정 사항과 할 일을 근거 세그먼트와 함께 뽑습니다.</p>
            <button className="primary-button" disabled={summarize.job.running} onClick={() => summarize.startJob("summarize", info.id)}>
              {summarize.job.running ? (STAGE_LABEL[summarize.job.stage ?? ""] ?? "시작하는 중…") : "요약 만들기"}
            </button>
            {summarize.job.error && <p className="inline-error">{summarize.job.error}</p>}
          </div>
        )}
      </aside>
    </div>
  );
}

const SegmentRow = memo(function SegmentRow({
  seg,
  index,
  isActive,
  order,
  onSeek,
}: {
  seg: Segment;
  index: number;
  isActive: boolean;
  order: number;
  onSeek: (t: number) => void;
}) {
  return (
    <li className={`seg ${isActive ? "is-active" : ""}`} data-seg={index} style={{ "--i": Math.min(order, 16) } as React.CSSProperties}>
      <button className="seg-button" onClick={() => onSeek(seg.start)} aria-current={isActive}>
        <time className="seg-time tnum">{fmtTime(seg.start)}</time>
        <span className="seg-text">{seg.corrected_text || seg.text}</span>
      </button>
    </li>
  );
});

function MemoRow({ memo: m, onSeek }: { memo: Memo; onSeek: (t: number) => void }) {
  const isBookmark = m.kind === "bookmark";
  return (
    <li className={`memo is-${isBookmark ? "bookmark" : "memo"}`}>
      <button className="seg-button" onClick={() => onSeek(m.t)}>
        <time className="seg-time tnum">{fmtTime(m.t)}</time>
        <span className="memo-body">
          <span className="memo-kind">{isBookmark ? "북마크" : "메모"}</span>
          {m.text}
        </span>
      </button>
    </li>
  );
}

function TimeChip({ ids, starts, onSeek }: { ids: string[]; starts: Map<string, number>; onSeek: (t: number) => void }) {
  const t = evidenceStart(ids, starts);
  if (t === null) return null;
  return (
    <button className="time-chip tnum" onClick={() => onSeek(t)} title={`근거: ${ids.join(", ")}`}>
      {fmtTime(t)}
    </button>
  );
}

function SummaryPanel({ summary, starts, onSeek }: { summary: Summary; starts: Map<string, number>; onSeek: (t: number) => void }) {
  return (
    <div className="summary">
      <p className="eyebrow">요약</p>
      <p className="summary-lead">{summary.summary}</p>

      {summary.decisions.length > 0 && (
        <section>
          <h2 className="rail-heading">
            결정 사항 <span className="tnum">{summary.decisions.length}</span>
          </h2>
          <ol className="rail-list">
            {summary.decisions.map((d, i) => (
              <li key={i}>
                <span>{d.text}</span>
                <TimeChip ids={d.segment_ids} starts={starts} onSeek={onSeek} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {summary.action_items.length > 0 && (
        <section>
          <h2 className="rail-heading">
            할 일 <span className="tnum">{summary.action_items.length}</span>
          </h2>
          <ul className="rail-list is-actions">
            {summary.action_items.map((a, i) => (
              <li key={i}>
                <span>
                  {a.task}
                  {(a.owner || a.due) && (
                    <span className="action-meta">
                      {a.owner && <span>{a.owner}</span>}
                      {a.due && <span>{a.due}</span>}
                    </span>
                  )}
                </span>
                <TimeChip ids={a.segment_ids} starts={starts} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.topics.length > 0 && (
        <section>
          <h2 className="rail-heading">주제</h2>
          <ul className="topic-list">
            {summary.topics.map((tp, i) => (
              <li key={i}>
                <TimeChip ids={tp.segment_ids} starts={starts} onSeek={onSeek} />
                <span>{tp.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.model && <p className="summary-source">{[summary.provider, summary.model].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" />
  </svg>
);
