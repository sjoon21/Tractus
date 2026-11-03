// 읽는 동안의 강조와 스크롤 (MeetingView에서 옮김, 동작 그대로): 가라오케(재생 중인 단어), 찾기 일치로 스크롤, 재생 위치 따라 자동 스크롤.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { segText, segmentIndexAt, tokenOffsets, usableWords, wordClock, wordIndexAt, type Match, type Segment, type Row } from "../lib";

export function useReadingHighlights({
  segments,
  rows,
  editingId,
  list,
  audio,
  playing,
  pos,
  active,
  follow,
  setFollow,
  holding,
  curMatch,
  detailKey,
}: {
  segments: Segment[];
  rows: Row[];
  editingId: string | null;
  list: RefObject<HTMLOListElement | null>;
  audio: RefObject<HTMLAudioElement | null>;
  playing: boolean;
  pos: number;
  /** 지금 재생 위치의 대화 번호 */
  active: number;
  follow: boolean;
  setFollow: (f: boolean) => void;
  /** 화자·문장을 고치는 중: 자동 스크롤을 쉰다 */
  holding: boolean;
  curMatch: Match | null;
  /** 노트가 바뀌면 단어 시각 지도를 다시 만든다 */
  detailKey: unknown;
}) {
  // 가라오케 (6.2): 재생 중인 단어 하나를 Highlight API로 칠한다 (단어마다 span을 만들지 않는다).
  // 재생 중에만 rAF로 돌고, 멈춘 동안은 이동할 때 한 번 칠한다. (세그먼트, 단어)가 바뀔 때만 Range를 바꾼다.
  // 찾기 강조가 위에 보이게 우선순위를 낮추고, 등록은 한 번만 한다(같은 우선순위면 나중에 등록한 것이 위)
  const karaoke = useRef<Highlight | null>(null);
  const usable = useMemo(() => new Map(segments.map((s) => [s.id, usableWords(s)])), [detailKey]);
  const pausedT = playing ? -1 : pos;
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const h = (karaoke.current ??= Object.assign(new Highlight(), { priority: -1 }));
    if (!CSS.highlights.has("karaoke")) CSS.highlights.set("karaoke", h);
    let last: string | null = null;
    let raf = 0;
    const paint = () => {
      const now = audio.current?.currentTime ?? pos;
      const seg = segments[segmentIndexAt(segments, now)];
      // 발화가 끝난 뒤의 공백과 고치는 중인 세그먼트는 칠하지 않는다. 끝 시각에 겹친 단어(길이 0)는 wordClock의 끝까지 칠한다
      const cand = seg && seg.id !== editingId ? usable.get(seg.id) : null;
      const words = cand && now <= Math.max(seg.end, wordClock(cand).end) ? cand : null;
      const k = words ? wordIndexAt(words, now) : -1;
      const key = k < 0 ? "" : `${seg.id}:${k}`;
      if (key !== last) {
        last = key;
        h.clear();
        const node = k < 0 ? null : list.current?.querySelector(`[data-seg-id="${seg.id}"] .seg-text:not(.seg-editor)`)?.firstChild;
        const o = node ? tokenOffsets(segText(seg))[k] : undefined;
        if (node && o) {
          try {
            const r = new Range();
            r.setStart(node, o.start);
            r.setEnd(node, o.end);
            h.add(r);
          } catch {
            // 글자 노드가 방금 바뀌었다. 다음 갱신에 다시 칠한다
          }
        }
      }
      if (playing) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [playing, pausedT, usable, rows, editingId]);
  useEffect(() => () => void ("highlights" in CSS && CSS.highlights.delete("karaoke")), []);
  useEffect(() => {
    if (!curMatch) return;
    setFollow(false);
    list.current?.querySelector(`[data-seg-id="${curMatch.id}"]`)?.scrollIntoView({ block: "center" });
  }, [curMatch]);

  // 현재 세그먼트 자동 스크롤. 사용자가 직접 스크롤하면 멈추고 "현재 위치로" 버튼을 보인다.
  // 화자를 고치는 동안(메뉴·이름 입력·합치기 확인)과 문장을 고치는 동안은 쉰다: 스크롤하면 고치던 것이 사라진다
  useEffect(() => {
    if (!follow || active < 0 || holding) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-seg="${active}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.top < 80 || box.bottom > window.innerHeight - 140) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [active, follow, holding]);
}
