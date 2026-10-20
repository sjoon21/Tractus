import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { attachAlignJobs } from "./alignJobs";
import { api, errDetail, errFull, errText, useJob, useRecorder, type CalendarEvent, type MeetingInfo, type PendingRecording } from "./api";
import { attendeeLine, CARD_LABEL, CARD_RECORD, eventWhen, useNextEvent } from "./calendar";
import { CoachMark } from "./CoachMark";
import { OnboardingCard } from "./OnboardingCard";
import { onboardSteps, showOnboard, useOnboard, type StepId } from "./onboarding";
import { AskPanel } from "./AskPanel";
import { CHECKUP_LABEL, DROP_UNAVAILABLE, MODELS_LABEL, OK, recordNotice, UNCONVERTED_SAVED, type Decision } from "./caps";
import { Checkup } from "./Checkup";
import { GatedButton } from "./GatedButton";
import { DOWNLOAD_DONE, downloadErrorView } from "./models";
import { ModelsView } from "./ModelsSettings";
import { attachModelsJobs } from "./modelsJob";
import { CapsContext, useCapabilities, useCapabilitiesState } from "./useCapabilities";
import { OPEN_SETTINGS } from "./llmKey";
import { addBlocked, ADDED, ADD_BADGE, attachReduce, DROP_CONFIRM, DROP_LABEL, failedFile, IDLE_ATTACH, IMPORT_BUSY, lockOf, pendingTarget, PENDING_LABEL, resolveTarget, type AttachControls, type AttachTarget } from "./attach";
import { ConfirmDialog } from "./ConfirmDialog";
import { editQueue } from "./editQueue";
import { ErrorDetail } from "./ErrorDetail";
import { locale, t } from "./i18n";
import { bindIndexer, indexer } from "./indexer";
import { baseName, errorView, isImeKey, isRecLive, IDLE_JOB, JOB_ERROR, fmtTime, IMPORT_EXTS, isImportable, isTypingTarget, recMode, REC_MODES, STAGE_FALLBACK, STAGE_LABEL, warningText, type RecMode } from "./lib";
import { MeetingView } from "./MeetingView";
import type { NewNoteAction } from "./menu";
import { NewNoteMenu } from "./NewNoteMenu";
import { dropMemo, flushMemos, isMemo, noteTime, settleMemo } from "./memo";
import { RecordView } from "./RecordView";
import { deleteDialogText, deletedText, deleteFailure, deleteReduce, IDLE_DELETE, recordingLabel, type DeleteTarget } from "./remove";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { createTraySender, deriveTrayState, routeTrayAction } from "./tray";
import { AfterRecordDialog } from "./AfterRecordDialog";
import { afterRecord, ASK_BLOCKS_RECORD, effectiveChoice, rememberedChoice, stopAction, type AskChoice } from "./afterRecord";
import { attachConvertJobs, convertStore, useConvertJob } from "./convertJobs";
import { convertAdvance, convertEnqueue, convertProgress, convertSlot, IDLE_CONVERT, type ConvertQueue } from "./convertQueue";
import { recButton } from "./pause";
import { BULK_MIN, CONVERT_ALL, CONVERT_PAUSED, CONVERT_ALL_LINE, CONVERT_ALL_TITLE, CONVERT_FAIL, CONVERTED, isRecorded, noteLabel, recordedIds, SAVE_NOTE, SAVE_NOTE_TITLE, WAIT_OTHER, WAIT_RECORDING, type ConvertControls } from "./recorded";
import { NoteLibrary } from "./NoteLibrary";
import { touchNote as touchNoteIn, type Folder } from "./organize";
import { OrganizeContext, useOrganizeState } from "./useOrganize";
import { PanelResizer, PanelToggle, usePanels } from "./PanelToggle";
import { RecHeaderControls } from "./RecHeaderControls";
import { RAIL_REC_LABEL, railPendingLabel, railRecState } from "./panels";
import { check } from "@tauri-apps/plugin-updater";
import { AudioLines, Box, CalendarClock, ChevronRight, CircleAlert, FileText, House, Mic, Search, Settings, Sparkles, SquarePen, Stethoscope, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/components/ui/utils";
import { FlickeringGrid } from "@/components/ui/flickering-grid";
import { JOB_CARD, NOTE_LINK, SIDE_HEAD, SIDE_ITEM } from "@/components/sidebar";
import { SparklesIcon } from "@/components/ui/sparkles-icon";
import { newVersionToast, OPEN_SETTINGS_LABEL, START_DELAY_MS } from "./update";

export type Seek = { segId?: string; t?: number; nonce: number };
export type View =
  | { kind: "home" }
  | { kind: "meeting"; id: string; seek?: Seek }
  | { kind: "search"; q: string }
  | { kind: "record" }
  | { kind: "settings" }
  | { kind: "models" };

const GLOBAL = { kind: "global" } as const;

/** 화면 아래 알림. 오류는 닫을 때까지 남고, 새 알림이 와도 밀려나지 않는다(쌓인다). detail: 원래 문구 (접힌 '자세히') */
export type Toast = { text: string; detail?: string | null; error?: boolean; action?: { label: string; run: () => void } };
export type Notify = (t: Toast) => void;
const TOAST_MS = 6000;
const TOAST_MAX = 4; // ponytail: 넘치면 가장 오래된 것부터 버린다. 여러 파일 실패를 다 보여야 하면 가져오기 패널에 실패 목록을 둔다

export function App() {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]); // $TRACTUS_HOME/folders.json (docs/desktop.md §2.12)
  const [pending, setPending] = useState<PendingRecording[]>([]);
  const [listError, setListError] = useState<{ text: string; detail: string | null } | null>(null);
  // 노트 목록을 한 번이라도 읽었는지: 읽기 전에는 '삭제된 노트'를 판단하지 않는다 (AI 질문의 인용 칩)
  const [listLoaded, setListLoaded] = useState(false);
  const [view, setView] = useState<View>({ kind: "home" });
  const panels = usePanels(); // 양쪽 패널 접기 (PanelToggle.tsx, docs/desktop.md §3.2): 왼쪽 노트 목록은 여기서, 오른쪽 패널은 노트 화면이 그린다
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const searchAfterReveal = useRef(false); // ⌘K로 접힌 목록을 펼쳤다: 그려진 뒤 검색창에 초점
  useEffect(() => {
    if (panels.state.left || !searchAfterReveal.current) return;
    searchAfterReveal.current = false;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [panels.state.left]);
  const searchRef = useRef<HTMLInputElement>(null);
  // 전체 회의에 질문 (6.3): 오른쪽 서랍. 닫아도 대화는 남는다(앱을 끄기 전까지)
  const [askOpen, setAskOpen] = useState(false);
  const askInput = useRef<HTMLTextAreaElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);
  const closeAsk = useCallback(() => {
    setAskOpen(false);
    askButton.current?.focus();
  }, []);
  useEffect(() => {
    if (askOpen) askInput.current?.focus();
  }, [askOpen]);
  const [toasts, setToasts] = useState<(Toast & { id: number })[]>([]);
  const toastId = useRef(0);
  const notify = useCallback<Notify>((t) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { ...t, id }].slice(-TOAST_MAX));
  }, []);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((x) => x.id !== id)), []);

  const refresh = useCallback(async () => {
    try {
      const [m, p, f] = await Promise.all([api.listMeetings(), api.listRecordings(), api.listFolders()]);
      setMeetings(m);
      setFolders(f);
      setPending(p);
      setListError(null);
      setListLoaded(true);
    } catch (e) {
      setListError({ text: errText(e), detail: errDetail(e) });
    }
  }, []);
  const touchNote = useCallback((id: string, updatedAt: string) => setMeetings((ms) => touchNoteIn(ms, id, updatedAt) as typeof ms), []);
  // 노트 정리(즐겨찾기·태그·폴더·순서): 사이드바와 노트 머리가 같은 상태를 본다 (useOrganize.ts)
  const org = useOrganizeState({ meetings, setMeetings, folders, setFolders, refresh, notify });
  // 삭제(휴지통으로 이동): 확인 대화상자 상태. 노트 화면과 사이드바의 남은 녹음이 같이 쓴다
  const [del, dispatchDel] = useReducer(deleteReduce, IDLE_DELETE);
  // 글만 있는 노트에 녹음 추가 (attach.ts): 흐름 상태와, 끝난 뒤 그 노트를 다시 읽게 하는 표시 (노트 화면의 key)
  const [attach, dispatchAttach] = useReducer(attachReduce, IDLE_ATTACH);
  const attachRef = useRef(attach);
  attachRef.current = attach;
  const [noteEpoch, setNoteEpoch] = useState({ id: "", n: 0, stale: false }); // stale: 그 노트를 다시 열 때 요약이 낡았다고 알린다 (한 번만)
  // 화면을 옮기기 전에 쓰던 메모를 저장한다. 저장하지 못하면 옮기지 않는다 (그 메모가 오류를 이미 보이고 있다)
  const go = useCallback(async (next: View) => {
    if (await flushMemos()) setView(next);
  }, []);
  // 설정·모델 화면의 `뒤로`: 그 화면을 열기 전에 보던 화면 (노트·검색·녹음·홈)
  const lastContent = useRef<View>({ kind: "home" });
  if (view.kind !== "settings" && view.kind !== "models") lastContent.current = view;
  const goBack = useCallback(() => void go(lastContent.current), [go]);
  // 요약·질문 오류의 `설정 열기` (llmKey.requestSettings)
  useEffect(() => {
    const open = () => {
      setAskOpen(false);
      void go({ kind: "settings" });
    };
    window.addEventListener(OPEN_SETTINGS, open);
    return () => window.removeEventListener(OPEN_SETTINGS, open);
  }, [go]);
  const openMeeting = useCallback(
    (id: string, seek?: Omit<Seek, "nonce">) => void go({ kind: "meeting", id, seek: seek && { ...seek, nonce: Date.now() } }),
    [go],
  );
  // 모델·도구가 없어 못 쓰는 기능 (caps.ts, docs/desktop.md §2.15): 점검 결과를 앱 전체가 같이 본다. 점검을 못 하면 모두 쓸 수 있다고 본다
  const [checkupOpen, setCheckupOpen] = useState(false);
  const [unconverted, setUnconverted] = useState(false); // 방금 녹음을 변환하지 못하고 저장만 했다 (RecordView)
  const checkupOpenRef = useRef(false);
  checkupOpenRef.current = checkupOpen;
  const viewRef = useRef<View>({ kind: "home" });
  viewRef.current = view;
  const caps = useCapabilitiesState({
    openModels: useCallback(() => {
      setCheckupOpen(false);
      void go({ kind: "models" });
    }, [go]),
    openCheckup: useCallback(() => setCheckupOpen(true), []),
    openSettings: useCallback(() => {
      setAskOpen(false);
      setCheckupOpen(false);
      void go({ kind: "settings" });
    }, [go]),
  });
  const capsRef = useRef(caps);
  capsRef.current = caps;
  const convertGate = caps.can("convert");
  const recordGate = caps.can("record"); // 녹음 프로그램(tractus-rec)이 없으면 녹음 단추가 이유를 보인다 (녹음은 모델 없이도 된다)
  // 못 쓰는 기능을 눌렀을 때(메뉴·끌어 놓기): 같은 이유와 고치는 길을 알림으로 보인다
  const notifyBlocked = useCallback(
    (d: ReturnType<typeof caps.can>) => {
      if (!d.ok) notify({ text: d.reason, error: true, action: { label: d.fix.label, run: () => capsRef.current.fixAction(d.fix) } });
    },
    [notify],
  );
  const closeCheckup = useCallback(() => {
    setCheckupOpen(false);
    void api.setCheckupDone(true).catch(() => {});
  }, []);
  // 받기가 끝나면 점검을 다시 하고, 모델 화면을 보고 있지 않으면 알린다
  useEffect(
    () =>
      attachModelsJobs((dl) => {
        void capsRef.current.refresh();
        if (viewRef.current.kind === "models" || checkupOpenRef.current) return;
        if (dl.error) {
          const e = downloadErrorView(dl.error);
          notify({ text: e.text, detail: e.detail, error: true });
        } else if (dl.completed) notify({ text: DOWNLOAD_DONE });
      }),
    [notify],
  );
  // 새 메모 (⌘N): 빈 메모 노트를 만들고 열면 본문에 초점이 간다
  const [creating, setCreating] = useState(false);
  const newMemo = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { meeting_id } = await api.noteNew();
      openMeeting(meeting_id); // 노트 화면은 스스로 읽는다: 목록 새로 읽기를 기다리지 않고 바로 연다 (노트가 많으면 목록이 느리다)
      void refresh();
    } catch (e) {
      notify({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setCreating(false);
    }
  }, [creating, refresh, openMeeting, notify]);

  // 녹음 정지 → 전사 → 회의 상세
  const transcribe = useJob((meetingId) => {
    const t = transcribeTarget.current;
    if (t && t.id === meetingId) setNoteEpoch((e) => ({ id: meetingId, n: e.n + 1, stale: true })); // 녹음을 덧붙인 노트: 열려 있으면 다시 읽는다
    void refresh().then(() => openMeeting(meetingId));
  });
  // 녹음을 변환하지 않고 노트로 저장 (`recording finish`, docs/desktop.md §3.3): 끝나면 변환 전 노트를 연다. 실패하면 녹음 폴더가 남아 `변환 대기 중인 녹음`에 보인다 (녹음은 잃지 않는다)
  const finish = useJob((meetingId) => void refresh().then(() => openMeeting(meetingId)));
  const finishDir = useRef<string | null>(null);
  const [progressKind, setProgressKind] = useState<"convert" | "save">("convert"); // 녹음 화면의 진행 줄이 보이는 작업 (마지막으로 시작한 것)
  const finishRecording = useCallback(
    (dir: string) => {
      finishDir.current = dir;
      setProgressKind("save");
      setUnconverted(false);
      void finish.runJob("recording_finish", { dir, title: null });
    },
    [finish.runJob],
  );
  // 변환 전 노트의 변환 줄 (convertQueue.ts): 노트 하나를 변환하는 것도, 모두 변환도 같은 줄이다. 한 번에 하나씩 (변환 엔진이 한 번에 하나만 올라간다)
  const [convQ, setConvQ] = useState<ConvertQueue>(IDLE_CONVERT);
  const convJob = useConvertJob(convQ.current);
  const converting = convQ.current !== null;
  const convertRunning = converting && convJob.running;
  // 마지막 전사 대상. "다시 전사"는 방금 녹음뿐 아니라 사이드바의 남은 녹음에도 쓴다.
  // 바로 시작하지 않고 waitDir에 둔다: 파일 가져오기가 돌고 있으면 끝난 뒤에 시작한다(전사 두 개가 모델을 따로 올리지 않게)
  const transcribeDir = useRef<string | null>(null);
  const transcribeTarget = useRef<AttachTarget | null>(null); // 글만 있는 노트에 덧붙이는 녹음이면 그 노트 (--append-to)
  const [waitDir, setWaitDir] = useState<string | null>(null);
  const startTranscribe = useCallback((dir: string, target?: AttachTarget | null) => {
    transcribeDir.current = dir;
    transcribeTarget.current = target ?? null;
    setProgressKind("convert");
    setUnconverted(false);
    if (target) dispatchAttach({ type: "convert", target });
    setWaitDir(dir);
  }, []);
  const confirmDelete = async () => {
    const t = del.target;
    if (!t || del.busy) return;
    dispatchDel({ type: "start" });
    try {
      if (t.kind === "note") {
        // 쓰던 메모가 있으면 마지막으로 저장해 둔다(휴지통에서 되살려도 최신 글이 있게)
        await settleMemo(t.id);
        // 저장 중인 수정(문장·참석자·목소리 등록·내보내기)이 끝난 뒤에 지운다. 그동안 이 노트의 새 수정은 받지 않는다 (editQueue)
        await editQueue.exclusive(t.id, () => api.deleteMeeting(t.id));
        dropMemo(t.id); // 지운 뒤에야 저장을 멈춘다 (삭제가 실패하면 편집기는 계속 저장한다)
        // 열려 있던 노트는 닫는다: 지워진 폴더를 다시 읽지 않게 목록 갱신보다 먼저
        setView((v) => (v.kind === "meeting" && v.id === t.id ? { kind: "home" } : v));
      } else {
        await api.deleteRecording(t.dir);
        if (transcribeDir.current === t.dir) transcribeDir.current = null;
      }
      notify({ text: deletedText(t) });
    } catch (e) {
      const f = deleteFailure(t, errFull(e));
      notify({ text: f.text, detail: f.detail, error: true });
    } finally {
      dispatchDel({ type: "finish" });
      void refresh();
    }
  };
  const askDelete = useCallback((target: DeleteTarget) => dispatchDel({ type: "ask", target }), []);
  // 변환 엔진이 없을 때 녹음은 저장만 한다: 변환을 시작하지 않고 `변환 대기 중인 녹음`에 남긴다 (준비되면 사이드바에서 변환)
  // 녹음이 끝났다: `녹음을 끝내면` 설정이 바로 변환 | 노트로 저장 | 묻기를 정한다 (afterRecord.stopAction). 어느 쪽이든 녹음은 남는다
  const [afterAsk, setAfterAsk] = useState<{ dir: string; seconds: number } | null>(null);
  const asking = afterAsk !== null; // 방금 끝낸 녹음을 어떻게 할지 묻는 중: 이 녹음이 정해질 때까지 새 녹음·변환 줄 시작을 막는다 (묻는 창이 다른 녹음의 것으로 바뀌지 않게)
  const { rec, live, startRec, sendRec, resetRec, startedAtMs } = useRecorder((dir, seconds) => {
    void (async () => {
      const target = attachRef.current.phase === "recording" ? attachRef.current.target : null; // 글만 있는 노트에 추가하는 녹음
      const settings = await api.getSettings().catch(() => null); // 설정 화면·묻는 창이 바꾼 값을 늘 새로 읽는다
      const action = stopAction({ setting: afterRecord(settings?.after_record), convertOk: capsRef.current.can("convert").ok, attach: target !== null });
      if (action.kind === "convert") startTranscribe(dir, target);
      else if (action.kind === "later") finishRecording(dir);
      else if (action.kind === "ask") {
        setAfterAsk({ dir, seconds });
        void api.trayShowIfHidden().catch(() => {}); // 메뉴 막대에서 끝냈다면 창을 꺼내 묻는다
      } else {
        setUnconverted(true);
        dispatchAttach({ type: "abort" });
        void refresh();
      }
    })();
  });
  const recording = rec.phase === "recording" || rec.phase === "paused" || rec.phase === "starting" || rec.phase === "stopping";

  // 녹음 방식: 마지막으로 고른 값을 설정에 저장해 두고 다음에도 쓴다
  const [mode, setMode] = useState<RecMode>("in_person");
  useEffect(() => {
    // 설정을 못 읽으면 기본값(대면 회의)으로 둔다. 목록 읽기 오류가 따로 보인다
    api.getSettings().then(
      (s) => {
        setMode(recMode(s.rec_mode));
        if (!s.checkup_done) setCheckupOpen(true); // 처음 실행: 시작 점검을 한 번 보여 준다
      },
      () => setMode("in_person"),
    );
  }, []);
  const chooseMode = (m: RecMode) => {
    setMode(m);
    api.setRecMode(m).catch((e) => setListError({ text: t("녹음 방식을 저장하지 못했습니다: {error}", { error: errText(e) }), detail: errDetail(e) }));
  };

  // 파일 가져오기 (Phase 5.5): 끌어 놓거나 고른 파일을 큐에 넣고 한 번에 하나씩 전사한다
  // (vibe use-drop-target.ts, meetily layout.tsx — 둘 다 MIT — 참고). 녹음 전사와는 겹치지 않는다: 녹음 전사가 먼저다
  const [queue, setQueue] = useState<string[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const importTarget = useRef<AttachTarget | null>(null); // 이 노트에 추가하려고 고른 파일이면 그 노트 (파일에서 추가)
  const imp = useJob((meetingId, warnings) => {
    void refresh();
    const name = importing ? baseName(importing) : t("파일");
    // 화면은 바꾸지 않는다: 고치던 문장·찾기가 사라진다. 열기는 사용자가 고른다
    const dup = warnings.some((w) => w.code === "duplicate");
    const into = importTarget.current;
    if (into && !dup && into.id === meetingId) {
      setNoteEpoch((e) => ({ id: meetingId, n: e.n + 1, stale: true })); // 열려 있는 노트는 녹음 노트로 다시 읽는다
      return notify({ text: ADDED(into.title, name) });
    }
    notify({ text: dup ? t("이미 텍스트로 변환한 파일입니다 — {name}", { name }) : t("텍스트 변환을 마쳤습니다 — {name}", { name }), action: { label: t("열기"), run: () => openMeeting(meetingId) } });
  });
  useEffect(() => {
    if (!waitDir || imp.job.running || convertRunning || recording) return; // 새 녹음이 도는 동안에는 변환 엔진을 올리지 않는다
    setWaitDir(null);
    void transcribe.startJob("transcribe", waitDir, transcribeTarget.current?.id);
  }, [waitDir, imp.job.running, convertRunning, recording, transcribe.startJob]);
  // 노트로 저장하는 중·변환 전 노트를 변환하는 중도 `변환 중`으로 본다: 새 녹음·가져오기·창 닫기 확인이 같은 규칙을 쓴다
  const transcribing = transcribe.job.running || waitDir !== null || finish.job.running || converting;
  // 새 녹음을 막는 일. 변환 전 노트의 변환 줄은 막지 않는다: 새 녹음이 도는 변환을 멈추고(멈춘 곳부터 이어 할 수 있다) 녹음이 끝나면 이어서 한다 (pauseConvert)
  const recordBlocked = transcribe.job.running || waitDir !== null || finish.job.running || asking;
  const preempted = useRef<string | null>(null); // 새 녹음이 멈춘 변환의 노트
  // 변환 줄의 첫 노트를 시작한다: 녹음·다른 변환·가져오기가 끝난 뒤에. 지워졌거나 다른 곳에서 이미 변환한 노트는 건너뛴다
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const startedConv = useRef<string | null>(null);
  useEffect(() => {
    const id = convQ.current;
    if (id === null) {
      startedConv.current = null;
      return;
    }
    if (startedConv.current === id || !listLoaded) return;
    const note = meetings.find((m) => m.id === id);
    if (!note || !isRecorded(note)) return setConvQ(convertAdvance);
    if (recording || asking || transcribe.job.running || waitDir !== null || finish.job.running || imp.job.running) return;
    startedConv.current = id;
    void convertStore.start(id);
  }, [convQ.current, meetings, listLoaded, recording, asking, transcribe.job.running, waitDir, finish.job.running, imp.job.running, convJob.running]);
  // 변환이 끝나면(성공이든 실패든) 알리고 줄을 넘긴다. 실패해도 줄은 이어진다. 노트가 열려 있지 않아도 알린다
  useEffect(
    () =>
      attachConvertJobs(({ noteId, ok, state }) => {
        // 새 녹음이 멈춘 변환: 실패로 알리지 않고 줄도 넘기지 않는다. 녹음이 끝나면 같은 노트를 이어서 시작한다
        if (preempted.current === noteId) {
          preempted.current = null;
          if (!ok) {
            startedConv.current = null;
            return;
          }
        }
        const title = meetingsRef.current.find((m) => m.id === noteId)?.title ?? "";
        if (ok) {
          const open = viewRef.current.kind === "meeting" && viewRef.current.id === noteId;
          notify({ text: CONVERTED(title), action: open ? undefined : { label: t("열기"), run: () => openMeeting(noteId) } });
          state.warnings.forEach((w) => notify({ text: warningText(w) }));
        } else {
          const e = errorView(state.error, state.errorCode, JOB_ERROR.convert);
          notify({ text: CONVERT_FAIL(title, e.text === JOB_ERROR.convert ? "" : `. ${e.text}`), detail: e.detail, error: true });
        }
        void refresh();
        setConvQ((q) => (q.current === noteId ? convertAdvance(q) : q));
      }),
    [notify, refresh, openMeeting],
  );
  const enqueue = useCallback(
    (paths: string[]) => {
      if (!capsRef.current.can("convert").ok) return notifyBlocked(capsRef.current.can("convert")); // 끌어 놓은 파일: 실패하지 않고 이유를 알린다
      const bad = paths.filter((p) => !isImportable(p));
      if (bad.length) notify({ text: t("가져올 수 없는 형식입니다: {files}", { files: bad.map(baseName).join(", ") }), error: true });
      setQueue((q) => [...q, ...paths.filter((p) => isImportable(p) && !q.includes(p))]);
    },
    [notify, notifyBlocked],
  );
  useEffect(() => {
    if (!queue.length || imp.job.running || transcribing) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setImporting(next);
    importTarget.current = null;
    void imp.startJob("import", next);
  }, [queue, imp.job.running, transcribing, imp.startJob]);
  // 실패는 알림으로 남긴다 (다음 파일이 시작되면 진행 표시는 그 파일로 바뀐다)
  useEffect(() => {
    if (!imp.job.running && imp.job.error && importing) {
      const e = errorView(imp.job.error, imp.job.errorCode, JOB_ERROR.import);
      const why = e.text === JOB_ERROR.import ? "" : `. ${e.text}`;
      notify({ text: failedFile(importing, why), detail: e.detail, error: true });
    }
  }, [imp.job.running, imp.job.error, imp.job.errorCode, importing, notify]);
  const pickFiles = async () => {
    if (!convertGate.ok) return notifyBlocked(convertGate);
    try {
      const picked = await open({ multiple: true, directory: false, filters: [{ name: t("오디오·동영상"), extensions: IMPORT_EXTS }] });
      if (picked) enqueue(picked);
    } catch (e) {
      notify({ text: t("파일을 고르지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
  };
  // 창에 파일을 끌어 오면 덮개를 보인다. 앱 안에서 끄는 것(화자 합치기)은 경로가 없어서 무시된다
  const [dropping, setDropping] = useState(false);
  const [dropCount, setDropCount] = useState(0);
  const dropNote = useRef<AttachTarget | null>(null); // 글만 있는 노트를 보고 있고 추가할 수 있으면 그 노트: 파일 하나를 놓으면 그 노트에 추가한다
  const attachFileRef = useRef<(t: AttachTarget, path?: string) => Promise<void>>(async () => {});
  const [dropAsk, setDropAsk] = useState<{ target: AttachTarget; path: string } | null>(null); // 놓은 파일로 노트를 바꾸기 전에 묻는다 (되돌릴 수 없다)
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") {
        setDropping(payload.paths.length > 0);
        setDropCount(payload.paths.length);
      } else if (payload.type === "leave") setDropping(false);
      else if (payload.type === "drop") {
        setDropping(false);
        if (dropNote.current && payload.paths.length === 1) setDropAsk({ target: dropNote.current, path: payload.paths[0] });
        else if (payload.paths.length) enqueue(payload.paths);
      }
    });
    return () => void un.then((f) => f());
  }, [enqueue]);

  // 창을 닫으면 앱이 끝난다(메뉴 막대에 남기기가 꺼져 있을 때): 전사 중이거나 대기 중인 파일이 있으면 묻는다.
  // ponytail: ⌘Q는 묻지 않는다(쓰던 메모만 저장하고 끝낸다: quit-requested). 남은 전사 프로세스는 stdout이 닫혀 다음 진행 이벤트에서 끝난다
  const busyRef = useRef("");
  busyRef.current = !(transcribing || imp.job.running || queue.length) ? "" : queue.length ? t("진행 중인 변환과 대기 중인 파일 {n}개가 취소됩니다.", { n: queue.length }) : t("진행 중인 변환이 취소됩니다.");
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      // 메뉴 막대에 남기는 설정이면 Rust가 창을 숨기기만 한다: 앱이 계속 돌아 녹음·변환이 이어지므로 묻지 않는다. 쓰던 메모는 저장해 둔다
      if (await api.trayHidesOnClose().catch(() => false)) {
        await flushMemos();
        return e.preventDefault();
      }
      // 저장하지 못한 메모가 있으면 묻는다 (⌘Q는 묻지 않고 저장만 마친다: quit-requested)
      if (!(await flushMemos()) && !(await ask(t("저장하지 못한 메모가 있습니다. 그래도 닫을까요?"), { title: t("Tractus 닫기"), kind: "warning", okLabel: t("저장하지 않고 닫기"), cancelLabel: t("계속 쓰기") }))) return e.preventDefault();
      if (busyRef.current && !(await ask(t("{reason} 그래도 닫을까요?", { reason: busyRef.current }), { title: t("Tractus 닫기"), kind: "warning", okLabel: t("닫기"), cancelLabel: t("계속 변환") }))) e.preventDefault();
    });
    return () => void un.then((f) => f());
  }, []);

  // ⌘Q: 코어가 종료를 미루고 알리면 쓰던 메모를 저장한 뒤 이어 간다 (저장하지 못해도 끝낸다: ⌘Q는 묻지 않는다)
  useEffect(() => {
    const un = listen("quit-requested", () => void flushMemos().finally(() => void api.quitReady()));
    return () => void un.then((f) => f());
  }, []);

  // 단어 싱크는 노트를 닫아도 계속 돈다: 끝나면 열려 있는 노트와 상관없이 알린다 (alignJobs.ts)
  useEffect(
    () =>
      attachAlignJobs(({ ok, state }) => {
        if (ok) notify({ text: t("단어 싱크를 맞췄습니다. 단어를 누르면 그 단어부터 재생합니다") });
        else if (state.error) notify({ ...errorView(state.error, state.errorCode, JOB_ERROR.align), error: true });
      }),
    [notify],
  );
  // 문장을 고친 뒤 검색에 반영하는 조용한 갱신은 앱이 한가할 때만 (녹음·변환·가져오기 중이면 미룬다. 요약·단어 싱크 등은 Rust가 비켜 간다)
  const idleBlockers = useRef(false);
  idleBlockers.current = recording || transcribing || imp.job.running || queue.length > 0;
  useEffect(
    () =>
      bindIndexer({
        isBusy: () => idleBlockers.current,
        onError: (e) => notify({ text: t("스마트 검색 정보를 갱신하지 못했습니다"), detail: errDetail(e) ?? errFull(e), error: true }), // 코어·Rust가 한 줄만 주면 그 줄이 원인이다
      }),
    [notify],
  );
  // 시작할 때 한 번 갱신한다: 지난번에 고친 뒤 5분 안에 앱을 끝냈어도 그 변경이 검색에 따라온다 (갱신은 증분이라 바뀐 것이 없으면 가볍다)
  useEffect(() => indexer.touch(), []);

  // 업데이트 확인 (update.ts): 미리 만든 앱(번들)에서만, 시작 약 10초 뒤 한 번. 새 버전이 있으면 알림과 `설정 열기`뿐이다 (받지도 설치하지도 않는다).
  // 실패는 조용히 무시한다 (오프라인이 흔하다). 설정 화면의 `업데이트 확인`은 따로 돈다
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        if (!(await api.updateAvailable())) return;
        const u = await check();
        if (!u) return;
        notify({ text: newVersionToast(u.version), action: { label: OPEN_SETTINGS_LABEL, run: () => void go({ kind: "settings" }) } });
        void u.close().catch(() => {});
      } catch {
        // 오프라인·서버 오류: 아무것도 보이지 않는다
      }
    }, START_DELAY_MS);
    return () => clearTimeout(id);
  }, [notify, go]);

  // 앱 밖(터미널 `tractus transcribe` 등)에서 만든 노트도 질문 답의 인용 칩이 '삭제됨'으로 보이지 않게: 창으로 돌아올 때와 질문 창을 열 때 목록을 다시 읽는다
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(() => {
    if (askOpen) void refresh();
  }, [askOpen, refresh]);

  // 처음, 그리고 전사가 끝날 때마다(성공·실패) 목록과 남은 녹음을 다시 읽는다
  useEffect(() => {
    if (!transcribe.job.running) void refresh();
  }, [transcribe.job.running, refresh]);
  const importPct = imp.job.total ? imp.job.done / imp.job.total : null;
  const leftover = pending.filter((p) => !(recording && p.dir === rec.dir));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.code === "KeyJ") {
        e.preventDefault();
        setAskOpen((o) => !o);
      } else if (e.metaKey && !e.shiftKey && !e.altKey && e.code === "KeyN" && !isImeKey(e)) {
        e.preventDefault();
        void newMemo();
      } else if (e.metaKey && e.code === "KeyK") {
        e.preventDefault();
        if (panelsRef.current.state.left) {
          // 검색창은 접힌 노트 목록 안에 있다: 펼친 뒤 그려지면 초점을 준다 (아래 effect)
          searchAfterReveal.current = true;
          panelsRef.current.reveal({ kind: "search" });
        }
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.code === "KeyB" && !e.metaKey && !e.ctrlKey && isRecLive(rec.phase) && !isTypingTarget(e.target)) {
        e.preventDefault();
        void sendRec("bookmark");
      }
    };
    // e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec.phase, sendRec, newMemo]);

  // 변환 전 노트를 변환하는 중에 녹음을 시작하면 변환을 멈춘다 (멈춘 곳부터 이어서 할 수 있다). 줄은 그대로라 녹음이 끝나면 이어서 한다
  const pauseConvert = () => {
    if (!convertRunning || convQ.current === null) return;
    preempted.current = convQ.current;
    convertStore.cancel(convQ.current);
    notify({ text: CONVERT_PAUSED });
  };
  /** event: 홈의 `곧 시작하는 일정` 카드에서 시작한 녹음 (일정 제목·참석자를 녹음 폴더에 남긴다) */
  const onRecordButton = (event?: CalendarEvent) => {
    if (!recording && !recordBlocked && !recordGate.ok) return notifyBlocked(recordGate); // 새 노트 메뉴의 `녹음 시작`
    if (!recording && !recordBlocked) {
      pauseConvert();
      resetRec();
      setUnconverted(false);
      void startRec(mode, null, event);
    }
    void go({ kind: "record" });
  };

  // 메뉴 막대 아이콘 (tray.ts, docs/desktop.md §3.1): 상태를 Rust에 밀어 주고, 메뉴에서 온 동작은 위 단추와 같은 함수로 처리한다
  const traySend = useRef(createTraySender((p) => api.trayUpdate(p)));
  const trayJob = finish.job.running ? finish.job : transcribe.job; // 지금 도는 녹음 변환·저장 작업 (진행률)
  const bgJob = convertRunning ? convJob : imp.job; // 녹음을 막지 않는 변환(가져오기, 변환 전 노트의 변환 줄)의 진행률
  const pausedSec = rec.phase === "paused" ? rec.t : 0; // 일시정지 중에는 메뉴 막대 시계가 이 값으로 멈춘다 (타이머 없음)
  const trayState = useMemo(
    () => deriveTrayState({ rec: { phase: rec.phase }, startedAtMs, elapsedSec: pausedSec, job: { running: trayJob.running, done: trayJob.done, total: trayJob.total }, waiting: waitDir !== null || asking, importing: { active: imp.job.running || queue.length > 0 || attach.phase === "converting" || converting, done: bgJob.done, total: bgJob.total }, recordOk: recordGate.ok, notes: meetings }),
    [rec.phase, startedAtMs, pausedSec, trayJob.running, trayJob.done, trayJob.total, waitDir, asking, converting, bgJob.done, bgJob.total, imp.job.running, queue.length, attach.phase, recordGate.ok, meetings],
  );
  const trayRef = useRef(trayState);
  trayRef.current = trayState;
  const trayKey = JSON.stringify(trayState);
  useEffect(() => void traySend.current(trayRef.current), [trayKey]); // 숨은 창에서도 늦지 않게 타이머 없이 바로 보낸다
  // 메뉴 막대에서 시작한 녹음이 숨은 창에서 실패하거나 경고가 생기면 창을 꺼내 알린다 (오류·경고는 녹음 화면에만 보인다). 보이는 창은 그대로 둔다
  const recWarns = rec.warnings.length;
  useEffect(() => {
    if (rec.phase === "error" || recWarns > 0) void api.trayShowIfHidden().catch(() => {});
  }, [rec.phase, recWarns]);
  const recPhaseRef = useRef(rec.phase);
  recPhaseRef.current = rec.phase;
  const trayAct = useRef<(raw: unknown) => void>(() => {});
  trayAct.current = (raw) => {
    const route = routeTrayAction(raw, { recPhase: recPhaseRef.current, transcribing: recordBlocked });
    if (!route) return;
    // 메뉴를 빠르게 두 번 눌러도 다시 그리기 전에 두 번째가 들어올 수 있다: 보낸 즉시 단계를 앞당겨 둔다
    if (route.kind === "start") {
      if (recordGate.ok) recPhaseRef.current = "starting";
      onRecordButton();
    } else if (route.kind === "stop") {
      recPhaseRef.current = "stopping";
      void sendRec("stop");
    } else if (route.kind === "pause") {
      void sendRec("pause");
    } else if (route.kind === "resume") {
      void sendRec("resume");
    } else if (route.kind === "bookmark") void sendRec("bookmark");
    else openMeeting(route.id);
  };
  useEffect(() => {
    const un = listen("tray-action", (e) => trayAct.current(e.payload));
    return () => void un.then((f) => f());
  }, []);

  // 글만 있는 노트에 녹음 추가 (attach.ts, docs/desktop.md §2.11). 쓰던 글을 먼저 저장한다 (저장하지 못하면 시작하지 않는다: 오류는 편집기가 보인다)
  const startAttachRecord = useCallback(
    async (t: AttachTarget) => {
      if (recording || transcribing || attachRef.current.phase !== "idle") return;
      if (!recordGate.ok) return notifyBlocked(recordGate);
      if (!(await flushMemos())) return;
      dispatchAttach({ type: "record", target: t });
      resetRec();
      setUnconverted(false);
      void startRec(mode, t.id);
      void go({ kind: "record" });
    },
    [recording, transcribing, recordGate, notifyBlocked, mode, resetRec, startRec, go],
  );
  const attachFile = async (target: AttachTarget, path?: string) => {
    if (!convertGate.ok) return notifyBlocked(convertGate);
    if (recording || transcribing || imp.job.running || queue.length > 0 || attachRef.current.phase !== "idle") return notify({ text: IMPORT_BUSY, error: true });
    let file = path;
    if (!file) {
      try {
        const picked = await open({ multiple: false, directory: false, filters: [{ name: t("오디오·동영상"), extensions: IMPORT_EXTS }] });
        file = picked ?? undefined;
      } catch (e) {
        return notify({ text: t("파일을 고르지 못했습니다: {error}", { error: errText(e) }), error: true });
      }
    }
    if (!file) return;
    if (!isImportable(file)) return notify({ text: t("가져올 수 없는 형식입니다: {files}", { files: baseName(file) }), error: true });
    if (!(await flushMemos())) return;
    importTarget.current = target;
    dispatchAttach({ type: "convert", target });
    setImporting(file);
    void imp.startJob("import", file, target.id);
  };
  attachFileRef.current = attachFile;
  // 낡음 안내는 노트 화면이 처음 뜰 때 한 번만 쓴다 (요약을 다시 만든 뒤 노트를 다시 열었을 때 또 보이지 않게)
  useEffect(() => {
    if (noteEpoch.stale && view.kind === "meeting" && view.id === noteEpoch.id) setNoteEpoch((e) => ({ ...e, stale: false }));
  }, [noteEpoch, view]);
  // 변환이 끝나면(성공이든 실패든) 흐름을 닫는다. 녹음이 시작되지 못했으면 대상 노트를 풀어 준다
  useEffect(() => {
    if (attach.phase === "converting" && !transcribing && !imp.job.running) dispatchAttach({ type: "finish" });
    else if (attach.phase === "recording" && rec.phase === "error") dispatchAttach({ type: "abort" });
  }, [attach.phase, transcribing, imp.job.running, rec.phase]);

  // `새 노트` 메뉴 (⌘N은 메뉴 없이 바로 글쓰기)
  // 온보딩의 예시 노트: 코어가 만들거나(이미 있으면 그것) 목록을 다시 읽고 연다
  const sampleBusy = useRef(false); // 두 번 빨리 눌러도 한 번만 (코어도 잠금으로 하나만 만든다)
  const openSample = async () => {
    if (sampleBusy.current) return;
    sampleBusy.current = true;
    try {
      const id = await api.noteSample();
      openMeeting(id);
      void refresh();
    } catch (e) {
      notify({ text: t("예시 노트를 열지 못했습니다: {error}", { error: errText(e) }), error: true });
    } finally {
      sampleBusy.current = false;
    }
  };

  const onNewNote = (a: NewNoteAction) => {
    if (a === "write") void newMemo();
    else if (a === "record") onRecordButton();
    else void pickFiles();
  };

  // 변환 전 노트의 변환 (recorded.ts): 한 노트도, 모두도 같은 줄에 올린다. 못 쓰면 이유와 고치는 길을 알린다
  const convertNote = useCallback(
    (id: string) => {
      const gate = capsRef.current.can("convert");
      if (!gate.ok) return notifyBlocked(gate);
      setConvQ((q) => convertEnqueue(q, [id]));
    },
    [notifyBlocked],
  );
  const bulkIds = useMemo(() => recordedIds(meetings), [meetings]);
  const convertAll = () => {
    if (!convertGate.ok) return notifyBlocked(convertGate);
    setConvQ((q) => convertEnqueue(q, bulkIds));
  };
  const convertSlots = useMemo(() => {
    const slots = new Map<string, "running" | "queued">();
    for (const id of [convQ.current, ...convQ.pending]) {
      const slot = id === null ? null : convertSlot(convQ, id, convertRunning);
      if (id !== null && slot) slots.set(id, slot);
    }
    return slots;
  }, [convQ, convertRunning]);
  const waitReason = recording ? WAIT_RECORDING : WAIT_OTHER;
  const convertControls: ConvertControls | undefined = view.kind === "meeting" ? { slot: convertSlot(convQ, view.id, convertRunning), waitReason, gate: convertGate, onConvert: convertNote } : undefined;
  const convTitle = converting ? (meetings.find((m) => m.id === convQ.current)?.title ?? "") : "";
  const convPct = convJob.total ? convJob.done / convJob.total : null;
  const convProgress = convertProgress(convQ);
  const railRec = railRecState({ recording, asking, busy: transcribe.job.running || waitDir !== null || finish.job.running || imp.job.running || queue.length > 0 });
  const recButtonView = recButton({ phase: rec.phase, t: rec.t, saving: finish.job.running, converting: transcribe.job.running, waiting: waitDir !== null, asking });
  // 녹음을 끝내고 묻는 창에서 고른 것: 바로 변환 | 노트로 저장. `다음부터 묻지 않기`를 체크했으면 그 선택을 설정에 남긴다
  const chooseAfter = (choice: AskChoice, remember: boolean) => {
    const a = afterAsk;
    if (!a) return;
    setAfterAsk(null);
    const run = effectiveChoice(choice, capsRef.current.can("convert").ok); // 창이 뜬 사이 변환할 수 없게 됐다면 노트로 저장한다
    const keep = rememberedChoice(run, remember);
    if (keep) void api.setAfterRecord(keep).catch((e) => notify({ text: t("설정을 저장하지 못했습니다: {error}", { error: errText(e) }), detail: errDetail(e), error: true }));
    if (run === "convert") startTranscribe(a.dir, null);
    else finishRecording(a.dir);
  };
  // 남은 녹음을 변환하지 않고 노트로 저장한다 (`노트로 저장`): 진행은 녹음 화면에 보인다. 글만 있는 노트에 추가하려던 녹음은 덧붙여야 하므로 이 길이 없다
  const saveLeftover = (dir: string) => {
    finishRecording(dir);
    void go({ kind: "record" });
  };
  const dialogText = del.target && deleteDialogText(del.target);
  // 보고 있는 노트가 글만 있는 노트면 녹음 추가 단추·잠금. 못 쓰는 동안(녹음·변환 중)에는 파일을 놓아도 새 노트 가져오기로 간다
  const viewNote = view.kind === "meeting" ? resolveTarget(view.id, meetings) : null;
  const viewLock = view.kind === "meeting" ? lockOf(attach, view.id) : null;
  const addBlock = addBlocked({ recording, transcribing, lock: viewLock, busy: imp.job.running || queue.length > 0 });
  const attachControls: AttachControls = { lock: viewLock, blocked: addBlock, convert: convertGate, onRecord: (t) => void startAttachRecord(t), onFile: (t) => void attachFile(t) };
  dropNote.current = viewNote && !addBlock && convertGate.ok ? viewNote : null;
  const activeId = view.kind === "meeting" ? view.id : null;
  const memoIds = useMemo(() => new Set(meetings.filter(isMemo).map((m) => m.id)), [meetings]);
  const knownNotes = useMemo(() => (listLoaded ? new Set(meetings.map((m) => m.id)) : null), [listLoaded, meetings]);

  return (
    <CapsContext.Provider value={caps}>
    <OrganizeContext.Provider value={org}>
    <div className={cn("shell grid h-screen", panels.state.left ? "is-left-collapsed grid-cols-[80px_minmax(0,1fr)]" : "grid-cols-[var(--sidebar-w)_minmax(0,1fr)]")}>
      <aside className="relative flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        {/* 타이틀바를 겹친 창: 신호등 단추 자리 + 창 끌기 */}
        <div data-tauri-drag-region className="h-[52px] shrink-0" />
        <PanelToggle side="left" />
        {!panels.state.left && <PanelResizer side="left" />}
        {panels.state.left && (
          <GatedButton
            gate={recording || recordBlocked ? OK : recordGate}
            className={cn("mt-10 grid size-9 place-items-center self-center rounded-full shadow-xs transition-colors", recording ? "bg-rec" : "bg-primary hover:bg-primary/85")}
            onClick={() => onRecordButton()}
            aria-current={view.kind === "record"}
            aria-label={RAIL_REC_LABEL[railRec]}
            title={RAIL_REC_LABEL[railRec]}
          >
            <span className={cn("size-2.5 rounded-full", recording ? "animate-rec-pulse bg-white" : "bg-rec")} aria-hidden />
          </GatedButton>
        )}
        {panels.state.left && (
          <nav className="mt-3 flex flex-col items-center gap-1" aria-label={t("이동")}>
            <Button variant="sidebar" size="icon" className="justify-center" aria-label={t("홈")} title={t("홈")} aria-current={view.kind === "home"} onClick={() => void go({ kind: "home" })}>
              <House aria-hidden />
            </Button>
            <Button variant="sidebar" size="icon" className="justify-center" aria-label={t("설정")} title={t("설정")} aria-current={view.kind === "settings"} onClick={() => void go({ kind: "settings" })}>
              <Settings aria-hidden />
            </Button>
          </nav>
        )}
        {panels.state.left && leftover.length > 0 && (
          <span className="mt-2 min-w-5 self-center rounded-full bg-rec px-1.5 text-center text-[11px] font-semibold leading-[18px] text-white" role="img" aria-label={railPendingLabel(leftover.length)} title={railPendingLabel(leftover.length)}>
            {leftover.length}
          </span>
        )}
        <div id="sidebar-body" className="flex min-h-0 flex-1 flex-col" hidden={panels.state.left}>
        <header className="sr-only">
          <span>Tractus</span>
          <span>{t("노트와 녹음")}</span>
        </header>

        <div className="flex flex-col gap-1.5 px-3">
          <div className="flex gap-1.5">
            <GatedButton
              gate={recording || recordBlocked ? OK : recordGate}
              className={cn(buttonVariants({ variant: recButtonView.live ? "rec" : "outline" }), "flex-1 justify-start gap-2 bg-background", recButtonView.live && "bg-rec", rec.phase === "paused" && "opacity-80")}
              onClick={() => onRecordButton()}
              aria-current={view.kind === "record"}
            >
              <span className={cn("size-2 shrink-0 rounded-full", recButtonView.live ? "bg-white" : "bg-rec", rec.phase === "recording" && "animate-rec-pulse")} aria-hidden />
              <span>{recButtonView.text}</span>
              {recButtonView.time && <time className="ml-auto tabular-nums opacity-90">{recButtonView.time}</time>}
            </GatedButton>
            <NewNoteMenu
              onPick={onNewNote}
              disabled={{ write: creating ? t("만드는 중…") : undefined, record: recording ? t("이미 녹음 중입니다") : asking ? ASK_BLOCKS_RECORD : recordBlocked ? t("변환이 끝난 뒤에 녹음할 수 있습니다") : undefined }}
            />
          </div>

          {!recording && recordNotice(convertGate) && (
            <p className="px-1 text-xs text-muted-foreground" role="note">
              {recordNotice(convertGate)}
            </p>
          )}

          <div className="grid grid-cols-2 gap-0.5 rounded-md bg-sidebar-accent p-0.5" role="radiogroup" aria-label={t("녹음 방식")}>
            {REC_MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                role="radio"
                aria-checked={mode === m.mode}
                title={m.note}
                disabled={recording}
                onClick={() => chooseMode(m.mode)}
                className="h-6 whitespace-nowrap rounded-[5px] text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-px px-2">
          <form
            className="relative mb-1 px-1"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              const q = searchRef.current?.value.trim();
              if (q) void go({ kind: "search", q });
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
            <Input ref={searchRef} type="search" placeholder={t("노트 검색")} aria-label={t("노트 검색")} className="h-7 bg-background/70 pr-10 pl-7" />
            <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">⌘K</Kbd>
          </form>
          <button className={SIDE_ITEM} aria-current={view.kind === "home"} onClick={() => void go({ kind: "home" })}>
            <House aria-hidden />
            {t("홈")}
          </button>
          <button
            ref={askButton}
            className={cn(SIDE_ITEM, "group/ai relative isolate hover:bg-transparent aria-expanded:bg-sidebar-accent")}
            aria-expanded={askOpen}
            aria-controls="ask-drawer"
            aria-keyshortcuts="Meta+J"
            aria-label={t("AI 어시스턴트")}
            title={t("AI 어시스턴트 (⌘J)")}
            data-tip="ask"
            onClick={() => setAskOpen((o) => !o)}
          >
            {/* 가리키면 옅은 보라→하늘색 바탕이 번진다 */}
            <span className="pointer-events-none absolute inset-0 -z-10 rounded-md bg-gradient-to-r from-violet-500/14 via-sky-500/10 to-transparent opacity-0 transition-opacity duration-300 group-hover/ai:opacity-100" aria-hidden />
            <SparklesIcon className="text-muted-foreground" />
            <span className="group-hover/ai:bg-[linear-gradient(90deg,var(--sidebar-foreground)_0%,var(--sidebar-foreground)_35%,#8b5cf6_45%,#0ea5e9_55%,var(--sidebar-foreground)_65%,var(--sidebar-foreground)_100%)] bg-[length:200%_100%] bg-clip-text group-hover/ai:animate-shine group-hover/ai:text-transparent">{t("AI 어시스턴트")}</span>
            <Kbd className="ml-auto">⌘J</Kbd>
          </button>
          <GatedButton gate={convertGate} className={SIDE_ITEM} onClick={pickFiles} title={t("{exts} — 창에 끌어 놓아도 됩니다", { exts: IMPORT_EXTS.join(" ") })}>
            <Upload aria-hidden />
            {t("파일 가져오기")}
          </GatedButton>
          {bulkIds.length >= BULK_MIN && !converting && (
            <GatedButton gate={convertGate} className={SIDE_ITEM} disabled={transcribing || recording} onClick={convertAll} title={CONVERT_ALL_TITLE}>
              <AudioLines aria-hidden />
              {CONVERT_ALL(bulkIds.length)}
            </GatedButton>
          )}
        </div>

        {(imp.job.running || queue.length > 0) && (
          <section className={JOB_CARD} aria-live="polite" aria-label={t("가져오기 진행")}>
            <p className="truncate font-medium text-foreground">{importing ? baseName(importing) : t("대기 중")}</p>
            <p className="flex justify-between gap-2 tabular-nums">
              <span>{STAGE_LABEL[imp.job.stage ?? ""] ?? STAGE_FALLBACK}</span>
              <span>{[importPct !== null && `${Math.round(importPct * 100)}%`, queue.length > 0 && t("대기 {n}개", { n: queue.length })].filter(Boolean).join(" · ")}</span>
            </p>
            <Progress value={importPct} />
            {imp.job.warnings
              .filter((w) => w.code !== "duplicate")
              .map((w) => (
                <p key={w.code} className="text-memo">
                  {warningText(w)}
                </p>
              ))}
          </section>
        )}
        {converting && (
          <section className={JOB_CARD} aria-live="polite" aria-label={t("변환 전 노트 변환 진행")}>
            <p className="truncate font-medium text-foreground">{convProgress ? CONVERT_ALL_LINE(convProgress.n, convProgress.total, convTitle) : noteLabel(convTitle)}</p>
            <p className="flex justify-between gap-2 tabular-nums">
              <span>{convertRunning ? (STAGE_LABEL[convJob.stage ?? ""] ?? STAGE_FALLBACK) : waitReason}</span>
              <span>{convertRunning && convPct !== null ? `${Math.round(convPct * 100)}%` : ""}</span>
            </p>
            <Progress value={convertRunning ? convPct : null} />
          </section>
        )}

        <nav className="meeting-nav mt-2 min-h-0 flex-1 overflow-y-auto border-t border-sidebar-border px-2 pt-2 pb-6" aria-label={t("노트 목록")}>
          {listError && (
            <div className="m-2 text-xs text-destructive">
              <p>{listError.text}</p>
              <ErrorDetail detail={listError.detail} />
            </div>
          )}
          {leftover.length > 0 && (
            <section className="mb-2">
              <h2 className={SIDE_HEAD}>{t("변환 대기 중인 녹음")}</h2>
              <ul>
                {leftover.map((p) => {
                  // 글만 있는 노트에 추가하려던 녹음이면 그 노트(아직 글만 있을 때)에 이어서 추가한다. 노트가 없어졌으면 새 노트로 변환한다
                  const into = pendingTarget(p, meetings);
                  const label = into ? PENDING_LABEL(into.title) : recordingLabel(p.started_at);
                  return (
                  <li key={p.dir} className="group relative">
                    <GatedButton
                      gate={convertGate}
                      className={NOTE_LINK}
                      disabled={transcribing}
                      onClick={() => {
                        startTranscribe(p.dir, into);
                        void go({ kind: "record" });
                      }}
                    >
                      <span className="block truncate text-[13px] font-medium tabular-nums">{label}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                        {p.duration === null ? t("끊긴 녹음") : fmtTime(p.duration)}
                        <Badge variant="rec">{into ? ADD_BADGE : t("변환하기")}</Badge>
                      </span>
                    </GatedButton>
                    <span className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      {!into && (
                        <Button variant="outline" size="sm" className="h-6 px-2" disabled={transcribing || recording} aria-label={`${label} ${SAVE_NOTE}`} title={SAVE_NOTE_TITLE} onClick={() => saveLeftover(p.dir)}>
                          {SAVE_NOTE}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 hover:border-destructive hover:text-destructive"
                        disabled={transcribing}
                        aria-label={t("{label} 삭제", { label })}
                        title={t("삭제 (휴지통으로 이동)")}
                        onClick={() => askDelete({ kind: "recording", dir: p.dir, startedAt: p.started_at })}
                      >
                        {t("삭제")}
                      </Button>
                    </span>
                  </li>
                  );
                })}
              </ul>
            </section>
          )}
          {!listError && meetings.length === 0 && leftover.length === 0 && <p className="m-2 text-xs text-muted-foreground">{t("아직 노트가 없습니다. 새 노트로 녹음을 시작하거나 글을 쓰거나, 설정에서 데이터 위치를 확인하세요.")}</p>}
          <NoteLibrary notes={meetings} activeId={activeId} onOpen={openMeeting} convertSlots={convertSlots} onConvert={convertNote} />
        </nav>

        <footer className="flex items-center gap-0.5 border-t border-sidebar-border px-2 py-1.5">
          <Button variant="sidebar" size="sm" className="gap-1.5 text-muted-foreground aria-[current=true]:text-foreground" onClick={() => void go({ kind: "settings" })} aria-current={view.kind === "settings"}>
            <Settings aria-hidden />
            {t("설정")}
          </Button>
          <Button variant="sidebar" size="sm" className="gap-1.5 text-muted-foreground aria-[current=true]:text-foreground" onClick={() => void go({ kind: "models" })} aria-current={view.kind === "models"}>
            <Box aria-hidden />
            {MODELS_LABEL}
          </Button>
          <span className="ml-auto pr-2 text-[11px] text-subtle-foreground tabular-nums">{t("노트 {n}개", { n: meetings.length })}</span>
        </footer>
        </div>
      </aside>

      <main className="main relative h-screen overflow-hidden bg-background">
        {view.kind === "home" && <Welcome notes={meetings} onOpen={openMeeting} onAction={onNewNote} onRecordEvent={onRecordButton} onSample={() => void openSample()} recordGate={recording || recordBlocked ? OK : recordGate} convertGate={convertGate} recording={recording} />}
        {view.kind === "meeting" && (
          <MeetingView
            key={noteEpoch.id === view.id ? `${view.id}.${noteEpoch.n}` : view.id}
            id={view.id}
            seek={view.seek}
            onChanged={refresh}
            onEdited={touchNote}
            notify={notify}
            onDelete={askDelete}
            attach={attachControls}
            convert={convertControls}
            summaryStale={noteEpoch.stale && noteEpoch.id === view.id}
          />
        )}
        {view.kind === "search" && <SearchView key={view.q} query={view.q} onOpen={openMeeting} memoIds={memoIds} />}
        {view.kind === "record" && <RecordView rec={rec} captions={live} job={progressKind === "save" ? finish.job : waitDir ? { ...IDLE_JOB, running: true, stage: "wait_import" } : transcribe.job} progressKind={progressKind} choosing={afterAsk !== null} send={sendRec} retry={() => (progressKind === "save" ? finishDir.current && finishRecording(finishDir.current) : transcribeDir.current && startTranscribe(transcribeDir.current, transcribeTarget.current))} unconverted={unconverted ? UNCONVERTED_SAVED : null} attachTitle={attach.phase !== "idle" ? (attach.target?.title ?? null) : null} />}
        {view.kind === "settings" && <SettingsView onBack={goBack} onSaved={() => void Promise.all([refresh(), caps.refresh()])} relaunchBlocked={recording || transcribing || imp.job.running || queue.length > 0} />}
        {view.kind === "models" && <ModelsView onBack={goBack} />}
        {view.kind !== "record" && <RecHeaderControls phase={rec.phase} send={sendRec} />}
      </main>

      <aside
        id="ask-drawer"
        className="fixed inset-y-0 right-0 z-30 flex w-[min(440px,calc(100vw-var(--sidebar-w)))] flex-col overflow-y-auto border-l border-border bg-background px-5 shadow-pop animate-in slide-in-from-right-4 fade-in-0 duration-200"
        role="dialog"
        aria-labelledby="ask-drawer-title"
        hidden={!askOpen}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            closeAsk();
          }
        }}
      >
        <header data-tauri-drag-region className="sticky top-0 z-10 -mx-5 flex h-[52px] shrink-0 items-center justify-between gap-2 bg-background/90 px-5 backdrop-blur-md">
          <h2 id="ask-drawer-title" className="m-0 flex items-center gap-2 text-[13px] font-semibold">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            {t("AI 어시스턴트")}
          </h2>
          <Button variant="ghost" size="icon-sm" aria-label={t("닫기 (Esc)")} onClick={closeAsk}>
            <X aria-hidden />
          </Button>
        </header>
        <AskPanel scope={GLOBAL} inputRef={askInput} notes={knownNotes} memoIds={memoIds} onCite={(meetingId, segId, t) => openMeeting(meetingId, { segId, t })} />
      </aside>

      {del.target && dialogText && (
        <ConfirmDialog
          title={dialogText.title}
          body={dialogText.body}
          cancelLabel={dialogText.cancel}
          confirmLabel={del.busy ? dialogText.busy : dialogText.confirm}
          busy={del.busy}
          onCancel={() => dispatchDel({ type: "cancel" })}
          onConfirm={() => void confirmDelete()}
        />
      )}
      {afterAsk && <AfterRecordDialog seconds={afterAsk.seconds} convert={convertGate} onChoose={chooseAfter} />}
      {dropAsk && (
        <ConfirmDialog
          title={DROP_CONFIRM.title(dropAsk.target.title)}
          body={DROP_CONFIRM.body}
          cancelLabel={DROP_CONFIRM.cancel}
          confirmLabel={DROP_CONFIRM.confirm}
          busy={false}
          onCancel={() => setDropAsk(null)}
          onConfirm={() => {
            const { target, path } = dropAsk;
            setDropAsk(null);
            void attachFileRef.current(target, path);
          }}
        />
      )}
      {checkupOpen && <Checkup onClose={closeCheckup} />}
      {dropping && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-content-center gap-2 rounded-2xl border-2 border-dashed border-ring bg-background/85 text-center backdrop-blur-sm animate-in fade-in-0 zoom-in-[0.98]" aria-hidden>
          <Upload className="mx-auto size-8 text-ring" />
          <p className="m-0 text-xl font-semibold">{!convertGate.ok ? DROP_UNAVAILABLE : dropNote.current && dropCount === 1 ? DROP_LABEL(dropNote.current.title) : t("파일을 놓으면 텍스트로 변환합니다")}</p>
          <small className="text-xs text-muted-foreground">{IMPORT_EXTS.join(" · ")}</small>
        </div>
      )}
      <div className="fixed bottom-6 left-1/2 z-40 grid max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 justify-items-center gap-2" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </div>
    </OrganizeContext.Provider>
    </CapsContext.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (toast.error) return;
    const h = setTimeout(() => close.current(), TOAST_MS);
    return () => clearTimeout(h);
  }, [toast.error]);
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border border-border bg-popover py-1.5 pr-1.5 pl-3.5 text-[13px] text-popover-foreground shadow-pop animate-in fade-in-0 slide-in-from-bottom-2", toast.error && "border-destructive/40")} role={toast.error ? "alert" : "status"}>
      {toast.error && <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 flex-1 py-1">
        {toast.text}
        <ErrorDetail detail={toast.detail} />
      </div>
      {toast.action && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("알림 닫기")} onClick={onClose}>
        <X aria-hidden />
      </Button>
    </div>
  );
}

