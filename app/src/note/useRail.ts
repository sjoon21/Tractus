// 오른쪽 패널(레일)의 탭 상태 (MeetingView에서 옮김, 동작 그대로): 어느 탭이 열렸는지, 접힘, 탭 고르기, 메모의 줄로 가기.
// 질문·메모·회의록 탭은 처음 열 때 만들고 그 뒤에는 숨겨도 둔다(스트리밍·쓰던 글이 이어지게): askSeen·memoSeen·minutesSeen.  // words-ok: 회의록은 문서 이름
import { useCallback, useEffect, useState } from "react";
import { flushMemos } from "../memo";
import type { MemoTarget } from "../MemoView";
import { usePanels } from "../PanelToggle";
import { railTabs, validTab, type RailTab } from "../rail";

export function useRail(memoNote: boolean, memoRef: { readonly current: boolean }, setMemoPick: (t: MemoTarget) => void) {
  const [tab, setTab] = useState<RailTab>("summary");
  // 오른쪽 패널 접기 (PanelToggle.tsx): 접어도 내용은 그대로 두고 숨기기만 한다 (쓰던 메모·질문 스트림·요약 작업이 이어진다)
  const { state: panels, reveal, registerRight, toggle: toggleRail } = usePanels();
  useEffect(() => registerRight(), [registerRight]);
  const railCollapsed = panels.right;
  const [askSeen, setAskSeen] = useState(false);
  const [memoSeen, setMemoSeen] = useState(false);
  const [minutesSeen, setMinutesSeen] = useState(false);
  const tabs = railTabs(memoNote);
  const tabNow = validTab(tabs, tab);
  const showTab = (k: RailTab, focusMemo = false) => {
    if (tabNow === "memo" && k !== "memo") void flushMemos(); // 메모 탭을 떠날 때 저장을 마친다 (입력창을 벗어나는 blur와 같다)
    setTab(k);
    if (k === "ask") setAskSeen(true);
    if (k === "minutes") setMinutesSeen(true);
    if (k === "memo") {
      setMemoSeen(true);
      if (focusMemo) setMemoPick({ segId: null, nonce: Date.now() }); // 탭을 눌러 열면 입력창에 초점. 방향키로 지나갈 때는 두지 않는다
    }
  };
  // 도크의 탭: 접힌 패널이면 펴서 그 탭을 보이고, 열려 있는 탭을 다시 누르면 접는다. 좁은 창(패널이 본문 아래로 내려간 때)에서는 패널로 스크롤한다
  const pickTab = (k: RailTab) => {
    const narrow = window.matchMedia("(max-width: 1180px)").matches;
    if (!narrow && !railCollapsed && k === tabNow) return void toggleRail("right");
    showTab(k, k === "memo");
    if (railCollapsed) void toggleRail("right");
    if (narrow) window.setTimeout(() => document.getElementById("rail-body")?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  };
  // 메모의 줄로 간다: 메모 노트는 가운데 본문에서, 녹음 노트는 메모 탭을 열고 그 줄을 고른다
  const openMemoLine = useCallback(
    (segId: string | null) => {
      if (!memoRef.current) {
        setTab("memo");
        setMemoSeen(true);
        reveal({ kind: "memo-line", memoNote: false }); // 메모 탭이 접힌 패널 안에 있으면 펼친다
      }
      setMemoPick({ segId, nonce: Date.now() });
    },
    [reveal, memoRef, setMemoPick],
  );
  return { tab, tabs, tabNow, askSeen, memoSeen, minutesSeen, railCollapsed, showTab, pickTab, openMemoLine };
}

export type Rail = ReturnType<typeof useRail>;
