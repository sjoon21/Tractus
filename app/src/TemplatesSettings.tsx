// 설정 › 요약 템플릿 (docs/desktop.md §2.13): 기본 유형(읽기 전용, `복사해서 만들기`)과 내 유형(만들기·고치기·삭제).
// 입력 검사는 summaries.checkTemplate (코어와 같은 한도·문장). 삭제는 앱 안에서 한 번 더 묻는다. 글자 조합(IME) 중에는 Enter·Esc를 가로채지 않는다.
import { useCallback, useEffect, useId, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/components/ui/utils";
import { api, errDetail, errText } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { isImeKey } from "./lib";
import { checkTemplate, copyDraft, MAX_DESC, MAX_NAME, promptCounter, type TemplateDraft, type TemplateInfo } from "./summaries";

const CARD = "m-0 list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0";
const SUB = "m-0 mt-2 px-1 text-xs font-medium text-muted-foreground";
const NAME = "block text-[13px] font-medium text-foreground";
const DESC = "mt-0.5 block text-xs leading-relaxed text-muted-foreground";
const ERR = "text-xs text-destructive";

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
      const tpl = await api.templatesSave(id, d.name, d.description, d.prompt);
      setMsg(t("‘{name}’ 요약 유형을 저장했습니다.", { name: tpl.name }));
      setEditing(null);
      setError(null);
      load();
    } catch (e) {
      setError({ text: errText(e), detail: errDetail(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tpl: TemplateInfo) => {
    setBusy(true);
    try {
      await api.templatesDelete(tpl.id);
      setMsg(t("‘{name}’ 요약 유형을 삭제했습니다.", { name: tpl.name }));
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

  const builtin = (list ?? []).filter((tpl) => tpl.builtin);
  const mine = (list ?? []).filter((tpl) => !tpl.builtin);

  const form = editing && <TemplateForm key={editing.id ?? "new"} id={editing.id} initial={editing.draft} busy={busy} onSave={save} onCancel={() => setEditing(null)} />;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="templates-title">
      <header className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 id="templates-title" className="m-0 text-[13px] font-semibold">
            {t("요약 템플릿")}
          </h2>
          <p className="m-0 mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t("요약 방법을 정해 두고 요약 탭에서 고릅니다. 기본 유형은 복사해서 고칠 수 있습니다.")}
          </p>
        </div>
        {list && !editing && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing({ id: null, draft: EMPTY })}>
            <Plus aria-hidden />
            {t("새 유형 만들기")}
          </Button>
        )}
      </header>
      {error && (
        <div className={cn(ERR, "px-1")} role="alert">
          {error.text}
          <ErrorDetail detail={error.detail} />
        </div>
      )}
      {!list && !error && <p className="m-0 rounded-lg border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">{t("불러오는 중…")}</p>}

      {list && (
        <>
          <h3 className={SUB}>{t("기본 유형")}</h3>
          <ul className={CARD}>
            {builtin.map((tpl) => (
              <li key={tpl.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <span className={NAME}>{tpl.name}</span>
                    <span className={DESC}>{tpl.description}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="-my-0.5" disabled={busy} onClick={() => setEditing({ id: null, draft: copyDraft(tpl) })} aria-label={t("{name} 복사해서 만들기", { name: tpl.name })}>
                    {t("복사해서 만들기")}
                  </Button>
                </div>
                <details className="mt-1.5">
                  <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">{t("요약 방법 보기")}</summary>
                  <pre className="m-0 mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-sans text-xs leading-relaxed text-muted-foreground">{tpl.prompt}</pre>
                </details>
              </li>
            ))}
          </ul>

          <h3 className={SUB}>{t("내 유형")}</h3>
          <div className={CARD}>
            {mine.length === 0 && !editing && <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{t("아직 만든 요약 유형이 없습니다.")}</p>}
            {mine.length > 0 && (
              <ul className="m-0 list-none divide-y divide-border p-0">
                {mine.map((tpl) =>
                  editing?.id === tpl.id ? null : (
                    <li key={tpl.id} className="flex items-start justify-between gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <span className={NAME}>{tpl.name}</span>
                        <span className={DESC}>{tpl.description}</span>
                      </div>
                      <div className="-my-0.5 flex shrink-0 gap-1">
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing({ id: tpl.id, draft: { name: tpl.name, description: tpl.description, prompt: tpl.prompt } })} aria-label={t("{name} 고치기", { name: tpl.name })}>
                          {t("고치기")}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => setAsking(tpl)} aria-label={t("{name} 삭제", { name: tpl.name })}>
                          {t("삭제")}
                        </Button>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
            {form}
          </div>
        </>
      )}
      {msg && (
        <p className="m-0 px-1 text-xs text-muted-foreground" role="status">
          {msg}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={t("‘{name}’ 요약 유형을 삭제할까요?", { name: asking.name })}
          body={t("이 유형으로 이미 만든 요약은 노트에 그대로 남습니다.")}
          cancelLabel={t("취소")}
          confirmLabel={t("삭제")}
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
  const label = "mb-1.5 block text-xs font-medium text-muted-foreground";
  return (
    <div className="flex flex-col gap-4 bg-muted/40 px-4 py-4" role="group" aria-label={id ? t("요약 유형 고치기") : t("새 요약 유형")}>
      <div>
        <label className={label} htmlFor={ids.name}>
          {t("이름 ({n}자까지)", { n: MAX_NAME })}
        </label>
        <Input id={ids.name} className="max-w-sm" value={d.name} spellCheck={false} autoFocus aria-invalid={tried && !!check.name} onChange={(e) => setD({ ...d, name: e.target.value })} onKeyDown={(e) => key(e, true)} {...ime} />
        {tried && check.name && (
          <span className={cn(ERR, "mt-1 block")} role="alert">
            {check.name}
          </span>
        )}
      </div>
      <div>
        <label className={label} htmlFor={ids.desc}>
          {t("한 줄 설명 (선택, {n}자까지)", { n: MAX_DESC })}
        </label>
        <Input id={ids.desc} className="max-w-md" value={d.description} spellCheck={false} aria-invalid={!!check.description} onChange={(e) => setD({ ...d, description: e.target.value })} onKeyDown={(e) => key(e, true)} {...ime} />
        {check.description && (
          <span className={cn(ERR, "mt-1 block")} role="alert">
            {check.description}
          </span>
        )}
      </div>
      <div>
        <label className={label} htmlFor={ids.prompt}>
          {t("요약 방법")}
        </label>
        <Textarea
          id={ids.prompt}
          className="min-h-40 font-mono text-xs aria-invalid:border-destructive"
          rows={9}
          value={d.prompt}
          spellCheck={false}
          aria-invalid={tried && !!check.prompt}
          onChange={(e) => setD({ ...d, prompt: e.target.value })}
          onKeyDown={(e) => key(e, false)}
          {...ime}
        />
        <div className="mt-1 flex items-start justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            <span className={ERR} role="alert">
              {tried || d.prompt.trim() ? check.prompt : null}
            </span>
            {!(tried || d.prompt.trim()) || !check.prompt ? t("섹션 구성과 어투를 정합니다. 근거 표시와 출력 형식은 항상 앱이 정한 규칙을 따릅니다.") : null}
          </span>
          <span className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", check.prompt && d.prompt.trim() && "text-destructive")}>{promptCounter(d.prompt)}</span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-subtle-foreground">{t("⌘Enter로 저장합니다.")}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          {t("취소")}
        </Button>
        <Button size="sm" disabled={busy} aria-disabled={!check.ok} onClick={submit}>
          {t("저장")}
        </Button>
      </div>
    </div>
  );
}
