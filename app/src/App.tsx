import { ToastItem } from "@/components/Toast";
import { isTranscribing, type Activity } from "./jobSchedule";
import { useConvertQueue } from "./useConvertQueue";
import { useImportQueue } from "./useImportQueue";
import { useFileDrop } from "./useFileDrop";
import { useTranscribeQueue } from "./useTranscribeQueue";
import { useWorkScheduler } from "./useWorkScheduler";
import { SidebarJobs } from "@/components/sidebar/SidebarJobs";
import { LeftoverRecordings } from "@/components/sidebar/LeftoverRecordings";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { Welcome } from "@/components/home/Welcome";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { attachAlignJobs } from "./alignJobs";
import { api, errDetail, errFull, errText, useJob, useRecorder, type CalendarEvent, type MeetingInfo, type PendingRecording } from "./api";
import { AskPanel } from "./AskPanel";
import { DROP_UNAVAILABLE, MODELS_LABEL, OK, recordNotice, UNCONVERTED_SAVED } from "./caps";
import { Checkup } from "./Checkup";
import { GatedButton } from "./GatedButton";
import { DOWNLOAD_DONE, downloadErrorView } from "./models";
import { ModelsView } from "./ModelsSettings";
import { DictionaryView } from "./DictionaryView";
import { attachModelsJobs } from "./modelsJob";
import { CapsContext, useCapabilitiesState } from "./useCapabilities";
import { OPEN_SETTINGS } from "./llmKey";
import { addBlocked, attachReduce, DROP_CONFIRM, DROP_LABEL, IDLE_ATTACH, IMPORT_BUSY, lockOf, resolveTarget, type AttachControls, type AttachTarget } from "./attach";
import { ConfirmDialog } from "./ConfirmDialog";
import { editQueue } from "./editQueue";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { bindIndexer, indexer } from "./indexer";
import { baseName, errorView, isImeKey, isRecLive, IDLE_JOB, JOB_ERROR, IMPORT_EXTS, isImportable, isTypingTarget, recMode, REC_MODES, type RecMode } from "./lib";
import { MeetingView, type ExportReq } from "./MeetingView";
import type { NewNoteAction } from "./menu";
import { NewNoteMenu } from "./NewNoteMenu";
import { dropMemo, exportFormatsFor, flushMemos, isMemo, settleMemo } from "./memo";
import { RecordView } from "./RecordView";
import { deleteDialogText, deletedText, deleteFailure, deleteReduce, IDLE_DELETE, type DeleteTarget } from "./remove";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { createTraySender, deriveTrayState, routeTrayAction } from "./tray";
import { AfterRecordDialog } from "./AfterRecordDialog";
import { afterRecord, ASK_BLOCKS_RECORD, effectiveChoice, rememberedChoice, stopAction, type AskChoice } from "./afterRecord";
import { LIVE_BLOCKS_RECORD, recordBlock } from "./recordBusy";
import { recButton } from "./pause";
import { BULK_MIN, CONVERT_ALL, CONVERT_ALL_TITLE, isRecorded, WAIT_OTHER, WAIT_RECORDING, type ConvertControls } from "./recorded";
import { NoteLibrary } from "./NoteLibrary";
import { QuickFind } from "./QuickFind";
import { CommandPalette } from "./CommandPalette";
import type { PaletteAction } from "./palette";
import { folderPath, touchNote as touchNoteIn, type Folder } from "./organize";
import { OrganizeContext, useOrganizeState } from "./useOrganize";
import { PanelResizer, PanelToggle, usePanels } from "./PanelToggle";
import { PANEL_TEXT, RAIL_REC_LABEL, railPendingLabel, railRecState, toggleLabel } from "./panels";
import { check } from "@tauri-apps/plugin-updater";
import { AudioLines, BookA, Box, Download, Folder as FolderIcon, House, Mic, PanelLeft, Settings, Sparkles, SquarePen, Star, Stethoscope, Tag, Upload, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/components/ui/utils";
import { SIDE_ITEM } from "@/components/sidebar";
import { SparklesIcon } from "@/components/ui/sparkles-icon";
import logo from "./assets/logo.png";
import { markSeen, newVersionToast, noteExcerpt, OPEN_SETTINGS_LABEL, remembered, seenVersion, START_DELAY_MS, updateNotice, updateReduce } from "./update";
import { UpdateDialog } from "./UpdateDialog";

export type Seek = { segId?: string; t?: number; nonce: number };
export type View =
  | { kind: "home" }
  | { kind: "meeting"; id: string; seek?: Seek }
  | { kind: "search"; q: string }
  | { kind: "record" }
  | { kind: "settings"; toUpdate?: number } // toUpdate: 업데이트 절로 내려간다 (누를 때마다 새 값)
  | { kind: "models" }
  | { kind: "dictionary" };

const GLOBAL = { kind: "global" } as const;

/** 화면 아래 알림. 오류는 닫을 때까지 남고, 새 알림이 와도 밀려나지 않는다(쌓인다). detail: 원래 문구 (접힌 '자세히') */
export type Toast = { text: string; detail?: string | null; error?: boolean; action?: { label: string; run: () => void } };
export type Notify = (t: Toast) => void;
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
  const searchRef = useRef<HTMLInputElement>(null);
  // 전체 회의에 질문 (6.3): 오른쪽 서랍. 닫아도 대화는 남는다(앱을 끄기 전까지)
  const [askOpen, setAskOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exportReq, setExportReq] = useState<ExportReq | null>(null); // ⌘K의 노트 내보내기 요청
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
      return m; // 새로 읽은 노트 목록 (못 읽으면 undefined)
    } catch (e) {
      setListError({ text: errText(e), detail: errDetail(e) });
    }
  }, []);
  const touchNote = useCallback((id: string, updatedAt: string) => setMeetings((ms) => touchNoteIn(ms, id, updatedAt) as typeof ms), []);
  // 노트 정리(즐겨찾기·태그·폴더·순서): 사이드바와 노트 머리가 같은 상태를 본다 (useOrganize.ts)
  const refreshVoid = useCallback(() => refresh().then(() => {}), [refresh]);
  const org = useOrganizeState({ meetings, setMeetings, folders, setFolders, refresh: refreshVoid, notify });
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
  // 설정·모델·사전 화면의 `뒤로`: 그 화면을 열기 전에 보던 화면 (노트·검색·녹음·홈)
  const lastContent = useRef<View>({ kind: "home" });
  if (view.kind !== "settings" && view.kind !== "models" && view.kind !== "dictionary") lastContent.current = view;
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
  const openSettings = useCallback(() => {
    setAskOpen(false);
    setCheckupOpen(false);
    void go({ kind: "settings" });
  }, [go]);
  const caps = useCapabilitiesState({
    openModels: useCallback(() => {
      setCheckupOpen(false);
      void go({ kind: "models" });
    }, [go]),
    openCheckup: useCallback(() => setCheckupOpen(true), []),
    openSettings,
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

  // 녹음 정지 → 전사 → 회의 상세. 다음 녹음을 하는 중에 앞 녹음의 변환이 끝났으면(recordBusy.ts) 화면을 바꾸지 않고 알린다: 녹음 화면의 메모·북마크가 끊기지 않게
  const recordingRef = useRef(false);
  // 녹음 변환 줄 (useTranscribeQueue.ts): 언제 시작하는가는 아래 useWorkScheduler가 정한다
  const transcribe = useTranscribeQueue({
    notify,
    refresh,
    openMeeting,
    markNoteStale: (id) => setNoteEpoch((e) => ({ id, n: e.n + 1, stale: true })),
    isRecording: () => recordingRef.current,
    failureHidden: () => recordingRef.current || viewRef.current.kind !== "record",
  });
  const waitDir = transcribe.waitDir;
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
  // 변환 전 노트의 변환 줄 (useConvertQueue.ts): 언제 시작하는가는 아래 useWorkScheduler가 정한다
  const convert = useConvertQueue({
    meetings,
    convertGate: () => capsRef.current.can("convert"),
    notify,
    notifyBlocked,
    refresh,
    openMeeting,
    isViewing: (noteId) => viewRef.current.kind === "meeting" && viewRef.current.id === noteId,
  });
  const { converting, running: convertRunning, job: convJob, bulkIds, convertNote, convertAll, slots: convertSlots, title: convTitle, pct: convPct, progress: convProgress } = convert;
  // 녹음 변환을 줄에 세운다. "다시 변환"은 방금 녹음뿐 아니라 사이드바의 남은 녹음에도 쓴다
  const enqueueTranscribe = transcribe.enqueue;
  const startTranscribe = useCallback(
    (dir: string, target?: AttachTarget | null) => {
      setProgressKind("convert");
      setUnconverted(false);
      if (target) dispatchAttach({ type: "convert", target });
      enqueueTranscribe(dir, target ?? null);
    },
    [enqueueTranscribe],
  );
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
        transcribe.forget(t.dir);
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
  recordingRef.current = recording;
  // 실시간 텍스트 변환: 켜 두면 변환 중에는 녹음하지 않는다(recordBusy.ts). 처음과 설정 화면을 나올 때 읽고,
  // 이번 녹음에 켜졌는지(liveRec)는 녹음을 시작할 때 정한다(Rust도 녹음을 시작할 때의 설정으로 자막을 띄운다)
  const [liveOn, setLiveOn] = useState(false);
  const [liveRec, setLiveRec] = useState(false);
  const liveOnRef = useRef(false); // useCallback 안(노트에 녹음 추가)에서도 지금 값을 읽는다
  liveOnRef.current = liveOn;
  const readLive = useCallback(() => void api.getSettings().then((s) => setLiveOn(!!s.live_captions), () => {}), []);
  useEffect(() => {
    if (view.kind !== "settings") readLive();
  }, [view.kind, readLive]);

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

  // 파일 가져오기 줄 (useImportQueue.ts)
  const importQ = useImportQueue({
    convertGate: () => capsRef.current.can("convert"),
    notify,
    notifyBlocked,
    refresh,
    openMeeting,
    markNoteStale: (id) => setNoteEpoch((e) => ({ id, n: e.n + 1, stale: true })),
  });
  const { imp, queue, importing, importPct, enqueue, startAttach } = importQ;
  // 무거운 작업은 한 번에 하나씩 순서대로 시작한다: 규칙은 jobSchedule.ts(테스트), 시작은 useWorkScheduler가 한다
  const activity: Activity = {
    recording,
    liveRec,
    asking,
    transcribeRunning: transcribe.job.running,
    transcribeWaiting: waitDir !== null,
    finishRunning: finish.job.running,
    converting,
    convertRunning,
    importRunning: imp.job.running,
    importWaiting: queue.length > 0,
  };
  useWorkScheduler({
    activity,
    listLoaded,
    startNextTranscribe: transcribe.startNext,
    tryStartConvert: convert.tryStart,
    convertWatch: meetings,
    startNextImport: importQ.startNext,
    waitKey: transcribe.waitList,
    importKey: queue,
  });
  // 노트로 저장하는 중·변환 전 노트를 변환하는 중도 `변환 중`으로 본다: 새 녹음·가져오기·창 닫기 확인이 같은 규칙을 쓴다
  const transcribing = isTranscribing(activity);
  // 새 녹음을 막는 일 (recordBusy.ts): 묻는 창·저장 중, 그리고 실시간 텍스트 변환을 켜 둔 채 녹음을 변환하는 중. 그 밖의 변환은 녹음과 함께 돈다.
  // 변환 전 노트의 변환 줄은 막지 않는다: 자막을 켠 녹음이면 도는 변환을 멈추고(멈춘 곳부터 이어 할 수 있다) 녹음이 끝나면 이어서 한다 (pauseConvert)
  const recordBlockKind = recordBlock({ converting: transcribe.job.running || waitDir !== null, saving: finish.job.running, asking, liveOn });
  const recordBlocked = recordBlockKind !== null;
  const pickFiles = async () => {
    if (!convertGate.ok) return notifyBlocked(convertGate);
    try {
      const picked = await open({ multiple: true, directory: false, filters: [{ name: t("오디오·동영상"), extensions: IMPORT_EXTS }] });
      if (picked) enqueue(picked);
    } catch (e) {
      notify({ text: t("파일을 고르지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
  };
  // 창에 파일 끌어다 놓기 (useFileDrop.ts)
  const { dropping, dropCount, dropNote, dropAsk, setDropAsk } = useFileDrop(enqueue);
  const attachFileRef = useRef<(t: AttachTarget, path?: string) => Promise<void>>(async () => {});

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

  // 업데이트 확인 (update.ts): 미리 만든 앱(번들)에서만, 시작 약 10초 뒤 한 번. 받지도 설치하지도 않는다: 처음 보는 버전이면 큰 창, 이미 닫은 버전이거나
  // 녹음 중·다른 창이 열려 있으면 작은 알림이고, 둘 다 설정의 업데이트 절로 간다. 실패는 조용히 무시한다 (오프라인이 흔하다). 설정 화면의 `업데이트 확인`은 따로 돈다
  const [updateAsk, setUpdateAsk] = useState<{ version: string; notes: string | null } | null>(null);
  const openUpdate = useCallback(() => void go({ kind: "settings", toUpdate: Date.now() }), [go]);
  const closeUpdate = (open: boolean) => {
    if (updateAsk) markSeen(updateAsk.version);
    setUpdateAsk(null);
    if (open) openUpdate();
  };
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        if (!(await api.updateAvailable())) return;
        const u = await check();
        if (!u) return;
        // 시작 점검(첫 실행)은 바쁜 것으로 치지 않는다: 큰 창을 남겨 두었다가 점검을 닫으면 띄운다 (점검 뒤의 알림은 모달 아래라 누를 수 없다)
        const busy = recordingRef.current || viewRef.current.kind === "record" || (!checkupOpenRef.current && !!document.querySelector("dialog[open]"));
        if (updateNotice(u.version, seenVersion(), busy) === "dialog") setUpdateAsk({ version: u.version, notes: noteExcerpt(u.body) });
        else notify({ text: newVersionToast(u.version), action: { label: OPEN_SETTINGS_LABEL, run: openUpdate } });
        // 설정의 업데이트 절이 이 결과로 시작하게 넘긴다: 가서 `업데이트 확인`을 다시 누르지 않아도 `업데이트 설치`가 보인다 (받지는 않는다). 이미 그 절에서 확인했으면 놓는다
        if (remembered.state.phase !== "idle") return void u.close().catch(() => {});
        remembered.update = u;
        remembered.state = updateReduce(remembered.state, { type: "found", version: u.version, body: u.body });
      } catch {
        // 오프라인·서버 오류: 아무것도 보이지 않는다
      }
    }, START_DELAY_MS);
    return () => clearTimeout(id);
  }, [notify, openUpdate]);

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
        setPaletteOpen((o) => !o); // 빠른 실행 (CommandPalette.tsx)
      } else if (e.code === "KeyB" && !e.metaKey && !e.ctrlKey && isRecLive(rec.phase) && !isTypingTarget(e.target)) {
        e.preventDefault();
        void sendRec("bookmark");
      }
    };
    // e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec.phase, sendRec, newMemo]);

  // 실시간 텍스트 변환을 켠 녹음을 변환 전 노트를 변환하는 중에 시작하면 변환을 멈춘다 (멈춘 곳부터 이어서 할 수 있다). 줄은 그대로라 녹음이 끝나면 이어서 한다.
  // 자막이 없으면 변환은 녹음과 함께 계속 돈다. 이번 녹음의 자막 여부도 여기서 정한다
  const pauseConvert = () => {
    setLiveRec(liveOn);
    if (liveOn) convert.preempt();
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
    () => deriveTrayState({ rec: { phase: rec.phase }, startedAtMs, elapsedSec: pausedSec, job: { running: trayJob.running, done: trayJob.done, total: trayJob.total }, waiting: waitDir !== null || asking, importing: { active: imp.job.running || queue.length > 0 || attach.phase === "converting" || converting, done: bgJob.done, total: bgJob.total }, recordOk: recordGate.ok, recordBlocked, notes: meetings }),
    [rec.phase, startedAtMs, pausedSec, trayJob.running, trayJob.done, trayJob.total, waitDir, asking, converting, bgJob.done, bgJob.total, imp.job.running, queue.length, attach.phase, recordGate.ok, recordBlocked, meetings],
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
      if (recording || transcribing || attachRef.current.phase !== "idle") return; // 노트에 녹음 추가는 전처럼 변환이 끝난 뒤에 (파일에서 추가와 같은 상태 기계)
      if (!recordGate.ok) return notifyBlocked(recordGate);
      if (!(await flushMemos())) return;
      setLiveRec(liveOnRef.current); // 이 녹음 중에 시작하는 변환(변환 대기 중인 녹음 등)이 자막 규칙을 따르게
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
    dispatchAttach({ type: "convert", target });
    startAttach(file, target);
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

  // 새 노트 메뉴와 ⌘K 빠른 실행이 같은 이유로 막는다
  const newNoteBlocked = { write: creating ? t("만드는 중…") : undefined, record: recording ? t("이미 녹음 중입니다") : asking ? ASK_BLOCKS_RECORD : recordBlockKind === "live" ? LIVE_BLOCKS_RECORD : recordBlocked ? t("변환이 끝난 뒤에 녹음할 수 있습니다") : undefined };
  // ⌘K 빠른 실행의 앱 동작: 사이드바·메뉴의 단추와 같은 함수를 부른다 (모델이 없는 등 막힌 이유는 그 함수가 알린다)
  const leftToggle = toggleLabel("left", panels.state.left);
  const paletteActions: PaletteAction[] = [
    { id: "record", label: t("녹음 시작"), icon: <Mic />, blocked: newNoteBlocked.record, run: () => onNewNote("record") },
    { id: "write", label: t("글쓰기"), keywords: t("새 메모"), icon: <SquarePen />, kbd: "⌘N", blocked: newNoteBlocked.write, run: () => onNewNote("write") },
    { id: "import", label: t("파일 가져오기"), icon: <Upload />, run: () => onNewNote("import") },
    { id: "ask", label: t("AI 어시스턴트"), icon: <Sparkles />, kbd: "⌘J", run: () => setAskOpen(true) },
    { id: "home", label: t("홈"), icon: <House />, run: () => void go({ kind: "home" }) },
    { id: "dictionary", label: t("사전"), icon: <BookA />, run: () => void go({ kind: "dictionary" }) },
    { id: "settings", label: t("설정"), icon: <Settings />, run: openSettings },
    { id: "models", label: MODELS_LABEL, icon: <Box />, run: caps.openModels },
    { id: "checkup", label: t("시작 점검"), icon: <Stethoscope />, run: caps.openCheckup },
    { id: "left", label: leftToggle.label, icon: <PanelLeft />, kbd: PANEL_TEXT.left.key, run: () => void panels.toggle("left") },
  ];
  const COMMON_EXPORTS = ["md", "docx"]; // 빈 입력에서도 보이는 내보내기 형식. 나머지는 `내보내기`로 찾는다
  // 지금 연 노트의 동작: 즐겨찾기·태그는 사이드바 줄 메뉴와, 내보내기는 노트 머리의 내보내기 메뉴와 같은 함수다 (내보내기는 MeetingView가 exportReq를 받아 한다)
  const openNote = view.kind === "meeting" ? meetings.find((m) => m.id === view.id) : undefined;
  const noteActions: PaletteAction[] = openNote
    ? [
        { id: "favorite", label: openNote.favorite ? t("즐겨찾기에서 빼기") : t("즐겨찾기에 추가"), icon: <Star />, run: () => void org.setFavorite(openNote.id, !openNote.favorite) },
        { id: "tags", label: t("태그 편집…"), icon: <Tag />, run: () => org.requestTagFocus(openNote.id) },
        ...exportFormatsFor(isMemo(openNote), isRecorded(openNote)).map((f) => ({ id: `export-${f.format}`, label: t("내보내기: {format}", { format: f.label }), keywords: f.ext, icon: <Download />, typed: !COMMON_EXPORTS.includes(f.format), run: () => setExportReq({ id: openNote.id, format: f.format, nonce: Date.now() }) })),
        { id: "obsidian", label: t("Obsidian으로 보내기"), keywords: t("내보내기"), icon: <Download />, run: () => setExportReq({ id: openNote.id, format: "obsidian", nonce: Date.now() }) },
      ]
    : [];
  // 폴더·태그로 바로 가기: 사이드바 거르기를 그 폴더(태그) 하나로 바꾸고 노트 목록을 펼친다
  const showFiltered = (apply: () => void) => {
    org.clearFilters();
    apply();
    if (panels.state.left) void panels.toggle("left");
  };
  const jumps: PaletteAction[] = [
    ...folders.map((f) => ({ id: `folder-${f.id}`, label: folderPath(folders, f.id), keywords: t("폴더"), icon: <FolderIcon />, run: () => showFiltered(() => org.selectFolder(f.id)) })),
    ...org.tags.map(({ tag }) => ({ id: `tag-${tag}`, label: `#${tag}`, keywords: t("태그"), icon: <Tag />, run: () => showFiltered(() => org.toggleTag(tag)) })),
  ];

  const waitReason = recording && liveRec ? WAIT_RECORDING : WAIT_OTHER;
  const convertControls: ConvertControls | undefined = view.kind === "meeting" ? { slot: convert.slotOf(view.id), waitReason, gate: convertGate, onConvert: convertNote } : undefined;
  // 녹음 단추는 녹음을 막는 동안에만 변환 상태를 보인다. 막지 않는 변환(자막이 꺼진 녹음 변환·가져오기)의 진행은 사이드바 카드에 있다
  const liveBlock = recordBlockKind === "live";
  const railRec = railRecState({ recording, asking, busy: finish.job.running || liveBlock });
  const recButtonView = recButton({ phase: rec.phase, t: rec.t, saving: finish.job.running, converting: liveBlock && transcribe.job.running, waiting: liveBlock && waitDir !== null, asking });
  const txPct = transcribe.job.running && transcribe.job.total ? transcribe.job.done / transcribe.job.total : null;
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
        <header data-tauri-drag-region className="-mt-1 flex items-center gap-2 px-4 pb-3">
          <img src={logo} alt="" width={20} height={20} className="pointer-events-none size-5 select-none" draggable={false} />
          <span className="pointer-events-none select-none text-[15px] font-semibold tracking-tight">Tractus</span>
          <span className="sr-only">{t("노트와 녹음")}</span>
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
              tips={{ import: t("{exts} — 창에 끌어 놓아도 됩니다", { exts: IMPORT_EXTS.join(" ") }) }}
              disabled={newNoteBlocked}
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
          <QuickFind notes={meetings} inputRef={searchRef} onOpen={openMeeting} onSearch={(q) => void go({ kind: "search", q })} />
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
          <button className={SIDE_ITEM} aria-current={view.kind === "dictionary"} title={t("사전: 텍스트로 변환할 때 더 정확하게 알아들을 단어")} onClick={() => void go({ kind: "dictionary" })}>
            <BookA aria-hidden />
            {t("사전")}
          </button>
          {bulkIds.length >= BULK_MIN && !converting && (
            <GatedButton gate={convertGate} className={SIDE_ITEM} disabled={transcribing || recording} onClick={convertAll} title={CONVERT_ALL_TITLE}>
              <AudioLines aria-hidden />
              {CONVERT_ALL(bulkIds.length)}
            </GatedButton>
          )}
        </div>

        <SidebarJobs
          importJob={imp.job}
          importing={importing}
          importPct={importPct}
          queue={queue}
          transcribeJob={transcribe.job}
          waitList={transcribe.waitList}
          waitReason={waitReason}
          txPct={txPct}
          converting={converting}
          convertRunning={convertRunning}
          convStage={convJob.stage}
          convPct={convPct}
          convProgress={convProgress}
          convTitle={convTitle}
        />

        <nav className="meeting-nav mt-2 min-h-0 flex-1 overflow-y-auto border-t border-sidebar-border px-2 pt-2 pb-6" aria-label={t("노트 목록")}>
          {listError && (
            <div className="m-2 text-xs text-destructive">
              <p>{listError.text}</p>
              <ErrorDetail detail={listError.detail} />
            </div>
          )}
          {leftover.length > 0 && <LeftoverRecordings leftover={leftover} meetings={meetings} convertGate={convertGate} transcribing={transcribing} recording={recording} startTranscribe={startTranscribe} saveLeftover={saveLeftover} askDelete={askDelete} go={go} />}
          {!listError && meetings.length === 0 && leftover.length === 0 && <p className="m-2 text-xs text-muted-foreground">{t("아직 노트가 없습니다. 새 노트로 녹음을 시작하거나 글을 쓰거나, 설정에서 데이터 위치를 확인하세요.")}</p>}
          <NoteLibrary notes={meetings} activeId={activeId} onOpen={openMeeting} convertSlots={convertSlots} onConvert={convertNote} />
        </nav>

        <SidebarFooter viewKind={view.kind} noteCount={meetings.length} go={go} />
        </div>
      </aside>

      <main className={cn("main relative h-screen overflow-hidden bg-background transition-[padding] duration-200", askOpen && view.kind === "record" && "min-[1180px]:pr-[440px]")}>
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
            exportReq={exportReq?.id === view.id ? exportReq : undefined}
          />
        )}
        {view.kind === "search" && <SearchView key={view.q} query={view.q} onOpen={openMeeting} memoIds={memoIds} />}
        {view.kind === "record" && <RecordView rec={rec} captions={live} job={progressKind === "save" ? finish.job : waitDir ? { ...IDLE_JOB, running: true, stage: "wait_convert" } : transcribe.job} progressKind={progressKind} choosing={afterAsk !== null} send={sendRec} retry={() => (progressKind === "save" ? finishDir.current && finishRecording(finishDir.current) : transcribe.current.current && startTranscribe(transcribe.current.current.dir, transcribe.current.current.target))} unconverted={unconverted ? UNCONVERTED_SAVED : null} attachTitle={attach.phase !== "idle" ? (attach.target?.title ?? null) : null} />}
        {view.kind === "settings" && <SettingsView toUpdate={view.toUpdate} onBack={goBack} onSaved={() => void Promise.all([refresh(), caps.refresh(), readLive()])} relaunchBlocked={recording || transcribing || imp.job.running || queue.length > 0} />}
        {view.kind === "models" && <ModelsView onBack={goBack} />}
        {view.kind === "dictionary" && <DictionaryView onBack={goBack} notify={notify} />}
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
      {paletteOpen && <CommandPalette notes={meetings} actions={paletteActions} noteActions={noteActions} jumps={jumps} onOpenNote={openMeeting} onSearch={(q) => void go({ kind: "search", q })} onClose={() => setPaletteOpen(false)} />}
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
      {updateAsk && !checkupOpen && !asking && <UpdateDialog version={updateAsk.version} notes={updateAsk.notes} onOpen={() => closeUpdate(true)} onLater={() => closeUpdate(false)} />}
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
