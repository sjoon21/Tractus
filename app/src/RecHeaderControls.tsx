// 녹음 화면 밖에서도 창 위쪽에서 녹음을 멈추고 끝내는 가로 막대 (녹음 점 + 녹음 시각 | 일시정지 ↔ 계속, 녹음 종료).
// 녹음 화면에는 같은 단추가 글자와 함께 있으므로 App이 그 화면에서는 그리지 않는다. 동작은 녹음 화면·메뉴 막대와 같은 sendRec이다.
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { fmtTime, isRecLive, type RecPhase } from "./lib";
import { PAUSE_LABEL, PAUSE_TITLE, RESUME_LABEL, RESUME_TITLE } from "./pause";

type Send = (cmd: "stop" | "pause" | "resume") => Promise<void>;

/** seconds: 녹음 시각(일시정지한 시간은 빠진다). 사이드바 녹음 단추와 같은 값 */
export function RecHeaderControls({ phase, seconds, send }: { phase: RecPhase; seconds: number; send: Send }) {
  if (!isRecLive(phase)) return null;
  const paused = phase === "paused";
  const stop = t("녹음 종료");
  return (
    <div className="absolute top-[8px] left-1/2 z-40 flex h-9 -translate-x-1/2 items-center gap-4 rounded-lg border border-border bg-background/90 py-1 pr-1 pl-3.5 shadow-pop backdrop-blur-md">
      {/* 사이드바 녹음 단추와 같은 점: 녹음 중에는 깜빡이고, 일시정지 중에는 멈춰 옅어진다 (시계도 함께 멈춘다) */}
      <span className={cn("flex min-w-[88px] items-center gap-2 text-[13px] font-medium tabular-nums", paused ? "text-muted-foreground" : "text-foreground")}>
        <span className={cn("size-2 shrink-0 rounded-full bg-rec", paused ? "opacity-40" : "animate-rec-pulse")} aria-hidden />
        {fmtTime(seconds)}
      </span>
      <span className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" onClick={() => void send(paused ? "resume" : "pause")} aria-label={paused ? RESUME_LABEL : PAUSE_LABEL} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
          {paused ? <Play aria-hidden className="fill-current" /> : <Pause aria-hidden className="fill-current" />}
        </Button>
        <Button variant="rec" size="icon-sm" onClick={() => void send("stop")} aria-label={stop} title={stop}>
          <Square aria-hidden className="fill-current" />
        </Button>
      </span>
    </div>
  );
}
