// 코어(tractus)·녹음 프로그램(tractus-rec) 경로의 "자동 / 직접 지정" 순수 로직 (docs/desktop.md §3.4, WORDS.md §4.19).
// 설정에서 경로가 비어 있으면 자동이다: Rust(paths.rs)가 실행할 때마다 찾고, 화면은 찾은 경로와 출처만 보여 준다.
import type { DoctorReport, FixKind } from "./caps";
import type { Settings } from "./api";

export type BinKind = "tractus" | "rec";

export const BIN_FIELD = { tractus: "tractus_bin", rec: "rec_bin" } as const;
export const BIN_LABEL: Record<BinKind, string> = { tractus: "tractus 실행 파일", rec: "tractus-rec 실행 파일" };
const BIN_ENV: Record<BinKind, string> = { tractus: "TRACTUS_BIN", rec: "TRACTUS_REC_BIN" };

export const AUTO_BADGE = "자동";
export const CUSTOM_BADGE = "직접 지정";
export const PICK_CUSTOM = "직접 지정";
export const BROWSE = "찾아보기…";
export const REVERT_AUTO = "자동으로 되돌리기";
export const FULL_PATH_HINT = "전체 경로로 적습니다 (앱은 터미널의 PATH를 읽지 않습니다)";
export const CHECKING = "확인 중…";
export const HOME_MOVED = "데이터 폴더를 바꿨습니다. 노트는 옮겨지지 않으니 새 폴더로 직접 옮긴 뒤 앱을 다시 시작하세요.";
export const HOME_PICK = "폴더 바꾸기…";

export interface BinView {
  /** 지금 쓰는 경로 (못 찾았으면 안내용 경로) */
  path: string;
  found: boolean;
  /** 직접 지정한 경로를 쓰는 중 */
  custom: boolean;
  /** 어디서 찾았는지 한 줄 */
  note: string;
}

const NOTE: Record<string, string> = {
  custom: "직접 지정한 경로입니다",
  bundle: "앱 안에서 찾았습니다",
  repo: "빌드한 저장소에서 찾았습니다",
  known: "설치된 위치에서 찾았습니다",
  none: "찾지 못했습니다",
};

/** 점검 결과에서 한 실행 파일의 경로·출처를 읽는다. 점검을 못 읽었으면 null (화면은 `확인 중…`) */
export function binView(report: DoctorReport | null | undefined, kind: BinKind): BinView | null {
  if (!report) return null;
  const [path, found, source] = kind === "tractus" ? [report.tractus_bin, report.tractus_bin_exists, report.tractus_source] : [report.rec_bin, report.rec_bin_exists, report.rec_source];
  const src = source ?? (found ? "known" : "none"); // 옛 앱은 출처를 보내지 않는다
  return { path, found, custom: src === "custom", note: src === "env" ? `환경변수 ${BIN_ENV[kind]}에서 찾았습니다` : (NOTE[src] ?? NOTE.known) };
}

/** 시작 점검의 고치는 단추가 설정에 쓸 값. 파일·폴더를 고르다 취소했으면(picked null) 아무것도 쓰지 않는다 */
export function fixPatch(kind: FixKind, picked: string | null): Partial<Settings> | null {
  switch (kind) {
    case "pick-tractus":
      return picked ? { tractus_bin: picked } : null;
    case "pick-rec":
      return picked ? { rec_bin: picked } : null;
    case "auto-tractus":
      return { tractus_bin: "" };
    case "auto-rec":
      return { rec_bin: "" };
    case "pick-home":
      return picked ? { home: picked } : null;
    default:
      return null;
  }
}

/** 이 고치는 단추는 앱 안에서 파일·폴더를 골라 처리한다 (다른 화면으로 가지 않는다) */
export const isPathFix = (kind: FixKind): boolean => kind.startsWith("pick-") || kind.startsWith("auto-");
export const needsFolder = (kind: FixKind): boolean => kind === "pick-home";
export const needsPick = (kind: FixKind): boolean => kind.startsWith("pick-");
