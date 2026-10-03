import { useRef, useState } from "react";
import type { JobState, RecState } from "./api";
import { fmtTime, levelFraction, REC_MODES, STAGE_LABEL, warningText } from "./lib";

type Send = (cmd: "bookmark" | "memo" | "stop", text?: string) => Promise<void>;

export function RecordView({ rec, job, send, retry }: { rec: RecState; job: JobState; send: Send; retry: () => void }) {
  const [memo, setMemo] = useState("");
  // 한글 조합 중 Enter로 제출하고 입력을 비우면 조합 중인 글자가 다시 들어간다(한 글자짜리 메모가 하나 더 생김).
  // 조합 중에는 제출하지 않는다. 조합이 끝난 뒤의 Enter가 제출한다
  const composing = useRef(false);
  const live = rec.phase === "recording";
  const mode = REC_MODES.find((m) => m.mode === rec.mode);

  return (
    <section className="record" aria-labelledby="record-title">
      <p className="eyebrow" id="record-title">
        {rec.phase === "starting" && "녹음 준비 중"}
        {live && "녹음 중"}
        {rec.phase === "stopping" && "마무리하는 중"}
        {rec.phase === "stopped" && "녹음 끝"}
        {rec.phase === "error" && "녹음 오류"}
        {rec.phase === "idle" && "녹음"}
      </p>

      <time className={`record-clock tnum ${live ? "is-live" : ""}`} aria-live="off">
        {fmtTime(rec.t)}
      </time>

      {rec.phase !== "idle" && mode && (
        <p className="record-mode">
          <strong>{mode.label}</strong>
          {mode.note}
        </p>
      )}

      {rec.warnings.map((w) => (
        <p key={w.code} className="record-warning" role="alert">
          {warningText(w)}
        </p>
      ))}
      {rec.error && (
        <p className="record-warning is-error" role="alert">
          {rec.error}
        </p>
      )}

      {(live || rec.phase === "starting" || rec.phase === "stopping") && (
        <>
          <div className="meters">
            <Meter label="마이크" db={rec.mic} present={rec.tracks.includes("mic")} />
            {rec.mode === "hybrid" && <Meter label="시스템 오디오" db={rec.system} present={rec.tracks.includes("system")} />}
          </div>

          <div className="record-controls">
            <button className="ghost-button" onClick={() => send("bookmark")} disabled={!live}>
              북마크 <kbd>B</kbd>
            </button>
            <button className="stop-button" onClick={() => send("stop")} disabled={!live}>
              <span aria-hidden className="stop-square" /> 정지하고 전사
            </button>
          </div>

          <form
            className="memo-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (composing.current || !memo.trim()) return;
              void send("memo", memo);
              setMemo("");
            }}
          >
            <time className="memo-at tnum">{fmtTime(rec.t)}</time>
            <input
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={() => (composing.current = false)} 
              placeholder="메모를 쓰고 Enter — 지금 시각과 함께 저장됩니다"
              aria-label="메모"
              disabled={!live}
            />
          </form>
        </>
      )}

      {(rec.phase === "stopped" || job.running || job.error) && <JobProgress job={job} retry={retry} />}

      {rec.marks.length > 0 && (
        <ol className="mark-list">
          {[...rec.marks].reverse().map((m, i) => (
            <li key={i} className={`is-${m.kind}`}>
              <time className="tnum">{fmtTime(m.t)}</time>
              <span className="memo-kind">{m.kind === "bookmark" ? "북마크" : "메모"}</span>
              {m.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Meter({ label, db, present }: { label: string; db: number | null; present: boolean }) {
  const f = levelFraction(db);
  return (
    <div className={`meter ${present ? "" : "is-off"}`}>
      <span className="meter-label">{label}</span>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db ?? -60}>
        <div className="meter-fill" style={{ transform: `scaleX(${f})` }} />
      </div>
      <span className="meter-db tnum">{present ? (db === null ? "—" : `${Math.round(db)} dB`) : "꺼짐"}</span>
    </div>
  );
}

function JobProgress({ job, retry }: { job: JobState; retry: () => void }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : null;
  return (
    <div className="job" aria-live="polite">
      <div className="job-line">
        <span>{job.error ? "전사 실패" : job.running ? (STAGE_LABEL[job.stage ?? ""] ?? "전사 준비 중") : "전사 완료"}</span>
        {pct !== null && job.running && (
          <span className="tnum">
            {job.done}/{job.total} · {pct}%
          </span>
        )}
      </div>
      <div className="job-track">
        <div className={`job-fill ${pct === null && job.running ? "is-indeterminate" : ""}`} style={{ transform: `scaleX(${pct === null ? (job.running ? 1 : 0) : pct / 100})` }} />
      </div>
      {job.error && (
        <>
          <pre className="inline-error">{job.error}</pre>
          <button className="primary-button" onClick={retry}>
            다시 전사
          </button>
        </>
      )}
    </div>
  );
}
