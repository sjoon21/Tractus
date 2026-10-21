// 녹음 중 남긴 메모·북마크 고치기·지우기 (녹음 화면: 녹음 프로그램 명령, 노트: `tractus marks <노트> save`).
// 화면과 무관한 순수 함수라 marks.test.ts에서 검사한다. 원본은 고치지 않고 새 목록을 돌려준다.
import { t } from "./i18n";
import type { Memo } from "./lib";

export const MEMO_TEXT_MAX = 500; // 코어 store.MEMO_TEXT_MAX와 같다

export const MARK_EDIT_HINT = t("두 번 눌러 고칩니다. 비우면 지웁니다");
export const MARK_EDIT_LABEL = t("메모 고치기");
export const markDeleteLabel = (m: Memo) => (m.kind === "bookmark" ? t("북마크 삭제") : t("메모 삭제"));

/** 한 줄로 정리한 메모 글 (코어 store.one_line과 같은 결과) */
export const cleanMarkText = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ").slice(0, MEMO_TEXT_MAX);

/** i번째 메모의 글을 바꾼 새 목록. 비우면 지운다. 북마크는 글이 없어 바꾸지 않는다 */
export function editMark(marks: Memo[], i: number, text: string): Memo[] {
  const m = marks[i];
  if (!m || m.kind !== "memo") return marks;
  const clean = cleanMarkText(text);
  return clean ? marks.map((x, n) => (n === i ? { ...x, text: clean } : x)) : deleteMark(marks, i);
}

/** i번째 메모·북마크를 뺀 새 목록 */
export const deleteMark = (marks: Memo[], i: number): Memo[] => marks.filter((_, n) => n !== i);
