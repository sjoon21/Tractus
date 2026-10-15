import { describe, expect, test } from "vitest";
import { ERROR_TEXT, warningText, WARNING_TEXT } from "./lib";
import { ASR_FALLBACK_WARNING, CAP_NAME, MODEL_MISSING_ERROR, decide, FIX_CHECKUP, FIX_MODELS, FIX_SETTINGS, recordNotice, showSearchNotice, speakerHintVisible, trackOf, OK, type CapId, type DoctorCap, type DoctorReport } from "./caps";
import { dismiss, isDismissed, speakerHintKey } from "./hintDismiss";
import { focusRefreshDue } from "./useCapabilities";

const tool = { found: true, path: "/x", version: null };
const report = (caps: Partial<DoctorCap>[]): DoctorReport => ({
  doctor: {
    system: { arch: "arm64", macos_version: "15.0", memory_gb: 32, meets_min: true, disk_free_bytes: 5e10 },
    tools: { ffmpeg: tool, recorder: tool, diar_helper: tool, brew: null },
    models: [],
    capabilities: caps.map((c) => ({ id: "convert", name: "x", ready: false, missing: [], hint: "", ...c })),
    recommended_track: null,
  },
  core_error: null,
  tractus_bin: "/t",
  tractus_bin_exists: true,
  rec_bin: "/r",
  rec_bin_exists: true,
});

const ids = Object.keys(CAP_NAME) as CapId[];

describe("decide: 점검을 못 읽거나 모르면 막지 않는다", () => {
  test("점검 결과가 없으면 모든 기능을 쓸 수 있다", () => {
    for (const id of ids) {
      expect(decide(null, id)).toBe(OK);
      expect(decide(undefined, id)).toBe(OK);
      expect(decide({ ...report([]), doctor: null }, id)).toBe(OK);
    }
  });
  test("점검에 없는 기능(옛 코어)·준비된 기능은 쓸 수 있다", () => {
    expect(decide(report([]), "align")).toBe(OK);
    expect(decide(report([{ id: "align", ready: true }]), "align")).toBe(OK);
  });
});

describe("decide: 기능별 이유와 고치는 길", () => {
  const why = (id: CapId, missing: string[]) => {
    const d = decide(report([{ id, missing }]), id);
    if (d.ok) throw new Error("막혀야 한다");
    return d;
  };
  test("변환: 모델 없음 → 모델 화면", () => {
    const d = why("convert", ["vad", "asr-std"]);
    expect(d.reason).toContain("변환 엔진이 없어");
    expect(d.fix).toEqual(FIX_MODELS);
    expect(d.missing).toEqual(["vad", "asr-std"]);
  });
  test("변환: ffmpeg만 없음 → 시작 점검 (brew 명령을 안내)", () => {
    const d = why("convert", ["ffmpeg"]);
    expect(d.reason).toContain("brew install ffmpeg");
    expect(d.fix).toEqual(FIX_CHECKUP);
  });
  test("변환: 모델도 ffmpeg도 없음 → 둘 다 말하고 모델 화면으로", () => {
    const d = why("convert", ["asr-lite", "ffmpeg"]);
    expect(d.reason).toMatch(/변환 엔진과 ffmpeg/);
    expect(d.fix).toEqual(FIX_MODELS);
  });
  test("실시간: 표준 엔진이 있어도 0.6B가 따로 필요하다고 말한다", () => {
    const d = why("live", ["asr-lite"]);
    expect(d.reason).toContain("0.6B");
    expect(d.reason).toContain("표준 변환 엔진을 설치했어도");
    expect(d.fix).toEqual(FIX_MODELS);
  });
  test("실시간: 녹음 프로그램만 없음 → 설정, 구간 감지 파일만 없음 → 그 파일을 말한다", () => {
    expect(why("live", ["recorder"]).fix).toEqual(FIX_SETTINGS);
    expect(why("live", ["vad"]).reason).toContain("목소리 구간 감지");
  });
  test("실시간: 메모리 16 GB 미만이면 다른 것이 없어도 못 켜고 시작 점검으로 안내한다", () => {
    const d = why("live", ["asr-lite", "memory"]);
    expect(d.reason).toContain("16 GB 미만");
    expect(d.fix).toEqual(FIX_CHECKUP);
    expect(why("live", ["memory"]).fix).toEqual(FIX_CHECKUP);
  });
  test("단어 싱크·목소리 등록: ffmpeg만 없으면 ffmpeg를 말하고 시작 점검으로, 모델도 없으면 모델 화면으로", () => {
    for (const id of ["align", "voices"] as const) {
      const d = why(id, ["ffmpeg"]);
      expect(d.reason).toContain("brew install ffmpeg");
      expect(d.fix).toEqual(FIX_CHECKUP);
    }
    expect(why("align", ["aligner", "ffmpeg"]).fix).toEqual(FIX_MODELS);
    expect(why("voices", ["voices", "ffmpeg"]).fix).toEqual(FIX_MODELS);
  });
  test("나머지 기능은 자기 이름의 이유를 가진다", () => {
    expect(why("diarize", ["diarizer"]).reason).toBe("참석자 구분 모델이 없어 참석자를 나누지 못했습니다. 모델 화면에서 설치하면 다음 변환부터 참석자를 나눕니다.");
    expect(why("diarize-many", ["fluid"]).reason).toContain("최대 8명");
    expect(why("align", ["aligner"]).reason).toContain("단어 싱크");
    expect(why("smart-search", ["embedding"]).reason).toContain("단어 일치로만");
    // Upstage로 쓰는 중에 키가 없으면 모델이 아니라 키가 이유이고, 고치는 곳은 설정이다
    expect(why("smart-search", ["upstage-key"])).toMatchObject({ reason: expect.stringContaining("Upstage API 키가 없어"), fix: FIX_SETTINGS });
    // 로컬 전용 모드에서는 Upstage로 처리하지 않는다: 이유는 모드이고, 고치는 곳은 설정이다
    expect(why("smart-search", ["local-only"])).toMatchObject({ reason: expect.stringContaining("로컬 전용 모드"), fix: FIX_SETTINGS });
    expect(why("voices", ["voices"]).reason).toContain("이름만 바꿀 수 있습니다");
  });
  test("모든 막힌 기능은 이유 문장과 고치는 단추 글자를 가진다", () => {
    for (const id of ids.filter((i) => i !== "record")) {
      const d = why(id, []);
      expect(d.reason.length).toBeGreaterThan(10);
      expect(d.fix.label.length).toBeGreaterThan(1);
    }
  });
});

