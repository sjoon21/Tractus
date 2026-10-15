"""모델·기능 목록의 단일 출처 (docs/desktop.md §2.15). 모델 하나를 쓰는 기능은 여기에 선언하고 앱에서 막는다 (CLAUDE.md).

- 저장소·리비전·폴더 이름은 각 모듈(asr는 이곳, diarize·align·embed·voices)의 상수를 그대로 가져온다. 힌트 문구도 여기서 만든다.
- `inspect`는 네트워크 없이 파일 존재와 크기만 본다 (파일 목록·크기는 고정한 리비전의 값). 받기가 남긴 완료 표시의 리비전이 다르면 일부만 받은 것으로 본다. 내용 해시는 voices만 확인한다.
- ASR·VAD는 이 파일이 원본이다 (cli.MODELS·VAD_MODEL이 여기서 가져간다).
- Qwen 항목의 publisher "Alibaba Qwen 팀"은 소유자가 정한 표기다. 카드에는 HF 조직 "Qwen"만 나오고 Alibaba 소속은 적혀 있지 않다 (Alibaba Cloud API 링크뿐).
- 소개 필드(model_name·publisher·converted_by·license·languages·params)는 2026-10-14에 각 모델 카드(HF API·README, 아래 모델 줄 주석)와 NOTICE로 확인한 값이다.
  확인하지 못한 값은 None이다 (추측하지 않는다). source·revision은 내려받는 상수에서 나온다.
"""

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from tractus import align, diarize, embed, paths, voices

LEVELS = ("required", "recommended", "optional")
ONE_OF = "one_of"  # level_note: 같은 기능의 필수 모델 여럿 중 하나만 있으면 된다 (`level`은 그대로 required라 옛 소비자는 그대로 읽는다)
PRESETS = ("required", "standard", "lite", "all")
ID_RE = re.compile(r"^[a-z0-9-]+$")
MARKER = ".tractus-model.json"  # 받기를 마친 뒤 맨 마지막에 쓴다 (id·revision·files)
LOCK_NAME = ".tractus-models.lock"
STANDARD_MIN_MEMORY = 16 * 1024**3
MIN_MEMORY = 8 * 1024**3


def physical_memory() -> int:
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    purpose: str
    level: str
    group: str  # convert | speakers | words | search
    kind: str  # hf | url | helper
    local_dir: str
    size_bytes: int
    repo: str | None = None
    revision: str | None = None
    files: dict[str, int] = field(default_factory=dict)  # 상대 경로 → 바이트 (이게 모두 있고 크기가 맞아야 설치됨)
    url: str | None = None
    sha256: str | None = None
    # 모델 소개 (docs/desktop.md §2.15 `models list --json`). 화면에 그대로 보이므로 WORDS.md §4.14를 따른다
    model_name: str = ""  # 공식 이름을 풀어 쓴 것
    publisher: str = ""  # 만든 곳
    license: str = ""
    converted_by: str | None = None  # 커뮤니티 변환본이면 변환한 곳
    languages: str | None = None
    params: str | None = None
    level_note: str | None = None  # None | ONE_OF (화면은 `필수 (둘 중 하나)`, docs/desktop.md §2.15)

    @property
    def source(self) -> str:
        """내려받는 곳: HF 저장소 ID 또는 URL."""
        return self.repo or self.url or ""

    @property
    def needed_by(self) -> tuple[str, ...]:
        return tuple(c.id for c in CAPABILITIES if any(self.id in g for g in c.models))


@dataclass(frozen=True)
class Capability:
    id: str
    name: str
    models: tuple[tuple[str, ...], ...] = ()  # 모두 필요. 안쪽 튜플은 그중 하나면 된다
    tools: tuple[str, ...] = ()  # ffmpeg | recorder | diar_helper
    min_memory: int = 0  # 이보다 작은 Mac에서는 못 쓴다 (missing에 "memory")


def _hf(id: str, name: str, purpose: str, level: str, group: str, repo: str, revision: str, local_dir: str, files: dict[str, int], **info: str | None) -> Model:
    return Model(id, name, purpose, level, group, "hf", local_dir, sum(files.values()), repo=repo, revision=revision, files=files, **info)


MLX = "mlx-community (MLX 변환본)"


