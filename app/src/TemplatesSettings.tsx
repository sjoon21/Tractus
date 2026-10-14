// 설정 › 요약 템플릿 (docs/desktop.md §2.13): 기본 유형(읽기 전용, `복사해서 만들기`)과 내 유형(만들기·고치기·삭제).
// 입력 검사는 summaries.checkTemplate (코어와 같은 한도·문장). 삭제는 앱 안에서 한 번 더 묻는다. 글자 조합(IME) 중에는 Enter·Esc를 가로채지 않는다.
import { useCallback, useEffect, useId, useState } from "react";
import { api, errDetail, errText } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { isImeKey } from "./lib";
import { checkTemplate, copyDraft, MAX_DESC, MAX_NAME, promptCounter, type TemplateDraft, type TemplateInfo } from "./summaries";

const EMPTY: TemplateDraft = { name: "", description: "", prompt: "" };

export function TemplatesSection() {
  const [list, setList] = useState<TemplateInfo[] | null>(null);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: TemplateDraft } | null>(null);
  const [asking, setAsking] = useState<TemplateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    api.templatesList().then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e) => setError({ text: errText(e), detail: errDetail(e) }),
    );
  }, []);
  useEffect(load, [load]);

  const save = async (id: string | null, d: TemplateDraft) => {
    setBusy(true);
    try {
      const t = await api.templatesSave(id, d.name, d.description, d.prompt);
      setMsg(`‘${t.name}’ 요약 유형을 저장했습니다.`);
      setEditing(null);
      setError(null);
      load();
    } catch (e) {
      setError({ text: errText(e), detail: errDetail(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: TemplateInfo) => {
    setBusy(true);
    try {
      await api.templatesDelete(t.id);
      setMsg(`‘${t.name}’ 요약 유형을 삭제했습니다.`);
      setAsking(null);
      setError(null);
      load();
    } catch (e) {
      setAsking(null);
      setError({ text: errText(e), detail: errDetail(e) });
    } finally {
      setBusy(false);
    }
  };

  const builtin = (list ?? []).filter((t) => t.builtin);
  const mine = (list ?? []).filter((t) => !t.builtin);

  return (
    <section className="templates" aria-labelledby="templates-title">
      <h2 id="templates-title">요약 템플릿</h2>
      <p className="field-hint">
        요약 유형마다 AI에게 주는 요약 방법이 있습니다. 기본 유형은 고칠 수 없지만 ‘복사해서 만들기’로 내 유형을 만들어 다듬을 수 있습니다. 노트의 요약 탭에서 유형을 고르면 그 방법대로 요약합니다.
      </p>
      {error && (
        <div className="inline-error" role="alert">
          {error.text}
          <ErrorDetail detail={error.detail} />
        </div>
      )}
      {!list && !error && <p className="voices-empty">불러오는 중…</p>}

      {list && (
        <>
          <h3>기본 유형</h3>
          <ul className="template-list">
            {builtin.map((t) => (
              <li key={t.id}>
                <span className="template-name">{t.name}</span>
                <span className="template-desc">{t.description}</span>
                <button type="button" className="text-button" disabled={busy} onClick={() => setEditing({ id: null, draft: copyDraft(t) })} aria-label={`${t.name} 복사해서 만들기`}>
                  복사해서 만들기
                </button>
                <details className="template-prompt">
                  <summary>요약 방법 보기</summary>
                  <pre>{t.prompt}</pre>
                </details>
              </li>
            ))}
          </ul>

          <h3>내 유형</h3>
          {mine.length === 0 && !editing && <p className="voices-empty">아직 만든 요약 유형이 없습니다.</p>}
          <ul className="template-list">
            {mine.map((t) =>
              editing?.id === t.id ? null : (
                <li key={t.id}>
                  <span className="template-name">{t.name}</span>
                  <span className="template-desc">{t.description}</span>
                  <button type="button" className="text-button" disabled={busy} onClick={() => setEditing({ id: t.id, draft: { name: t.name, description: t.description, prompt: t.prompt } })} aria-label={`${t.name} 고치기`}>
                    고치기
                  </button>
                  <button type="button" className="text-button is-danger" disabled={busy} onClick={() => setAsking(t)} aria-label={`${t.name} 삭제`}>
                    삭제
                  </button>
                </li>
              ),
            )}
          </ul>

          {editing ? (
            <TemplateForm key={editing.id ?? "new"} id={editing.id} initial={editing.draft} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <button type="button" className="ghost-button" disabled={busy} onClick={() => setEditing({ id: null, draft: EMPTY })}>
              새 유형 만들기
            </button>
          )}
        </>
      )}
      {msg && (
        <p className="field-hint" role="status">
          {msg}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={`‘${asking.name}’ 요약 유형을 삭제할까요?`}
          body="이 유형으로 이미 만든 요약은 노트에 그대로 남습니다."
          cancelLabel="취소"
          confirmLabel="삭제"
          busy={busy}
          onCancel={() => setAsking(null)}
          onConfirm={() => void remove(asking)}
        />
      )}
    </section>
  );
}

function TemplateForm({ id, initial, busy, onSave, onCancel }: { id: string | null; initial: TemplateDraft; busy: boolean; onSave: (id: string | null, d: TemplateDraft) => void; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const [tried, setTried] = useState(false);
  const [composing, setComposing] = useState(false);
  const check = checkTemplate(d);
  const ids = { name: useId(), desc: useId(), prompt: useId() };
  const submit = () => {
    setTried(true);
    if (check.ok && !busy) onSave(id, d);
  };
  const key = (e: React.KeyboardEvent, submitOnEnter: boolean) => {
    if (isImeKey(e.nativeEvent, composing)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (submitOnEnter ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const ime = { onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false) };
  return (
    <div className="template-form" role="group" aria-label={id ? "요약 유형 고치기" : "새 요약 유형"}>
      <div className="field">
        <label className="field-label" htmlFor={ids.name}>
          이름 ({MAX_NAME}자까지)
        </label>
        <input id={ids.name} value={d.name} spellCheck={false} autoFocus aria-invalid={tried && !!check.name} onChange={(e) => setD({ ...d, name: e.target.value })} onKeyDown={(e) => key(e, true)} {...ime} />
        {tried && check.name && <span className="inline-error" role="alert">{check.name}</span>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.desc}>
          한 줄 설명 (선택, {MAX_DESC}자까지)
        </label>
        <input id={ids.desc} value={d.description} spellCheck={false} aria-invalid={!!check.description} onChange={(e) => setD({ ...d, description: e.target.value })} onKeyDown={(e) => key(e, true)} {...ime} />
        {check.description && <span className="inline-error" role="alert">{check.description}</span>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.prompt}>
          요약 방법
        </label>
        <textarea
          id={ids.prompt}
          className="summary-prompt"
          rows={9}
          value={d.prompt}
          spellCheck={false}
          aria-invalid={tried && !!check.prompt}
          onChange={(e) => setD({ ...d, prompt: e.target.value })}
          onKeyDown={(e) => key(e, false)}
          {...ime}
        />
        <div className="summary-prompt-foot">
          <span className="inline-error" role="alert">
            {tried || d.prompt.trim() ? check.prompt : null}
          </span>
          <span className={`tnum field-hint ${check.prompt && d.prompt.trim() ? "is-over" : ""}`}>{promptCounter(d.prompt)}</span>
        </div>
        <span className="field-hint">섹션 구성과 어투를 정합니다. 근거 표시와 출력 형식은 항상 앱이 정한 규칙을 따릅니다. ⌘Enter로 저장합니다.</span>
      </div>
      <div className="template-form-actions">
        <button type="button" className="primary-button" disabled={busy} aria-disabled={!check.ok} onClick={submit}>
          저장
        </button>
        <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
