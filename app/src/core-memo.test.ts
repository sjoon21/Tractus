// 코어가 실제로 만든 녹음 노트(tests/fixtures/memo_home, 가상 내용)와 실제 MCP·ask 출력의 모양을 앱 순수 로직으로 읽는다.
import { describe, expect, test } from "vitest";
import { answerParts, citeLabel, citeTarget, type AskEvent, askReduce, START_ASK } from "./ask";
import { evidenceLabel, parseToolResult, summaryMarkdown, type NoteMemo } from "./lib";
import { hitView, memoLineNumbers } from "./memo";
import type { SearchResponse } from "./api";

const MID = "01M4SV7KREWFM3MJPYR83JJD3M";
const files = import.meta.glob("../../tests/fixtures/memo_home/meetings/*/*.json", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const read = (f: string) => JSON.parse(files[`../../tests/fixtures/memo_home/meetings/2026-10-13_rec_${MID}/${f}`]);

describe("코어가 실제로 만든 녹음 노트의 메모", () => {
  const memo = read("transcript.json").memo as NoteMemo;
  const lines = memoLineNumbers(memo);

  test("메모 줄 ID가 줄 번호로 이어진다 (빈 줄은 건너뛴다)", () => {
    expect([...lines]).toEqual([["m0001", 1], ["m0002", 3], ["m0003", 4]]);
  });

  test("요약의 m-ID 근거가 `메모 n번째 줄`로 나온다 (시각과 섞이면 쉼표)", () => {
    const sum = read("summary.json");
    const starts = new Map([["s0001", 0]]);
    const md = summaryMarkdown(sum, starts, lines);
    expect(md).toContain("- 새 견적은 하늘상사에서 받기로 결정 (메모 3번째 줄)");
    expect(md).toContain("(0:00, 메모 1번째 줄)");
    expect(evidenceLabel(["m0003", "m0002"], starts, lines)).toBe("메모 3번째 줄");
  });

  test("질문 기록(chat.json)의 인용이 메모 줄 칩이 된다", () => {
    const turn = read("chat.json").turns[0];
    const cite = answerParts(turn.answer).find((p) => p.kind === "cite");
    expect(cite).toEqual({ kind: "cite", meetingId: null, segId: "m0002" });
    const t = citeTarget({ meetingId: null, segId: "m0002" }, { meetingId: MID, citations: turn.citations, sources: [] });
    expect(t).toEqual({ meetingId: MID, segId: "m0002", t: 0, line: 3 });
    expect(citeLabel(t!.t, { memo: true, tagged: true, line: t!.line })).toBe("메모 3번째 줄");
  });
});

describe("코어가 실제로 낸 녹음 노트 메모 질문·검색", () => {
  // `tractus ask --progress-json` 전체 범위 질문의 done 줄 (답에 `[회의#m0003]` 꼴이 온다)
  const done = `{"job":"j","event":"done","answer":"마감은 금요일입니다. [${MID}#m0003]","citations":[{"meeting_id":"${MID}","segment_id":"m0003","start":0.0,"line":4,"source":"memo"}],"provider":"upstage","model":"solar-pro4","no_evidence":false}`;

  test("전체 범위 답의 `[노트#m0003]`가 `메모 4번째 줄` 칩으로 간다", () => {
    const end = askReduce(START_ASK, JSON.parse(done) as AskEvent);
    const cite = answerParts(end.answer).find((p) => p.kind === "cite");
    expect(cite).toEqual({ kind: "cite", meetingId: MID, segId: "m0003" });
    const t = citeTarget({ meetingId: MID, segId: "m0003" }, { citations: end.citations, sources: end.sources });
    expect(t).toEqual({ meetingId: MID, segId: "m0003", t: 0, line: 4 });
  });

  test("MCP search_meetings 결과: 메모 줄은 시각 칸이 `메모 n번째 줄`이고 line이 붙는다", () => {
    const structured: SearchResponse = {
      query: "하늘상사 견적",
      vector_used: true,
      hits: [
        {
          meeting_id: MID,
          title: "예산 논의",
          date: "2026-10-13",
          matched: ["keyword", "vector"],
          segments: [{ id: "m0002", source: "memo", line: 3, time: "메모 3번째 줄", text: "견적은 하늘상사에서 받는다", cite: `[${MID}#m0002 메모 3번째 줄]` }],
        },
      ],
    };
    const r = parseToolResult<SearchResponse>({ content: [{ type: "text", text: "{}" }], structuredContent: structured });
    const s = r.hits[0].segments[0];
    expect(hitView(s, false)).toEqual({ memo: true, tagged: true, label: "3번째 줄", seek: { segId: "m0002", t: 0 } });
    // line이 없던 옛 서버 출력이어도 시각 칸에서 줄을 읽는다
    const old = { id: s.id, source: s.source, time: s.time, text: s.text };
    expect(hitView(old, false).label).toBe("3번째 줄");
  });
});
