// 첫 화면 (App에서 옮김, 동작 그대로): 시작 점검·곧 시작하는 일정 카드·만들기 카드·최근 노트.
import { useEffect, useMemo, useState } from "react";
import { type CalendarEvent, type MeetingInfo } from "../../api";
import { attendeeLine, CARD_LABEL, CARD_RECORD, eventWhen, useNextEvent } from "../../calendar";
import { CoachMark } from "../../CoachMark";
import { OnboardingCard } from "../../OnboardingCard";
import { onboardSteps, showOnboard, useOnboard, type StepId } from "../../onboarding";
import { CHECKUP_LABEL, MODELS_LABEL, type Decision } from "../../caps";
import { GatedButton } from "../../GatedButton";
import { useCapabilities } from "../../useCapabilities";
import { locale, t } from "../../i18n";
import type { NewNoteAction } from "../../menu";
import { isMemo, noteTime } from "../../memo";
import { AudioLines, Box, CalendarClock, ChevronRight, FileText, Mic, SquarePen, Stethoscope, Upload } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { FlickeringGrid } from "@/components/ui/flickering-grid";

const RECENT_MAX = 6;

export function Welcome({ notes, onOpen, onAction, onRecordEvent, onSample, recordGate, convertGate, recording }: { notes: MeetingInfo[]; onOpen: (id: string) => void; onAction: (a: NewNoteAction) => void; onRecordEvent: (ev: CalendarEvent) => void; onSample: () => void; recordGate: Decision; convertGate: Decision; recording: boolean }) {
  const caps = useCapabilities();
  const { openCheckup, openModels } = caps;
  const next = useNextEvent();
  const onboard = useOnboard();
  const steps = onboardSteps(onboard, notes, caps.can("convert").ok);
  const checklist = showOnboard(onboard, steps);
  const onStep = (id: StepId) => (id === "models" ? openModels() : id === "record" ? onAction("record") : onSample());
  const recent = useMemo(() => [...notes].sort((a, b) => (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)).slice(0, RECENT_MAX), [notes]);
  const keys: [string[], string][] = [
    [["⌘N"], t("글쓰기 (새 메모)")],
    [["⌘K"], t("노트·동작 찾기")],
    [["Space"], t("재생 / 일시정지")],
    [["B"], t("녹음 중 북마크")],
    [["←", "→"], t("5초 이동 (Shift 10초)")],
    [["R"], t("직전 문장 다시 듣기")],
    [["⌘F"], t("찾아 바꾸기")],
    [["⌘J"], t("AI 어시스턴트")],
    [["⌘B"], t("노트 목록 접기·펼치기")],
    [["⌥⌘B"], t("오른쪽 패널 접기·펼치기")],
  ];
  const action = "flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-4 text-left outline-none transition-colors hover:border-border-strong hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40 gated:opacity-50 [&_svg]:size-5";
  return (
    <section className="relative isolate flex h-full flex-col overflow-y-auto">
      <FlickeringGrid className="absolute inset-x-0 top-0 -z-10 h-[360px] [mask-image:radial-gradient(ellipse_70%_100%_at_50%_0%,black_20%,transparent_75%)]" />
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-8 pt-10 pb-16">
        <h1 className="sr-only">{t("홈")}</h1>
        {notes.length === 0 && <p className="m-0 text-[15px] font-medium">{t("녹음하거나 메모를 써서 노트를 만드세요. 녹음은 이 Mac에서 텍스트로 변환되고, 파일로 남습니다.")}</p>}

        {next && <NextEventCard ev={next} gate={recordGate} recording={recording} onRecord={() => onRecordEvent(next)} />}
        {checklist && <OnboardingCard steps={steps} onStep={onStep} />}
        {/* 홈의 안내는 시작하기 목록을 마치거나 닫은 뒤에 (목록을 가리지 않게) */}
        <CoachMark id="ask" side="right" ready={!checklist && notes.some((n) => !n.sample)} />
        {next && <CoachMark id="calendar" ready={!checklist} />}

        <div className="grid grid-cols-3 gap-3">
          <GatedButton gate={recordGate} className={action} disabled={recording} onClick={() => onAction("record")}>
            <span className="grid size-9 place-items-center rounded-full bg-rec-wash text-rec">
              <Mic aria-hidden />
            </span>
            <span className="text-[13px] font-medium">{t("녹음 시작")}</span>
          </GatedButton>
          <button type="button" className={action} onClick={() => onAction("write")}>
            <span className="grid size-9 place-items-center rounded-full bg-memo-wash text-memo">
              <SquarePen aria-hidden />
            </span>
            <span className="flex w-full items-center justify-between text-[13px] font-medium">
              {t("글쓰기")} <Kbd>⌘N</Kbd>
            </span>
          </button>
          <GatedButton gate={convertGate} className={action} onClick={() => onAction("import")}>
            <span className="grid size-9 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Upload aria-hidden />
            </span>
            <span className="text-[13px] font-medium">{t("파일 가져오기")}</span>
          </GatedButton>
        </div>

        {recent.length > 0 && (
          <section aria-labelledby="recent-title" className="flex flex-col gap-2">
            <h2 id="recent-title" className="m-0 px-1 text-[13px] font-semibold">
              {t("최근 노트")}
            </h2>
            <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0">
              {recent.map((m) => (
                <li key={m.id}>
                  <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left outline-none hover:bg-accent/60 focus-visible:bg-accent" onClick={() => onOpen(m.id)}>
                    {isMemo(m) ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <AudioLines className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{m.title || t("제목 없음")}</span>
                    <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
                      {new Date(m.updated_at ?? m.created_at).toLocaleDateString(locale(), { month: "short", day: "numeric" })} · {noteTime(m)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <details className="group rounded-lg border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-2.5 text-[13px] font-semibold select-none">
            {t("단축키")}
            <ChevronRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border px-4 py-3 text-[13px]">
            {keys.map(([ks, label]) => (
              <div key={label} className="flex items-center gap-3">
                <dt className="flex w-16 shrink-0 gap-0.5">
                  {ks.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </dt>
                <dd className="m-0 text-muted-foreground">{label}</dd>
              </div>
            ))}
          </dl>
        </details>

        <p className="m-0 flex gap-2">
          <Button variant="outline" size="sm" onClick={openCheckup}>
            <Stethoscope aria-hidden />
            {CHECKUP_LABEL}
          </Button>
          <Button variant="outline" size="sm" onClick={openModels}>
            <Box aria-hidden />
            {MODELS_LABEL}
          </Button>
        </p>
      </div>
    </section>
  );
}

/** 홈: 진행 중이거나 15분 안에 시작하는 캘린더 일정 하나 (calendar.ts) */
function NextEventCard({ ev, gate, recording, onRecord }: { ev: CalendarEvent; gate: Decision; recording: boolean; onRecord: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const people = attendeeLine(ev.attendees);
  return (
    <section aria-label={CARD_LABEL} data-tip="calendar" className="flex items-center gap-4 rounded-lg border border-border bg-card/90 p-4 shadow-xs backdrop-blur-sm">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-rec-wash text-rec">
        <CalendarClock className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-xs font-medium text-muted-foreground tabular-nums">{eventWhen(ev, now)}</p>
        <p className="m-0 truncate text-[15px] font-semibold leading-6" title={ev.title}>
          {ev.title}
        </p>
        {people && <p className="m-0 truncate text-xs text-subtle-foreground">{people}</p>}
      </div>
      <GatedButton gate={gate} className={buttonVariants({ variant: "rec", size: "sm" })} disabled={recording} onClick={onRecord}>
        <Mic aria-hidden />
        {CARD_RECORD}
      </GatedButton>
    </section>
  );
}
