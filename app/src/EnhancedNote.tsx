// 녹음 노트의 메모 탭: `내 메모 | 완성된 노트` 전환과 `노트 완성` (docs/design/enhanced-notes.md, WORDS.md §4.22).
// 만들기는 요약과 같은 작업(summary_start --template enhanced)이고, 결과는 요약 목록의 한 칸(summaries/enhanced.json)이다.
// 내 메모 편집기는 전환해도 언마운트하지 않는다 (쓰던 글을 잃지 않게 숨기기만 한다).
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { api, errText, useJob, type JobState } from "./api";
import type { Notify } from "./App";
import { ENHANCE_HINT, ENHANCE_LABEL, ENHANCED_KEY, enhancedView, EXTRA_TITLE, findEnhanced, memoTabShowing, NO_MEMO_NOTICE, REDO_LABEL, RUNNING_TEXT, staleNotice, VIEW_DONE, VIEW_MINE } from "./enhanced";
import { ErrorDetail } from "./ErrorDetail";
import { fmtTime } from "./lib";
import { LlmServicePicker, useLlmServices } from "./LlmServicePicker";
import { llmErrorView } from "./llmKey";
import { staleSentence, type EditKind } from "./memo";
import type { MemoTarget } from "./MemoView";
import { OpenSettings } from "./OpenSettings";
import type { SummaryDoc, SummaryItem, SummarySection } from "./summaries";
import { buttonVariants } from "@/components/ui/button";
import { CHIP } from "@/components/panel/chip";
import { CoachMark } from "./CoachMark";
import { markOnboard } from "./onboarding";
import { SparklesIcon } from "@/components/ui/sparkles-icon";
import { cn } from "@/components/ui/utils";

const NO_DETAIL = "대화에서 관련 내용을 찾지 못했습니다"; // 코어 summaries.NO_DETAIL과 같은 문장 (내보낸 문서와 화면이 같게)

