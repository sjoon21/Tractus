import { describe, expect, test } from "vitest";
import {
  DISK_MARGIN,
  diskShort,
  downloadErrorView,
  downloadReduce,
  fmtBytes,
  IDLE_DOWNLOAD,
  engineSummary,
  installedSummary,
  levelLabel,
  movable,
  moveDialog,
  moveDone,
  pruneDialog,
  pruneDone,
  pruneLabel,
  unregisteredSummary,
  installLabel,
  modelDetailRows,
  modelSubtitle,
  overallFraction,
  planOf,
  planSize,
  presetIds,
  progressLine,
  removeDialog,
  toInstall,
  corruptIn,
  type DownloadState,
  type ModelRow,
  type ModelsEvent,
  engineInUse,
  validRepo,
} from "./models";

const row = (id: string, over: Partial<ModelRow> = {}): ModelRow => ({
  id,
  name: id.toUpperCase(),
  purpose: "",
  level: "optional",
  size_bytes: 1e9,
  installed: false,
  installed_bytes: 0,
  state: "missing",
  needed_by: [],
  group: "",
  ...over,
});
const ALL = ["vad", "asr-std", "asr-lite", "diarizer", "aligner", "embedding", "voices", "fluid"].map((id) => row(id));
const withInstalled = (...ids: string[]) => ALL.map((m) => (ids.includes(m.id) ? { ...m, installed: true, state: "installed" as const } : m));

describe("fmtBytes", () => {
  test("Finder처럼 1000 단위", () => {
    expect(fmtBytes(1.3e6)).toBe("1.3 MB");
    expect(fmtBytes(2.3e9)).toBe("2.3 GB");
    expect(fmtBytes(189e6)).toBe("189 MB");
    expect(fmtBytes(12e9)).toBe("12 GB");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(-1)).toBe("—");
  });
});

describe("presetIds", () => {
  test("필수만: 구간 분석 + 메모리에 맞는 변환 엔진 하나", () => {
    expect(presetIds("required", ALL, "asr-std")).toEqual(["vad", "asr-std"]);
    expect(presetIds("required", ALL, "asr-lite")).toEqual(["vad", "asr-lite"]);
    expect(presetIds("required", ALL, null)).toEqual(["vad", "asr-std"]);
  });
  test("필수만: 변환 엔진이 이미 있으면 새로 받지 않는다", () => {
    expect(presetIds("required", withInstalled("asr-lite"), "asr-std")).toEqual(["vad"]);
  });
  test("표준: 필수 + 1.7B + 참석자 구분·단어 싱크·스마트 검색·목소리 (작은 엔진·9명 도구는 넣지 않는다)", () => {
    const ids = presetIds("standard", ALL, "asr-std");
    expect(ids).toEqual(["vad", "asr-std", "diarizer", "aligner", "embedding", "voices"]);
    expect(ids).not.toContain("asr-lite");
    expect(ids).not.toContain("fluid");
  });
  test("표준: 저사양을 권하는 Mac이면 필수의 작은 엔진이 더해진다", () => {
    expect(presetIds("standard", ALL, "lite")).toEqual(["vad", "asr-lite", "asr-std", "diarizer", "aligner", "embedding", "voices"]);
  });
  test("저사양: 구간 분석 + 0.6B + 참석자 구분", () => {
    expect(presetIds("lite", ALL, "asr-std")).toEqual(["vad", "asr-lite", "diarizer"]);
  });
});

