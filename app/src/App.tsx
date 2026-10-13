import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { attachAlignJobs } from "./alignJobs";
import { api, errDetail, errFull, errText, useJob, useRecorder, type MeetingInfo, type PendingRecording } from "./api";
import { AskPanel } from "./AskPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { editQueue } from "./editQueue";
import { ErrorDetail } from "./ErrorDetail";
import { bindIndexer } from "./indexer";
import { baseName, dayParts, errorView, isImeKey, IDLE_JOB, JOB_ERROR, fmtTime, groupByDay, IMPORT_EXTS, isImportable, isTypingTarget, recMode, REC_MODES, STAGE_FALLBACK, STAGE_LABEL, warningText, type RecMode } from "./lib";
import { MeetingView } from "./MeetingView";
import type { NewNoteAction } from "./menu";
import { NewNoteMenu } from "./NewNoteMenu";
import { dropMemo, flushMemos, isMemo, noteTime, settleMemo } from "./memo";
import { RecordView } from "./RecordView";
import { deleteDialogText, deletedText, deleteFailure, deleteReduce, IDLE_DELETE, recordingLabel, type DeleteTarget } from "./remove";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

export type Seek = { segId?: string; t?: number; nonce: number };
export type View =
  | { kind: "home" }
  | { kind: "meeting"; id: string; seek?: Seek }
  | { kind: "search"; q: string }
  | { kind: "record" }
  | { kind: "settings" };

const GLOBAL = { kind: "global" } as const;

/** 화면 아래 알림. 오류는 닫을 때까지 남고, 새 알림이 와도 밀려나지 않는다(쌓인다). detail: 원래 문구 (접힌 '자세히') */
export type Toast = { text: string; detail?: string | null; error?: boolean; action?: { label: string; run: () => void } };
export type Notify = (t: Toast) => void;
const TOAST_MS = 6000;
const TOAST_MAX = 4; // ponytail: 넘치면 가장 오래된 것부터 버린다. 여러 파일 실패를 다 보여야 하면 가져오기 패널에 실패 목록을 둔다

