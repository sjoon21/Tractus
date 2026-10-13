// Rust 명령·이벤트 연결 (src-tauri/src/lib.rs). 이벤트 스키마는 docs/desktop.md §1·§2.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Citation, ChatMessage, LlmConfig } from "./ask";
import { APP_ERROR, DetailedError, IDLE_JOB, splitMessage, IDLE_LIVE, IDLE_REC, jobReduce, liveReduce, parseToolResult, recFlags, recReduce, type RecMode, type JobEvent, type JobState, type LiveEvent, type LiveState, type Memo, type NoteMemo, type RecEvent, type RecState, type Segment, type Speakers, type TextEdit } from "./lib";

export type { JobState, LiveState, RecState } from "./lib";

export interface MeetingInfo {
  id: string;
  dir: string;
  title: string;
  created_at: string;
  duration_sec: number;
  segments: number;
  has_summary: boolean;
  /** "memo": 녹음 없이 직접 쓴 노트 (길이 0). 없거나 다른 값이면 녹음 (memo.kindOf) */
  kind?: "recording" | "memo";
}

export interface Summary {
  summary: string;
  topics: { title: string; segment_ids: string[] }[];
  decisions: { text: string; segment_ids: string[] }[];
  action_items: { task: string; owner: string | null; due: string | null; segment_ids: string[] }[];
  provider: string | null;
  model: string | null;
}

export interface MeetingDetail {
  info: MeetingInfo;
  segments: Segment[];
  /** 라벨 → 이름. 화자 없는 회의(schema_version 1, 화자 분리 끔)는 {} */
  speakers: Speakers;
  summary: Summary | null;
  memos: Memo[];
  /** 메모 노트의 본문. 녹음은 null */
  body: string | null;
  /** 녹음 노트에 사용자가 적은 메모(오른쪽 패널의 메모 탭). 없으면(메모 노트·아직 안 씀·읽을 수 없음) null. `memos`(녹음 중 메모·북마크)와 다르다 */
  note_memo: NoteMemo | null;
  audio_path: string | null;
}

/** `tractus speakers <회의> rename | set | merge | dismiss` (docs/desktop.md §2.1·§2.7). set의 label은 "new"면 새 화자.
 * dismiss는 목소리 제안 거절, 제안 확정은 그 이름으로 rename */
export type SpeakerEdit =
  | { op: "rename"; label: string; name: string }
  | { op: "set"; segment: string; label: string }
  | { op: "merge"; from: string; into: string }
  | { op: "dismiss"; label: string };

/** `tractus voices list --json` (Rust voices::VoiceList). 벡터는 오지 않는다 */
export interface VoicePerson {
  id: string;
  name: string;
  samples: number;
  created_at: string;
}

export interface VoiceList {
  people: VoicePerson[];
  /** 임베딩 모델이 바뀌어 지금 프로필로는 맞춰 보지 않는다 → 다시 등록 */
  needs_reenroll: boolean;
  /** 목소리 인식 모델 파일을 쓸 수 있는지. 없으면 등록할 수 없다. 코어가 알리지 않으면 true로 본다 (voiceModelReady) */
  model_present: boolean;
}

export interface PendingRecording {
  dir: string;
  started_at: string;
  duration: number | null;
}

export interface Settings {
  tractus_bin: string;
  rec_bin: string;
  home: string;
  models_dir: string;
  fake_recorder: boolean;
  /** 마지막으로 고른 녹음 방식 ("in_person" | "hybrid"). lib.ts recMode로 읽는다 */
  rec_mode: string;
  /** 녹음 중 실시간 자막 (Phase 7.2). 기본 꺼짐. Rust가 녹음을 시작할 때 읽어 `tractus live`를 띄운다 */
  live_captions: boolean;
}

export interface SearchHit {
  meeting_id: string;
  title: string;
  date: string;
  /** 녹음 노트의 메모 줄은 id가 `m0003`이고 source가 "memo" (코어). 메모 노트의 줄은 line이 붙는다 */
  segments: { id: string; time: string; text: string; cite: string; source?: string; line?: number }[];
  matched: string[];
}

export interface SearchResponse {
  query: string;
  vector_used: boolean;
  hits: SearchHit[];
}

/** chat.json 항목 (`tractus ask --save`, Rust meetings::ChatEntry) */
export interface ChatEntry {
  question: string;
  answer: string;
  citations: Citation[];
  provider: string | null;
  model: string | null;
  created_at: string;
}

/** 회의 질의 시작 인수. meeting이 있으면 그 회의만 보고 chat.json에 남긴다. job은 프론트엔드가 만든 ID(이벤트 "ask"의 job) */
export interface AskArgs {
  job: string;
  meeting: string | null;
  from: string | null;
  to: string | null;
  question: string;
  history: ChatMessage[];
}

