// 영어 화면 검사: 빠진 번역, 쓰이지 않는 번역, 자리표시자, t() 밖에 남은 한국어 (i18n.ts, WORDS.md §7)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EN } from "./en";
import { clock, setLang, t, type Dict } from "./i18n";

const SRC = __dirname;
const HANGUL = /[가-힣]/;

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "en" || name === "preview" || name === "fixtures" ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
  });
}

interface Token {
  kind: "str" | "code";
  text: string;
  line: number;
  /** 문자열 바로 앞의 코드 (t( 인지 보려고) */
  before: string;
}

/** 주석을 버리고 문자열과 코드 조각으로 나눈다. 템플릿 문자열은 ${…}까지 통째로 문자열 하나다 (대강이면 충분하다) */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let code = "";
  let codeLine = 1;
  const flush = () => {
    if (code) out.push({ kind: "code", text: code, line: codeLine, before: "" });
    code = "";
  };
  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      line += (src.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const before = code.slice(-40);
      flush();
      const start = line;
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") line++;
        j++;
      }
      out.push({ kind: "str", text: src.slice(i + 1, j), line: start, before });
      i = j + 1;
      codeLine = line;
      continue;
    }
    if (!code) codeLine = line;
    if (c === "\n") line++;
    code += c;
    i++;
  }
  flush();
  return out;
}

const isTCall = (before: string) => /(?:^|[^\w.$])t\(\s*$/.test(before);
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const files = sources().map((p) => ({ path: relative(SRC, p), src: readFileSync(p, "utf-8") }));
const keys = new Map<string, string>(); // 키 → 처음 쓴 파일
const unescape = (raw: string) => raw.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1");
for (const f of files) for (const tok of tokenize(f.src)) if (tok.kind === "str" && isTCall(tok.before)) keys.set(unescape(tok.text), f.path);

afterEach(() => setLang("ko"));

describe("영어 사전", () => {
  test("t()에 넘긴 한국어 문구는 모두 영어가 있다", () => {
    const missing = [...keys].filter(([k]) => HANGUL.test(k) && !(k in EN)).map(([k, p]) => `${p}: ${k}`);
    expect(missing).toEqual([]);
  });

  test("쓰이지 않는 번역이 없다 (화면에서 지운 문구는 사전에서도 지운다)", () => {
    expect(Object.keys(EN).filter((k) => !keys.has(k))).toEqual([]);
  });

  test("같은 키는 사전 파일 하나에만 있다", () => {
    const parts = import.meta.glob<{ default: Dict }>("./en/*.ts", { eager: true });
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const [p, m] of Object.entries(parts)) {
      if (p.endsWith("index.ts")) continue;
      for (const k of Object.keys(m.default)) {
        if (seen.has(k)) dup.push(`${k} (${seen.get(k)}, ${p})`);
        seen.set(k, p);
      }
    }
    expect(dup).toEqual([]);
  });

  test("영어 문장의 자리표시자는 한국어와 같다", () => {
    const bad = Object.entries(EN).flatMap(([k, e]) => (typeof e === "string" ? [e] : [...e]).filter((s) => vars(s).join() !== vars(k).join()).map((s) => `${k} → ${s}`));
    expect(bad).toEqual([]);
  });

  test("영어 문장에 한국어가 남지 않는다", () => {
    const bad = Object.entries(EN).flatMap(([k, e]) => ((typeof e === "string" ? [e] : [...e]).some((s) => HANGUL.test(s)) ? [k] : []));
    expect(bad).toEqual([]);
  });
});

test("화면 코드에 t() 밖의 한국어 문구가 없다 (언어와 상관없는 데이터는 줄 끝에 i18n-ok)", () => {
  const left: string[] = [];
  for (const f of files) {
    const lines = f.src.split("\n");
    for (const tok of tokenize(f.src)) {
      if (!HANGUL.test(tok.text) || (tok.kind === "str" && isTCall(tok.before))) continue;
      const span = tok.text.split("\n").length;
      if (lines.slice(tok.line - 1, tok.line - 1 + span).some((l) => l.includes("i18n-ok"))) continue;
      const at = tok.text.split("\n").findIndex((l) => HANGUL.test(l));
      left.push(`${f.path}:${tok.line + at}: ${tok.text.split("\n")[at].trim().slice(0, 60)}`);
    }
  }
  expect(left).toEqual([]);
});

describe("t()", () => {
  test("한국어는 그대로, 영어는 사전, 없으면 한국어", () => {
    expect(t("노트 {n}개", { n: 3 })).toBe("노트 3개");
    setLang("en", { "노트 {n}개": ["{n} note", "{n} notes"], 저장: "Save" });
    expect(t("노트 {n}개", { n: 1 })).toBe("1 note");
    expect(t("노트 {n}개", { n: 2 })).toBe("2 notes");
    expect(t("저장")).toBe("Save");
    expect(t("사전에 없는 말")).toBe("사전에 없는 말");
  });

});

test("시각은 한국어 15:00, 영어 3:00 PM", () => {
  expect([clock(15, 0), clock(9, 5)]).toEqual(["15:00", "09:05"]);
  setLang("en");
  expect([clock(15, 0), clock(0, 30), clock(12, 0), clock(9, 5)]).toEqual(["3:00 PM", "12:30 AM", "12:00 PM", "9:05 AM"]);
});