_TOK = {"merges.txt": 1671853, "vocab.json": 2776833, "preprocessor_config.json": 330, "chat_template.json": 1161}


def _qwen_asr(size_cfg: int, weights: int, index: int, extra_cfg: int = 12487, gen: int = 142) -> dict[str, int]:
    return {**_TOK, "config.json": size_cfg, "model.safetensors": weights, "model.safetensors.index.json": index,
            "generation_config.json": gen, "tokenizer_config.json": extra_cfg}


MODELS: tuple[Model, ...] = (
    _hf("vad", "목소리 구간 감지", "녹음에서 사람이 말하는 구간을 찾습니다.", "required", "convert",
        "mlx-community/silero-vad-v6", "2ebf4a5e10726a2e78ddd4d70eedfb6f1c33eb06", "silero-vad-v6",
        {"config.json": 463, "model.safetensors": 1237860},
        # 카드 mlx-community/silero-vad-v6: license mit, base_model snakers4/silero-vad, "~309K" 파라미터. 원 저장소 README: Silero Team, MIT. 6000개 넘는 언어 말뭉치로 학습했다고만 적혀 있고 지원 언어 목록은 없어 languages는 None
        model_name="Silero VAD v6", publisher="Silero", converted_by=MLX, license="MIT", params="309K"),
    _hf("asr-std", "변환 엔진 (표준)", "가장 정확합니다. 메모리 16GB 이상을 권합니다.", "required", "convert",
        "mlx-community/Qwen3-ASR-1.7B-8bit", "a8379a2e2f9e313c9292cdf1af4055ab56d50d55", "qwen3-asr-1.7b-8bit",
        _qwen_asr(7188, 2463307541, 78968), level_note=ONE_OF,
        # 카드 mlx-community/Qwen3-ASR-1.7B-8bit: Qwen/Qwen3-ASR-1.7B에서 mlx-audio 0.3.1로 변환, apache-2.0. 원본 카드(HF 조직 Qwen): 30개 언어 + 중국어 방언 22개, ko·en 포함
        model_name="Qwen3-ASR 1.7B (8bit 양자화)", publisher="Alibaba Qwen 팀", converted_by=MLX, license="Apache-2.0", languages="한국어·영어 등 30개 언어와 중국어 방언 22개", params="1.7B"),
    _hf("asr-lite", "변환 엔진 (가벼운 것)", "메모리를 덜 쓰는 가벼운 엔진입니다. 실시간 텍스트 변환에는 이 엔진이 따로 필요합니다.", "required", "convert",
        "mlx-community/Qwen3-ASR-0.6B-8bit", "89e96d92ba34aca20b3e29fb10cc284097d1219f", "qwen3-asr-0.6b-8bit",
        _qwen_asr(7187, 1006229426, 71815), level_note=ONE_OF,
        # 카드 mlx-community/Qwen3-ASR-0.6B-8bit: Qwen/Qwen3-ASR-0.6B에서 변환, apache-2.0. 언어는 1.7B와 같은 원본 카드 표
        model_name="Qwen3-ASR 0.6B (8bit 양자화)", publisher="Alibaba Qwen 팀", converted_by=MLX, license="Apache-2.0", languages="한국어·영어 등 30개 언어와 중국어 방언 22개", params="0.6B"),
    _hf("diarizer", "참석자 구분", "누가 말했는지 나눕니다. 8명까지 구분합니다.", "recommended", "speakers",
        diarize.MODEL_REPO, diarize.MODEL_REVISION, diarize.MODEL_DIR,
        {"config.json": 1521, "model.safetensors": 198632220},
        # 카드 mlx-community/Nemotron-3-Diarization: nvidia/Nemotron-3-Diarization에서 변환, openmdw-1.1, 최대 8명. NVIDIA 카드: "Number of model parameters: 100M". 지원 언어 표기는 없다 (학습 데이터만 적혀 있어 None)
        model_name="Nemotron 3 Diarization", publisher="NVIDIA", converted_by=MLX, license="OpenMDW-1.1", params="100M"),
    _hf("aligner", "단어 싱크", "단어마다 재생 시각을 맞춰, 듣는 곳의 단어를 강조합니다.", "optional", "words",
        align.MODEL_REPO, align.MODEL_REVISION, align.MODEL_DIR,
        {**_TOK, "config.json": 6940, "model.safetensors": 1271924386, "model.safetensors.index.json": 79108,
         "generation_config.json": 115, "tokenizer_config.json": 12666},
        # 카드 mlx-community/Qwen3-ForcedAligner-0.6B-8bit: Qwen/Qwen3-ForcedAligner-0.6B에서 변환, apache-2.0. 원본 카드: 11개 언어(ko·en 포함), 최대 5분
        model_name="Qwen3-ForcedAligner 0.6B (8bit 양자화)", publisher="Alibaba Qwen 팀", converted_by=MLX, license="Apache-2.0", languages="한국어·영어 등 11개 언어", params="0.6B"),
    _hf("embedding", "스마트 검색", "단어가 달라도 비슷한 뜻의 대화를 찾습니다.", "optional", "search",
        embed.MODEL_REPO, embed.MODEL_REVISION, embed.MODEL_DIR,
        {"added_tokens.json": 707, "config.json": 857, "merges.txt": 1671853, "model.safetensors": 633152041, "special_tokens_map.json": 613,
         "tokenizer.json": 11423705, "tokenizer_config.json": 5404, "vocab.json": 2776833},
        # 카드 mlx-community/Qwen3-Embedding-0.6B-8bit (2026-10-15 HF API 확인): Qwen/Qwen3-Embedding-0.6B에서 mlx-embeddings로 변환, apache-2.0, config quantization bits 8·group 64.
        # 원본 카드(HF 조직 Qwen): "Supported Languages: 100+", "Number of Parameters: 0.6B". 변환본 카드에는 언어·파라미터 수가 없어 원본 값을 쓴다
        model_name="Qwen3-Embedding 0.6B (8bit 양자화)", publisher="Alibaba Qwen 팀", converted_by=MLX, license="Apache-2.0", languages="100개 이상의 언어", params="0.6B"),
    Model("voices", "참석자 목소리 프로필", "등록한 참석자의 목소리를 알아보고 이름을 제안합니다.", "optional", "speakers", "url", voices.MODEL_DIR,
          28281164, files={voices.MODEL_FILE: 28281164}, url=voices.MODEL_URL, sha256=voices.MODEL_SHA256,
          # ModelScope iic/speech_campplus_sv_zh_en_16k-common_advanced: 3D-Speaker(alibaba-damo-academy), Apache License 2.0, 언어 cn·en. ONNX는 k2-fsa/sherpa-onnx 릴리스(speaker-recongition-models)가 올린 것. 파라미터 수는 카드에 없다
          model_name="3D-Speaker CAM++ (중국어·영어, 16kHz)", publisher="3D-Speaker (Alibaba DAMO)", converted_by="k2-fsa sherpa-onnx (ONNX 변환본)", license="Apache-2.0", languages="중국어·영어"),
    Model("fluid", "참석자 구분 (9명 이상)", "9명 이상이 말한 노트에서 참석자를 더 정확히 나눕니다. 따로 빌드한 도우미 프로그램이 필요합니다.",
          "optional", "speakers", "helper", diarize.FLUID_DIR, 21_800_000, repo=diarize.FLUID_REPO,
          # 카드 FluidInference/speaker-diarization-coreml: base_model pyannote/speaker-diarization-community-1, 이 범위(Community-1 산출물)는 CC-BY-4.0 (NOTICE.md). 리비전은 FluidAudio v0.17.5가 내려받는 HEAD라 고정하지 않는다 (None)
          model_name="pyannote speaker-diarization community-1 (Core ML)", publisher="pyannote", converted_by="FluidInference (Core ML 변환본)", license="CC-BY-4.0"),
)

