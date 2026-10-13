// PDF 인쇄 레이아웃 (docs/roadmap.md §3 6.5). 화면에는 보이지 않고 @media print에서만 나온다(styles.css).
// body 바로 아래에 둬서 인쇄할 때 앱(#root)을 통째로 숨긴다. Tauri 2는 macOS에서 window.print()를
// Webview::print(WKWebView printOperation)로 바꿔 놓으므로 인쇄 대화상자의 'PDF로 저장'을 그대로 쓴다.
import { createPortal } from "react-dom";
import type { PrintDoc } from "./print";

export function PrintSheet({ doc }: { doc: PrintDoc }) {
  const s = doc.summary;
  return createPortal(
    <article className="print-sheet" lang="ko">
      <header className="print-head">
        <h1>{doc.title}</h1>
        <p className="print-meta">{[doc.date, !doc.memo && `길이 ${doc.duration}`, doc.speakers.length > 0 && `참석자 ${doc.speakers.length}명 (${doc.speakers.join(", ")})`].filter(Boolean).join(" · ")}</p>
      </header>
      {s && (
        <section className="print-summary">
          <h2>요약</h2>
          <p>{s.lead}</p>
          <PrintList title="결정 사항" items={s.decisions} />
          <PrintList title="할 일" items={s.actions} />
          <PrintList title="주제" items={s.topics} />
        </section>
      )}
      <section>
        <h2>{doc.memo ? "메모" : "대화 내용"}</h2>
        <ol className={`print-rows ${doc.memo ? "is-memo" : ""}`}>
          {doc.rows.map((r) => (
            <li key={r.id} className={r.speaker ? "is-turn" : undefined}>
              {!doc.memo && <time>{r.time}</time>}
              <p>
                {r.speaker && <strong>{r.speaker}</strong>}
                {r.text}
              </p>
            </li>
          ))}
        </ol>
      </section>
      {doc.memoLines.length > 0 && (
        <section>
          <h2>메모</h2>
          <ol className="print-rows is-memo">
            {doc.memoLines.map((l) => (
              <li key={l.id}>
                <p>{l.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>,
    document.body,
  );
}

function PrintList({ title, items }: { title: string; items: { text: string; meta?: string; at: string | null }[] }) {
  if (!items.length) return null;
  return (
    <>
      <h3>{title}</h3>
      <ul>
        {items.map((x, i) => (
          <li key={i}>
            {x.text}
            {x.meta && <span className="print-dim"> — {x.meta}</span>}
            {x.at && <span className="print-dim"> ({x.at})</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
