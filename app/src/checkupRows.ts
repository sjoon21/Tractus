// 시작 점검 (docs/desktop.md §2.15, WORDS.md §4.14)의 행 모델. 화면(Checkup.tsx)은 이 구조를 그리기만 한다.
// 상태: ok = 문제 없음, warn = 일부 기능이 줄어듦, blocked = 핵심 기능이 안 됨, info = 안내(앱이 미리 확인할 수 없음).
// 점검은 앱을 막지 않는다: blocked여도 노트 쓰기·검색·녹음 보관은 된다.
import type { DoctorReport, Fix } from "./caps";
import { FIX_MODELS } from "./caps";
import { fmtBytes, type ModelRow, type ModelsList } from "./models";
import { binView, BROWSE, HOME_PICK, REVERT_AUTO, type BinKind } from "./paths";

export type RowStatus = "ok" | "warn" | "blocked" | "info";

export interface CheckupRow {
  id: string;
  label: string;
  status: RowStatus;
  detail: string;
  fix?: Fix;
  /** 눌러서 복사할 터미널 명령 */
  copy?: string;
}

export type SectionId = "system" | "tools" | "data" | "models" | "permissions" | "ai";
export interface CheckupSection {
  id: SectionId;
  title: string;
  rows: CheckupRow[];
}

export const BREW_FFMPEG = "brew install ffmpeg";
export const MIN_MACOS = [14, 4] as const;
export const MIN_MEMORY_GB = 8;
export const STANDARD_MEMORY_GB = 16;
/** 구성을 받을 때 필요한 디스크: 표준 약 4.6 GB(스마트 검색이 8bit가 된 2026-10-15 이후, 전에는 5.2), 저사양 약 1.2 GB (코어 레지스트리의 크기 합). 여유가 이 값의 1.1배(코어의 확인)보다 많으면 문제 없다 */
export const STANDARD_DISK = 4.6e9;
export const LITE_DISK = 1.2e9;
export const MIN_DISK = LITE_DISK * 1.25;

export const KEY_FIX: Fix = { kind: "settings", label: "API 키 등록" };
export const STALE_SAVED = "저장된 경로가 없어 자동 경로를 씁니다";
export const HOME_RISK = "이 폴더는 동기화되거나 Obsidian 볼트일 수 있습니다. 노트 폴더 안에 모델을 두지 마세요";
const fixFor = (kind: BinKind, kindOfFix: "pick" | "auto", label: string): Fix => ({ kind: `${kindOfFix}-${kind}` as Fix["kind"], label });

export const STATUS_LABEL: Record<RowStatus, string> = { ok: "문제 없음", warn: "확인 필요", blocked: "사용할 수 없음", info: "안내" };

/** "14.4.1" → 14.4 이상인가. 읽지 못하면 null */
export function macosAtLeast(version: string | null | undefined, min: readonly [number, number] = MIN_MACOS): boolean | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec((version ?? "").trim());
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2] ?? 0)];
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

const unknown = (id: string, label: string): CheckupRow => ({ id, label, status: "warn", detail: "읽지 못했습니다. 아래 ‘다시 확인’을 눌러 보세요." });

function systemRows(report: DoctorReport | null, models: ModelsList | null): CheckupRow[] {
  const sys = report?.doctor?.system;
  if (!sys) return [unknown("system", "시스템")];
  const rows: CheckupRow[] = [];
  const arch = sys.arch;
  rows.push(
    arch === null
      ? unknown("arch", "Apple Silicon")
      : arch === "arm64"
        ? { id: "arch", label: "Apple Silicon", status: "ok", detail: "arm64" }
        : { id: "arch", label: "Apple Silicon", status: "blocked", detail: `변환 엔진은 Apple Silicon Mac에서만 동작합니다 (지금: ${arch})` },
  );
  const mac = macosAtLeast(sys.macos_version);
  rows.push(
    mac === null
      ? unknown("macos", "macOS 14.4 이상")
      : { id: "macos", label: "macOS 14.4 이상", status: mac ? "ok" : "blocked", detail: mac ? `macOS ${sys.macos_version}` : `시스템 오디오 녹음에 14.4 이상이 필요합니다 (지금: ${sys.macos_version})` },
  );
  const gb = sys.memory_gb;
  rows.push(
    gb === null
      ? unknown("memory", "메모리")
      : gb >= STANDARD_MEMORY_GB
        ? { id: "memory", label: "메모리", status: "ok", detail: `${gb} GB — 표준 구성을 쓸 수 있습니다` }
        : gb >= MIN_MEMORY_GB
          ? { id: "memory", label: "메모리", status: "warn", detail: `${gb} GB — 저사양 구성을 권합니다. 실시간 텍스트 변환은 켜지지 않습니다 (16 GB 이상)` }
          : { id: "memory", label: "메모리", status: "blocked", detail: `${gb} GB — 8 GB 이상이 필요합니다` },
  );
  const free = models?.disk_free_bytes ?? sys.disk_free_bytes;
  rows.push(
    free === null || free === undefined
      ? unknown("disk", "디스크 여유")
      : free >= STANDARD_DISK * 1.15
        ? { id: "disk", label: "디스크 여유", status: "ok", detail: `${fmtBytes(free)} 여유` }
        : free >= MIN_DISK
          ? { id: "disk", label: "디스크 여유", status: "warn", detail: `${fmtBytes(free)} 여유 — 표준 구성은 약 ${fmtBytes(STANDARD_DISK)}, 저사양 구성은 약 ${fmtBytes(LITE_DISK)}가 필요합니다` }
          : { id: "disk", label: "디스크 여유", status: "blocked", detail: `${fmtBytes(free)} 여유 — 모델을 받을 공간이 없습니다` },
  );
  return rows;
}

