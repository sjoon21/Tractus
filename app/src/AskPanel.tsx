// 회의 질의 패널 (docs/roadmap.md §3 6.3). 회의 오른쪽 레일의 '질문' 탭과 전체 회의 패널(⌘J)이 같이 쓴다.
// 인라인 인용 칩은 open-webui의 인용 UI에서 아이디어만 얻었다(코드는 쓰지 않음).
import { listen } from "@tauri-apps/api/event";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errText, type ChatEntry } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { answeredBy, answerParts, askReduce, citeTarget, isAsking, sendNotice, START_ASK, trimHistory, turnsHistory, type AskEvent, type AskSource, type AskState, type LlmConfig } from "./ask";
import { APP_ERROR, errorView, fmtTime, isImeKey, JOB_ERROR } from "./lib";

export type AskScope = { kind: "meeting"; id: string; starts: Map<string, number> } | { kind: "global" };
type Turn = { id: string; question: string; state: AskState };
type OnCite = (meetingId: string, segId: string, t: number) => void;

const fromEntry = (e: ChatEntry, i: number): Turn => ({
  id: `h${i}`,
  question: e.question,
  state: { ...START_ASK, phase: "done", answer: e.answer, citations: e.citations, provider: e.provider, model: e.model },
});

const STATUS: Partial<Record<AskState["phase"], string>> = { starting: "준비 중…", retrieve: "관련 대화를 찾는 중…", answer: "답변 작성 중…" };

