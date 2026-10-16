"""copyleft 의존성 검사 (CLAUDE.md: GPL·LGPL·AGPL 금지). CI와 손으로 같은 명령을 쓴다.

    uv run python scripts/check_licenses.py            # Python(지금 환경) + npm(app/) + Rust(app/src-tauri)
    uv run python scripts/check_licenses.py --only py  # 하나만: py | npm | cargo

라이선스 식에 GPL 계열이 아닌 선택지가 하나라도 있으면(`MIT OR GPL-2.0`) 통과다. MPL-2.0 같은 파일 단위 copyleft는 막지 않는다.
알려진 예외는 ALLOW에 이유와 함께 적는다. 문제가 있으면 종료 코드 1과 목록.
"""

import argparse
import json
import re
import subprocess
import sys
from importlib.metadata import distributions
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COPYLEFT = re.compile(r"\b(A|L)?GPL|GNU (Affero |Lesser |Library )?General Public", re.IGNORECASE)
# 이름 → 이유. 라이선스가 아니라 메타데이터가 틀린 경우나 소유자가 결정한 예외만
ALLOW: dict[str, str] = {}


def bad(expr: str) -> bool:
    """식의 모든 선택지가 GPL 계열이면 True. 빈 식(모름)은 통과시키고 따로 보이지 않는다."""
    alts = [a for a in re.split(r"\s+OR\s+|\s*/\s*|\s*\|\|\s*", expr.strip("() "), flags=re.IGNORECASE) if a.strip()]
    return bool(alts) and all(COPYLEFT.search(a) for a in alts)


def python_pkgs() -> list[tuple[str, str]]:
    out = []
    for d in distributions():
        m = d.metadata
        classifiers = [c.split("::")[-1].strip() for c in m.get_all("Classifier") or [] if c.startswith("License ::")]
        expr = m.get("License-Expression") or (" OR ".join(classifiers) if classifiers else (m.get("License") or "").splitlines()[0][:200] if m.get("License") else "")
        out.append((m["Name"], expr))
    return out


def npm_pkgs() -> list[tuple[str, str]]:
    raw = subprocess.run(["pnpm", "licenses", "list", "--prod", "--json"], cwd=ROOT / "app", check=True, capture_output=True, text=True).stdout
    return [(p["name"], lic) for lic, pkgs in json.loads(raw).items() for p in pkgs]


def cargo_pkgs() -> list[tuple[str, str]]:
    raw = subprocess.run(["cargo", "metadata", "--format-version", "1", "--locked"], cwd=ROOT / "app" / "src-tauri", check=True, capture_output=True, text=True).stdout
    return [(p["name"], p.get("license") or "") for p in json.loads(raw)["packages"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["py", "npm", "cargo"])
    a = ap.parse_args()
    sources = {"py": python_pkgs, "npm": npm_pkgs, "cargo": cargo_pkgs}
    problems = []
    for key, fn in sources.items():
        if a.only and a.only != key:
            continue
        pkgs = fn()
        found = sorted({(n, lic) for n, lic in pkgs if bad(lic) and n not in ALLOW})
        problems += [f"{key}: {n} ({lic})" for n, lic in found]
        print(f"{key}: 패키지 {len(pkgs)}개 확인, copyleft {len(found)}개")
    for p in problems:
        print(f"  ✗ {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    assert bad("GPL-3.0") and bad("LGPL-2.1-or-later") and bad("GNU General Public License v3 (GPLv3)") and bad("AGPL-3.0")
    assert not bad("MIT OR GPL-2.0") and not bad("MPL-2.0") and not bad("MIT") and not bad("") and not bad("Apache-2.0 / LGPL-2.1")
    sys.exit(main())
