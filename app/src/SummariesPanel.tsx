// 노트의 `요약` 탭 (docs/desktop.md §2.13): 요약 유형 고르기 + 만들기, 만든 요약의 탭, 선택한 요약(복사·다시 만들기·삭제).
// 요약은 한 번에 하나씩 차례로 만든다(summaryQueue.ts). 요약 파일 읽기·복사·순서는 summaries.ts, 새 요약은 섹션 렌더러, 옛 요약(결정 사항·할 일·주제)은 옛 모양 그대로.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errText, useJob, type JobState } from "./api";
import type { Notify } from "./App";
import { providerLabel } from "./ask";
import { ConfirmDialog } from "./ConfirmDialog";
import { CustomSummaryDialog } from "./CustomSummaryDialog";
import { ErrorDetail } from "./ErrorDetail";
import { STAGE_LABEL } from "./lib";
import { llmErrorView } from "./llmKey";
import { OpenSettings } from "./OpenSettings";
import { staleSentence, type EditKind } from "./memo";
import {
  afterDelete,
  DEFAULT_KEY,
  DEFAULT_NAME,
  defaultPick,
  docMarkdown,
  orderDocs,
  pickLabel,
  pickSelected,
  rerunSpec,
  specsFromPick,
  tabLabels,
  togglePick,
  type SummaryDoc,
  type SummarySpec,
  type TemplateInfo,
} from "./summaries";
import { IDLE_QUEUE, queueAdvance, queueFail, queueLabel, queueStart, type QueueState } from "./summaryQueue";

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

  const reload = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const d = await api.summariesList(id);
        if (alive()) setDocs(d);
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
    api.templatesList().then(setTemplates, () => setTemplatesFailed(true));
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
    void job.runJob("summary_start", { id, template: cur.template ?? null, custom: cur.custom ?? null });
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
  const specs = templates.length > 0 ? specsFromPick(pick, templates) : templatesFailed ? [{ label: DEFAULT_NAME, key: DEFAULT_KEY }] : [];
  const start = async (list: SummarySpec[]) => {
    if (running || p.blocked || list.length === 0) return;
    if (!(await p.prepare())) return;
    setQ((s) => queueStart(s, list));
  };
  const made = new Set(docs.map((d) => d.key));
  const mine = templates.filter((t) => !t.builtin);
  const stage = STAGE_LABEL[job.job.stage ?? ""] ?? "시작하는 중…";
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
    <div className="summaries">
      <div className="summary-bar">
        <div className="template-picker" ref={wrap}>
          <button
            ref={menuButton}
            type="button"
            className="ghost-button picker-button"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            title="어떤 형태로 요약할지 고릅니다. 여러 개를 고르면 한 번에 만듭니다"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span>{pickLabel(pick, templates)}</span>
            <span aria-hidden>▾</span>
          </button>
          {menuOpen && (
            <div
              id={menuId}
              className="template-menu"
              role="group"
              aria-label="요약 유형 고르기"
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                setMenuOpen(false);
                menuButton.current?.focus();
              }}
            >
              <p className="field-hint">여러 개를 고르면 차례로 한 번에 만듭니다. 이미 만든 유형은 다시 만들어 덮어씁니다.</p>
              {templatesFailed && (
                <p className="inline-error" role="alert">
                  요약 유형을 읽지 못했습니다.{" "}
                  <button type="button" className="text-button" onClick={loadTemplates}>
                    다시 시도
                  </button>
                </p>
              )}
              <PickGroup title="기본 유형" items={templates.filter((t) => t.builtin)} pick={pick} made={made} disabled={running} onToggle={(tid) => setPicked(togglePick(pick, tid))} />
              {mine.length > 0 && <PickGroup title="내 유형" items={mine} pick={pick} made={made} disabled={running} onToggle={(tid) => setPicked(togglePick(pick, tid))} />}
              <button
                type="button"
                className="menu-action"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false);
                  setCustom(true);
                }}
              >
                직접 프롬프트로 요약…
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={busy || specs.length === 0}
          title={p.blocked && !running ? "저장이 끝난 뒤에 요약할 수 있습니다" : undefined}
          onClick={() => {
            setMenuOpen(false);
            void start(specs);
          }}
        >
          {running ? stage : specs.length > 1 ? `요약 만들기 (${specs.length})` : "요약 만들기"}
        </button>
      </div>

      {running && (
        <p className="summary-progress tnum" role="status">
          {queueLabel(q)} · {stage}
        </p>
      )}
      {!running && q.failed && <SummaryFailure job={job.job} label={q.total > 1 ? q.failed.label : null} />}

      {ordered.length > 0 && (
        <div className="summary-tabs" role="tablist" aria-label="만든 요약" onKeyDown={(e) => tabKey(e, ordered, selected, setSelectedKey)}>
          {ordered.map((d, i) => (
            <button
              key={d.key}
              id={`sumtab-${d.key}`}
              type="button"
              role="tab"
              aria-selected={d.key === selected?.key}
              aria-controls="summary-doc"
              tabIndex={d.key === selected?.key ? 0 : -1}
              onClick={() => setSelectedKey(d.key)}
            >
              {labels[i]}
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div id="summary-doc" role="tabpanel" aria-labelledby={`sumtab-${selected.key}`} className="summary">
          <div className="summary-head">
            <button
              type="button"
              className="text-button"
              onClick={() =>
                navigator.clipboard.writeText(docMarkdown(selected, p.starts, p.memoLines)).then(
                  () => notify({ text: "요약을 마크다운으로 복사했습니다" }),
                  (e) => notify({ text: `복사하지 못했습니다: ${errText(e)}`, error: true }),
                )
              }
            >
              요약 복사
            </button>
            <button type="button" className="text-button" disabled={busy || !rerunSpec(selected, templates)} title={rerunSpec(selected, templates) ? undefined : "요약 방법을 알 수 없어 다시 만들 수 없습니다"} onClick={() => rerun(selected)}>
              다시 만들기
            </button>
            <button type="button" className="text-button is-danger" disabled={busy} onClick={() => setAsking(selected)}>
              삭제
            </button>
          </div>
          {p.editSeq > (seqByKey[selected.key] ?? 0) && (
            <div className="summary-stale" role="status">
              <p>{staleSentence(p.editKinds.current.slice(seqByKey[selected.key] ?? 0))}. 이 요약에는 아직 반영되지 않았습니다.</p>
              {rerunSpec(selected, templates) && (
                <button type="button" className="text-button" disabled={busy} onClick={() => rerun(selected)}>
                  {running ? stage : "요약 다시 만들기"}
                </button>
              )}
            </div>
          )}
          {selected.legacy ? <LegacyBody doc={selected} chip={p.chip} /> : <SectionsBody doc={selected} chip={p.chip} />}
          {selected.model && <p className="summary-source">{selected.provider ? `요약: ${providerLabel(selected.provider)}(${selected.model})` : `요약: ${selected.model}`}</p>}
        </div>
      ) : (
        loaded && (
          <div className="summary-empty">
            <p>{p.memoNote ? "아직 요약이 없습니다. 요약 유형을 고르고 ‘요약 만들기’를 누르면 근거가 된 줄과 함께 정리합니다." : "아직 요약이 없습니다. 요약 유형을 고르고 ‘요약 만들기’를 누르면 근거 대화와 함께 정리합니다."}</p>
          </div>
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
          title={`‘${asking.name}’ 요약을 삭제할까요?`}
          body="노트와 대화 내용은 그대로 남습니다. 요약은 언제든 다시 만들 수 있습니다."
          cancelLabel="취소"
          confirmLabel="삭제"
          busy={deleting}
          onCancel={() => setAsking(null)}
          onConfirm={() => void remove(asking)}
        />
      )}
    </div>
  );
}

export function PickGroup({ title, items, pick, made, disabled, onToggle }: { title: string; items: TemplateInfo[]; pick: string[]; made: Set<string>; disabled: boolean; onToggle: (id: string) => void }) {
  return (
    <fieldset className="pick-group">
      <legend>{title}</legend>
      {items.map((t) => (
        <label key={t.id} className="pick-row">
          <input type="checkbox" checked={pick.includes(t.id)} disabled={disabled} onChange={() => onToggle(t.id)} />
          <span className="pick-text">
            <span className="pick-name">
              {t.name}
              {made.has(t.id) && <em>만들어짐</em>}
            </span>
            {t.description && <small>{t.description}</small>}
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
    <div className="inline-error" role="alert">
      {label ? `‘${label}’ — ` : ""}
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

/** 새 요약: 개요 + 유형이 정한 섹션들. 섹션 스타일: 번호 목록 / 체크리스트 / 글머리 */
export function SectionsBody({ doc, chip }: { doc: SummaryDoc; chip: (ids: string[]) => ReactNode }) {
  return (
    <>
      {doc.overview.trim() && <p className="summary-lead">{doc.overview}</p>}
      {doc.sections
        .filter((s) => s.items.length > 0)
        .map((s, n) => {
          const items = s.items.map((it, i) => (
            <li key={i}>
              <span>
                {it.text}
                <Meta owner={it.owner} due={it.due} />
              </span>
              {chip(it.segment_ids)}
            </li>
          ));
          return (
            <section key={n}>
              <h2 className="rail-heading">
                {s.heading} <span className="tnum">{s.items.length}</span>
              </h2>
              {s.style === "numbered" ? <ol className="rail-list">{items}</ol> : <ul className={`rail-list ${s.style === "checklist" ? "is-actions" : "is-bullets"}`}>{items}</ul>}
            </section>
          );
        })}
    </>
  );
}

/** 옛 요약(결정 사항·할 일·주제): 예전 그림 그대로 */
export function LegacyBody({ doc, chip }: { doc: SummaryDoc; chip: (ids: string[]) => ReactNode }) {
  const s = doc.legacy!;
  return (
    <>
      <p className="summary-lead">{s.summary}</p>

      {s.decisions.length > 0 && (
        <section>
          <h2 className="rail-heading">
            결정 사항 <span className="tnum">{s.decisions.length}</span>
          </h2>
          <ol className="rail-list">
            {s.decisions.map((d, i) => (
              <li key={i}>
                <span>{d.text}</span>
                {chip(d.segment_ids)}
              </li>
            ))}
          </ol>
        </section>
      )}

      {s.action_items.length > 0 && (
        <section>
          <h2 className="rail-heading">
            할 일 <span className="tnum">{s.action_items.length}</span>
          </h2>
          <ul className="rail-list is-actions">
            {s.action_items.map((a, i) => (
              <li key={i}>
                <span>
                  {a.task}
                  <Meta owner={a.owner} due={a.due} />
                </span>
                {chip(a.segment_ids)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.topics.length > 0 && (
        <section>
          <h2 className="rail-heading">주제</h2>
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
    </>
  );
}
