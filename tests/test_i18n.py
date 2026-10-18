"""코어가 앱·문서로 내보내는 문장의 영어 (tractus.i18n): 빠진 번역, 쓰이지 않는 번역, 자리표시자, t() 밖에 남은 한국어."""

import ast
import json
import re
from pathlib import Path

import pytest

from tractus import i18n

SRC = Path(i18n.__file__).parent
HANGUL = re.compile(r"[가-힣]")
VAR = re.compile(r"\{(\w+)\}")
# MCP 출력은 에이전트용 기술 문서라 옮기지 않는다 (CLAUDE.md "MCP 출력")
SKIP = {"mcp_server.py"}
# CLI 도움말·로그는 개발자용이다
DEV_KWARGS = {"help", "rich_help_panel", "metavar", "epilog", "short_help"}
DEV_LOGGERS = {"log", "logger", "logging"}
EN = json.loads((SRC / "i18n_en.json").read_text(encoding="utf-8"))


def _call_name(call: ast.Call) -> tuple[str, str]:
    f = call.func
    if isinstance(f, ast.Attribute):
        return (f.value.id if isinstance(f.value, ast.Name) else ""), f.attr
    return "", getattr(f, "id", "")


def scan(path: Path) -> tuple[list[str], list[tuple[int, str]]]:
    """(t()에 넘긴 키, t() 밖의 한국어 (줄, 앞부분))"""
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines()
    tree = ast.parse(src)
    parents = {c: p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
    docs = {n.body[0].value for n in ast.walk(tree) if isinstance(n, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    keys, left = [], []
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and _call_name(n) == ("", "t") and n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str):
            keys.append(n.args[0].value)
        if not (isinstance(n, ast.Constant) and isinstance(n.value, str) and HANGUL.search(n.value)) or n in docs:
            continue
        node = parents[n] if isinstance(parents.get(n), ast.JoinedStr) else n  # f-string 조각
        ok, cur = False, node
        while cur in parents:
            par = parents[cur]
            if isinstance(par, ast.keyword) and par.arg in DEV_KWARGS:
                ok = True
            elif isinstance(par, ast.Call):
                base, name = _call_name(par)
                if base in DEV_LOGGERS or (name == "t" and not base and par.args and par.args[0] is node and isinstance(node, ast.Constant)):
                    ok = True
            if ok:
                break
            cur = par
        end = getattr(node, "end_lineno", n.lineno) or n.lineno
        if not ok and not any("i18n-ok" in l for l in lines[n.lineno - 1 : end]):
            left.append((n.lineno, n.value.strip().replace("\n", " ")[:50]))
    return keys, left


FILES = sorted(p for p in SRC.glob("*.py") if p.name not in SKIP)
SCANNED = {p.name: scan(p) for p in FILES}
KEYS = {k for keys, _ in SCANNED.values() for k in keys}


def test_no_hangul_strings_outside_t():
    left = [f"{name}:{line}: {text}" for name, (_, items) in SCANNED.items() for line, text in items]
    assert left == []


def test_every_key_has_english_and_every_entry_is_used():
    assert sorted(k for k in KEYS if HANGUL.search(k) and k not in EN) == []
    assert sorted(k for k in EN if k not in KEYS) == []


def test_english_keeps_placeholders_and_has_no_hangul():
    bad = []
    for k, v in EN.items():
        for s in [v] if isinstance(v, str) else v:
            if sorted(VAR.findall(s)) != sorted(VAR.findall(k)) or HANGUL.search(s):
                bad.append(f"{k} → {s}")
        assert isinstance(v, str) or (isinstance(v, list) and len(v) == 2), k
    assert bad == []


def test_t_uses_english_only_when_tractus_lang_is_en(monkeypatch):
    monkeypatch.setattr(i18n, "_dict", lambda: {"노트 {n}개": ["{n} note", "{n} notes"], "저장": "Save"})
    monkeypatch.delenv("TRACTUS_LANG", raising=False)
    assert i18n.t("노트 {n}개", n=2) == "노트 2개"
    monkeypatch.setenv("LANG", "en_US.UTF-8")  # 셸의 LANG은 보지 않는다
    assert i18n.t("저장") == "저장"
    monkeypatch.setenv("TRACTUS_LANG", "en")
    assert (i18n.t("노트 {n}개", n=1), i18n.t("노트 {n}개", n=3), i18n.t("저장"), i18n.t("없는 말")) == ("1 note", "3 notes", "Save", "없는 말")


@pytest.mark.parametrize("bad", ["f-string", "concat"])
def test_scanner_catches_f_strings_and_concatenation(tmp_path, bad):
    src = {"f-string": 'x = 1\nraise ValueError(f"노트 {x}개")\n', "concat": 'raise ValueError("노트 " + str(1))\n'}[bad]
    p = tmp_path / "m.py"
    p.write_text(src, encoding="utf-8")
    assert scan(p)[1]


def test_builtin_summary_types_have_english_names(monkeypatch):
    from tractus import summary_templates

    monkeypatch.setenv("TRACTUS_LANG", "en")
    names = {tpl.id: (tpl.name, tpl.description) for tpl in summary_templates.builtin_templates()}
    assert names["meeting"][0] == "Meeting notes"
    assert all(n and d and not HANGUL.search(n + d) for n, d in names.values())


def test_english_ui_asks_the_ai_for_english_output(monkeypatch):
    from tractus import enhance, summaries, summarize

    t = {"meeting_id": "x", "segments": []}
    monkeypatch.delenv("TRACTUS_LANG", raising=False)
    ko = (summarize.system_prompt(t), summaries.system_prompt(t, "지침"), enhance.system_prompt())
    assert all(i18n.EN_OUTPUT_RULE not in p for p in ko)  # 한국어 화면의 프롬프트는 그대로다
    monkeypatch.setenv("TRACTUS_LANG", "en")
    en = (summarize.system_prompt(t), summaries.system_prompt(t, "지침"), enhance.system_prompt())
    assert all(i18n.EN_OUTPUT_RULE in p and "쓰인 언어로" not in p for p in en)
