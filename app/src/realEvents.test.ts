// 실제 바이너리가 낸 줄을 그대로 화면 논리에 넣는다 (2026-10-14: `tractus-rec record --fake` 6초 → 일시정지 3초 → 6초, `tractus recording finish`, `tractus transcribe --into`).
// 줄은 stdout에서 그대로 옮긴 것이다 (경로만 줄였다). 계약이 어긋나면 여기서 먼저 깨진다.
import { describe, expect, test } from "vitest";
import { deriveTrayState } from "./tray";
import { IDLE_JOB, IDLE_REC, jobReduce, recReduce, type JobEvent, type RecEvent } from "./lib";
import { clockAt, resumedStartMs } from "./pause";

const parse = <T>(lines: string): T[] => lines.trim().split("\n").map((l) => JSON.parse(l) as T);

const RECORDER = `
{"tracks":["mic","system"],"sample_rate":48000,"started_at":"2026-10-14T17:44:12+09:00","echo_cancel":false,"event":"started","dir":"/h/recordings/R1"}
{"system":-13.5,"t":0.26,"event":"level","mic":-13.5}
{"system":-13.5,"t":5.76,"event":"level","mic":-13.5}
{"elapsed":6,"event":"paused"}
{"text":null,"kind":"bookmark","t":6,"event":"mark"}
{"text":"일시정지 중 메모","kind":"memo","t":6,"event":"mark"}
{"elapsed":6,"event":"resumed"}
{"system":-13.5,"t":6.25,"event":"level","mic":-13.5}
{"system":-13.5,"t":12,"event":"level","mic":-13.5}
{"event":"stopped","dir":"/h/recordings/R1","duration":12.01}
`;

describe("실제 tractus-rec 이벤트", () => {
  const evs = parse<RecEvent>(RECORDER);
  const upTo = (n: number) => evs.slice(0, n).reduce(recReduce, { ...IDLE_REC, phase: "starting" });

  test("일시정지 → 북마크·메모 → 계속 → 끝: 녹음 시각은 멈춘 시간을 뺀다", () => {
    expect(upTo(4)).toMatchObject({ phase: "paused", t: 6, mic: null, system: null });
    expect(upTo(6).marks.map((m) => [m.kind, m.t])).toEqual([["bookmark", 6], ["memo", 6]]); // 일시정지 중에도 받고 멈춘 위치에 찍힌다
    expect(upTo(7)).toMatchObject({ phase: "recording", t: 6 });
    expect(upTo(8)).toMatchObject({ phase: "recording", t: 6.25 }); // level.t는 멈춘 위치에서 이어진다
    expect(upTo(evs.length)).toMatchObject({ phase: "stopped", t: 12.01, dir: "/h/recordings/R1" });
  });

  test("트레이: 일시정지는 멈춘 경과(ms)를 보내고, 계속하면 시작 시각을 뒤로 옮긴다", () => {
    const paused = upTo(4);
    const p = deriveTrayState({ rec: paused, startedAtMs: null, elapsedSec: paused.t, job: IDLE_JOB, waiting: false, importing: { active: false, done: 0, total: 0 }, recordOk: true, notes: [] });
    expect(p).toMatchObject({ phase: "paused", elapsed_ms: 6000, can_bookmark: true, can_record: false });
    const now = 1_000_000;
    const start = resumedStartMs(now, 6);
    expect(clockAt({ t: 6, at: now }, now + 1500)).toBe(7.5);
    expect(now - start).toBe(6000);
  });
});

const jobLines = (job: string, lines: string) => parse<Omit<JobEvent, "job">>(lines).map((e) => ({ ...e, job }) as JobEvent);
const FINISH = `
{"event": "stage", "stage": "decode"}
{"event": "stage", "stage": "encode"}
{"event": "done", "meeting_id": "01M4WSBRKTBY3NXVZB3CPXM9MT", "meeting_dir": "/h/meetings/2026-10-14_녹음_17_44_01M4WSBRKTBY3NXVZB3CPXM9MT"}
`;
const CONVERT = `
{"event": "stage", "stage": "decode"}
{"event": "stage", "stage": "vad"}
{"event": "stage", "stage": "diarize", "engine": "nemotron"}
{"event": "stage", "stage": "load_model"}
{"event": "stage", "stage": "transcribe"}
{"event": "progress", "done": 0, "total": 1}
{"event": "progress", "done": 1, "total": 1}
{"event": "stage", "stage": "align"}
{"event": "progress", "done": 1, "total": 1}
{"event": "stage", "stage": "index"}
{"event": "done", "meeting_id": "01M4WSCHD7BTVNC25CW6FF8DF2", "meeting_dir": "/h/meetings/x"}
`;

describe("실제 tractus 작업 이벤트", () => {
  const run = (job: string, lines: string) => [...jobLines(job, lines), { job, event: "exit", code: 0, stderr: "" } as JobEvent].reduce(jobReduce, { ...IDLE_JOB, running: true });

  test("recording finish: decode → encode → done, exit 0이면 성공이고 새 노트 ID가 남는다", () => {
    expect(run("j1", FINISH)).toMatchObject({ running: false, error: null, meetingId: "01M4WSBRKTBY3NXVZB3CPXM9MT", stage: "encode" });
  });

  test("transcribe --into: 일반 변환과 같은 단계·진행률로 끝난다", () => {
    expect(run("j2", CONVERT)).toMatchObject({ running: false, error: null, meetingId: "01M4WSCHD7BTVNC25CW6FF8DF2", stage: "index" });
  });

  test("not_recorded·not_converted·recording_missing·note_audio_missing 오류 코드는 화면 문장으로 바뀐다", async () => {
    const { errorView } = await import("./lib");
    for (const code of ["not_recorded", "not_converted", "recording_missing", "note_audio_missing"]) {
      const v = errorView("원래 문구", code, "작업을 하지 못했습니다");
      expect(v.text, code).not.toBe("작업을 하지 못했습니다");
    }
  });
});