describe("녹음 프로그램", () => {
  test("앱이 쓰는 경로(설정)에 없으면 녹음 단추가 이유와 설정으로 가는 길을 보인다", () => {
    const d = decide({ ...report([]), rec_bin_exists: false }, "record");
    expect(d).toMatchObject({ ok: false, fix: FIX_SETTINGS });
    expect(d.ok === false && d.reason).toContain("tractus-rec");
  });
  test("있거나 점검을 못 하면 쓸 수 있다", () => {
    expect(decide(report([]), "record")).toBe(OK);
    expect(decide(null, "record")).toBe(OK);
  });
});

describe("녹음 버튼 아래 안내", () => {
  test("변환할 수 있으면 아무것도 보이지 않는다", () => {
    expect(recordNotice(OK)).toBeNull();
  });
  test("모델이 없으면 녹음만 저장된다고, ffmpeg만 없으면 ffmpeg를 말한다", () => {
    const m = decide(report([{ id: "convert", missing: ["asr-std"] }]), "convert");
    const f = decide(report([{ id: "convert", missing: ["ffmpeg"] }]), "convert");
    expect(recordNotice(m)).toBe("변환 엔진이 없어 녹음만 저장됩니다. 모델 화면에서 설치하면 변환할 수 있습니다");
    expect(recordNotice(f)).toBe("ffmpeg가 없어 녹음만 저장됩니다. 설치하면 변환할 수 있습니다");
  });
});

describe("참석자 구분 안내", () => {
  const blocked = decide(report([{ id: "diarize", missing: ["diarizer"] }]), "diarize");
  const base = { diarize: blocked, isRecording: true, segments: 10, speakers: 0, dismissed: false };
  test("모델이 없고 참석자가 없는 녹음 노트에만 보인다", () => {
    expect(speakerHintVisible(base)).toBe(true);
    expect(speakerHintVisible({ ...base, diarize: OK })).toBe(false);
    expect(speakerHintVisible({ ...base, speakers: 2 })).toBe(false);
    expect(speakerHintVisible({ ...base, isRecording: false })).toBe(false);
    expect(speakerHintVisible({ ...base, segments: 0 })).toBe(false);
  });
  test("닫으면 다시 보이지 않는다", () => {
    expect(speakerHintVisible({ ...base, dismissed: true })).toBe(false);
  });
  test("닫은 상태는 노트마다 따로 저장되고, 저장소가 막혀도 오류가 나지 않는다", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(isDismissed(speakerHintKey("n1"), store)).toBe(false);
    dismiss(speakerHintKey("n1"), store);
    expect(isDismissed(speakerHintKey("n1"), store)).toBe(true);
    expect(isDismissed(speakerHintKey("n2"), store)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(isDismissed("k", broken)).toBe(false);
    expect(() => dismiss("k", broken)).not.toThrow();
    expect(isDismissed("k", null)).toBe(false);
  });
});

describe("코어 경고·오류 코드 문장", () => {
  test("asr_track_fallback(권장 엔진이 없어 다른 엔진으로 변환)은 코어의 명령 문구 대신 문장으로 보인다", () => {
    expect(WARNING_TEXT.asr_track_fallback).toBe(ASR_FALLBACK_WARNING);
    expect(warningText({ code: "asr_track_fallback", message: "standard 변환 엔진이 없어 lite 엔진으로 변환합니다 (받으려면 tractus models download asr-std)" })).not.toContain("tractus models");
  });
  test("model_missing은 모델 화면으로 안내한다", () => {
    expect(ERROR_TEXT.model_missing).toBe(MODEL_MISSING_ERROR);
    expect(MODEL_MISSING_ERROR).toContain("모델 화면");
  });
});

describe("검색 안내·변환 엔진 이름·점검 간격", () => {
  test("단어 일치뿐이고 모델이 없을 때만 검색 안내를 보인다", () => {
    const blocked = decide(report([{ id: "smart-search", missing: ["embedding"] }]), "smart-search");
    expect(showSearchNotice(false, blocked)).toBe(true);
    expect(showSearchNotice(true, blocked)).toBe(false);
    expect(showSearchNotice(false, OK)).toBe(false);
  });
  test("trackOf: 코어가 주는 이름이 달라도 저사양을 알아본다", () => {
    for (const v of ["asr-lite", "lite", "0.6B", "저사양"]) expect(trackOf(v)).toBe("lite");
    for (const v of ["asr-std", "standard", "1.7B", "", null, undefined]) expect(trackOf(v)).toBe("std");
  });
  test("focusRefreshDue: 간격이 지났고 진행 중인 점검이 없을 때만", () => {
    expect(focusRefreshDue(0, 6000, false)).toBe(true);
    expect(focusRefreshDue(4000, 6000, false)).toBe(false);
    expect(focusRefreshDue(0, 60000, true)).toBe(false);
  });
});
