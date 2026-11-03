import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAlign } from "./alignJobs";
import { api, errDetail, errText } from "./api";
import type { Notify, Seek } from "./App";
import { OK, SPEAKER_HINT, SPEAKER_HINT_DISMISS, speakerHintVisible } from "./caps";
import { GatedButton } from "./GatedButton";
import { dismiss, isDismissed, speakerHintKey } from "./hintDismiss";
import { useCapabilities } from "./useCapabilities";
import {
  baseName,
  exportFilename,
  findMatches,
  fmtTime,
  inverseEdits,
  isImeKey,
  isMemoLineId,
  isTypingTarget,
  oneLine,
  replaceEdits,
  SEEK_STEP,
  SEEK_STEP_BIG,
  segmentIndexAt,
  segText,
  speakerName,
  speakerStats,
  STAGE_LABEL,
  stepRate,
  tokenOffsets,
  transcriptRows,
  usableWords,
  replayStart,
  wordClock,
  wordIndexAt,
  type EXPORT_FORMATS,
  type Match,
  type Segment,
} from "./lib";
import { AskPanel } from "./AskPanel";
import { editQueue } from "./editQueue";
import { ErrorDetail } from "./ErrorDetail";
import { clock, getLang, locale, t } from "./i18n";
import { indexer } from "./indexer";
import { printDoc } from "./print";
import { EDIT_BLOCKED, type DeleteTarget } from "./remove";
import { deleteMark, editMark } from "./marks";
import { PrintSheet } from "./PrintSheet";
import { SummariesPanel } from "./SummariesPanel";
import type { SummaryDoc } from "./summaries";
import { SpeakerMenu, SpeakersBar, type MenuTarget, type MergeAsk } from "./Speakers";
import { sendToObsidian } from "./obsidian";
import { CoachMark } from "./CoachMark";
import { markOnboard } from "./onboarding";
import { ExportMenu, FindBar, type FindState } from "./TranscriptTools";
import { ExportDialog, type ExportPick } from "./ExportDialog";
import { exportItems, PICK_FORMATS, type ExportItem } from "./exportPick";
import { MemoEditor, TitleEditor, type MemoTarget } from "./MemoView";
import { NoteOrganizer } from "./NoteOrganizer";
import { ADD_FILE, ADD_FILE_TITLE, LOCK_NOTICE, type AttachControls } from "./attach";
import { ConvertPanel } from "./ConvertPanel";
import { useConvertJob } from "./convertJobs";
import { CONVERT_FIRST, deleteBlockedWhileConverting, isRecorded, keptNotice, railNotice, RECORDED_BADGE, recordedStats, type ConvertControls } from "./recorded";
import { exportFormatsFor, flushMemos, isMemo, memoLineNumbers, memoLineSegments, segmentSpans, type SaveState } from "./memo";
import { RAIL_LABEL, railLabel } from "./rail";
import { PanelResizer, PanelToggle } from "./PanelToggle";
import { AudioLines, MoreHorizontal, Upload } from "lucide-react";
import { ItemMenu, Popover } from "./Popover";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { EnhancedNote } from "./EnhancedNote";
import { MinutesPanel } from "./MinutesPanel";
import { PolishBar, usePolish } from "./PolishControls";
import { RecordPill } from "./RecordPill";
import { usePlayback } from "./note/usePlayback";
import { useNoteEditing } from "./note/useNoteEditing";
import { useRail } from "./note/useRail";
import { NotePlayer } from "@/components/note/NotePlayer";
import { NoteDock } from "@/components/note/NoteDock";
import { SegmentRow } from "@/components/note/SegmentRow";
import { MemoRow } from "@/components/note/MemoRow";
import { TimeChip } from "@/components/note/TimeChip";
import { PENDING } from "@/components/note/styles";
import { livePolish, nextSuggestion, NO_SUGGESTIONS, pendingIds, suggestionMarks, termsFromSuggestions, type PolishSuggestion } from "./polish";

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
  const {
    confirmed, commit, detail, summaryRev, setSummaryRev,
    editSeq, editSeqRef, editKinds, bumpEdit, onMemoSaved,
    memoRev, sendToMemo, renameNote,
    editing, serial, editError, setEditError, saveMarks, editSpeakers, renameSpeaker,
    undoStack, suggestTerms, saveText, undo,   } = useNoteEditing({ id, summaryStale, notify, onEdited, onChanged });
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
  // AI 다듬기 (docs/design/transcript-polish.md): 제안은 polish.json이 원본이다. 끝나면 노트를 다시 읽는다
  const polish = usePolish(id, notify, async () => {
    const d = await api.loadMeeting(id);
    commit(d);
    if (!d.polish?.length) notify({ text: NO_SUGGESTIONS });
  });
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  // 지금 보이는 제안 (아래 렌더에서 채운다): 받은 제안의 용어를 자주 쓰는 단어로 넘길 때 kind·원문을 본다
  const polishLive = useRef<Map<string, PolishSuggestion>>(new Map());
  // 제안으로 이동: 가운데로 스크롤하고 수락 단추에 초점을 둔다 (Enter로 바로 받을 수 있다). polishAt은 '다음 제안'의 기준
  const [jump, setJump] = useState<{ id: string } | null>(null);
  const polishAt = useRef<string | undefined>(undefined);
  const jumpTo = useCallback((to: string) => {
    polishAt.current = to;
    setJump({ id: to });
  }, []);
  useEffect(() => {
    if (!jump) return;
    setFollow(false);
    const row = list.current?.querySelector<HTMLElement>(`[data-seg-id="${jump.id}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    row?.querySelector<HTMLButtonElement>(".seg-polish button")?.focus({ preventScroll: true });
    // 어디로 왔는지 보이게 제안 상자를 잠깐 밝힌다
    if (!reduce) row?.querySelector(".seg-polish")?.animate([{ boxShadow: "0 0 0 4px color-mix(in srgb, var(--ring) 60%, transparent)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1400, easing: "ease-out" });
  }, [jump]);
  /** 제안 받기·버리기: 줄에 세워 코어가 고친 회의를 돌려준다. 받은 문장은 ⌘Z로 되돌릴 수 있고, 받은 용어·이름 교정은 모아서 자주 쓰는 단어로 제안한다 */
  const decidePolish = useCallback(
    (ids: string[], accept: boolean) => {
      if (!ids.length) return;
      if (editQueue.isBlocked(id)) return setEditError(EDIT_BLOCKED);
      setDeciding((d) => new Set([...d, ...ids]));
      const chosen = ids.flatMap((i) => polishLive.current.get(i) ?? []);
      void serial(async () => {
        const before = confirmed.current;
        try {
          const { changed, meeting } = await api.polishResolve(id, ids, accept);
          commit(meeting);
          // 정한 줄 다음의 제안으로 (여럿을 한꺼번에 정했으면 남은 것의 처음으로)
          const rest = new Map([...polishLive.current].filter(([k]) => !ids.includes(k)));
          const to = nextSuggestion(meeting.segments, rest, ids.length === 1 ? ids[0] : undefined);
          if (to) jumpTo(to);
          if (accept && changed > 0) {
            onEdited?.(id, meeting.info.updated_at ?? "");
            bumpEdit("text");
            indexer.touch();
            const now = new Map(meeting.segments.map((s) => [s.id, s]));
            const edits = ids.flatMap((i) => (now.has(i) ? [{ id: i, text: segText(now.get(i)!) }] : []));
            if (before) undoStack.current.push(inverseEdits(before.segments, edits));
            suggestTerms(termsFromSuggestions(chosen.filter((x) => now.has(x.id) && segText(now.get(x.id)!) === x.text)));
          }
        } catch (e) {
          notify({ text: errText(e), detail: errDetail(e), error: true });
        } finally {
          setDeciding((d) => new Set([...d].filter((x) => !ids.includes(x))));
        }
      });
    },
    [id, serial, commit, onEdited, bumpEdit, suggestTerms, notify, jumpTo],
  );
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

  // PDF (6.5): 인쇄용 문서를 body 아래에 두고 macOS 인쇄 대화상자를 연다. 대화상자의 미리보기가 나중에 그리므로
  // 한 번 만든 인쇄 문서는 회의 화면을 닫을 때까지 둔다 (화면에는 보이지 않는다)
  const [printNonce, setPrintNonce] = useState(0);
  useEffect(() => {
    if (!printNonce) return;
    const id = requestAnimationFrame(() =>
      // Tauri는 macOS에서 window.print()를 webview print 명령(Promise)으로 바꿔 둔다
      Promise.resolve(window.print() as unknown).catch((e) => notify({ text: t("인쇄 창을 열지 못했습니다: {error}", { error: errText(e) }), error: true })),
    );
    return () => cancelAnimationFrame(id);
  }, [printNonce, notify]);
  const printable = useMemo(() => (printNonce && detail ? printDoc(detail, selectedSummary) : null), [printNonce > 0, detail, selectedSummary]);

  const railState = useRail(memoNote, memoRef, setMemoPick);
  const { tabNow, askSeen, memoSeen, minutesSeen, railCollapsed, openMemoLine } = railState;
  const memoSegs = useMemo(() => memoLineSegments(detail?.note_memo), [detail?.note_memo]);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
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

  // 찾기·바꾸기 (5.4)
  const [find, setFind] = useState<FindState | null>(null);
  const [cur, setCur] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (find ? findMatches(visible, find.q) : []), [visible, find?.q]);
  const curMatch: Match | null = matches.length ? matches[Math.min(cur, matches.length - 1)] : null;
  const curIndex = curMatch ? matches.indexOf(curMatch) : 0;
  useEffect(() => setCur(0), [find?.q]);
  const replace = (all: boolean) => {
    if (!find || !curMatch) return;
    const edits = replaceEdits(visible, find.q, find.r, all ? undefined : curMatch);
    if (!edits.length) return setEditError(t("바꿔도 내용이 같거나 비게 되어 바꾸지 않았습니다"));
    saveText(edits);
    const term = find.r.trim();
    if (find.glossary && term) {
      api.glossaryAdd([term]).then(
        (n) => notify({ text: n ? t("자주 쓰는 단어에 추가했습니다 — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }) : t("이미 자주 쓰는 단어에 있습니다 — {term}", { term }) }),
        (e) => notify({ text: t("자주 쓰는 단어에 추가하지 못했습니다: {error}", { error: errText(e) }), error: true }),
      );
    }
  };

  // 강조: CSS Custom Highlight API. 지원하지 않으면 현재 일치 행의 테두리(is-find)만 보인다.
  // 문장 노드는 한 번에 모아 둔다(일치마다 querySelector를 부르면 1000세그먼트에서 키 입력마다 100ms 넘게 걸린다)
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const nodes = new Map<string, Node>();
    if (matches.length)
      for (const el of list.current?.querySelectorAll<HTMLElement>(".seg-text:not(.seg-editor)") ?? []) {
        const segId = el.closest<HTMLElement>("[data-seg-id]")?.dataset.segId;
        if (segId && el.firstChild) nodes.set(segId, el.firstChild);
      }
    const range = (m: Match) => {
      const node = nodes.get(m.id);
      if (!node) return [];
      try {
        const r = new Range();
        r.setStart(node, m.start);
        r.setEnd(node, m.start + m.length);
        return [r];
      } catch {
        return [];
      }
    };
    CSS.highlights.set("find", new Highlight(...matches.flatMap(range)));
    CSS.highlights.set("find-current", new Highlight(...(curMatch ? range(curMatch) : [])));
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [matches, curMatch, rows, editingId]);
  // 가라오케 (6.2): 재생 중인 단어 하나를 Highlight API로 칠한다 (단어마다 span을 만들지 않는다).
  // 재생 중에만 rAF로 돌고, 멈춘 동안은 이동할 때 한 번 칠한다. (세그먼트, 단어)가 바뀔 때만 Range를 바꾼다.
  // 찾기 강조가 위에 보이게 우선순위를 낮추고, 등록은 한 번만 한다(같은 우선순위면 나중에 등록한 것이 위)
  const karaoke = useRef<Highlight | null>(null);
  const usable = useMemo(() => new Map(segments.map((s) => [s.id, usableWords(s)])), [detail]);
  const pausedT = playing ? -1 : pos;
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const h = (karaoke.current ??= Object.assign(new Highlight(), { priority: -1 }));
    if (!CSS.highlights.has("karaoke")) CSS.highlights.set("karaoke", h);
    let last: string | null = null;
    let raf = 0;
    const paint = () => {
      const now = audio.current?.currentTime ?? pos;
      const seg = segments[segmentIndexAt(segments, now)];
      // 발화가 끝난 뒤의 공백과 고치는 중인 세그먼트는 칠하지 않는다. 끝 시각에 겹친 단어(길이 0)는 wordClock의 끝까지 칠한다
      const cand = seg && seg.id !== editingId ? usable.get(seg.id) : null;
      const words = cand && now <= Math.max(seg.end, wordClock(cand).end) ? cand : null;
      const k = words ? wordIndexAt(words, now) : -1;
      const key = k < 0 ? "" : `${seg.id}:${k}`;
      if (key !== last) {
        last = key;
        h.clear();
        const node = k < 0 ? null : list.current?.querySelector(`[data-seg-id="${seg.id}"] .seg-text:not(.seg-editor)`)?.firstChild;
        const o = node ? tokenOffsets(segText(seg))[k] : undefined;
        if (node && o) {
          try {
            const r = new Range();
            r.setStart(node, o.start);
            r.setEnd(node, o.end);
            h.add(r);
          } catch {
            // 글자 노드가 방금 바뀌었다. 다음 갱신에 다시 칠한다
          }
        }
      }
      if (playing) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [playing, pausedT, usable, rows, editingId]);
  useEffect(() => () => void ("highlights" in CSS && CSS.highlights.delete("karaoke")), []);
  useEffect(() => {
    if (!curMatch) return;
    setFollow(false);
    list.current?.querySelector(`[data-seg-id="${curMatch.id}"]`)?.scrollIntoView({ block: "center" });
  }, [curMatch]);

  // 현재 세그먼트 자동 스크롤. 사용자가 직접 스크롤하면 멈추고 "현재 위치로" 버튼을 보인다.
  // 화자를 고치는 동안(메뉴·이름 입력·합치기 확인)과 문장을 고치는 동안은 쉰다: 스크롤하면 고치던 것이 사라진다
  const holding = !!(menu || renaming || merge || editingId);
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

  // Markdown·Word는 넣을 내용을 고르는 창을 먼저 연다 (exportPick.ts). 다른 형식은 바로 저장 대화상자
  const [exportPick, setExportPick] = useState<{ f: (typeof EXPORT_FORMATS)[number]; items: ExportItem[] } | null>(null);
  const exportAs = async (f: (typeof EXPORT_FORMATS)[number]) => {
    if (!detail) return;
    if (!PICK_FORMATS.includes(f.format)) return saveExport(f, null);
    let items: ExportItem[];
    try {
      const [docs, templates] = await Promise.all([api.summariesList(id), api.templatesList().catch(() => [])]);
      items = exportItems(docs, templates, {
        memoNote,
        transcript: detail.segments.some((s) => segText(s).trim()),
        memo: !memoNote && (detail.note_memo?.lines ?? []).some((l) => l.text.trim()),
        marks: detail.memos.length > 0,
      });
    } catch (e) {
      return notify({ text: t("내보내지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
    if (items.length === 0) return saveExport(f, { summaries: [], parts: [] }); // 고를 것이 없다 (빈 변환 전 노트): 제목만
    setExportPick({ f, items });
  };
  const saveExport = async (f: (typeof EXPORT_FORMATS)[number], pick: ExportPick | null) => {
    if (!detail) return;
    let out: string | null;
    try {
      out = await save({ defaultPath: exportFilename(detail.info.created_at, detail.info.title, f.ext), filters: [{ name: f.label, extensions: [f.ext] }] });
    } catch (e) {
      return notify({ text: t("저장 위치를 고르지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
    if (!out) return;
    const target = out;
    if (!(await flushMemos())) return; // 쓰던 글까지 내보낸다. 저장하지 못하면 내보내지 않는다 (오류는 편집기가 보인다)
    // 저장 중인 편집이 끝난 뒤에 내보낸다
    void serial(async () => {
      try {
        const path = await api.exportMeeting(id, f.format, target, pick);
        notify({ text: t("내보냈습니다 — {file}", { file: baseName(path) }) });
      } catch (e) {
        notify({ text: t("내보내지 못했습니다: {error}", { error: errText(e) }), error: true });
      }
    });
  };

  useEffect(() => {
    if (detail?.info.sample) markOnboard("sampleOpened"); // 온보딩: 예시 노트를 열었다
  }, [detail?.info.sample]);

  const toObsidian = async () => {
    if (!(await flushMemos())) return; // 쓰던 글까지 보낸다
    void serial(() => sendToObsidian(id, selectedSummary?.key, notify)); // 요약 탭에서 고른 요약이 들어간다
  };

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
  const polishOff = recorded ? CONVERT_FIRST : editing || memoBusy ? t("저장이 끝난 뒤에 교정할 수 있습니다") : null;

  return (
    <div className={cn("meeting grid h-full max-[1180px]:block max-[1180px]:overflow-y-auto", railCollapsed ? "is-rail-collapsed grid-cols-[minmax(0,1fr)_52px]" : "grid-cols-[minmax(0,1fr)_var(--rail)]")}>
      <article className="transcript-col relative col-start-1 row-start-1 flex min-h-0 flex-col overflow-y-auto max-[1180px]:overflow-visible" onWheel={() => playing && setFollow(false)} onScroll={() => menu && setMenu(null)}>
        <div data-tauri-drag-region className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-2 bg-background/90 pr-3 pl-6 backdrop-blur-md">
          <p className="m-0 flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground tabular-nums" data-tauri-drag-region>
            {created?.toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric", weekday: "short" })}
            {created && " · "}
            {created && (getLang() === "en" ? clock(created.getHours(), created.getMinutes()) : created.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }))}
            {recorded && <Badge variant="memo">{RECORDED_BADGE}</Badge>}
          </p>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {!memoNote && segments.length > 0 && !hasWords && detail.audio_path && (
              <GatedButton
                gate={alignGate}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
                disabled={align.job.running}
                onClick={align.startAlign}
                title={t("음성과 대화 내용을 단어 단위로 맞춥니다. 재생 중인 단어가 강조되고, 단어를 누르면 그 단어부터 재생합니다")}
              >
                <AudioLines aria-hidden />
                {align.job.running
                  ? (STAGE_LABEL[align.job.stage ?? ""] ?? t("시작하는 중…")) + (align.job.total ? ` ${Math.round((align.job.done / align.job.total) * 100)}%` : "")
                  : t("단어 싱크 맞추기")}
              </GatedButton>
            )}
            {memoNote && attach && (
              <GatedButton gate={attach.convert ?? OK} className={buttonVariants({ variant: "ghost", size: "sm" })} disabled={!!attach.blocked} title={attach.blocked ?? ADD_FILE_TITLE} onClick={() => attach.onFile({ id, title: info.title })}>
                <Upload aria-hidden />
                {ADD_FILE}
              </GatedButton>
            )}
            <ExportMenu
              formats={exportFormatsFor(memoNote, recorded)}
              onPick={(f) => void exportAs(f)}
              onObsidian={() => void toObsidian()}
              onPrint={() => {
                // 메모는 쓰던 글까지 인쇄한다
                void flushMemos().then((ok) => ok && setPrintNonce((n) => n + 1));
              }}
            />
            {exportPick && (
              <ExportDialog
                label={exportPick.f.label}
                items={exportPick.items}
                onDone={(pick) => {
                  setExportPick(null);
                  if (pick) void saveExport(exportPick.f, pick);
                }}
              />
            )}
            <Button variant="ghost" size="icon-sm" aria-label={t("더 보기")} title={t("더 보기")} aria-haspopup="menu" aria-expanded={!!moreAnchor} onClick={(e) => setMoreAnchor((a) => (a ? null : e.currentTarget))}>
              <MoreHorizontal aria-hidden />
            </Button>
            {moreAnchor && (
              <Popover anchor={moreAnchor} label={t("더 보기")} align="end" onClose={() => setMoreAnchor(null)}>
                {(close) => (
                  <ItemMenu
                    close={close}
                    entries={[
                      {
                        id: "delete",
                        label: t("삭제…"),
                        danger: true,
                        disabled: convertBlock ?? (align.job.running || summaryRunning || enhanceRunning || minutesRunning || polish.running || attach?.lock ? t("작업이 끝난 뒤에 삭제할 수 있습니다") : undefined),
                        onSelect: () => onDelete({ kind: "note", id, title: info.title, dir: info.dir, memo: memoNote, withMemo: !memoNote && memoLines.size > 0 }),
                      },
                    ]}
                  />
                )}
              </Popover>
            )}
          </div>
        </div>
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

      <aside className="summary-col relative flex min-h-0 flex-col border-l border-border bg-background max-[1180px]:overflow-visible max-[1180px]:border-t max-[1180px]:border-l-0" aria-label={railLabel(memoNote)}>
        <PanelToggle side="right" />
        {!railCollapsed && <PanelResizer side="right" className="max-[1180px]:hidden" />}
        <div id="rail-body" className="rail-body flex min-h-0 flex-1 flex-col overflow-y-auto max-[1180px]:overflow-visible" hidden={railCollapsed}>
        <div className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center bg-background/90 pr-12 pl-5 backdrop-blur-md" data-tauri-drag-region>
          <h2 className="m-0 text-[13px] font-semibold">{RAIL_LABEL[tabNow]}</h2>
        </div>
        <div className={cn("flex flex-1 flex-col px-5 pt-2", tabNow === "ask" ? "pb-0" : "pb-10")}>
        <div id="panel-summary" role="tabpanel" aria-labelledby="tab-summary" hidden={tabNow !== "summary"}>
          {recorded ? (
            <p className={PENDING} role="status">
              {railNotice("summary", true)}
            </p>
          ) : (
          <SummariesPanel
            id={id}
            memoNote={memoNote}
            rev={summaryRev}
            prepare={async () => !attach?.lock && (await flushMemos())} // 메모(메모 노트의 본문, 녹음 노트의 메모 탭)는 쓰던 글을 먼저 저장한다 (요약이 저장된 글을 읽는다). 저장하지 못하면 요약하지 않는다 (오류는 편집기가 보인다)
            blocked={editing || memoBusy || !!attach?.lock}
            editSeq={editSeq}
            editSeqRef={editSeqRef}
            editKinds={editKinds}
            chip={(ids) => <TimeChip ids={ids} starts={rail} onSeek={seekTo} memo={memoLines.size > 0 ? { lines: memoLines, onPick: openMemoLine, tagged: !memoNote } : null} />}
            starts={rail}
            memoLines={memoNote ? undefined : memoLines}
            notify={notify}
            onRunning={setSummaryRunning}
            onSelect={setSelectedSummary}
            onChanged={onChanged}
            onToMemo={memoNote || recorded ? undefined : sendToMemo}
          />
          )}
        </div>
        {minutesSeen && !memoNote && (
          <div id="panel-minutes" role="tabpanel" aria-labelledby="tab-minutes" hidden={tabNow !== "minutes"}>
            <MinutesPanel
              id={id}
              rev={summaryRev}
              disabled={recorded ? CONVERT_FIRST : segments.length === 0 ? t("인식된 대화가 없습니다") : editing || memoBusy ? t("저장이 끝난 뒤에 만들 수 있습니다") : null}
              prepare={flushMemos}
              editSeq={editSeq}
              editSeqRef={editSeqRef}
              editKinds={editKinds}
              chip={(ids) => <TimeChip ids={ids} starts={rail} onSeek={seekTo} memo={memoLines.size > 0 ? { lines: memoLines, onPick: openMemoLine, tagged: true } : null} />}
              notify={notify}
              onRunning={setMinutesRunning}
              onChanged={() => {
                setSummaryRev((r) => r + 1);
                onChanged();
              }}
            />
          </div>
        )}
        {askSeen && (
          <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" className="rail-ask flex flex-1 flex-col" hidden={tabNow !== "ask"}>
            {recorded ? (
              <p className={PENDING} role="status">
                {railNotice("ask", true)}
              </p>
            ) : attach?.lock ? (
              // 녹음을 추가하는 동안에는 묻지 않는다: 메모 노트가 녹음 노트로 바뀌는 중이라 근거(메모 줄 ID)가 곧 바뀐다
              <p className={PENDING} role="status">
                {LOCK_NOTICE[attach.lock]}
              </p>
            ) : (
              <AskPanel scope={{ kind: "meeting", id, starts, memoLines: memoLines.size > 0 ? memoLines : undefined, memoNote }} onCite={onCite} />
            )}
          </div>
        )}
        {memoSeen && !memoNote && (
          <div id="panel-memo" role="tabpanel" aria-labelledby="tab-memo" className="rail-memo" hidden={tabNow !== "memo"}>
            <EnhancedNote
              id={id}
              rev={summaryRev}
              disabled={recorded ? CONVERT_FIRST : segments.length === 0 ? t("인식된 대화가 없습니다") : editing || memoBusy ? t("저장이 끝난 뒤에 완성할 수 있습니다") : null}
              prepare={flushMemos}
              editSeq={editSeq}
              editSeqRef={editSeqRef}
              editKinds={editKinds}
              chip={(ids) => <TimeChip ids={ids} starts={rail} onSeek={seekTo} />}
              onSeek={(t) => seekTo(t)}
              onMade={() => {
                setSummaryRev((r) => r + 1);
                onChanged();
              }}
              onRunning={setEnhanceRunning}
              notify={notify}
              pick={memoTarget}
              mine={
                <>
                  <p className="mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{t("내가 적는 메모입니다. 요약과 AI 질문에 대화 내용과 함께 쓰입니다.")}</p>
                  <MemoEditor key={memoRev} variant="rail" id={id} initial={noteBody} savedBody={noteBody} segments={memoSegs} target={memoTarget} notify={notify} onSaved={onMemoSaved} onState={setMemoSave} />
                </>
              }
            />
          </div>
        )}
        </div>
        </div>
      </aside>
      {printable && <PrintSheet doc={printable} />}
    </div>
  );
}
