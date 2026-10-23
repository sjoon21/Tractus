"""미리 만든 앱이 실제로 불러오는 모듈 목록(scripts/bundle_modules.txt) 만들기. bundle_slim.py가 이 목록으로 앱을 줄인다.

테스트 전체(실제 모델 `slow`·작은 VAD 받기 `network` 포함, 실제 AI 호출 `llm`은 뺀다)를 모듈 기록기를 켜고 돌린 뒤, 이 Mac에서 돌리지 못하는 경로
(모델이 없는 변환 엔진 계열 등)는 EXTRA로 직접 불러 더한다. 남기는 것은 site-packages에 있는 패키지와 tractus뿐이다.

언제: 의존성을 바꿨을 때(uv.lock), 새 기능이 transformers·mlx_audio·mlx_lm·scipy·onnxruntime의 다른 부분을 쓸 때.
필요한 것: 저장소의 models/(변환·화자 분리·단어 싱크·검색·목소리 모델), 몇 분.
실행: 저장소 루트에서 `uv run python scripts/bundle_trace.py`
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "scripts" / "bundle_modules.txt"
DEV_ONLY = {"pytest", "_pytest", "pluggy", "iniconfig", "py"}  # 테스트 도구: 앱에 들어가지 않는다

# 테스트가 돌리지 못하는 경로: 모델이 없는 변환 엔진 계열(Whisper·SenseVoice, 사용자가 직접 추가하는 엔진 포함)과
# mlx_audio가 필요할 때만 부르는 리샘플러, 목소리 매칭의 헝가리안 할당
EXTRA = """
import scipy.signal, scipy.optimize
import mlx_audio.resample
import mlx_audio.stt.models.qwen3_asr, mlx_audio.stt.models.qwen3_forced_aligner, mlx_audio.stt.models.whisper, mlx_audio.stt.models.sensevoice  # 위 사본에서
import mlx_audio.vad.models.silero_vad, mlx_audio.vad.models.nemotron_diarization
from transformers import AutoTokenizer, PreTrainedTokenizerFast, WhisperProcessor, WhisperTokenizer, WhisperTokenizerFast, WhisperFeatureExtractor
from huggingface_hub import snapshot_download, model_info
import docx, openai, onnxruntime, kaldi_native_fbank, sqlite_vec
from tractus import mcp_server, cli
"""

# 모듈 이름이 아니라 파일을 적는다: transformers는 옛 경로 이름(…image_processing_*_fast)을 다른 모듈의 별칭으로 sys.modules에 올려
# 이름만 보면 쓰지 않는 모델 폴더 100여 개가 쓰는 것처럼 보인다
HOOK = """import atexit, os, sys
def _tractus_dump():
    files = {getattr(m, "__file__", None) for m in list(sys.modules.values())}
    with open(os.environ["TRACTUS_TRACE_OUT"], "a", encoding="utf-8") as f:
        f.write("\\n".join(x for x in files if x) + "\\n")
atexit.register(_tractus_dump)
"""


spec = importlib.util.spec_from_file_location("bundle_slim", Path(__file__).with_name("bundle_slim.py"))
slim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(slim)


def module_name(path: Path, roots: list[Path]) -> str | None:
    """파일 경로 → 모듈 이름 (roots 밖이면 None). a/b/__init__.py → a.b, a/c.cpython-312-darwin.so → a.c"""
    for root in roots:
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        parts = [*rel.parts[:-1], rel.name.split(".")[0]]
        return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)
    return None


def main() -> None:
    sp = Path(sysconfig.get_paths()["purelib"])
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "sitecustomize.py").write_text(HOOK, encoding="utf-8")
        trace = Path(tmp) / "modules.txt"
        # 앱과 같게: mlx_audio 사본의 stt/models/__init__.py를 bundle_slim과 같은 방식으로 고쳐 먼저 보이게 한다
        shutil.copytree(sp / "mlx_audio", Path(tmp) / "mlx_audio", ignore=shutil.ignore_patterns("__pycache__"))
        slim.patch_stt_init(Path(tmp), slim.stt_families())
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [tmp, os.environ.get("PYTHONPATH")])), "TRACTUS_TRACE_OUT": str(trace)}
        runs = [
            [sys.executable, "-m", "pytest", "-q", "-m", "not llm", "-p", "no:cacheprovider"],
            [sys.executable, "-c", EXTRA],
        ]
        for cmd in runs:
            r = subprocess.run(cmd, cwd=REPO, env=env)
            if r.returncode:  # 실패한 테스트가 있어도 그때까지 불러온 모듈은 기록된다. 목록만 만들고 알린다
                print(f"경고: {' '.join(cmd[:4])}… 종료 코드 {r.returncode}", file=sys.stderr)
        files = set(trace.read_text(encoding="utf-8").splitlines())
        roots = [Path(tmp), sp, REPO / "src"]  # 고친 mlx_audio 사본, site-packages, tractus(편집 설치)
        names = {n for f in files if (n := module_name(Path(f), roots))}

    kept = sorted(m for m in names if m.split(".")[0] not in DEV_ONLY)
    header = "# scripts/bundle_trace.py가 만든다. 손으로 고치지 않는다 (scripts/bundle_slim.py가 읽는다)\n"
    OUT.write_text(header + "\n".join(kept) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(REPO)}: 모듈 {len(kept)}개")


if __name__ == "__main__":
    main()
