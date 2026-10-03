"""`.env` / `.env.local` 로더. 우선순위: 셸 환경변수 > 현재 폴더(.env.local > .env) > $TRACTUS_HOME(.env.local > .env).

`.env`에는 비밀이 아닌 개발 기본값을, `.env.local`에는 API 키를 둔다. 둘 다 git에서 제외된다.
"""

import os
import re
from pathlib import Path

_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def _parse(text: str) -> dict[str, str]:
    out = {}
    for line in text.splitlines():
        m = _LINE.match(line)
        if not m:
            continue
        key, value = m.groups()
        value = value.strip()
        if value[:1] in ("'", '"') and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        elif value.startswith("#"):
            value = ""
        else:
            value = re.sub(r"\s+#.*$", "", value)
        out[key] = value
    return out


def load_env_all() -> None:
    """현재 폴더(개발: 저장소 루트)를 먼저 읽고, 그다음 데이터 폴더를 읽는다.
    데스크톱 앱처럼 저장소 밖에서 실행해도 $TRACTUS_HOME/.env.local의 API 키·모델 위치를 쓸 수 있게 한다."""
    from tractus.paths import home_dir

    load_env(Path.cwd())
    load_env(home_dir())


def load_env(root: Path) -> None:
    """이미 있는 환경변수는 덮어쓰지 않는다. .env.local을 먼저 읽어 .env보다 우선하게 한다.
    빈 값(템플릿에서 복사한 `KEY=`)은 건너뛰어, 아래 순위 파일의 값을 가리지 않게 한다."""
    for name in (".env.local", ".env"):
        path = root / name
        if path.is_file():
            for key, value in _parse(path.read_text(encoding="utf-8")).items():
                if value and not os.environ.get(key):  # 셸에 빈 값으로 export된 변수도 비어 있는 것으로 본다
                    os.environ[key] = value
