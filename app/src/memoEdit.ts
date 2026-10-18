// 메모 입력창(<textarea>)의 편집 도움: 목록 이어 쓰기(Enter), 체크박스 토글(⌘Enter, `[ ]` 클릭), 굵게·기울임(⌘B·⌘I).
// 글은 Markdown 그대로 저장된다(Obsidian으로 보내면 그대로 보인다). 화면과 무관한 순수 함수: memoEdit.test.ts, docs/desktop.md §2.10

export interface Edit {
  text: string;
  /** 바꾼 뒤 고를 범위 */
  start: number;
  end: number;
}

const LIST = /^(\s*)(- \[[ xX]\] |[-*] |(\d+)\. )(.*)$/;
const CHECK = /^(\s*)- \[([ xX])\] /;

function lineAt(text: string, pos: number): { from: number; to: number; line: string } {
  const from = text.lastIndexOf("\n", pos - 1) + 1;
  const nl = text.indexOf("\n", pos);
  const to = nl < 0 ? text.length : nl;
  return { from, to, line: text.slice(from, to) };
}

/**
 * Enter: 목록 줄이면 다음 줄에 같은 표지를 잇는다 (체크박스는 빈 칸으로, 번호는 다음 번호로).
 * 내용 없는 목록 줄에서 누르면 표지를 지우고 목록을 끝낸다. 목록 줄이 아니거나 글을 고른 상태면 null (평소 Enter)
 */
export function continueList(text: string, start: number, end: number): Edit | null {
  if (start !== end) return null;
  const { from, line } = lineAt(text, start);
  const m = LIST.exec(line);
  if (!m || start - from < m[1].length + m[2].length) return null; // 표지 앞에서 누르면 평소대로
  const [, indent, marker, num, body] = m;
  if (!body.trim()) {
    const next = text.slice(0, from) + text.slice(from + indent.length + marker.length);
    return { text: next, start: from, end: from };
  }
  const nextMarker = num ? `${Number(num) + 1}. ` : marker.startsWith("- [") ? "- [ ] " : marker;
  const ins = `\n${indent}${nextMarker}`;
  return { text: text.slice(0, start) + ins + text.slice(end), start: start + ins.length, end: start + ins.length };
}

/** ⌘Enter: 지금 줄의 체크박스를 토글한다. 체크박스가 아니면 `- [ ] `를 붙인다 (글머리 `- `는 체크박스로 바꾼다) */
export function toggleCheck(text: string, start: number, end: number): Edit {
  const { from, line } = lineAt(text, start);
  const c = CHECK.exec(line);
  let next: string;
  let shift: number;
  if (c) {
    const at = from + c[1].length + 3; // `- [` 다음 칸
    next = text.slice(0, at) + (c[2] === " " ? "x" : " ") + text.slice(at + 1);
    shift = 0;
  } else {
    const indent = /^\s*/.exec(line)![0];
    const bullet = /^[-*] /.test(line.slice(indent.length)) ? 2 : 0;
    const at = from + indent.length;
    next = text.slice(0, at) + "- [ ] " + text.slice(at + bullet);
    shift = 6 - bullet;
  }
  return { text: next, start: Math.max(from, start + shift), end: Math.max(from, end + shift) };
}

/** 클릭: 체크박스의 `[ ]`·`[x]` 안을 누르면 토글한다. 다른 곳이면 null */
export function checkAtClick(text: string, pos: number): Edit | null {
  const { from, line } = lineAt(text, pos);
  const c = CHECK.exec(line);
  if (!c) return null;
  const box = from + c[1].length + 2; // `[`의 위치
  if (pos < box || pos > box + 3) return null;
  return toggleCheck(text, pos, pos);
}

/** ⌘B(**)·⌘I(*): 고른 글을 감싼다. 이미 감싸져 있으면 벗긴다. 고른 글이 없으면 null (⌘B는 노트 목록 접기로 남는다) */
export function wrapSelection(text: string, start: number, end: number, mark: "**" | "*"): Edit | null {
  if (start === end) return null;
  const inner = text.slice(start, end);
  const n = mark.length;
  const outside = text.slice(start - n, start) === mark && text.slice(end, end + n) === mark;
  // `**굵게**`를 고르고 ⌘I를 누르면 `*`로 벗기지 않는다: 바깥 표지가 정확히 이 표지일 때만 벗긴다
  const boldAround = mark === "*" && text.slice(start - 2, start) === "**" && text.slice(end, end + 2) === "**";
  if (outside && !boldAround) return { text: text.slice(0, start - n) + inner + text.slice(end + n), start: start - n, end: end - n };
  if (inner.startsWith(mark) && inner.endsWith(mark) && inner.length >= 2 * n && !(mark === "*" && inner.startsWith("**"))) {
    const bare = inner.slice(n, -n);
    return { text: text.slice(0, start) + bare + text.slice(end), start, end: start + bare.length };
  }
  return { text: text.slice(0, start) + mark + inner + mark + text.slice(end), start: start + n, end: end + n };
}

/** 요약을 메모 끝에 붙인다: 빈 메모면 그대로, 아니면 빈 줄 하나를 두고 */
export const appendBlock = (body: string, block: string): string => (body.trim() ? `${body.trimEnd()}\n\n${block.trim()}\n` : `${block.trim()}\n`);
