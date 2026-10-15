import { describe, expect, test } from "vitest";
import type { DoctorReport } from "./caps";
import { BREW_FFMPEG, checkupHeadline, checkupSections, macosAtLeast, type CheckupSection } from "./checkupRows";
import type { ModelRow, ModelsList } from "./models";

const tool = (found: boolean) => ({ found, path: found ? "/usr/bin/x" : null, version: found ? "7.1" : null });
const report = (over: { sys?: Partial<NonNullable<DoctorReport["doctor"]>["system"]>; ffmpeg?: boolean; helper?: boolean; brew?: boolean | null } = {}): DoctorReport => ({
  doctor: {
    system: { arch: "arm64", macos_version: "15.1", memory_gb: 32, meets_min: true, disk_free_bytes: 5e10, ...over.sys },
    tools: { ffmpeg: tool(over.ffmpeg ?? true), recorder: tool(true), diar_helper: tool(over.helper ?? false), brew: over.brew === undefined || over.brew === null ? null : tool(over.brew) },
    models: [],
    capabilities: [],
    recommended_track: null,
  },
  core_error: null,
  tractus_bin: "/repo/.venv/bin/tractus",
  tractus_bin_exists: true,
  rec_bin: "/repo/recorder/.build/release/tractus-rec",
  rec_bin_exists: true,
});
const m = (id: string, installed: boolean): ModelRow => ({ id, name: id, purpose: "", level: "optional", size_bytes: 1, installed, installed_bytes: installed ? 1 : 0, state: installed ? "installed" : "missing", needed_by: [], group: "" });
const list = (...installed: string[]): ModelsList => ({ models_dir: "/m", disk_free_bytes: 5e10, download_active: false, models: ["vad", "asr-std", "asr-lite", "diarizer", "aligner", "embedding", "voices", "fluid"].map((id) => m(id, installed.includes(id))) });
const rows = (s: CheckupSection[], id: string) => s.find((x) => x.id === id)!.rows;
const row = (s: CheckupSection[], id: string) => s.flatMap((x) => x.rows).find((r) => r.id === id)!;

describe("macosAtLeast", () => {
  test("14.4 이상", () => {
    expect(macosAtLeast("14.4")).toBe(true);
    expect(macosAtLeast("14.3.1")).toBe(false);
    expect(macosAtLeast("15")).toBe(true);
    expect(macosAtLeast("13.9")).toBe(false);
    expect(macosAtLeast("26.0.1")).toBe(true);
    expect(macosAtLeast("")).toBeNull();
    expect(macosAtLeast(null)).toBeNull();
  });
});