function toolRows(report: DoctorReport | null): CheckupRow[] {
  const rows: CheckupRow[] = [];
  const r = report;
  if (r?.stale_saved?.length) rows.push({ id: "stale-paths", label: "저장된 경로", status: "info", detail: STALE_SAVED });
  const core = binView(r, "tractus");
  if (r && core && !core.found) {
    rows.push({ id: "core", label: "Tractus 엔진", status: "blocked", detail: `실행 파일을 찾지 못했습니다 (${core.path}). 설정에서 tractus 실행 파일 경로를 확인하세요.`, fix: fixFor("tractus", "pick", BROWSE) });
  } else if (r && core && !r.doctor && r.tractus_source === "bundle") {
    // 앱 안의 엔진이 안 돈다 = 앱이 손상된 것이라 '엔진이 오래됐다'가 아니다. 날것의 한 줄은 뒤에 붙인다
    rows.push({ id: "core", label: "Tractus 엔진", status: "blocked", detail: `Tractus 안의 엔진이 손상되었습니다. 앱을 다시 받아 설치하세요.${r.core_error ? ` (${r.core_error.split("\n")[0]})` : ""}` });
  } else if (r && core && !r.doctor) {
    rows.push({ id: "core", label: "Tractus 엔진", status: "warn", detail: `점검 정보를 읽지 못했습니다${r.core_error ? `: ${r.core_error.split("\n")[0]}` : ""}. 엔진이 오래되었을 수 있습니다.` });
  } else if (r && core) {
    rows.push({ id: "core", label: "Tractus 엔진", status: "ok", detail: `${core.path} — ${core.note}`, ...(core.custom && { fix: fixFor("tractus", "auto", REVERT_AUTO) }) });
  }
  const ff = r?.doctor?.tools.ffmpeg;
  if (ff) {
    const brewMissing = r?.doctor?.tools.brew && !r.doctor.tools.brew.found;
    rows.push(
      ff.found
        ? { id: "ffmpeg", label: "ffmpeg", status: "ok", detail: [ff.version, ff.path].filter(Boolean).join(" · ") || "설치됨" }
        : {
            id: "ffmpeg",
            label: "ffmpeg",
            status: "blocked",
            detail: `음성 파일을 읽는 데 필요합니다. 터미널에서 아래 명령으로 설치한 뒤 ‘다시 확인’을 누르세요.${brewMissing ? " Homebrew도 없습니다. https://brew.sh 안내를 먼저 따르세요." : ""}`,
            copy: BREW_FFMPEG,
          },
    );
  }
  const rec = binView(r, "rec");
  if (rec) {
    rows.push(
      rec.found
        ? { id: "recorder", label: "녹음 프로그램", status: "ok", detail: `${rec.path} — ${rec.note}`, ...(rec.custom && { fix: fixFor("rec", "auto", REVERT_AUTO) }) }
        : { id: "recorder", label: "녹음 프로그램", status: "blocked", detail: `tractus-rec를 찾지 못했습니다 (${rec.path}). 설정의 tractus-rec 실행 파일 경로를 확인하세요. 녹음 말고는 모두 쓸 수 있습니다.`, fix: fixFor("rec", "pick", BROWSE) },
    );
  }
  const helper = r?.doctor?.tools.diar_helper;
  if (helper) {
    rows.push(
      helper.found
        ? { id: "diar-helper", label: "9명 이상 구분 도구", status: "ok", detail: helper.path ?? "tractus-diar" }
        : { id: "diar-helper", label: "9명 이상 구분 도구", status: "info", detail: "tractus-diar가 없어 참석자를 최대 8명까지 구분합니다. 선택 사항입니다." },
    );
  }
  return rows;
}

/** 데이터 폴더: 동기화 폴더나 Obsidian 볼트 안이면 주의 (노트가 함께 동기화될 수 있다). 점검을 못 읽었으면 행이 없다 */
function dataRows(report: DoctorReport | null): CheckupRow[] {
  if (!report?.home) return [];
  const risk = report.home_risk;
  return [
    risk
      ? { id: "home", label: "데이터 폴더", status: "warn", detail: `${report.home} (${risk}) — ${HOME_RISK}`, fix: { kind: "pick-home", label: HOME_PICK } }
      : { id: "home", label: "데이터 폴더", status: "ok", detail: report.home },
  ];
}

