import { useEffect, useState } from "react";
import { api, errText, type SearchResponse } from "./api";
import { dayParts, fmtTime, highlight, parseHms } from "./lib";

export function SearchView({ query, onOpen }: { query: string; onOpen: (id: string, seek: { segId: string; t: number }) => void }) {
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.search(query).then(
      (r) => alive && setRes(r),
      (e) => alive && setError(errText(e)),
    );
    return () => {
      alive = false;
    };
  }, [query]);

  return (
    <section className="search" aria-labelledby="search-title">
      <p className="eyebrow">검색</p>
      <h1 id="search-title">“{query}”</h1>
      {!res && !error && <p className="page-loading">찾는 중… (첫 검색은 색인을 맞추느라 조금 걸립니다)</p>}
      {error && <p className="page-error">{error}</p>}
      {res && (
        <>
          <p className="search-meta">
            결과 {res.hits.length}건 · {res.vector_used ? "키워드 + 의미 검색" : "키워드 검색만 (임베딩 없음)"}
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
                    {!h.matched.includes("keyword") && <span className="badge">{h.matched.includes("partial") ? "일부 일치" : "의미"}</span>}
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
          {res.hits.length === 0 && <p className="nav-note">맞는 세그먼트가 없습니다. 다른 단어로 찾아보세요.</p>}
        </>
      )}
    </section>
  );
}
