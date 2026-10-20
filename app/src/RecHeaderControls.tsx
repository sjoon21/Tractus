// 녹음 화면 밖에서도 창 위쪽에서 녹음을 멈추고 끝내는 아이콘 단추 (일시정지 ↔ 계속, 녹음 종료).
// 녹음 화면에는 같은 단추가 글자와 함께 있으므로 App이 그 화면에서는 그리지 않는다. 동작은 녹음 화면·메뉴 막대와 같은 sendRec이다.
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "./i18n";
import { isRecLive, type RecPhase } from "./lib";
import { PAUSE_LABEL, PAUSE_TITLE, RESUME_LABEL, RESUME_TITLE } from "./pause";

type Send = (cmd: "stop" | "pause" | "resume") => Promise<void>;

export function RecHeaderControls({ phase, send }: { phase: RecPhase; send: Send }) {
  if (!isRecLive(phase)) return null;
  const paused = phase === "paused";
  const stop = t("녹음 종료");
  return (
    <div className="absolute top-[12px] left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-background/90 p-0.5 shadow-xs backdrop-blur-md">
      <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={() => void send(paused ? "resume" : "pause")} aria-label={paused ? RESUME_LABEL : PAUSE_LABEL} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
        {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
      </Button>
      <Button variant="ghost" size="icon-sm" className="rounded-full text-rec hover:text-rec" onClick={() => void send("stop")} aria-label={stop} title={stop}>
        <Square aria-hidden className="fill-current" />
      </Button>
    </div>
  );
}
