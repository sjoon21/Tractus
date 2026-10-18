// 회의 질의 패널 (docs/roadmap.md §3 6.3). 회의 오른쪽 레일의 '질문' 탭과 전체 회의 패널(⌘J)이 같이 쓴다.
// 인라인 인용 칩은 open-webui의 인용 UI에서 아이디어만 얻었다(코드는 쓰지 않음).
import { listen } from "@tauri-apps/api/event";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errFull, errText, type ChatEntry } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { answerParts, askReduce, citeLabel, citeTarget, isAsking, isMemoCite, isNoteGone, isTaggedMemo, sendNotice, START_ASK, trimHistory, turnsHistory, type AskEvent, type AskSource, type AskState, type LlmConfig } from "./ask";
import { APP_ERROR, fmtTime, isImeKey } from "./lib";
import { KEY_CHANGED, llmErrorView } from "./llmKey";
import { LlmServicePicker, useLlmServices } from "./LlmServicePicker";
import { OpenSettings } from "./OpenSettings";
import { flushMemos } from "./memo";
import { NOTE_GONE } from "./remove";
import { ArrowUp, ChevronRight, Square } from "lucide-react";
import { CHIP } from "@/components/panel/chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";

/**
 * memoNote: 이 노트가 메모 노트인가. memoLines: 줄 ID → 본문의 줄 번호 (인용 칩 `n번째 줄`).
 * 메모 노트는 대화가 곧 줄이고, 녹음 노트는 사용자가 적은 메모의 줄(`m0003`)이 들어 있다. 메모는 시각이 없다
 */
export type AskScope = { kind: "meeting"; id: string; starts: Map<string, number>; memoLines?: Map<string, number>; memoNote?: boolean } | { kind: "global" };
type Turn = { id: string; question: string; state: AskState };
type OnCite = (meetingId: string, segId: string, t: number) => void;

const fromEntry = (e: ChatEntry, i: number): Turn => ({
  id: `h${i}`,
  question: e.question,
  state: { ...START_ASK, phase: "done", answer: e.answer, citations: e.citations, provider: e.provider, model: e.model },
});

const STATUS: Partial<Record<AskState["phase"], string>> = { starting: t("준비 중…"), retrieve: t("관련 대화를 찾는 중…"), answer: t("답변 작성 중…") };

/**
 * notes: 지금 있는 노트의 ID들 (전체 범위 질문용). 목록에 없는 노트를 가리키는 인용 칩은 삭제된 노트로 보고 누를 수 없게 한다.
 * 목록이 바뀔 때마다 새로 판단하므로 답을 쓰는 사이에 지워진 노트도 따라간다. 아직 목록을 못 읽었으면 null
 */
