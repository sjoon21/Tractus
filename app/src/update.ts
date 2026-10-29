// 설정 › 업데이트 (v3.34, WORDS.md §4.21): 상태·문구의 순수 로직. 플러그인 호출(check·downloadAndInstall·relaunch)은 SettingsView·App이 하고 여기는 부르지 않는다.
// 자동 설치는 없다: 앱 시작 약 10초 뒤와 `업데이트 확인` 단추에서만 확인하고, `업데이트 설치`를 누른 뒤에만 받아 설치한다. 설정 파일에 남기는 값은 없다.
import type { Update } from "@tauri-apps/plugin-updater";
import { t } from "./i18n";

/** 시작 확인까지 기다리는 시간. 첫 화면·점검이 먼저 그려지게 */
export const START_DELAY_MS = 10_000;

export const CHECK_LABEL = t("업데이트 확인");
export const INSTALL_LABEL = t("업데이트 설치");
export const RELAUNCH_LABEL = t("다시 열기");
export const OPEN_SETTINGS_LABEL = t("설정 열기");
/** 녹음·변환 중에는 `다시 열기`를 잠근다: relaunch는 종료 확인(begin_quit·onCloseRequested)을 거치지 않고 바로 끝나 변환이 끊긴다 */
export const RELAUNCH_WAIT = t("녹음·변환이 끝난 뒤 누르세요.");
/** 저장소에서 install.sh로 만든 앱·개발 실행에서는 확인하지 않는다 */
export const REPO_NOTE = t("저장소에서 만든 앱은 scripts/update.sh로 업데이트합니다.");
export const UPDATE_HINT = t("‘업데이트 설치’를 누를 때만 받습니다(약 240 MB).");

/** 릴리스 노트(소개 사이트의 버전 페이지)를 여는 링크. 앱 안에는 노트 앞부분만 보이므로 전체는 웹에서 본다 */
export const NOTES_LABEL = t("릴리스 노트 보기");

/** 링크가 가리킬 버전: 새 버전을 찾았으면 그 버전, 아니면 지금 버전 */
export function notesVersion(s: UpdateState, current: string | null): string | null {
  return s.phase === "found" || s.phase === "downloading" || s.phase === "installed" ? s.version : current;
}

export const versionLine = (v: string | null): string => (v ? t("지금 버전 {version}", { version: v }) : t("지금 버전을 읽는 중…"));
/** 시작 때 확인에서 새 버전이 있을 때의 작은 알림: 그 버전의 큰 창을 이미 닫았거나, 녹음 중이거나 다른 창이 열려 있을 때 */
export const newVersionToast = (version: string): string => t("새 버전이 있습니다: {version}", { version });

/** 시작 때 큰 창 (버전마다 한 번). 조사가 어긋나지 않게 버전 뒤에 조사를 붙이지 않는다 */
export const NEW_VERSION_DIALOG = {
  title: (version: string) => t("새 버전이 나왔습니다: {version}", { version }),
  body: t("무엇이 바뀌었는지 확인해 보세요. 설정에서 ‘업데이트 설치’를 누를 때만 받아 설치합니다."),
  open: t("업데이트 보기"),
  later: t("나중에"),
};

/** 설정 화면의 업데이트 절 id (시작 때 창·알림에서 그 절로 내려간다) */
export const UPDATE_SECTION_ID = "settings-update";

/** 큰 창을 닫은 버전 (이 창의 localStorage). 막히거나 비면 큰 창이 다시 보일 뿐이다 */
export const SEEN_KEY = "tractus.update.seen";

/** 시작 때 찾은 새 버전을 어떻게 알릴지: 처음 보는 버전이고 한가하면 큰 창, 아니면 작은 알림 (busy: 녹음 중·녹음 화면·다른 모달) */
export function updateNotice(version: string | null, seen: string | null, busy: boolean): "dialog" | "toast" | null {
  if (!version) return null;
  return busy || seen === version ? "toast" : "dialog";
}

