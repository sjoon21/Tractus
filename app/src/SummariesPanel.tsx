// 노트의 `요약` 탭 (docs/desktop.md §2.13): 요약 유형 고르기 + 만들기, 만든 요약의 탭, 선택한 요약(복사·다시 만들기·삭제).
// 요약은 한 번에 하나씩 차례로 만든다(summaryQueue.ts). 요약 파일 읽기·복사·순서는 summaries.ts, 새 요약은 섹션 렌더러, 옛 요약(결정 사항·할 일·주제)은 옛 모양 그대로.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errText, useJob, type JobState } from "./api";
import type { Notify } from "./App";
import { ConfirmDialog } from "./ConfirmDialog";
import { CustomSummaryDialog } from "./CustomSummaryDialog";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { LlmServicePicker, useLlmServices } from "./LlmServicePicker";
import { STAGE_LABEL } from "./lib";
import { llmErrorView } from "./llmKey";
import { OpenSettings } from "./OpenSettings";
import { staleSentence, type EditKind } from "./memo";
import {
  afterDelete,
  defaultPick,
  FALLBACK_SPEC,
  docMarkdown,
  orderDocs,
  pickLabel,
  pickSelected,
  rerunSpec,
  specsFromPick,
  summaryTabDocs,
  summaryTemplates,
  tabLabels,
  togglePick,
  type SummaryDoc,
  type SummarySpec,
  type TemplateInfo,
} from "./summaries";
import { IDLE_QUEUE, queueAdvance, queueFail, queueLabel, queueStart, type QueueState } from "./summaryQueue";
import { Copy, LoaderCircle, NotebookPen, PencilLine, RotateCw, Trash2 } from "lucide-react";
import { MENU, MENU_ITEM } from "@/components/menu";
import { Button } from "@/components/ui/button";
import { selectClass } from "@/components/ui/select";
import { checkClass } from "@/components/ui/switch";
import { cn } from "@/components/ui/utils";

export interface SummariesPanelProps {
  id: string;
  memoNote: boolean;
  /** 바뀌면 요약을 다시 읽는다 (노트가 다시 불러와졌을 때) */
  rev: number;
  /** 시작 전에 쓰던 메모를 저장한다. false면 시작하지 않는다 */
  prepare: () => Promise<boolean>;
  /** 저장 중이거나 다른 작업이 노트를 잠갔을 때 */
  blocked: boolean;
  /** 코어가 실제로 바꾼 편집 횟수와 종류. 요약마다 만들 때의 값과 견줘 '낡음'을 가른다 */
  editSeq: number;
  editSeqRef: { current: number };
  editKinds: { current: EditKind[] };
  /** 항목의 근거 칩 (시각·메모 줄) */
  chip: (ids: string[]) => ReactNode;
  starts: Map<string, number>;
  /** 복사용 메모 줄 번호 (메모 노트는 줄 번호를 붙이지 않는다) */
  memoLines: Map<string, number> | undefined;
  notify: Notify;
  onRunning: (running: boolean) => void;
  /** 고른 요약 (복사·인쇄가 쓴다) */
  onSelect: (doc: SummaryDoc | null) => void;
  /** 요약이 만들어졌거나 지워졌다 (노트 목록의 `요약 없음` 배지) */
  onChanged: () => void;
  /** 녹음 노트만: 고른 요약(마크다운, 할 일은 `- [ ]`)을 내 메모 끝에 붙인다. 없으면 단추도 없다 */
  onToMemo?: (markdown: string) => Promise<void>;
}

