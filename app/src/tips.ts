// 기능을 처음 마주칠 때 한 번씩 뜨는 안내 (온보딩 ③, WORDS.md §4.25). 한 번에 하나만 보인다.
// 본 안내는 이 Mac의 브라우저 저장소에만 기억한다 (개인 편의 설정: 없거나 막혀 있어도 앱은 그대로 돈다).
import { useEffect, useState } from "react";

/** 안내 ID → 문장. 화면의 `data-tip="<ID>"` 요소 옆에 뜬다 */
export const TIPS = {
  ask: "모든 노트에 대해 물어볼 수 있습니다. 답에 붙은 시각을 누르면 그 자리를 엽니다.",
  calendar: "곧 시작하는 일정입니다. 누르면 일정 제목과 참석자 이름으로 녹음합니다.",
  transcript: "시각을 누르면 그 자리부터 재생하고, 문장을 누르면 고칠 수 있습니다.",
  speakers: "참석자 이름을 눌러 정하세요. 목소리를 등록하면 다음 녹음부터 알아봅니다.",
  export: "Markdown·Word·PDF로 내보내거나 Obsidian 볼트로 보낼 수 있습니다.",
  enhance: "녹음하며 적은 메모를 뼈대로, 대화 내용에서 찾은 세부를 붙여 노트를 완성합니다.",
} as const;
export type TipId = keyof typeof TIPS;
export const TIP_OK = "알겠습니다";
export const TIP_OFF = "안내 끄기";

const KEY = "tractus.tips";
export interface TipState {
  seen: string[];
  off: boolean;
}
const EMPTY: TipState = { seen: [], off: false };

export function readTips(): TipState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TipState> | null;
    return { seen: Array.isArray(v?.seen) ? v.seen.filter((x) => typeof x === "string") : [], off: v?.off === true };
  } catch {
    return EMPTY;
  }
}
function writeTips(s: TipState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 저장소가 막혀 있으면 이번 실행 동안만 기억한다 */
  }
}

/** 이 안내를 보여도 되는가 (아직 안 봤고, 안내를 끄지 않았다) */
export const wants = (s: TipState, id: string) => !s.off && !s.seen.includes(id);

// 한 번에 하나: 먼저 보일 준비가 된 안내가 자리를 잡고, 닫히면 다음 안내가 이어 받는다
let state: TipState = readTips();
let active: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function seeTip(id: string) {
  state = { ...state, seen: [...new Set([...state.seen, id])] };
  writeTips(state);
  if (active === id) active = null;
  emit();
}
export function tipsOff(off = true) {
  state = { ...state, off };
  writeTips(state);
  if (off) active = null;
  emit();
}
/** 설정의 `다시 보기`: 본 안내를 잊고 다시 켠다 */
export function resetTips() {
  state = EMPTY;
  writeTips(state);
  active = null;
  emit();
}

/** 이 안내를 아직 보여야 하는가 (봤거나 안내를 끄면 false로 바뀐다). CoachMark가 쓸모없는 자리 찾기를 멈추는 데 쓴다 */
export function useWanted(id: TipId): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  return wants(state, id);
}

/** ready: 이 안내의 자리(요소)가 지금 화면에 있다. show면 그린다 */
export function useTip(id: TipId, ready: boolean): boolean {
  const [n, tick] = useState(0); // 바뀔 때마다(다른 안내가 닫힘 등) 아래 effect가 다시 돌아 빈 자리를 이어 받는다
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  const eligible = ready && wants(state, id);
  // 자리 잡기: 빈 자리가 나면(n이 바뀌면) 다시 본다. 놓기는 아래 effect만 한다 (여기서 놓으면 잡기·놓기가 서로를 다시 부른다)
  useEffect(() => {
    if (eligible && active === null) {
      active = id;
      emit();
    }
  }, [eligible, id, n]);
  useEffect(
    () => () => {
      if (active === id) {
        active = null;
        emit();
      }
    },
    [eligible, id],
  );
  return eligible && active === id;
}