describe("받을 것 계산", () => {
  test("toInstall: 설치된 것과 코어가 모르는 ID는 뺀다. 일부만 받은 것·손상은 다시 받는다", () => {
    const models = [row("a", { installed: true, state: "installed" }), row("b", { state: "partial" }), row("c", { state: "corrupt" }), row("d")];
    expect(toInstall(["a", "b", "c", "d", "zzz"], models)).toEqual(["b", "c", "d"]);
  });
  test("corruptIn: 구성에서 손상된 것만 골라 먼저 지운다 (코어는 손상된 모델 받기를 거부한다)", () => {
    const models = [row("a", { state: "partial" }), row("c", { state: "corrupt" }), row("d")];
    expect(corruptIn(["a", "c", "d", "zzz"], models)).toEqual(["c"]);
  });
  test("planOf·planSize", () => {
    const plan = planOf(["vad", "asr-std", "nope"], [row("vad", { size_bytes: 1.3e6 }), row("asr-std", { size_bytes: 2.3e9 })]);
    expect(plan.map((p) => p.id)).toEqual(["vad", "asr-std"]);
    expect(planSize(plan)).toBe(1.3e6 + 2.3e9);
  });
  test("diskShort: 용량×1.1보다 여유가 적으면 알린다. 여유를 모르면 막지 않는다", () => {
    const plan = [{ id: "a", name: "A", size: 1e9 }];
    expect(diskShort(plan, 1e9 * DISK_MARGIN)).toBeNull();
    expect(diskShort(plan, 1.09e9)).toContain("디스크 여유 공간이 부족합니다");
    expect(diskShort(plan, null)).toBeNull();
    expect(diskShort([], 0)).toBeNull();
  });
  test("구분 글자: 변환 엔진은 `필수 (엔진 중 하나)`, 나머지는 그대로", () => {
    const eng = (id: string, installed = false) => row(id, { level: "required", level_note: "one_of", installed });
    expect(levelLabel(eng("asr-std"))).toBe("필수 (엔진 중 하나)");
    expect(levelLabel(row("vad", { level: "required" }))).toBe("필수");
    expect(levelLabel(row("vad", { level: "required", level_note: null }))).toBe("필수"); // 옛 코어
    expect(levelLabel(row("aligner", { level: "optional" }))).toBe("선택");
  });
  test("필수 요약 줄: 변환 엔진 중 하나라도 있으면 설치됨, 모두 없으면 안내, 옛 코어는 줄 없음", () => {
    const eng = (id: string, installed: boolean) => row(id, { level: "required", level_note: "one_of", installed });
    expect(engineSummary([row("vad", { level: "required" }), eng("asr-std", false), eng("asr-lite", true)])).toEqual({ ok: true, text: "변환 엔진: 설치됨" });
    expect(engineSummary([eng("asr-std", true), eng("asr-lite", false)])?.ok).toBe(true);
    expect(engineSummary([eng("asr-std", false), eng("asr-lite", false)])).toEqual({ ok: false, text: "변환 엔진: 없음 — 하나 이상 설치하세요" });
    expect(engineSummary([row("vad", { level: "required", installed: true })])).toBeNull();
  });
  test("installLabel·installedSummary·removeDialog", () => {
    expect(installLabel("missing")).toBe("받기");
    expect(installLabel("partial")).toBe("이어 받기");
    expect(installLabel("corrupt")).toBe("다시 받기");
    expect(installedSummary(withInstalled("vad", "asr-std").map((m) => ({ ...m, installed_bytes: m.installed ? 100 : 0 })))).toEqual({ installed: 2, total: 8, bytes: 200 });
    const d = removeDialog({ name: "단어 싱크", installed_bytes: 1.2e9, needed_by: ["align"] });
    expect(d.title).toBe("‘단어 싱크’을(를) 삭제할까요?");
    expect(d.body).toContain("1.2 GB");
    expect(d.body).toContain("단어 싱크 기능을 다시 설치할 때까지 쓸 수 없습니다");
  });
});

