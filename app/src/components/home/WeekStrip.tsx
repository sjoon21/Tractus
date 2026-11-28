// 홈의 `이번 주` 띠 (WORDS.md §4.31): 월~일 7칸에 날마다 캘린더 일정·노트 개수, 고른 날의 목록(일정 → 녹음, 노트 → 열기). 규칙은 week.ts
import { Fragment, useEffect, useMemo, useState } from "react";
import { AudioLines, CalendarDays, ChevronLeft, ChevronRight, FileText, Mic, SquarePen } from "lucide-react";
import type { CalendarEvent, MeetingInfo } from "../../api";
import { ADD_TITLE } from "../../attach";
import { attendeeLine, CARD_RECORD, PREPARE_MEMO } from "../../calendar";
import type { Decision } from "../../caps";
import { GatedButton } from "../../GatedButton";
import { clock, t } from "../../i18n";
import { dayParts } from "../../lib";
import { isMemo, noteTime } from "../../memo";
import { isWindows } from "../../platform";
import { addDays, dayNotes, eventAction, groupWeek, preparable, recordable, weekDays, weekStart, ymd, useWeekEvents, type DayEvent } from "../../week";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";

const DOTS = 3; // 칸에 찍는 점의 최대 수 (넘으면 숫자)
const hm = (iso: string) => {
  const d = new Date(iso);
  return clock(d.getHours(), d.getMinutes());
};

