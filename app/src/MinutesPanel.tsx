// 녹음 노트의 `회의록` 탭 (docs/design/meeting-minutes.md, WORDS.md §4.23).
// 만들기는 요약과 같은 작업(summary_start --template minutes)이고, 칸은 `minutes show|save`로 읽고 고친다.
// 위키용 Markdown과 짧은 판은 코어가 그린다(복사할 글이 내보내기·Obsidian과 같게). 고치기는 칸 단위라 근거 칩이 남는다.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, LoaderCircle, MessageSquareText, Trash2 } from "lucide-react";
import { api, errText, useJob, type JobState } from "./api";
import type { Notify } from "./App";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { LlmServicePicker, useLlmServices } from "./LlmServicePicker";
import { llmErrorView } from "./llmKey";
import { staleSentence, type EditKind } from "./memo";
import { MINUTES_KEY, missing, setActionField, setLine, whoOf, type LinePath, type MAction, type MLine, type Minutes, type MinutesShown } from "./minutes";
import { OpenSettings } from "./OpenSettings";
import { LegacyBody } from "./SummariesPanel";
import { DEFAULT_KEY, type SummaryDoc } from "./summaries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";

const MAKE = t("회의록 만들기"); // words-ok: 회의록은 문서 이름
const REDO = t("다시 만들기");
const RUNNING = t("회의록을 쓰는 중…"); // words-ok: 회의록은 문서 이름
const EDIT_HINT = t("두 번 눌러 고칩니다. 비우면 지웁니다");
const NO_WHO = t("담당 미정");
const NO_DUE = t("기한 미정");
const DOC = t("회의록"); // words-ok: 회의록은 문서 이름
const COPY_TITLE = t("위키에 붙일 회의록 전체 (마크다운)"); // words-ok
const COPIED = t("회의록을 마크다운으로 복사했습니다"); // words-ok
const LEGACY_NOTE = t("이전 형식의 회의록입니다. ‘회의록 만들기’를 누르면 새 형식으로 만듭니다."); // words-ok
const EMPTY = t("아직 회의록이 없습니다. ‘회의록 만들기’를 누르면 안건·조율 사항·할 일을 근거 대화와 함께 정리합니다."); // words-ok
const REDO_TITLE = t("회의록을 다시 만들까요?"); // words-ok
const DELETE_TITLE = t("회의록을 삭제할까요?"); // words-ok
const DELETE_BODY = t("노트와 대화 내용은 그대로 남습니다. 회의록은 언제든 다시 만들 수 있습니다."); // words-ok
const stale = (sentence: string) => t("{sentence}. 이 회의록에는 아직 반영되지 않았습니다.", { sentence }); // words-ok
const saveFailed = (error: string) => t("회의록을 저장하지 못했습니다: {error}", { error }); // words-ok