describe("downloadReduce", () => {
  const plan = [
    { id: "vad", name: "VAD", size: 1_000 },
    { id: "asr-std", name: "ASR", size: 9_000 },
  ];
  const run = (events: ModelsEvent[], start: DownloadState = downloadReduce(IDLE_DOWNLOAD, { type: "start", plan })) =>
    events.reduce((s, ev) => downloadReduce(s, { type: "event", ev }), start);

  test("시작하면 첫 모델을 받는 중으로 본다", () => {
    const s = downloadReduce(IDLE_DOWNLOAD, { type: "start", plan });
    expect(s).toMatchObject({ running: true, model: "vad", done: 0 });
  });
  test("진행: 받은 바이트·파일·전체 진행률이 모델이 바뀌어도 이어진다", () => {
    let s = run([{ event: "progress", model: "vad", file: "weights.safetensors", done: 500, total: 1000 }]);
    expect(s).toMatchObject({ model: "vad", file: "weights.safetensors", done: 500, total: 1000 });
    expect(overallFraction(s)).toBeCloseTo(0.05);
    s = run([{ event: "model_done", model: "vad" }, { event: "progress", model: "asr-std", done: 4500, total: 9000 }], s);
    expect(s.finished).toEqual(["vad"]);
    expect(overallFraction(s)).toBeCloseTo((1000 + 4500) / 10000);
    expect(progressLine(s)).toBe("ASR 받는 중… 5 KB / 9 KB (2/2)");
  });
  test("코어가 실제로 내는 이벤트(stage → progress → model_done → done)를 그대로 따라간다", () => {
    const s = run([
      { event: "stage", stage: "download", model: "vad", index: 1, count: 2, size_bytes: 1000 } as ModelsEvent,
      { event: "progress", model: "vad", file: "model.safetensors", bytes_done: 400, bytes_total: 1000, overall_done: 400, overall_total: 10000 },
      { event: "model_done", model: "vad" },
      { event: "stage", stage: "download", model: "asr-std", index: 2, count: 2, size_bytes: 9000 } as ModelsEvent,
      { event: "progress", model: "asr-std", file: "model.safetensors", bytes_done: 1500, bytes_total: 9000, overall_done: 2500, overall_total: 10000 },
    ]);
    expect(s).toMatchObject({ model: "asr-std", done: 1500, total: 9000, finished: ["vad"], running: true });
    expect(overallFraction(s)).toBeCloseTo(0.25); // 코어가 알린 전체 진행률이 먼저다
    const end = run([{ event: "model_done", model: "asr-std" }, { event: "done" }, { event: "exit", code: 0 }], s);
    expect(end).toMatchObject({ running: false, completed: true, finished: ["vad", "asr-std"] });
  });
  test("stage만 와도 그 모델의 전체 크기를 안다", () => {
    expect(run([{ event: "stage", model: "asr-std", size_bytes: 9000 }])).toMatchObject({ model: "asr-std", total: 9000, done: 0 });
  });
  test("코어가 cancelled를 알리고 종료 코드 130으로 끝나면 오류가 아니라 멈춤이다", () => {
    const s = run([{ event: "cancelled" }, { event: "exit", code: 130 }]);
    expect(s).toMatchObject({ running: false, stopped: true, error: null, completed: false });
  });
  test("다른 이름의 키(bytes_done·id)도 읽는다", () => {
    const s = run([{ event: "progress", id: "asr-std", bytes_done: 10, bytes_total: 20 }]);
    expect(s).toMatchObject({ model: "asr-std", done: 10, total: 20 });
  });
  test("모르는 이벤트는 무시한다", () => {
    const s0 = downloadReduce(IDLE_DOWNLOAD, { type: "start", plan });
    expect(run([{ event: "whatever" }], s0)).toEqual(s0);
  });
  test("끝: done + exit 0 → 완료", () => {
    const s = run([{ event: "done" }, { event: "exit", code: 0 }]);
    expect(s).toMatchObject({ running: false, completed: true, error: null, stopped: false });
  });
  test("exit 0만 와도 완료로 본다", () => {
    expect(run([{ event: "exit", code: 0 }])).toMatchObject({ running: false, completed: true });
  });
  test("오류 이벤트: 코드·메시지·모델을 남기고 exit 뒤에도 오류다", () => {
    const s = run([
      { event: "progress", model: "asr-std", done: 1, total: 9 },
      { event: "error", code: "disk_full", message: "no space", model: "asr-std" },
      { event: "exit", code: 1, stderr: "" },
    ]);
    expect(s).toMatchObject({ running: false, completed: false, error: { code: "disk_full", message: "no space", model: "asr-std" } });
  });
  test("이벤트 없이 죽으면(신호로 끝남) 오류로 본다", () => {
    const s = run([{ event: "exit", code: undefined, stderr: "Killed" }]);
    expect(s.error).toEqual({ code: null, message: "Killed", model: "vad" });
  });
  test("멈추기: 끝나면 오류가 아니라 '멈췄다'", () => {
    let s = downloadReduce(downloadReduce(IDLE_DOWNLOAD, { type: "start", plan }), { type: "cancel" });
    expect(s.cancelling).toBe(true);
    expect(progressLine(s)).toBe("멈추는 중…");
    s = run([{ event: "exit", code: undefined }], s);
    expect(s).toMatchObject({ running: false, stopped: true, error: null, completed: false });
  });
  test("멈추기는 받는 중이 아니면 아무 일도 없다", () => {
    expect(downloadReduce(IDLE_DOWNLOAD, { type: "cancel" })).toBe(IDLE_DOWNLOAD);
  });
  test("경고는 쌓인다", () => {
    const s = run([{ event: "warning", code: "x", message: "m" }]);
    expect(s.warnings).toEqual([{ code: "x", message: "m" }]);
  });
  test("시작하지 못한 오류(실행 파일 경로 등)는 앱 오류로 보인다", () => {
    const s = downloadReduce(downloadReduce(IDLE_DOWNLOAD, { type: "start", plan }), { type: "failed", message: "Tractus 엔진을 실행할 수 없습니다\nENOENT" });
    expect(s.running).toBe(false);
    expect(downloadErrorView(s.error!)).toEqual({ text: "Tractus 엔진을 실행할 수 없습니다", detail: "ENOENT" });
  });
  test("계획이 없으면 지금 모델의 비율만, 그도 모르면 null", () => {
    expect(overallFraction({ ...IDLE_DOWNLOAD, done: 5, total: 10 })).toBe(0.5);
    expect(overallFraction(IDLE_DOWNLOAD)).toBeNull();
  });
});