export function App() {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [pending, setPending] = useState<PendingRecording[]>([]);
  const [listError, setListError] = useState<{ text: string; detail: string | null } | null>(null);
  // 노트 목록을 한 번이라도 읽었는지: 읽기 전에는 '삭제된 노트'를 판단하지 않는다 (AI 질문의 인용 칩)
  const [listLoaded, setListLoaded] = useState(false);
  const [view, setView] = useState<View>({ kind: "home" });
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
      const [m, p] = await Promise.all([api.listMeetings(), api.listRecordings()]);
      setMeetings(m);
      setPending(p);
      setListError(null);
      setListLoaded(true);
    } catch (e) {
      setListError({ text: errText(e), detail: errDetail(e) });
    }
  }, []);
  // 삭제(휴지통으로 이동): 확인 대화상자 상태. 노트 화면과 사이드바의 남은 녹음이 같이 쓴다
  const [del, dispatchDel] = useReducer(deleteReduce, IDLE_DELETE);
  // 화면을 옮기기 전에 쓰던 메모를 저장한다. 저장하지 못하면 옮기지 않는다 (그 메모가 오류를 이미 보이고 있다)
  const go = useCallback(async (next: View) => {
    if (await flushMemos()) setView(next);
  }, []);
  const openMeeting = useCallback(
    (id: string, seek?: Omit<Seek, "nonce">) => void go({ kind: "meeting", id, seek: seek && { ...seek, nonce: Date.now() } }),
    [go],
  );
  // 새 메모 (⌘N): 빈 메모 노트를 만들고 열면 본문에 초점이 간다
  const [creating, setCreating] = useState(false);
  const newMemo = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { meeting_id } = await api.noteNew();
      await refresh();
      openMeeting(meeting_id);
    } catch (e) {
      notify({ text: errText(e), detail: errDetail(e), error: true });
    } finally {
      setCreating(false);
    }
  }, [creating, refresh, openMeeting, notify]);

  // 녹음 정지 → 전사 → 회의 상세
  const transcribe = useJob((meetingId) => {
    void refresh().then(() => openMeeting(meetingId));
  });
  // 마지막 전사 대상. "다시 전사"는 방금 녹음뿐 아니라 사이드바의 남은 녹음에도 쓴다.
  // 바로 시작하지 않고 waitDir에 둔다: 파일 가져오기가 돌고 있으면 끝난 뒤에 시작한다(전사 두 개가 모델을 따로 올리지 않게)
  const transcribeDir = useRef<string | null>(null);
  const [waitDir, setWaitDir] = useState<string | null>(null);
  const startTranscribe = useCallback((dir: string) => {
    transcribeDir.current = dir;
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
  const { rec, live, startRec, sendRec, resetRec } = useRecorder(startTranscribe);
  const recording = rec.phase === "recording" || rec.phase === "starting" || rec.phase === "stopping";

  // 녹음 방식: 마지막으로 고른 값을 설정에 저장해 두고 다음에도 쓴다
  const [mode, setMode] = useState<RecMode>("in_person");
  useEffect(() => {
    // 설정을 못 읽으면 기본값(대면 회의)으로 둔다. 목록 읽기 오류가 따로 보인다
    api.getSettings().then((s) => setMode(recMode(s.rec_mode)), () => setMode("in_person"));
  }, []);
  const chooseMode = (m: RecMode) => {
    setMode(m);
    api.setRecMode(m).catch((e) => setListError({ text: `녹음 방식을 저장하지 못했습니다: ${errText(e)}`, detail: errDetail(e) }));
  };

  // 파일 가져오기 (Phase 5.5): 끌어 놓거나 고른 파일을 큐에 넣고 한 번에 하나씩 전사한다
  // (vibe use-drop-target.ts, meetily layout.tsx — 둘 다 MIT — 참고). 녹음 전사와는 겹치지 않는다: 녹음 전사가 먼저다
  const [queue, setQueue] = useState<string[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const imp = useJob((meetingId, warnings) => {
    void refresh();
    const name = importing ? baseName(importing) : "파일";
    // 화면은 바꾸지 않는다: 고치던 문장·찾기가 사라진다. 열기는 사용자가 고른다
    const dup = warnings.some((w) => w.code === "duplicate");
    notify({ text: dup ? `이미 텍스트로 변환한 파일입니다 — ${name}` : `텍스트 변환을 마쳤습니다 — ${name}`, action: { label: "열기", run: () => openMeeting(meetingId) } });
  });
  useEffect(() => {
    if (!waitDir || imp.job.running) return;
    setWaitDir(null);
    void transcribe.startJob("transcribe", waitDir);
  }, [waitDir, imp.job.running, transcribe.startJob]);
  const transcribing = transcribe.job.running || waitDir !== null;
  const enqueue = useCallback(
    (paths: string[]) => {
      const bad = paths.filter((p) => !isImportable(p));
      if (bad.length) notify({ text: `가져올 수 없는 형식입니다: ${bad.map(baseName).join(", ")}`, error: true });
      setQueue((q) => [...q, ...paths.filter((p) => isImportable(p) && !q.includes(p))]);
    },
    [notify],
  );
  useEffect(() => {
    if (!queue.length || imp.job.running || transcribing) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    setImporting(next);
    void imp.startJob("import", next);
  }, [queue, imp.job.running, transcribing, imp.startJob]);
  // 실패는 알림으로 남긴다 (다음 파일이 시작되면 진행 표시는 그 파일로 바뀐다)
  useEffect(() => {
    if (!imp.job.running && imp.job.error && importing) {
      const e = errorView(imp.job.error, imp.job.errorCode, JOB_ERROR.import);
      const why = e.text === JOB_ERROR.import ? "" : `. ${e.text}`;
      notify({ text: `‘${baseName(importing)}’을(를) 텍스트로 변환하지 못했습니다${why}`, detail: e.detail, error: true });
    }
  }, [imp.job.running, imp.job.error, imp.job.errorCode, importing, notify]);
  const pickFiles = async () => {
    try {
      const picked = await open({ multiple: true, directory: false, filters: [{ name: "오디오·동영상", extensions: IMPORT_EXTS }] });
      if (picked) enqueue(picked);
    } catch (e) {
      notify({ text: `파일을 고르지 못했습니다: ${errText(e)}`, error: true });
    }
  };
  // 창에 파일을 끌어 오면 덮개를 보인다. 앱 안에서 끄는 것(화자 합치기)은 경로가 없어서 무시된다
  const [dropping, setDropping] = useState(false);
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter") setDropping(payload.paths.length > 0);
      else if (payload.type === "leave") setDropping(false);
      else if (payload.type === "drop") {
        setDropping(false);
        if (payload.paths.length) enqueue(payload.paths);
      }
    });
    return () => void un.then((f) => f());
  }, [enqueue]);

  // 창을 닫으면 앱이 끝난다: 전사 중이거나 대기 중인 파일이 있으면 묻는다.
  // ponytail: ⌘Q는 묻지 않는다(쓰던 메모만 저장하고 끝낸다: quit-requested). 남은 전사 프로세스는 stdout이 닫혀 다음 진행 이벤트에서 끝난다
  const busyRef = useRef("");
  busyRef.current = !(transcribing || imp.job.running || queue.length) ? "" : queue.length ? `진행 중인 변환과 대기 중인 파일 ${queue.length}개가 취소됩니다.` : "진행 중인 변환이 취소됩니다.";
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      // 저장하지 못한 메모가 있으면 묻는다 (⌘Q는 묻지 않고 저장만 마친다: quit-requested)
      if (!(await flushMemos()) && !(await ask("저장하지 못한 메모가 있습니다. 그래도 닫을까요?", { title: "Tractus 닫기", kind: "warning", okLabel: "저장하지 않고 닫기", cancelLabel: "계속 쓰기" }))) return e.preventDefault();
      if (busyRef.current && !(await ask(`${busyRef.current} 그래도 닫을까요?`, { title: "Tractus 닫기", kind: "warning", okLabel: "닫기", cancelLabel: "계속 변환" }))) e.preventDefault();
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
        if (ok) notify({ text: "단어 싱크를 맞췄습니다. 단어를 누르면 그 단어부터 재생합니다" });
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
        onError: (e) => notify({ text: "스마트 검색 정보를 갱신하지 못했습니다", detail: errDetail(e) ?? errFull(e), error: true }), // 코어·Rust가 한 줄만 주면 그 줄이 원인이다
      }),
    [notify],
  );

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
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.code === "KeyB" && !e.metaKey && !e.ctrlKey && rec.phase === "recording" && !isTypingTarget(e.target)) {
        e.preventDefault();
        void sendRec("bookmark");
      }
    };
    // e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec.phase, sendRec, newMemo]);

  const onRecordButton = () => {
    if (!recording && !transcribing) {
      resetRec();
      void startRec(mode);
    }
    void go({ kind: "record" });
  };

  // `새 노트` 메뉴 (⌘N은 메뉴 없이 바로 글쓰기)
  const onNewNote = (a: NewNoteAction) => {
    if (a === "write") void newMemo();
    else if (a === "record") onRecordButton();
    else void pickFiles();
  };

  const dialogText = del.target && deleteDialogText(del.target);
  const activeId = view.kind === "meeting" ? view.id : null;
  const groups = groupByDay(meetings);
  const memoIds = useMemo(() => new Set(meetings.filter(isMemo).map((m) => m.id)), [meetings]);
  const knownNotes = useMemo(() => (listLoaded ? new Set(meetings.map((m) => m.id)) : null), [listLoaded, meetings]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="brand">
          <span className="wordmark">Tractus</span>
          <span className="brand-sub">노트와 녹음</span>
        </header>

        <div className="rec-row">
          <button className={`rec-button ${recording ? "is-live" : ""}`} onClick={onRecordButton} aria-current={view.kind === "record"}>
            <span className="rec-dot" aria-hidden />
            {recording ? (
              <>
                <span>녹음 중</span>
                <time className="tnum">{fmtTime(rec.t)}</time>
              </>
            ) : transcribing ? (
              <span>{transcribe.job.running ? "변환 중…" : "변환 대기 중…"}</span>
            ) : (
              <span>녹음 시작</span>
            )}
          </button>
          <NewNoteMenu
            onPick={onNewNote}
            disabled={{ write: creating ? "만드는 중…" : undefined, record: recording ? "이미 녹음 중입니다" : transcribing ? "변환이 끝난 뒤에 녹음할 수 있습니다" : undefined }}
          />
        </div>

        <div className="mode-switch" role="radiogroup" aria-label="녹음 방식">
          {REC_MODES.map((m) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={mode === m.mode}
              title={m.note}
              disabled={recording}
              onClick={() => chooseMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <button className="import-button" onClick={pickFiles} title={`${IMPORT_EXTS.join(" ")} — 창에 끌어 놓아도 됩니다`}>
          파일 가져오기
        </button>
        {(imp.job.running || queue.length > 0) && (
          <section className="import-status" aria-live="polite" aria-label="가져오기 진행">
            <p className="import-file">{importing ? baseName(importing) : "대기 중"}</p>
            <p className="import-line tnum">
              <span>{STAGE_LABEL[imp.job.stage ?? ""] ?? STAGE_FALLBACK}</span>
              <span>{[importPct !== null && `${Math.round(importPct * 100)}%`, queue.length > 0 && `대기 ${queue.length}개`].filter(Boolean).join(" · ")}</span>
            </p>
            <div className="job-track">
              <div className={`job-fill ${importPct === null ? "is-indeterminate" : ""}`} style={{ transform: `scaleX(${importPct ?? 1})` }} />
            </div>
            {imp.job.warnings
              .filter((w) => w.code !== "duplicate")
              .map((w) => (
                <p key={w.code} className="import-warning">
                  {warningText(w)}
                </p>
              ))}
          </section>
        )}

        <form
          className="search-box"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchRef.current?.value.trim();
            if (q) void go({ kind: "search", q });
          }}
        >
          <input ref={searchRef} type="search" placeholder="노트 검색" aria-label="노트 검색" />
          <kbd aria-hidden>⌘K</kbd>
        </form>
        <button
          ref={askButton}
          className="ask-entry"
          aria-expanded={askOpen}
          aria-controls="ask-drawer"
          aria-keyshortcuts="Meta+J"
          aria-label="AI 어시스턴트에게 질문 (모든 노트 대상)"
          title="AI 어시스턴트에게 질문 (모든 노트 대상)"
          onClick={() => setAskOpen((o) => !o)}
        >
          <span>AI 어시스턴트에게 질문</span>
          <kbd aria-hidden>⌘J</kbd>
        </button>

        <nav className="meeting-nav" aria-label="노트 목록">
          {listError && (
            <div className="nav-note is-error">
              <p>{listError.text}</p>
              <ErrorDetail detail={listError.detail} />
            </div>
          )}
          {leftover.length > 0 && (
            <section className="day-group">
              <h2 className="month-label">변환 대기 중인 녹음</h2>
              <ul className="pending-list">
                {leftover.map((p) => (
                  <li key={p.dir} className="pending-item">
                    <button
                      className="meeting-link"
                      disabled={transcribing}
                      onClick={() => {
                        startTranscribe(p.dir);
                        void go({ kind: "record" });
                      }}
                    >
                      <span className="meeting-link-title tnum">{recordingLabel(p.started_at)}</span>
                      <span className="meeting-link-meta tnum">
                        {p.duration === null ? "끊긴 녹음" : fmtTime(p.duration)}
                        <span className="badge">변환하기</span>
                      </span>
                    </button>
                    <button
                      className="row-delete"
                      disabled={transcribing}
                      aria-label={`${recordingLabel(p.started_at)} 삭제`}
                      title="삭제 (휴지통으로 이동)"
                      onClick={() => askDelete({ kind: "recording", dir: p.dir, startedAt: p.started_at })}
                    >
                      삭제
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!listError && meetings.length === 0 && leftover.length === 0 && <p className="nav-note">아직 노트가 없습니다. 새 노트로 녹음을 시작하거나 글을 쓰거나, 설정에서 데이터 위치를 확인하세요.</p>}
          {groups.map((g, i) => {
            const p = dayParts(g.day);
            const newMonth = i === 0 || dayParts(groups[i - 1].day).month !== p.month;
            return (
              <section key={g.day} className="day-group">
                {newMonth && <h2 className="month-label">{p.month}</h2>}
                <div className="day-row">
                  <div className="day-num" aria-label={`${p.day}일 ${p.weekday}요일`}>
                    <span className="tnum">{p.day}</span>
                    <small>{p.weekday}</small>
                  </div>
                  <ul>
                    {g.items.map((m) => (
                      <li key={m.id}>
                        <button className="meeting-link" aria-current={m.id === activeId} onClick={() => openMeeting(m.id)}>
                          <span className="meeting-link-title">{m.title || "제목 없음"}</span>
                          <span className="meeting-link-meta tnum">
                            {noteTime(m)}
                            {isMemo(m) ? <span className="badge">메모</span> : !m.has_summary && <span className="badge">요약 없음</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}
        </nav>

        <footer className="sidebar-foot">
          <button className="text-button" onClick={() => void go({ kind: "settings" })} aria-current={view.kind === "settings"}>
            설정
          </button>
          <span className="foot-note">노트 {meetings.length}개</span>
        </footer>
      </aside>

      <main className="main">
        {view.kind === "home" && <Welcome count={meetings.length} />}
        {view.kind === "meeting" && <MeetingView key={view.id} id={view.id} seek={view.seek} onChanged={refresh} notify={notify} onDelete={askDelete} />}
        {view.kind === "search" && <SearchView key={view.q} query={view.q} onOpen={openMeeting} memoIds={memoIds} />}
        {view.kind === "record" && <RecordView rec={rec} captions={live} job={waitDir ? { ...IDLE_JOB, running: true, stage: "wait_import" } : transcribe.job} send={sendRec} retry={() => transcribeDir.current && startTranscribe(transcribeDir.current)} />}
        {view.kind === "settings" && <SettingsView onSaved={refresh} />}
      </main>

      <aside
        id="ask-drawer"
        className="ask-drawer"
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
        <header className="ask-drawer-head">
          <h2 id="ask-drawer-title" className="eyebrow">
            AI 어시스턴트에게 질문 (모든 노트 대상)
          </h2>
          <button className="toast-close" aria-label="닫기 (Esc)" onClick={closeAsk}>
            ×
          </button>
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
      {dropping && (
        <div className="drop-overlay" aria-hidden>
          <p>파일을 놓으면 텍스트로 변환합니다</p>
          <small>{IMPORT_EXTS.join(" · ")}</small>
        </div>
      )}
      <div className="toast-region" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </div>
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
    <div className={`toast ${toast.error ? "is-error" : ""}`} role={toast.error ? "alert" : "status"}>
      <div className="toast-body">
        {toast.text}
        <ErrorDetail detail={toast.detail} />
      </div>
      {toast.action && (
        <button
          className="text-button"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="알림 닫기" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

function Welcome({ count }: { count: number }) {
  return (
    <section className="welcome">
      <h1 className="sr-only">Tractus</h1>
      <p className="welcome-lead">
        {count > 0 ? `노트 ${count}개가 이 Mac에 있습니다. 왼쪽에서 하나를 고르세요.` : "녹음하거나 메모를 써서 노트를 만드세요. 녹음은 이 Mac에서 텍스트로 변환되고, 파일로 남습니다."}
      </p>
      <dl className="shortcuts">
        <div>
          <dt><kbd>⌘N</kbd></dt>
          <dd>글쓰기 (새 메모)</dd>
        </div>
        <div>
          <dt><kbd>⌘K</kbd></dt>
          <dd>검색</dd>
        </div>
        <div>
          <dt><kbd>Space</kbd></dt>
          <dd>재생 / 일시정지</dd>
        </div>
        <div>
          <dt><kbd>B</kbd></dt>
          <dd>녹음 중 북마크</dd>
        </div>
        <div>
          <dt><kbd>←</kbd> <kbd>→</kbd></dt>
          <dd>5초 이동 (Shift 10초)</dd>
        </div>
        <div>
          <dt><kbd>⌘F</kbd></dt>
          <dd>찾아 바꾸기</dd>
        </div>
        <div>
          <dt><kbd>⌘J</kbd></dt>
          <dd>AI 어시스턴트에게 질문</dd>
        </div>
      </dl>
    </section>
  );
}
