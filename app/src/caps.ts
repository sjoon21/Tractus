// 기능 사용 가능 여부 (docs/desktop.md §2.15, WORDS.md §4.14). 코어 `tractus doctor --json`의 capabilities를 앱이 어떻게 쓰는지의 순수 로직이다.
// 모델이 없는 기능은 조용히 실패하지 않는다: 단추는 aria-disabled로 이유와 고치는 길을 보여 주고(GatedButton), 코어는 선택 단계를 건너뛰며 경고한다.
// 개발자용 화면이라 이 파일과 models.ts·checkupRows.ts의 `모델`은 제품 말이다 (WORDS.md §5가 이 파일들만 `모델`을 허용한다).
// 점검 정보를 읽지 못하면(옛 코어·오류) 모두 쓸 수 있다고 본다: 앱을 막지 않는다.

export type CapId = "record" | "convert" | "diarize" | "diarize-many" | "align" | "smart-search" | "live" | "voices";

export type ModelState = "installed" | "missing" | "partial" | "corrupt";

export interface DoctorCap {
  id: string;
  name: string;
  ready: boolean;
  /** 없는 모델 ID(`asr-lite`)나 도구 이름(`ffmpeg`) */
  missing: string[];
  hint: string;
}

export interface DoctorTool {
  found: boolean;
  path: string | null;
  version: string | null;
}

export interface Doctor {
  system: { arch: string | null; macos_version: string | null; memory_gb: number | null; meets_min: boolean | null; disk_free_bytes: number | null };
  tools: { ffmpeg: DoctorTool; recorder: DoctorTool; diar_helper: DoctorTool; brew: DoctorTool | null };
  models: { id: string; state: ModelState; installed: boolean }[];
  capabilities: DoctorCap[];
  /** 코어가 메모리로 권하는 변환 엔진 (`asr-std` | `asr-lite` 또는 표준·저사양 이름). trackOf로 읽는다 */
  recommended_track: string | null;
}

/** Rust `doctor` 명령의 결과. 코어를 부르지 못했거나(경로가 틀림, 옛 코어) 읽지 못하면 doctor가 null이다 */
export interface DoctorReport {
  doctor: Doctor | null;
  core_error: string | null;
  tractus_bin: string;
  tractus_bin_exists: boolean;
  rec_bin: string;
  rec_bin_exists: boolean;
  /** 경로가 어디서 왔는지 (Rust paths.rs): custom 직접 지정 | env | bundle | repo | known | none 못 찾음. 옛 앱은 보내지 않는다 */
  tractus_source?: string;
  rec_source?: string;
  /** 이번 실행에서 없어서 자동으로 되돌린 저장 경로 (`tractus_bin`·`rec_bin`) */
  stale_saved?: string[];
  /** 데이터 폴더(펼친 경로)와, 동기화 폴더·Obsidian 볼트 안이면 그 이름 (iCloud Drive | Dropbox | OneDrive | Google Drive | Obsidian) */
  home?: string;
  home_risk?: string | null;
}

/** pick-*: 파일·폴더를 골라 설정에 저장 / auto-*: 직접 지정을 지우고 자동으로. 시작 점검 화면이 직접 처리한다 (pathFix.ts) */
export type FixKind = "models" | "checkup" | "settings" | "pick-tractus" | "auto-tractus" | "pick-rec" | "auto-rec" | "pick-home";
export interface Fix {
  kind: FixKind;
  label: string;
}

export type Decision = { ok: true } | { ok: false; reason: string; missing: string[]; fix: Fix };

export const OK: Decision = { ok: true };

/** 코어가 `missing`에 모델과 함께 돌려줄 수 있는 도구 이름 (이 밖은 모델 ID로 본다. `memory`는 live만 따로 먼저 읽는다) */
const TOOL_IDS = new Set(["ffmpeg", "recorder", "tractus-rec", "diar_helper", "diar-helper", "tractus-diar"]);
const RECORDER_IDS = new Set(["recorder", "tractus-rec"]);