describe("downloadErrorView: 코드 → 문장 (WORDS.md §4.14)", () => {
  test.each(["no_network", "disk_full", "auth", "hash_mismatch", "helper_missing", "busy", "corrupt", "unsafe_path"])("%s", (code) => {
    const v = downloadErrorView({ code, message: "원래 문구", model: null });
    expect(v.text).not.toBe("모델을 받지 못했습니다");
    expect(v.detail).toBe("원래 문구");
  });
  test("모르는 코드·코드 없음은 기본 문장 + 자세히", () => {
    expect(downloadErrorView({ code: "unknown", message: "boom", model: null })).toEqual({ text: "모델을 받지 못했습니다", detail: "boom" });
    expect(downloadErrorView({ code: null, message: "", model: null })).toEqual({ text: "모델을 받지 못했습니다", detail: null });
  });
});

describe("모델 소개: 한 줄과 자세히 (WORDS.md §4.15)", () => {
  const full = row("asr-std", {
    size_bytes: 2_463_000_000,
    model_name: "Qwen3-ASR 1.7B (8bit 양자화)",
    publisher: "Alibaba Qwen 팀",
    converted_by: "mlx-community (MLX 변환본)",
    source: "mlx-community/Qwen3-ASR-1.7B-8bit",
    revision: "a8379a2e2f9e313c9292cdf1af4055ab56d50d55",
    license: "Apache-2.0",
    languages: "한국어·영어 등 30개 언어와 중국어 방언 22개",
    params: "1.7B",
  });

  test("이름 아래 한 줄은 모델 이름 · 만든 곳", () => {
    expect(modelSubtitle(full)).toBe("Qwen3-ASR 1.7B (8bit 양자화) · Alibaba Qwen 팀");
    expect(modelSubtitle({ model_name: "Qwen3-Embedding 0.6B", publisher: null })).toBe("Qwen3-Embedding 0.6B");
    expect(modelSubtitle({ model_name: "  ", publisher: "NVIDIA" })).toBe("NVIDIA");
  });

  test("옛 코어(소개 키 없음)는 한 줄도 자세히도 없다", () => {
    expect(modelSubtitle(row("vad"))).toBeNull();
    expect(modelDetailRows(row("vad"))).toEqual([]);
    expect(modelDetailRows(row("vad", { model_name: null, publisher: "", source: null }))).toEqual([]);
  });

  test("자세히 줄: 순서·버전 앞 8자(전체는 title)·크기는 마지막", () => {
    const rows = modelDetailRows(full);
    expect(rows.map((r) => r.label)).toEqual(["모델 이름", "만든 곳", "변환한 곳", "내려받는 곳", "버전", "라이선스", "지원 언어", "규모", "크기"]);
    const rev = rows.find((r) => r.label === "버전");
    expect(rev).toEqual({ label: "버전", value: "a8379a2e", title: "a8379a2e2f9e313c9292cdf1af4055ab56d50d55" });
    expect(rows.find((r) => r.label === "내려받는 곳")?.value).toBe("mlx-community/Qwen3-ASR-1.7B-8bit");
    expect(rows.at(-1)).toEqual({ label: "크기", value: "2.5 GB" });
  });

  test("모르는 값은 줄을 뺀다 (변환한 곳·언어·버전·규모가 없는 모델)", () => {
    const rows = modelDetailRows(row("embedding", { size_bytes: 1_191_000_000, model_name: "Qwen3-Embedding 0.6B", publisher: "Alibaba Qwen 팀", source: "Qwen/Qwen3-Embedding-0.6B", license: "Apache-2.0", converted_by: null, languages: null, revision: null }));
    expect(rows.map((r) => r.label)).toEqual(["모델 이름", "만든 곳", "내려받는 곳", "라이선스", "크기"]);
  });
});