CAPABILITIES: tuple[Capability, ...] = (
    Capability("record", "녹음", tools=("recorder",)),
    Capability("convert", "텍스트로 변환", models=(("vad",), ("asr-std", "asr-lite")), tools=("ffmpeg",)),
    Capability("diarize", "참석자 구분", models=(("diarizer",),)),
    Capability("diarize-many", "참석자 구분 (9명 이상)", models=(("fluid",),)),
    Capability("align", "단어 싱크", models=(("aligner",),), tools=("ffmpeg",)),  # 노트 오디오를 디코딩한다
    Capability("smart-search", "스마트 검색", models=(("embedding",),)),
    Capability("live", "실시간 텍스트 변환", models=(("vad",), ("asr-lite",)), tools=("recorder",), min_memory=STANDARD_MIN_MEMORY),  # cli live_low_memory와 같은 기준
    Capability("voices", "참석자 목소리 인식", models=(("voices",),), tools=("ffmpeg",)),
)

_BY_ID = {m.id: m for m in MODELS}


def build_hint(item: str) -> str | None:
    """없는 도구를 채우는 안내. 녹음·도우미 프로그램은 저장소 배치일 때만 빌드 명령을 말한다 (paths.build_hint)."""
    return "brew install ffmpeg" if item == "ffmpeg" else paths.build_hint(item) if item in ("recorder", "diar_helper") else None