export const CAP_NAME: Record<CapId, string> = {
  record: "녹음",
  convert: "텍스트 변환",
  diarize: "참석자 구분",
  "diarize-many": "9명 이상 구분",
  align: "단어 싱크",
  "smart-search": "스마트 검색",
  live: "실시간 텍스트 변환",
  voices: "목소리 등록",
};

/** 화면 이름·열기 단추 글자 (모델 화면은 개발자가 쓰는 화면이라 `모델`이 제품 말이다. 다른 파일에는 `모델`을 쓰지 않으려고 여기서만 정한다) */
export const MODELS_LABEL = "모델";
export const MODELS_OPEN = "모델 화면 열기";
/** 온보딩 목록의 첫 단계 (onboarding.ts). `모델`은 이 파일에서만 쓴다 (WORDS.md §5) */
export const ONBOARD_MODELS = { label: "변환 모델 받기", hint: "녹음을 텍스트로 바꾸는 모델입니다. 이 Mac에만 저장됩니다.", action: MODELS_OPEN };
export const CHECKUP_LABEL = "시작 점검";
export const CHECKUP_OPEN = "시작 점검 열기";

export const FIX_MODELS: Fix = { kind: "models", label: "모델 설치" };
export const FIX_CHECKUP: Fix = { kind: "checkup", label: CHECKUP_OPEN };
export const FIX_SETTINGS: Fix = { kind: "settings", label: "설정 열기" };

const REASON = {
  convert: "변환 엔진이 없어 텍스트로 변환할 수 없습니다. 모델 화면에서 설치하세요.",
  convertBoth: "변환 엔진과 ffmpeg가 없어 텍스트로 변환할 수 없습니다. 모델 화면에서 변환 엔진을 설치하고, 터미널에서 brew install ffmpeg를 실행하세요.",
  ffmpeg: "음성 파일을 읽는 데 필요한 ffmpeg가 없어 텍스트로 변환할 수 없습니다. 터미널에서 brew install ffmpeg로 설치한 뒤 시작 점검에서 다시 확인하세요.",
  diarize: "참석자 구분 모델이 없어 참석자를 나누지 못했습니다. 모델 화면에서 설치하면 다음 변환부터 참석자를 나눕니다.",
  diarizeMany: "9명 이상 구분에 필요한 도구가 없어 참석자를 최대 8명까지만 구분합니다. 모델 화면에서 안내를 확인하세요.",
  align: "단어 싱크 모델이 없어 단어 싱크를 맞출 수 없습니다. 모델 화면에서 설치하세요.",
  smartSearch: "스마트 검색 모델이 없어 단어 일치로만 찾습니다. 모델 화면에서 설치하세요.",
  smartSearchKey: "스마트 검색에 쓸 Upstage API 키가 없어 단어 일치로만 찾습니다. 설정에서 API 키를 등록하세요.",
  smartSearchLocalOnly: "로컬 전용 모드라 Upstage를 쓰지 않고 단어 일치로만 찾습니다. 설정에서 스마트 검색 방식을 바꾸세요.",
  liveLite: "실시간 텍스트 변환에는 작은 변환 엔진(0.6B)이 따로 필요합니다. 표준 변환 엔진을 설치했어도 마찬가지입니다. 모델 화면에서 설치하세요.",
  liveFiles: "실시간 텍스트 변환에 필요한 파일(목소리 구간 감지)이 없습니다. 모델 화면에서 설치하세요.",
  liveMemory: "이 Mac은 메모리가 16 GB 미만이라 실시간 텍스트 변환을 켜지 않습니다. 녹음은 정상 진행되고, 녹음 종료 후 텍스트로 변환합니다.",
  liveRecorder: "녹음 프로그램(tractus-rec)을 찾지 못해 실시간 텍스트 변환을 쓸 수 없습니다. 설정에서 실행 파일 경로를 확인하세요.",
  record: "녹음 프로그램(tractus-rec)을 찾지 못해 녹음할 수 없습니다. 설정에서 실행 파일 경로를 확인하세요.",
  alignFfmpeg: "음성 파일을 읽는 데 필요한 ffmpeg가 없어 단어 싱크를 맞출 수 없습니다. 터미널에서 brew install ffmpeg로 설치한 뒤 시작 점검에서 다시 확인하세요.",
  voicesFfmpeg: "음성 파일을 읽는 데 필요한 ffmpeg가 없어 목소리를 등록할 수 없습니다. 이름만 바꿀 수 있습니다. 터미널에서 brew install ffmpeg로 설치한 뒤 시작 점검에서 다시 확인하세요.",
  voices: "목소리 인식 모델이 없어 목소리를 등록할 수 없습니다. 이름만 바꿀 수 있습니다. 모델 화면에서 설치하세요.",
} as const;