export function WeekStrip({ notes, onOpen, onRecordEvent, onPrepareEvent, recordGate, recording, hero }: { notes: readonly MeetingInfo[]; /** 홈 위쪽 곧 시작하는 일정 칸에 이미 녹음 단추가 있는 일정: 그 줄에서는 단추를 빼 같은 동작을 두 번 두지 않는다 */ hero?: CalendarEvent | null; onOpen: (id: string) => void; onRecordEvent: (ev: CalendarEvent) => void; onPrepareEvent: (ev: CalendarEvent) => void; recordGate: Decision; recording: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const today = ymd(now);
  const [offset, setOffset] = useState(0); // 이번 주에서 몇 주 떨어졌는가
  const from = ymd(addDays(weekStart(now), offset * 7));
  const days = useMemo(() => weekDays(new Date(`${from}T00:00:00`)), [from]);
  const events = useWeekEvents(from);
  const week = useMemo(() => groupWeek(days, events, notes), [days, events, notes]);
  const [picked, setPicked] = useState(today);
  const day = days.includes(picked) ? picked : days[0];
  const cur = week.get(day)!;
  const p = dayParts(day);
  const range = `${dayParts(days[0]).day}–${dayParts(days[6]).day}`;
  /** 다른 주로: 이번 주면 오늘, 아니면 그 주 월요일을 고른다 */
  const move = (to: number) => {
    setOffset(to);
    setPicked(to === 0 ? today : ymd(addDays(weekStart(now), to * 7)));
  };

  return (
    <section aria-labelledby="week-title" className="flex flex-col gap-2">
      <div className="flex items-center gap-1 px-1">
        <h2 id="week-title" className="m-0 flex-1 text-[13px] font-semibold">
          {offset === 0 ? t("이번 주") : t("{month} {range}일", { month: dayParts(days[0]).month, range })}
        </h2>
        {offset !== 0 && (
          <Button variant="ghost" size="sm" onClick={() => move(0)}>
            {t("이번 주")}
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t("지난주")} title={t("지난주")} onClick={() => move(offset - 1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label={t("다음 주")} title={t("다음 주")} onClick={() => move(offset + 1)}>
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div role="group" aria-label={t("요일")} className="grid grid-cols-7 border-b border-border">
          {days.map((d) => {
            const g = week.get(d)!;
            const dp = dayParts(d);
            const isToday = d === today;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={d === day}
                aria-label={t("{day}일 {weekday}요일 · 일정 {e} · 노트 {n}", { day: dp.day, weekday: dp.weekday, e: g.events.length, n: dayNotes(g) })}
                className={cn("flex flex-col items-center gap-1 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", d === day && "bg-accent")}
                onClick={() => setPicked(d)}
              >
                <span className={cn("text-[11px] text-subtle-foreground", isToday && "font-semibold text-rec-ink")}>{dp.weekday}</span>
                <span className={cn("grid size-7 place-items-center rounded-full text-[13px] font-semibold tabular-nums", isToday && "bg-rec-strong text-white")}>{dp.day}</span>
                <span className="flex h-2 items-center gap-0.5" aria-hidden>
                  <Dots n={g.events.length} className="bg-primary" />
                  <Dots n={dayNotes(g)} className="bg-muted-foreground/50" />
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-col">
          <p className="m-0 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">{t("{day}일 {weekday}요일", { day: p.day, weekday: p.weekday })}</p>
          {!cur.events.length && !cur.notes.length && <p className="m-0 px-4 pt-1 pb-4 text-[13px] text-subtle-foreground">{isWindows() ? t("노트가 없습니다") : t("일정과 노트가 없습니다")}</p>}
          <ul className="m-0 list-none p-0 pb-1.5">
            {cur.events.map((ev) => (
              <Fragment key={`${ev.id}-${ev.start}`}>
                <EventRow ev={ev} now={now} gate={recordGate} recording={recording} noRecord={!!hero && hero.id === ev.id && hero.start === ev.start} onRecord={() => onRecordEvent(ev)} onPrepare={() => onPrepareEvent(ev)} />
                {ev.notes.map((m) => (
                  <NoteLine key={m.id} m={m} onOpen={onOpen} inEvent />
                ))}
              </Fragment>
            ))}
            {cur.notes.map((m) => (
              <NoteLine key={m.id} m={m} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** 노트 줄. inEvent: 위 일정으로 녹음한 노트 (일정 줄 아래에 들여 쓴다) */
function NoteLine({ m, onOpen, inEvent = false }: { m: MeetingInfo; onOpen: (id: string) => void; inEvent?: boolean }) {
  return (
    <li>
      <button type="button" className={cn("flex w-full items-center gap-3 py-2 pr-4 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", inEvent ? "pl-11" : "pl-4")} onClick={() => onOpen(m.id)}>
        {isMemo(m) ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-[13px]">{m.title || t("제목 없음")}</span>
        <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">{noteTime(m)}</span>
      </button>
    </li>
  );
}

/** 칸의 점: 3개까지는 점, 넘으면 `+n` */
function Dots({ n, className }: { n: number; className: string }) {
  if (!n) return null;
  return (
    <>
      {Array.from({ length: Math.min(n, DOTS) }, (_, i) => (
        <span key={i} className={cn("size-1.5 rounded-full", className)} />
      ))}
      {n > DOTS && <span className="text-[11px] leading-none text-subtle-foreground">+{n - DOTS}</span>}
    </>
  );
}

/** 일정 줄. 이어진 노트가 없으면 `메모 준비`(끝나지 않은 일정), 녹음 단추는 오늘 일정만. 준비한 메모가 있으면 녹음은 그 노트에 추가된다 (week.eventAction) */
export function EventRow({ ev, now, gate, recording, noRecord, onRecord, onPrepare }: { ev: DayEvent; now: Date; gate: Decision; recording: boolean; noRecord?: boolean; onRecord: () => void; onPrepare: () => void }) {
  const people = attendeeLine(ev.attendees);
  const act = eventAction(ev, ev.notes);
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <CalendarDays className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-[86px] shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">{ev.all_day ? t("종일") : `${hm(ev.start)}–${hm(ev.end)}`}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium" title={ev.title}>
          {ev.title}
        </span>
        {people && <span className="block truncate text-xs text-subtle-foreground">{people}</span>}
      </span>
      {act.kind === "prepare" && preparable(ev, now) && (
        <Button variant="ghost" size="sm" onClick={onPrepare}>
          <SquarePen aria-hidden />
          {PREPARE_MEMO}
        </Button>
      )}
      {!noRecord && recordable(ev, now) && (
        <GatedButton gate={gate} className={buttonVariants({ variant: "outline", size: "sm" })} disabled={recording} title={act.kind === "record-into" ? ADD_TITLE : undefined} onClick={onRecord}>
          <Mic aria-hidden />
          {CARD_RECORD}
        </GatedButton>
      )}
    </li>
  );
}
