// 디자인 확인용 미리보기 (개발 서버 전용, `pnpm dev` → /preview.html). Tauri 없이 브라우저에서 앱을 띄운다.
// 모든 invoke를 가짜로 받는다: 노트는 저장소의 가상 회의(tests/fixtures/eval), 모델·점검은 `tractus doctor/models list --json` 출력.
// 빌드(index.html)에는 들어가지 않는다.
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import data from "./data/meetings.json";
import doctor from "./data/doctor.json";
import models from "./data/models.json";
import templates from "./data/templates.json";

type T = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const notes = Object.values((data as T).meetings) as { t: T; summary: T | null; dir: string }[];

// 가상 회의에 참석자 라벨을 입힌다 (화면 확인용)
notes.forEach(({ t }, n) => {
  if (t.speakers) return;
  t.speakers = { S1: { name: "김지훈" }, S2: { name: null }, S3: { name: "박소연" } };
  t.segments.forEach((s: T, i: number) => (s.speaker = ["S1", "S2", "S3"][(i + n) % (i % 4 === 0 ? 2 : 3)]));
});

// 메모 노트 하나 (글만 있는 노트 확인용)
const MEMO_BODY = "하늘상사 구매팀 인터뷰 메모\n\n- 지금은 엑셀로 발주를 관리한다\n- 월말 정산 때 이틀씩 야근한다고 함\n- 가격보다 도입 기간이 더 중요\n\n다음 주에 데모 일정 잡기";
notes.push({
  dir: "2026-10-14_하늘상사_인터뷰_메모_01N0MEMO000000000000000000",
  summary: null,
  t: {
    meeting_id: "01N0MEMO000000000000000000",
    title: "하늘상사 인터뷰 메모",
    created_at: "2026-10-14T15:00:00+09:00",
    kind: "memo",
    body: MEMO_BODY,
    segments: MEMO_BODY.split("\n").flatMap((text, i) => (text.trim() ? [{ id: `s${String(i + 1).padStart(4, "0")}`, start: 0, end: 0, line: i + 1, text, speaker: null, corrected_text: null, words: null }] : [])),
    speakers: {},
  },
});

