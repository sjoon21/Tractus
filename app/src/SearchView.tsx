import { useEffect, useState } from "react";
import { api, errDetail, errText, type SearchResponse } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { dayParts, fmtTime, highlight, parseHms } from "./lib";

export function SearchView({ query, onOpen }: { query: string; onOpen: (id: string, seek: { segId: string; t: number }) => void }) {
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);

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
    <section className="search" aria-labelledby="search-title">
      <p className="eyebrow">검색</p>
      <h1 id="search-title">“{query}”</h1>
      {!res && !error && <p className="page-loading">찾는 중… (첫 검색은 스마트 검색을 준비하느라 조금 걸립니다)</p>}
      {error && (
        <div className="page-error" role="alert">
          {error.text}
          <ErrorDetail detail={error.detail} />
        </div>
      )}
      {res && (
        <>
          <p className="search-meta">
            결과 {res.hits.length}건 · {res.vector_used ? "스마트 검색" : "단어 일치로만 찾았습니다 (스마트 검색 준비 안 됨)"}
          </p>
          <ol className="hits">
            {res.hits.map((h, i) => {
              const d = dayParts(h.date);
              return (
                <li key={`${h.meeting_id}-${i}`} className="hit">
                  <header>
                    <span className="hit-title">{h.title}</span>
                    <span className="hit-date tnum">
                      {d.month} {d.day}일 {d.weekday}
                    </span>
                    {!h.matched.includes("keyword") && <span className="badge">{h.matched.includes("partial") ? "일부 일치" : "비슷한 뜻"}</span>}
                  </header>
                  <ul>
                    {h.segments.map((s) => (
                      <li key={s.id}>
                        <button className="seg-button" onClick={() => onOpen(h.meeting_id, { segId: s.id, t: parseHms(s.time) })}>
                          <time className="seg-time tnum">{fmtTime(parseHms(s.time))}</time>
                          <span className="seg-text">
                            {highlight(s.text, query).map((p, j) => (p.hit ? <mark key={j}>{p.text}</mark> : <span key={j}>{p.text}</span>))}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ol>
          {res.hits.length === 0 && <p className="nav-note">맞는 대화가 없습니다. 다른 단어로 찾아보세요.</p>}
        </>
      )}
    </section>
  );
}
