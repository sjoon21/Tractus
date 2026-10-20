// 메뉴 막대 아이콘을 왼쪽 클릭하면 뜨는 팝오버 (tray.rs `toggle_popover`, 창 `tray`).
// 맨 위 녹음 막대(녹음 점·녹음 시각 | 둥근 아이콘 단추), Tractus 열기·종료. 단추는 메뉴 항목과 같은 ID를 `tray_popover_action`으로 보낸다.
// 상태는 Rust가 보낸다(`tray_popover_state`·`tray-popover` 이벤트). 녹음 시각도 Rust 틱이 1초마다 보내는 이벤트로 고친다: 화면 타이머를 쓰지 않는다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { AppWindow, AudioLines, Bookmark, Pause, Play, Power, Square } from "lucide-react";
import { MENU, MENU_ITEM } from "@/components/menu";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { applyTheme, readTheme } from "./themePref";
import { PAUSE_LABEL, PAUSE_TITLE, RESUME_LABEL, RESUME_TITLE } from "./pause";

export type PopoverPhase = "idle" | "starting" | "recording" | "paused" | "converting";

/** tray.rs `popover_state` */
export interface PopoverState {
  phase: PopoverPhase;
  status: string;
  started_at_ms: number | null;
  elapsed_ms: number | null;
  /** 변환 중 진행률 0..100 (모르면 null) */
  progress_pct?: number | null;
  can: { start: boolean; pause: boolean; resume: boolean; stop: boolean; bookmark: boolean };
  recent: { id: string; label: string }[];
}

export const EMPTY_POPOVER: PopoverState = { phase: "idle", status: "", started_at_ms: null, elapsed_ms: null, can: { start: false, pause: false, resume: false, stop: false, bookmark: false }, recent: [] };

// tray.rs의 메뉴 항목 ID
const ID = { start: "tray:record_start", pause: "tray:record_pause", resume: "tray:record_resume", stop: "tray:record_stop", bookmark: "tray:bookmark", open: "tray:open", quit: "tray:quit" } as const;

/** 메뉴 막대 제목과 같은 모양: `00:16`, 한 시간이 넘으면 `1:02:03` (tray.rs `fmt_elapsed`) */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 녹음 시각(초). 녹음 중이면 시작 시각부터, 일시정지면 멈춘 값, 아니면 null */
export function popoverSeconds(s: PopoverState, nowMs: number): number | null {
  if (s.phase === "recording" && s.started_at_ms !== null) return Math.max(0, (nowMs - s.started_at_ms) / 1000);
  if (s.phase === "paused") return (s.elapsed_ms ?? 0) / 1000;
  return null;
}

