import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAlign } from "./alignJobs";
import { api, errDetail, errText } from "./api";
import type { Notify, Seek } from "./App";
import { SPEAKER_HINT, SPEAKER_HINT_DISMISS, speakerHintVisible } from "./caps";
import { dismiss, isDismissed, speakerHintKey } from "./hintDismiss";
import { useCapabilities } from "./useCapabilities";
import {
  fmtTime,
  isImeKey,
  isMemoLineId,
  isTypingTarget,
  oneLine,
  SEEK_STEP,
  SEEK_STEP_BIG,
  segmentIndexAt,
  segText,
  speakerName,
  speakerStats,
  stepRate,
  transcriptRows,
  replayStart,
  type Segment,
} from "./lib";
import { ErrorDetail } from "./ErrorDetail";
import { locale, t } from "./i18n";
import type { DeleteTarget } from "./remove";
import { deleteMark, editMark } from "./marks";
import { PrintSheet } from "./PrintSheet";
import type { SummaryDoc } from "./summaries";
import { SpeakerMenu, SpeakersBar, type MenuTarget, type MergeAsk } from "./Speakers";
import { CoachMark } from "./CoachMark";
import { markOnboard } from "./onboarding";
import { FindBar } from "./TranscriptTools";
import { MemoEditor, TitleEditor, type MemoTarget } from "./MemoView";
import { NoteOrganizer } from "./NoteOrganizer";
import { LOCK_NOTICE, type AttachControls } from "./attach";
import { ConvertPanel } from "./ConvertPanel";
import { useConvertJob } from "./convertJobs";
import { CONVERT_FIRST, deleteBlockedWhileConverting, isRecorded, keptNotice, recordedStats, type ConvertControls } from "./recorded";
import { isMemo, memoLineNumbers, memoLineSegments, segmentSpans, type SaveState } from "./memo";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { PolishBar } from "./PolishControls";
import { RecordPill } from "./RecordPill";
import { usePlayback } from "./note/usePlayback";
import { useNote } from "./note/useNote";
import { NoteViewProvider, type NoteView } from "./note/NoteViewContext";
import { useFind } from "./note/useFind";
import { useNoteExport } from "./note/useNoteExport";
import { usePolishReview } from "./note/usePolishReview";
import { useReadingHighlights } from "./note/useReadingHighlights";
import { useRail } from "./note/useRail";
import { NotePlayer } from "@/components/note/NotePlayer";
import { NoteDock } from "@/components/note/NoteDock";
import { NoteHeader } from "@/components/note/NoteHeader";
import { NoteRail } from "@/components/note/NoteRail";
import { SegmentRow } from "@/components/note/SegmentRow";
import { MemoRow } from "@/components/note/MemoRow";
import { livePolish, nextSuggestion, pendingIds, suggestionMarks } from "./polish";

