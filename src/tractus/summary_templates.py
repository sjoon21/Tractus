"""요약 유형(템플릿): 기본 유형(src/tractus/templates/*.md)과 내 유형($TRACTUS_HOME/templates/<id>.md) (docs/desktop.md §2.13).

파일 형식은 둘 다 같다: 맨 앞 `---` 머리말(id, name, description, order | created)과 본문(요약 지침).
지침은 요약의 구성(섹션·어투)만 정한다. 출력 스키마·근거·언어·안전 규칙은 summaries.SYSTEM_PROMPT가 정하고 언제나 우선한다.
내 유형의 ID는 `u-` + 16진수 8자, 파일 이름이 곧 ID다 (한글 이름이어도 파일 이름은 안전하다)."""

import re
import secrets
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from tractus.i18n import t
from tractus.store import _write_atomic, one_line

BUILTIN_DIR = Path(__file__).parent / "templates"
MAX_NAME = 40
MAX_DESC = 100
MAX_PROMPT = 4000
MAX_USER_TEMPLATES = 50
USER_ID = re.compile(r"u-[0-9a-f]{8}")
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # \t·\n만 남긴다

NAME_EMPTY = t("이름을 입력하세요.")
NAME_LONG = t("이름은 {n}자까지 쓸 수 있습니다.", n=MAX_NAME)
DESC_LONG = t("설명은 {n}자까지 쓸 수 있습니다.", n=MAX_DESC)
PROMPT_EMPTY = t("요약 방법을 입력하세요.")
PROMPT_LONG = t("요약 방법은 {n}자까지 쓸 수 있습니다.", n=f"{MAX_PROMPT:,}")
TOO_MANY = t("내 요약 유형은 {n}개까지 만들 수 있습니다.", n=MAX_USER_TEMPLATES)
BUILTIN_FIXED = t("기본 요약 유형은 고치거나 삭제할 수 없습니다. 복사해서 새로 만드세요.")
NOT_FOUND = t("요약 유형을 찾을 수 없습니다.")


@dataclass(frozen=True)
class Template:
    id: str
    name: str
    description: str
    prompt: str
    builtin: bool
    order: str = ""  # 기본: 숫자(정렬), 내 유형: 만든 시각

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "description": self.description, "prompt": self.prompt, "builtin": self.builtin}


def parse(text: str) -> tuple[dict, str]:
    """`---` 머리말(`key: value` 줄)과 본문. 머리말이 없거나 닫히지 않으면 ValueError."""
    m = re.match(r"---\n(.*?)\n---\n?(.*)\Z", text.replace("\r\n", "\n"), re.S)
    if not m:
        raise ValueError("머리말이 없습니다")  # words-ok: 파일 손상, 목록에서 건너뛴다  # i18n-ok: 화면에 나가지 않는다 (건너뜀)
    meta = {k.strip(): v.strip() for k, _, v in (line.partition(":") for line in m.group(1).split("\n")) if k.strip()}
    return meta, m.group(2).strip()


def _from_file(path: Path, builtin: bool) -> Template:
    meta, body = parse(path.read_text(encoding="utf-8"))
    tid = meta.get("id", "")
    if tid != path.stem or not body:
        raise ValueError(f"{path.name}: id가 파일 이름과 다르거나 본문이 비었습니다")  # words-ok: 파일 손상  # i18n-ok: 화면에 나가지 않는다 (내 유형은 건너뛰고, 기본 유형 파일은 개발 오류)
    return Template(tid, meta.get("name") or tid, meta.get("description", ""), body, builtin, meta.get("order" if builtin else "created", ""))


def builtin_templates() -> list[Template]:
    return sorted((_from_file(p, True) for p in BUILTIN_DIR.glob("*.md")), key=lambda t: int(t.order or 0))


def user_dir(home: Path) -> Path:
    return home / "templates"


def user_templates(home: Path) -> list[Template]:
    """내 유형 (만든 순서). 깨진 파일은 건너뛴다."""
    out = []
    for p in sorted(user_dir(home).glob("u-*.md")):
        if not USER_ID.fullmatch(p.stem):
            continue
        try:
            out.append(_from_file(p, False))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda t: (t.order, t.id))


def all_templates(home: Path) -> list[Template]:
    return [*builtin_templates(), *user_templates(home)]


def get_template(home: Path, tid: str) -> Template:
    """기본 유형 또는 내 유형. 없으면 ValueError(NOT_FOUND)."""
    for t in builtin_templates() if not USER_ID.fullmatch(tid) else user_templates(home):
        if t.id == tid:
            return t
    raise ValueError(NOT_FOUND)


def clean_name(raw: str) -> str:
    name = one_line(raw)
    if not name:
        raise ValueError(NAME_EMPTY)
    if len(name) > MAX_NAME:
        raise ValueError(NAME_LONG)
    return name


def clean_description(raw: str) -> str:
    desc = one_line(raw or "")
    if len(desc) > MAX_DESC:
        raise ValueError(DESC_LONG)
    return desc


def clean_prompt(raw: str) -> str:
    """제어 문자를 빼고 앞뒤 공백을 자른다. 비었거나 4,000자를 넘으면 ValueError. 본문이 `---`로 시작해도 머리말 뒤라 안전하다."""
    prompt = _CTRL.sub("", raw.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if not prompt:
        raise ValueError(PROMPT_EMPTY)
    if len(prompt) > MAX_PROMPT:
        raise ValueError(PROMPT_LONG)
    return prompt


def new_user_id() -> str:
    return f"u-{secrets.token_hex(4)}"


def save_user_template(home: Path, name: str, prompt: str, description: str = "", tid: str | None = None) -> Template:
    """내 유형을 만들거나(tid 없음) 고친다(tid = 기존 내 유형). 잘못된 입력은 ValueError (문장). 만든 시각은 고칠 때 유지한다."""
    name, description, prompt = clean_name(name), clean_description(description), clean_prompt(prompt)
    existing = user_templates(home)
    if tid is None:
        if len(existing) >= MAX_USER_TEMPLATES:
            raise ValueError(TOO_MANY)
        tid, created = new_user_id(), datetime.now().astimezone().isoformat(timespec="seconds")
    else:
        if not USER_ID.fullmatch(tid):
            raise ValueError(BUILTIN_FIXED if tid in {t.id for t in builtin_templates()} else NOT_FOUND)
        old = next((t for t in existing if t.id == tid), None)
        if old is None:
            raise ValueError(NOT_FOUND)
        created = old.order
    user_dir(home).mkdir(parents=True, exist_ok=True)
    _write_atomic(user_dir(home) / f"{tid}.md", f"---\nid: {tid}\nname: {name}\ndescription: {description}\ncreated: {created}\n---\n{prompt}\n")
    return Template(tid, name, description, prompt, False, created)


def delete_user_template(home: Path, tid: str) -> None:
    if not USER_ID.fullmatch(tid):
        raise ValueError(BUILTIN_FIXED if tid in {t.id for t in builtin_templates()} else NOT_FOUND)
    path = user_dir(home) / f"{tid}.md"
    if not path.is_file():
        raise ValueError(NOT_FOUND)
    path.unlink()
