// 디자인 확인용 미리보기 (개발 서버 전용, `pnpm dev` → /preview.html). Tauri 없이 브라우저에서 앱을 띄운다.
// 모든 invoke를 가짜로 받는다: 노트는 저장소의 가상 회의(tests/fixtures/eval), 모델·점검은 `tractus doctor/models list --json` 출력.
// 빌드(index.html)에는 들어가지 않는다. `?lang=en`이면 화면도 가짜 데이터도 영어다(README 영어 스크린샷·데모).
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import dataKo from "./data/meetings.json";
import doctorKo from "./data/doctor.json";
import modelsKo from "./data/models.json";
import templatesKo from "./data/templates.json";
import dataEn from "./data/meetings-en.json";
import doctorEn from "./data/doctor-en.json";
import modelsEn from "./data/models-en.json";
import templatesEn from "./data/templates-en.json";

const EN = new URLSearchParams(location.search).get("lang") === "en";
const [data, doctor, models, templates] = EN ? [dataEn, doctorEn, modelsEn, templatesEn] : [dataKo, doctorKo, modelsKo, templatesKo];
const Q3 = EN ? "Q3" : "3분기"; // 예시 노트(3분기 예산 회의)를 찾는 제목 조각
const PEOPLE = EN ? ["Daniel Kim", "Sophie Park", "Ryan Choi", "Hannah Jung"] : ["김지훈", "박소연", "최도윤", "정하은"];

type T = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const notes = Object.values((data as T).meetings) as { t: T; summary: T | null; dir: string }[];

// 가상 회의에 참석자 라벨을 입힌다 (화면 확인용)
notes.forEach(({ t }, n) => {
  if (t.speakers) return;
  t.speakers = { S1: { name: PEOPLE[0] }, S2: { name: null }, S3: { name: PEOPLE[1] } };
  t.segments.forEach((s: T, i: number) => (s.speaker = ["S1", "S2", "S3"][(i + n) % (i % 4 === 0 ? 2 : 3)]));
});

// 메모 노트 하나 (글만 있는 노트 확인용)
const MEMO_BODY = EN
  ? "Skyline Trading interview notes\n\n- Orders are tracked in Excel today\n- Two late nights at every month-end close\n- Rollout time matters more than price\n\nSet up a demo next week"
  : "하늘상사 구매팀 인터뷰 메모\n\n- 지금은 엑셀로 발주를 관리한다\n- 월말 정산 때 이틀씩 야근한다고 함\n- 가격보다 도입 기간이 더 중요\n\n다음 주에 데모 일정 잡기";
notes.push({
  dir: EN ? "2026-10-14_Skyline_Trading_interview_notes_01N0MEMO000000000000000000" : "2026-10-14_하늘상사_인터뷰_메모_01N0MEMO000000000000000000",
  summary: null,
  t: {
    meeting_id: "01N0MEMO000000000000000000",
    title: EN ? "Skyline Trading interview notes" : "하늘상사 인터뷰 메모",
    created_at: "2026-10-14T15:00:00+09:00",
    kind: "memo",
    body: MEMO_BODY,
    segments: MEMO_BODY.split("\n").flatMap((text, i) => (text.trim() ? [{ id: `s${String(i + 1).padStart(4, "0")}`, start: 0, end: 0, line: i + 1, text, speaker: null, corrected_text: null, words: null }] : [])),
    speakers: {},
  },
});

