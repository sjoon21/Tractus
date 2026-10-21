// Rust 명령·이벤트 연결 (src-tauri/src/lib.rs). 이벤트 스키마는 docs/desktop.md §1·§2.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AfterRecord } from "./afterRecord";
import type { Citation, ChatMessage, LlmConfig } from "./ask";
import type { DoctorReport } from "./caps";
import type { ModelsList } from "./models";
import { clockAt, resumedStartMs, type ClockAnchor } from "./pause";
import type { Folder, MetaPatch, NoteMeta, SortKey, SortOrder } from "./organize";
import { parseShown, type Minutes } from "./minutes";
import { parseSummaryDocs, type TemplateInfo } from "./summaries";
import type { TrayWire } from "./tray";
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
  /** 사용자가 정리한 정보 (docs/desktop.md §2.12). 없으면 즐겨찾기 아님·태그 없음·폴더 없음 */
  favorite?: boolean;
  tags?: string[];
  /** 폴더 ID. 지워진 폴더를 가리키면 폴더 없음으로 본다 (organize.folderOf) */
  folder?: string | null;
  /** 마지막으로 내용을 고친 시각. 정리 정보만 바꾼 것은 올리지 않는다. 옛 노트는 만든 시각 */
  updated_at?: string;
  /** "recorded": 변환 전 노트 (녹음만 있고 아직 텍스트로 변환하지 않았다). 없으면 평범한 노트 (recorded.isRecorded) */
  state?: "recorded" | null;
  /** 변환 전 노트가 보관 중인 원본 녹음(`tracks/`)의 바이트 수. 변환 전 노트에만 있다 (recorded.keptNotice) */
  tracks_bytes?: number;
  /** 예시 노트 (온보딩, `tractus note sample`). 목록에 `예시` 표시 */
  sample?: boolean;
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
  /** 캘린더 일정으로 시작한 녹음이면 그 일정의 참석자 이름 (참석자 이름 고르기). 옛 앱·없음은 빈 목록 */
  attendees?: string[];
}

/** `tractus-rec calendar next`의 일정 하나 (docs/design/calendar.md). 시각은 ISO 8601 */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  calendar: string;
  attendees: string[];
}

export type CalendarAccess = "granted" | "denied" | "undetermined" | "restricted" | "write_only";

export interface CalendarStatus {
  enabled: boolean;
  access: CalendarAccess;
  calendars: { id: string; title: string; source: string }[];
  hidden: string[];
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
  /** 글만 있는 노트에 추가하려고 녹음한 것이면 그 노트의 ID (attach.json). 노트가 아직 있는지는 attach.resolveTarget이 본다 */
  attach_to?: string | null;
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
  /** 노트 목록 순서 (organize.readSortPrefs로 읽는다) */
  list_sort?: string;
  list_order?: string;
  /** 시작 점검(checkupRows.ts)을 한 번 보여 줬는가. 처음 실행할 때만 저절로 열린다 */
  checkup_done?: boolean;
  /** 메뉴 막대에 Tractus 아이콘을 둔다 (tray.ts, docs/desktop.md §3.1). 없으면(옛 설정) 켜짐 */
  tray_enabled?: boolean;
  /** 창을 닫아도 앱을 끝내지 않고 메뉴 막대에 남긴다. 아이콘이 떠 있을 때만 뜻이 있다. 없으면 켜짐 */
  keep_in_tray?: boolean;
  /** 녹음을 끝내면: "ask" | "convert" | "later". 없거나 모르는 값이면 매번 묻는다 (afterRecord.afterRecord) */
  after_record?: string;
  /** AI 서비스·스마트 검색 방식은 llm_* 명령으로 따로 저장한다 (여기 값은 저장 때 무시된다) */
  llm_default?: string;
  llm_profiles?: Record<string, LlmProfile>;
  embedding_provider?: string;
  /** Obsidian으로 보내기의 볼트 (비면 아직 안 고름). set_obsidian으로 바로 저장한다 */
  obsidian_vault?: string;
  /** 오디오도 볼트에 복사한다. 없으면 꺼짐 */
  obsidian_audio?: boolean;
  /** 기본 변환 엔진 (모델 ID). 비거나 없으면 자동(메모리에 맞는 기본 엔진). set_asr_engine으로 바로 저장한다 */
  asr_engine?: string;
}

