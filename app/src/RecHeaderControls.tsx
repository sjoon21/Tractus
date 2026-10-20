// 녹음 화면 밖에서도 창 위쪽에서 녹음을 멈추고 끝내는 아이콘 단추 (일시정지 ↔ 계속, 녹음 종료).
// 녹음 화면에는 같은 단추가 글자와 함께 있으므로 App이 그 화면에서는 그리지 않는다. 동작은 녹음 화면·메뉴 막대와 같은 sendRec이다.
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { isRecLive, type RecPhase } from "./lib";
import { PAUSE_LABEL, PAUSE_TITLE, RESUME_LABEL, RESUME_TITLE } from "./pause";

type Send = (cmd: "stop" | "pause" | "resume") => Promise<void>;

export function RecHeaderControls({ phase, send }: { phase: RecPhase; send: Send }) {
  if (!isRecLive(phase)) return null;
  const paused = phase === "paused";
  const stop = t("녹음 종료");
  return (
    <div className="absolute top-[10px] left-1/2 z-40 flex h-8 -translate-x-1/2 items-center gap-0.5 rounded-lg border border-border bg-background/85 pr-0.5 pl-2.5 shadow-xs backdrop-blur-md">
      {/* 사이드바 녹음 단추와 같은 점: 녹음 중에는 깜빡이고, 일시정지 중에는 멈춰 옅어진다 */}
      <span className={cn("mr-1.5 size-2 shrink-0 rounded-full bg-rec", paused ? "opacity-40" : "animate-rec-pulse")} aria-hidden />
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" onClick={() => void send(paused ? "resume" : "pause")} aria-label={paused ? RESUME_LABEL : PAUSE_LABEL} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
      </Button>
      <Button variant="ghost" size="icon-sm" className="text-rec hover:bg-rec-wash hover:text-rec" onClick={() => void send("stop")} aria-label={stop} title={stop}>
        <Square aria-hidden className="fill-current" />
      </Button>
    </div>
  );
}
