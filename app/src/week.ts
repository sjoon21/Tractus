// 홈의 `이번 주` 띠 (WORDS.md §4.31): 월요일부터 7일, 날마다 캘린더 일정과 그날 만든 노트. 화면은 components/home/WeekStrip.tsx
import { useEffect, useState } from "react";
import { api, type CalendarEvent, type MeetingInfo } from "./api";
import { POLL_MS } from "./calendar";

/** 이 Mac 시간대의 날짜 "YYYY-MM-DD" */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** d가 든 주의 월요일 0시 */
export function weekStart(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

/** 첫날부터 n일 뒤 (달력으로 센다: 서머타임이 있어도 0시) */
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** 주의 7일 "YYYY-MM-DD" */
export const weekDays = (start: Date): string[] => Array.from({ length: 7 }, (_, i) => ymd(addDays(start, i)));

export type WeekEvent = CalendarEvent & { all_day?: boolean };
/** 일정 + 그 일정으로 녹음한 노트 (이른 것부터) */
export type DayEvent = WeekEvent & { notes: MeetingInfo[] };
/** notes: 일정에 이어지지 않은 그날의 노트 */
export type Day = { events: DayEvent[]; notes: MeetingInfo[] };

/** 이 일정으로 시작한 노트인가: 시작 시각이 같고, 일정 ID가 같다 (ID를 남기기 전의 노트는 제목이 같다) */
export function linked(ev: WeekEvent, n: Pick<MeetingInfo, "event">): boolean {
  const e = n.event;
  if (!e || new Date(e.start).getTime() !== new Date(ev.start).getTime()) return false;
  return e.id ? e.id === ev.id : e.title === ev.title;
}

/** 일정이 걸친 날들 (시작 날부터 끝나기 직전까지. 종일 일정의 끝은 다음 날 0시라 그날은 빼진다) */
function eventDays(ev: WeekEvent): string[] {
  const start = new Date(ev.start);
  const last = new Date(Math.max(start.getTime(), new Date(ev.end).getTime() - 1));
  const out: string[] = [];
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= last && out.length < 31; d = addDays(d, 1)) out.push(ymd(d));
  return out;
}

/** 날마다 일정(시작 순, 받은 순서)과 그 일정의 노트, 일정에 이어지지 않은 그날 만든 노트(created_at의 날짜 = 노트의 현지 날짜, 이른 것부터) */
export function groupWeek(days: readonly string[], events: readonly WeekEvent[], notes: readonly MeetingInfo[]): Map<string, Day> {
  const map = new Map(days.map((d) => [d, { events: [], notes: [] } as Day]));
  const sorted = [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const withEvent = sorted.filter((n) => n.event);
  const taken = new Set<string>();
  for (const ev of events) {
    const mine = withEvent.filter((n) => linked(ev, n));
    for (const n of mine) taken.add(n.id);
    for (const d of eventDays(ev)) map.get(d)?.events.push({ ...ev, notes: mine });
  }
  for (const n of sorted) if (!taken.has(n.id)) map.get(n.created_at.slice(0, 10))?.notes.push(n);
  return map;
}

/** 그날의 노트 수 (일정에 이어진 것 포함) */
export const dayNotes = (d: Day) => d.notes.length + d.events.reduce((k, e) => k + e.notes.length, 0);

/** 목록에서 `이 일정으로 녹음`을 보일 일정: 오늘 시작하고 아직 끝나지 않은, 종일이 아닌 일정 */
export const recordable = (ev: WeekEvent, now: Date) => !ev.all_day && ymd(new Date(ev.start)) === ymd(now) && new Date(ev.end) > now;

/** 그 주의 캘린더 일정. 연결하지 않았거나 실패하면 빈 목록 (띠는 노트만 보인다). 1분마다, 창이 다시 보일 때 다시 읽는다 */
export function useWeekEvents(from: string): WeekEvent[] {
  const [events, setEvents] = useState<WeekEvent[]>([]);
  useEffect(() => {
    let on = true;
    const load = () => void api.calendarWeek(from).then((list) => on && setEvents(list), () => on && setEvents([]));
    load();
    const id = setInterval(load, POLL_MS);
    const vis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", vis);
    return () => {
      on = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [from]);
  return events;
}
