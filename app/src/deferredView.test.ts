// 녹음과 변환 나누기의 화면 조각 (docs/desktop.md §3.3): 정적 마크업으로 단추·문구·접근성 속성을 본다. 순수 로직은 각 모듈의 테스트가 맡는다.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { MeetingInfo } from "./api";
import { AfterRecordDialog } from "./AfterRecordDialog";
import { OK, type Decision } from "./caps";
import { ConvertPanel } from "./ConvertPanel";
import { IDLE_JOB, IDLE_LIVE, IDLE_REC, type JobState, type RecState } from "./lib";
import { NoteRow } from "./NoteRow";
import { RecordView } from "./RecordView";
import { WAIT_OTHER, type ConvertControls } from "./recorded";

const GATED: Decision = { ok: false, reason: "변환 엔진이 없어 텍스트로 변환할 수 없습니다. 모델 화면에서 설치하세요.", missing: ["asr-std"], fix: { kind: "models", label: "모델 설치" } };
const job = (o: Partial<JobState> = {}): JobState => ({ ...IDLE_JOB, ...o });
const controls = (o: Partial<ConvertControls> = {}): ConvertControls => ({ slot: null, waitReason: WAIT_OTHER, gate: OK, onConvert: () => {}, ...o });

describe("ConvertPanel (변환 전 노트 가운데)", () => {
  const html = (j: JobState, c: ConvertControls) => renderToStaticMarkup(createElement(ConvertPanel, { id: "01ABC", job: j, controls: c }));

  test("쉬는 중: 안내와 `텍스트로 변환` 단추", () => {
    const h = html(job(), controls());
    expect(h).toContain("아직 텍스트로 변환하지 않았습니다");
    expect(h).toMatch(/<button[^>]*>텍스트로 변환<\/button>/);
    expect(h).not.toContain("aria-disabled");
  });

  test("변환 엔진이 없으면 단추가 aria-disabled이고 이유가 title로 붙는다 (조용히 죽지 않는다)", () => {
    const h = html(job(), controls({ gate: GATED }));
    expect(h).toContain("aria-disabled");
    expect(h).toContain(GATED.reason);
  });

  test("변환 중: 단계 문구와 진행률, 단추는 없다", () => {
    const h = html(job({ running: true, stage: "transcribe", done: 9, total: 20 }), controls({ slot: "running" }));
    expect(h).toContain("음성을 글로 변환하는 중…");
    expect(h).toContain("9/20 · 45%");
    expect(h).not.toContain("텍스트로 변환</button>");
  });

  test("줄에서 기다리는 중: 이유를 보이고 단추는 없다", () => {
    const h = html(job(), controls({ slot: "queued", waitReason: "녹음이 끝나면 변환을 시작합니다" }));
    expect(h).toContain("녹음이 끝나면 변환을 시작합니다");
    expect(h).not.toContain("<button");
  });

  test("실패: 코드 문장과 접힌 자세히, 다시 변환", () => {
    const h = html(job({ error: "ffmpeg not found", errorCode: "ffmpeg_missing" }), controls());
    expect(h).toContain("텍스트 변환 실패");
    expect(h).toContain("brew install ffmpeg");
    expect(h).toContain("자세히");
    expect(h).toMatch(/<button[^>]*>다시 변환<\/button>/);
  });

  test("경고(보관한 원본이 없을 때 등)는 코드 문장으로 보인다", () => {
    expect(html(job({ running: true, warnings: [{ code: "tracks_missing", message: "audio.ogg" }] }), controls({ slot: "running" }))).toContain("보관한 녹음 원본이 없어");
  });
});