/** `tractus obsidian` 결과. edited면 볼트에서 고친 파일이라 아무것도 쓰지 않았다 */
export interface ObsidianSent {
  status: "created" | "updated" | "unchanged" | "edited";
  path: string;
  audio: string | null;
}

/** 한 서비스에 저장한 주소·AI 모델 (비어 있으면 서비스 기본값) */
export interface LlmProfile {
  base_url: string;
  model: string;
}

export interface LlmSettings {
  /** 서비스를 따로 고르지 않을 때 쓰는 서비스 (등록된 것 중에서) */
  default: string;
  /** 서비스마다 저장한 주소·AI 모델. 다섯 서비스가 모두 있다 */
  profiles: Record<string, LlmProfile>;
  /** 서비스별 키 등록 여부 */
  saved: Record<string, boolean>;
  /** 지금 쓸 수 있는 서비스 (키가 있거나 이 Mac 주소의 직접 입력) */
  registered: string[];
  /** 셸·.env.local의 TRACTUS_LLM_ 설정이 이 화면의 선택보다 먼저 적용되는가 */
  env_override: boolean;
  /** 그중 서비스 자체를 환경이 정하는가 (그러면 요약·질문에서 서비스를 고를 수 없다) */
  provider_fixed: boolean;
  /** 스마트 검색 방식 */
  embedding_provider: "local" | "upstage";
  /** 로컬 전용 모드(TRACTUS_LOCAL_ONLY): Upstage로 보내지 않는다 */
  local_only: boolean;
}

/** `tractus llm models`의 결과. 실패하면 models가 비고 code·message가 있다 */
export interface LlmModelList {
  models: string[];
  code: string | null;
  message: string | null;
}

