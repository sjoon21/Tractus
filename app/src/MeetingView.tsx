import { convertFileSrc } from "@tauri-apps/api/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, useJob, type MeetingDetail, type SpeakerEdit, type Summary } from "./api";
import type { Seek } from "./App";
import { evidenceStart, fmtTime, isTypingTarget, segmentIndexAt, speakerName, speakerStats, STAGE_LABEL, transcriptRows, type Memo, type Segment } from "./lib";
import { SpeakerChip, SpeakerMenu, SpeakersBar, spkStyle, type MenuTarget, type MergeAsk } from "./Speakers";

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
  const speakers = detail?.speakers ?? {};
  const stats = useMemo(() => speakerStats(segments, speakers), [detail]);
  const diarized = stats.length > 0;
  const slotOf = useMemo(() => new Map(stats.map((s) => [s.label, s.slot])), [stats]);
  // 화자 필터. 합치기로 그 화자가 사라지면 전체로 돌아가고, 같은 라벨이 다시 생겨도 되살리지 않는다
  const [only, setOnly] = useState<string | null>(null);
  const filter = only && stats.some((s) => s.label === only) ? only : null;
  useEffect(() => {
    if (only && !filter) setOnly(null);
  }, [only, filter]);
  const rows = useMemo(() => transcriptRows(segments, detail?.memos ?? [], filter), [detail, filter]);

  // 화자 편집: 코어가 파일과 색인을 고치고(약 3초) 고친 회의를 돌려준다
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeAsk | null>(null);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // 편집은 한 번에 하나만: 코어가 transcript.json을 잠금 없이 읽고-고쳐-쓴다
  const inFlight = useRef(false);
  const editSpeakers = useCallback(
    async (edit: SpeakerEdit) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setEditing(true);
      setEditError(null);
      try {
        setDetail(await api.editSpeakers(id, edit));
      } catch (e) {
        setEditError(errText(e));
      } finally {
        inFlight.current = false;
        setEditing(false);
      }
    },
    [id],
  );
  const openChip = useCallback((seg: Segment, anchor: HTMLElement) => setMenu({ kind: "seg", seg, anchor }), []);
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

  // 현재 세그먼트 자동 스크롤. 사용자가 직접 스크롤하면 멈추고 "현재 위치로" 버튼을 보인다.
  // 화자를 고치는 동안(메뉴·이름 입력·합치기 확인)은 쉰다: 스크롤하면 메뉴가 닫히고 입력하던 이름이 사라진다
  const holding = !!(menu || renaming || merge);
  useEffect(() => {
    if (!follow || active < 0 || holding) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-seg="${active}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.top < 80 || box.bottom > window.innerHeight - 140) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [active, follow, holding]);

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
      <article className="transcript-col" onWheel={() => playing && setFollow(false)} onScroll={() => menu && setMenu(null)}>
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
          {diarized && (
            <SpeakersBar
              stats={stats}
              only={filter}
              onFilter={setOnly}
              busy={editing}
              renaming={renaming}
              merge={merge}
              onRename={(label, name) => {
                setRenaming(null);
                void editSpeakers({ op: "rename", label, name });
              }}
              onStartRename={setRenaming}
              onCancelRename={() => setRenaming(null)}
              onAskMerge={setMerge}
              onMerge={() => {
                if (merge) void editSpeakers({ op: "merge", ...merge });
                setMerge(null);
              }}
              onCancelMerge={() => setMerge(null)}
              onMenu={(label, anchor) => setMenu({ kind: "speaker", label, anchor })}
            />
          )}
        </header>

        {segments.length === 0 && (
          <div className="transcript-empty" role="status">
            <p className="eyebrow">전사 없음</p>
            <p>이 녹음에서 말소리를 찾지 못했습니다. 아래 플레이어로 녹음된 소리를 확인해 보세요. 마이크가 멀었거나 녹음이 너무 짧았을 수 있습니다.</p>
          </div>
        )}
        <ol className={`transcript ${diarized ? "has-speakers" : ""}`} ref={list}>
          {rows.map((r, i) =>
            r.kind === "seg" ? (
              <SegmentRow
                key={r.seg.id}
                seg={r.seg}
                index={r.index}
                isActive={r.index === active}
                order={i}
                onSeek={seekTo}
                speaker={diarized ? speakerName(r.seg.speaker, speakers) : undefined}
                slot={slotOf.get(r.seg.speaker ?? "")}
                turnStart={!!r.turnStart}
                onChip={openChip}
              />
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
          <span className={`player-note ${editError ? "inline-error" : ""}`} role="status">
            {editing ? "화자 고치는 중…" : editError}
          </span>
        </div>
        {menu && (
          <SpeakerMenu
            target={menu}
            stats={stats}
            busy={editing}
            onClose={() => setMenu(null)}
            onSet={(segment, label) => void editSpeakers({ op: "set", segment, label })}
            onRename={(label, name) => void editSpeakers({ op: "rename", label, name })}
            onStartRename={setRenaming}
            onAskMerge={setMerge}
          />
        )}
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
  speaker,
  slot,
  turnStart,
  onChip,
}: {
  seg: Segment;
  index: number;
  isActive: boolean;
  order: number;
  onSeek: (t: number) => void;
  /** 화자 있는 회의만: 표시 이름(화자 미상이면 null). 화자 없는 회의는 undefined → 칩을 그리지 않는다 */
  speaker?: string | null;
  slot?: number;
  turnStart: boolean;
  onChip: (seg: Segment, anchor: HTMLElement) => void;
}) {
  const diarized = speaker !== undefined;
  return (
    <li
      className={`seg ${isActive ? "is-active" : ""} ${diarized && turnStart ? "is-turn" : ""}`}
      data-seg={index}
      style={{ "--i": Math.min(order, 16), ...(diarized ? spkStyle(slot) : {}) } as React.CSSProperties}
    >
      {diarized && <SpeakerChip seg={seg} display={speaker} turnStart={turnStart} onOpen={onChip} />}
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