// 새 모양(섹션) 요약과 AI 질문 기록 (오른쪽 패널 확인용)
const BRIEF_KO = {
  key: "brief",
  template: "brief",
  template_name: "핵심 요약",
  overview: "2분기 AWS 비용 초과에 대응해 개발 클러스터를 야간에 줄이고, GPU 서버 구매는 보류하기로 했다.",
  sections: [
    { heading: "핵심", style: "bullets", items: [{ text: "AWS 비용이 예산 대비 15% 초과", segment_ids: ["s0002"], owner: null, due: null }, { text: "클라우드 GPU는 월 800만 원 한도", segment_ids: ["s0008"], owner: null, due: null }] }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
    { heading: "할 일", style: "checklist", items: [{ text: "야간 scale down 스크립트 적용", segment_ids: ["s0004"], owner: "최도윤", due: "7월 31일" }, { text: "예산안 재무팀 제출", segment_ids: ["s0012"], owner: null, due: "다음 주 화요일" }] }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
  ],
};
const CHAT_KO = [
  { question: "GPU 서버는 어떻게 하기로 했나요?", answer: "3분기에는 H100 서버 구매를 보류하고 [s0008] 클라우드 GPU를 월 800만 원 한도로 쓰기로 했습니다 [s0007, s0008].", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0007", start: 101.2 }, { meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0008", start: 116.4 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:00:00+09:00" }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
  { question: "채용은 몇 명인가요?", answer: "backend 개발자 두 명만 3분기에 채용합니다 [s0010]. ML 엔지니어 채용은 보류했습니다.", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0010", start: 140.5 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:01:00+09:00" }, // words-ok: 미리보기 가짜 데이터 (화면에 ID를 그리지 않는다)
];
const BRIEF_EN = {
  key: "brief",
  template: "brief",
  template_name: "Brief",
  overview: "To deal with the Q2 AWS overrun, the dev cluster will scale down at night and the GPU server purchase is on hold.",
  sections: [
    { heading: "Key points", style: "bullets", items: [{ text: "AWS costs ran 15% over budget", segment_ids: ["s0002"], owner: null, due: null }, { text: "Cloud GPUs are capped at $8K a month", segment_ids: ["s0008"], owner: null, due: null }] },
    { heading: "To-dos", style: "checklist", items: [{ text: "Apply the nightly scale-down script", segment_ids: ["s0004"], owner: "Ryan Choi", due: "July 31" }, { text: "Send the budget to finance", segment_ids: ["s0012"], owner: null, due: "Next Tuesday" }] },
  ],
};
const CHAT_EN = [
  { question: "What did we decide about the GPU server?", answer: "We're holding off on buying the H100 server in Q3 [s0008] and using cloud GPUs capped at $8K a month [s0007, s0008].", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0007", start: 101.2 }, { meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0008", start: 116.4 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:00:00+09:00" },
  { question: "How many people are we hiring?", answer: "Only two backend developers in Q3 [s0010]. The ML engineer hire is on hold.", citations: [{ meeting_id: "01KWZKT9M0T5YFCND21XGZFT8G", segment_id: "s0010", start: 140.5 }], provider: "upstage", model: "solar-pro2", created_at: "2026-10-15T10:01:00+09:00" },
];
const [BRIEF, CHAT] = EN ? [BRIEF_EN, CHAT_EN] : [BRIEF_KO, CHAT_KO];

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
  favorite: dir.includes(EN ? "budget" : "예산"),
  tags: dir.includes("API") ? (EN ? ["performance", "backend"] : ["성능", "백엔드"]) : [],
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
    memos: marksOf(n.t.meeting_id),
    body: n.t.kind === "memo" ? (n.t.body ?? "") : null,
    note_memo: n.t.memo ?? null,
    audio_path: null,
    attendees: n.t.title?.includes(Q3) ? PEOPLE : [],
    polish: polishPending.get(n.t.meeting_id) ?? [],
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
// 녹음 중 메모·북마크: rec_send의 mark_edit·mark_delete가 고친 목록을 marks 이벤트로 돌려준다 (녹음 프로그램과 같다)
let recMarks: T[] = [];
const fakeRecording = () => {
  const rec = (payload: T) => void emit("rec", payload);
  recMarks = [
    { t: 42, kind: "bookmark", text: null },
    { t: 61, kind: "memo", text: EN ? "double-check budget numbers" : "예산 숫자 다시 확인" },
    { t: 75, kind: "memo", text: EN ? "ask Minsu after the meeting whether the Q3 cloud GPU cap of $8K a month includes the dev cluster, and send the slow-query analysis link to the channel" : "회의 끝나고 민수님께 3분기 클라우드 GPU 월 800만 원 한도에 개발 클러스터도 들어가는지 물어보고 slow query 분석 링크를 채널에 공유하기" },
  ];
  setTimeout(() => {
    rec({ event: "started", dir: "/tmp/preview-rec", tracks: ["mic"], started_at: new Date().toISOString() });
    rec({ event: "level", t: 83.4, mic: -18, system: null });
    recMarks.forEach((m) => rec({ event: "mark", ...m }));
  }, 50);
  return "/tmp/preview-rec";
};
const fakeRecSend = ({ cmd, text, index }: T) => {
  if (cmd === "mark_edit" && recMarks[index]?.kind === "memo") recMarks = recMarks.map((m, i) => (i === index ? { ...m, text } : m));
  else if (cmd === "mark_delete") recMarks = recMarks.filter((_, i) => i !== index);
  else return null;
  setTimeout(() => void emit("rec", { event: "marks", marks: recMarks }), 30);
  return null;
};
// 노트의 녹음 중 메모 (첫 노트): marks_save가 바꾼다
let noteMarks: Record<string, T[]> = {};
const marksOf = (id: string): T[] =>
  noteMarks[id] ?? (id === notes[0].t.meeting_id
    ? [
        { t: 12, kind: "memo", text: EN ? "check pool size" : "pool size 확인" },
        { t: 30, kind: "bookmark", text: null },
        { t: 45, kind: "memo", text: EN ? "ask Minsu after the meeting whether the pool size change needs a DB restart, and send the slow-query analysis link to the channel before Wednesday" : "회의 끝나고 민수님께 pool size 바꾸면 DB 재시작이 필요한지 물어보고 수요일 전에 slow query 분석 링크를 채널에 공유하기" },
      ]
    : []);

// 노트 완성 (첫 노트): 메모 탭 글 + 누르면 완성된 노트를 만든다
const FIRST = notes[0].t;
FIRST.memo = EN
  ? { body: "ways to cut AWS cost\n\nbuy GPU server?\n\nhow many hires", lines: [
    { id: "m0001", line: 1, text: "ways to cut AWS cost" }, { id: "m0002", line: 3, text: "buy GPU server?" }, { id: "m0003", line: 5, text: "how many hires" }], seq: 3 }
  : { body: "AWS 비용 줄일 방법\n\nGPU 서버 살지?\n\n채용 몇 명", lines: [
  { id: "m0001", line: 1, text: "AWS 비용 줄일 방법" }, { id: "m0002", line: 3, text: "GPU 서버 살지?" }, { id: "m0003", line: 5, text: "채용 몇 명" }], seq: 3 };
const it = (text: string, ids: string[], owner: string | null = null, due: string | null = null) => ({ text, segment_ids: ids, owner, due });
const ENHANCED_KO = {
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
const ENHANCED_EN = {
  key: "enhanced", kind: "enhanced", template: "enhanced", template_name: "Enhanced note", title: "Q3 budget planning", overview: "",
  sections: [
    { heading: "ways to cut AWS cost", part: "memo", source: "m0001", style: "bullets", items: [
      it("Q2 AWS costs averaged $42K a month, 15% over budget", ["s0002"]),
      it("Scaling the dev EKS cluster to zero at night would save about $6K a month", ["s0003"]),
      it("The nightly scale-down goes in by July 31", ["s0004", "s0005"])] },
    { heading: "buy GPU server?", part: "memo", source: "m0002", style: "bullets", items: [
      it("The quote for a server with two H100s was $98K each", ["s0006"]),
      it("Purchase is on hold in Q3; cloud GPUs are capped at $8K a month", ["s0008"])] },
    { heading: "how many hires", part: "memo", source: "m0003", style: "bullets", items: [
      it("Only two backend developers in the second half; the ML engineer hire is on hold", ["s0009", "s0010"])] },
    { heading: "Bookmark 1:56", part: "memo", source: "r0001", at: 116, style: "bullets", items: [it("Everyone agreed to hold off on the GPU purchase", ["s0008"])] },
    { heading: "Q3 total budget", part: "extra", source: null, style: "bullets", items: [it("$510K for infrastructure, $120K for hiring", ["s0012"])] },
    { heading: "To-dos", part: "todos", source: null, style: "checklist", items: [
      it("Apply the nightly scale-down on the dev cluster", ["s0004"], "Ryan Choi", "July 31"), it("Post the backend job openings", ["s0011"], "Hannah Jung", "This Friday")] },
  ],
};
const ENHANCED = EN ? ENHANCED_EN : ENHANCED_KO;

// AI 다듬기 (docs/design/transcript-polish.md): 문장 몇 개의 낱말 하나를 잘못 들은 것처럼 바꿔 두고, 원래 문장을 제안한다. 구간 셋이 차례로 끝난다
const polishPending = new Map<string, T[]>();
const garble = (w: string) => (w.length > 1 ? w[1] + w[0] + w.slice(2) : w + w);
const fakePolish = (a: T) => {
  const n = notes.find((x) => x.t.meeting_id === a.id) ?? notes[0];
  const segs = n.t.segments as T[];
  const job = (payload: T) => void emit("job", { job: a.job, kind: "polish", ...payload });
  const made: T[] = [];
  segs.forEach((s, i) => {
    if (i % 3 !== 1 || s.corrected_text) return;
    const words = s.text.split(" ");
    const k = Math.min(1, words.length - 1);
    const original = s.text;
    s.text = words.map((w: string, j: number) => (j === k ? garble(w) : w)).join(" ");
    const flags = i % 9 === 4 ? ["number"] : i % 9 === 7 ? ["rewrite"] : [];
    made.push({ id: s.id, start: s.start, before: s.text, text: original, kind: "term", flags });
  });
  polishPending.set(a.id, []);
  const thirds = [0, 1, 2].map((w) => segs.slice(Math.floor((w * segs.length) / 3), Math.floor(((w + 1) * segs.length) / 3)));
  setTimeout(() => job({ event: "stage", stage: "polish" }), 50);
  [2, 0, 1].forEach((w, done) =>
    setTimeout(() => {
      const part = thirds[w];
      if (!part.length) return;
      const ids = new Set(part.map((s) => s.id));
      job({ event: "progress", done: done + 1, total: 3, suggestions: made.filter((m) => ids.has(m.id)), range: [part[0].id, part[part.length - 1].id] });
    }, 1600 * (done + 1)),
  );
  setTimeout(() => {
    polishPending.set(a.id, made);
    job({ event: "done", meeting_id: a.id, meeting_dir: "/tmp", suggestions: made.length });
    job({ event: "exit", code: 0 });
  }, 5400);
  return null;
};
const resolvePolish = (a: T) => {
  const n = notes.find((x) => x.t.meeting_id === a.id) ?? notes[0];
  const left: T[] = [];
  let changed = 0;
  for (const s of polishPending.get(a.id) ?? []) {
    if (!a.ids.includes(s.id)) left.push(s);
    else if (a.accept) {
      const seg = (n.t.segments as T[]).find((x) => x.id === s.id);
      if (seg) Object.assign(seg, { corrected_text: s.text === seg.text ? null : s.text, corrected_by: "ai" }), changed++;
    }
  }
  polishPending.set(a.id, left);
  return { changed, meeting: detail(a.id) };
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

// 회의록 탭 (docs/design/meeting-minutes.md): 첫 노트에만 있다. 근거는 그 노트의 첫 대화 줄들
const minutesFor = (id: string) => {
  const n = notes.find((x) => x.t.meeting_id === id);
  if (n !== notes[0]) return null;
  const ids = (n.t.segments as { id: string }[]).map((x) => x.id);
  const L = (text: string, k: number, extra: T = {}) => ({ text, segment_ids: [ids[k % ids.length]], ...extra });
  return EN
    ? {
        agenda: "Payments API latency, release date, onboarding docs",
        topics: [
          { title: "Payments API latency", open: false, discussed: [L("p95 rose to 800 ms since last week", 1, { unverified: ["800"] }), L("The connection pool fills up", 1)], agreed: [L("Raise the pool size from 20 to 50", 2)], points: [{ label: "Technical issue", details: [{ ...L("Pool exhaustion at peak", 1), children: [L("Slow queries hold connections", 2)] }] }], approach: [] },
          { title: "Onboarding docs", open: true, discussed: [L("Notion or Confluence?", 3)], agreed: [], points: [], approach: [] },
        ],
        actions: [{ ...L("Share the slow-query analysis", 2), team: null, owner: "Minsu Kim", due: "Wednesday", note: null }, { ...L("Draft the onboarding outline", 3), team: null, owner: null, due: null, note: null }],
        next_meeting: [L("Next Tuesday", 3)],
      }
    : {
        agenda: "결제 API latency, 릴리스 일정, 온보딩 문서",
        topics: [
          { title: "결제 API latency", open: false, discussed: [L("지난주부터 p95가 800ms까지 오름", 1, { unverified: ["800"] }), L("DB connection pool이 꽉 참", 1)], agreed: [L("pool size를 20에서 50으로 올리기로 함", 2)], points: [{ label: "기술적 이슈", details: [{ ...L("피크 시간에 pool 고갈", 1), children: [L("slow query가 연결을 오래 잡음", 2)] }] }], approach: [] },
          { title: "온보딩 문서", open: true, discussed: [L("Notion과 Confluence 중 어디에 둘지", 3)], agreed: [], points: [], approach: [] },
        ],
        actions: [{ ...L("slow query 분석 공유", 2), team: null, owner: "김민수", due: "수요일", note: null }, { ...L("온보딩 목차 초안", 3), team: null, owner: null, due: null, note: null }],
        next_meeting: [L("다음 주 화요일", 3)],
      };
};
let minutesEdited: Record<string, T> = {};
const shownMinutes = (m: T | null, edited: string | null) =>
  m ? { minutes: m, attendees: PEOPLE.slice(0, 2), title: EN ? "Weekly dev sync" : "주간 개발 회의", generated_at: "2026-10-20T10:00:00+09:00", edited_at: edited, markdown: "# [26.10.20] …", short: "[회의록] …" } : { minutes: null };

const handlers: Record<string, (a: T) => unknown> = {
  rec_start: fakeRecording,
  rec_send: fakeRecSend,
  marks_save: (a) => ((noteMarks = { ...noteMarks, [a.id]: a.marks }), { marks: a.marks }),
  summary_start: fakeSummary,
  list_meetings: () => notes.map(info),
  note_sample: () => (sampleId = notes.find((n) => n.t.title.includes(Q3))?.t.meeting_id ?? notes[0].t.meeting_id),
  list_recordings: () => [],
  list_folders: () => [{ id: "f1", name: EN ? "Customers" : "고객사", parent: null, order: 0, created_at: "2026-10-01T09:00:00+09:00" }],
  load_meeting: (a) => detail(a.id),
  polish_start: fakePolish,
  polish_resolve: resolvePolish,
  summaries_list: (a) => {
    const n = notes.find((x) => x.t.meeting_id === a.id);
    const extra = made.has(a.id) && n === notes[0] ? [ENHANCED] : [];
    return n?.summary ? [{ ...n.summary, key: "meeting" }, ...(n === notes[0] ? [BRIEF] : []), ...extra] : extra;
  },
  minutes_show: (a) => shownMinutes((minutesEdited[a.id] as T) ?? minutesFor(a.id), minutesEdited[a.id] ? "2026-10-20T11:00:00+09:00" : null),
  minutes_save: (a) => ((minutesEdited = { ...minutesEdited, [a.id]: a.minutes }), shownMinutes(a.minutes, "2026-10-20T11:00:00+09:00")),
  load_chat: (a) => (a.id === notes[0].t.meeting_id ? CHAT : []),
  get_settings: () => settings,
  calendar_next: () => {
    const start = new Date(Date.now() + 6 * 60_000);
    return [{ id: "e1", title: EN ? "Weekly infra check" : "주간 인프라 점검", start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString(), calendar: EN ? "Work" : "회사", attendees: PEOPLE }];
  },
  calendar_status: () => (EN ? { enabled: true, access: "granted", hidden: ["c3"], calendars: [{ id: "c1", title: "Work", source: "Google" }, { id: "c2", title: "Team", source: "Google" }, { id: "c3", title: "US Holidays", source: "Subscribed" }] } : { enabled: true, access: "granted", hidden: ["c3"], calendars: [{ id: "c1", title: "회사", source: "Google" }, { id: "c2", title: "팀 일정", source: "Google" }, { id: "c3", title: "대한민국 공휴일", source: "구독" }] }),
  set_obsidian: ({ vault, audio }: T) => void Object.assign(settings, { obsidian_vault: vault, obsidian_audio: audio }),
  obsidian_send: ({ id }: T) => ({ status: "created", path: `/Users/me/Documents/My Vault/Tractus/${id}.md`, audio: null }),
  doctor: () => ({ doctor, core_error: null, tractus_bin: "tractus", tractus_bin_exists: true, rec_bin: "tractus-rec", rec_bin_exists: true, tractus_source: "repo", rec_source: "repo", home: "~/Tractus", home_risk: null }),
  models_list: () => models,
  // 변환 엔진 직접 추가·기본 엔진 (docs/design/asr-engines.md): 추가하면 목록 끝에 받지 않은 줄이 생긴다
  models_add: ({ repo }: T) => {
    const id = `custom-${String(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 40);
    (models as T).models.push({ id, name: String(repo), purpose: EN ? "A transcription engine you added." : "직접 추가한 변환 엔진입니다.", level: "required", level_note: "one_of", size_bytes: 1_600_000_000, installed: false, installed_bytes: 0, state: "missing", needed_by: ["convert"], group: "convert", path: `~/models/${id}`, model_name: repo, publisher: String(repo).split("/")[0], source: repo, revision: "a".repeat(40), license: "", engine: "whisper", custom: true });
    return { id, repo, engine: "whisper", size_bytes: 1_600_000_000 };
  },
  set_asr_engine: ({ id }: T) => void Object.assign(settings, { asr_engine: id ?? "" }),
  templates_list: () => (templates as T).templates,
  llm_settings: () => llm,
  llm_config: () => ({ provider: "upstage", model: "solar-pro2", host: "api.upstage.ai", remote: true, key_present: true }),
  llm_key_status: (a) => ({ saved: a.provider === "upstage" || a.provider === "claude" }),
  voices_list: () => ({ people: [], needs_reenroll: false, model_present: true }),
  update_available: () => false,
  ui_lang: () => ({ pref: "system", lang: EN ? "en" : "ko" }), // ?lang=en으로 영어 화면 확인
  set_ui_lang: () => null,
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