export interface LlmTestResult {
  ok: boolean;
  provider: string | null;
  model: string | null;
  host: string | null;
  latency_ms: number | null;
  /** 응답은 왔지만 내용이 비어 있었다 (연결은 된 것이다) */
  empty?: boolean;
  /** 실패했을 때 코어의 오류 코드 (lib.ts ERROR_TEXT)와 원래 문구 */
  code: string | null;
  message: string | null;
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
  /** 이번 질문에 쓸 AI 서비스 (없으면 기본 서비스) */
  provider?: string | null;
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
  /** 화면 언어 (settings.json ui_lang). 바꾼 뒤 화면을 다시 연다 (i18n.ts) */
  setUiLang: (pref: "system" | "ko" | "en") => invoke<void>("set_ui_lang", { pref }),
  /** `tractus glossary add`. 새로 더한 개수 */
  glossaryAdd: (terms: string[]) => invoke<number>("glossary_add", { terms }),
  /** `tractus templates list --json`: 기본 요약 유형 → 내 요약 유형 (docs/desktop.md §2.13) */
  templatesList: () => invoke<TemplateInfo[]>("templates_list"),
  /** `tractus templates save`: 내 요약 유형 만들기(id 없음)·고치기. 저장한 유형 */
  templatesSave: (id: string | null, name: string, description: string, prompt: string) => invoke<TemplateInfo>("templates_save", { id, name, description, prompt }),
  templatesDelete: (id: string) => invoke<void>("templates_delete", { id }),
  /** 노트의 요약 전부(기본 + summaries/). 원본 JSON + key라 summaries.parseSummaryDocs로 읽는다 */
  summariesList: async (id: string) => parseSummaryDocs(await invoke<unknown[]>("summaries_list", { id })),
  summariesDelete: (id: string, key: string) => invoke<void>("summaries_delete", { id, key }),
  /** `tractus minutes <노트> show`: 회의록 칸 + 위키용 Markdown + 짧은 판. 없으면 null (docs/design/meeting-minutes.md) */
  minutesShow: async (id: string) => parseShown(await invoke<unknown>("minutes_show", { id })),
  /** `tractus minutes <노트> save`: 고친 칸을 저장하고 새로 그린 값을 돌려준다 */
  minutesSave: async (id: string, minutes: Minutes) => parseShown(await invoke<unknown>("minutes_save", { id, minutes })),
  /** `tractus note new`: 새 메모 노트(기본 제목 `메모 HH:MM`). 만든 노트 ID */
  noteNew: (title?: string) => invoke<{ meeting_id: string }>("note_new", { title: title ?? null }),
  /** `tractus note save`: 메모 본문 전체를 저장한다 (메모 노트는 본문, 녹음 노트는 메모 탭의 글). 코어가 만든 줄 수와 고친 노트. 노트별 줄(editQueue)에 세워서 부른다 */
  noteSave: (id: string, body: string) => invoke<{ segments: number; meeting: MeetingDetail }>("note_save", { id, body }),
  /** `tractus note title`: 제목 바꾸기(녹음·메모). 폴더 이름은 그대로다. 코어가 정한 제목 */
  noteTitle: (id: string, title: string) => invoke<string>("note_title", { id, title }),
  /** 노트 정리 (docs/desktop.md §2.12): `tractus note meta`. 준 키만 바뀌고, 코어가 저장한 값을 돌려준다. 노트별 줄(editQueue)에 세워서 부른다 */
  noteMeta: (id: string, patch: MetaPatch) => invoke<NoteMeta>("note_meta", { id, patch }),
  /** $TRACTUS_HOME/folders.json (읽기만. 깨졌거나 없으면 빈 목록) */
  listFolders: () => invoke<Folder[]>("list_folders"),
  /** `tractus folders create | rename | move | delete`. 모두 바뀐 폴더 목록을 돌려준다. delete는 노트를 지우지 않고 상위로 올린다 */
  foldersCreate: (name: string, parent: string | null) => invoke<Folder[]>("folders_create", { name, parent }),
  foldersRename: (id: string, name: string) => invoke<Folder[]>("folders_rename", { id, name }),
  foldersMove: (id: string, parent: string | null) => invoke<Folder[]>("folders_move", { id, parent }),
  foldersDelete: (id: string) => invoke<Folder[]>("folders_delete", { id }),
  /** 노트 목록 순서를 설정에 저장한다 (다른 설정은 건드리지 않는다) */
  setListPrefs: (sort: SortKey, order: SortOrder) => invoke<void>("set_list_prefs", { sort, order }),
  /** `tractus export` 후 Finder에서 보여 준다. 저장한 절대 경로 */
  exportMeeting: (id: string, format: string, out: string, summary?: string) => invoke<string>("export_meeting", { id, format, out, summary: summary ?? null }),
  /** 예시 노트를 만들고(이미 있으면 그것) ID를 돌려준다 */
  noteSample: () => invoke<string>("note_sample"),
  setObsidian: (vault: string, audio: boolean) => invoke<void>("set_obsidian", { vault, audio }),
  /** 노트를 설정의 볼트로 보낸다. force: 볼트에서 고친 파일도 덮어쓴다 */
  obsidianSend: (id: string, summary: string | undefined, force: boolean) => invoke<ObsidianSent>("obsidian_send", { id, summary: summary ?? null, force }),
  obsidianOpen: (path: string) => invoke<void>("obsidian_open", { path }),
  calendarStatus: () => invoke<CalendarStatus>("calendar_status"),
  /** 권한을 묻고(처음이면 macOS 창) 허락되면 연결한다 */
  calendarConnect: () => invoke<CalendarAccess>("calendar_connect"),
  calendarSet: (enabled: boolean, hidden: string[]) => invoke<void>("calendar_set", { enabled, hidden }),
  /** 진행 중이거나 15분 안에 시작하는 일정 (연결 안 했으면 빈 목록) */
  calendarNext: () => invoke<CalendarEvent[]>("calendar_next"),
  calendarPrivacy: () => invoke<void>("calendar_privacy"),
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
  llmConfig: (provider?: string | null) => invoke<LlmConfig>("llm_config", { provider: provider ?? null }),
  /** AI 서비스 API 키: 서비스별로 등록 여부만 알 수 있다. 키는 화면으로 돌아오지 않는다 (docs/desktop.md §2.14) */
  llmKeyStatus: (provider: string) => invoke<{ saved: boolean }>("llm_key_status", { provider }),
  llmKeySave: (provider: string, key: string) => invoke<void>("llm_key_save", { provider, key }),
  llmKeyDelete: (provider: string) => invoke<void>("llm_key_delete", { provider }),
  /** 서비스마다 저장한 주소·AI 모델, 기본 서비스, 등록된 서비스, 스마트 검색 방식 */
  llmSettings: () => invoke<LlmSettings>("llm_settings"),
  /** 한 서비스의 주소·AI 모델만 저장한다 (다른 서비스·설정은 건드리지 않는다). 주소·AI 모델이 비어 있으면 서비스 기본값 */
  llmSettingsSave: (provider: string, baseUrl: string, model: string) => invoke<void>("llm_settings_save", { provider, baseUrl, model }),
  /** 요약·질문에서 서비스를 따로 고르지 않을 때 쓰는 서비스 */
  llmDefaultSave: (provider: string) => invoke<void>("llm_default_save", { provider }),
  /** 스마트 검색 방식. upstage는 Upstage 키가 있어야 한다. 바꾸면 검색 정보를 새로 만든다 (indexer.touch) */
  embeddingProviderSave: (provider: "local" | "upstage") => invoke<void>("embedding_provider_save", { provider }),
  /** 저장된 선택과 키로 `tractus llm test` (provider 없으면 기본 서비스). 실패해도 reject하지 않고 {ok: false, code, message}를 돌려준다 (실행하지 못했을 때만 reject) */
  llmTest: (provider?: string | null) => invoke<LlmTestResult>("llm_test", { provider: provider ?? null }),
  /** 서비스가 아는 AI 모델 이름 (`tractus llm models`). 실패해도 reject하지 않고 {models: [], code, message} */
  llmModels: (provider?: string | null) => invoke<LlmModelList>("llm_models", { provider: provider ?? null }),
  /** 모델·점검 (docs/desktop.md §2.15): `tractus models list --json` / `doctor --json`. doctor는 코어를 못 불러도 실행 파일 경로 확인 결과를 돌려준다 */
  modelsList: () => invoke<ModelsList>("models_list"),
  doctor: () => invoke<DoctorReport>("doctor"),
  /** 받기는 modelsJob.ts가 시작한다 (job 이벤트 kind "models"). 지우기는 받는 중이면 코어가 거절한다 */
  modelsRemove: (id: string) => invoke<void>("models_remove", { id }),
  /** `tractus models add <저장소>`: 변환 엔진 직접 추가 (받지는 않는다) */
  modelsAdd: (repo: string) => invoke<{ id: string; repo: string; engine: string; size_bytes: number }>("models_add", { repo }),
  /** 기본 변환 엔진 고르기. null이면 자동 */
  setAsrEngine: (id: string | null) => invoke<void>("set_asr_engine", { id }),
  /** 모델 폴더 옮기기 (지금 폴더 → dest). 성공한 뒤에 화면이 `models_dir` 설정을 저장한다 */
  modelsMove: (dest: string) => invoke<{ moved: string[]; freed_bytes: number }>("models_move", { dest }),
  /** 등록되지 않은 폴더 정리 */
  modelsPrune: () => invoke<{ removed: { name: string; bytes: number }[]; freed_bytes: number }>("models_prune"),
  setCheckupDone: (done: boolean) => invoke<void>("set_checkup_done", { done }),
  /** 메뉴 막대 아이콘 설정 두 개를 바로 적용하고 저장한다 (다시 시작하지 않아도 된다) */
  setTrayPrefs: (trayEnabled: boolean, keepInTray: boolean) => invoke<void>("set_tray_prefs", { trayEnabled, keepInTray }),
  /** 메뉴 막대에 보일 상태 (tray.ts createTraySender가 같은 값을 다시 보내지 않게 거른다) */
  trayUpdate: (payload: TrayWire) => invoke<void>("tray_update", { payload }),
  /** 지금 창을 닫으면 숨기기만 하는가 (메뉴 막대에 남기기) */
  trayHidesOnClose: () => invoke<boolean>("tray_hides_on_close"),
  /** 숨었거나 최소화한 창을 꺼낸다 (보이는 창은 그대로). 메뉴 막대에서 시작한 녹음이 실패했을 때 오류를 보이려고 쓴다 */
  trayShowIfHidden: () => invoke<void>("tray_show_if_hidden"),
  /** 미리 만든 앱(번들)인가: 그때만 업데이트를 확인한다 (update.ts, docs/desktop.md §3.5). 저장소에서 만든 앱·개발 실행은 false */
  updateAvailable: () => invoke<boolean>("update_available"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setRecMode: (mode: string) => invoke<void>("set_rec_mode", { mode }),
  /** `녹음을 끝내면` 설정만 바로 저장한다 (설정 화면, 끝낼 때 묻는 창의 `다음부터 묻지 않기`) */
  setAfterRecord: (value: AfterRecord) => invoke<void>("set_after_record", { value }),
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

/** 작업 하나를 실행하고 진행 이벤트를 상태로 모은다. 성공(exit 0 + done)하면 onDone(meeting_id, 경고들, 요약 key), 실패하면 onFail().
 * 요약 key는 요약 작업의 done 이벤트(summary_key)에만 있다 */
export function useJob(onDone: (meetingId: string, warnings: Warning[], summaryKey: string | null) => void, onFail?: () => void) {
  const [state, setState] = useState<JobState>(IDLE_JOB);
  const jobId = useRef<string | null>(null);
  const doneId = useRef<string | null>(null);
  const doneKey = useRef<string | null>(null);
  const warnings = useRef<Warning[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const un = listen<JobEvent>("job", ({ payload: ev }) => {
      if (ev.job !== jobId.current) return;
      // 부수 효과는 상태 갱신 함수 밖에서 (StrictMode는 갱신 함수를 두 번 부른다)
      if (ev.event === "done") {
        doneId.current = ev.meeting_id;
        doneKey.current = ev.summary_key ?? null;
      }
      if (ev.event === "warning") warnings.current = [...warnings.current, { code: ev.code, message: ev.message }];
      if (ev.event === "exit") {
        if (ev.code === 0 && doneId.current) onDoneRef.current(doneId.current, warnings.current, doneKey.current);
        else onFailRef.current?.();
      }
      setState((s) => jobReduce(s, ev));
    });
    return () => void un.then((f) => f());
  }, []);

  /** 작업 명령 하나를 시작한다 (job_start, summary_start). 작업 ID(job)는 여기서 붙인다 */
  const run = useCallback(async (command: string, args: Record<string, unknown>) => {
    setState({ ...IDLE_JOB, running: true });
    doneId.current = null;
    doneKey.current = null;
    warnings.current = [];
    // 작업 ID는 여기서 만든다: 빨리 끝나는 작업의 이벤트가 invoke 응답보다 먼저 와도 놓치지 않게
    const job = crypto.randomUUID();
    jobId.current = job;
    try {
      await invoke(command, { ...args, job });
    } catch (e) {
      setState({ ...IDLE_JOB, error: errFull(e), errorCode: APP_ERROR }); // 실행 실패 등 Rust 문장은 그대로 보인다
      onFailRef.current?.();
    }
  }, []);

  /** appendTo: 글만 있는 노트의 ID. transcribe·import만: 새 노트를 만들지 않고 그 노트에 녹음을 덧붙인다 (`--append-to`) */
  const start = useCallback(
    (kind: "transcribe" | "summarize" | "import" | "align", target: string, appendTo?: string | null) => run("job_start", { kind, target, appendTo: appendTo ?? null }),
    [run],
  );

  return { job: state, startJob: start, runJob: run };
}

// ── 녹음 (tractus-rec record) ──

/** 녹음 상태는 App이 들고 있는다 (다른 화면으로 가도 녹음은 계속된다). 정지되면 onStopped(녹음 폴더, 녹음 길이 초: 일시정지한 시간은 뺀다).
 * 실시간 자막(live)도 여기서 모은다: Rust가 녹음과 함께 띄우고, stopped를 보내기 전에 끝낸다 */
export function useRecorder(onStopped: (dir: string, seconds: number) => void) {
  const [rec, setRec] = useState<RecState>(IDLE_REC);
  const [live, setLive] = useState<LiveState>(IDLE_LIVE);
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  /** 마지막으로 알린 녹음 시각(초)과 그때의 화면 시계. level 이벤트 사이에도 시계가 흐르게 한다 */
  const anchor = useRef<ClockAnchor>({ t: 0, at: 0 });
  /** 녹음이 시작된 시각(epoch ms). 메뉴 막대가 경과 시간을 이 값으로 센다 (화면 타이머는 숨은 창에서 늦어진다).
   * 일시정지한 시간은 센 적이 없다: 계속할 때마다 `지금 - 경과`로 다시 맞춘다 */
  const startedAtMs = useRef<number | null>(null);

  useEffect(() => {
    const un = listen<RecEvent>("rec", ({ payload: ev }) => {
      if (ev.event === "started") {
        anchor.current = { t: 0, at: performance.now() };
        startedAtMs.current = Date.now();
      } else if (ev.event === "level") anchor.current = { t: ev.t, at: performance.now() };
      else if (ev.event === "paused") anchor.current = { t: ev.elapsed, at: performance.now() };
      else if (ev.event === "resumed") {
        anchor.current = { t: ev.elapsed, at: performance.now() };
        startedAtMs.current = resumedStartMs(Date.now(), ev.elapsed);
      }
      if (ev.event === "stopped") onStoppedRef.current(ev.dir, ev.duration);
      setRec((s) => recReduce(s, ev));
    });
    const unLive = listen<LiveEvent>("live", ({ payload: ev }) => setLive((s) => liveReduce(s, ev)));
    return () => {
      void un.then((f) => f());
      void unLive.then((f) => f());
    };
  }, []);

  // level 이벤트 사이에도 시계가 흐르게 한다. 일시정지 중에는 멈춘다 (녹음 시각은 일시정지한 시간을 세지 않는다)
  useEffect(() => {
    if (rec.phase !== "recording") return;
    const id = setInterval(() => setRec((s) => ({ ...s, t: Math.max(s.t, clockAt(anchor.current, performance.now())) })), 500);
    return () => clearInterval(id);
  }, [rec.phase]);

  /** target: 글만 있는 노트의 ID. 있으면 그 노트에 추가하는 녹음이다 (녹음 폴더에 attach.json). event: 캘린더 일정으로 시작하는 녹음 (녹음 폴더에 event.json) */
  const start = useCallback(async (mode: RecMode, target?: string | null, event?: CalendarEvent | null) => {
    setRec({ ...IDLE_REC, phase: "starting", mode });
    setLive(IDLE_LIVE);
    try {
      await invoke<string>("rec_start", { flags: recFlags(mode), target: target ?? null, event: event ?? null });
    } catch (e) {
      setRec({ ...IDLE_REC, mode, phase: "error", error: errText(e) });
    }
  }, []);

  const send = useCallback(async (cmd: "bookmark" | "memo" | "stop" | "pause" | "resume", text?: string) => {
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

  return { rec, live, startRec: start, sendRec: send, resetRec: reset, startedAtMs: startedAtMs.current };
}