export function EnhancedNote(p: {
  id: string;
  /** 노트를 다시 읽을 때마다 오른다 (MeetingView summaryRev): 요약 파일을 다시 읽는다 */
  rev: number;
  /** 지금 만들 수 없는 이유 (변환 전, 저장 중 …). 없으면 null */
  disabled: string | null;
  /** 쓰던 메모를 먼저 저장한다. 저장하지 못하면 만들지 않는다 (오류는 편집기가 보인다) */
  prepare: () => Promise<boolean>;
  editSeq: number;
  editSeqRef: MutableRefObject<number>;
  editKinds: MutableRefObject<EditKind[]>;
  chip: (ids: string[]) => ReactNode;
  onSeek: (t: number) => void;
  /** 만들었다: 요약 탭·노트 목록을 새로 읽는다 */
  onMade: () => void;
  onRunning: (running: boolean) => void;
  notify: Notify;
  /** 내 메모 화면 (안내 줄 + 편집기) */
  mine: ReactNode;
  /** 편집기가 고를 줄 (요약·AI 질문의 `메모 n번째 줄` 칩). 사용자가 마지막으로 보기를 바꾼 뒤에 온 줄 요청이면 내 메모를 보인다 */
  pick: MemoTarget | null;
}) {
  const { id, rev, onRunning, onMade, notify } = p;
  const [doc, setDoc] = useState<SummaryDoc | null>(null);
  const [view, setViewState] = useState<"mine" | "done">("done");
  const [viewAt, setViewAt] = useState(0); // 보기를 바꾼 시각: 이보다 나중의 줄 요청만 내 메모로 돌린다
  const setView = (v: "mine" | "done") => {
    setViewState(v);
    setViewAt(Date.now());
  };
  const [madeSeq, setMadeSeq] = useState(0); // 이 노트 완성이 반영한 편집 횟수 (그 뒤 편집이 있으면 낡음)
  const launchSeq = useRef(0);
  const services = useLlmServices("summary");

  const reload = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const docs = await api.summariesList(id);
        if (alive()) setDoc(findEnhanced(docs));
      } catch (e) {
        if (alive()) notify({ text: errText(e), error: true });
      }
    },
    [id, notify],
  );
  useEffect(() => {
    let on = true;
    void reload(() => on);
    return () => void (on = false);
  }, [reload, rev]);

  const job = useJob(() => {
    setMadeSeq(launchSeq.current);
    setView("done");
    void reload();
    onMade();
  });
  const running = job.job.running;
  useEffect(() => onRunning(running), [running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);

  const start = async () => {
    if (running || p.disabled || !(await p.prepare())) return;
    launchSeq.current = p.editSeqRef.current; // 저장이 끝난 뒤의 값: 요약 직전 저장이 낡음으로 남지 않게
    void job.runJob("summary_start", { id, template: ENHANCED_KEY, custom: null, provider: services.provider });
  };

  const showing = memoTabShowing(!!doc, view, viewAt, p.pick);
  const seeingDone = showing === "done" && !!doc;
  useEffect(() => {
    if (seeingDone) markOnboard("enhancedSeen"); // 온보딩: 완성된 노트를 봤다
  }, [seeingDone]);
  const changed = p.editKinds.current.slice(madeSeq);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {doc && (
          <div className="grid grid-cols-2 gap-0.5 rounded-md bg-secondary p-0.5" role="radiogroup" aria-label="메모 보기">
            {(["mine", "done"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={showing === v}
                onClick={() => setView(v)}
                className="h-6 whitespace-nowrap rounded-[5px] px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-xs"
              >
                {v === "mine" ? VIEW_MINE : VIEW_DONE}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <LlmServicePicker services={services} disabled={running} />
          <button
            type="button"
            className={cn(buttonVariants({ variant: doc ? "outline" : "default", size: "sm" }), "group/ai")}
            data-tip="enhance"
            disabled={running || !!p.disabled}
            title={p.disabled ?? ENHANCE_HINT}
            onClick={() => void start()}
          >
            <SparklesIcon className={doc ? "text-muted-foreground" : ""} />
            {doc ? REDO_LABEL : ENHANCE_LABEL}
          </button>
        </div>
      </div>

      <CoachMark id="enhance" />
      {running && (
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {RUNNING_TEXT}
        </p>
      )}
      <Failure job={job.job} />

      <div hidden={showing !== "mine"}>{p.mine}</div>
      {showing === "done" && doc && (
        <Done doc={doc} stale={changed.length > 0 ? staleNotice(staleSentence(changed)) : null} chip={p.chip} onSeek={p.onSeek} />
      )}
    </div>
  );
}

function Failure({ job }: { job: Pick<JobState, "error" | "errorCode"> }) {
  if (!job.error) return null;
  const e = llmErrorView("summarize", job.error, job.errorCode);
  return (
    <div className="text-xs leading-5 text-destructive" role="alert">
      {e.text}
      {e.settings && <OpenSettings />}
      <ErrorDetail detail={e.detail} />
    </div>
  );
}

function Done({ doc, stale, chip, onSeek }: { doc: SummaryDoc; stale: string | null; chip: (ids: string[]) => ReactNode; onSeek: (t: number) => void }) {
  const v = enhancedView(doc);
  return (
    <article className="flex flex-col gap-5" aria-label={VIEW_DONE}>
      {stale && <p className="m-0 rounded-md bg-memo-wash px-3 py-2 text-xs leading-5" role="status">{stale}</p>}
      {v.noMemo && <p className="m-0 text-xs text-muted-foreground">{NO_MEMO_NOTICE}</p>}
      {v.memo.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {v.memo.map((s) => (
            <li key={s.source ?? s.heading}>
              <div className="flex items-baseline gap-2 border-l-2 border-memo pl-3">
                <span className="min-w-0 flex-1 text-[14px] font-semibold leading-6 text-foreground">{s.heading}</span>
                {s.at !== undefined && (
                  <button type="button" className={CHIP} onClick={() => onSeek(s.at!)} title={`${fmtTime(s.at)} 위치로 이동`}>
                    {fmtTime(s.at)}
                  </button>
                )}
              </div>
              <Items section={s} chip={chip} empty={NO_DETAIL} />
            </li>
          ))}
        </ol>
      )}
      {v.extra.length > 0 && (
        <section className="flex flex-col gap-3" aria-label={EXTRA_TITLE}>
          <h3 className="m-0 text-xs font-semibold text-subtle-foreground">{EXTRA_TITLE}</h3>
          {v.extra.map((s, n) => (
            <div key={n}>
              <p className="m-0 text-[13px] font-medium leading-6 text-foreground">{s.heading}</p>
              <Items section={s} chip={chip} />
            </div>
          ))}
        </section>
      )}
      {v.todos.map((s, n) => (
        <section key={n} className="flex flex-col gap-1" aria-label={s.heading}>
          <h3 className="m-0 text-[13px] font-semibold">{s.heading}</h3>
          <Items section={s} chip={chip} />
        </section>
      ))}
    </article>
  );
}

function Items({ section, chip, empty }: { section: SummarySection; chip: (ids: string[]) => ReactNode; empty?: string }) {
  if (section.items.length === 0) return empty ? <p className="m-0 mt-1 pl-3.5 text-xs text-subtle-foreground">{empty}</p> : null;
  const todo = section.style === "checklist";
  return (
    <ul className={cn("m-0 mt-1 flex list-none flex-col gap-1 p-0", !todo && "pl-3.5")}>
      {section.items.map((it: SummaryItem, n) => (
        <li key={n} className="flex items-start gap-2 text-[14px] leading-6 text-muted-foreground">
          {todo ? <span className="mt-[5px] size-3.5 shrink-0 rounded-[4px] border-[1.5px] border-border-strong" aria-hidden /> : <span className="mt-[11px] size-1 shrink-0 rounded-full bg-subtle-foreground" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className={todo ? "text-foreground" : ""}>{it.text}</span>
            {(it.owner || it.due) && <span className="block text-xs text-subtle-foreground">{[it.owner, it.due].filter(Boolean).join(" · ")}</span>}
          </span>
          <span className="flex shrink-0 gap-1 pt-0.5">{chip(it.segment_ids)}</span>
        </li>
      ))}
    </ul>
  );
}
