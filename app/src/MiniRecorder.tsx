// 녹음 미니 창 (mini.rs, 창 `mini`): 녹음 중 다른 앱을 쓰는 동안 화면 구석에 떠 있는 작은 녹음 막대.
// 녹음 점·녹음 시각·소리 크기 | 북마크·일시정지·종료. 빈 곳을 끌면 창이 움직이고, 시각을 누르면 Tractus 창이 열린다.
// 상태와 단추는 메뉴 막대 팝오버와 같은 길이다 (`tray_popover_state`·`tray-popover` 이벤트·`tray_popover_action`).
// 시각은 화면 타이머로 센다: 이 창은 보일 때만 돌고, 보이는 창의 타이머는 늦지 않는다 (숨은 메인 창과 다르다)
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Bookmark, Pause, Play, Square } from "lucide-react";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { levelFraction, type RecEvent } from "./lib";
import { PAUSE_LABEL, PAUSE_TITLE, RESUME_LABEL, RESUME_TITLE } from "./pause";
import { applyTheme, readTheme } from "./themePref";
import { clock, EMPTY_POPOVER, popoverSeconds, type PopoverState } from "./TrayPopover";

export const MINI_OPEN_TITLE = t("Tractus 열기");

/** 두 트랙 중 큰 소리 (0..1). 소리가 없거나 일시정지면 0 */
export const miniLevel = (mic: number | null, system: number | null): number => Math.max(levelFraction(mic), levelFraction(system));

const BARS = 5;
/** 가운데가 높은 막대 다섯 개: 소리 크기에 막대마다 다른 비율을 곱한다 */
const SHAPE = [0.55, 0.8, 1, 0.8, 0.55];

export function MiniRecorderView({ state, nowMs, level, onAction }: { state: PopoverState; nowMs: number; level: number; onAction: (id: string) => void }) {
  const sec = popoverSeconds(state, nowMs);
  const paused = state.phase === "paused";
  const stop = t("녹음 종료");
  const bookmark = t("북마크 남기기");
  const round = "grid size-7 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 off:pointer-events-none off:opacity-40 [&_svg]:size-3.5";
  const quiet = cn(round, "text-foreground hover:bg-accent");
  return (
    <div data-tauri-drag-region className="flex h-11 items-center gap-1 rounded-full border border-border bg-popover pr-1.5 pl-3 text-popover-foreground shadow-pop">
      <button
        type="button"
        className="flex shrink-0 items-center gap-2 rounded-md text-[15px] whitespace-nowrap font-semibold tracking-tight tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        onClick={() => onAction("tray:open")}
        title={MINI_OPEN_TITLE}
        aria-label={MINI_OPEN_TITLE}
      >
        <span className={cn("size-2 shrink-0 rounded-full bg-rec", paused ? "opacity-40" : "animate-rec-pulse")} aria-hidden />
        <span className={paused ? "text-muted-foreground" : undefined}>{clock(sec ?? 0)}</span>
      </button>
      {/* 소리 크기: 마이크가 듣고 있다는 신호. 끌기 영역에 속한다 */}
      <span data-tauri-drag-region className="mx-1.5 flex h-5 flex-1 items-center justify-center gap-[3px]" aria-hidden>
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} className="w-[3px] rounded-full bg-muted-foreground/70 transition-[height] duration-200" style={{ height: `${Math.max(3, Math.round(20 * (paused ? 0 : level) * SHAPE[i]))}px` }} />
        ))}
      </span>
      <button type="button" className={quiet} onClick={() => onAction("tray:bookmark")} disabled={!state.can.bookmark} aria-label={bookmark} title={bookmark}>
        <Bookmark aria-hidden />
      </button>
      <button type="button" className={quiet} onClick={() => onAction(paused ? "tray:record_resume" : "tray:record_pause")} disabled={paused ? !state.can.resume : !state.can.pause} aria-label={paused ? RESUME_LABEL : PAUSE_LABEL} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
        {paused ? <Play aria-hidden className="fill-current" /> : <Pause aria-hidden className="fill-current" />}
      </button>
      <button type="button" className={cn(round, "bg-rec text-white hover:bg-rec/90")} onClick={() => onAction("tray:record_stop")} disabled={!state.can.stop} aria-label={stop} title={stop}>
        <Square aria-hidden className="size-3! fill-current" />
      </button>
    </div>
  );
}

/** 미니 창 전체: 상태·소리 크기를 받고 1초마다 시각을 고친다 */
export function MiniRecorder() {
  const [state, setState] = useState<PopoverState>(EMPTY_POPOVER);
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState(0);

  useEffect(() => {
    void invoke<PopoverState>("tray_popover_state").then(setState, () => {});
    const un = listen<PopoverState>("tray-popover", (e) => {
      setState(e.payload);
      applyTheme(readTheme()); // 다시 보일 때마다 설정의 테마를 따른다
    });
    const unRec = listen<RecEvent>("rec", ({ payload: ev }) => {
      if (ev.event === "level") setLevel(miniLevel(ev.mic, ev.system));
      else if (ev.event === "paused" || ev.event === "stopped") setLevel(0);
    });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      void un.then((f) => f());
      void unRec.then((f) => f());
      window.clearInterval(timer);
    };
  }, []);

  return (
    // 카드 그림자가 잘리지 않게 창 가장자리에 여백을 둔다 (창 크기는 mini.rs)
    <div data-tauri-drag-region className="p-1.5">
      <MiniRecorderView state={state} nowMs={now} level={level} onAction={(id) => void invoke("tray_popover_action", { id })} />
    </div>
  );
}