describe("checkupSections: 시스템", () => {
  const sys = (over: Parameters<typeof report>[0]) => checkupSections({ report: report(over), models: null, keySaved: true });
  test("모두 괜찮은 Mac", () => {
    const s = sys({});
    expect(rows(s, "system").map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });
  test("Intel Mac은 사용할 수 없다", () => {
    expect(row(sys({ sys: { arch: "x86_64" } }), "arch")).toMatchObject({ status: "blocked" });
  });
  test("macOS가 낮으면 사용할 수 없다", () => {
    expect(row(sys({ sys: { macos_version: "13.6" } }), "macos")).toMatchObject({ status: "blocked" });
  });
  test("메모리: 16 GB 미만은 저사양을 권하고, 8 GB 미만은 막는다", () => {
    expect(row(sys({ sys: { memory_gb: 8 } }), "memory")).toMatchObject({ status: "warn" });
    expect(row(sys({ sys: { memory_gb: 16 } }), "memory").status).toBe("ok");
    expect(row(sys({ sys: { memory_gb: 4 } }), "memory").status).toBe("blocked");
  });
  test("디스크: 목록의 여유가 점검의 값보다 먼저다", () => {
    const s = checkupSections({ report: report({ sys: { disk_free_bytes: 5e10 } }), models: { ...list(), disk_free_bytes: 2e9 }, keySaved: true });
    expect(row(s, "disk")).toMatchObject({ status: "warn" });
    expect(row(sys({ sys: { disk_free_bytes: 5e8 } }), "disk").status).toBe("blocked");
  });
  test("점검을 못 읽으면 한 줄로 알린다 (막지 않는다)", () => {
    const s = checkupSections({ report: null, models: null, keySaved: null });
    expect(rows(s, "system")).toHaveLength(1);
    expect(rows(s, "system")[0].status).toBe("warn");
  });
});

describe("checkupSections: 도구", () => {
  test("ffmpeg가 없으면 복사할 brew 명령과 함께 막힘", () => {
    const r = row(checkupSections({ report: report({ ffmpeg: false }), models: null, keySaved: true }), "ffmpeg");
    expect(r).toMatchObject({ status: "blocked", copy: BREW_FFMPEG });
  });
  test("Homebrew도 없으면 그 사실만 알린다", () => {
    const r = row(checkupSections({ report: report({ ffmpeg: false, brew: false }), models: null, keySaved: true }), "ffmpeg");
    expect(r.detail).toContain("Homebrew도 없습니다");
  });
  test("실행 파일 경로가 없으면 찾아보기로 안내한다", () => {
    const rep = { ...report(), tractus_bin_exists: false, rec_bin_exists: false };
    const s = checkupSections({ report: rep, models: null, keySaved: true });
    expect(row(s, "core")).toMatchObject({ status: "blocked", fix: { kind: "pick-tractus", label: "찾아보기…" } });
    expect(row(s, "recorder")).toMatchObject({ status: "blocked", fix: { kind: "pick-rec" } });
  });
  test("찾은 경로와 출처를 보여 주고, 직접 지정일 때만 자동으로 되돌리는 단추를 준다", () => {
    const auto = checkupSections({ report: { ...report(), tractus_source: "bundle", rec_source: "repo" }, models: null, keySaved: true });
    expect(row(auto, "core")).toMatchObject({ status: "ok", detail: "/repo/.venv/bin/tractus — 앱 안에서 찾았습니다" });
    expect(row(auto, "core").fix).toBeUndefined();
    const mine = checkupSections({ report: { ...report(), tractus_source: "custom", rec_source: "custom" }, models: null, keySaved: true });
    expect(row(mine, "core")).toMatchObject({ detail: expect.stringContaining("직접 지정한 경로"), fix: { kind: "auto-tractus", label: "자동으로 되돌리기" } });
    expect(row(mine, "recorder").fix).toMatchObject({ kind: "auto-rec" });
  });
  test("없어서 자동으로 되돌린 저장 경로가 있으면 한 줄로 알린다", () => {
    const s = checkupSections({ report: { ...report(), stale_saved: ["tractus_bin"] }, models: null, keySaved: true });
    expect(row(s, "stale-paths")).toMatchObject({ status: "info", detail: "저장된 경로가 없어 자동 경로를 씁니다" });
    expect(checkupSections({ report: report(), models: null, keySaved: true }).flatMap((x) => x.rows).some((r) => r.id === "stale-paths")).toBe(false);
  });
  test("데이터 폴더: 동기화 폴더·Obsidian 볼트면 경고와 폴더 바꾸기, 아니면 문제 없음, 점검을 못 읽으면 행이 없다", () => {
    const at = (home: string, home_risk: string | null) => row(checkupSections({ report: { ...report(), home, home_risk }, models: null, keySaved: true }), "home");
    expect(at("/Users/me/Tractus", null)).toMatchObject({ status: "ok", detail: "/Users/me/Tractus", label: "데이터 폴더" });
    expect(at("/Users/me/Dropbox/Tractus", "Dropbox")).toMatchObject({ status: "warn", detail: expect.stringContaining("Obsidian 볼트일 수 있습니다"), fix: { kind: "pick-home", label: "폴더 바꾸기…" } });
    expect(checkupSections({ report: report(), models: null, keySaved: true }).some((x) => x.id === "data")).toBe(false);
  });
  test("엔진은 있는데 점검을 못 읽으면(옛 코어) 경고", () => {
    const rep: DoctorReport = { ...report(), doctor: null, core_error: "No such command 'doctor'\nusage" };
    const r = row(checkupSections({ report: rep, models: null, keySaved: true }), "core");
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("No such command");
    expect(r.detail).not.toContain("usage");
  });
  test("앱 안의 엔진이 안 돌면 '앱이 손상됐다'고 막는다 (엔진이 오래된 것이 아니다)", () => {
    const rep: DoctorReport = { ...report(), doctor: null, tractus_source: "bundle", core_error: "dyld: Library not loaded\ndetail" };
    const r = row(checkupSections({ report: rep, models: null, keySaved: true }), "core");
    expect(r.status).toBe("blocked");
    expect(r.detail).toContain("앱을 다시 받아 설치하세요");
    expect(r.detail).toContain("dyld: Library not loaded");
    expect(r.detail).not.toContain("detail");
  });
  test("9명 이상 구분 도구는 없어도 안내일 뿐이다", () => {
    expect(row(checkupSections({ report: report(), models: null, keySaved: true }), "diar-helper").status).toBe("info");
    expect(row(checkupSections({ report: report({ helper: true }), models: null, keySaved: true }), "diar-helper").status).toBe("ok");
  });
});

describe("checkupSections: 모델·권한·AI", () => {
  const sec = (l: ModelsList | null, key: boolean | null = true) => checkupSections({ report: report(), models: l, keySaved: key });
  test("필수 모델이 없으면 막힘 + 모델 화면, 있으면 문제 없음", () => {
    expect(row(sec(list()), "required")).toMatchObject({ status: "blocked", fix: { kind: "models" } });
    expect(row(sec(list("vad")), "required").detail).toContain("변환 엔진");
    expect(row(sec(list("asr-lite")), "required").detail).toContain("목소리 구간 감지");
    expect(row(sec(list("vad", "asr-lite")), "required").status).toBe("ok");
    expect(row(sec(list("vad", "asr-std")), "required").status).toBe("ok"); // 엔진은 둘 중 하나면 된다
    expect(row(sec(list("vad")), "required").detail).toContain("표준·가벼운 것 중 하나");
  });
  test("권장: 참석자 구분이 없으면 경고", () => {
    expect(row(sec(list("vad", "asr-std")), "recommended").status).toBe("warn");
    expect(row(sec(list("vad", "asr-std", "diarizer")), "recommended").status).toBe("ok");
  });
  test("선택: 없는 기능 이름을 나열한다", () => {
    const r = row(sec(list("vad", "asr-std", "aligner")), "optional");
    expect(r.status).toBe("info");
    expect(r.detail).toContain("스마트 검색");
    expect(r.detail).not.toContain("단어 싱크");
  });
  test("목록이 없으면 점검의 모델 요약을 쓴다", () => {
    const rep = report();
    rep.doctor!.models = [{ id: "vad", state: "installed", installed: true }, { id: "asr-std", state: "installed", installed: true }];
    expect(row(checkupSections({ report: rep, models: null, keySaved: true }), "required").status).toBe("ok");
    expect(row(checkupSections({ report: report(), models: null, keySaved: true }), "models").status).toBe("warn");
  });
  test("권한은 안내뿐이다 (앱이 미리 확인할 수 없다)", () => {
    expect(rows(sec(null), "permissions").map((r) => r.status)).toEqual(["info", "info"]);
  });
  test("API 키: 있음 / 없음(설정으로) / 확인 중", () => {
    expect(rows(sec(null, true), "ai")[0].status).toBe("ok");
    expect(rows(sec(null, false), "ai")[0]).toMatchObject({ status: "warn", fix: { kind: "settings" } });
    expect(rows(sec(null, null), "ai")[0].status).toBe("info");
  });
});

describe("checkupHeadline", () => {
  test("막힌 항목과 확인 필요 항목을 센다", () => {
    expect(checkupHeadline(checkupSections({ report: report({ ffmpeg: false }), models: list(), keySaved: false }))).toBe("사용할 수 없는 항목 2개 · 확인 필요 2개");
  });
  test("문제가 없으면 모두 괜찮다고 한다", () => {
    expect(checkupHeadline(checkupSections({ report: report(), models: list("vad", "asr-std", "diarizer", "aligner", "embedding", "voices", "fluid"), keySaved: true }))).toBe("모두 괜찮습니다");
  });
});
