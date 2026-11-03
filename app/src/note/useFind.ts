// 찾아 바꾸기 (MeetingView에서 옮김, 동작 그대로): 찾기 상태·일치 목록·바꾸기와 일치 강조(CSS Custom Highlight API).
// 문장 저장(saveText)은 useNoteEditing이 한다.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, errText } from "../api";
import type { Notify } from "../App";
import { t } from "../i18n";
import { findMatches, replaceEdits, type Match, type Segment, type TextEdit, type Row } from "../lib";
import type { FindState } from "../TranscriptTools";

export function useFind({
  visible,
  rows,
  editingId,
  list,
  saveText,
  setEditError,
  notify,
}: {
  /** 화면에 보이는 대화 (화자 필터 적용) */
  visible: Segment[];
  rows: Row[];
  editingId: string | null;
  list: RefObject<HTMLOListElement | null>;
  saveText: (edits: TextEdit[], suggestTerm?: boolean) => void;
  setEditError: (e: string | null) => void;
  notify: Notify;
}) {
  // 찾기·바꾸기 (5.4)
  const [find, setFind] = useState<FindState | null>(null);
  const [cur, setCur] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (find ? findMatches(visible, find.q) : []), [visible, find?.q]);
  const curMatch: Match | null = matches.length ? matches[Math.min(cur, matches.length - 1)] : null;
  const curIndex = curMatch ? matches.indexOf(curMatch) : 0;
  useEffect(() => setCur(0), [find?.q]);
  const replace = (all: boolean) => {
    if (!find || !curMatch) return;
    const edits = replaceEdits(visible, find.q, find.r, all ? undefined : curMatch);
    if (!edits.length) return setEditError(t("바꿔도 내용이 같거나 비게 되어 바꾸지 않았습니다"));
    saveText(edits);
    const term = find.r.trim();
    if (find.glossary && term) {
      api.glossaryAdd([term]).then(
        (n) => notify({ text: n ? t("자주 쓰는 단어에 추가했습니다 — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }) : t("이미 자주 쓰는 단어에 있습니다 — {term}", { term }) }),
        (e) => notify({ text: t("자주 쓰는 단어에 추가하지 못했습니다: {error}", { error: errText(e) }), error: true }),
      );
    }
  };

  // 강조: CSS Custom Highlight API. 지원하지 않으면 현재 일치 행의 테두리(is-find)만 보인다.
  // 문장 노드는 한 번에 모아 둔다(일치마다 querySelector를 부르면 1000세그먼트에서 키 입력마다 100ms 넘게 걸린다)
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const nodes = new Map<string, Node>();
    if (matches.length)
      for (const el of list.current?.querySelectorAll<HTMLElement>(".seg-text:not(.seg-editor)") ?? []) {
        const segId = el.closest<HTMLElement>("[data-seg-id]")?.dataset.segId;
        if (segId && el.firstChild) nodes.set(segId, el.firstChild);
      }
    const range = (m: Match) => {
      const node = nodes.get(m.id);
      if (!node) return [];
      try {
        const r = new Range();
        r.setStart(node, m.start);
        r.setEnd(node, m.start + m.length);
        return [r];
      } catch {
        return [];
      }
    };
    CSS.highlights.set("find", new Highlight(...matches.flatMap(range)));
    CSS.highlights.set("find-current", new Highlight(...(curMatch ? range(curMatch) : [])));
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [matches, curMatch, rows, editingId]);
  return { find, setFind, cur, setCur, findInput, matches, curMatch, curIndex, replace };
}