export function AskPanel({ scope, onCite, inputRef }: { scope: AskScope; onCite: OnCite; inputRef?: React.RefObject<HTMLTextAreaElement | null> }) {
  const meetingId = scope.kind === "meeting" ? scope.id : null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const composing = useRef(false);
  const running = turns.find((t) => isAsking(t.state));
  const runningId = useRef<string | null>(null);
  runningId.current = running?.id ?? null;

  useEffect(() => {
    api.llmConfig().then(setLlm, () => setLlm(null));
    if (!meetingId) return;
    let alive = true;
    api.loadChat(meetingId).then(
      // 기록을 읽는 사이에 보낸 질문은 뒤에 둔다
      (entries) => alive && setTurns((ts) => [...entries.map(fromEntry), ...ts]),
      (e) => alive && setLoadError(`지난 질문을 읽지 못했습니다: ${errText(e)}`),
    );
    return () => {
      alive = false;
    };
  }, [meetingId]);

  useEffect(() => {
    const un = listen<AskEvent>("ask", ({ payload: ev }) => setTurns((ts) => ts.map((t) => (t.id === ev.job ? { ...t, state: askReduce(t.state, ev) } : t))));
    return () => void un.then((f) => f());
  }, []);

  // 화면을 떠나면 진행 중인 질문을 멈춘다 (프로세스가 남지 않게)
  useEffect(() => () => void (runningId.current && api.askCancel(runningId.current).catch(() => {})), []);

  // 맨 아래를 보고 있으면 새 질문·스트리밍 답을 따라간다. 위로 올려 읽는 중이면 그대로 둔다
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (pinned.current = e.isIntersecting), { rootMargin: "0px 0px 120px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const send = async () => {
    const question = draft.trim();
    if (!question || running) return;
    const job = crypto.randomUUID();
    const history = trimHistory(turnsHistory(turns));
    pinned.current = true;
    setTurns((ts) => [...ts, { id: job, question, state: START_ASK }]);
    setDraft("");
    try {
      await api.askStart({ job, meeting: meetingId, from: range.from || null, to: range.to || null, question, history });
    } catch (e) {
      setTurns((ts) => ts.map((t) => (t.id === job ? { ...t, state: { ...t.state, phase: "error", error: errText(e), errorCode: APP_ERROR } } : t)));
    }
  };
  const cancel = () => {
    if (!running) return;
    setTurns((ts) => ts.map((t) => (t.id === running.id ? { ...t, state: { ...t.state, phase: "cancelled" } } : t)));
    api.askCancel(running.id).catch(() => {});
  };

  // 다음 질문이 갈 곳은 지금 설정(TRACTUS_LLM_PROVIDER)이다. 지난 답이 간 곳은 각 턴에 따로 적는다
  const notice = llm && sendNotice(llm);

  return (
    <div className="ask">
      {turns.length === 0 && (
        <div className="ask-empty">
          <p>
            {meetingId
              ? "이 회의 내용을 바탕으로 AI가 답변합니다. 답변 속 시각을 누르면 그 부분으로 이동합니다."
              : "모든 회의 내용을 바탕으로 AI가 답변합니다. 시각을 누르면 그 회의의 해당 부분을 엽니다."}
          </p>
        </div>
      )}
      {loadError && <p className="inline-error ask-note">{loadError}</p>}
      <ol className="ask-log" aria-label="질문과 답변">
        {turns.map((t) => (
          <TurnItem key={t.id} turn={t} scope={scope} onCite={onCite} />
        ))}
      </ol>
      <div ref={end} aria-hidden />

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {!meetingId && (
          <fieldset className="ask-range">
            <legend>기간</legend>
            <input type="date" aria-label="시작 날짜" value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <span aria-hidden>–</span>
            <input type="date" aria-label="끝 날짜" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </fieldset>
        )}
        <textarea
          ref={inputRef}
          className="ask-input"
          rows={2}
          maxLength={2000}
          value={draft}
          placeholder={meetingId ? "예: 예산은 얼마로 정했나요?" : "예: 지난주 회의들에서 정한 출시일은?"}
          aria-label={meetingId ? "이 회의에 대해 AI에게 질문" : "AI 어시스턴트에게 질문 (모든 회의 대상)"}
          aria-description="Enter 보내기, Shift+Enter 줄바꿈"
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            // 한글 조합 중 Enter는 조합만 끝낸다 (lib.isImeKey)
            if (e.key !== "Enter" || e.shiftKey || isImeKey(e.nativeEvent, composing.current)) return;
            e.preventDefault();
            void send();
          }}
        />
        <div className="ask-form-foot">
          <p className={`ask-notice ${notice?.warn ? "is-warn" : ""}`}>{notice?.text}</p>
          {running ? (
            <button type="button" className="ghost-button ask-send" onClick={cancel}>
              멈추기
            </button>
          ) : (
            <button type="submit" className="primary-button ask-send" disabled={!draft.trim()}>
              보내기
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function TurnItem({ turn: { question, state: s }, scope, onCite }: { turn: Turn; scope: AskScope; onCite: OnCite }) {
  const ctx = { meetingId: scope.kind === "meeting" ? scope.id : undefined, citations: s.citations, sources: s.sources, starts: scope.kind === "meeting" ? scope.starts : undefined };
  const status = STATUS[s.phase];
  return (
    <li className="ask-turn">
      <p className="ask-q">{question}</p>
      {(s.answer || s.phase === "done") && (
        <p className={`ask-a ${s.phase === "answer" ? "is-streaming" : ""}`}>
          {answerParts(s.answer).map((p, i) => {
            if (p.kind === "text") return <Fragment key={i}>{p.text}</Fragment>;
            const to = citeTarget(p, ctx);
            const src = to && s.sources.find((x) => x.meeting_id === to.meetingId && x.segment_id === to.segId);
            return to ? (
              <CiteChip
                key={i}
                label={chipLabel(to.t, scope.kind === "global" ? src : undefined)}
                title={scope.kind === "global" && src ? `${src.title} · ${fmtTime(to.t)} 위치로 이동` : `${fmtTime(to.t)} 위치로 이동`}
                onClick={() => onCite(to.meetingId, to.segId, to.t)}
              />
            ) : null; // 풀리지 않은 인용은 그리지 않는다 (내부 ID를 보이지 않는다)
          })}
        </p>
      )}
      <p className="ask-status" role="status">
        {status && !(s.phase === "answer" && s.answer) ? status : null}
        {s.phase === "done" && s.citations.length === 0 && <span className="badge">근거 대화 없음</span>}
        {s.phase === "cancelled" && "멈췄습니다"}
        {answeredBy(s) && <span className="ask-by">{answeredBy(s)}</span>}
      </p>
      {s.error && <AskError error={s.error} code={s.errorCode} />}
      {s.warning && <p className="ask-note is-warn">{s.warning}</p>}
      {s.sources.length > 0 && <Sources sources={s.sources} global={scope.kind === "global"} onCite={onCite} />}
    </li>
  );
}

/** 실패: 코드 문장 또는 "답변을 받지 못했습니다" + 원래 문구(자세히) */
function AskError({ error, code }: { error: string; code: string | null }) {
  const e = errorView(error, code, JOB_ERROR.ask);
  return (
    <div className="inline-error ask-note" role="alert">
      {e.text}
      <ErrorDetail detail={e.detail} />
    </div>
  );
}

/** 회의 범위는 시각만, 전체 범위는 날짜도 ("10/2 5:31") */
function chipLabel(t: number, src?: AskSource | null): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(src?.date ?? "");
  return m ? `${Number(m[1])}/${Number(m[2])} ${fmtTime(t)}` : fmtTime(t);
}

function CiteChip({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className="time-chip cite-chip tnum" title={title} onClick={onClick}>
      {label}
    </button>
  );
}

function Sources({ sources, global, onCite }: { sources: AskSource[]; global: boolean; onCite: OnCite }) {
  return (
    <details className="ask-sources">
      <summary>
        참고한 대화 <span className="tnum">{sources.length}</span>
      </summary>
      <ol>
        {sources.map((s) => (
          <li key={`${s.meeting_id}#${s.segment_id}`}>
            <CiteChip label={chipLabel(s.start, global ? s : undefined)} title={`${s.title} · ${fmtTime(s.start)}`} onClick={() => onCite(s.meeting_id, s.segment_id, s.start)} />
            <span>
              {global && <span className="ask-src-title">{s.title}</span>}
              {s.speaker && <span className="ask-src-speaker">{s.speaker}</span>}
              {s.text}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
