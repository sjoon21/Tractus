// 사전 화면 (WORDS.md §4.29, 코드 이름 glossary): 단어 더하기·붙여 넣기·찾기·고치기·지우기(되돌리기 알림).
// 저장은 코어 `tractus glossary`만 한다(glossary.md, 잠금 안에서). 순수 함수는 dictionary.ts.
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Notify } from "./App";
import { api, errDetail, errText } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { engineSkipsVocab, FIND_MIN, isMulti, matchTerms, splitTerms } from "./dictionary";
import { t } from "./i18n";
import { useCapabilities } from "./useCapabilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageBody, PageHeader } from "@/components/ui/page";
import { Section } from "@/components/ui/section";

const SENT_NOTE = t("회의록·스마트 교정을 쓰면 사전 단어도 함께 AI 서비스로 보냅니다."); // words-ok: 탭 이름 `회의록`

export function DictionaryView({ onBack, notify }: { onBack: () => void; notify: Notify }) {
  const [list, setList] = useState<{ terms: string[]; max: number } | null>(null);
  const [loadError, setLoadError] = useState<{ text: string; detail: string | null } | null>(null);
  const [draft, setDraft] = useState("");
  const [pasted, setPasted] = useState<string[] | null>(null); // 쉼표·줄바꿈이 든 붙여 넣기: 칩으로 미리 보고 한 번에 더한다
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ term: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [skipsVocab, setSkipsVocab] = useState(false);
  const track = useCapabilities().report?.doctor?.recommended_track;

  const load = useCallback(
    () =>
      api.glossaryList().then(
        (l) => (setList(l), setLoadError(null)),
        (e) => setLoadError({ text: errText(e), detail: errDetail(e) }),
      ),
    [],
  );
  useEffect(() => void load(), [load]);
  // 사전 단어를 쓰지 않는 변환 엔진(Qwen이 아닌 계열)을 고른 사람에게만 알린다. 모르면 알리지 않는다
  useEffect(() => {
    void Promise.all([api.modelsList(), api.getSettings()]).then(
      ([m, s]) => setSkipsVocab(engineSkipsVocab(m.models, s.asr_engine || null, track)),
      () => setSkipsVocab(false),
    );
  }, [track]);

  const fail = (e: unknown) => notify({ text: errText(e), detail: errDetail(e), error: true });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      void load();
    }
  };

  const add = (terms: string[]) =>
    run(async () => {
      if (!terms.length) return;
      const { added, skipped } = await api.glossaryAdd(terms);
      const term = terms.join(", ");
      if (added > 1) notify({ text: t("사전에 {n}개를 추가했습니다 (다음 녹음부터 더 정확하게 인식합니다)", { n: added }) });
      else if (added) notify({ text: t("사전에 추가했습니다 — {term} (다음 녹음부터 더 정확하게 인식합니다)", { term }) });
      else if (!skipped) notify({ text: t("이미 사전에 있습니다 — {term}", { term }) });
      if (skipped) notify({ text: t("{n}개는 추가하지 못했습니다 (40자가 넘거나 사전이 가득 찼습니다)", { n: skipped }), error: true });
      setDraft("");
      setPasted(null);
    });
  const remove = (term: string) =>
    run(async () => {
      await api.glossaryRemove([term]);
      notify({ text: t("사전에서 지웠습니다 — {term}", { term }), action: { label: t("되돌리기"), run: () => void api.glossaryAdd([term]).then(() => void load(), fail) } });
    });
  const rename = (old: string, next: string) =>
    run(async () => {
      if (next.trim() && next.trim() !== old) await api.glossaryRename(old, next);
      setEditing(null);
    });

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || busy) return;
    e.preventDefault();
    void add(splitTerms(draft));
  };
  const onEditKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || !editing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void rename(editing.term, editing.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(null);
    }
  };

  const terms = list?.terms ?? [];
  const shown = matchTerms(terms, terms.length > FIND_MIN ? q : "");
  const used = new Set(terms.slice(0, list?.max ?? terms.length)); // terms는 최근 것부터
  const chip = (term: string) =>
    editing?.term === term ? (
      <li key={term} className="list-none">
        <Input
          autoFocus
          value={editing.value}
          onChange={(e) => setEditing({ term, value: e.target.value })}
          onKeyDown={onEditKey}
          onBlur={() => setEditing(null)}
          aria-label={t("‘{term}’ 고치기", { term })}
          className="h-7 w-56"
          disabled={busy}
        />
      </li>
    ) : (
      <li key={term} className="flex h-7 max-w-full list-none items-center rounded-full border border-border bg-card text-[13px] text-foreground">
        <button
          type="button"
          className="min-w-0 truncate rounded-full py-1 pl-3 pr-1 text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label={t("‘{term}’ 고치기", { term })}
          title={t("‘{term}’ 고치기", { term })}
          disabled={busy}
          onClick={() => setEditing({ term, value: term })}
        >
          {term}
        </button>
        <button
          type="button"
          className="mr-1 grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label={t("‘{term}’ 지우기", { term })}
          title={t("‘{term}’ 지우기", { term })}
          disabled={busy}
          onClick={() => void remove(term)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </li>
    );
  return (
    <>
      <PageHeader title={t("사전")} onBack={onBack} />
      <PageBody>
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">{t("이름·제품명·전문 용어처럼 잘못 알아듣기 쉬운 단어를 적어 두면, 다음 녹음부터 텍스트로 변환할 때 더 정확하게 알아듣습니다.")}</p>
          <p className="m-0 text-xs text-subtle-foreground">{SENT_NOTE}</p>
          {skipsVocab && (
            <p role="note" className="m-0 text-xs text-foreground">
              {t("지금 고른 변환 엔진은 사전 단어를 쓰지 않습니다.")}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKey}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!isMulti(text)) return;
              e.preventDefault(); // 한 줄 입력칸은 줄바꿈을 지우므로 붙여 넣은 글을 직접 나눈다
              setPasted(splitTerms(text));
            }}
            placeholder={t("단어를 적고 Enter")}
            aria-label={t("사전에 단어 추가")}
            className="max-w-md"
            disabled={busy}
          />
          {pasted && (
            <div className="flex flex-wrap items-center gap-1.5">
              {pasted.map((x) => (
                <Badge key={x} variant="outline">
                  {x}
                </Badge>
              ))}
              <Button size="sm" disabled={busy || !pasted.length} onClick={() => void add(pasted)}>
                {t("{n}개 추가", { n: pasted.length })}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPasted(null)}>
                {t("취소")}
              </Button>
            </div>
          )}
        </div>

        {loadError ? (
          <div role="alert" className="text-[13px] text-destructive">
            {loadError.text}
            <ErrorDetail detail={loadError.detail} />
          </div>
        ) : (
          list && (
            <Section
              title={
                <span className="tabular-nums">{t("단어 {n}개", { n: terms.length })}</span>
              }
              actions={terms.length > FIND_MIN && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("사전에서 찾기")} aria-label={t("사전에서 찾기")} className="h-7 w-48" />}
            >
              {!terms.length ? (
                <div className="px-4 py-6 text-[13px] text-muted-foreground">
                  <p className="m-0">{t("아직 단어가 없습니다. 위 칸에 적거나, 대화 내용을 고칠 때 사전에 추가할 수 있습니다.")}</p>
                  <p className="m-0 mt-1 text-xs text-subtle-foreground">{t("데이터 폴더를 바꿨다면 이전 폴더의 glossary.md를 확인하세요.")}</p>
                </div>
              ) : !shown.length ? (
                <p className="m-0 px-4 py-3 text-[13px] text-muted-foreground">{t("맞는 단어가 없습니다")}</p>
              ) : (
                <div className="flex flex-col gap-4 px-4 py-3">
                  {/* 단어가 변환 한도보다 많으면 쓰는 것(최근 max개)과 쓰지 않는 것을 나눠 보인다 */}
                  {terms.length > list.max ? (
                    <>
                      <ChipGroup title={t("변환에 쓰는 단어")} terms={shown.filter((x) => used.has(x))} chip={chip} />
                      <ChipGroup
                        title={t("지금은 쓰지 않는 단어 {n}개", { n: terms.length - list.max })}
                        note={t("변환에는 최근에 추가한 단어부터 {max}개까지 씁니다. 다시 쓰려면 지우고 새로 추가하세요.", { max: list.max })}
                        terms={shown.filter((x) => !used.has(x))}
                        chip={chip}
                      />
                    </>
                  ) : (
                    <ChipGroup terms={shown} chip={chip} />
                  )}
                </div>
              )}
            </Section>
          )
        )}
      </PageBody>
    </>
  );
}

/** 단어 칩 묶음. 찾기로 비면 묶음째 숨긴다 */
function ChipGroup({ title, note, terms, chip }: { title?: string; note?: string; terms: string[]; chip: (term: string) => ReactNode }) {
  if (!terms.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {title && <h3 className="m-0 text-xs font-medium text-muted-foreground">{title}</h3>}
      {note && <p className="m-0 -mt-1 text-xs text-subtle-foreground">{note}</p>}
      <ul className="m-0 flex flex-wrap gap-1.5 p-0">{terms.map(chip)}</ul>
    </div>
  );
}