/** 코어 점검이 아니라 앱이 `missing`에 넣는 값: 스마트 검색을 Upstage로 쓰는데 Upstage 키가 없다 */
export const UPSTAGE_KEY_MISSING = "upstage-key";
/** 스마트 검색을 Upstage로 쓰는데 로컬 전용 모드라 코어가 Upstage를 쓰지 않는다 */
export const LOCAL_ONLY_MISSING = "local-only";

const isTool = (id: string) => TOOL_IDS.has(id);

/** 기능 하나를 쓸 수 있는가. 못 쓰면 이유 문장과 고치는 길(모델 화면·시작 점검·설정)을 돌려준다 */
export function decide(report: DoctorReport | null | undefined, id: CapId): Decision {
  // 녹음은 모델이 아니라 앱이 쓰는 녹음 프로그램 경로(설정)가 기준이다: 코어가 보는 기본 경로와 다를 수 있다
  if (id === "record") return report && !report.rec_bin_exists ? { ok: false, reason: REASON.record, missing: ["recorder"], fix: FIX_SETTINGS } : OK;
  const cap = report?.doctor?.capabilities.find((c) => c.id === id);
  if (!cap || cap.ready) return OK; // 모르면(옛 코어·점검 실패) 막지 않는다
  const models = cap.missing.filter((m) => !isTool(m));
  const tools = cap.missing.filter(isTool);
  const noFfmpeg = tools.includes("ffmpeg");
  const noRecorder = tools.some((t) => RECORDER_IDS.has(t));
  const fail = (reason: string, fix: Fix): Decision => ({ ok: false, reason, missing: cap.missing, fix });
  switch (id) {
    case "convert":
      if (models.length > 0 && noFfmpeg) return fail(REASON.convertBoth, FIX_MODELS);
      if (models.length === 0 && noFfmpeg) return fail(REASON.ffmpeg, FIX_CHECKUP);
      return fail(REASON.convert, FIX_MODELS);
    case "live":
      if (cap.missing.includes("memory")) return fail(REASON.liveMemory, FIX_CHECKUP); // 메모리는 채울 수 없다: 점검의 메모리 행으로 안내한다
      if (noRecorder && models.length === 0) return fail(REASON.liveRecorder, FIX_SETTINGS);
      return fail(models.length > 0 && !models.includes("asr-lite") ? REASON.liveFiles : REASON.liveLite, FIX_MODELS);
    case "diarize":
      return fail(REASON.diarize, FIX_MODELS);
    case "diarize-many":
      return fail(REASON.diarizeMany, FIX_MODELS);
    case "align":
      return models.length === 0 && noFfmpeg ? fail(REASON.alignFfmpeg, FIX_CHECKUP) : fail(REASON.align, FIX_MODELS);
    case "smart-search":
      // 스마트 검색을 Upstage로 쓰는 중이면 이 Mac의 검색 모델이 아니라 Upstage 키가 빠진 것이다 (Rust apply_embedding)
      if (cap.missing.includes(LOCAL_ONLY_MISSING)) return fail(REASON.smartSearchLocalOnly, FIX_SETTINGS);
      return cap.missing.includes(UPSTAGE_KEY_MISSING) ? fail(REASON.smartSearchKey, FIX_SETTINGS) : fail(REASON.smartSearch, FIX_MODELS);
    case "voices":
      return models.length === 0 && noFfmpeg ? fail(REASON.voicesFfmpeg, FIX_CHECKUP) : fail(REASON.voices, FIX_MODELS);
  }
}