// 새 모양(섹션) 요약과 AI 질문 기록 (오른쪽 패널 확인용)
const BRIEF = {
  key: "brief",
  template: "brief",
  template_name: "핵심 요약",
  overview: "2분기 AWS 비용 초과에 대응해 개발 클러스터를 야간에 줄이고, GPU 서버 구매는 보류하기로 했다.",
  sections: [
    { heading: "핵심", style: "bullets", items: [{ text: "AWS 비용이 예산 대비 15% 초과", segment_ids: ["s0002"], owner: null, due: null }, { text: "클라우드 GPU는 월 800만 원 한도", segment_ids: ["s0008"], owner: null, due: null }] }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
    { heading: "할 일", style: "checklist", items: [{ text: "야간 scale down 스크립트 적용", segment_ids: ["s0004"], owner: "최도윤", due: "7월 31일" }, { text: "예산안 재무팀 제출", segment_ids: ["s0012"], owner: null, due: "다음 주 화요일" }] }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
  ],
};
const CHAT = [
  { question: "GPU 서버는 어떻게 하기로 했나요?", answer: "3분기에는 H100 서버 구매를 보류하고 [s0008] 클라우드 GPU를 월 800만 원 한도로 쓰기로 했습니다 [s0007, s0008].", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0007", start: 101.2 }, { meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0008", start: 116.4 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:00:00+09:00" }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
  { question: "채용은 몇 명인가요?", answer: "backend 개발자 두 명만 3분기에 채용합니다 [s0010]. ML 엔지니어 채용은 보류했습니다.", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0010", start: 140.5 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:01:00+09:00" }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
];

let sampleId: string | null = null; // note_sample이 고른 노트 (미리보기에서는 3분기 예산 회의를 예시 노트로 쓴다)
const info = ({ t, summary, dir }: (typeof notes)[number]): T => ({
  id: t.meeting_id,
  dir,
  title: t.title,
  created_at: t.created_at,
  updated_at: t.created_at,
  duration_sec: t.audio?.duration_sec ?? 0,
  segments: t.segments.length,
  has_summary: !!summary,
  kind: t.kind === "memo" ? "memo" : "recording",
  favorite: dir.includes("예산"),
  tags: dir.includes("API") ? ["성능", "백엔드"] : [],
  folder: null,
  ...(t.meeting_id === sampleId ? { sample: true } : {}),
});
const detail = (id: string): T => {
  const n = notes.find((x) => x.t.meeting_id === id) ?? notes[0];
  return {
    info: info(n),
    segments: n.t.segments,
    speakers: n.t.speakers ?? {},
    summary: n.summary,
    memos: [],
    body: n.t.kind === "memo" ? (n.t.body ?? "") : null,
    note_memo: n.t.memo ?? null,
    audio_path: null,
    attendees: n.t.title?.includes("3분기") ? ["김지훈", "박소연", "최도윤", "정하은"] : [],
  };
};

const settings = { tractus_bin: "", rec_bin: "", home: "~/Tractus", models_dir: "", fake_recorder: false, rec_mode: "in_person", live_captions: false, checkup_done: true, tray_enabled: true, keep_in_tray: true, after_record: "ask", obsidian_vault: "/Users/me/Documents/My Vault", obsidian_audio: false };
const llm = {
  default: "upstage",
  profiles: Object.fromEntries(["upstage", "openai", "claude", "gemini", "custom"].map((p) => [p, { base_url: "", model: "" }])),
  saved: { upstage: true, claude: true },
  registered: ["upstage", "claude"],
  env_override: false,
  provider_fixed: false,
  embedding_provider: "local",
  local_only: false,
};

// 녹음 시작: 녹음 중 화면을 보이게 이벤트를 흉내 낸다
const fakeRecording = () => {
  const rec = (payload: T) => void emit("rec", payload);
  setTimeout(() => {
    rec({ event: "started", dir: "/tmp/preview-rec", tracks: ["mic"], started_at: new Date().toISOString() });
    rec({ event: "level", t: 83.4, mic: -18, system: null });
    rec({ event: "mark", t: 42, kind: "bookmark", text: null });
    rec({ event: "mark", t: 61, kind: "memo", text: "예산 숫자 다시 확인" });
  }, 50);
  return "/tmp/preview-rec";
};

// 노트 완성 (첫 노트): 메모 탭 글 + 누르면 완성된 노트를 만든다
const FIRST = notes[0].t;
FIRST.memo = { body: "AWS 비용 줄일 방법\n\nGPU 서버 살지?\n\n채용 몇 명", lines: [
  { id: "m0001", line: 1, text: "AWS 비용 줄일 방법" }, { id: "m0002", line: 3, text: "GPU 서버 살지?" }, { id: "m0003", line: 5, text: "채용 몇 명" }], seq: 3 };
const it = (text: string, ids: string[], owner: string | null = null, due: string | null = null) => ({ text, segment_ids: ids, owner, due });
const ENHANCED = {
  key: "enhanced", kind: "enhanced", template: "enhanced", template_name: "노트 완성", title: "3분기 예산 계획", overview: "",
  sections: [
    { heading: "AWS 비용 줄일 방법", part: "memo", source: "m0001", style: "bullets", items: [
      it("2분기 AWS 비용이 월 평균 4,200만 원으로 예산보다 15% 많았다", ["s0002"]),
      it("개발 EKS 클러스터를 야간에 0으로 줄이면 월 600만 원 정도 아낄 수 있다", ["s0003"]),
      it("야간 scale down은 7월 31일까지 적용하기로 했다", ["s0004", "s0005"])] },
    { heading: "GPU 서버 살지?", part: "memo", source: "m0002", style: "bullets", items: [
      it("H100 두 장 서버 견적은 대당 9,800만 원이었다", ["s0006"]),
      it("3분기에는 구매를 보류하고 클라우드 GPU를 월 800만 원 한도로 쓴다", ["s0008"])] },
    { heading: "채용 몇 명", part: "memo", source: "m0003", style: "bullets", items: [
      it("하반기에는 backend 개발자 2명만 뽑고 ML 엔지니어는 보류한다", ["s0009", "s0010"])] },
    { heading: "북마크 1:56", part: "memo", source: "r0001", at: 116, style: "bullets", items: [it("GPU 구매 보류에 모두 동의했다", ["s0008"])] },
    { heading: "3분기 총예산", part: "extra", source: null, style: "bullets", items: [it("인프라 5억 1천, 채용 1억 2천", ["s0012"])] },
    { heading: "할 일", part: "todos", source: null, style: "checklist", items: [
      it("개발 클러스터 야간 scale down 적용", ["s0004"], "최도윤", "7월 31일"), it("backend 채용 공고 게시", ["s0011"], "정하은", "이번 주 금요일")] },
  ],
};
const made = new Set<string>();
const fakeSummary = (a: T) => {
  const job = (payload: T) => void emit("job", { job: a.job, kind: "summarize", ...payload });
  setTimeout(() => job({ event: "stage", stage: "summarize" }), 50);
  setTimeout(() => {
    if (a.template === "enhanced") made.add(a.id);
    job({ event: "done", meeting_id: a.id, meeting_dir: "/tmp", summary_key: a.template ?? "meeting" });
    job({ event: "exit", code: 0 });
  }, 1500);
  return null;
};

const handlers: Record<string, (a: T) => unknown> = {
  rec_start: fakeRecording,
  summary_start: fakeSummary,
  list_meetings: () => notes.map(info),
  note_sample: () => (sampleId = notes.find((n) => n.t.title.includes("3분기"))?.t.meeting_id ?? notes[0].t.meeting_id),
  list_recordings: () => [],
  list_folders: () => [{ id: "f1", name: "고객사", parent: null, order: 0, created_at: "2026-10-01T09:00:00+09:00" }],
  load_meeting: (a) => detail(a.id),
  summaries_list: (a) => {
    const n = notes.find((x) => x.t.meeting_id === a.id);
    const extra = made.has(a.id) && n === notes[0] ? [ENHANCED] : [];
    return n?.summary ? [{ ...n.summary, key: "meeting" }, ...(n === notes[0] ? [BRIEF] : []), ...extra] : extra;
  },
  load_chat: (a) => (a.id === notes[0].t.meeting_id ? CHAT : []),
  get_settings: () => settings,
  calendar_next: () => {
    const start = new Date(Date.now() + 6 * 60_000);
    return [{ id: "e1", title: "주간 인프라 점검", start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), calendar: "회사", attendees: ["김지훈", "박소연", "최도윤", "정하은"] }];
  },
  calendar_status: () => ({ enabled: true, access: "granted", hidden: ["c3"], calendars: [{ id: "c1", title: "회사", source: "Google" }, { id: "c2", title: "팀 일정", source: "Google" }, { id: "c3", title: "대한민국 공휴일", source: "구독" }] }),
  set_obsidian: ({ vault, audio }: T) => void Object.assign(settings, { obsidian_vault: vault, obsidian_audio: audio }),
  obsidian_send: ({ id }: T) => ({ status: "created", path: `/Users/me/Documents/My Vault/Tractus/${id}.md`, audio: null }),
  doctor: () => ({ doctor, core_error: null, tractus_bin: "tractus", tractus_bin_exists: true, rec_bin: "tractus-rec", rec_bin_exists: true, tractus_source: "repo", rec_source: "repo", home: "~/Tractus", home_risk: null }),
  models_list: () => models,
  templates_list: () => (templates as T).templates,
  llm_settings: () => llm,
  llm_config: () => ({ provider: "upstage", model: "solar-pro2", host: "api.upstage.ai", remote: true, key_present: true }),
  llm_key_status: (a) => ({ saved: a.provider === "upstage" || a.provider === "claude" }),
  voices_list: () => ({ people: [], needs_reenroll: false, model_present: true }),
  update_available: () => false,
  tray_hides_on_close: () => true,
  mcp_call: (a) => ({
    content: [{ type: "text", text: JSON.stringify(a.name === "status" ? { home: "~/Tractus", meetings: notes.length, indexed_chunks: 120, vectors: 120, vector_search: true, hint: null } : { query: a.arguments.query, vector_used: true, hits: [] }) }],
  }),
};

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const h = handlers[cmd];
    if (h) return h((args ?? {}) as T);
    if (!cmd.startsWith("plugin:")) console.debug("[preview] 처리하지 않은 명령", cmd, args);
    return null;
  },
  { shouldMockEvents: true },
);

await import("../main");
