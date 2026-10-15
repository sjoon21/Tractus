import { ErrorDetail } from "./ErrorDetail";
import { GatedButton } from "./GatedButton";
import { warningText, type JobState } from "./lib";
import { canQueueConvert, CONVERT_EMPTY_BODY, CONVERT_EMPTY_TITLE, CONVERT_FAILED_TITLE, CONVERT_LABEL, CONVERT_RETRY, convertPanelView, type ConvertControls } from "./recorded";
import { AudioLines } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/components/ui/utils";

/**
 * 변환 전 노트의 가운데 안내 (WORDS.md §4.18): `아직 텍스트로 변환하지 않았습니다` + `텍스트로 변환`.
 * 변환 중이면 진행, 줄에서 기다리면 이유, 실패하면 이유와 `자세히`와 `다시 변환`. 단추는 변환 엔진·ffmpeg가 없으면 이유와 고치는 길을 보인다 (GatedButton).
 */
export function ConvertPanel({ id, job, controls, kept }: { id: string; job: JobState; controls: ConvertControls; kept?: { line: string; warn: string | null } | null }) {
  const view = convertPanelView(job, controls.slot, controls.waitReason);
  const can = canQueueConvert(controls.slot, job);
  return (
    <div className="mx-auto my-12 flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center" role="status" aria-live="polite">
      <span className="grid size-10 place-items-center rounded-full bg-memo-wash text-memo">
        <AudioLines className="size-5" aria-hidden />
      </span>
      <p className="m-0 text-[15px] font-semibold">{view.phase === "error" ? CONVERT_FAILED_TITLE : CONVERT_EMPTY_TITLE}</p>
      {view.phase === "idle" && <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{CONVERT_EMPTY_BODY}</p>}
      {kept && (view.phase === "idle" || view.phase === "error") && (
        <p className="m-0 text-xs text-muted-foreground tabular-nums">
          {kept.line}
          {kept.warn && ` ${kept.warn}`}
        </p>
      )}
      {(view.phase === "running" || view.phase === "queued") && (
        <>
          <div className="flex w-full justify-between gap-3 text-[13px]">
            <span>{view.text}</span>
            {view.phase === "running" && view.pct !== null && (
              <span className="text-muted-foreground tabular-nums">
                {job.done}/{job.total} · {view.pct}%
              </span>
            )}
          </div>
          <Progress className="w-full" value={view.phase === "running" && view.pct !== null ? view.pct / 100 : null} />
        </>
      )}
      {view.phase === "error" && (
        <div className="text-[13px] text-destructive" role="alert">
          {view.text}
          <ErrorDetail detail={view.detail} />
        </div>
      )}
      {job.warnings.map((w) => (
        <p key={w.code} className="m-0 rounded-md bg-memo-wash px-3 py-2 text-xs" role="status">
          {warningText(w)}
        </p>
      ))}
      {(view.phase === "idle" || view.phase === "error") && (
        <GatedButton gate={controls.gate} className={cn(buttonVariants(), "mt-1")} disabled={!can} onClick={() => controls.onConvert(id)}>
          {view.phase === "error" ? CONVERT_RETRY : CONVERT_LABEL}
        </GatedButton>
      )}
    </div>
  );
}
