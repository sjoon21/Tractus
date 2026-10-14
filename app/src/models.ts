// 모델 화면의 순수 로직 (docs/desktop.md §2.15, WORDS.md §4.14): 구성(프리셋) → 받을 모델, 용량 표시, 받기 진행 상태, 오류 문장.
// 코어 `tractus models list|download|remove`의 JSON을 쓴다. 코어가 주는 키가 조금 달라도 읽도록 느슨하게 받는다.
import type { CapId, ModelState } from "./caps";
import { CAP_NAME, trackOf } from "./caps";

export type ModelLevel = "required" | "recommended" | "optional";

export interface ModelRow {
  id: string;
  name: string;
  purpose: string;
  level: ModelLevel;
  size_bytes: number;
  installed: boolean;
  installed_bytes: number;
  state: ModelState;
  /** 이 모델이 있어야 쓸 수 있는 기능 (CapId) */
  needed_by: string[];
  group: string;
  /** 필수 모델 여럿 중 하나만 있으면 되면 "one_of" (변환 엔진 둘). 옛 코어는 보내지 않는다. level은 그대로 required다 */
  level_note?: string | null;
  // 모델 소개 (코어 `models list --json`의 추가 키, §2.15). 옛 코어는 보내지 않고 모르는 값은 null이다
  model_name?: string | null;
  publisher?: string | null;
  converted_by?: string | null;
  /** 내려받는 곳: 저장소 ID 또는 URL */
  source?: string | null;
  revision?: string | null;
  license?: string | null;
  languages?: string | null;
  params?: string | null;
}

export interface ModelsList {
  models_dir: string;
  disk_free_bytes: number | null;
  /** 다른 곳(터미널의 `tractus models download` 등)이 지금 받는 중이다. 코어는 한 번에 하나만 받는다 */
  download_active: boolean;
  models: ModelRow[];
}

export const LEVEL_LABEL: Record<ModelLevel, string> = { required: "필수", recommended: "권장", optional: "선택" };
export const ONE_OF_LABEL = "필수 (둘 중 하나)";
/** 구분 칸 글자: 변환 엔진처럼 둘 중 하나만 있으면 되는 필수 모델은 `필수 (둘 중 하나)` */
export const levelLabel = (m: Pick<ModelRow, "level" | "level_note">): string => (m.level === "required" && m.level_note === "one_of" ? ONE_OF_LABEL : LEVEL_LABEL[m.level]);

/** 필수 요약 줄: 둘 중 하나인 필수 모델(변환 엔진) 중 어느 하나라도 있으면 설치됨. 그런 모델이 없으면(옛 코어) null */
export function engineSummary(models: Pick<ModelRow, "level" | "level_note" | "installed">[]): { text: string; ok: boolean } | null {
  const group = models.filter((m) => m.level === "required" && m.level_note === "one_of");
  if (group.length === 0) return null;
  const ok = group.some((m) => m.installed);
  return { ok, text: ok ? "변환 엔진: 설치됨" : "변환 엔진: 없음 — 둘 중 하나를 설치하세요" };
}
export const STATE_LABEL: Record<ModelState, string> = { installed: "설치됨", missing: "없음", partial: "일부만 받음", corrupt: "손상" };

