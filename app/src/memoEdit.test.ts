import { describe, expect, test } from "vitest";
import { appendBlock, checkAtClick, continueList, toggleCheck, wrapSelection } from "./memoEdit";

const at = (s: string) => s.indexOf("|");
const cut = (s: string) => s.replace("|", "");

describe("목록 이어 쓰기 (Enter)", () => {
  test("글머리·체크박스·번호를 다음 줄에 잇는다 (체크박스는 빈 칸, 번호는 +1)", () => {
    expect(continueList(cut("- 사과|"), at("- 사과|"), at("- 사과|"))?.text).toBe("- 사과\n- ");
    expect(continueList(cut("- [x] 끝남|"), at("- [x] 끝남|"), at("- [x] 끝남|"))?.text).toBe("- [x] 끝남\n- [ ] ");
    expect(continueList(cut("  3. 셋|"), at("  3. 셋|"), at("  3. 셋|"))?.text).toBe("  3. 셋\n  4. ");
  });

  test("내용 없는 목록 줄에서 누르면 표지를 지우고 목록을 끝낸다", () => {
    const r = continueList("- 사과\n- [ ] ", 12, 12);
    expect(r).toEqual({ text: "- 사과\n", start: 5, end: 5 });
  });

  test("목록이 아니거나, 글을 골랐거나, 표지 앞이면 평소 Enter", () => {
    expect(continueList("그냥 글", 4, 4)).toBeNull();
    expect(continueList("- 사과", 2, 4)).toBeNull();
    expect(continueList("- 사과", 0, 0)).toBeNull();
  });
});

describe("체크박스", () => {
  test("⌘Enter: 토글, 일반 줄은 체크박스로, 글머리는 체크박스로 바꾼다 (캐럿은 같은 글자 뒤)", () => {
    expect(toggleCheck("- [ ] 할 일", 8, 8).text).toBe("- [x] 할 일");
    expect(toggleCheck("- [x] 할 일", 8, 8).text).toBe("- [ ] 할 일");
    expect(toggleCheck("첫 줄\n할 일", 5, 5)).toEqual({ text: "첫 줄\n- [ ] 할 일", start: 11, end: 11 });
    expect(toggleCheck("- 할 일", 3, 3)).toEqual({ text: "- [ ] 할 일", start: 7, end: 7 });
  });

  test("클릭: [ ] 안을 누를 때만 토글한다", () => {
    expect(checkAtClick("- [ ] 우유", 3)?.text).toBe("- [x] 우유");
    expect(checkAtClick("- [ ] 우유", 7)).toBeNull();
    expect(checkAtClick("우유 [ ] 사기", 4)).toBeNull();
  });
});

describe("굵게·기울임", () => {
  test("고른 글을 감싸고, 다시 누르면 벗긴다. 고른 글이 없으면 null", () => {
    expect(wrapSelection("중요한 말", 0, 3, "**")).toEqual({ text: "**중요한** 말", start: 2, end: 5 });
    expect(wrapSelection("**중요한** 말", 2, 5, "**")).toEqual({ text: "중요한 말", start: 0, end: 3 });
    expect(wrapSelection("**중요한** 말", 0, 7, "**")).toEqual({ text: "중요한 말", start: 0, end: 3 });
    expect(wrapSelection("말", 1, 1, "**")).toBeNull();
  });

  test("굵게 안의 글에 기울임을 걸어도 굵게를 벗기지 않는다", () => {
    expect(wrapSelection("**굵게**", 2, 4, "*")?.text).toBe("***굵게***");
  });
});

test("요약 붙이기: 빈 메모는 그대로, 아니면 빈 줄 하나를 두고", () => {
  expect(appendBlock("", "## 요약\n- [ ] 일")).toBe("## 요약\n- [ ] 일\n");
  expect(appendBlock("내 메모\n\n", "## 요약")).toBe("내 메모\n\n## 요약\n");
});
