import { ErrorDetail } from "./ErrorDetail";
import { GatedButton } from "./GatedButton";
import { warningText, type JobState } from "./lib";
import { canQueueConvert, CONVERT_EMPTY_BODY, CONVERT_EMPTY_TITLE, CONVERT_FAILED_TITLE, CONVERT_LABEL, CONVERT_RETRY, convertPanelView, type ConvertControls } from "./recorded";

/**
 * 변환 전 노트의 가운데 안내 (WORDS.md §4.18): `아직 텍스트로 변환하지 않았습니다` + `텍스트로 변환`.
 * 변환 중이면 진행, 줄에서 기다리면 이유, 실패하면 이유와 `자세히`와 `다시 변환`. 단추는 변환 엔진·ffmpeg가 없으면 이유와 고치는 길을 보인다 (GatedButton).
 */
export function ConvertPanel({ id, job, controls, kept }: { id: string; job: JobState; controls: ConvertControls; kept?: { line: string; warn: string | null } | null }) {
  const view = convertPanelView(job, controls.slot, controls.waitReason);
  const can = canQueueConvert(controls.slot, job);
  return (
    <div className="transcript-empty convert-panel" role="status" aria-live="polite">
      <p className="eyebrow">{view.phase === "error" ? CONVERT_FAILED_TITLE : CONVERT_EMPTY_TITLE}</p>
      {view.phase === "idle" && <p>{CONVERT_EMPTY_BODY}</p>}
      {kept && (view.phase === "idle" || view.phase === "error") && (
        <p className="tnum">
          {kept.line}
          {kept.warn && ` ${kept.warn}`}
        </p>
      )}
      {(view.phase === "running" || view.phase === "queued") && (
        <>
          <div className="job-line">
            <span>{view.text}</span>
            {view.phase === "running" && view.pct !== null && (
              <span className="tnum">
                {job.done}/{job.total} · {view.pct}%
              </span>
            )}
          </div>
          <div className="job-track">
            <div className={`job-fill ${view.phase === "queued" || view.pct === null ? "is-indeterminate" : ""}`} style={{ transform: `scaleX(${view.phase === "running" && view.pct !== null ? view.pct / 100 : 1})` }} />
          </div>
        </>
      )}
      {view.phase === "error" && (
        <div className="inline-error job-error" role="alert">
          {view.text}
          <ErrorDetail detail={view.detail} />
        </div>
      )}
      {job.warnings.map((w) => (
        <p key={w.code} className="record-warning" role="status">
          {warningText(w)}
        </p>
      ))}
      {(view.phase === "idle" || view.phase === "error") && (
        <GatedButton gate={controls.gate} className="primary-button" disabled={!can} onClick={() => controls.onConvert(id)}>
          {view.phase === "error" ? CONVERT_RETRY : CONVERT_LABEL}
        </GatedButton>
      )}
    </div>
  );
}
