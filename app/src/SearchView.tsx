import { useEffect, useState } from "react";
import { api, errDetail, errText, type SearchResponse } from "./api";
import { showSearchNotice } from "./caps";
import { ErrorDetail } from "./ErrorDetail";
import { t } from "./i18n";
import { GateHint } from "./GatedButton";
import { useCapabilities } from "./useCapabilities";
import { dayParts, highlight } from "./lib";
import { hitView } from "./memo";
import { Badge } from "@/components/ui/badge";
import { PageBody, PageHeader } from "@/components/ui/page";

export function SearchView({ query, onOpen, memoIds }: { query: string; onOpen: (id: string, seek: { segId: string; t: number }) => void; memoIds?: ReadonlySet<string> }) {
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const smart = useCapabilities().can("smart-search");

  useEffect(() => {
    let alive = true;
    api.search(query).then(
      (r) => alive && setRes(r),
      (e) => alive && setError({ text: errText(e), detail: errDetail(e) }),
    );
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <section className="flex h-full flex-col overflow-y-auto" aria-labelledby="search-title">
      <PageHeader title={<span id="search-title">“{query}”</span>} />
      <PageBody wide className="gap-4">
        {!res && !error && <p className="m-0 text-[13px] text-muted-foreground">{t("찾는 중… (첫 검색은 스마트 검색을 준비하느라 조금 걸립니다)")}</p>}
        {error && (
          <div className="text-[13px] text-destructive" role="alert">
            {error.text}
            <ErrorDetail detail={error.detail} />
          </div>
        )}
        {res && (
          <>
            <p className="m-0 text-xs text-muted-foreground">
              {t("결과 {n}건", { n: res.hits.length })} · {res.vector_used ? t("스마트 검색") : t("단어 일치로만 찾았습니다 (스마트 검색 준비 안 됨)")}
            </p>
            {showSearchNotice(res.vector_used, smart) && <GateHint gate={smart} />}
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {res.hits.map((h, i) => {
                const d = dayParts(h.date);
                const memo = !!memoIds?.has(h.meeting_id); // 메모는 시각이 없다
                return (
                  <li key={`${h.meeting_id}-${i}`} className="overflow-hidden rounded-lg border border-border bg-card">
                    <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                      <span className="text-[13px] font-semibold">{h.title}</span>
                      {memo && <Badge>{t("메모")}</Badge>}
                      {!h.matched.includes("keyword") && <Badge variant="outline">{h.matched.includes("partial") ? t("일부 일치") : t("비슷한 뜻")}</Badge>}
                      <span className="ml-auto text-xs text-subtle-foreground tabular-nums">
                        {t("{month} {day}일 {weekday}", { month: d.month, day: d.day, weekday: d.weekday })}
                      </span>
                    </header>
                    <ul className="m-0 list-none p-1">
                      {h.segments.map((s) => {
                        // 메모의 줄은 시각 대신 `3번째 줄`. 녹음 노트의 메모 줄은 열면 메모 탭에서 그 줄을 고른다 (MeetingView)
                        const v = hitView(s, memo);
                        return (
                          <li key={s.id}>
                            <button className="grid w-full grid-cols-[5.5rem_minmax(0,1fr)] gap-2 rounded-md px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40" onClick={() => onOpen(h.meeting_id, v.seek)}>
                              <time className="pt-0.5 text-xs text-subtle-foreground tabular-nums">{v.label}</time>
                              <span className="text-[14px] leading-relaxed">
                                {v.tagged && <Badge variant="memo" className="mr-1.5">{t("메모")}</Badge>}
                                {highlight(s.text, query).map((p, j) => (p.hit ? <mark key={j} className="rounded-[3px] bg-memo-wash px-0.5 text-foreground">{p.text}</mark> : <span key={j}>{p.text}</span>))}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                );
              })}
            </ol>
            {res.hits.length === 0 && <p className="m-0 py-12 text-center text-[13px] text-muted-foreground">{t("맞는 대화가 없습니다. 다른 단어로 찾아보세요.")}</p>}
          </>
        )}
      </PageBody>
    </section>
  );
}
