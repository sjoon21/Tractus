// Rust 명령·이벤트 연결 (src-tauri/src/lib.rs). 이벤트 스키마는 docs/desktop.md §1·§2.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { IDLE_JOB, IDLE_REC, jobReduce, parseToolResult, recFlags, recReduce, type RecMode, type JobEvent, type JobState, type Memo, type RecEvent, type RecState, type Segment } from "./lib";

export type { JobState, RecState } from "./lib";

export interface MeetingInfo {
  id: string;
  dir: string;
  title: string;
  created_at: string;
  duration_sec: number;
  segments: number;
  has_summary: boolean;
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
  summary: Summary | null;
  memos: Memo[];
  audio_path: string | null;
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
}

export interface SearchHit {
  meeting_id: string;
  title: string;
  date: string;
  segments: { id: string; time: string; text: string; cite: string }[];
  matched: string[];
}

export interface SearchResponse {
  query: string;
  vector_used: boolean;
  hits: SearchHit[];
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
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setRecMode: (mode: string) => invoke<void>("set_rec_mode", { mode }),
  search: async (query: string) =>
    parseToolResult<SearchResponse>(await invoke("mcp_call", { name: "search_meetings", arguments: { query, limit: 20 } })),
  status: async () => parseToolResult<McpStatus>(await invoke("mcp_call", { name: "status", arguments: {} })),
};

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── 작업 (transcribe / summarize) ──

/** 작업 하나를 실행하고 진행 이벤트를 상태로 모은다. 성공(exit 0 + done)하면 onDone(meeting_id). */
export function useJob(onDone: (meetingId: string) => void) {
  const [state, setState] = useState<JobState>(IDLE_JOB);
  const jobId = useRef<string | null>(null);
  const doneId = useRef<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const un = listen<JobEvent>("job", ({ payload: ev }) => {
      if (ev.job !== jobId.current) return;
      // 부수 효과는 상태 갱신 함수 밖에서 (StrictMode는 갱신 함수를 두 번 부른다)
      if (ev.event === "done") doneId.current = ev.meeting_id;
      if (ev.event === "exit" && ev.code === 0 && doneId.current) onDoneRef.current(doneId.current);
      setState((s) => jobReduce(s, ev));
    });
    return () => void un.then((f) => f());
  }, []);

  const start = useCallback(async (kind: "transcribe" | "summarize", target: string) => {
    setState({ ...IDLE_JOB, running: true });
    doneId.current = null;
    // 작업 ID는 여기서 만든다: 빨리 끝나는 작업의 이벤트가 invoke 응답보다 먼저 와도 놓치지 않게
    const job = crypto.randomUUID();
    jobId.current = job;
    try {
      await invoke("job_start", { kind, target, job });
    } catch (e) {
      setState({ ...IDLE_JOB, error: errText(e) });
    }
  }, []);

  return { job: state, startJob: start };
}

// ── 녹음 (tractus-rec record) ──

/** 녹음 상태는 App이 들고 있는다 (다른 화면으로 가도 녹음은 계속된다). 정지되면 onStopped(녹음 폴더). */
export function useRecorder(onStopped: (dir: string) => void) {
  const [rec, setRec] = useState<RecState>(IDLE_REC);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const startedAt = useRef(0);

  useEffect(() => {
    const un = listen<RecEvent>("rec", ({ payload: ev }) => {
      if (ev.event === "started") startedAt.current = performance.now();
      if (ev.event === "stopped") onStoppedRef.current(ev.dir);
      setRec((s) => recReduce(s, ev));
    });
    return () => void un.then((f) => f());
  }, []);

  // level 이벤트 사이에도 시계가 흐르게 한다
  useEffect(() => {
    if (rec.phase !== "recording") return;
    const id = setInterval(() => setRec((s) => ({ ...s, t: Math.max(s.t, (performance.now() - startedAt.current) / 1000) })), 500);
    return () => clearInterval(id);
  }, [rec.phase]);

  const start = useCallback(async (mode: RecMode) => {
    setRec({ ...IDLE_REC, phase: "starting", mode });
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

  const reset = useCallback(() => setRec(IDLE_REC), []);

  return { rec, startRec: start, sendRec: send, resetRec: reset };
}
