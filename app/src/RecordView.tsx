import { useLayoutEffect, useRef, useState } from "react";
import type { JobState, LiveState, RecState } from "./api";
import { RECORD_LABEL } from "./attach";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { GateHint } from "./GatedButton";
import { useCapabilities } from "./useCapabilities";
import { EditableMark } from "./MarkEdit";
import { errorView, fmtTime, isRecLive, JOB_ERROR, levelFraction, liveHaltView, liveHalted, REC_MODES, STAGE_LABEL, warningText, type RecCommand } from "./lib";
import { AFTER_ASK } from "./afterRecord";
import { PAUSE_LABEL, PAUSE_TITLE, PAUSED_NOTE, RESUME_LABEL, RESUME_TITLE } from "./pause";
import { CONVERT_FAILED_TITLE, CONVERT_RETRY, SAVE_DONE_TITLE, SAVE_FAILED_TITLE, SAVE_RETRY, SAVING } from "./recorded";
import { Bookmark, Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GrowTextarea } from "@/components/ui/textarea";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/components/ui/utils";

type Send = (cmd: RecCommand, text?: string, index?: number) => Promise<void>;

export function RecordView({
  rec,
  captions,
  job,
  send,
  retry,
  attachTitle = null,
  unconverted = null,
  progressKind = "convert",
  choosing = false,
}: {
  rec: RecState;
  captions: LiveState;
  job: JobState;
  send: Send;
  retry: () => void;
  attachTitle?: string | null;
  /** 변환 엔진이 없어 녹음만 저장했을 때의 안내 문장 (없으면 null). 변환 진행 줄 대신 보인다 */
  unconverted?: string | null;
  /** 진행 줄이 보이는 작업: 텍스트 변환 | 노트로 저장 (`recording finish`) */
  progressKind?: "convert" | "save";
  /** 녹음을 끝내고 `바로 변환 / 나중에 변환`을 묻는 중: 아직 아무 작업도 시작하지 않았으므로 진행 줄(옛 작업의 `완료`일 수 있다)을 가린다 */
  choosing?: boolean;
}) {
  const caps = useCapabilities();
  const [memo, setMemo] = useState("");
  // 한글 조합 중 Enter로 제출하고 입력을 비우면 조합 중인 글자가 다시 들어간다(한 글자짜리 메모가 하나 더 생김).
  // 조합 중에는 제출하지 않는다. 조합이 끝난 뒤의 Enter가 제출한다
  const composing = useRef(false);
  const live = isRecLive(rec.phase); // 녹음 중이거나 일시정지: 끝내기·북마크·메모가 된다
  const paused = rec.phase === "paused";
  const mode = REC_MODES.find((m) => m.mode === rec.mode);

  const status =
    rec.phase === "starting" ? t("녹음 준비 중") : rec.phase === "recording" ? t("녹음 중") : paused ? t("일시정지됨") : rec.phase === "stopping" ? t("마무리하는 중") : rec.phase === "stopped" ? t("녹음 끝") : rec.phase === "error" ? t("녹음 오류") : t("녹음");

  return (
    <section className="flex h-full flex-col overflow-y-auto" aria-labelledby="record-title">
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 pt-6 pb-16">
        <header className="flex flex-col items-center gap-3 text-center">
          <p id="record-title" className={cn("m-0 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium", rec.phase === "recording" ? "bg-rec-wash text-rec" : rec.phase === "error" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground")}>
            {rec.phase === "recording" && <span className="size-1.5 animate-rec-pulse rounded-full bg-rec" aria-hidden />}
            {status}
          </p>
          {attachTitle !== null && <p className="m-0 text-[13px] text-muted-foreground">{RECORD_LABEL(attachTitle)}</p>}
          <time className={`record-clock tnum ${rec.phase === "recording" ? "is-live" : ""} ${paused ? "is-paused opacity-40" : ""} text-[64px] leading-none font-extralight tracking-tight tabular-nums`} aria-live="off">
            {fmtTime(rec.t)}
          </time>
          {rec.phase !== "idle" && mode && (
            <p className="m-0 max-w-md text-xs leading-relaxed text-muted-foreground">
              <strong className="mr-1.5 font-medium text-foreground">{mode.label}</strong>
              {mode.note}
            </p>
          )}
        </header>

        {rec.warnings.map((w) => (
          <p key={w.code} className={NOTICE} role="alert">
            {warningText(w)}
          </p>
        ))}
        {rec.error && (
          <p className={cn(NOTICE, "border-destructive/30 bg-destructive/8 whitespace-pre-wrap text-destructive")} role="alert">
            {rec.error}
          </p>
        )}

        {(live || rec.phase === "starting" || rec.phase === "stopping") && (
          <>
            <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3">
              <Meter label={t("마이크")} db={rec.mic} present={rec.tracks.includes("mic")} />
              {rec.mode === "hybrid" && <Meter label={t("시스템 오디오")} db={rec.system} present={rec.tracks.includes("system")} />}
            </div>

            {paused && (
              <p className={NOTICE} role="status">
                {PAUSED_NOTE}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" onClick={() => send(paused ? "resume" : "pause")} disabled={!live} title={paused ? RESUME_TITLE : PAUSE_TITLE}>
                {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
                {paused ? RESUME_LABEL : PAUSE_LABEL}
              </Button>
              <Button variant="outline" onClick={() => send("bookmark")} disabled={!live}>
                <Bookmark aria-hidden />
                {t("북마크")} <Kbd>B</Kbd>
              </Button>
              <Button variant="rec" onClick={() => send("stop")} disabled={!live}>
                <Square aria-hidden className="fill-current" /> {t("녹음 종료")}
              </Button>
            </div>

            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault();
                if (composing.current || !memo.trim()) return;
                void send("memo", memo);
                setMemo("");
              }}
            >
              <time className="pointer-events-none absolute top-[9px] left-3 text-xs leading-[18px] font-medium text-memo tabular-nums">{fmtTime(rec.t)}</time>
              {/* 긴 메모는 옆으로 숨지 않고 줄을 늘린다. 메모는 한 줄로 저장되므로 Enter가 저장이다 */}
              <GrowTextarea
                className="min-h-9 py-[7px] pl-14 leading-[20px]"
                value={memo}
                onChange={(e) => setMemo(e.target.value.replace(/\n/g, " "))}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || composing.current || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                placeholder={t("메모를 쓰고 Enter — 지금 시각과 함께 저장됩니다")}
                aria-label={t("메모")}
                disabled={!live}
              />
            </form>

            <LivePane live={captions} recording={live} />
          </>
        )}

        {unconverted && rec.phase === "stopped" && !job.running && (
          <div className={JOB_BOX} role="status">
            <p className="m-0 text-[13px]">{unconverted}</p>
            <GateHint gate={caps.can("convert")} />
          </div>
        )}
        {choosing && rec.phase === "stopped" && (
          <div className={JOB_BOX} role="status">
            <p className="m-0 text-[13px]">{AFTER_ASK.pending}</p>
          </div>
        )}
        {/* 녹음하는 동안에는 앞선 녹음의 변환이 함께 돌 수 있다(recordBusy.ts): 그 진행은 사이드바에 있고, 여기서는 이 녹음이 끝난 뒤에만 보인다 */}
        {!choosing && !live && rec.phase !== "starting" && rec.phase !== "stopping" && !(unconverted && rec.phase === "stopped" && !job.running) && (rec.phase === "stopped" || job.running || job.error) && <JobProgress job={job} retry={retry} kind={progressKind} />}

        {rec.marks.length > 0 && (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {[...rec.marks].reverse().map((m, i) => {
              const at = rec.marks.length - 1 - i; // 녹음 프로그램의 목록 자리 (화면은 최신이 위)
              // 시각·종류는 줄을 바꾸지 않는 칸, 긴 메모는 셋째 칸 안에서만 줄을 바꾼다
              const row = (
                <span className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-baseline gap-x-3 py-1 leading-relaxed">
                  <time className="text-xs whitespace-nowrap text-memo tabular-nums">{fmtTime(m.t)}</time>
                  <span className="text-[11px] font-semibold whitespace-nowrap text-memo">{m.kind === "bookmark" ? t("북마크") : t("메모")}</span>
                  <span className="[overflow-wrap:anywhere]">{m.text}</span>
                </span>
              );
              return (
                <li key={`${m.t}-${at}`} className="rounded-md bg-memo-wash px-3 py-1 text-[13px]">
                  {/* 녹음이 끝나면 녹음 프로그램이 없다: 그 뒤에는 노트에서 고친다 */}
                  {live ? (
                    <EditableMark memo={m} onSave={(text) => void send("mark_edit", text, at)} onDelete={() => void send("mark_delete", undefined, at)}>
                      {row}
                    </EditableMark>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

const NOTICE = "m-0 rounded-md border border-memo/25 bg-memo-wash px-3 py-2.5 text-[13px] leading-relaxed";
const JOB_BOX = "flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4";

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
    <section className="flex flex-col gap-2" aria-labelledby="live-title">
      <p className="m-0 flex items-baseline justify-between gap-3 px-1">
        <span id="live-title" className="text-[13px] font-semibold">{t("{label} (미리보기)", { label: STAGE_LABEL.live })}</span>
        <span className="text-xs text-muted-foreground">{t("녹음 종료 후 고품질 텍스트로 정돈됩니다")}</span>
      </p>
      {liveHalted(live, recording) && (
        <div className={NOTICE} role="status">
          {halt.text}
          {halt.note && <span className="mt-1 block text-xs text-muted-foreground">{halt.note}</span>}
          <ErrorDetail detail={live.error} />
        </div>
      )}
      {live.warnings.map((w) => (
        <p key={w.code} className="m-0 px-1 text-xs text-memo" role="status">
          {warningText(w)}
        </p>
      ))}
      <div
        className="max-h-[320px] min-h-[120px] overflow-y-auto rounded-lg border border-border bg-card px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        ref={box}
        tabIndex={0}
        aria-label={t("실시간 텍스트 변환 내용")}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
        }}
      >
        {empty && <p className="m-0 py-6 text-center text-[13px] text-subtle-foreground">{live.status === "loading" ? STAGE_LABEL.live_load : live.status === "on" ? t("말씀하시면 실시간으로 기록됩니다") : ""}</p>}
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-live="polite" aria-relevant="additions">
          {live.finals.map((f) => (
            <li key={f.id} className="grid grid-cols-[3rem_minmax(0,1fr)] text-[14px] leading-relaxed text-muted-foreground">
              <time className="pt-0.5 text-xs text-subtle-foreground tabular-nums">{fmtTime(f.start)}</time>
              <span>{f.text}</span>
            </li>
          ))}
        </ol>
        {live.partial && (
          <p className="m-0 mt-1.5 grid grid-cols-[3rem_minmax(0,1fr)] text-[14px] leading-relaxed text-subtle-foreground">
            <time className="pt-0.5 text-xs tabular-nums">{fmtTime(live.partial.start)}</time>
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
    <div className={cn("grid grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3", !present && "opacity-50")}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-border" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db ?? -60}>
        <div className="h-full origin-left rounded-full bg-[#34c759] transition-transform duration-75" style={{ transform: `scaleX(${f})` }} />
      </div>
      <span className="text-right text-xs text-subtle-foreground tabular-nums">{present ? (db === null ? "—" : `${Math.round(db)} dB`) : t("꺼짐")}</span>
    </div>
  );
}

function JobProgress({ job, retry, kind }: { job: JobState; retry: () => void; kind: "convert" | "save" }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : null;
  const save = kind === "save";
  const err = job.error ? errorView(job.error, job.errorCode, save ? JOB_ERROR.finish : JOB_ERROR.transcribe) : null;
  return (
    <div className={JOB_BOX} aria-live="polite">
      <div className="flex justify-between gap-3 text-[13px] font-medium">
        <span>{job.error ? (save ? SAVE_FAILED_TITLE : CONVERT_FAILED_TITLE) : job.running ? (STAGE_LABEL[job.stage ?? ""] ?? (save ? SAVING : t("변환 준비 중…"))) : save ? SAVE_DONE_TITLE : t("텍스트 변환 완료")}</span>
        {pct !== null && job.running && (
          <span className="font-normal text-muted-foreground tabular-nums">
            {job.done}/{job.total} · {pct}%
          </span>
        )}
      </div>
      {/* 화자 분리 모델이 없거나 실패해도 전사는 계속된다 (diarizer_missing·diarizer_failed) */}
      {job.warnings.map((w) => (
        <p key={w.code} className={NOTICE} role="status">
          {warningText(w)}
        </p>
      ))}
      <Progress value={pct === null ? (job.running ? null : 0) : pct / 100} />
      {err && (
        <>
          <div className="text-[13px] text-destructive" role="alert">
            {err.text}
            <ErrorDetail detail={err.detail} />
          </div>
          <Button className="self-start" onClick={retry}>
            {save ? SAVE_RETRY : CONVERT_RETRY}
          </Button>
        </>
      )}
    </div>
  );
}
