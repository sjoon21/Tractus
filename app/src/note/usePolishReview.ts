// 스마트 교정의 제안 확인: 실행(usePolish), 제안 받기·버리기(줄에 세워 저장), 다음 제안으로 이동.
// 노트 데이터·저장 줄·저장 후 처리는 useNote의 것을 받아 쓴다.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, errDetail, errText } from "../api";
import type { Notify } from "../App";
import { inverseEdits, segText } from "../lib";
import { nextSuggestion, NO_SUGGESTIONS, termsFromSuggestions, type PolishSuggestion } from "../polish";
import { usePolish } from "../PolishControls";
import type { Note } from "./useNote";

/** onArrive: 제안으로 옮겨 간 뒤 (확인 표시가 있으면 그 문장을 들려준다, MeetingView) */
export function usePolishReview({ id, notify, note, setFollow, list, onArrive }: { id: string; notify: Notify; note: Note; setFollow: (f: boolean) => void; list: RefObject<HTMLOListElement | null>; onArrive?: (s: PolishSuggestion) => void }) {
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  const { data, queue, noteSaved, suggestTerms } = note;
  const { undoStack } = note.text;
  const { confirmed, commit } = data;
  const { guard, serial } = queue;
  // AI 다듬기 (docs/design/transcript-polish.md): 제안은 polish.json이 원본이다. 끝나면 노트를 다시 읽는다
  const polish = usePolish(id, notify, async () => {
    const d = await api.loadMeeting(id);
    commit(d);
    if (!d.polish?.length) notify({ text: NO_SUGGESTIONS });
  });
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  // 지금 보이는 제안 (아래 렌더에서 채운다): 받은 제안의 용어를 사전 단어로 넘길 때 kind·원문을 본다
  const polishLive = useRef<Map<string, PolishSuggestion>>(new Map());
  // 제안으로 이동: 가운데로 스크롤하고 수락 단추에 초점을 둔다 (Enter로 바로 받을 수 있다). polishAt은 '다음 제안'의 기준
  const [jump, setJump] = useState<{ id: string } | null>(null);
  const polishAt = useRef<string | undefined>(undefined);
  const jumpTo = useCallback((to: string) => {
    polishAt.current = to;
    setJump({ id: to });
  }, []);
  useEffect(() => {
    if (!jump) return;
    setFollow(false);
    const row = list.current?.querySelector<HTMLElement>(`[data-seg-id="${jump.id}"]`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    row?.querySelector<HTMLButtonElement>(".seg-polish button")?.focus({ preventScroll: true });
    // 어디로 왔는지 보이게 제안 상자를 잠깐 밝힌다
    const s = polishLive.current.get(jump.id);
    if (s) arrive.current?.(s);
    if (!reduce) row?.querySelector(".seg-polish")?.animate([{ boxShadow: "0 0 0 4px color-mix(in srgb, var(--ring) 60%, transparent)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1400, easing: "ease-out" });
  }, [jump]);
  /** 제안 받기·버리기: 줄에 세워 코어가 고친 회의를 돌려준다. 받은 문장은 ⌘Z로 되돌릴 수 있고, 받은 용어·이름 교정은 모아서 사전 단어로 제안한다 */
  const decidePolish = useCallback(
    (ids: string[], accept: boolean) => {
      if (!ids.length) return;
      if (guard()) return;
      setDeciding((d) => new Set([...d, ...ids]));
      const chosen = ids.flatMap((i) => polishLive.current.get(i) ?? []);
      void serial(async () => {
        const before = confirmed.current;
        try {
          const { changed, meeting } = await api.polishResolve(id, ids, accept);
          noteSaved(meeting, "text", accept && changed > 0);
          // 정한 줄 다음의 제안으로 (여럿을 한꺼번에 정했으면 남은 것의 처음으로)
          const rest = new Map([...polishLive.current].filter(([k]) => !ids.includes(k)));
          const to = nextSuggestion(meeting.segments, rest, ids.length === 1 ? ids[0] : undefined);
          if (to) jumpTo(to);
          if (accept && changed > 0) {
            const now = new Map(meeting.segments.map((s) => [s.id, s]));
            const edits = ids.flatMap((i) => (now.has(i) ? [{ id: i, text: segText(now.get(i)!) }] : []));
            if (before) undoStack.current.push(inverseEdits(before.segments, edits));
            suggestTerms(termsFromSuggestions(chosen.filter((x) => now.has(x.id) && segText(now.get(x.id)!) === x.text)));
          }
        } catch (e) {
          notify({ text: errText(e), detail: errDetail(e), error: true });
        } finally {
          setDeciding((d) => new Set([...d].filter((x) => !ids.includes(x))));
        }
      });
    },
    [id, guard, serial, confirmed, noteSaved, undoStack, suggestTerms, notify, jumpTo],
  );
  return { polish, deciding, polishLive, polishAt, jumpTo, decidePolish };
}
