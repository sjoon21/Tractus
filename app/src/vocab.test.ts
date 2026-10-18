import { expect, test } from "vitest";
import { stem, termFromEdit } from "./vocab";

test("오인식 고침은 고친 낱말을 돌려준다 (조사는 뗀다)", () => {
  expect(termFromEdit("자원 언톨로지로 뭘 하려는지", "자원 온톨로지로 뭘 하려는지")).toBe("온톨로지");
  expect(termFromEdit("유저 쿼리랑 이베딩을 비교해요", "유저 쿼리랑 임베딩을 비교해요")).toBe("임베딩");
  expect(termFromEdit("예를 들어 볼트웰 머신이 있으면", "예를 들어 버추얼 머신이 있으면")).toBe("버추얼");
  expect(termFromEdit("이 K 8 에서 파스 쪽", "이 K8s 에서 파스 쪽")).toBe("K8s");
  expect(termFromEdit("시장 노드를 찾는 데", "시드 노드를 찾는 데")).toBe("시드");
});

test("말투 고침·다른 말로 바꿔 쓰기·긴 수정은 제안하지 않는다", () => {
  expect(termFromEdit("연결이 안 되있고", "연결이 안 돼 있고")).toBeNull(); // 동사
  expect(termFromEdit("좋습니다 그렇게 하죠", "괜찮네요 그렇게 하죠")).toBeNull();
  expect(termFromEdit("그 회의 내용을 오늘 정리해서 공유드릴게요", "회의록은 내일 아침까지 메일로 보내겠습니다")).toBeNull();
  expect(termFromEdit("같은 문장", "같은 문장")).toBeNull();
  expect(termFromEdit("3명이 왔어요", "4명이 왔어요")).toBeNull(); // 숫자
});

test("조사·문장부호 떼기", () => {
  expect(stem("온톨로지로")).toBe("온톨로지");
  expect(stem("임베딩을,")).toBe("임베딩");
  expect(stem("VM이")).toBe("VM"); // 영문 뒤 조사도 뗀다
  expect(stem("나는")).toBe("나는");
});