/** 코어 오류 `model_missing`(변환 엔진 파일 없음)과 경고 `asr_track_fallback`(권장 엔진이 없어 다른 엔진으로 변환)의 문장 (lib.ts가 코드 표에 쓴다) */
export const MODEL_MISSING_ERROR = "변환 엔진 파일이 없어 진행하지 못했습니다. 모델 화면에서 설치하거나 설정의 ‘변환 엔진 위치’를 확인하세요.";
export const ASR_FALLBACK_WARNING = "권장 변환 엔진이 없어 설치된 다른 변환 엔진으로 변환했습니다. 권장 엔진은 모델 화면에서 설치할 수 있습니다.";

/** 녹음 버튼 아래 안내: 녹음은 모델 없이도 된다. 변환을 못 하는 이유가 있을 때만 (없으면 null) */
export const RECORD_NOTICE_MODELS = "변환 엔진이 없어 녹음만 저장됩니다. 모델 화면에서 설치하면 변환할 수 있습니다";
export const RECORD_NOTICE_FFMPEG = "ffmpeg가 없어 녹음만 저장됩니다. 설치하면 변환할 수 있습니다";
export function recordNotice(d: Decision): string | null {
  if (d.ok) return null;
  return d.fix.kind === "checkup" ? RECORD_NOTICE_FFMPEG : RECORD_NOTICE_MODELS;
}

/** 변환을 못 하는 동안 파일을 끌어 오면 보이는 덮개 문장 (놓으면 이유와 고치는 길이 알림으로 보인다) */
export const DROP_UNAVAILABLE = "지금은 파일을 텍스트로 변환할 수 없습니다";

/** 녹음을 마쳤지만 변환을 시작하지 못했을 때 녹음 화면의 문장 */
export const UNCONVERTED_SAVED = "녹음을 저장했습니다. 지금은 텍스트로 변환할 수 없어 ‘변환 대기 중인 녹음’에 남겨 두었습니다. 준비가 끝나면 왼쪽 목록에서 변환하세요.";

/** 참석자 구분 모델이 없을 때 노트에 한 번 보이는 한 줄 (참석자가 없는 녹음 노트에만) */
export const SPEAKER_HINT = "참석자 구분 모델이 없어 참석자를 나누지 못했습니다";
export const SPEAKER_HINT_DISMISS = "이 안내 닫기";

/** 안내를 보일지: 모델이 없고, 이 노트에 참석자가 하나도 없고(대화는 있고), 아직 닫지 않았을 때 */
export function speakerHintVisible(o: { diarize: Decision; isRecording: boolean; segments: number; speakers: number; dismissed: boolean }): boolean {
  return !o.diarize.ok && o.isRecording && o.segments > 0 && o.speakers === 0 && !o.dismissed;
}

/** ⌘K 검색 결과가 단어 일치뿐이고 스마트 검색 모델이 없을 때만 이유와 고치는 길을 보인다 */
export const showSearchNotice = (vectorUsed: boolean, smart: Decision): boolean => !vectorUsed && !smart.ok;

/** 메모리로 권하는 변환 엔진 이름 → 'std' | 'lite'. 코어가 주는 이름이 달라도 읽는다 (asr-lite, lite, 0.6B, 저사양) */
export function trackOf(recommended: string | null | undefined): "std" | "lite" {
  return /lite|0\.6|저사양/i.test(recommended ?? "") ? "lite" : "std";
}