def get(model_id: str) -> Model:
    return _BY_ID[model_id]


def by_repo(repo: str) -> Model | None:
    return next((m for m in MODELS if m.repo == repo and m.kind == "hf"), None)


def preferred_asr(memory: int | None = None) -> str:
    """메모리가 권하는 변환 엔진 (16GB 이상이면 표준)."""
    return "asr-std" if (physical_memory() if memory is None else memory) >= STANDARD_MIN_MEMORY else "asr-lite"


def pick_asr(root: Path, memory: int | None = None) -> str | None:
    """`--track` 없이 변환할 때 쓸 변환 엔진: 메모리가 권하는 쪽이 쓸 수 있으면 그것, 아니면 다른 쪽, 둘 다 없으면 None."""
    first = preferred_asr(memory)
    return next((i for i in (first, "asr-lite" if first == "asr-std" else "asr-std") if usable(i, root)), None)


def preset_ids(preset: str, memory: int | None = None, helper: bool = False) -> list[str]:
    """프리셋 → 모델 ID (등록 순서). all은 도우미 프로그램이 있을 때만 fluid를 넣는다."""
    if preset == "required":
        ids = {"vad", preferred_asr(memory)}
    elif preset == "standard":
        ids = {"vad", "asr-std", "diarizer", "aligner", "embedding", "voices"}
    elif preset == "lite":
        ids = {"vad", "asr-lite", "diarizer"}
    elif preset == "all":
        ids = {m.id for m in MODELS if helper or m.id != "fluid"}
    else:
        raise ValueError(f"알 수 없는 프리셋: {preset} ({', '.join(PRESETS)})")
    return [m.id for m in MODELS if m.id in ids]


def resolve_ids(ids: list[str], preset: str | None, memory: int | None = None, helper: bool = False) -> list[str]:
    """명령줄의 모델 ID와 프리셋 → 중복 없는 ID (등록 순서). 모르는 ID는 ValueError."""
    for i in ids:
        if not ID_RE.fullmatch(i) or i not in _BY_ID:
            raise ValueError(f"알 수 없는 모델: {i} ({', '.join(_BY_ID)})")  # words-ok: 명령줄 인수 오류 (앱은 검증한 ID만 넘긴다)
    wanted = set(ids) | (set(preset_ids(preset, memory, helper)) if preset else set())
    return [m.id for m in MODELS if m.id in wanted]


# ── 설치 상태 ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Status:
    state: str  # installed | missing | partial | corrupt
    installed_bytes: int = 0
    has_incomplete: bool = False  # 받다 만 파일(.incomplete, .part)이 있다

    @property
    def installed(self) -> bool:
        return self.state == "installed"


def _incomplete_files(d: Path) -> list[Path]:
    return [*(d / ".cache/huggingface/download").glob("*.incomplete"), *d.glob("*.part")]


def _size(p: Path) -> int | None:
    try:
        return p.stat().st_size if p.is_file() else None
    except OSError:
        return None


def _dir_bytes(d: Path) -> int:
    return sum(f.stat().st_size for f in d.rglob("*") if f.is_file() and not f.is_symlink()) if d.is_dir() else 0