export function MeetingView({
  id,
  seek,
  onChanged,
  onEdited,
  notify,
  onDelete,
  attach,
  convert,
  summaryStale = false,
}: {
  id: string;
  seek?: Seek;
  onChanged: () => void;
  /** 내용을 저장했다: 코어가 올린 수정 시각 (사이드바의 `최근 수정 순`이 새로 고치기 전에도 맞도록) */
  onEdited?: (id: string, updatedAt: string) => void;
  notify: Notify;
  onDelete: (t: DeleteTarget) => void;
  /** 글만 있는 노트에 녹음 추가 (attach.ts). 없으면 단추도 잠금도 없다 */
  attach?: AttachControls;
  /** 변환 전 노트의 변환 제어 (recorded.ts). 없으면 변환 단추가 동작하지 않는다 */
  convert?: ConvertControls;
  /** 녹음을 방금 추가해 열었다: 요약이 있어도 아직 새 내용이 반영되지 않았다 */
  summaryStale?: boolean;
}) {
  const note = useNote({ id, summaryStale, notify, onEdited, onChanged });
  const { detail, commit, summaryRev, refresh: refreshNote } = note.data;
  const { editSeq, editSeqRef, editKinds } = note.seq;
  const { memoRev, onMemoSaved, sendToMemo } = note.memo;
  const { editing, serial, editError, setEditError } = note.queue;
  const { editSpeakers, renameSpeaker } = note.speakers;
  const { saveText, undo } = note.text;
  const { saveMarks, renameNote } = note;
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  // 메모 노트 (녹음 없이 직접 쓴 글): 본문 편집기가 화면의 가운데를 차지하고 플레이어·참석자·단어 싱크는 없다
  const memoNote = !!detail && isMemo(detail.info);
  const memoRef = useRef(false);
  memoRef.current = memoNote;
  const recordedRef = useRef(false); // 변환 전 노트: 대화가 없어 찾아 바꾸기를 열지 않는다
  recordedRef.current = !!detail && isRecorded(detail.info);
  const [memoSave, setMemoSave] = useState<SaveState>({ status: "saved" });
  const [memoPick, setMemoPick] = useState<MemoTarget | null>(null); // 요약 칩으로 고른 줄
  const list = useRef<HTMLOListElement>(null);
  const pb = usePlayback(detail?.audio_path);
  const { audio, pos, setDuration, playing, follow, setFollow, seekTo, setRate } = pb;

  const load = useCallback(async () => {
    try {
      const d = await api.loadMeeting(id);
      commit(d);
      setDuration(d.info.duration_sec);
    } catch (e) {
      setError({ text: errText(e), detail: errDetail(e) });
    }
  }, [id, commit]);
  useEffect(() => void load(), [load]);

  const [summaryRunning, setSummaryRunning] = useState(false); // 요약 탭이 요약을 만드는 중 (삭제를 막는다)
  const [enhanceRunning, setEnhanceRunning] = useState(false); // 메모 탭이 노트를 완성하는 중 (삭제를 막는다)
  const [minutesRunning, setMinutesRunning] = useState(false); // 회의록 탭이 회의록을 만드는 중 (삭제를 막는다)  // words-ok: 회의록은 문서 이름
  const [selectedSummary, setSelectedSummary] = useState<SummaryDoc | null>(null); // 요약 탭에서 고른 요약 (인쇄가 쓴다)
  const memoBusy = memoSave.status === "saving";

  const segments = detail?.segments ?? [];
  // 단어 타이밍 (6.1): 예전 회의는 words가 없다 → '단어 타이밍 만들기'. 코어는 정렬하는 동안 고친 문장을 덮어쓰지 않는다
  const hasWords = segments.some((s) => !!s.words?.length);
  // 작업 상태는 노트 ID별로 앱 전체 저장소에 있다(alignJobs.ts): 노트를 닫았다 다시 열어도 진행이 보이고 버튼이 다시 켜지지 않는다.
  // 끝났다는 알림(토스트)도 App이 한다. 이 화면은 열려 있는 동안 끝나면 다시 읽기만 한다
  const align = useAlign(id);
  const alignWasRunning = useRef(align.job.running);
  useEffect(() => {
    if (alignWasRunning.current && !align.job.running && !align.job.error) void load();
    alignWasRunning.current = align.job.running;
  }, [align.job.running, align.job.error, load]);
  // 변환 전 노트의 변환 (convertJobs.ts): 진행은 앱 저장소가 들고 있다. 끝나면 대화 내용을 다시 읽는다
  const convertJob = useConvertJob(id);
  const convertWasRunning = useRef(convertJob.running);
  useEffect(() => {
    if (convertWasRunning.current && !convertJob.running && !convertJob.error) void load();
    convertWasRunning.current = convertJob.running;
  }, [convertJob.running, convertJob.error, load]);
  const speakers = detail?.speakers ?? {};
  const stats = useMemo(() => speakerStats(segments, speakers), [detail]);
  const diarized = stats.length > 0;
  // 모델이 없어 못 쓰는 기능 (caps.ts): 단어 싱크 단추, 참석자 구분 안내
  const caps = useCapabilities();
  const alignGate = caps.can("align");
  const diarizeGate = caps.can("diarize");
  const [hintGone, setHintGone] = useState(() => isDismissed(speakerHintKey(id)));
  const slotOf = useMemo(() => new Map(stats.map((s) => [s.label, s.slot])), [stats]);
  // 화자 필터. 합치기로 그 화자가 사라지면 전체로 돌아가고, 같은 라벨이 다시 생겨도 되살리지 않는다
  const [only, setOnly] = useState<string | null>(null);
  const filter = only && stats.some((s) => s.label === only) ? only : null;
  useEffect(() => {
    if (only && !filter) setOnly(null);
  }, [only, filter]);
  const rows = useMemo(() => transcriptRows(segments, detail?.memos ?? [], filter), [detail, filter]);
  /** 화면에 보이는 세그먼트 (화자 필터 적용). 찾기와 무음 건너뛰기의 대상 */
  const visible = useMemo(() => (filter ? segments.filter((s) => s.speaker === filter) : segments), [detail, filter]);
  const visibleRef = useRef(visible); // 단축키(R) 처리기가 매번 다시 붙지 않게
  visibleRef.current = visible;

  // 화자 편집: 코어가 파일과 색인을 고치고(약 3초) 고친 회의를 돌려준다
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeAsk | null>(null);
  const { polish, deciding, polishLive, polishAt, jumpTo, decidePolish } = usePolishReview({ id, notify, note, setFollow, list });
  const [editingId, setEditingId] = useState<string | null>(null);
  const startEdit = useCallback((seg: Segment) => setEditingId(seg.id), []);
  const finishEdit = useCallback(
    (seg: Segment, raw: string | null) => {
      setEditingId(null);
      if (raw === null) return;
      const text = oneLine(raw);
      if (!text) return setEditError(t("빈 내용은 저장할 수 없습니다. 원래 내용을 그대로 둡니다"));
      if (text !== oneLine(segText(seg))) saveText([{ id: seg.id, text }], true);
    },
    [saveText],
  );

  const openChip = useCallback((seg: Segment, anchor: HTMLElement) => setMenu({ kind: "seg", seg, anchor }), []);
  const starts = useMemo(() => new Map(segments.map((s) => [s.id, s.start])), [detail]);
  const active = segmentIndexAt(segments, pos);

  const exp = useNoteExport({ id, detail, memoNote, selectedSummary, serial, notify });

  const railState = useRail(memoNote, memoRef, setMemoPick);
  const { railCollapsed, openMemoLine } = railState;
  const memoSegs = useMemo(() => memoLineSegments(detail?.note_memo), [detail?.note_memo]);
  const onCite = useCallback(
    (_m: string, segId: string, sec: number) => (memoRef.current || isMemoLineId(segId) ? openMemoLine(segId) : seekTo(sec)),
    [seekTo, openMemoLine],
  );

  // 검색 결과·시각 칩에서 들어온 시각으로 한 번만 이동 (재생은 사용자가 시작).
  // 요약을 만든 뒤 다시 읽어도(detail이 바뀌어도) 재생 위치를 되돌리지 않게 nonce로 거른다
  const appliedSeek = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || !seek || appliedSeek.current === seek.nonce) return;
    appliedSeek.current = seek.nonce;
    if (memoRef.current) return; // 메모 노트는 줄을 고른다 (아래 memoTarget)
    if (seek.segId && isMemoLineId(seek.segId)) return openMemoLine(seek.segId); // 녹음 노트의 메모 줄: 메모 탭에서 그 줄을 고른다
    const sec = seek.segId !== undefined ? (starts.get(seek.segId) ?? seek.t ?? 0) : (seek.t ?? 0);
    seekTo(sec, false);
  }, [detail, seek, starts, seekTo, openMemoLine]);

  const { find, setFind, setCur, findInput, matches, curMatch, curIndex, replace } = useFind({ visible, rows, editingId, list, saveText, setEditError, notify });
  const holding = !!(menu || renaming || merge || editingId);
  useReadingHighlights({ segments, rows, editingId, list, audio, playing, pos, active, follow, setFollow, holding, curMatch, detailKey: detail });

  // 단축키. e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
  // (bbc/react-transcript-editor defaultHotKeys.js, MIT 참고)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e) || memoRef.current) return; // 메모는 본문 편집기(textarea)가 키를 쓴다. 찾기·재생 단축키는 녹음 노트만
      if (e.metaKey && e.code === "KeyF") {
        if (recordedRef.current) return;
        e.preventDefault();
        // 이미 열려 있으면 찾을 말을 고른다. 새로 열면 입력이 autoFocus로 초점을 받는다
        if (findInput.current) findInput.current.select();
        else setFind({ q: "", r: "", glossary: false });
        return;
      }
      // 탭 목록처럼 키를 이미 쓴 위젯이 있으면 재생 단축키로 다시 쓰지 않는다
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = audio.current;
      if (!a) return;
      if (e.code === "Space" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (a.paused) void a.play().catch(() => {});
        else a.pause();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? SEEK_STEP_BIG : SEEK_STEP;
        seekTo(a.currentTime + (e.code === "ArrowLeft" ? -step : step), !a.paused);
      } else if (e.code === "KeyR" && !e.shiftKey) {
        // 직전 문장 다시 듣기: 지금 대화의 처음부터 (막 시작했으면 바로 앞 대화부터)
        const to = replayStart(visibleRef.current, a.currentTime);
        if (to !== null) {
          e.preventDefault();
          seekTo(to, true);
        }
      } else if (e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
        e.preventDefault();
        setRate((r) => stepRate(r, e.code === "Period" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekTo, undo]);

  useEffect(() => {
    if (detail?.info.sample) markOnboard("sampleOpened"); // 온보딩: 예시 노트를 열었다
  }, [detail?.info.sample]);

  if (error)
    return (
      <div className="page-error m-auto max-w-md p-8 text-center text-[13px] text-destructive">
        <p>{error.text}</p>
        <ErrorDetail detail={error.detail} />
      </div>
    );
  if (!detail) return <p className="page-loading m-0 grid h-full place-items-center text-[13px] text-muted-foreground">{t("불러오는 중…")}</p>;

  const { info } = detail;
  const recorded = isRecorded(info);
  const convertBlock = deleteBlockedWhileConverting(convert?.slot ?? (convertJob.running ? "running" : null));
  const created = info.created_at ? new Date(info.created_at) : null;
  // 메모: 대화 id → 본문 줄 번호 (요약·질문의 인용 칩 `n번째 줄`). 메모는 시각이 없어 시각 지도는 비운다
  const spans = memoNote ? segmentSpans(detail.body ?? "", segments) : null;
  // 줄 번호는 코어가 세그먼트에 싣는다(line). 없으면 본문에서 찾는다
  const memoNoteLines =
    spans &&
    new Map(
      segments.flatMap((s) => {
        const n = s.line ?? spans.get(s.id)?.line;
        return n ? [[s.id, n] as [string, number]] : [];
      }),
    );
  // 녹음 노트: 사용자가 적은 메모의 줄 ID(m0003) → 줄 번호 (요약·질문의 칩 `메모 3번째 줄`)
  const memoLines = memoNoteLines ?? memoLineNumbers(detail.note_memo);
  const rail = memoNote ? new Map<string, number>() : starts;
  const memoTarget: MemoTarget | null = memoNote
    ? [memoPick, seek?.segId ? { segId: seek.segId, nonce: seek.nonce } : null].reduce<MemoTarget | null>((a, b) => (!b || (a && a.nonce >= b.nonce) ? a : b), null)
    : memoPick;
  const noteBody = detail.note_memo?.body ?? "";
  const bodyChars = (detail.body ?? "").length;
  // AI 다듬기: 돌아가는 동안은 끝난 구간의 제안, 끝나면 polish.json. 지금 문장과 맞는 것만, 정하는 중인 것은 빼고
  const polishMap = new Map([...livePolish(segments, polish.running ? polish.live : (detail.polish ?? []))].filter(([k]) => !deciding.has(k)));
  polishLive.current = polishMap;
  const glowing = polish.running ? pendingIds(segments, polish.ranges) : null;
  const deleteWhy = convertBlock ?? (align.job.running || summaryRunning || enhanceRunning || minutesRunning || polish.running || attach?.lock ? t("작업이 끝난 뒤에 삭제할 수 있습니다") : null);
  const polishOff = recorded ? CONVERT_FIRST : editing || memoBusy ? t("저장이 끝난 뒤에 교정할 수 있습니다") : null;

  // 오른쪽 패널의 탭들이 함께 쓰는 노트 단위의 값 (note/NoteViewContext)
  const noteView: NoteView = {
    id,
    memoNote,
    recorded,
    hasSegments: segments.length > 0,
    notify,
    onChanged,
    summaryRev,
    refreshNote,
    edit: { editSeq, editSeqRef, editKinds },
    busy: editing || memoBusy,
    attach,
    seekTo,
    openMemoLine,
    starts,
    railStarts: rail,
    memoLines,
    setRunning: { summary: setSummaryRunning, minutes: setMinutesRunning, enhance: setEnhanceRunning },
  };

  return (
    <div className={cn("meeting grid h-full max-[1180px]:block max-[1180px]:overflow-y-auto", railCollapsed ? "is-rail-collapsed grid-cols-[minmax(0,1fr)_52px]" : "grid-cols-[minmax(0,1fr)_var(--rail)]")}>
      <article className="transcript-col relative col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto max-[1180px]:overflow-visible" onWheel={() => playing && setFollow(false)} onScroll={() => menu && setMenu(null)}>
        <NoteHeader
          id={id}
          created={created}
          title={info.title}
          memoNote={memoNote}
          recorded={recorded}
          hasSegments={segments.length > 0}
          hasWords={hasWords}
          hasAudio={!!detail.audio_path}
          align={align}
          alignGate={alignGate}
          attach={attach}
          exp={exp}
          deleteWhy={deleteWhy}
          onDelete={() => onDelete({ kind: "note", id, title: info.title, dir: info.dir, memo: memoNote, withMemo: !memoNote && memoLines.size > 0 })}
        />
        {find && (
          <FindBar
            state={find}
            onChange={setFind}
            count={matches.length}
            current={curIndex}
            onStep={(d) => setCur((curIndex + d + matches.length) % Math.max(1, matches.length))}
            onReplace={() => replace(false)}
            onReplaceAll={() => replace(true)}
            onClose={() => setFind(null)}
            inputRef={findInput}
          />
        )}
        <div className={cn("mx-auto flex w-full max-w-[860px] flex-1 flex-col px-6", memoNote ? "pb-10" : "")}>
        <header className={cn("meeting-head pt-4 pb-5", !memoNote && "mb-2 border-b border-border", !memoNote && "pl-[var(--time-col)]")}>
          <TitleEditor title={info.title} onSave={renameNote} onReject={(error) => notify({ text: error, error: true })} />
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            {memoNote ? (
              <p className="meeting-stats m-0 text-xs text-muted-foreground tabular-nums">
                {t("메모")} · {t("줄 {n}개", { n: info.segments })} · {t("{n}자", { n: bodyChars === 1 ? 1 : bodyChars.toLocaleString(locale()) })}
              </p>
            ) : recorded ? (
              <p className="meeting-stats m-0 text-xs text-muted-foreground tabular-nums">{recordedStats(info.duration_sec, detail.memos.length)}</p>
            ) : (
              <p className="meeting-stats m-0 text-xs text-muted-foreground tabular-nums" title={t("대화를 두 번 누르거나 Enter를 눌러 내용을 수정합니다")}>
                {fmtTime(info.duration_sec)} · {t("대화 {n}개", { n: info.segments })}
                {detail.memos.length > 0 && " · " + t("녹음 중 메모 {n}개", { n: detail.memos.length })}
              </p>
            )}
            <NoteOrganizer id={id} />
          </div>
          {!memoNote && !diarized && !diarizeGate.ok && speakerHintVisible({ diarize: diarizeGate, isRecording: true, segments: segments.length, speakers: stats.length, dismissed: hintGone }) && (
            <p className="speaker-hint mt-4 mb-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">
              <span className="mr-auto">{SPEAKER_HINT}</span>
              <Button variant="outline" size="sm" className="h-6" onClick={() => caps.fixAction(diarizeGate.fix)}>
                {diarizeGate.fix.label}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6"
                onClick={() => {
                  dismiss(speakerHintKey(id));
                  setHintGone(true);
                }}
              >
                {SPEAKER_HINT_DISMISS}
              </Button>
            </p>
          )}
          {/* 온보딩 ③: 처음 마주칠 때 하나씩 (tips.ts, 한 번에 하나) */}
          <CoachMark id="transcript" anchor=".seg-time" ready={!memoNote && !recorded && segments.length > 0} />
          <CoachMark id="speakers" anchor="#speakers-title" ready={!memoNote && diarized} />
          <CoachMark id="export" />
          {!memoNote && diarized && (
            <SpeakersBar
              stats={stats}
              attendees={detail.attendees}
              only={filter}
              onFilter={setOnly}
              busy={editing}
              renaming={renaming}
              merge={merge}
              onRename={(label, name, remember) => {
                setRenaming(null);
                renameSpeaker(label, name, remember);
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
              onConfirm={(label, name) => void editSpeakers({ op: "rename", label, name })}
              onDismiss={(label) => void editSpeakers({ op: "dismiss", label })}
            />
          )}
        </header>

        {memoNote && (
          <MemoEditor id={id} initial={detail.body ?? ""} savedBody={detail.body ?? ""} segments={segments} target={memoTarget} notify={notify} onSaved={onMemoSaved} onState={setMemoSave} locked={attach?.lock ? LOCK_NOTICE[attach.lock] : null} />
        )}
        {!memoNote && recorded && convert && <ConvertPanel id={id} job={convertJob} controls={convert} kept={keptNotice(info.tracks_bytes, info.created_at, Date.now())} />}
        {!memoNote && !recorded && segments.length === 0 && (
          <div className="transcript-empty mx-auto my-16 max-w-sm text-center" role="status">
            <p className="m-0 text-[13px] font-semibold">{t("인식된 대화가 없습니다")}</p>
            <p className="mt-1.5 mb-0 text-xs leading-relaxed text-muted-foreground">{t("이 녹음에서 말소리를 찾지 못했습니다. 아래 플레이어로 녹음된 소리를 확인해 보세요. 마이크가 멀었거나 녹음이 너무 짧았을 수 있습니다.")}</p>
          </div>
        )}
        {!memoNote && <PolishBar live={polishMap} marks={suggestionMarks(segments, polishMap)} running={polish.running} busy={deciding.size > 0} onDecide={decidePolish} onJump={(to) => { const n = to ?? nextSuggestion(segments, polishMap, polishAt.current); if (n) jumpTo(n); }} />}
        {!memoNote && <ol className={`transcript ${diarized ? "has-speakers" : ""} ${polish.running ? "is-polishing" : ""}`} ref={list}>
          {rows.map((r, i) =>
            r.kind === "seg" ? (
              <SegmentRow
                key={r.seg.id}
                seg={r.seg}
                index={r.index}
                isActive={r.index === active}
                isEditing={r.seg.id === editingId}
                isFind={r.seg.id === curMatch?.id}
                order={i}
                onSeek={seekTo}
                onEdit={startEdit}
                onEditDone={finishEdit}
                speaker={diarized ? speakerName(r.seg.speaker, speakers) : undefined}
                slot={slotOf.get(r.seg.speaker ?? "")}
                turnStart={!!r.turnStart}
                flow={!!r.flow}
                onChip={openChip}
                suggestion={polishMap.get(r.seg.id)}
                glowing={!!glowing?.has(r.seg.id)}
                deciding={deciding.size > 0}
                onDecide={decidePolish}
              />
            ) : (
              <MemoRow
                key={`m${i}`}
                memo={r.memo}
                onSeek={seekTo}
                onSave={(text) => saveMarks(editMark(detail.memos, detail.memos.indexOf(r.memo), text))}
                onDelete={() => saveMarks(deleteMark(detail.memos, detail.memos.indexOf(r.memo)))}
              />
            ),
          )}
        </ol>}
        </div>

        <div className="sticky bottom-0 z-10 mt-auto bg-background/90 backdrop-blur-md">
        <NoteDock rail={railState} memoNote={memoNote} recorded={recorded} hasSegments={segments.length > 0} polish={polish} polishOff={polishOff} polishAgain={(detail.polish?.length ?? 0) > 0} onFind={() => (findInput.current ? findInput.current.select() : setFind({ q: "", r: "", glossary: false }))} />
        {!memoNote && <NotePlayer pb={pb} audioPath={detail.audio_path} marks={detail.memos} visible={visible} filter={filter} editing={editing} editError={editError} />}
        </div>
        {!memoNote && menu && (
          <SpeakerMenu
            target={menu}
            stats={stats}
            attendees={detail.attendees}
            busy={editing}
            onClose={() => setMenu(null)}
            onSet={(segment, label) => void editSpeakers({ op: "set", segment, label })}
            onRename={renameSpeaker}
            onStartRename={setRenaming}
            onAskMerge={setMerge}
          />
        )}
        <RecordPill memoNote={memoNote} attach={attach} target={{ id, title: info.title }} />
      </article>
      {polish.running && <div aria-hidden className="polish-frame pointer-events-none col-start-1 row-start-1 max-[1180px]:hidden" />}

      <NoteViewProvider value={noteView}>
        <NoteRail
          rail={railState}
          onSelectSummary={setSelectedSummary}
          sendToMemo={sendToMemo}
          onCite={onCite}
          memoTab={{ target: memoTarget, body: noteBody, segments: memoSegs, rev: memoRev, onSaved: onMemoSaved, onState: setMemoSave }}
        />
      </NoteViewProvider>
      {exp.printable && <PrintSheet doc={exp.printable} />}
    </div>
  );
}
