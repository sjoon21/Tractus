import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { PolishDiff } from "./PolishControls";

const s = { id: "a", start: 0, before: "삼십 명", text: "30명", kind: "number", flags: ["number"] };
const html = (onListen?: () => void) => renderToStaticMarkup(<PolishDiff s={s} busy={false} onDecide={() => {}} onListen={onListen} />);

test("확인 표시가 있는 제안에만 듣기 단추가 있고, 넘어올 때 초점은 수락 단추에 간다", () => {
  expect(html()).not.toContain("듣기");
  expect(html(() => {})).toContain("듣기");
  // usePolishReview가 [data-accept]에 초점을 준다: 듣기가 앞에 있어도 Enter는 수락이다
  expect(html(() => {}).match(/<button[^>]*data-accept[^>]*>/)?.[0]).toContain("수락 (Enter)");
});