export interface McpStatus {
  home: string;
  meetings: number;
  indexed_chunks: number;
  vectors: number;
  vector_search: boolean;
  hint: string | null;
}

export const api = {
  listMeetings: () => invoke<MeetingInfo[]>("list_meetings"),
  listRecordings: () => invoke<PendingRecording[]>("list_recordings"),
  loadMeeting: (id: string) => invoke<MeetingDetail>("load_meeting", { id }),
  /** 코어가 transcript.json·md·vtt·검색 색인을 고친 뒤 다시 읽은 회의 */
  editSpeakers: (id: string, edit: SpeakerEdit) => invoke<MeetingDetail>("edit_speakers", { id, edit }),
  /** `tractus segments <회의> edit` 묶음 한 번. 원문과 같은 문장은 해제된다. 코어가 바꾼 세그먼트 수와 고친 회의 */
  editSegments: (id: string, edits: TextEdit[]) => invoke<{ changed: number; meeting: MeetingDetail }>("edit_segments", { id, edits }),
  /** 목소리 프로필 (Phase 7.1, docs/desktop.md §2.7) */
  voicesList: () => invoke<VoiceList>("voices_list"),
  /** 이름 바꾸기 + 목소리 기억하기. 동의 확인(폼의 두 번째 체크)을 받은 뒤에만 부른다. 그 사람의 표본 수와 고친 회의 */
  voicesEnroll: (meeting: string, label: string, name: string) =>
    invoke<{ samples: number; meeting: MeetingDetail }>("voices_enroll", { meeting, label, name, consent: true }),
  /** 지운 사람 수 */
  voicesForget: (id: string) => invoke<number>("voices_forget", { id }),
  /** `tractus index`: 고친 문장을 검색에 반영한다. 다른 작업이 돌고 있어 비켜 갔으면 false */
  indexRefresh: () => invoke<boolean>("index_refresh"),
  /** `tractus glossary add`. 새로 더한 개수 */
  glossaryAdd: (terms: string[]) => invoke<number>("glossary_add", { terms }),
  /** `tractus note new`: 새 메모 노트(기본 제목 `메모 HH:MM`). 만든 노트 ID */
  noteNew: (title?: string) => invoke<{ meeting_id: string }>("note_new", { title: title ?? null }),
  /** `tractus note save`: 메모 본문 전체를 저장한다 (메모 노트는 본문, 녹음 노트는 메모 탭의 글). 코어가 만든 줄 수와 고친 노트. 노트별 줄(editQueue)에 세워서 부른다 */
  noteSave: (id: string, body: string) => invoke<{ segments: number; meeting: MeetingDetail }>("note_save", { id, body }),
  /** `tractus note title`: 제목 바꾸기(녹음·메모). 폴더 이름은 그대로다. 코어가 정한 제목 */
  noteTitle: (id: string, title: string) => invoke<string>("note_title", { id, title }),
  /** `tractus export` 후 Finder에서 보여 준다. 저장한 절대 경로 */
  exportMeeting: (id: string, format: string, out: string) => invoke<string>("export_meeting", { id, format, out }),
  /** 노트 폴더를 휴지통으로 옮긴다 (되돌릴 수 있다). 처리 중이거나 변환이 끝나지 않은 노트는 거절한다. 검색 색인은 백그라운드로 정리 */
  deleteMeeting: (id: string) => invoke<void>("delete_meeting", { id }),
  /** 변환하지 않은 녹음 폴더를 휴지통으로 옮긴다 */
  deleteRecording: (dir: string) => invoke<void>("delete_recording", { dir }),
  /** ⌘Q로 미룬 종료를 이어 간다 (쓰던 메모를 저장한 뒤) */
  quitReady: () => invoke<void>("quit_ready"),
  /** `tractus ask --progress-json` (Phase 6.3). 이벤트는 "ask" */
  askStart: (args: AskArgs) => invoke<void>("ask_start", { ...args }),
  /** 질문 멈추기 (프로세스 kill) */
  askCancel: (job: string) => invoke<void>("ask_cancel", { job }),
  loadChat: (id: string) => invoke<ChatEntry[]>("load_chat", { id }),
  /** 보내기 전 안내용 공급자·모델 (셸 > .env.local > .env, 코어와 같은 순서) */
  llmConfig: () => invoke<LlmConfig>("llm_config"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setRecMode: (mode: string) => invoke<void>("set_rec_mode", { mode }),
  search: async (query: string) =>
    parseToolResult<SearchResponse>(await invoke("mcp_call", { name: "search_meetings", arguments: { query, limit: 20 } })),
  status: async () => parseToolResult<McpStatus>(await invoke("mcp_call", { name: "status", arguments: {} })),
};

const errRaw = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 화면 문장: Rust 오류 문자열은 첫 줄이 문장이고 둘째 줄부터가 원래 문구다 (lib.splitMessage) */
export const errText = (e: unknown) => splitMessage(errRaw(e)).text;
/** 원래 문구 ('자세히'): DetailedError의 detail, 없으면 오류 문자열의 둘째 줄부터. 없으면 null */
export const errDetail = (e: unknown): string | null => (e instanceof DetailedError ? e.detail : splitMessage(errRaw(e)).detail);
/** 줄바꿈을 포함한 오류 전체 (문장 + 자세히를 함께 다시 해석할 때) */
export const errFull = errRaw;

// ── 작업 (transcribe / summarize / import / align) ──

type Warning = JobState["warnings"][number];

/** 작업 하나를 실행하고 진행 이벤트를 상태로 모은다. 성공(exit 0 + done)하면 onDone(meeting_id, 경고들). */
export function useJob(onDone: (meetingId: string, warnings: Warning[]) => void) {
  const [state, setState] = useState<JobState>(IDLE_JOB);
  const jobId = useRef<string | null>(null);
  const doneId = useRef<string | null>(null);
  const warnings = useRef<Warning[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const un = listen<JobEvent>("job", ({ payload: ev }) => {
      if (ev.job !== jobId.current) return;
      // 부수 효과는 상태 갱신 함수 밖에서 (StrictMode는 갱신 함수를 두 번 부른다)
      if (ev.event === "done") doneId.current = ev.meeting_id;
      if (ev.event === "warning") warnings.current = [...warnings.current, { code: ev.code, message: ev.message }];
      if (ev.event === "exit" && ev.code === 0 && doneId.current) onDoneRef.current(doneId.current, warnings.current);
      setState((s) => jobReduce(s, ev));
    });
    return () => void un.then((f) => f());
  }, []);

  const start = useCallback(async (kind: "transcribe" | "summarize" | "import" | "align", target: string) => {
    setState({ ...IDLE_JOB, running: true });
    doneId.current = null;
    warnings.current = [];
    // 작업 ID는 여기서 만든다: 빨리 끝나는 작업의 이벤트가 invoke 응답보다 먼저 와도 놓치지 않게
    const job = crypto.randomUUID();
    jobId.current = job;
    try {
      await invoke("job_start", { kind, target, job });
    } catch (e) {
      setState({ ...IDLE_JOB, error: errFull(e), errorCode: APP_ERROR }); // 실행 실패 등 Rust 문장은 그대로 보인다
    }
  }, []);

  return { job: state, startJob: start };
}

