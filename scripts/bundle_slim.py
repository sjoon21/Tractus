"""미리 만든 앱의 site-packages 줄이기 (scripts/build_app_bundle.sh 4단계). 번들의 파이썬으로 돈다.

목록(scripts/bundle_modules.txt, scripts/bundle_trace.py가 실제 기능을 돌려 만든다)에 나온 모듈만 쓴다고 보고
0. mlx_audio.stt.models가 변환 엔진 계열 17개를 한꺼번에 불러오는 것을 우리가 쓰는 계열만 불러오게 고친다(patch_stt_init).
   mlx_audio는 모델을 불러올 때 계열 모듈을 이름으로 찾아 부르므로(mlx_audio.utils의 importlib) 이 일괄 import는 필요 없고,
   쓰지 않는 계열(voxtral 등)이 transformers 모델 정의 100여 개를 끌고 온다. bundle_trace.py도 같은 고침을 한 사본으로 목록을 만든다.
1. PRUNE 패키지의 하위 패키지 중 목록에 한 번도 나오지 않은 것을 지운다 (transformers 모델 정의 523개 중 쓰는 몇 개만 남기는 식).
2. 목록에 나온 site-packages 모듈만 바이트코드를 미리 만든다. 나머지는 .py만 남는다: 불러오면 파이썬이 메모리에서 컴파일하니
   동작은 같고 처음 불러올 때만 느리다(앱 안은 봉인되어 .pyc를 쓰지 않는다).

지우는 것은 PRUNE의 하위 패키지(폴더)뿐이다. 목록에 없는 기능 경로가 생기면 그 패키지가 빠져 ImportError가 나므로,
새 기능이 이 패키지들의 다른 부분을 쓰면 bundle_trace.py에 그 기능을 더해 목록을 다시 만든다.

사용법: python bundle_slim.py <site-packages> <bundle_modules.txt>
"""

from __future__ import annotations

import py_compile
import re
import shutil
import sys
from pathlib import Path

# 하위 패키지를 골라 지울 패키지 (쓰지 않는 모델·기능이 많은 것)
PRUNE = ("transformers.models", "mlx_audio", "mlx_audio.stt.models", "mlx_audio.vad.models", "mlx_lm.models", "scipy", "onnxruntime")
STT_INIT = Path("mlx_audio", "stt", "models", "__init__.py")
ALIGNER_FAMILY = "qwen3_forced_aligner"  # tractus.align이 부르는 단어 정렬 모델 (일괄 import 목록에는 원래 없다)


def stt_families() -> set[str]:
    """우리가 쓰는 mlx_audio 변환 계열: tractus.asr.ENGINES의 model_type + 단어 정렬."""
    from tractus.asr import ENGINES

    return {t for e in ENGINES.values() for t in e.model_types} | {ALIGNER_FAMILY}


def patch_stt_init(sp: Path, keep: set[str]) -> list[str]:
    """mlx_audio/stt/models/__init__.py의 `from . import (…)`에서 keep만 남긴다. 남긴 이름을 돌려준다.
    파일 모양이 다르면(mlx-audio를 올렸다) 조용히 넘어가지 않고 멈춘다."""
    path = sp / STT_INIT
    m = re.fullmatch(r"\s*from \. import \(([\w\s,]+)\)\s*", path.read_text(encoding="utf-8"))
    if not m:
        sys.exit(f"{path}: 모양이 예상과 다릅니다(mlx-audio를 올렸나요?). scripts/bundle_slim.py의 patch_stt_init을 고치세요")
    kept = [n for n in (x.strip() for x in m.group(1).split(",")) if n in keep]
    if not kept:
        sys.exit(f"{path}: 남길 변환 계열이 없습니다 ({sorted(keep)})")
    path.write_text(f"# scripts/bundle_slim.py가 고쳤다: Tractus가 쓰는 계열만 (나머지는 mlx_audio.utils가 이름으로 찾아 부른다)\nfrom . import {', '.join(kept)}\n", encoding="utf-8")
    return kept


def prune(sp: Path, used: set[str]) -> list[str]:
    removed = []
    for root in PRUNE:
        base = sp.joinpath(*root.split("."))
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            name = f"{root}.{child.name}"
            if not (child / "__init__.py").is_file():
                continue  # 하위 패키지만 지운다 (모듈 파일·확장 모듈·데이터 폴더는 그대로)
            if not any(m == name or m.startswith(name + ".") for m in used):
                shutil.rmtree(child)
                removed.append(name)
    return removed


def compile_used(sp: Path, used: set[str]) -> int:
    n = 0
    for m in sorted(used):
        base = sp.joinpath(*m.split("."))
        for src in (base.with_suffix(".py"), base / "__init__.py"):
            if src.is_file():
                # unchecked-hash: 원본 수정 시각을 보지 않는다 (복사하면 시각이 바뀌어 pyc가 낡은 것으로 보이는 일을 막는다)
                py_compile.compile(str(src), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
                n += 1
                break
    return n


def main() -> None:
    sp, listing = Path(sys.argv[1]), Path(sys.argv[2])
    used = {line.strip() for line in listing.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#")}
    assert "tractus.cli" in used, f"{listing}에 tractus.cli가 없습니다: 목록이 비었거나 잘못 만들어졌습니다"
    print(f"  mlx_audio 변환 계열: {', '.join(patch_stt_init(sp, stt_families()))}")
    removed = prune(sp, used)
    print(f"  지운 하위 패키지 {len(removed)}개 ({', '.join(sorted({r.rsplit('.', 1)[0] for r in removed}))})")
    print(f"  바이트코드를 만든 모듈 {compile_used(sp, used)}개")


if __name__ == "__main__":
    main()