const installed = (list: ModelRow[], id: string) => list.some((m) => m.id === id && m.installed);

/** 모델 상태: 목록(models list)이 있으면 그것을, 없으면 점검(doctor)의 요약을 쓴다 */
function modelRows(report: DoctorReport | null, models: ModelsList | null): CheckupRow[] {
  const list: ModelRow[] | null = models?.models ?? null;
  const fromDoctor = report?.doctor?.models;
  const has = (id: string) => (list ? installed(list, id) : !!fromDoctor?.some((m) => m.id === id && m.installed));
  if (!list && !fromDoctor?.length) return [unknown("models", "모델")];
  const rows: CheckupRow[] = [];
  const lack: string[] = [];
  if (!has("vad")) lack.push("목소리 구간 감지 파일");
  if (!has("asr-std") && !has("asr-lite")) lack.push("변환 엔진(표준·가벼운 것 중 하나)");
  rows.push(
    lack.length === 0
      ? { id: "required", label: "필수 모델", status: "ok", detail: "텍스트 변환에 필요한 모델이 모두 있습니다 (변환 엔진은 둘 중 하나면 됩니다)" }
      : { id: "required", label: "필수 모델", status: "blocked", detail: `${lack.join(", ")}이(가) 없어 텍스트로 변환할 수 없습니다. 녹음은 저장됩니다.`, fix: FIX_MODELS },
  );
  rows.push(
    has("diarizer")
      ? { id: "recommended", label: "권장 모델", status: "ok", detail: "참석자 구분 모델이 있습니다" }
      : { id: "recommended", label: "권장 모델", status: "warn", detail: "참석자 구분 모델이 없어 참석자를 나누지 못합니다. 텍스트 변환은 됩니다.", fix: FIX_MODELS },
  );
  const optional: [string, string][] = [
    ["aligner", "단어 싱크"],
    ["embedding", "스마트 검색"],
    ["voices", "목소리 등록"],
    ["fluid", "9명 이상 구분"],
  ];
  const lacking = optional.filter(([id]) => !has(id)).map(([, name]) => name);
  rows.push(
    lacking.length === 0
      ? { id: "optional", label: "선택 모델", status: "ok", detail: "선택 모델이 모두 있습니다" }
      : { id: "optional", label: "선택 모델", status: "info", detail: `없는 기능: ${lacking.join(", ")}. 필요할 때 설치하세요.`, fix: FIX_MODELS },
  );
  return rows;
}

const PERMISSION_ROWS: CheckupRow[] = [
  { id: "mic", label: "마이크", status: "info", detail: "처음 녹음할 때 macOS가 허락을 묻습니다. 앱이 미리 확인할 수는 없습니다. 거절했다면 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 Tractus를 켜세요." },
  {
    id: "system-audio",
    label: "시스템 오디오",
    status: "info",
    detail: "화상·하이브리드 녹음에서 상대방 소리를 받을 때 처음 한 번 묻습니다. 거절했다면 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 켜세요.",
  },
];

function aiRows(keySaved: boolean | null): CheckupRow[] {
  if (keySaved === null) return [{ id: "key", label: "API 키", status: "info", detail: "확인 중…" }];
  return [
    keySaved
      ? { id: "key", label: "API 키", status: "ok", detail: "API 키가 등록되어 있습니다" }
      : { id: "key", label: "API 키", status: "warn", detail: "키가 없으면 요약과 AI 질문을 쓸 수 없습니다. 텍스트 변환과 검색은 키 없이 됩니다.", fix: KEY_FIX },
  ];
}

export function checkupSections(o: { report: DoctorReport | null; models: ModelsList | null; keySaved: boolean | null }): CheckupSection[] {
  const data = dataRows(o.report);
  return [
    { id: "system", title: "시스템", rows: systemRows(o.report, o.models) },
    { id: "tools", title: "도구", rows: toolRows(o.report) },
    ...(data.length > 0 ? [{ id: "data" as const, title: "저장 위치", rows: data }] : []),
    { id: "models", title: "모델", rows: modelRows(o.report, o.models) },
    { id: "permissions", title: "권한 안내", rows: PERMISSION_ROWS },
    { id: "ai", title: "AI 요약·질문", rows: aiRows(o.keySaved) },
  ];
}

/** 점검 결과 한 줄: `사용할 수 없는 항목 2개 · 확인 필요 1개` / 모두 괜찮으면 `모두 괜찮습니다` */
export function checkupHeadline(sections: CheckupSection[]): string {
  const rows = sections.flatMap((s) => s.rows);
  const blocked = rows.filter((r) => r.status === "blocked").length;
  const warn = rows.filter((r) => r.status === "warn").length;
  const parts = [blocked > 0 && `사용할 수 없는 항목 ${blocked}개`, warn > 0 && `확인 필요 ${warn}개`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "모두 괜찮습니다";
}