describe("RecordView (일시정지·끝낸 뒤)", () => {
  const rec = (o: Partial<RecState>): RecState => ({ ...IDLE_REC, mode: "in_person", tracks: ["mic"], ...o });
  const html = (r: RecState, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(RecordView, { rec: r, captions: IDLE_LIVE, job: IDLE_JOB, send: async () => {}, retry: () => {}, ...extra }));

  test("녹음 중: `일시정지`, `북마크`, `녹음 종료`. 시계에 붉은 점", () => {
    const h = html(rec({ phase: "recording", t: 61 }));
    expect(h).toContain("녹음 중");
    expect(h).toMatch(/>일시정지<\/button>/);
    expect(h).toContain("녹음 종료");
    expect(h).not.toContain("녹음 종료 및 변환");
    expect(h).toContain("record-clock tnum is-live");
    expect(h).not.toContain("일시정지됨");
  });

  test("일시정지 중: `계속`, 안내, 멈춘 시계(깜빡이지 않음), 북마크·종료·메모는 켜져 있다", () => {
    const h = html(rec({ phase: "paused", t: 754 }));
    expect(h).toContain("일시정지됨");
    expect(h).toMatch(/>계속<\/button>/);
    expect(h).toContain("마이크 사용 표시는 녹음을 끝낼 때까지 켜져 있습니다");
    expect(h).toContain("12:34");
    expect(h).toContain("is-paused");
    expect(h).not.toContain("is-live");
    // 단추들이 disabled가 아니다 (일시정지 중에도 된다)
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(북마크|녹음 종료)/);
    expect(h).not.toMatch(/<(input|textarea)[^>]*disabled/);
  });

  test("끝낸 뒤 묻는 중에는 옛 변환의 `완료` 줄을 보이지 않는다", () => {
    const h = html(rec({ phase: "stopped", t: 30 }), { choosing: true, job: job({ meetingId: "OLD" }) });
    expect(h).toContain("지금 변환할지 정해 주세요");
    expect(h).not.toContain("텍스트 변환 완료");
  });

  test("노트로 저장하는 진행 줄: 저장 중 / 완료 / 실패와 다시 저장", () => {
    const stopped = rec({ phase: "stopped", t: 30 });
    expect(html(stopped, { progressKind: "save", job: job({ running: true }) })).toContain("저장 중…");
    expect(html(stopped, { progressKind: "save", job: job({ running: true, stage: "encode" }) })).toContain("음성 파일 압축 보관 중…");
    expect(html(stopped, { progressKind: "save", job: job({ meetingId: "N1" }) })).toContain("녹음 저장 완료");
    const failed = html(stopped, { progressKind: "save", job: job({ error: "disk full", errorCode: "audio_failed" }) });
    expect(failed).toContain("녹음 저장 실패");
    expect(failed).toMatch(/>다시 저장<\/button>/);
    expect(failed).not.toContain("텍스트 변환 실패");
  });

  test("바로 변환 진행 줄은 그대로다 (텍스트 변환 완료·실패·다시 변환)", () => {
    const stopped = rec({ phase: "stopped", t: 30 });
    expect(html(stopped, { job: job({ meetingId: "N1" }) })).toContain("텍스트 변환 완료");
    expect(html(stopped, { job: job({ error: "x" }) })).toMatch(/>다시 변환<\/button>/);
  });
});

describe("NoteRow (사이드바 줄)", () => {
  const note = (o: Partial<MeetingInfo> = {}): MeetingInfo => ({ id: "01A", dir: "/h/meetings/x", title: "녹음 14:05", created_at: "2026-10-14T14:05:00+09:00", duration_sec: 65, segments: 0, has_summary: false, kind: "recording", ...o });
  const html = (m: MeetingInfo, slot: "running" | "queued" | null = null) => renderToStaticMarkup(createElement(NoteRow, { m, active: false, onOpen: () => {}, slot, onConvert: () => {} }));

  test("변환 전 노트: 배지 `변환 전` (`요약 없음` 대신)", () => {
    const h = html(note({ state: "recorded" }));
    expect(h).toContain("변환 전");
    expect(h).not.toContain("요약 없음");
  });

  test("변환 줄에 오르면 배지가 `변환 대기`·`변환 중…`으로 바뀐다", () => {
    expect(html(note({ state: "recorded" }), "queued")).toContain("변환 대기");
    expect(html(note({ state: "recorded" }), "running")).toContain("변환 중…");
  });

  test("변환한 노트와 메모 노트에는 `변환 전` 배지가 없다", () => {
    expect(html(note())).toContain("요약 없음");
    expect(html(note())).not.toContain("변환 전");
    expect(html(note({ kind: "memo", state: "recorded" }))).not.toContain("변환 전");
  });
});

describe("AfterRecordDialog (끝낸 뒤 묻는 창)", () => {
  const html = (convert: Decision) => renderToStaticMarkup(createElement(AfterRecordDialog, { seconds: 754, convert, onChoose: () => {} }));

  test("두 단추, 체크, 본문의 길이", () => {
    const h = html(OK);
    expect(h).toContain("녹음을 끝냈습니다");
    expect(h).toContain("녹음 길이 12:34");
    expect(h).toContain("나중에 변환하기");
    expect(h).toContain("바로 변환하기");
    expect(h).toContain("다음부터 묻지 않기");
    expect(h).toContain('role="alertdialog"');
    expect(h).not.toContain("aria-disabled");
  });

  test("변환을 못 쓰면 `바로 변환하기`가 aria-disabled + 이유, 이유와 고치는 단추가 창에 보인다", () => {
    const h = html(GATED);
    expect(h).toMatch(/<button[^>]*aria-disabled="true"[^>]*>바로 변환하기<\/button>/);
    expect(h).toContain(GATED.reason);
    expect(h).toContain("모델 설치");
    // `나중에 변환하기`는 눌린다
    expect(h).not.toMatch(/<button[^>]*aria-disabled[^>]*>나중에 변환하기/);
  });
});