type Store = Pick<Storage, "getItem" | "setItem">;
const localStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function seenVersion(store: Store | null = localStore()): string | null {
  try {
    return store?.getItem(SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function markSeen(version: string, store: Store | null = localStore()): void {
  try {
    store?.setItem(SEEN_KEY, version);
  } catch {
    // 저장하지 못하면 다음 실행에 큰 창이 다시 보인다
  }
}

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "found"; version: string; notes: string | null }
  | { phase: "downloading"; version: string; done: number; total: number | null }
  | { phase: "installed"; version: string }
  | { phase: "error"; text: string; detail: string | null };

export const IDLE_UPDATE: UpdateState = { phase: "idle" };

/** 플러그인의 다운로드 이벤트 (Update.downloadAndInstall의 콜백) */
export type DownloadEvent = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };

export type UpdateEvent =
  | { type: "check" }
  | { type: "latest" }
  | { type: "found"; version: string; body?: string | null }
  | { type: "install" }
  | { type: "download"; event: DownloadEvent }
  | { type: "installed" }
  | { type: "fail"; error: unknown };

export function updateReduce(s: UpdateState, ev: UpdateEvent): UpdateState {
  switch (ev.type) {
    case "check":
      return { phase: "checking" };
    case "latest":
      return { phase: "latest" };
    case "found":
      return { phase: "found", version: ev.version, notes: noteExcerpt(ev.body) };
    case "install":
      return s.phase === "found" ? { phase: "downloading", version: s.version, done: 0, total: null } : s;
    case "download": {
      if (s.phase !== "downloading") return s;
      const e = ev.event;
      if (e.event === "Started") return { ...s, total: e.data.contentLength ?? null };
      if (e.event === "Progress") return { ...s, done: s.done + e.data.chunkLength };
      return s.total === null ? s : { ...s, done: s.total };
    }
    case "installed":
      return s.phase === "downloading" || s.phase === "found" ? { phase: "installed", version: s.version } : s;
    case "fail":
      return { phase: "error", ...updateErrorView(ev.error, s.phase) };
  }
}

const NOTE_LINES = 3;
const NOTE_CHARS = 200;

/** 릴리스 노트 일부: 빈 줄을 뺀 앞 3줄, 200자까지. 잘렸으면 `…`. 없거나 비면 null */
export function noteExcerpt(body: string | null | undefined): string | null {
  const lines = (body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const text = lines.slice(0, NOTE_LINES).join("\n");
  const cut = lines.length > NOTE_LINES || text.length > NOTE_CHARS;
  return cut ? `${text.slice(0, NOTE_CHARS).trimEnd()}…` : text;
}

/** 0–100. 전체 크기를 모르면 null. 받은 양이 전체를 넘어도 100 */
export function progressPct(done: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.floor((done / total) * 100));
}

/** 상태 줄 문구 (idle은 null) */
export function updateText(s: UpdateState): string | null {
  switch (s.phase) {
    case "idle":
      return null;
    case "checking":
      return t("확인 중…");
    case "latest":
      return t("최신입니다.");
    case "found":
      return t("새 버전 {version}", { version: s.version });
    case "downloading": {
      const pct = progressPct(s.done, s.total);
      return pct === null ? t("받는 중…") : t("받는 중 {pct}%", { pct });
    }
    case "installed":
      return t("설치가 끝났습니다. 다시 열면 새 버전으로 시작합니다.");
    case "error":
      return s.text;
  }
}

const CONNECTION_TEXT = t("업데이트 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
const SIGNATURE_TEXT = t("받은 파일의 서명이 맞지 않아 설치하지 않았습니다. 다시 받아 보세요.");
const CHECK_FAILED = t("업데이트를 확인하지 못했습니다.");
const INSTALL_FAILED = t("업데이트를 설치하지 못했습니다.");

/** 플러그인 오류 → 첫 줄 문장 + 원래 문구(자세히). 어느 단계에서 났는지로 기본 문장을 고른다 (WORDS.md §4.7 규칙) */
export function updateErrorView(error: unknown, phase: UpdateState["phase"]): { text: string; detail: string | null } {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const lower = raw.toLowerCase();
  const detail = raw.trim() || null;
  if (/signature|minisign|pubkey|public key/.test(lower)) return { text: SIGNATURE_TEXT, detail };
  if (/request|network|connect|timed? ?out|dns|fetch|resolve/.test(lower)) return { text: CONNECTION_TEXT, detail };
  return { text: phase === "downloading" || phase === "installed" ? INSTALL_FAILED : CHECK_FAILED, detail };
}

/** 설정 화면을 떠났다 돌아와도 상태와 받을 준비가 된 Update가 남게 모듈에 둔다 (받는 중에 화면을 옮겨도 `다시 열기`를 잃지 않는다). 앱을 끄면 사라진다 */
export const remembered: { state: UpdateState; update: Update | null } = { state: IDLE_UPDATE, update: null };