/** 용량 표시: 맥 Finder처럼 1000 단위 (1.3 MB, 2.3 GB) */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${Math.round(n)} B`;
}

// ── 모델 소개 (WORDS.md §4.15 `모델 화면`) ──

export const MODEL_DETAIL_LABEL = "자세히";
/** 버전 줄의 전체 값을 화면 읽기 도우미에게 알려 주는 말 (보이는 글자는 앞 8자) */
export const MODEL_FULL_REVISION_LABEL = "전체 버전";
const REVISION_SHOWN = 8;

const filled = (v: string | null | undefined): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 이름 아래 한 줄: `{모델 이름} · {만든 곳}`. 둘 다 모르면(옛 코어) null */
export function modelSubtitle(m: Pick<ModelRow, "model_name" | "publisher">): string | null {
  return [filled(m.model_name), filled(m.publisher)].filter((x): x is string => x !== null).join(" · ") || null;
}

export interface DetailRow {
  label: string;
  value: string;
  /** 마우스를 올리면 보이는 전체 값 (버전의 긴 값) */
  title?: string;
}

/** 자세히 목록. 모르는 값은 줄을 빼고, 소개가 하나도 없으면(옛 코어) 빈 목록이라 자세히 자체를 보이지 않는다 */
export function modelDetailRows(m: ModelRow): DetailRow[] {
  const rev = filled(m.revision);
  const rows: (DetailRow | null)[] = [
    pick("모델 이름", m.model_name),
    pick("만든 곳", m.publisher),
    pick("변환한 곳", m.converted_by),
    pick("내려받는 곳", m.source),
    rev ? { label: "버전", value: rev.slice(0, REVISION_SHOWN), title: rev } : null,
    pick("라이선스", m.license),
    pick("지원 언어", m.languages),
    pick("규모", m.params),
  ];
  const found = rows.filter((r): r is DetailRow => r !== null);
  return found.length === 0 ? [] : [...found, { label: "크기", value: fmtBytes(m.size_bytes) }];
}

function pick(label: string, value: string | null | undefined): DetailRow | null {
  const v = filled(value);
  return v ? { label, value: v } : null;
}

// ── 구성(프리셋) ──

export type Preset = "required" | "standard" | "lite";

export const PRESETS: { id: Preset; label: string; note: string }[] = [
  { id: "standard", label: "표준 구성 설치", note: "변환 엔진 1.7B와 참석자 구분·단어 싱크·스마트 검색·목소리 등록. 메모리 16 GB 이상 권장" },
  { id: "lite", label: "저사양 구성 설치", note: "작은 변환 엔진 0.6B와 참석자 구분. 실시간 텍스트 변환도 쓸 수 있습니다" },
  { id: "required", label: "필수만 설치", note: "텍스트 변환만 됩니다. 나머지 기능은 나중에 하나씩 설치하세요" },
];

const STANDARD_EXTRA = ["asr-std", "diarizer", "aligner", "embedding", "voices"];
const ASR_IDS = ["asr-std", "asr-lite"];

/** 구성 → 모델 ID 목록. 필수만: 목소리 구간 분석 + 변환 엔진 하나(이미 있으면 새로 받지 않고, 없으면 메모리에 맞는 쪽).
 * 표준: 필수 + 변환 엔진 1.7B와 나머지(작은 엔진은 실시간 텍스트 변환용이라 넣지 않는다). 저사양: 작은 엔진 + 참석자 구분 */
export function presetIds(preset: Preset, models: ModelRow[], recommendedTrack: string | null | undefined): string[] {
  const asrInstalled = models.some((m) => ASR_IDS.includes(m.id) && m.installed);
  const asr = trackOf(recommendedTrack) === "lite" ? "asr-lite" : "asr-std";
  const required = asrInstalled ? ["vad"] : ["vad", asr];
  switch (preset) {
    case "required":
      return required;
    case "lite":
      return ["vad", "asr-lite", "diarizer"];
    case "standard":
      return [...new Set([...required, ...STANDARD_EXTRA])];
  }
}

/** 이미 설치된 것은 뺀다. 일부만 받은 것·손상된 것은 다시 받는다. 코어가 모르는 ID는 버린다 */
export const toInstall = (ids: string[], models: ModelRow[]): string[] => ids.filter((id) => models.some((m) => m.id === id && !m.installed));

/** 받을 목록 중 손상된 것의 ID (코어는 손상된 모델 받기를 거부하므로 먼저 지워야 한다) */
export const corruptIn = (ids: string[], models: ModelRow[]): string[] => ids.filter((id) => models.some((m) => m.id === id && m.state === "corrupt"));

export interface PlanItem {
  id: string;
  name: string;
  size: number;
}

/** 받을 모델의 이름·용량. 이미 받아 둔 부분(일부만 받음)은 용량에서 빼지 않는다: 이어 받는 양은 코어가 정한다 */
export function planOf(ids: string[], models: ModelRow[]): PlanItem[] {
  return ids.flatMap((id) => {
    const m = models.find((x) => x.id === id);
    return m ? [{ id, name: m.name, size: m.size_bytes }] : [];
  });
}

export const planSize = (plan: PlanItem[]): number => plan.reduce((s, p) => s + p.size, 0);

/** 코어는 받기 전에 여유 ≥ 용량×1.1을 확인한다. 같은 계산으로 미리 알린다 (여유를 모르면 null) */
export const DISK_MARGIN = 1.1;
export function diskShort(plan: PlanItem[], free: number | null | undefined): string | null {
  const need = planSize(plan);
  if (free === null || free === undefined || need === 0 || free >= need * DISK_MARGIN) return null;
  return `디스크 여유 공간이 부족합니다 (필요 ${fmtBytes(need * DISK_MARGIN)}, 여유 ${fmtBytes(free)}). 공간을 비운 뒤 설치하세요.`;
}

export const installLabel = (state: ModelState): string => (state === "partial" ? "이어 받기" : state === "corrupt" ? "다시 받기" : "받기");

/** 기능 칩 글자 (CapId가 아닌 값은 그대로) */
export const capChip = (id: string): string => CAP_NAME[id as CapId] ?? id;

/** 지우기 확인 대화상자 (WORDS.md §4.14). 지우면 못 쓰게 되는 기능을 말한다 */
export function removeDialog(m: Pick<ModelRow, "name" | "installed_bytes" | "needed_by">): { title: string; body: string; cancel: string; confirm: string } {
  const lost = m.needed_by.length > 0 ? ` ${m.needed_by.map(capChip).join(", ")} 기능을 다시 설치할 때까지 쓸 수 없습니다.` : "";
  return {
    title: `‘${m.name}’을(를) 삭제할까요?`,
    body: `이 Mac에서 ${fmtBytes(m.installed_bytes)}를 비웁니다. 언제든 다시 받을 수 있습니다.${lost}`,
    cancel: "취소",
    confirm: "삭제",
  };
}

// ── 받기 진행 ──

/** `tractus models download --progress-json` 이벤트 (docs/desktop.md §2.15). 키 이름이 조금 달라도 읽는다 */
export interface ModelsEvent {
  event: string;
  job?: string;
  model?: string;
  id?: string;
  file?: string;
  current_file?: string;
  done?: number;
  total?: number;
  bytes_done?: number;
  bytes_total?: number;
  /** 이번에 받는 모델 전체의 받은·전체 바이트 */
  overall_done?: number;
  overall_total?: number;
  size_bytes?: number;
  code?: string | number | null;
  message?: string;
  stderr?: string;
}

export interface DownloadState {
  running: boolean;
  /** 사용자가 멈추기를 눌렀다 (끝나면 오류가 아니라 '멈췄습니다') */
  cancelling: boolean;
  plan: PlanItem[];
  /** 지금 받는 모델 ID */
  model: string | null;
  file: string | null;
  /** 지금 모델의 받은 바이트·전체 바이트 */
  done: number;
  total: number;
  /** 이번 받기 전체의 받은·전체 바이트 (코어가 알릴 때. 없으면 null) */
  overall: { done: number; total: number } | null;
  finished: string[];
  warnings: { code: string; message: string }[];
  error: { code: string | null; message: string; model: string | null } | null;
  /** 끝까지 마쳤다 (오류·멈춤이 아님) */
  completed: boolean;
  stopped: boolean;
}

export const IDLE_DOWNLOAD: DownloadState = {
  running: false,
  cancelling: false,
  plan: [],
  model: null,
  file: null,
  done: 0,
  total: 0,
  overall: null,
  finished: [],
  warnings: [],
  error: null,
  completed: false,
  stopped: false,
};

export type DownloadAction = { type: "start"; plan: PlanItem[] } | { type: "cancel" } | { type: "event"; ev: ModelsEvent } | { type: "failed"; message: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function downloadReduce(s: DownloadState, a: DownloadAction): DownloadState {
  switch (a.type) {
    case "start":
      return { ...IDLE_DOWNLOAD, running: true, plan: a.plan, model: a.plan[0]?.id ?? null };
    case "cancel":
      return s.running ? { ...s, cancelling: true } : s;
    case "failed":
      // 시작하지 못했다 (실행 파일 경로 등): 앱이 만든 문장이다
      return { ...IDLE_DOWNLOAD, plan: s.plan, error: { code: "app", message: a.message, model: null } };
    case "event":
      return eventReduce(s, a.ev);
  }
}

function eventReduce(s: DownloadState, ev: ModelsEvent): DownloadState {
  const model = text(ev.model) ?? text(ev.id);
  switch (ev.event) {
    case "stage":
    case "model_start":
      return model && model !== s.model ? { ...s, model, file: null, done: 0, total: num(ev.size_bytes) ?? 0 } : s;
    case "progress": {
      const changed = model && model !== s.model;
      const [od, ot] = [num(ev.overall_done), num(ev.overall_total)];
      return {
        ...s,
        overall: od !== null && ot !== null && ot > 0 ? { done: od, total: ot } : s.overall,
        model: model ?? s.model,
        file: text(ev.file) ?? text(ev.current_file) ?? (changed ? null : s.file),
        done: num(ev.done) ?? num(ev.bytes_done) ?? (changed ? 0 : s.done),
        total: num(ev.total) ?? num(ev.bytes_total) ?? (changed ? 0 : s.total),
      };
    }
    case "model_done":
    case "installed": {
      const id = model ?? s.model;
      return id && !s.finished.includes(id) ? { ...s, finished: [...s.finished, id], done: s.total, file: null } : s;
    }
    case "cancelled":
      // 코어가 SIGTERM·Ctrl-C로 멈췄다고 알렸다 (종료 코드 130): 앱이 멈추기를 눌렀든 아니든 오류가 아니다
      return { ...s, cancelling: true };
    case "warning":
      return { ...s, warnings: [...s.warnings, { code: text(ev.code) ?? "", message: text(ev.message) ?? "" }] };
    case "error":
      return { ...s, error: { code: ev.code === null || ev.code === undefined ? null : String(ev.code), message: text(ev.message) ?? "", model } };
    case "done":
      return { ...s, completed: true };
    case "exit": {
      if (s.error || s.cancelling) return { ...s, running: false, stopped: s.cancelling && !s.error };
      if (ev.code === 0 || s.completed) return { ...s, running: false, completed: true, model: null, file: null };
      // 이벤트 없이 끝났다 (신호로 끝나면 코드가 없다)
      return { ...s, running: false, error: { code: null, message: text(ev.stderr) ?? "", model: s.model } };
    }
    default:
      return s;
  }
}

/** 전체 진행률 0..1: 끝난 모델의 용량 + 지금 모델의 받은 양 ÷ 계획 전체. 용량을 모르면 지금 모델만, 그도 모르면 null */
export function overallFraction(s: DownloadState): number | null {
  if (s.overall && s.overall.total > 0 && !s.completed) return Math.min(1, s.overall.done / s.overall.total);
  const all = planSize(s.plan);
  if (all > 0) {
    const finished = s.plan.filter((p) => s.finished.includes(p.id)).reduce((t, p) => t + p.size, 0);
    const cur = s.plan.find((p) => p.id === s.model && !s.finished.includes(p.id));
    const part = cur ? Math.min(s.done, cur.size) : 0;
    return Math.min(1, (finished + part) / all);
  }
  return s.total > 0 ? Math.min(1, s.done / s.total) : null;
}

/** 진행 줄: `Qwen3-ASR 1.7B 받는 중… 120 MB / 2.3 GB (1/3)` */
export function progressLine(s: DownloadState): string {
  const cur = s.plan.find((p) => p.id === s.model);
  const idx = Math.min(s.plan.length, s.finished.length + (cur && !s.finished.includes(cur.id) ? 1 : 0));
  const name = cur?.name ?? "모델";
  const bytes = s.total > 0 ? ` ${fmtBytes(s.done)} / ${fmtBytes(s.total)}` : "";
  const nth = s.plan.length > 1 ? ` (${idx}/${s.plan.length})` : "";
  return s.cancelling ? "멈추는 중…" : `${name} 받는 중…${bytes}${nth}`;
}

// ── 오류 문장 (WORDS.md §4.14). 코드가 없거나 모르면 기본 문장 + 자세히 ──

export const DOWNLOAD_FAILED = "모델을 받지 못했습니다";
export const DOWNLOAD_STOPPED = "받기를 멈췄습니다. 다시 받으면 멈춘 곳부터 이어서 받습니다.";
export const DOWNLOAD_DONE = "모델을 받았습니다";

export const MODEL_ERROR: Record<string, string> = {
  no_network: "인터넷에 연결하지 못해 받지 못했습니다. 연결을 확인하고 다시 받으면 멈춘 곳부터 이어서 받습니다.",
  disk_full: "디스크 여유 공간이 부족해 받지 못했습니다. 공간을 비운 뒤 다시 받으세요.",
  auth: "내려받는 곳이 접근을 거절했습니다. 네트워크 환경(프록시·로그인)을 확인하고 잠시 뒤 다시 시도하세요.",
  hash_mismatch: "내려받은 파일이 올바르지 않습니다. 다시 받으세요.",
  helper_missing: "9명 이상 구분 도구(tractus-diar)가 없어 받지 못했습니다. 저장소의 recorder/diar 폴더에서 swift build -c release로 먼저 만드세요.",
  busy: "다른 모델을 받는 중입니다. 끝난 뒤에 다시 시도하세요.",
  corrupt: "받아 둔 파일이 손상되어 있습니다. 삭제한 뒤 다시 받으세요.",
  unsafe_path: "모델 위치 밖의 폴더라 지우지 않았습니다. 설정의 모델 위치(TRACTUS_MODELS_DIR)를 확인하세요.",
};

/** 오류 → 화면 문장과 자세히 (앱이 시작하지 못한 오류 `app`은 첫 줄이 문장이다) */
export function downloadErrorView(e: NonNullable<DownloadState["error"]>): { text: string; detail: string | null } {
  if (e.code === "app") {
    const [first, ...rest] = e.message.split("\n");
    return { text: first || DOWNLOAD_FAILED, detail: rest.join("\n").trim() || null };
  }
  const mapped = e.code ? MODEL_ERROR[e.code] : undefined;
  return { text: mapped ?? DOWNLOAD_FAILED, detail: e.message || null };
}

/** 모델 목록 → 설치 요약: 설치됨 N/전체, 설치한 용량 */
export function installedSummary(models: ModelRow[]): { installed: number; total: number; bytes: number } {
  return { installed: models.filter((m) => m.installed).length, total: models.length, bytes: models.reduce((s, m) => s + (m.installed_bytes || 0), 0) };
}
