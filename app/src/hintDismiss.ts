// 노트마다 한 번만 보이는 안내를 닫았는지 (참석자 구분 모델이 없다는 한 줄). 사용자별 편의라 localStorage에 둔다:
// 막히거나 비어 있어도(개인정보 보호 창 등) 안내가 그냥 다시 보일 뿐이다.
export const speakerHintKey = (noteId: string): string => `tractus.hint.speakers.${noteId}`;

type Store = Pick<Storage, "getItem" | "setItem">;

const defaultStore = (): Store | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function isDismissed(key: string, store: Store | null = defaultStore()): boolean {
  try {
    return store?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function dismiss(key: string, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(key, "1");
  } catch {
    // 저장하지 못하면 이번 화면에서만 닫힌다
  }
}
