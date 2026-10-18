// macOS 캘린더 (docs/design/calendar.md, WORDS.md §4.24): 홈의 `곧 시작하는 일정` 카드와 설정 문구.
import { useEffect, useState } from "react";
import { api, type CalendarEvent } from "./api";
import { t } from "./i18n";

export const POLL_MS = 60_000;
export const CAL_SECTION = t("캘린더");
export const CAL_CONNECT = t("캘린더 연결");
export const CAL_CONNECT_HINT = t("곧 시작하는 일정을 홈에 보여 주고, 그 일정 제목과 참석자 이름으로 녹음합니다. 일정은 이 Mac에서만 읽습니다.");
export const CAL_DISCONNECT = t("연결 끊기");
export const CAL_DENIED = t("캘린더 접근이 거부되어 있습니다. 시스템 설정에서 Tractus를 허용하세요.");
export const CAL_PRIVACY = t("시스템 설정 열기");
/** 요청했는데 권한 창이 뜨지 않았다 (터미널에서 띄운 개발용 앱 등 macOS가 묻지 않은 경우) */
export const CAL_NO_PROMPT = t("macOS가 권한 창을 띄우지 않았습니다. 시스템 설정 › 개인정보 보호 및 보안 › 캘린더에서 Tractus를 허용하세요.");
export const CAL_LIST_HINT = t("끈 캘린더의 일정은 홈에 보이지 않습니다.");
export const CARD_LABEL = t("곧 시작하는 일정");
export const CARD_RECORD = t("이 일정으로 녹음");

const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** `10:00–11:00 · 진행 중` / `· 5분 뒤` / `· 곧 시작` */
export function eventWhen(ev: Pick<CalendarEvent, "start" | "end">, now: Date): string {
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const min = Math.ceil((s.getTime() - now.getTime()) / 60_000);
  const rel = min <= 0 ? t("진행 중") : min === 1 ? t("곧 시작") : t("{n}분 뒤", { n: min });
  return `${hm(s)}–${hm(e)} · ${rel}`;
}

/** 참석자 줄: `김민수, 이지은 외 3명`. 없으면 null */
export function attendeeLine(names: string[], show = 2): string | null {
  if (names.length === 0) return null;
  const head = names.slice(0, show).join(", ");
  return names.length > show ? t("{names} 외 {n}명", { names: head, n: names.length - show }) : head;
}

/** 곧 시작하는 일정 하나 (연결하지 않았거나 없으면 null). 1분마다, 창이 다시 보일 때 다시 읽는다. 실패는 조용히 null (홈 카드는 덤이다) */
export function useNextEvent(): CalendarEvent | null {
  const [ev, setEv] = useState<CalendarEvent | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => void api.calendarNext().then((list) => on && setEv(list[0] ?? null), () => on && setEv(null));
    load();
    const id = setInterval(load, POLL_MS);
    const vis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      on = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return ev;
}