def _sha256(p: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _stale_marker(m: Model, d: Path) -> bool:
    """받기가 남긴 완료 표시의 리비전이 지금 등록된 것과 다르다. 표시가 없거나(직접 받은 폴더) 읽지 못하면 아니다."""
    try:
        rev = json.loads((d / MARKER).read_text(encoding="utf-8")).get("revision")
    except (OSError, ValueError, AttributeError):
        return False
    return bool(m.revision) and rev is not None and rev != m.revision


def _inspect_files(m: Model, d: Path) -> Status:
    good = bad = got = 0
    for rel, expected in m.files.items():
        n = _size(d / rel)
        if n is None:
            continue
        if n != expected or (m.sha256 and _sha256(d / rel) != m.sha256):
            bad += 1
        else:
            good, got = good + 1, got + n
    partial_files = _incomplete_files(d)
    extra = sum(_size(p) or 0 for p in partial_files)
    if bad:
        return Status("corrupt", got, bool(partial_files))
    if good == len(m.files):
        return Status("partial" if _stale_marker(m, d) else "installed", got)  # 옛 리비전: 다시 받아야 한다
    return Status("partial" if good or partial_files else "missing", got + extra, bool(partial_files))


def _inspect_helper(m: Model, d: Path) -> Status:
    models_ok = d.is_dir() and diarize._fluid_models_ok(d)
    helper = diarize._executable(diarize.fluid_bin())
    size = _dir_bytes(d)
    if models_ok and helper:
        return Status("installed", size)
    return Status("partial" if models_ok or size else "missing", size)  # 모델만 있고 도우미 프로그램이 없어도 쓸 수 없으니 partial


def inspect(model_id: str, root: Path) -> Status:
    m = get(model_id)
    d = root / m.local_dir
    if not d.is_dir():
        return Status("missing")
    return _inspect_helper(m, d) if m.kind == "helper" else _inspect_files(m, d)


def usable(model_id: str, root: Path) -> bool:
    """실행해 볼 수 있나. 설치가 끝났거나, 가중치 없이 config.json만 있는 폴더(cli.local_model이 받아들이는 직접 만든 폴더·테스트 픽스처)이고
    받다 만 파일이 없다. 가중치가 있는데 크기가 맞지 않으면(손상·받는 중) 아니다."""
    st = inspect(model_id, root)
    if st.installed:
        return True
    m = get(model_id)
    d = root / m.local_dir
    return m.kind == "hf" and (d / "config.json").is_file() and not (d / "model.safetensors").exists() and not st.has_incomplete


# ── 기능 ─────────────────────────────────────────────────────────────────────

def capability_status(states: dict[str, str], tools: dict[str, bool], memory: int | None = None) -> list[dict]:
    """모델 상태({id: state})와 도구({ffmpeg: 있음})로 기능별 준비 여부. missing: 채워야 할 모델 ID와 도구 이름.
    둘 중 하나면 되는 모델(asr-std·asr-lite)이 모두 없으면 메모리가 권하는 쪽을 missing에 둔다."""
    out = []
    for c in CAPABILITIES:
        missing: list[str] = []
        for group in c.models:
            if not any(states.get(i) == "installed" for i in group):
                missing.append(preferred_asr(memory) if "asr-std" in group and "asr-lite" in group else group[0])
        missing += [t for t in c.tools if not tools.get(t)]
        if (physical_memory() if memory is None else memory) < c.min_memory:
            missing.append("memory")
        out.append({"id": c.id, "name": c.name, "ready": not missing, "missing": missing, "hint": "; ".join(fix_command(i) for i in missing)})
    return out


def fix_command(item: str) -> str:
    if item == "memory":
        return "메모리 16GB 이상인 Mac에서만 켤 수 있습니다"
    return build_hint(item) or f"tractus models download {item}"


# ── 힌트 문구 (코어 경고·오류가 쓴다) ──────────────────────────────────────────

def install_hint(m: Model | str, root: Path) -> str:
    """모델을 받는 명령. 첫 줄은 tractus, 둘째 줄부터는 직접 받는 방법."""
    m = get(m) if isinstance(m, str) else m
    path = root / m.local_dir
    lines = [f"  tractus models download {m.id}"]
    if m.kind == "hf":
        lines.append(f"  (직접 받기: hf download {m.repo} --revision {m.revision} --local-dir {path})")
    elif m.kind == "url":
        lines.append(f"  (직접 받기: mkdir -p {path} && curl -L -o {path / next(iter(m.files))} {m.url}  sha256 {m.sha256})")
    else:
        lines.append(f"  (도우미 프로그램: {build_hint('diar_helper')})")
    return "\n".join(lines)
