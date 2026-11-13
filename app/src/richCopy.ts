// 복사할 때 함께 넣는 서식(HTML): 우리가 만드는 Markdown(회의록·요약·완성된 노트)만 다루는 작은 변환기.
// 메일·문서·위키에 붙이면 제목·목록·굵게·표가 남고, 글만 받는 곳은 같이 넣은 Markdown을 가져간다.
// 클립보드에 두 형식을 함께 넣는 생각은 Yogurt(MIT, shared/exportNotes.ts)에서 왔다.
// shortcut: 링크·기울임·코드·인용은 다루지 않는다 (우리 복사 글에 없다). 생기면 여기에 더한다.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replaceAll('"', "&quot;");

/** 한 줄 안: 이스케이프 → **굵게** → `\|`(표 칸의 세로줄) */
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\\\|/g, "|");

/** 표 한 줄 → 칸들. `\|`는 칸 나눔이 아니다 */
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.trim().replace(/\u0000/g, "\\|"));

const CELL = 'style="border:1px solid #ccc;padding:4px 8px;vertical-align:top;text-align:left"';

/** 표 칸: 회의록은 칸 안 줄바꿈을 `<br>`로 쓴다 (그것만 태그로 살린다) */
const cell = (tag: "th" | "td", c: string) => `<${tag} ${CELL}>${inline(c).replace(/&lt;br\s*\/?&gt;/gi, "<br>")}</${tag}>`;

function table(rows: string[]): string {
  const body = rows.filter((r, i) => !(i === 1 && /^\|?[\s:|-]+$/.test(r.trim())));
  const [head, ...rest] = body.map(cells);
  const tr = (cs: string[], tag: "th" | "td") => `<tr>${cs.map((c) => cell(tag, c)).join("")}</tr>`;
  return `<table style="border-collapse:collapse"><thead>${tr(head, "th")}</thead><tbody>${rest.map((r) => tr(r, "td")).join("")}</tbody></table>`;
}

/** Markdown → HTML 조각. 맨 앞 `<meta charset>`: 클립보드 HTML을 UTF-8로 읽게 (없으면 한글이 깨지는 앱이 있다) */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lists: { indent: number; tag: "ul" | "ol" }[] = [];
  let para: string[] = [];
  const closeLists = (indent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > indent) out.push(`</li></${lists.pop()!.tag}>`);
  };
  const flush = () => {
    if (para.length) out.push(`<p>${para.join("")}</p>`);
    para = [];
  };
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const item = /^( *)([-*]|\d+\.) (.*)$/.exec(line);
    if (item) {
      flush();
      const indent = item[1].length;
      const tag = /\d/.test(item[2]) ? "ol" : "ul";
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (top?.indent === indent && top.tag !== tag) closeLists(indent - 1);
      const same = lists[lists.length - 1]?.indent === indent;
      if (same) out.push("</li><li>");
      else {
        out.push(`<${tag}><li>`);
        lists.push({ indent, tag });
      }
      const check = /^\[( |x)\] (.*)$/i.exec(item[3]);
      out.push(check ? `${check[1] === " " ? "☐" : "☑"} ${inline(check[2])}` : inline(item[3]));
      continue;
    }
    closeLists();
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      flush();
      const rows = [line];
      while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("|")) rows.push(lines[++i]);
      out.push(table(rows));
      continue;
    }
    // 줄 끝 공백 두 개는 줄바꿈, 아니면 이어 쓴다
    para.push(para.length && !para[para.length - 1].endsWith("<br>") ? " " : "", inline(line.replace(/ {2,}$/, "")), / {2,}$/.test(line) ? "<br>" : "");
  }
  closeLists();
  flush();
  return `<meta charset="utf-8">${out.join("")}`;
}