export function SummariesPanel(p: SummariesPanelProps) {
  const { id, rev, onRunning, onSelect, onChanged, notify } = p;
  const [docs, setDocs] = useState<SummaryDoc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null); // null = 아직 고르지 않음 → 기본 제안
  const [menuOpen, setMenuOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [asking, setAsking] = useState<SummaryDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [seqByKey, setSeqByKey] = useState<Record<string, number>>({});
  const [q, setQ] = useState<QueueState>(IDLE_QUEUE);
  const qRef = useRef(q);
  qRef.current = q;
  const launchSeq = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const services = useLlmServices("summary");

  const reload = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const d = await api.summariesList(id);
        if (alive()) setDocs(summaryTabDocs(d));
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

  const loadTemplates = useCallback(() => {
    setTemplatesFailed(false);
    api.templatesList().then((ts) => setTemplates(summaryTemplates(ts)), () => setTemplatesFailed(true));
  }, []);
  useEffect(loadTemplates, [loadTemplates]);

  const job = useJob(
    (_meeting, _warnings, key) => {
      const cur = qRef.current.current;
      const made = key ?? cur?.key ?? null;
      if (made) {
        setSeqByKey((m) => ({ ...m, [made]: launchSeq.current }));
        setSelectedKey(made);
      }
      if (cur?.custom?.save_as) loadTemplates(); // 새로 저장한 내 유형이 목록에 오게
      void reload();
      onChanged();
      setQ(queueAdvance);
    },
    () => setQ(queueFail),
  );

  // 대기열의 지금 것을 시작한다 (한 번에 하나)
  useEffect(() => {
    const cur = q.current;
    if (!cur) return;
    launchSeq.current = p.editSeqRef.current;
    void job.runJob("summary_start", { id, template: cur.template ?? null, custom: cur.custom ?? null, provider: services.provider });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 새 일이 시작될 때만 (job.runJob은 안정적이다)
  }, [q.current]);

  const running = q.current !== null;
  useEffect(() => onRunning(running), [running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);

  const ordered = useMemo(() => orderDocs(docs, templates), [docs, templates]);
  const labels = tabLabels(ordered);
  const selected = pickSelected(ordered, selectedKey);
  useEffect(() => onSelect(selected), [selected, onSelect]);

  // 요약 유형 메뉴: 바깥을 누르거나 Esc면 닫는다
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setMenuOpen(false);
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  const pick = picked ?? defaultPick(docs, templates);
  const specs = templates.length > 0 ? specsFromPick(pick, templates) : templatesFailed ? [FALLBACK_SPEC] : [];
  const start = async (list: SummarySpec[]) => {
    if (running || p.blocked || list.length === 0) return;
    if (!(await p.prepare())) return;
    setQ((s) => queueStart(s, list));
  };
  const made = new Set(docs.map((d) => d.key));
  const mine = templates.filter((t) => !t.builtin);
  const stage = STAGE_LABEL[job.job.stage ?? ""] ?? t("시작하는 중…");
  const busy = running || p.blocked;

  const remove = async (d: SummaryDoc) => {
    setDeleting(true);
    try {
      await api.summariesDelete(id, d.key);
      setSelectedKey(afterDelete(ordered, d.key));
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

  const rerun = (d: SummaryDoc) => {
    const spec = rerunSpec(d, templates);
    if (spec) void start([spec]);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-1 shadow-xs">
        <div className="relative min-w-0" ref={wrap}>
          <button
            ref={menuButton}
            type="button"
            className={cn(selectClass, "h-8 w-full truncate border-0 bg-transparent text-left text-[13px] font-medium shadow-none hover:bg-accent aria-expanded:bg-accent")}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            title={t("어떤 형태로 요약할지 고릅니다. 여러 개를 고르면 한 번에 만듭니다")}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {pickLabel(pick, templates)}
          </button>
          {menuOpen && (
            <div
              id={menuId}
              className={cn(MENU, "absolute inset-x-0 top-full z-30 mt-1 max-h-[min(70vh,34rem)] gap-0.5 overflow-y-auto")}
              role="group"
              aria-label={t("요약 유형 고르기")}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                setMenuOpen(false);
                menuButton.current?.focus();
              }}
            >
              <p className="m-0 px-2 pt-1 pb-0.5 text-xs leading-snug text-muted-foreground">{t("여러 개를 고르면 차례로 한 번에 만듭니다. 이미 만든 유형은 다시 만들어 덮어씁니다.")}</p>
              {templatesFailed && (
                <p className="m-0 flex items-center gap-1 px-2 py-1 text-xs text-destructive" role="alert">
                  {t("요약 유형을 읽지 못했습니다.")}
                  <Button variant="link" size="sm" className="h-auto text-xs" onClick={loadTemplates}>
                    {t("다시 시도")}
                  </Button>
                </p>
              )}
              <PickGroup title={t("기본 유형")} items={templates.filter((x) => x.builtin)} pick={pick} made={made} disabled={running} onToggle={(tid) => setPicked(togglePick(pick, tid))} />
              {mine.length > 0 && <PickGroup title={t("내 유형")} items={mine} pick={pick} made={made} disabled={running} onToggle={(tid) => setPicked(togglePick(pick, tid))} />}
              <hr className="my-1 border-border" />
              <button
                type="button"
                className={cn(MENU_ITEM, "disabled:opacity-45 disabled:hover:bg-transparent")}
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setCustom(true);
                }}
              >
                <PencilLine aria-hidden />
                {t("직접 프롬프트로 요약…")}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-0.5 pt-1">
        <LlmServicePicker services={services} disabled={running} />
        <Button
          size="sm"
          className="ml-auto"
          disabled={busy || specs.length === 0}
          title={p.blocked && !running ? t("저장이 끝난 뒤에 요약할 수 있습니다") : undefined}
          onClick={() => {
            setMenuOpen(false);
            void start(specs);
          }}
        >
          {running ? stage : specs.length > 1 ? t("요약 만들기 ({n})", { n: specs.length }) : t("요약 만들기")}
        </Button>
        </div>
      </div>

      {running && (
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {queueLabel(q)} · {stage}
        </p>
      )}
      {!running && q.failed && <SummaryFailure job={job.job} label={q.total > 1 ? q.failed.label : null} />}

      {ordered.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-wrap gap-0.5 rounded-lg bg-foreground/[0.06] p-0.5" role="tablist" aria-label={t("만든 요약")} onKeyDown={(e) => tabKey(e, ordered, selected, setSelectedKey)}>
            {ordered.map((d, i) => (
              <button
                key={d.key}
                id={`sumtab-${d.key}`}
                type="button"
                role="tab"
                aria-selected={d.key === selected?.key}
                aria-controls="summary-doc"
                tabIndex={d.key === selected?.key ? 0 : -1}
                className="h-6 max-w-[12rem] truncate rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-xs dark:aria-selected:bg-foreground/15"
                onClick={() => setSelectedKey(d.key)}
              >
                {labels[i]}
              </button>
            ))}
          </div>
          {selected && (
            <div className="ml-auto flex shrink-0 items-center text-muted-foreground">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-inherit hover:text-foreground"
                aria-label={t("요약 복사")}
                title={t("요약 복사 (마크다운)")}
                onClick={() =>
                  navigator.clipboard.writeText(docMarkdown(selected, p.starts, p.memoLines)).then(
                    () => notify({ text: t("요약을 마크다운으로 복사했습니다") }),
                    (e) => notify({ text: t("복사하지 못했습니다: {error}", { error: errText(e) }), error: true }),
                  )
                }
              >
                <Copy />
              </Button>
              {p.onToMemo && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-inherit hover:text-foreground"
                  aria-label={t("메모로 보내기")}
                  title={t("이 요약을 내 메모 끝에 붙입니다 (할 일은 체크박스로)")}
                  disabled={busy || p.blocked}
                  onClick={() => void p.onToMemo?.(docMarkdown(selected, p.starts, p.memoLines))}
                >
                  <NotebookPen />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-inherit hover:text-foreground"
                aria-label={t("다시 만들기")}
                title={rerunSpec(selected, templates) ? t("다시 만들기") : t("요약 방법을 알 수 없어 다시 만들 수 없습니다")}
                disabled={busy || !rerunSpec(selected, templates)}
                onClick={() => rerun(selected)}
              >
                <RotateCw />
              </Button>
              <Button variant="ghost" size="icon-sm" className="text-inherit hover:text-destructive" aria-label={t("삭제")} title={t("삭제")} disabled={busy} onClick={() => setAsking(selected)}>
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
      )}

      {selected ? (
        <div id="summary-doc" role="tabpanel" aria-labelledby={`sumtab-${selected.key}`} className="flex flex-col gap-6">
          {p.editSeq > (seqByKey[selected.key] ?? 0) && (
            <div className="flex flex-col items-start gap-1 rounded-md bg-memo-wash px-3 py-2 text-xs leading-5" role="status">
              <p className="m-0">{t("{sentence}. 이 요약에는 아직 반영되지 않았습니다.", { sentence: staleSentence(p.editKinds.current.slice(seqByKey[selected.key] ?? 0)) })}</p>
              {rerunSpec(selected, templates) && (
                <Button variant="link" size="sm" className="text-xs font-semibold text-memo hover:text-memo" disabled={busy} onClick={() => rerun(selected)}>
                  {running ? stage : t("요약 다시 만들기")}
                </Button>
              )}
            </div>
          )}
          {selected.legacy ? <LegacyBody doc={selected} chip={p.chip} /> : <SectionsBody doc={selected} chip={p.chip} />}
        </div>
      ) : (
        loaded && (
          <p className="m-0 max-w-[34ch] text-[13px] leading-relaxed text-muted-foreground">
            {p.memoNote ? t("아직 요약이 없습니다. 요약 유형을 고르고 ‘요약 만들기’를 누르면 근거가 된 줄과 함께 정리합니다.") : t("아직 요약이 없습니다. 요약 유형을 고르고 ‘요약 만들기’를 누르면 근거 대화와 함께 정리합니다.")}
          </p>
        )
      )}

      {custom && (
        <CustomSummaryDialog
          onCancel={() => setCustom(false)}
          onSubmit={(spec) => {
            setCustom(false);
            void start([spec]);
          }}
        />
      )}
      {asking && (
        <ConfirmDialog
          title={t("‘{name}’ 요약을 삭제할까요?", { name: asking.name })}
          body={t("노트와 대화 내용은 그대로 남습니다. 요약은 언제든 다시 만들 수 있습니다.")}
          cancelLabel={t("취소")}
          confirmLabel={t("삭제")}
          busy={deleting}
          onCancel={() => setAsking(null)}
          onConfirm={() => void remove(asking)}
        />
      )}
    </div>
  );
}

// 테스트가 찾는 클래스(pick-text·pick-name, summary-lead, rail-list, action-meta, topic-list)는 표시만 하고 모양은 감싼 요소가 정한다
const PICK_GROUP =
  "m-0 min-w-0 border-0 p-0 [&_legend]:px-2 [&_legend]:pt-2 [&_legend]:pb-1 [&_legend]:text-xs [&_legend]:font-medium [&_legend]:text-muted-foreground [&_.pick-text]:grid [&_.pick-text]:min-w-0 [&_.pick-text]:gap-px [&_.pick-name]:text-[13px] [&_.pick-name]:font-medium [&_em]:ml-1.5 [&_em]:text-xs [&_em]:font-normal [&_em]:not-italic [&_em]:text-subtle-foreground [&_small]:text-xs [&_small]:leading-snug [&_small]:text-muted-foreground";

export function PickGroup({ title, items, pick, made, disabled, onToggle }: { title: string; items: TemplateInfo[]; pick: string[]; made: Set<string>; disabled: boolean; onToggle: (id: string) => void }) {
  return (
    <fieldset className={PICK_GROUP}>
      <legend>{title}</legend>
      {items.map((tpl) => (
        <label key={tpl.id} className="flex cursor-pointer items-start gap-2.5 rounded-[5px] px-2 py-1.5 focus-within:bg-accent hover:bg-accent">
          <input type="checkbox" className={cn(checkClass, "mt-0.5")} checked={pick.includes(tpl.id)} disabled={disabled} onChange={() => onToggle(tpl.id)} />
          <span className="pick-text">
            <span className="pick-name">
              {tpl.name}
              {made.has(tpl.id) && <em>{t("만들어짐")}</em>}
            </span>
            {tpl.description && <small>{tpl.description}</small>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** ← → Home End로 탭을 옮긴다 (선택과 초점이 함께 간다). Shift+←→는 재생 단축키와 겹치므로 막는다 */
function tabKey(e: React.KeyboardEvent, docs: SummaryDoc[], selected: SummaryDoc | null, select: (key: string) => void) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const i = docs.findIndex((d) => d.key === selected?.key);
  const next = e.key === "ArrowRight" ? (i + 1) % docs.length : e.key === "ArrowLeft" ? (i - 1 + docs.length) % docs.length : e.key === "Home" ? 0 : e.key === "End" ? docs.length - 1 : null;
  if (next === null) return;
  e.preventDefault();
  select(docs[next].key);
  document.getElementById(`sumtab-${docs[next].key}`)?.focus();
}

/** 만들지 못했다: 코드 문장 또는 "요약하지 못했습니다" + 원래 문구(자세히). 여러 유형 중 하나가 실패했으면 어느 것인지 앞에 붙인다 */
function SummaryFailure({ job, label }: { job: Pick<JobState, "error" | "errorCode">; label: string | null }) {
  if (!job.error) return null;
  const e = llmErrorView("summarize", job.error, job.errorCode);
  return (
    <div className="text-xs leading-5 text-destructive" role="alert">
      {label ? t("‘{label}’ — ", { label }) : ""}
      {e.text}
      {e.settings && <OpenSettings />}
      <ErrorDetail detail={e.detail} />
    </div>
  );
}

function Meta({ owner, due }: { owner: string | null; due: string | null }) {
  if (!owner && !due) return null;
  return (
    <span className="action-meta">
      {owner && <span>{owner}</span>}
      {due && <span>{due}</span>}
    </span>
  );
}

/** 요약 본문: 개요는 읽는 글, 섹션 제목 13px, 항목 14px. 근거 칩은 줄 끝 */
const BODY =
  "flex flex-col gap-6 [&_.summary-lead]:m-0 [&_.summary-lead]:text-[14px] [&_.summary-lead]:leading-6 [&_.summary-lead]:text-foreground [&_.rail-list]:m-0 [&_.rail-list]:flex [&_.rail-list]:list-none [&_.rail-list]:flex-col [&_.rail-list]:gap-1 [&_.rail-list]:p-0 [&_.action-meta]:mt-0.5 [&_.action-meta]:flex [&_.action-meta]:flex-wrap [&_.action-meta]:gap-x-1.5 [&_.action-meta]:text-xs [&_.action-meta]:leading-5 [&_.action-meta]:text-muted-foreground [&_.action-meta>span+span]:before:mr-1.5 [&_.action-meta>span+span]:before:content-['·'] [&_.topic-list]:m-0 [&_.topic-list]:flex [&_.topic-list]:list-none [&_.topic-list]:flex-col [&_.topic-list]:gap-1 [&_.topic-list]:p-0 [&_.topic-list_li]:flex [&_.topic-list_li]:items-baseline [&_.topic-list_li]:gap-2.5 [&_.topic-list_li]:p-0 [&_.topic-list_li]:text-[14px] [&_.topic-list_li]:leading-6";

type ListStyle = "numbered" | "checklist" | "bullets";

/** 항목 앞 표시: 번호 / 빈 네모(할 일) / 점. 목록 요소가 이미 번호·항목을 말하므로 화면 읽기에서는 숨긴다 */
function Marker({ style, n }: { style: ListStyle; n: number }) {
  if (style === "numbered") return <span className="w-4 shrink-0 pt-px text-right text-xs font-medium leading-6 text-subtle-foreground tabular-nums" aria-hidden>{n}</span>;
  if (style === "checklist") return <span className="mt-[5px] size-3.5 shrink-0 rounded-[4px] border-[1.5px] border-border-strong" aria-hidden />;
  return <span className="mt-[11px] ml-1.5 mr-0.5 size-1 shrink-0 rounded-full bg-subtle-foreground" aria-hidden />;
}

/** 한 항목: 표시 · 글(+담당·기한) · 근거 칩 */
function Item({ style, n, text, meta, chip }: { style: ListStyle; n: number; text: ReactNode; meta?: ReactNode; chip: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 border-0 p-0 text-[14px] leading-6 before:content-none">
      <Marker style={style} n={n} />
      <span className="min-w-0 flex-1">
        {text}
        {meta}
      </span>
      <span className="shrink-0 pt-0.5 empty:hidden">{chip}</span>
    </li>
  );
}

function Heading({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h2 className="m-0 mb-1.5 flex items-baseline gap-1.5 border-0 p-0 text-[13px] font-semibold">
      {children}
      {count !== undefined && " "}
      {count !== undefined && <span className="text-xs font-normal text-subtle-foreground tabular-nums">{count}</span>}
    </h2>
  );
}

/** 새 요약: 개요 + 유형이 정한 섹션들. 섹션 스타일: 번호 목록 / 체크리스트 / 글머리 */
export function SectionsBody({ doc, chip }: { doc: SummaryDoc; chip: (ids: string[]) => ReactNode }) {
  return (
    <div className={BODY}>
      {doc.overview.trim() && <p className="summary-lead">{doc.overview}</p>}
      {doc.sections
        .filter((s) => s.items.length > 0)
        .map((s, n) => {
          const items = s.items.map((it, i) => <Item key={i} style={s.style} n={i + 1} text={it.text} meta={<Meta owner={it.owner} due={it.due} />} chip={chip(it.segment_ids)} />);
          return (
            <section key={n}>
              <Heading count={s.items.length}>{s.heading}</Heading>
              {s.style === "numbered" ? <ol className="rail-list">{items}</ol> : <ul className={`rail-list ${s.style === "checklist" ? "is-actions" : "is-bullets"}`}>{items}</ul>}
            </section>
          );
        })}
    </div>
  );
}

/** 옛 요약(결정 사항·할 일·주제): 예전 구성 그대로 */
export function LegacyBody({ doc, chip }: { doc: SummaryDoc; chip: (ids: string[]) => ReactNode }) {
  const s = doc.legacy!;
  return (
    <div className={BODY}>
      <p className="summary-lead">{s.summary}</p>

      {s.decisions.length > 0 && (
        <section>
          <Heading count={s.decisions.length}>{t("결정 사항")}</Heading>
          <ol className="rail-list">
            {s.decisions.map((d, i) => (
              <Item key={i} style="numbered" n={i + 1} text={d.text} chip={chip(d.segment_ids)} />
            ))}
          </ol>
        </section>
      )}

      {s.action_items.length > 0 && (
        <section>
          <Heading count={s.action_items.length}>{t("할 일")}</Heading>
          <ul className="rail-list is-actions">
            {s.action_items.map((a, i) => (
              <Item key={i} style="checklist" n={i + 1} text={a.task} meta={<Meta owner={a.owner} due={a.due} />} chip={chip(a.segment_ids)} />
            ))}
          </ul>
        </section>
      )}

      {s.topics.length > 0 && (
        <section>
          <Heading>{t("주제")}</Heading>
          <ul className="topic-list">
            {s.topics.map((tp, i) => (
              <li key={i}>
                {chip(tp.segment_ids)}
                <span>{tp.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