// ── 녹음 (tractus-rec record) ──

/** 녹음 상태는 App이 들고 있는다 (다른 화면으로 가도 녹음은 계속된다). 정지되면 onStopped(녹음 폴더).
 * 실시간 자막(live)도 여기서 모은다: Rust가 녹음과 함께 띄우고, stopped를 보내기 전에 끝낸다 */
export function useRecorder(onStopped: (dir: string) => void) {
  const [rec, setRec] = useState<RecState>(IDLE_REC);
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const startedAt = useRef(0);

  useEffect(() => {
    const un = listen<RecEvent>("rec", ({ payload: ev }) => {
      if (ev.event === "started") startedAt.current = performance.now();
      if (ev.event === "stopped") onStoppedRef.current(ev.dir);
      setRec((s) => recReduce(s, ev));
    });
    const unLive = listen<LiveEvent>("live", ({ payload: ev }) => setLive((s) => liveReduce(s, ev)));
    return () => {
      void un.then((f) => f());
      void unLive.then((f) => f());
    };
  }, []);

  // level 이벤트 사이에도 시계가 흐르게 한다
  useEffect(() => {
    if (rec.phase !== "recording") return;
    const id = setInterval(() => setRec((s) => ({ ...s, t: Math.max(s.t, (performance.now() - startedAt.current) / 1000) })), 500);
    return () => clearInterval(id);
  }, [rec.phase]);

  const start = useCallback(async (mode: RecMode) => {
    setRec({ ...IDLE_REC, phase: "starting", mode });
    setLive(IDLE_LIVE);
    try {
      await invoke<string>("rec_start", { flags: recFlags(mode) });
    } catch (e) {
      setRec({ ...IDLE_REC, mode, phase: "error", error: errText(e) });
    }
  }, []);

  const send = useCallback(async (cmd: "bookmark" | "memo" | "stop", text?: string) => {
    if (cmd === "stop") setRec((s) => ({ ...s, phase: "stopping" }));
    try {
      await invoke("rec_send", { cmd, text: text ?? null });
    } catch (e) {
      setRec((s) => ({ ...s, error: errText(e) }));
    }
  }, []);

  const reset = useCallback(() => {
    setRec(IDLE_REC);
    setLive(IDLE_LIVE);
  }, []);

  return { rec, live, startRec: start, sendRec: send, resetRec: reset };
}