export function AskPanel({ scope, onCite, inputRef, notes, memoIds }: { scope: AskScope; onCite: OnCite; inputRef?: React.RefObject<HTMLTextAreaElement | null>; notes?: ReadonlySet<string> | null; memoIds?: ReadonlySet<string> }) {
  const meetingId = scope.kind === "meeting" ? scope.id : null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const services = useLlmServices("ask");
  const provider = services.provider;
  const composing = useRef(false);
  const running = turns.find((x) => isAsking(x.state));
  const runningId = useRef<string | null>(null);
  runningId.current = running?.id ?? null;

  useEffect(() => {
    if (!meetingId) return;
    let alive = true;
    api.loadChat(meetingId).then(
      // 기록을 읽는 사이에 보낸 질문은 뒤에 둔다
      (entries) => alive && setTurns((ts) => [...entries.map(fromEntry), ...ts]),
      (e) => alive && setLoadError(t("지난 질문을 읽지 못했습니다: {error}", { error: errText(e) })),
    );
    return () => {
      alive = false;
    };
  }, [meetingId]);

  useEffect(() => {
    // 보내기 전 안내는 고른 서비스 기준이다. 설정에서 키·서비스를 바꾸면 다시 읽는다 (질문 서랍은 닫아도 계속 떠 있다)
    const refetch = () => void api.llmConfig(provider).then(setLlm, () => setLlm(null));
    refetch();
    window.addEventListener(KEY_CHANGED, refetch);
    return () => window.removeEventListener(KEY_CHANGED, refetch);
  }, [provider]);

  useEffect(() => {
    const un = listen<AskEvent>("ask", ({ payload: ev }) => setTurns((ts) => ts.map((x) => (x.id === ev.job ? { ...x, state: askReduce(x.state, ev) } : x))));
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

  const flushing = useRef(false);
  const send = async () => {
    const question = draft.trim();
    if (!question || running || flushing.current) return;
    // 쓰던 메모를 먼저 저장한다 (질문이 저장된 글을 읽는다). 저장하지 못하면 묻지 않고 질문을 남겨 둔다 (오류는 편집기가 보인다)
    flushing.current = true;
    const saved = await flushMemos().finally(() => (flushing.current = false));
    if (!saved) return;
    const job = crypto.randomUUID();
    const history = trimHistory(turnsHistory(turns));
    pinned.current = true;
    setTurns((ts) => [...ts, { id: job, question, state: START_ASK }]);
    setDraft("");
    try {
      await api.askStart({ job, meeting: meetingId, from: range.from || null, to: range.to || null, question, history, provider });
    } catch (e) {
      setTurns((ts) => ts.map((x) => (x.id === job ? { ...x, state: { ...x.state, phase: "error", error: errFull(e), errorCode: APP_ERROR } } : x)));
    }
  };
  const cancel = () => {
    if (!running) return;
    setTurns((ts) => ts.map((x) => (x.id === running.id ? { ...x, state: { ...x.state, phase: "cancelled" } } : x)));
    api.askCancel(running.id).catch(() => {});
  };

  // 다음 질문이 갈 곳은 지금 설정(TRACTUS_LLM_PROVIDER)이다. 지난 답이 간 곳은 각 턴에 따로 적는다
  const notice = llm && sendNotice(llm);

  return (
    <div className="flex flex-1 flex-col">
      {turns.length === 0 && (
        <p className="m-0 mb-4 max-w-[34ch] text-[13px] leading-relaxed text-muted-foreground">
          {meetingId
            ? t("이 노트 내용을 바탕으로 AI가 답변합니다. 답변 속 시각을 누르면 그 부분으로 이동합니다.")
            : t("모든 노트 내용을 바탕으로 AI가 답변합니다. 시각을 누르면 그 노트의 해당 부분을 엽니다.")}
        </p>
      )}
      {loadError && <p className="m-0 mb-3 text-xs text-destructive">{loadError}</p>}
      <ol className="m-0 flex flex-1 list-none flex-col gap-7 p-0" aria-label={t("질문과 답변")}>
        {turns.map((x) => (
          <TurnItem key={x.id} turn={x} scope={scope} onCite={onCite} notes={notes} memoIds={memoIds} />
        ))}
      </ol>
      <div ref={end} aria-hidden />

      <form
        // 바닥에 붙는 입력: 위로 흘러가는 답이 비치지 않게 놓인 곳의 바탕을 깐다 (노트 패널은 본문 바탕, 질문 서랍은 muted)
        className={cn("sticky bottom-0 mt-4 flex flex-col gap-2 pt-2 pb-4", "bg-background")}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {!meetingId && (
          <fieldset className="m-0 flex min-w-0 items-center gap-1.5 border-0 p-0 text-xs text-muted-foreground">
            <legend className="float-left mr-1 p-0 font-medium">{t("기간")}</legend>
            <input type="date" className={DATE} aria-label={t("시작 날짜")} value={range.from} max={range.to || undefined} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <span aria-hidden>–</span>
            <input type="date" className={DATE} aria-label={t("끝 날짜")} value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </fieldset>
        )}
        <div className="flex flex-col rounded-lg border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25">
          <textarea
            ref={inputRef}
            className="max-h-[14em] min-h-[3.25rem] w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-[14px] leading-6 outline-none [field-sizing:content] placeholder:text-subtle-foreground"
            rows={2}
            maxLength={2000}
            value={draft}
            placeholder={meetingId ? t("예: 예산은 얼마로 정했나요?") : t("예: 지난주 노트들에서 정한 출시일은?")}
            aria-label={meetingId ? t("이 노트에 대해 AI에게 질문") : t("AI 어시스턴트에게 질문")}
            aria-description={t("Enter 보내기, Shift+Enter 줄바꿈")}
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
          <div className="flex items-center gap-2 px-2 pb-2">
            <LlmServicePicker services={services} disabled={!!running} />
            {running ? (
              <Button variant="secondary" size="icon-sm" className="ml-auto rounded-full" aria-label={t("멈추기")} title={t("멈추기")} onClick={cancel}>
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button type="submit" size="icon-sm" className="ml-auto rounded-full" aria-label={t("보내기")} title={t("보내기 (Enter)")} disabled={!draft.trim()}>
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
        <p className={cn("m-0 text-xs leading-snug empty:hidden", notice?.warn ? "text-memo" : "text-subtle-foreground")}>{notice?.text}</p>
      </form>
    </div>
  );
}

const DATE = cn(inputClass, "h-7 w-auto px-1.5 text-xs");

function TurnItem({ turn: { question, state: s }, scope, onCite, notes, memoIds }: { turn: Turn; scope: AskScope; onCite: OnCite; notes?: ReadonlySet<string> | null; memoIds?: ReadonlySet<string> }) {
  const ctx = { meetingId: scope.kind === "meeting" ? scope.id : undefined, citations: s.citations, sources: s.sources, starts: scope.kind === "meeting" ? scope.starts : undefined };
  const status = STATUS[s.phase];
  return (
    <li className="flex flex-col gap-2 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <p className="m-0 ml-auto max-w-[88%] rounded-lg bg-foreground/[0.06] px-3 py-1.5 text-[14px] leading-6 whitespace-pre-wrap">{question}</p>
      {(s.answer || s.phase === "done") && (
        <p className={cn("m-0 text-[14px] leading-6 whitespace-pre-wrap", s.phase === "answer" && "after:ml-0.5 after:inline-block after:h-[1em] after:w-[0.45em] after:animate-pulse after:bg-rec after:align-[-0.14em] after:content-['']")}>
          {answerParts(s.answer).map((p, i) => {
            if (p.kind === "text") return <Fragment key={i}>{p.text}</Fragment>;
            const to = citeTarget(p, ctx);
            const src = to && s.sources.find((x) => x.meeting_id === to.meetingId && x.segment_id === to.segId);
            const memo = !!to && isMemoCite({ segment_id: to.segId, source: src?.source }, inMemoNote(scope, memoIds, to.meetingId, to.line));
            // 줄 번호는 지금 노트의 줄을 먼저 보고(고쳐졌을 수 있다), 없으면 인용에 실린 줄
            const label = to && chipLabel(to.t, { src: scope.kind === "global" ? src : undefined, memo, tagged: isTaggedMemo({ segment_id: to.segId, source: src?.source }), line: (scope.kind === "meeting" ? scope.memoLines?.get(to.segId) : undefined) ?? to.line });
            return to ? (
              <CiteChip
                key={i}
                label={label ?? ""}
                title={memo ? (scope.kind === "global" && src ? t("{title} · 메모의 줄로 이동", { title: src.title }) : t("메모의 줄로 이동")) : scope.kind === "global" && src ? t("{title} · {time} 위치로 이동", { title: src.title, time: fmtTime(to.t) }) : t("{time} 위치로 이동", { time: fmtTime(to.t) })}
                gone={scope.kind === "global" && isNoteGone(notes, to.meetingId)}
                onClick={() => onCite(to.meetingId, to.segId, to.t)}
              />
            ) : null; // 풀리지 않은 인용은 그리지 않는다 (내부 ID를 보이지 않는다)
          })}
        </p>
      )}
      <p className="m-0 flex items-center gap-2 text-xs text-subtle-foreground empty:hidden" role="status">
        {status && !(s.phase === "answer" && s.answer) ? status : null}
        {s.phase === "done" && s.citations.length === 0 && <Badge>{t("근거 대화 없음")}</Badge>}
        {s.phase === "cancelled" && t("멈췄습니다")}
      </p>
      {s.error && <AskError error={s.error} code={s.errorCode} />}
      {s.warning && <p className="m-0 text-xs text-memo">{s.warning}</p>}
      {s.sources.length > 0 && <Sources sources={s.sources} scope={scope} onCite={onCite} notes={notes} memoIds={memoIds} />}
    </li>
  );
}

/** 실패: 코드 문장 또는 "답변을 받지 못했습니다" + 원래 문구(자세히) */
function AskError({ error, code }: { error: string; code: string | null }) {
  const e = llmErrorView("ask", error, code);
  return (
    <div className="text-xs leading-5 text-destructive" role="alert">
      {e.text}
      {e.settings && <OpenSettings />}
      <ErrorDetail detail={e.detail} />
    </div>
  );
}

/** 회의 범위는 시각만, 전체 범위는 날짜도 ("10/2 5:31"). 메모는 시각 대신 줄 (ask.citeLabel) */
const chipLabel = (sec: number, o: { src?: AskSource | null; memo?: boolean; tagged?: boolean; line?: number }): string => citeLabel(sec, { date: o.src?.date, memo: o.memo, tagged: o.tagged, line: o.line });

/** gone: 삭제된 노트의 인용. 누를 수 없고 설명만 보인다 (오류 없이) */
function CiteChip({ label, title, gone, onClick }: { label: string; title: string; gone?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cn(CHIP, "mx-0.5 align-[0.1em]", gone && "cursor-default line-through opacity-60 hover:border-border-strong hover:bg-transparent hover:text-muted-foreground")} title={gone ? NOTE_GONE : title} aria-disabled={gone || undefined} aria-label={gone ? `${label} (${NOTE_GONE})` : undefined} onClick={gone ? undefined : onClick}>
      {label}
    </button>
  );
}

function Sources({ sources, scope, onCite, notes, memoIds }: { sources: AskSource[]; scope: AskScope; onCite: OnCite; notes?: ReadonlySet<string> | null; memoIds?: ReadonlySet<string> }) {
  const global = scope.kind === "global";
  return (
    <details className="group text-xs">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {t("참고한 대화")} <span className="text-subtle-foreground tabular-nums">{sources.length}</span>
      </summary>
      <ol className="m-0 mt-2 ml-1.5 flex list-none flex-col gap-2 border-l border-border-strong p-0 pl-3">
        {sources.map((s) => (
          <li key={`${s.meeting_id}#${s.segment_id}`} className="flex items-baseline gap-2 leading-5 text-muted-foreground">
            <CiteChip
              label={chipLabel(s.start, { src: global ? s : undefined, memo: isMemoCite(s, inMemoNote(scope, memoIds, s.meeting_id, s.line)), tagged: isTaggedMemo(s), line: (scope.kind === "meeting" ? scope.memoLines?.get(s.segment_id) : undefined) ?? s.line })}
              title={isMemoCite(s, inMemoNote(scope, memoIds, s.meeting_id, s.line)) ? t("{title} · 메모의 줄", { title: s.title }) : `${s.title} · ${fmtTime(s.start)}`}
              gone={global && isNoteGone(notes, s.meeting_id)}
              onClick={() => onCite(s.meeting_id, s.segment_id, s.start)}
            />
            <span className="min-w-0">
              {global && <span className="mr-1.5 font-medium text-foreground">{s.title}</span>}
              {s.speaker && <span className="mr-1.5 font-medium text-foreground">{s.speaker}</span>}
              {s.text}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** 인용이 메모 노트의 것인가: 노트 안 질문은 노트가 메모인지, 전체 질문은 노트 목록의 종류나 인용에 실린 줄 번호로 */
const inMemoNote = (scope: AskScope, memoIds: ReadonlySet<string> | undefined, meetingId: string, line?: number): boolean =>
  scope.kind === "meeting" ? !!scope.memoNote : !!memoIds?.has(meetingId) || line !== undefined;