export function TrayPopoverView({ state, nowMs, onAction }: { state: PopoverState; nowMs: number; onAction: (id: string) => void }) {
  const sec = popoverSeconds(state, nowMs);
  const paused = state.phase === "paused";
  const live = sec !== null;
  const converting = state.phase === "converting";
  const pct = state.progress_pct ?? null;
  const stop = t("녹음 종료");
  const bookmark = t("북마크 남기기");
  const start = t("녹음 시작");
  // 둥근 미디어 단추. 녹음 시작은 사이드바 녹음 단추와 같은 모양(어두운 원 + 빨간 점), 녹음 종료는 빨간 원 + 흰 네모
  const round = "grid size-9 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 off:pointer-events-none off:opacity-40 [&_svg]:size-4";
  const quiet = cn(round, "border border-border bg-background text-foreground hover:bg-accent");
  return (
    <div className={cn(MENU, "w-full")}>
      {/* 녹음 막대: 왼쪽 녹음 시각(또는 상태), 오른쪽 둥근 아이콘 단추 (글자 없음, 이름은 aria-label·title) */}
      <div className="flex items-center gap-3 px-2.5 pt-2 pb-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {live ? (
            <span className={cn("flex items-center gap-2 text-[22px] leading-7 font-semibold tracking-tight tabular-nums", paused ? "text-muted-foreground" : "text-foreground")}>
              <span className={cn("size-2.5 shrink-0 rounded-full bg-rec", paused ? "opacity-40" : "animate-rec-pulse")} aria-hidden />
              {clock(sec)}
            </span>
          ) : converting ? (
            <span className="flex items-center gap-2 text-[22px] leading-7 font-semibold tracking-tight tabular-nums">
              <AudioLines aria-hidden className="size-4 shrink-0 animate-pulse text-muted-foreground" />
              {pct === null ? "…" : `${pct}%`}
            </span>
          ) : null}
          <span className="truncate text-xs text-muted-foreground" title={state.status}>
            {live ? (paused ? t("일시정지됨") : t("녹음 중")) : converting ? t("텍스트로 변환 중") : state.status}
          </span>
        </div>
        {live ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <button type="button" className={quiet} onClick={() => onAction(ID.bookmark)} disabled={!state.can.bookmark} aria-label={bookmark} title={bookmark}>
              <Bookmark aria-hidden />
            </button>
            <button type="button" className={quiet} onClick={() => onAction(paused ? ID.resume : ID.pause)} disabled={paused ? !state.can.resume : !state.can.pause} aria-label={paused ? RESUME_LABEL : PAUSE_LABEL} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
              {paused ? <Play aria-hidden className="fill-current" /> : <Pause aria-hidden className="fill-current" />}
            </button>
            <button type="button" className={cn(round, "bg-rec text-white shadow-xs hover:bg-rec/90")} onClick={() => onAction(ID.stop)} disabled={!state.can.stop} aria-label={stop} title={stop}>
              <Square aria-hidden className="size-3.5! fill-current" />
            </button>
          </span>
        ) : converting && !state.can.start ? null : (
          // 변환 중에 녹음을 시작할 수 없으면 흐린 단추를 남기지 않는다 (진행률이 이 줄의 주인공)
          <button type="button" className={cn(round, "bg-primary shadow-xs hover:bg-primary/85")} onClick={() => onAction(ID.start)} disabled={!state.can.start} aria-label={start} title={start}>
            <span className="size-3 rounded-full bg-rec" aria-hidden />
          </button>
        )}
      </div>
      {converting && <Progress value={pct === null ? null : pct / 100} className="mx-2.5 mb-3" />}
      <div className="-mx-1 mb-1 h-px bg-border" role="separator" />
      <button type="button" className={MENU_ITEM} onClick={() => onAction(ID.open)}>
        <AppWindow aria-hidden />
        {t("Tractus 열기")}
      </button>
      <button type="button" className={MENU_ITEM} onClick={() => onAction(ID.quit)}>
        <Power aria-hidden />
        {t("종료")}
      </button>
    </div>
  );
}

/** 팝오버 창 전체: 상태를 받고, 내용 높이에 창을 맞추고, Esc로 닫고, 열릴 때마다 설정의 테마를 다시 읽는다 */
export function TrayPopover() {
  const [state, setState] = useState<PopoverState>(EMPTY_POPOVER);
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void invoke<PopoverState>("tray_popover_state").then(setState, () => {});
    const un = listen<PopoverState>("tray-popover", (e) => {
      setState(e.payload);
      setNow(Date.now());
    });
    return () => void un.then((f) => f());
  }, []);

  // 설정에서 테마를 바꿔도 팝오버 창은 살아 있다: 포커스를 받을 때(열릴 때)마다 같은 저장소의 선택을 다시 적용한다
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) applyTheme(readTheme());
    });
    return () => void un.then((f) => f());
  }, []);

  // 창 높이 = 내용 높이 (폭은 tray.rs가 정한다)
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => void getCurrentWindow().setSize(new LogicalSize(window.innerWidth, Math.ceil(el.getBoundingClientRect().height))).catch(() => {});
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void invoke("tray_popover_hide");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    // 카드 그림자(shadow-pop)가 잘리지 않게 창 좌우·아래에 여백을 둔다.
    // 위쪽 여백은 두지 않는다: 카드가 메뉴 막대 바로 아래에 붙는다 (좌우 여백 8pt는 tray.rs POPOVER_PAD)
    <div ref={box} className="px-2 pb-4">
      <TrayPopoverView state={state} nowMs={now} onAction={(id) => void invoke("tray_popover_action", { id })} />
    </div>
  );
}
