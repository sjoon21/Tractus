// 기능 사용 가능 여부를 앱 전체가 같이 본다 (caps.ts의 decide). App이 한 번 만들어 CapsContext로 내려 주고, 화면은 useCapabilities()로 읽는다.
// 점검(`doctor`)은 시작할 때, 받기·지우기·설정 저장 뒤에, 창으로 돌아올 때(디바운스) 다시 한다. 점검이 실패하면 모두 쓸 수 있다고 본다.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { decide, OK, type CapId, type Decision, type DoctorCap, type DoctorReport, type Fix } from "./caps";

export interface CapsValue {
  loading: boolean;
  report: DoctorReport | null;
  /** 코어가 알린 기능 목록 (점검을 못 읽으면 빈 목록) */
  caps: DoctorCap[];
  can: (id: CapId) => Decision;
  refresh: () => Promise<void>;
  openModels: () => void;
  openCheckup: () => void;
  /** 이유 옆의 고치는 단추: 모델 화면·시작 점검·설정 중 맞는 곳으로 간다 */
  fixAction: (fix: Fix) => void;
}

const NOOP = () => {};
/** Provider가 없을 때(테스트·고립된 화면): 모두 쓸 수 있다 */
const DEFAULT: CapsValue = { loading: false, report: null, caps: [], can: () => OK, refresh: async () => {}, openModels: NOOP, openCheckup: NOOP, fixAction: NOOP };

export const CapsContext = createContext<CapsValue>(DEFAULT);
export const useCapabilities = (): CapsValue => useContext(CapsContext);

/** 창으로 돌아올 때 다시 점검하는 최소 간격 (점검은 코어를 띄우는 일이라 자주 하지 않는다) */
export const FOCUS_REFRESH_GAP_MS = 5000;
export const FOCUS_DEBOUNCE_MS = 600;

/** 포커스로 다시 점검할 때가 되었는가: 마지막 점검 뒤 gap이 지났고 진행 중인 점검이 없을 때 */
export const focusRefreshDue = (lastAt: number, now: number, inFlight: boolean, gap = FOCUS_REFRESH_GAP_MS): boolean => !inFlight && now - lastAt >= gap;

export function useCapabilitiesState(actions: { openModels: () => void; openCheckup: () => void; openSettings: () => void }): CapsValue {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastAt = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current; // 겹치면 돌고 있는 점검을 기다린다
    const p = api
      .doctor()
      .then(setReport, () => setReport(null)) // 점검을 못 하면 막지 않는다
      .finally(() => {
        lastAt.current = Date.now();
        inFlight.current = null;
        setLoading(false);
      });
    inFlight.current = p;
    return p;
  }, []);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      clearTimeout(timer);
      timer = setTimeout(() => focusRefreshDue(lastAt.current, Date.now(), inFlight.current !== null) && void refresh(), FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const { openModels, openCheckup, openSettings } = actions;
  const fixAction = useCallback(
    (fix: Fix) => (fix.kind === "models" ? openModels() : fix.kind === "checkup" ? openCheckup() : openSettings()),
    [openModels, openCheckup, openSettings],
  );
  const can = useCallback((id: CapId) => decide(report, id), [report]);
  return useMemo(
    () => ({ loading, report, caps: report?.doctor?.capabilities ?? [], can, refresh, openModels, openCheckup, fixAction }),
    [loading, report, can, refresh, openModels, openCheckup, fixAction],
  );
}