const RECENT_MAX = 6;

function Welcome({ notes, onOpen, onAction, onRecordEvent, onSample, recordGate, convertGate, recording }: { notes: MeetingInfo[]; onOpen: (id: string) => void; onAction: (a: NewNoteAction) => void; onRecordEvent: (ev: CalendarEvent) => void; onSample: () => void; recordGate: Decision; convertGate: Decision; recording: boolean }) {
  const caps = useCapabilities();
  const { openCheckup, openModels } = caps;
  const next = useNextEvent();
  const onboard = useOnboard();
  const steps = onboardSteps(onboard, notes, caps.can("convert").ok);
  const checklist = showOnboard(onboard, steps);
  const onStep = (id: StepId) => (id === "models" ? openModels() : id === "record" ? onAction("record") : onSample());
  const recent = useMemo(() => [...notes].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)).slice(0, RECENT_MAX), [notes]);
  const keys: [string[], string][] = [
    [["⌘N"], t("글쓰기 (새 메모)")],
    [["⌘K"], t("검색")],
    [["Space"], t("재생 / 일시정지")],
    [["B"], t("녹음 중 북마크")],
    [["←", "→"], t("5초 이동 (Shift 10초)")],
    [["R"], t("직전 문장 다시 듣기")],
    [["⌘F"], t("찾아 바꾸기")],
    [["⌘J"], t("AI 어시스턴트")],
    [["⌘B"], t("노트 목록 접기·펼치기")],
    [["⌥⌘B"], t("오른쪽 패널 접기·펼치기")],
  ];
  const action = "flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left outline-none transition-colors hover:border-border-strong hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40 gated:opacity-50 [&_svg]:size-5";
  return (
    <section className="relative isolate flex h-full flex-col overflow-y-auto">
      <FlickeringGrid className="absolute inset-x-0 top-0 -z-10 h-[360px] [mask-image:radial-gradient(ellipse_70%_100%_at_50%_0%,black_20%,transparent_75%)]" />
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-8 pt-10 pb-16">
        <h1 className="sr-only">{t("홈")}</h1>
        {notes.length === 0 && <p className="m-0 text-[15px] font-medium">{t("녹음하거나 메모를 써서 노트를 만드세요. 녹음은 이 Mac에서 텍스트로 변환되고, 파일로 남습니다.")}</p>}

        {next && <NextEventCard ev={next} gate={recordGate} recording={recording} onRecord={() => onRecordEvent(next)} />}
        {checklist && <OnboardingCard steps={steps} onStep={onStep} />}
        {/* 홈의 안내는 시작하기 목록을 마치거나 닫은 뒤에 (목록을 가리지 않게) */}
        <CoachMark id="ask" side="right" ready={!checklist && notes.some((n) => !n.sample)} />
        {next && <CoachMark id="calendar" ready={!checklist} />}

        <div className="grid grid-cols-3 gap-3">
          <GatedButton gate={recordGate} className={action} disabled={recording} onClick={() => onAction("record")}>
            <span className="grid size-9 place-items-center rounded-full bg-rec-wash text-rec">
              <Mic aria-hidden />
            </span>
            <span className="text-[13px] font-medium">{t("녹음 시작")}</span>
          </GatedButton>
          <button type="button" className={action} onClick={() => onAction("write")}>
            <span className="grid size-9 place-items-center rounded-full bg-memo-wash text-memo">
              <SquarePen aria-hidden />
            </span>
            <span className="flex w-full items-center justify-between text-[13px] font-medium">
              {t("글쓰기")} <Kbd>⌘N</Kbd>
            </span>
          </button>
          <GatedButton gate={convertGate} className={action} onClick={() => onAction("import")}>
            <span className="grid size-9 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Upload aria-hidden />
            </span>
            <span className="text-[13px] font-medium">{t("파일 가져오기")}</span>
          </GatedButton>
        </div>

        {recent.length > 0 && (
          <section aria-labelledby="recent-title" className="flex flex-col gap-2">
            <h2 id="recent-title" className="m-0 px-1 text-[13px] font-semibold">
              {t("최근 노트")}
            </h2>
            <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0">
              {recent.map((m) => (
                <li key={m.id}>
                  <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent" onClick={() => onOpen(m.id)}>
                    {isMemo(m) ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.title || t("제목 없음")}</span>
                    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                      {new Date(m.updated_at ?? m.created_at).toLocaleDateString(locale(), { month: "short", day: "numeric" })} · {noteTime(m)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-[13px] font-semibold select-none">
            {t("단축키")}
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-[13px]">
            {keys.map(([ks, label]) => (
              <div key={label} className="flex items-center gap-3">
                <dt className="flex w-16 shrink-0 gap-0.5">
                  {ks.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </dt>
                <dd className="m-0 text-muted-foreground">{label}</dd>
              </div>
            ))}
          </dl>
        </details>

        <p className="m-0 flex gap-2">
          <Button variant="outline" size="sm" onClick={openCheckup}>
            <Stethoscope aria-hidden />
            {CHECKUP_LABEL}
          </Button>
          <Button variant="outline" size="sm" onClick={openModels}>
            <Box aria-hidden />
            {MODELS_LABEL}
          </Button>
        </p>
      </div>
    </section>
  );
}

/** 홈: 진행 중이거나 15분 안에 시작하는 캘린더 일정 하나 (calendar.ts) */
function NextEventCard({ ev, gate, recording, onRecord }: { ev: CalendarEvent; gate: Decision; recording: boolean; onRecord: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const people = attendeeLine(ev.attendees);
  return (
    <section aria-label={CARD_LABEL} data-tip="calendar" className="flex items-center gap-4 rounded-lg border border-border bg-card/90 p-4 shadow-xs backdrop-blur-sm">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-rec-wash text-rec">
        <CalendarClock className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-xs font-medium text-muted-foreground tabular-nums">{eventWhen(ev, now)}</p>
        <p className="m-0 truncate text-[15px] font-semibold leading-6" title={ev.title}>
          {ev.title}
        </p>
        {people && <p className="m-0 truncate text-xs text-subtle-foreground">{people}</p>}
      </div>
      <GatedButton gate={gate} className={buttonVariants({ variant: "rec", size: "sm" })} disabled={recording} onClick={onRecord}>
        <Mic aria-hidden />
        {CARD_RECORD}
      </GatedButton>
    </section>
  );
}
