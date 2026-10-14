import { useLayoutEffect, useRef, useState } from "react";
import type { JobState, LiveState, RecState } from "./api";
import { RECORD_LABEL } from "./attach";
import { ErrorDetail } from "./ErrorDetail";
import { GateHint } from "./GatedButton";
import { useCapabilities } from "./useCapabilities";
import { errorView, fmtTime, JOB_ERROR, levelFraction, liveHaltView, liveHalted, REC_MODES, STAGE_LABEL, warningText } from "./lib";

type Send = (cmd: "bookmark" | "memo" | "stop", text?: string) => Promise<void>;

export function RecordView({
  rec,
  captions,
  job,
  send,
  retry,
  attachTitle = null,
  unconverted = null,
}: {
  rec: RecState;
  captions: LiveState;
  job: JobState;
  send: Send;
  retry: () => void;
  attachTitle?: string | null;
  /** 변환 엔진이 없어 녹음만 저장했을 때의 안내 문장 (없으면 null). 변환 진행 줄 대신 보인다 */
  unconverted?: string | null;
}) {
  const caps = useCapabilities();
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

      {attachTitle !== null && <p className="record-attach">{RECORD_LABEL(attachTitle)}</p>}

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

          <LivePane live={captions} recording={live} />

          <div className="record-controls">
            <button className="ghost-button" onClick={() => send("bookmark")} disabled={!live}>
              북마크 <kbd>B</kbd>
            </button>
            <button className="stop-button" onClick={() => send("stop")} disabled={!live}>
              <span aria-hidden className="stop-square" /> 녹음 종료 및 변환
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

      {unconverted && rec.phase === "stopped" && !job.running && (
        <div className="job" role="status">
          <p>{unconverted}</p>
          <GateHint gate={caps.can("convert")} />
        </div>
      )}
      {!(unconverted && rec.phase === "stopped" && !job.running) && (rec.phase === "stopped" || job.running || job.error) && <JobProgress job={job} retry={retry} />}

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

/** 맨 아래에서 이만큼(px) 안이면 새 줄을 따라 내려간다. 위로 올려 읽는 중이면 멈춘다 */
const FOLLOW_SLACK = 24;

/** 실시간 텍스트 변환 (Phase 7.2). 미리보기라 저장하지 않는다. 화면 읽기 프로그램에는 확정된 줄만 알린다 (partial은 계속 바뀐다) */
function LivePane({ live, recording }: { live: LiveState; recording: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [live.finals, live.partial]);

  if (live.status === "off") return null;
  const halt = liveHaltView(live);
  const empty = !live.finals.length && !live.partial;
  return (
    <section className="live-pane" aria-labelledby="live-title">
      <p className="live-head">
        <span id="live-title">{STAGE_LABEL.live} (미리보기)</span>
        <span className="live-note">녹음 종료 후 고품질 텍스트로 정돈됩니다</span>
      </p>
      {liveHalted(live, recording) && (
        <div className="record-warning" role="status">
          {halt.text}
          {halt.note && <span className="live-error">{halt.note}</span>}
          <ErrorDetail detail={live.error} />
        </div>
      )}
      {live.warnings.map((w) => (
        <p key={w.code} className="live-warning" role="status">
          {warningText(w)}
        </p>
      ))}
      <div
        className="live-scroll"
        ref={box}
        tabIndex={0}
        aria-label="실시간 텍스트 변환 내용"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
        }}
      >
        {empty && <p className="live-empty">{live.status === "loading" ? STAGE_LABEL.live_load : live.status === "on" ? "말씀하시면 실시간으로 기록됩니다" : ""}</p>}
        <ol className="live-lines" aria-live="polite" aria-relevant="additions">
          {live.finals.map((f) => (
            <li key={f.id}>
              <time className="tnum">{fmtTime(f.start)}</time>
              <span>{f.text}</span>
            </li>
          ))}
        </ol>
        {live.partial && (
          <p className="live-partial">
            <time className="tnum">{fmtTime(live.partial.start)}</time>
            <span>{live.partial.text}</span>
          </p>
        )}
      </div>
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
  const err = job.error ? errorView(job.error, job.errorCode, JOB_ERROR.transcribe) : null;
  return (
    <div className="job" aria-live="polite">
      <div className="job-line">
        <span>{job.error ? "텍스트 변환 실패" : job.running ? (STAGE_LABEL[job.stage ?? ""] ?? "변환 준비 중…") : "텍스트 변환 완료"}</span>
        {pct !== null && job.running && (
          <span className="tnum">
            {job.done}/{job.total} · {pct}%
          </span>
        )}
      </div>
      {/* 화자 분리 모델이 없거나 실패해도 전사는 계속된다 (diarizer_missing·diarizer_failed) */}
      {job.warnings.map((w) => (
        <p key={w.code} className="record-warning" role="status">
          {warningText(w)}
        </p>
      ))}
      <div className="job-track">
        <div className={`job-fill ${pct === null && job.running ? "is-indeterminate" : ""}`} style={{ transform: `scaleX(${pct === null ? (job.running ? 1 : 0) : pct / 100})` }} />
      </div>
      {err && (
        <>
          <div className="inline-error job-error" role="alert">
            {err.text}
            <ErrorDetail detail={err.detail} />
          </div>
          <button className="primary-button" onClick={retry}>
            다시 변환
          </button>
        </>
      )}
    </div>
  );
}