describe("모델 폴더: 위치 바꾸기·정리", () => {
  const row = (state: "installed" | "missing" | "partial", installed_bytes: number) => ({ state, installed_bytes });
  test("사용하지 않는 폴더: 없거나 옛 코어면 숨긴다, 있으면 개수와 크기", () => {
    expect(unregisteredSummary(null)).toBeNull();
    expect(unregisteredSummary({})).toBeNull();
    expect(unregisteredSummary({ unregistered: [] })).toBeNull();
    // 읽을 수 없는 항목은 건너뛰고, 크기가 이상하면 0으로 본다
    const s = unregisteredSummary({ unregistered: [{ name: "old-vad", bytes: 1_500_000 }, { name: "x", bytes: -1 }, { bytes: 9 } as never, null as never] });
    expect(s).toEqual({ count: 2, bytes: 1_500_000, names: ["old-vad", "x"] });
    expect(pruneLabel(s!)).toBe("사용하지 않는 폴더 2개 (1.5 MB) 정리");
    expect(pruneDialog(s!).body).toContain("2개(1.5 MB)");
    expect(pruneDialog(s!).body).toContain("old-vad, x"); // 지울 폴더 이름을 보여 준다
    expect(pruneDone(2, 1_500_000)).toBe("2개를 정리했습니다 (1.5 MB 확보).");
  });
  test("옮길 모델: 없는 것(missing)만 뺀다. 일부만 받은 것은 옮긴다", () => {
    expect(movable([row("missing", 0)])).toEqual({ count: 0, bytes: 0 });
    expect(movable([row("installed", 2_000_000), row("partial", 500_000), row("missing", 0)])).toEqual({ count: 2, bytes: 2_500_000 });
    const d = moveDialog("/Volumes/ext/models", { count: 2, bytes: 2_500_000 });
    expect(d.body).toContain("2개(2.5 MB)");
    expect(d.body).toContain("‘/Volumes/ext/models’");
    expect([moveDone(3), moveDone(0)]).toEqual(["모델 3개를 옮겼습니다.", "모델 폴더를 바꿨습니다."]);
  });
});

describe("default transcription engine", () => {
  const rows = (ids: string[], installed: string[]) => ids.map((id) => ({ id, engine: id === "vad" ? null : "qwen3", installed: installed.includes(id) }));
  test("the chosen engine wins when installed, otherwise the same order as the core", () => {
    const all = rows(["vad", "asr-std", "asr-lite", "custom-buzzasr-korean"], ["vad", "asr-std", "asr-lite", "custom-buzzasr-korean"]);
    expect(engineInUse(all, "custom-buzzasr-korean", "standard")).toBe("custom-buzzasr-korean");
    expect(engineInUse(all, null, "standard")).toBe("asr-std");
    expect(engineInUse(all, null, "lite")).toBe("asr-lite");
    expect(engineInUse(rows(["asr-std", "custom-x"], ["custom-x"]), "asr-std", "standard")).toBe("custom-x"); // 고른 엔진이 없으면 받아 둔 다른 엔진
    expect(engineInUse(rows(["vad", "asr-std"], ["vad"]), null, "standard")).toBeNull();
  });
  test("repo ids for adding an engine", () => {
    for (const ok of ["BuzzASR/korean", " mlx-community/whisper-large-v3-turbo "]) expect(validRepo(ok)).toBe(true);
    for (const bad of ["", "korean", "a/b/c", "../x", "-a/b", "a/ b"]) expect(validRepo(bad)).toBe(false);
  });
});