export function MinutesPanel(p: {
  id: string;
  /** 노트를 다시 읽을 때마다 오른다 (MeetingView summaryRev) */
  rev: number;
  /** 지금 만들 수 없는 이유 (변환 전, 저장 중 …). 없으면 null */
  disabled: string | null;
  /** 쓰던 메모를 먼저 저장한다. 저장하지 못하면 만들지 않는다 */
  prepare: () => Promise<boolean>;
  editSeqRef: { current: number };
  editKinds: { current: EditKind[] };
  /** editSeq가 바뀔 때마다 다시 그려 낡음 안내를 보인다 */
  editSeq: number;
  chip: (ids: string[]) => ReactNode;
  notify: Notify;
  onRunning: (running: boolean) => void;
  /** 만들었거나 지웠다: 요약 탭·노트 목록을 새로 읽는다 */
  onChanged: () => void;
}) {
  const { id, rev, notify, onRunning, onChanged } = p;
  const [shown, setShown] = useState<MinutesShown | null>(null);
  const [legacy, setLegacy] = useState<SummaryDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [madeSeq, setMadeSeq] = useState(0);
  const [asking, setAsking] = useState<"redo" | "delete" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const launchSeq = useRef(0);
  const saving = useRef(Promise.resolve());
  const services = useLlmServices("summary");

  const reload = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const [s, docs] = await Promise.all([api.minutesShow(id), api.summariesList(id)]);
        if (!alive()) return;
        setShown(s);
        setLegacy(docs.find((d) => d.key === DEFAULT_KEY) ?? null);
      } catch (e) {
        if (alive()) notify({ text: errText(e), error: true });
      } finally {
        if (alive()) setLoaded(true);
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
    void reload();
    onChanged();
  });
  const running = job.job.running;
  useEffect(() => onRunning(running), [running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);

  const make = async () => {
    setAsking(null);
    if (running || p.disabled || !(await p.prepare())) return;
    launchSeq.current = p.editSeqRef.current; // 저장이 끝난 뒤의 값: 만들기 직전 저장이 낡음으로 남지 않게
    void job.runJob("summary_start", { id, template: MINUTES_KEY, custom: null, provider: services.provider });
  };

  /** 칸 하나를 고친다: 화면에 먼저 보이고, 저장은 차례로 (코어가 새로 그린 Markdown·짧은 판을 돌려준다) */
  const commit = (next: Minutes) => {
    if (!shown) return;
    const before = shown;
    setShown({ ...shown, minutes: next });
    saving.current = saving.current.then(async () => {
      try {
        const saved = await api.minutesSave(id, next);
        if (saved) setShown(saved);
      } catch (e) {
        setShown(before);
        notify({ text: saveFailed(errText(e)), error: true });
      }
    });
  };

  const copy = (text: string, done: string) =>
    navigator.clipboard.writeText(text).then(
      () => notify({ text: done }),
      (e) => notify({ text: t("복사하지 못했습니다: {error}", { error: errText(e) }), error: true }),
    );

  const remove = async () => {
    setDeleting(true);
    try {
      await api.summariesDelete(id, MINUTES_KEY);
      setAsking(null);
      await reload();
      onChanged();
    } catch (e) {
      setAsking(null);
      notify({ text: errText(e), error: true });
    } finally {
      setDeleting(false);
    }
  };

  const changed = p.editKinds.current.slice(madeSeq);
  const m = shown?.minutes;
  const gaps = m ? missing(m) : 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {shown && (
          <div className="flex items-center text-muted-foreground">
            <Button variant="ghost" size="icon-sm" className="text-inherit hover:text-foreground" aria-label={t("복사")} title={COPY_TITLE} onClick={() => void copy(shown.markdown, COPIED)}>
              <Copy />
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-inherit hover:text-foreground" aria-label={t("짧게 복사")} title={t("메신저로 바로 보낼 짧은 판 (정한 것·할 일·아직 안 정한 것)")} onClick={() => void copy(shown.short, t("짧은 판을 복사했습니다"))}>
              <MessageSquareText />
            </Button>
            <Button variant="ghost" size="icon-sm" className="text-inherit hover:text-destructive" aria-label={t("삭제")} title={t("삭제")} disabled={running} onClick={() => setAsking("delete")}>
              <Trash2 />
            </Button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          <LlmServicePicker services={services} disabled={running} />
          <Button size="sm" variant={shown ? "outline" : "default"} disabled={running || !!p.disabled} title={p.disabled ?? undefined} onClick={() => (shown?.edited_at ? setAsking("redo") : void make())}>
            {shown ? REDO : MAKE}
          </Button>
        </div>
      </div>

      {running && (
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {RUNNING}
        </p>
      )}
      <Failure job={job.job} />

      {m && shown ? (
        <article className="flex flex-col gap-5" aria-label={DOC}>
          {changed.length > 0 && (
            <p className="m-0 rounded-md bg-memo-wash px-3 py-2 text-xs leading-5" role="status">
              {stale(staleSentence(changed))}
            </p>
          )}
          <header className="flex flex-col gap-1">
            {shown.attendees.length > 0 && (
              <p className="m-0 text-xs text-muted-foreground">
                {t("참석")}: {shown.attendees.join(", ")}
              </p>
            )}
            <Editable value={m.agenda} label={t("주요 안건")} className="text-[14px] font-medium leading-6 text-foreground" onSave={(v) => commit(setLine(m, { kind: "agenda" }, v))} />
          </header>

          {m.topics.map((tp, ti) => (
            <section key={ti} className="flex flex-col gap-2" aria-label={tp.title}>
              <div className="flex items-baseline gap-2">
                <span className="text-xs tabular-nums text-subtle-foreground">{ti + 1})</span>
                <Editable value={tp.title} className="min-w-0 flex-1 text-[13px] font-semibold" onSave={(v) => commit(setLine(m, { kind: "title", topic: ti }, v))} />
                {tp.open && <Badge variant="memo">{t("추가 논의 필요")}</Badge>}
              </div>
              <Lines title={t("조율 사항")} lines={tp.agreed} chip={p.chip} path={(i) => ({ kind: "agreed", topic: ti, i })} m={m} commit={commit} strong />
              <Lines title={t("논의 내용")} lines={tp.discussed} chip={p.chip} path={(i) => ({ kind: "discussed", topic: ti, i })} m={m} commit={commit} />
              {tp.points.map((pt, pi) => (
                <div key={pi} className="flex flex-col gap-0.5">
                  <p className="m-0 text-xs font-semibold text-foreground">{pt.label}</p>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                    {pt.details.map((d, di) => (
                      <li key={di}>
                        <Row line={d} chip={p.chip} onSave={(v) => commit(setLine(m, { kind: "detail", topic: ti, point: pi, i: di }, v))} />
                        {d.children.length > 0 && (
                          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pl-4">
                            {d.children.map((c, ci) => (
                              <li key={ci}>
                                <Row line={c} chip={p.chip} onSave={(v) => commit(setLine(m, { kind: "child", topic: ti, point: pi, i: di, child: ci }, v))} />
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {tp.approach[0] && (
                <div className="rounded-md bg-accent px-3 py-2">
                  <p className="m-0 text-xs font-semibold">{t("접근 방식 정리")}</p>
                  <Row line={tp.approach[0]} chip={p.chip} onSave={(v) => commit(setLine(m, { kind: "approach", topic: ti, i: 0 }, v))} />
                </div>
              )}
            </section>
          ))}

          {m.actions.length > 0 && (
            <section className="flex flex-col gap-1" aria-label={t("향후 예정 작업")}>
              <h3 className="m-0 text-[13px] font-semibold">{t("향후 예정 작업")}</h3>
              {gaps > 0 && <p className="m-0 text-xs text-muted-foreground">{t("할 일 {n}개에 담당이나 기한이 없습니다. 눌러서 채우세요.", { n: gaps })}</p>}
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {m.actions.map((a, ai) => (
                  <Action key={ai} a={a} chip={p.chip} onText={(v) => commit(setLine(m, { kind: "action", i: ai }, v))} onField={(f, v) => commit(setActionField(m, ai, f, v))} />
                ))}
              </ul>
            </section>
          )}
          {m.next_meeting[0] && (
            <div className="flex items-baseline gap-2 text-[13px]">
              <span className="font-semibold">{t("다음에 볼 날")}</span>
              <Row line={m.next_meeting[0]} chip={p.chip} onSave={(v) => commit(setLine(m, { kind: "next", i: 0 }, v))} />
            </div>
          )}
        </article>
      ) : legacy ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-xs text-muted-foreground">{LEGACY_NOTE}</p>
          <LegacyBody doc={legacy} chip={p.chip} />
        </div>
      ) : (
        loaded &&
        !running && (
          <p className="m-0 max-w-[34ch] text-[13px] leading-relaxed text-muted-foreground">
            {EMPTY}
          </p>
        )
      )}

      {asking === "redo" && (
        <ConfirmDialog
          title={REDO_TITLE}
          body={t("다시 만들면 직접 고친 내용이 사라집니다.")}
          cancelLabel={t("취소")}
          confirmLabel={REDO}
          busy={false}
          onCancel={() => setAsking(null)}
          onConfirm={() => void make()}
        />
      )}
      {asking === "delete" && (
        <ConfirmDialog
          title={DELETE_TITLE}
          body={DELETE_BODY}
          cancelLabel={t("취소")}
          confirmLabel={t("삭제")}
          busy={deleting}
          onCancel={() => setAsking(null)}
          onConfirm={() => void remove()}
        />
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

function Lines(p: { title: string; lines: MLine[]; chip: (ids: string[]) => ReactNode; path: (i: number) => LinePath; m: Minutes; commit: (m: Minutes) => void; strong?: boolean }) {
  if (p.lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="m-0 text-xs font-semibold text-subtle-foreground">{p.title}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {p.lines.map((x, i) => (
          <li key={i}>
            <Row line={x} chip={p.chip} strong={p.strong} onSave={(v) => p.commit(setLine(p.m, p.path(i), v))} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 근거 칩이 달린 줄 하나. 근거와 다른 숫자가 있으면 `숫자 확인` */
function Row({ line, chip, onSave, strong }: { line: MLine; chip: (ids: string[]) => ReactNode; onSave: (v: string) => void; strong?: boolean }) {
  return (
    <span className="flex items-start gap-2">
      <Editable value={line.text} className={cn("min-w-0 flex-1 text-[14px] leading-6", strong ? "text-foreground" : "text-muted-foreground")} onSave={onSave} />
      {line.unverified && (
        <Badge variant="outline" className="mt-1 shrink-0" title={t("대화에 없는 숫자입니다: {nums}. 확인하세요.", { nums: line.unverified.join(", ") })}>
          {t("숫자 확인")}
        </Badge>
      )}
      <span className="flex shrink-0 gap-1 pt-0.5">{chip(line.segment_ids)}</span>
    </span>
  );
}

function Action({ a, chip, onText, onField }: { a: MAction; chip: (ids: string[]) => ReactNode; onText: (v: string) => void; onField: (f: "who" | "due", v: string) => void }) {
  const who = whoOf(a);
  return (
    <li className="flex items-start gap-2">
      <span className="mt-[5px] size-3.5 shrink-0 rounded-[4px] border-[1.5px] border-border-strong" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <Editable value={a.text} className="text-[14px] leading-6 text-foreground" onSave={onText} />
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <Editable value={who} placeholder={NO_WHO} label={t("담당")} className={who ? "text-subtle-foreground" : "font-medium text-memo"} onSave={(v) => onField("who", v)} keepEmpty />
          <span className="text-subtle-foreground" aria-hidden>
            ·
          </span>
          <Editable value={a.due ?? ""} placeholder={NO_DUE} label={t("기한")} className={a.due ? "text-subtle-foreground" : "font-medium text-memo"} onSave={(v) => onField("due", v)} keepEmpty />
          {a.note && <span className="text-subtle-foreground">{a.note}</span>}
        </span>
      </span>
      <span className="flex shrink-0 gap-1 pt-0.5">{chip(a.segment_ids)}</span>
    </li>
  );
}

/** 두 번 누르거나 Enter로 고치는 글. Enter 저장, Esc 취소. keepEmpty가 아니면 비운 줄은 지워진다(코어가 지운다) */
function Editable(p: { value: string; onSave: (v: string) => void; className?: string; label?: string; placeholder?: string; keepEmpty?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const done = (save: boolean) => {
      if (save && draft.trim() !== p.value.trim()) p.onSave(draft);
      setDraft(null);
    };
    return (
      <input
        autoFocus
        className={cn(inputClass, "h-7 min-w-0 flex-1 text-[13px]")}
        value={draft}
        aria-label={p.label ?? t("고치기")}
        placeholder={p.placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter는 글자를 끝내는 키다
          if (e.key === "Enter") done(true);
          if (e.key === "Escape") done(false);
        }}
      />
    );
  }
  const shownText = p.value || p.placeholder || "";
  return (
    <span
      role="button"
      tabIndex={0}
      className={cn("cursor-text rounded-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40", p.className)}
      title={p.keepEmpty ? t("두 번 눌러 고칩니다") : EDIT_HINT}
      aria-label={p.label ? `${p.label}: ${shownText}` : undefined}
      onDoubleClick={() => setDraft(p.value)}
      onClick={() => p.keepEmpty && !p.value && setDraft("")}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setDraft(p.value);
        }
      }}
    >
      {shownText}
    </span>
  );
}
