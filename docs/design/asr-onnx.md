# 설계: Windows 텍스트 변환 런타임 (Qwen3-ASR ONNX + onnxruntime CPU)

> 상태: 설계 (2026-11-19). 9절 1번 PR(어댑터, `windows/asr-onnx-adapter`, ARCHITECTURE v3.141)을 구현했다. 2번 PR(`windows/asr-onnx-bench`, v3.142)로 Mac 품질을 쟀다: 결과와 기준 판정은 8.5절이다. 구현하며 실제 모델로 확인한 것은 3.3절 끝("구현에서 실제로 확인한 것")에 적었다. 나머지 PR은 구현 전이다. 근거: docs/windows/plan.md 6.1·7.4절, docs/windows/README.md W4·W5, docs/design/asr-engines.md.
> 이 문서는 설계만 정한다. **`bench/` 측정 전에는 어떤 ONNX 모델도 등록 목록(`models_registry.MODELS`)에 올리지 않는다**(CLAUDE.md).

## 결론

Windows에서는 Mac과 **같은 모델 계열(Qwen3-ASR)**을 ONNX int4로 바꾼 판을 onnxruntime **CPU**로 돌린다. 계열은 `qwen3` 그대로 두고, 그 아래 실행 경로만 하나 더한다. 어느 경로로 돌릴지는 모델 폴더의 표지 파일로 정한다. 그래서 반복 루프 재시도·토큰 상한·자주 쓰는 단어 안전장치·오감지 재시도·ITN은 `Transcriber._transcribe`에 있는 그대로 공유되고, 복사하지 않는다.

먼저 만드는 것은 셋이다.

1. ONNX 어댑터 `src/tractus/asr_onnx.py`(MLX 없이 numpy + `tokenizers` + `onnxruntime`)
2. Silero VAD ONNX 어댑터 `src/tractus/vad_onnx.py`
3. 두 런타임을 **같은 조건**으로 재는 `bench/` 갈래(토큰 상한 같음, 앱 경로 모드 포함)

모델은 `andrewleech/qwen3-asr-1.7b-onnx`·`-0.6b-onnx`의 int4 판에서 출발했다. **2026-11-25부터 1.7B는 같은 원본에서 직접 만든 int8 판 `voyagar/Qwen3-ASR-1.7B-onnx-int8`을 쓴다(8.6절). 0.6B는 Windows 목록에 두지 않는다(11절 11번).** 등록 목록에는 측정이 끝난 뒤에만, **Windows에서만 보이는 항목**으로 올린다. ID는 Mac과 같다(`vad`·`asr-std`·`asr-lite`). Windows 목록에 없는 단계(화자 분리·목소리·단어 싱크)는 파이프라인이 모델을 찾기 전에 건너뛴다.

미루는 것:

- 실시간 자막, 화자 분리, 단어 싱크, 목소리, 로컬 스마트 검색
- 한국어 파인튜닝 엔진(`asr-ko-univa`)의 ONNX 변환
- 병합 디코더(merged) 판
- DirectML·GPU

macOS 번들·동작은 바뀌지 않는다. onnxruntime은 `sys_platform == 'win32'` 표지로만 들어간다.

## 1. 목표·비목표

**목표 (Windows 미리보기, README W5 범위)**

- 녹음·가져오기 → **배치 텍스트 변환**(onnxruntime CPU) → 요약·질문(원격 AI) → 키워드 검색 → 내보내기가 Windows에서 돈다.
- 변환 품질은 Mac과 같은 수준이다. 기준은 같은 조건으로 다시 잰 MLX 8bit 대비 CER +1.0 이내이고, 배치 RTF는 기준 기기에서 0.5 이하다(8.3절. 숫자는 W4 측정 뒤 다시 본다).
- Mac의 안전장치가 하나도 빠지지 않는다. 대상은 다음과 같다.
  - 자동 감지, 빈 출력이면 한국어로 다시 변환
  - 짧은 청크의 중국어·일본어 오감지 재시도
  - 토큰 상한, 반복 루프 재시도(자동 감지 → 온도 0.3 → 접기)
  - 자주 쓰는 단어(앞 50개, 1초 미만 청크에는 넣지 않음, 받아 적기 감지 후 재변환)
  - 숫자 표기 바꾸기(ITN)
- 이 안전장치들이 실제 음성에서 MLX와 같은 비율로 작동하는지 측정으로 확인한다(8.2절 앱 경로 모드).
- macOS의 번들·의존성·동작·시험은 바뀌지 않는다.

**비목표 (이번에 하지 않는다)**

| 미루는 것 | 이유 | 언제 |
| --- | --- | --- |
| 실시간 자막(`tractus live`) | VAD `feed()`·0.6B 지연을 Windows CPU에서 재야 한다(확정 지연 p95 ≤ 1.0초, `bench/live_sim.py`도 지금 MLX에 묶여 있다) | Stage 2 |
| 화자 분리·단어 싱크·목소리·로컬 스마트 검색 | 모두 MLX 모델이다. 미리보기에서는 파이프라인이 건너뛰고(4.3절) 앱은 기능 잠금으로 막는다 | Stage 2 (README W6) |
| `asr-ko-univa`·`asr-ko-mix` Windows판 | ONNX 판이 없다. UNIVA는 변환한 뒤 측정한다(2.3절) | 미리보기 뒤 |
| 병합 디코더(rhasspy·craigandrews), 인코더 int4 | 크기·메모리는 낫지만 한국어 품질을 재지 않았다 | 측정 후보로만 |
| DirectML·CUDA·OpenVINO | `onnxruntime-directml`은 1.24로 CPU판(1.32)보다 많이 뒤처졌고 같은 import 폴더를 쓴다(둘 중 하나만 설치된다). 상류는 AMD iGPU에서 결과가 깨진다고 보고했다 | 측정 뒤 |
| 사용자가 ONNX 엔진을 직접 추가(`models add`) | `CUSTOM_PATTERNS`가 `.onnx`를 받지 않고, 계열 검사도 MLX 형식만 본다 | 미리보기 뒤 |
| Whisper를 Windows 기본으로 | Phase 0 한국어 CER 14.92(Qwen 9.49). 사전을 넣으면 더 나빠진다 | 소유자 결정 사항(plan 7.5 #5) |

## 2. 모델 선택

### 2.1 고른 것

| 크기 | 저장소 @ revision | 양자화 | 합계 | 라이선스 |
| --- | --- | --- | --- | --- |
| 1.7B (`asr-std`) | `andrewleech/qwen3-asr-1.7b-onnx` @ `df916193ac67e59347769891a21e10d81d12acdd` | 디코더 int4 (RTN, block 64, accuracy_level 4, `MatMulNBits`), 인코더 FP32, 임베딩 fp16 | 4,131,035,498 B (약 4.13GB) | Apache-2.0 |
| 0.6B (`asr-lite`) | `andrewleech/qwen3-asr-0.6b-onnx` @ `4fc24a1402e74db89c4d2ef256875e71680128c4` | 같음 | 2,031,529,199 B (약 2.03GB) | Apache-2.0 |

받는 파일과 크기(HF API로 확인, 바이트):

| 파일 | 1.7B | 0.6B | 비고 |
| --- | --- | --- | --- |
| `encoder.int4.onnx` | 1,270,241,779 | 745,762,694 | 이름과 달리 FP32다. `encoder.onnx`와 LFS 해시가 같으므로 하나만 받는다 |
| `decoder_init.int4.onnx` | 356,165 | 355,390 | 그래프만 있다. 가중치는 아래 `.data` |
| `decoder_step.int4.onnx` | 355,662 | 354,888 | 같음. **실행 경로 판별 표지**(3.1절) |
| `decoder_weights.int4.data` | 2,226,321,408 | 962,460,672 | 두 디코더가 함께 쓰는 외부 데이터. 같은 폴더에 있어야 한다 |
| `embed_tokens.bin` | 622,329,856 | 311,164,928 | fp16 `[151936, H]` |
| `tokenizer.json` | 11,429,377 | 11,429,377 | `tokenizers`로 읽는다 |
| `config.json` | 1,251 | 1,250 | `model_type: "qwen3_asr"`, `decoder.hidden_size`(H), 특수 토큰, mel 설정 |

받지 않는 파일: fp32 디코더(`decoder_weights.data` 8.1GB/3.0GB), `.tar.gz` 묶음, `vocab.json`, `tokenizer_config.json`, `added_tokens.json`, `preprocessor_config.json`.

**왜 이것인가**

- 1.7B int4는 Mac CPU에서 한 번 쟀다(plan 6.1, 같은 revision). AI Hub 세션 1의 앞 60발화에서 CER 9.51(MLX 10.07), RTF 0.26, 최대 메모리 4.3GB, 반복·빈 출력 0이다.
  - 조건이 지금 계획과 다르다: onnxruntime 1.30, 저장소 밖 일회성 스크립트, **정답 발화 구간**으로 자른 짧은 발화(30초 VAD 청크 아님), 한국어 고정, 자주 쓰는 단어 없음.
  - 그래서 품질은 "나빠지지 않을 것 같다"는 신호로만 쓰고, 4.3GB는 30초 청크 + 자주 쓰는 단어의 메모리 상한이 아니다. 둘 다 8절에서 다시 잰다.
- 두 크기가 그래프 계약(입출력 이름·모양)이 같다. 디코딩 고리 하나로 둘 다 돈다.
- Apache-2.0이고 3월 뒤로 바뀌지 않았다. 내보내기 코드(`andrewleech/qwen3-asr-onnx`, Apache-2.0)가 공개되어 있어 UNIVA도 같은 방법으로 바꿀 수 있다.

### 2.2 고르지 않은 것

| 후보 | 판단 |
| --- | --- |
| `rhasspy/qwen3-asr-0.6b-onnx-int4-merged` (0.79GB), `craigandrews/qwen3-asr-1.7b-onnx-int4-merged` (1.81GB) | **다음 측정 후보.** 디코더 하나에 KV 캐시를 넣고, 마지막 위치 logits만 내며, 메모리가 1.4GB 적다. 다만 영어 짧은 음성으로만 확인했고 한국어 측정이 없다 |
| `rhasspy/qwen3-asr-0.6b-onnx-int4` (인코더 int4) | 인코더 int4의 한국어 품질을 재지 않았다 |
| `jiangzhuo9357/Qwen3-ASR-*-ONNX` | 브라우저용이다. block 32는 상류가 실패라고 경고한 설정이고, 프롬프트 ID를 박아 둔 버그가 있다 |
| `OpenVoiceOS/qwen3-asr-1.7b-onnx` | int8이 빈 출력을 낸다(자기 README). **탈락** |
| `Daumee/Qwen3-ASR-0.6B-ONNX-CPU` | 더 크고 관리되지 않는다. **탈락** |

### 2.3 한국어 파인튜닝(`asr-ko-univa`) ONNX 변환 (나중 단계)

- ONNX 판이 아직 없다. Mac 목록의 `voyagar/Qwen3-ASR-1.7B-ko-mlx-8bit`와 같은 원본(`TeamUNIVA/qwen3_asr_1.7b_ko`, 레지스트리 기록 `3e66f586`)을 같은 방법으로 바꾼다.
- 변환은 Tractus 의존성 밖에서 한다. torch가 든 일회성 가상환경에서 `andrewleech/qwen3-asr-onnx` @ `4aee2ae0`으로 다음 순서를 밟는다.
  1. `export.py --model TeamUNIVA/qwen3_asr_1.7b_ko`(원본 형식 `thinker_config`라 이 도구가 맞다. craigandrews 병합 스크립트는 `-hf` 형식만 받는다)
  2. `validate.py`
  3. `optimize_graphs.py`
  4. `quantize_nbits.py --bits 4 --block-size 64 --accuracy-level 4`
  5. `encoder.onnx`를 `encoder.int4.onnx`로 복사
  6. `convert_embed_fp16.py`
- `tokenizer.json`은 **UNIVA 것**을 넣는다. 해시가 원본과 다르고(`0499…` 대 `bd2a…`), 차이의 의미는 확인하지 않았다.
- 소유자 계정 `voyagar/Qwen3-ASR-1.7B-ko-onnx-int4`(가칭)에 올린다. 모델 카드에는 원작자, Apache-2.0, 변환 명령, 측정표를 적는다. 커밋을 고정한다.
- 확인:
  - 같은 5분 구간에서 MLX 8bit판과 출력 차이 CER을 본다(BuzzASR·UNIVA 때와 같은 방법).
  - 그다음 `bench/`로 FLEURS·HiKE·AI Hub를 잰다. CLAUDE.md 면제 기록이 "다음에 이 엔진을 … 바꿀 때 셋 다 잰다"고 정했으므로 이번에는 면제하지 않는다.

## 3. 어댑터 구조

### 3.1 계열이 아니라 폴더 표지로 가른다

`config.json`의 `model_type`이 두 크기 모두 `"qwen3_asr"`다(2026-11-19 확인). 따라서 `engine_of()`는 그대로 `ENGINES["qwen3"]`를 돌려준다. 계열 표(`ENGINES`)·`models_install.NEEDED_FILES`·`Engine` 필드는 고치지 않는다.

| 차원 | 값 | 정하는 곳 |
| --- | --- | --- |
| 계열 (`Engine.family`) | `qwen3` (그대로) | `config.json`의 `model_type` (`engine_of`) |
| 실행 경로 | mlx-audio \| onnxruntime | 모델 폴더에 `decoder_step.int4.onnx`가 있는가 (`asr_onnx.MARKER`) |
| transcript 기록 `asr.runtime` | `"mlx-audio"` \| `"onnxruntime"` | `asr.model`(저장소)이 레지스트리의 ONNX 저장소인가 (3.5절) |

**폴더로 정하는 이유:**

- Mac에서도 ONNX 어댑터를 시험·측정할 수 있다(`uv run --with onnxruntime`).
- 운영체제 갈래는 "어느 목록을 쓰는가" 한 곳(`models_registry`)에만 둔다.

**가장 큰 위험:** `model_type`이 같으므로, 판별을 빠뜨리면 ONNX 폴더가 `mlx_audio.stt.utils.load`로 넘어간다. `Transcriber.load`가 표지 파일을 먼저 본다. 이 갈래는 시험으로 고정한다.

### 3.2 바뀌는 곳 (`asr.py`)

```python
class Transcriber:                                       # 생성자는 그대로 (runtime 칸을 더하지 않는다)
    @classmethod
    def load(cls, model_dir: Path) -> "Transcriber":
        engine = engine_of(model_dir)
        if (model_dir / asr_onnx.MARKER).exists():       # model_type이 같아 config로는 못 가른다
            if engine.family != "qwen3":
                raise ValueError(...)                    # ONNX 어댑터는 Qwen3-ASR 그래프만 안다
            return cls(asr_onnx.OnnxQwen3ASR.load(model_dir), engine)
        from mlx_audio.stt.utils import load
        return cls(load(str(model_dir)), engine)

    def _generate(self, audio, ...):
        x = np.asarray(audio, dtype=np.float32)          # Qwen3-ASR은 mlx-audio·ONNX 모두 numpy를 받는다
        if self.engine.family in ("whisper", "sensevoice"):
            import mlx.core as mx
            x = mx.array(x)
        ...  # 계열별 갈래는 그대로
```

- mlx-audio 0.5.7 Qwen3-ASR `generate`는 받은 `mx.array`를 처음에 `np.array`로 되돌린다(`qwen3_asr.py` 1400행 부근). 그래서 Qwen에 numpy를 넘겨도 Mac 결과는 같다. `mx.array`는 MLX 전용 계열(whisper·sensevoice) 갈래에만 남긴다.
- 그 결과 `mlx.core` import가 갈래 안으로 들어가고, 가짜 모델을 쓰는 `tests/test_asr.py`가 Windows에서도 돈다. 지금은 `_generate`의 `import mlx.core`(asr.py:156)에서 실패한다(skip 표시가 있는 것이 아니다).
- `_transcribe`·`transcribe`·`Segment`·상수는 **바꾸지 않는다**. `.chunks.jsonl` 이어하기 호환을 위해 `Segment(text, lang, repaired)`도 그대로다. (예외 후보 한 줄은 3.4절 "자주 쓰는 단어" 행과 11절 7번.)

### 3.3 새 모듈 `src/tractus/asr_onnx.py`

```python
MARKER = "decoder_step.int4.onnx"
FILES = ("encoder.int4.onnx", "decoder_init.int4.onnx", MARKER,
         "decoder_weights.int4.data", "embed_tokens.bin", "tokenizer.json", "config.json")

@dataclass
class Output:                      # mlx-audio STTOutput에서 Transcriber가 읽는 세 칸만
    text: str
    language: str | None
    generation_tokens: int

def ort():                                          # onnxruntime 늦은 import. 실패하면 ImportError 그대로 (3.5절이 코드로 바꾼다)
def log_mel(pcm: np.ndarray) -> np.ndarray          # [1,128,T] f32, WhisperFeatureExtractor와 같은 값
def build_prompt(n_audio: int, language: str | None, hotwords: list[str] | None) -> str
def parse_language(text: str) -> tuple[str, str]    # mlx-audio extract_language와 같은 규칙
def pick(logits: np.ndarray, temperature: float, rng) -> int
def decode(init, step, emb, ids, af, off, eos, max_tokens, temperature, rng) -> list[int]   # 세션을 받는 디코딩 고리

class OnnxQwen3ASR:
    @classmethod
    def load(cls, model_dir: Path) -> "OnnxQwen3ASR": ...   # 여기서만 onnxruntime·tokenizers를 부른다: 세션 3개 + 토크나이저 + 임베딩(memmap)
    def __init__(self, enc, init, step, tok, emb, cfg): ...
    def generate(self, audio, *, language=None, hotwords=None, max_tokens=8192, temperature=0.0) -> Output
```

- 모듈은 `mlx`를 import하지 않는다. `onnxruntime`·`tokenizers`는 `load` 안에서만 부른다.
- 디코딩 고리를 세션을 받는 함수(`decode`)로 뺀 것은 시험 때문이다. 가짜 `run`·가짜 토크나이저를 넘기면 onnxruntime 없이 돈다(7절).

**generate가 지켜야 할 mlx-audio 0.5.7 동작** (`stt/models/qwen3_asr/qwen3_asr.py`, `stt/utils.py`에서 확인):

| 항목 | mlx-audio | ONNX 어댑터 |
| --- | --- | --- |
| 1초 미만 오디오 | 0으로 채워 1초로 만든다(`split_audio_into_chunks`, `min_chunk_duration=1.0`) | 같게 채운다 |
| 자주 쓰는 단어 | `merge_hotwords`: 빈 값을 뺀 `", ".join(terms)`가 `system_prompt`가 된다 | 같다 |
| 프롬프트 | `<\|im_start\|>system\n{sys}<\|im_end\|>\n<\|im_start\|>user\n<\|audio_start\|>{<\|audio_pad\|>×A}<\|audio_end\|><\|im_end\|>\n<\|im_start\|>assistant\n{prefix}`. `sys`는 `system_prompt + "\n"` 또는 빈 문자열 | 같은 문자열을 **통째로** 토큰화한다(`add_special_tokens=False`) |
| 언어 고정 | `prefix = "language {Name}<asr_text>"` (`Korean`/`English`) | 같다. `Output.language = Name` |
| 자동 감지 | prefix 없음. 출력 `language X<asr_text>본문`을 `extract_language`로 나눈다. `<asr_text>`가 없으면 `("English", text)` | `parse_language`가 같은 규칙으로 나눈다 |
| 종료 | EOS = {151643, 151645} (+토크나이저 eos). EOS는 세지 않는다 | 같다 |
| `generation_tokens` | EOS를 뺀 생성 토큰 수. 자동 감지면 `language X<asr_text>` 토큰도 센다 | 같다 → `_capped`의 상한 판정이 그대로 먹는다 |
| `max_tokens` | 생성 토큰 수 상한 | 같다(고리 조건) |
| 온도 | 0이면 argmax. 아니면 `make_sampler(temp, top_p=1, top_k=0, min_p=0)` = `softmax(logits/T)`에서 뽑기 | 같다(`np.random.default_rng()`, 시드 없음) |
| 반복 벌점 | 없음 | 없음 |
| 디코딩 | `decode(skip_special_tokens=True)`, 공백은 그대로(Transcriber가 strip) | 같다 |

**프롬프트 ID를 박아 두지 않는다.** 상류 `src/prompt.py`·`transcribe-rs` `prompt.rs`·jiangzhuo `prompt_config.json`은 "system"·"user"를 9125·882로 박아 두었다. 이 값은 실제로 `" Current"`·`" time"`이다(맞는 값은 8948·872, "assistant"는 77091). 그대로 옮기면 시스템 턴과 자주 쓰는 단어가 조용히 깨진다. 특수 토큰 ID(오디오 패드 151676 등)는 `config.json`의 `special_tokens`에서 읽는다.

**디코딩 고리 (실제 텐서 이름)**

```python
cfg = json.loads((d / "config.json").read_text())
H, V = cfg["decoder"]["hidden_size"], cfg["decoder"]["vocab_size"]          # 1.7B: 2048, 0.6B: 1024 / 151936
emb = np.memmap(d / "embed_tokens.bin", np.float16, "r", shape=(V, H))     # 한 행씩 f32로
mel = log_mel(pcm)                                                          # [1,128,T]
af  = enc.run(["audio_features"], {"mel": mel})[0]                          # [1,A,H]
ids = tok.encode(build_prompt(af.shape[1], language, hotwords), add_special_tokens=False).ids
off = ids.index(cfg["special_tokens"]["audio_pad_token_id"])

# decode(): 여기부터가 세션을 받는 함수다
logits, K, V_ = init.run(None, {"input_ids": i64([ids]), "position_ids": i64([range(len(ids))]),
                               "audio_features": af, "audio_offset": i64([off])})
out, pos = [], len(ids)
nxt = pick(logits[0, -1], temperature, rng)
while nxt not in eos and len(out) < max_tokens:
    out.append(nxt)
    logits, K, V_ = step.run(None, {"input_embeds": emb[nxt].astype(np.float32)[None, None],
                                    "position_ids": i64([[pos]]), "past_keys": K, "past_values": V_})
    pos += 1
    nxt = pick(logits[0, -1], temperature, rng)

text = tok.decode(out, skip_special_tokens=True)
lang, text = (language, text) if language else parse_language(text)
return Output(text, lang, len(out))
```

- 이 고리는 토큰마다 KV `[28,1,8,P,128]` f32 두 개를 numpy로 받고 다시 넘긴다(P≈500이면 하나에 약 57MB). 첫 구현은 이대로 두고, 기준 기기 RTF가 기준을 넘으면 먼저 ORT `io_binding()` + `OrtValue`로 KV를 세션 안에 둔다(8.3절). 고리 함수 하나 안에서 끝나고 모델은 그대로다.

그래프 계약(protobuf에서 읽음, 배치 1):

- **`decoder_init`:**
  - 입력: `input_ids`·`position_ids` i64 `[1,S]`, `audio_features` f32 `[1,A,H]`, `audio_offset` i64 `[1]`
  - 출력: `logits` `[1,S,151936]`, `present_keys`/`present_values` `[28,1,8,S,128]`
  - 그래프 안에서 하는 것: 임베딩, 인과 마스크, MRoPE
- **`decoder_step`:**
  - 입력: `input_embeds` `[1,1,H]`, `position_ids` `[1,1]`, `past_keys`/`past_values` `[28,1,8,P,128]`
  - 출력: `logits` `[1,1,V]`, present KV
  - 마스크는 넣지 않는다.
- **`encoder`:** 입력 `mel` `[1,128,T]`, 출력 `audio_features`. A는 출력 모양에서 읽고, 공식으로 따로 계산하지 않는다.

**특징 추출 (`log_mel`, numpy만)**

- WhisperFeatureExtractor와 같게 만든다:
  - 16kHz, `n_fft` 400, hop 160, periodic Hann, center reflect padding, 파워 스펙트럼
  - Slaney mel 128개(0–8kHz, `norm="slaney"`, `mel_scale="slaney"`)
  - `log10(max(x, 1e-10))` → `max − 8`로 자르기 → `(x + 4) / 4` → 마지막 프레임 버림
  - 30초 채우기는 하지 않는다(mlx-audio가 `padding=True, truncation=False`로 부른다)
- 약 40줄이다. transformers·librosa·torch를 Windows 의존성에 넣지 않는다.
- `kaldi-native-fbank`의 `OnlineWhisperFbank`는 기본값(dim 80, dither, povey 창)이 달라 쓰지 않는다.

**세션**

- `onnxruntime.InferenceSession(path, providers=["CPUExecutionProvider"])` 셋을 만든다.
- 스레드 수는 기본값(물리 코어)으로 두고, 측정에서 바꿔 본다(4/8/기본). 고정값은 측정 뒤 정한다.
- VAD 세션은 `intra_op`·`inter_op` 스레드를 1로 둔다. 512표본 창마다 부르는 작은 그래프라 스레드를 늘리면 오히려 느리다(Silero 공식 래퍼와 같다).

**구현에서 실제로 확인한 것 (1번 PR, 2026-11-19)**

받은 판: `andrewleech/qwen3-asr-0.6b-onnx` @ `4fc24a14…`(2.1절의 7개 파일), `istupakov/silero-vad-onnx` @ `b3e3ee3c…`. onnxruntime 1.32.0(Mac arm64 CPU)으로 그래프를 열어 이름·모양을 읽었다. 3.3절·5절의 계약과 **모두 같았다.**

| 그래프 | 입력 | 출력 |
| --- | --- | --- |
| `encoder.int4.onnx` | `mel` f32 `[1,128,time]` | `audio_features` `[1,u1,1024]` |
| `decoder_init.int4.onnx` | `input_ids`·`position_ids` i64 `[batch,seq_len]`, `audio_features` f32 `[batch,audio_len,1024]`, `audio_offset` i64 `[1]` | `logits` `[batch,seq_len,151936]`, `present_keys`·`present_values` `[28,batch,8,seq_len,128]` |
| `decoder_step.int4.onnx` | `input_embeds` f32 `[batch,1,1024]`, `position_ids` i64 `[batch,1]`, `past_keys`·`past_values` `[28,batch,8,past_seq_len,128]` | `logits` `[batch,1,151936]`, present KV (`past_seq_len + 1`) |
| `silero_vad_16k_op15.onnx` | `input` f32 `[batch,sequence]`, `state` f32 `[2,batch,128]`, `sr` i64 스칼라 | `output` `[batch,1]`, `stateN` |

- **토크나이저:** `<asr_text>`(151704)는 추가 토큰이지만 `special: false`다. 그래서 `decode(skip_special_tokens=True)`가 지우지 않고, 자동 감지 출력을 `parse_language`로 나눌 수 있다. 오디오 패드(151676)·`<|im_end|>`(151645)·`<|endoftext|>`(151643)는 special이다.
- **프롬프트 토큰 ID:** mlx-audio는 `AutoTokenizer.encode(prompt)`(기본 `add_special_tokens=True`)로 부르지만 Qwen 토크나이저는 아무것도 덧붙이지 않아, `tokenizers`로 `add_special_tokens=False`한 결과와 ID가 같다. 0.4초(1초로 채움)·5.3초(한국어 고정 + 단어 3개)·30초(자동 감지 + 단어 1개)에서 같았고, 인코더 출력 길이 A도 mlx-audio가 셈한 오디오 토큰 수와 같았다. 첫 세 ID는 `151644, 8948, 198`(`<|im_start|>`·`system`·`\n`)이다(`test_real_prompt_token_ids_and_audio_length_match_mlx_audio`).
- **특징 추출:** `log_mel`(numpy 약 15줄)과 `WhisperFeatureExtractor`(transformers 5.18)의 최대 차이가 5·31·1·0.37초 임의 음성에서 6.7e-8이었다.
- **VAD:** 가상 음성 12.4초(문장 사이 1초 무음)에서 ONNX와 MLX 확률의 최대 차이 2.6e-6, 발화 구간 5개가 표본 단위로 같았다. 388창에 0.03초.
- **mlx-audio 쪽 이름:** `_build_prompt`·`extract_language`·`_preprocess_audio`는 `mlx_audio.stt.models.qwen3_asr.qwen3_asr.Qwen3ASRModel`에 있다(`Model`은 이것을 감싼 껍데기라 클래스 속성으로는 찾을 수 없다). CI 시험이 이 함수들을 직접 불러 고정 문자열과 대조한다(Mac).
- **온도 표본:** `pick`은 `argmax(logits/T + Gumbel)`이다. mlx `categorical_sampling`과 같은 분포(softmax(logits/T))다.
- **받기 주의:** `hf download … --include …`가 한 번 `encoder.int4.onnx`를 빠뜨렸다(다른 작업이 같은 폴더에 동시에 받던 중이었고, 이 파일은 `encoder.onnx`와 내용이 같다). 받은 뒤 7개 파일이 모두 있는지 본다. 등록(5번 PR) 뒤에는 `models download`가 파일 목록·크기로 확인한다.
- **가상 음성:** `say -v Yuna` 6.6초("안녕하세요. 오늘 회의는 다음 분기 예산 검토입니다. 먼저 인건비부터 보겠습니다.")를 `Transcriber`로 받아 적으면 자동 감지·한국어 고정 + 단어 모두 문장부호만 다르게 맞았다(`repaired` 없음).

### 3.4 안전장치가 그대로 먹는지 대조

| 안전장치 (Mac) | 위치 | ONNX 경로에서 |
| --- | --- | --- |
| 자동 감지 기본(`language=None`) | `pipeline`·`_lang_arg` | 그대로. ko/en → `Korean`/`English` |
| 자동 감지가 빈 글 → 한국어로 다시 | `_transcribe` | 그대로. `parse_language`가 빈 본문을 돌려줘야 한다 |
| 5초 미만 + zh/ja 감지 → 한국어로 다시 | `_transcribe` (`misdetect_retry`) | 그대로. `Output.language`가 `Chinese`/`Japanese`를 낸다(`_lang_code`는 문자열·목록 둘 다 받는다) |
| 토큰 상한 `ceil(dur×16)+32` | `max_tokens_for`·`_capped` | 고리가 `max_tokens`에서 멈추고 `generation_tokens`가 정직하다 → 상한 도달 = 루프 판정 |
| 언어 고정 루프 → 자동 감지 → 접기 | `_transcribe` | 그대로. 단 이 재시도는 지금 자른 `hw`가 아니라 **전체 `hotwords`**를 넘긴다(asr.py:198). 50개 상한·1초 규칙을 건너뛰고, 파이프라인의 목록에는 상한이 없다(참석자 + `--term` + 사전 전체 + 노트 낱말). ONNX에서는 `decoder_init` logits가 프롬프트 토큰마다 약 0.6MB라 큰 사전이면 GB 단위로 메모리가 는다. `hw`로 바꾸는 것은 Mac hotwords 규칙 변경이라 소유자 결정(면제 또는 A/B)으로 넘긴다(11절 7번). 어댑터에서 따로 자르지 않는다(Mac과 갈리지 않게) |
| 루프 → 온도 0.3 한 번 → 접기 | `_transcribe` | `pick`이 온도 표본 추출을 지원한다 |
| 자주 쓰는 단어: 앞 50개, 1초 이상 청크만, 순서 유지 | `_transcribe`·`pipeline` | 그대로(위 행의 예외 하나). 시스템 프롬프트에 실제로 들어간다(시험으로 고정) |
| 목록을 받아 적으면 단어 없이 다시 | `echoes_hotwords` | 그대로 |
| ITN(`itn.korean_numbers`) | `Transcriber.transcribe` | 그대로. 순수 `re`라 Windows에서 돈다 |
| `words: null` | `store` | Windows 목록에는 단어 정렬기가 없다 → 정렬 단계를 건너뛰고(4.3절) `words`는 null. 단어를 지어내지 않는다 |
| 모델 내리기 | `pipeline._free_mlx` | `import mlx.core`를 `try … except ImportError`로 감싼다(W2, PR #128에서 이미 들어갔다). MLX가 없으면 그냥 돌아간다. Mac 동작은 같다 |

### 3.5 그 밖의 코어 변경

- **`pipeline._free_mlx`** (`:152-159`): 위 가드. 호출 네 곳(`:202` `_diarize` 안, `:294`, `:410`, `:420`)은 고치지 않는다.
- **`store.build_transcript`** (`:289`, `"runtime": "mlx-audio"`가 박힌 곳은 `:316`): 이 함수는 세 곳이 부른다(`write_transcript`, `deferred.finish_convert` deferred.py:172, `attach.finish_append` attach.py:135). 그래서 인자를 더하지 않고 **함수 안에서 `job.model`(=저장소)로 정한다**: `"onnxruntime" if job.model in registry.ONNX_REPOS else "mlx-audio"`. `ONNX_REPOS`는 레지스트리가 `_windows_models()`의 변환 엔진 저장소로 만든다(ASR 저장소의 원본은 레지스트리). store는 레지스트리를 함수 안에서 늦게 불러온다(레지스트리가 align·diarize 등을 import하므로 모듈 머리에서 부르지 않는다). `Job`·`write_transcript` 시그니처는 그대로다. 시험은 새 노트·`--into`·`--append-to` 세 경로를 본다.
- **onnxruntime을 불러오지 못할 때**(DLL·VC++ 런타임 문제, 휠 누락): `vad.find_chunks`는 `_new_job`에서 try 없이 ASR보다 먼저 돈다(pipeline.py:292). `_new_job`의 이 호출과 `_run`의 모델 올리기에서 잡아 `common.fail(..., code="runtime_missing")`로 끝낸다. 문구는 WORDS.md·`i18n_en.json`·앱 `lib.ts` `ERROR_TEXT`에 한 줄씩. `tractus doctor`의 Windows 갈래에 onnxruntime import 점검을 더한다(의존성이 들어오는 4번 PR).
  - **구현(1번 PR):** 모든 `ImportError`가 아니라 `asr.RuntimeMissing`(`ImportError`의 하위 클래스)만 잡는다. `asr_onnx.ort()`가 onnxruntime import 실패를 이것으로 바꾼다. 그래야 Mac에서 직접 추가한 엔진이 mlx-audio 안에서 내는 `ImportError`는 지금처럼 `model_load_failed`로 남는다. 클래스는 `asr.py`에 둔다: 파이프라인이 numpy를 부르는 `asr_onnx`를 CLI 시작 때 불러오지 않게(`test_cli_starts_without_heavy_libraries`).
- **`commands/engines.py`**: 고치지 않는다. Windows 항목이 같은 ID(`asr-std`·`asr-lite`·`vad`)를 쓰므로 `MODELS`·`TRACK_MODEL`·`VAD_MODEL`·`auto_track`이 그대로 맞는다(4절).
- **`live.py`**: 고치지 않는다. Windows에서는 `live` 기능 잠금으로 막는다.

## 4. 모델 목록(`models_registry`) 변경

### 4.1 같은 ID, 플랫폼별 항목

Windows의 목록은 Mac 항목을 갈아 끼운 다른 튜플이다. 고르는 곳은 한 군데이고, import 때 `MODELS`로 계산되는 `CAPABILITIES`(convert의 엔진 묶음)·`_BY_ID`도 같은 결과에서 만든다.

```python
MODELS = _windows_models() if platform_compat.WINDOWS else _mac_models()   # 시험은 두 함수를 직접 부른다
CAPABILITIES = _capabilities(MODELS)
_BY_ID = {m.id: m for m in MODELS}
ONNX_REPOS = frozenset(m.repo for m in _windows_models() if m.engine)
```

| ID | Mac (그대로) | Windows |
| --- | --- | --- |
| `vad` | `mlx-community/silero-vad-v6` | `istupakov/silero-vad-onnx` @ `b3e3ee3c…`, `silero_vad_16k_op15.onnx` 1,289,603 B, 폴더 `silero-vad-v6-onnx`, MIT |
| `asr-std` | `mlx-community/Qwen3-ASR-1.7B-8bit` | `andrewleech/qwen3-asr-1.7b-onnx` @ `df916193…`, 2.1절 파일, 폴더 `qwen3-asr-1.7b-onnx-int4`, `engine="qwen3"`, `level_note=ONE_OF` |
| `asr-lite` | `mlx-community/Qwen3-ASR-0.6B-8bit` | `andrewleech/qwen3-asr-0.6b-onnx` @ `4fc24a14…`, 폴더 `qwen3-asr-0.6b-onnx-int4`, `engine="qwen3"`, `level_note=ONE_OF` |
| `asr-ko-mix`·`asr-ko-univa`·`diarizer`·`fluid`·`aligner`·`embedding`·`voices` | 그대로 | **없음** (미리보기 범위 밖, 4.3절) |

**같은 ID를 쓰는 이유:** 아래 것들이 고치지 않고 그대로 맞는다.

- `engines.py`, `pick_asr`·`preferred_asr`·`preset_ids`(asr-std/asr-lite를 박아 둠)
- `capability_status`의 `"asr-std" in group` 가정
- 앱 설정 `asr_engine`, 앱 TS 타입
- `models list --json` 키 집합(`tests/test_models.py:576`)

`local_dir`·`repo`는 Mac과 다르다. `asr.model`(저장소)만 보아도 어느 런타임으로 변환했는지 알 수 있다. 플랫폼 칸을 `Model`에 더하지 않으므로 JSON 키도 늘지 않는다.

- **`level`/`ONE_OF`:** Windows 변환 엔진도 둘이고, `required` + `one_of`(`필수 (둘 중 하나)`) 의미가 그대로다. `vad`는 `required`다.
- **`files`:** 2.1절 표 그대로이고, 하위 폴더는 없다. `_inspect_files`가 크기를 대조한다. 받기는 `snapshot_download(allow_patterns=list(m.files))`라 파일 종류와 상관없이 그대로 돈다.
- **`usable`** (`:366-374`): 고친다. 대체 갈래는 `config.json`이 있고 `model.safetensors`가 없고 받다 만 파일이 없으면 True다. ONNX 폴더에는 `model.safetensors`가 원래 없으므로, `config.json`만 있고 `decoder_weights.int4.data`가 빠진 폴더도 쓸 수 있다고 본다. 그러면 `engines.local_model`(engines.py:47)이 통과시키고 `model_missing` 대신 ORT 세션 오류로 끝난다. 대체 갈래에 `"model.safetensors" in m.files` 조건을 더한다. 지금 Mac의 hf 항목은 모두 `files`에 `model.safetensors`가 있어 Mac 동작은 같다.
- **`models prune`:** `unregistered`의 "알려진 폴더"를 두 목록(`_mac_models()`·`_windows_models()`)의 `local_dir` 합집합으로 만든다. 그래야 두 운영체제가 모델 폴더를 함께 써도 서로의 폴더를 지우지 않는다. 등록 전(5번 PR 전) Mac의 개발용 ONNX 폴더는 여전히 지워진다(7절 경고).
- **`install_hint`:** `registry.install_hint`가 저장소·리비전에서 문구를 만들므로 그대로다.
- **소개 문구:** `asr-lite`의 Mac 설명("실시간 텍스트 변환에는 이 엔진이 따로 필요합니다")은 Windows에서 틀린 말이 된다. Windows 항목은 그 문장을 뺀 설명을 쓴다.
- **`NEEDED_FILES`·`add_custom`:** 고치지 않는다(직접 추가는 비목표). Windows에서는 `custom_models()`가 `()`를 돌려주고, `models add`가 `unsupported_platform`으로 거절한다(종료 코드 2).
- **메모리 판정:** Windows `physical_memory()`는 `GlobalMemoryStatusEx.ullTotalPhys`(platform_compat.py:96-110)다. 하드웨어 예약분·내장 GPU 몫을 뺀 값이라 "16GB" 노트북에서 16GiB보다 작게 나오고, `preferred_asr`(`STANDARD_MIN_MEMORY = 16 GiB`)가 늘 0.6B를 고른다. `platform_compat`의 Windows 갈래를 `GetPhysicallyInstalledSystemMemory`(설치된 용량)로 바꾼다. Mac은 그대로다. 기준 기기의 두 값을 8.4절 측정에 적는다.
- **새 문구와 번역:** 위 Windows 설명, `unsupported_platform`, `runtime_missing`, 4.2절 `platform` 이유, 4.3절 경고는 모두 `t()`로 쓰고 영어를 더한다. 코어는 `src/tractus/i18n_en.json`, 앱은 `app/src/en/*.ts`와 `lib.ts` `ERROR_TEXT`. 확인은 `tests/test_i18n.py`, `app/src/i18n.test.ts`, `scripts/check_words.sh`(출력 없음).

### 4.2 기능 잠금

- 실제 기능 ID는 `record`·`convert`·`diarize`·`diarize-many`·`align`·`smart-search`·`live`·`voices`다(models_registry.py:168-177).
- **규칙:** `capability_status`는 기능이 요구하는 모델 ID가 등록 목록(`_BY_ID`)에 없으면 `missing=["platform"]`을 넣는다. Windows 기능 목록을 따로 적지 않으므로 플랫폼 판별은 목록 고르기 한 곳에 남는다. Windows에서 `diarize`·`diarize-many`·`align`·`smart-search`·`voices`가 이렇게 잠긴다.
- **`live`는 예외다.** 요구 모델(`vad`·`asr-lite`)이 Windows 목록에도 있어 위 규칙으로는 잠기지 않는다. `Capability`에 `mac_only=True`를 달고, Windows면 `"platform"`을 넣는다. 0.6B로 확정 지연을 잰 뒤에 연다.
- **`fix_command("platform")`:** 지금은 `tractus models download platform`이라는 없는 명령으로 떨어진다. `platform`이면 이유 문구("Windows 미리보기에서는 아직 쓸 수 없습니다" 등, WORDS.md)를 돌려준다. 앱은 "모델 화면 열기" 대신 이유를 보인다(README W5). 새 `missing` 값이므로 앱 `lib.ts`·WORDS.md·docs/desktop.md 표를 함께 고친다.
- **`convert`:** `(vad,)` + `engine`이 있는 모델이고, 그대로다. 필수 모델(VAD + 변환 엔진 하나)과 ffmpeg만으로 변환 → 요약이 돌아야 한다는 규칙도 Windows에서 그대로 지킨다.
- 시험은 `_BY_ID`를 Windows 목록으로 바꿔 끼우고 `capability_status`를 부른다.

### 4.3 파이프라인: 목록에 없는 단계는 건너뛴다

지금 코드는 모델이 없을 때 `registry.install_hint(id)`로 안내를 만들고, `get()`은 등록되지 않은 ID에 `KeyError`를 낸다(models_registry.py:221-227). Windows 목록에서 `diarizer`·`aligner`를 빼면:

- `transcribe`는 화자 분리가 기본이다(`--no-diarize` 기본 False). `_diarize`에서 `load_diarizer`가 None을 돌려주면 `diarizer_missing` 안내(pipeline.py:193)가 try 밖에서 `KeyError`를 내 **VAD 직후 변환이 죽는다.**
- 단어 싱크는 `aligner_hint()`(pipeline.py:229)가 try 안이라 잡히지만, 경고가 `aligner_missing`이 아니라 `aligner_failed: 'aligner'`가 된다.

그래서 파이프라인이 모델을 찾기 전에 가른다.

- `_new_job`·`_run`에서 `registry.find("diarizer")`·`find("voices")`·`find("aligner")`가 None인 단계는 부르지 않는다(`_diarize`·`_suggest_voices`·`_align`).
- 건너뛴 단계를 묶어 경고 하나(`platform`)를 낸다. 화자 없이, `words: null`로 저장한다.
- `install_hint`가 없는 ID를 받게 하지는 않는다. 오류를 숨길 뿐이다.
- 잠긴 기능의 CLI 명령(`align`·`voices enroll|match`)도 같은 검사로 `common.fail(code="platform", exit_code=2)`한다.
- 시험: `_windows_models()`로 바꿔 끼우고 diarizer·aligner 폴더 없이 `transcribe`를 돌리면 종료 코드 0, 경고 코드는 `platform` 하나다.

## 5. Windows의 VAD (Silero ONNX)

VAD는 필수 모델이다. 지금 `vad.find_chunks`는 `mlx_audio.vad`를 부르므로 Windows에서 바로 죽는다.

- **모델:** `istupakov/silero-vad-onnx` @ `b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6`, `silero_vad_16k_op15.onnx`
  - 1,289,603 B, sha256 `7ed98ddb…2c49`, MIT, Silero v6.2
  - 16k 전용이고 연산이 단순하다. Mac의 MLX판은 `silero_vad PyPI 6.2.1`에서 옮긴 것이다.
- **새 모듈 `src/tractus/vad_onnx.py`:**
  - `speech_timestamps(audio, session) -> [(start, end)]`(표본 단위). 세션을 받으므로 가짜 세션으로 시험한다.
  - mlx-audio `_predict_proba_array`(silero_vad.py 270–315행)를 그대로 옮긴다:
    - 끝을 512의 배수로 0 채움
    - 문맥은 64개의 0으로 시작하고, 창마다 `input = concat(context[64], frame[512])`(576표본)
    - `state` `[2,1,128]`을 이어 받고, `sr = 16000`(i64 스칼라)
    - 출력은 `output`(확률)과 `stateN`이다.
- **확률 → 구간:** mlx-audio `_probs_to_timestamps`(361–430행)를 numpy로 옮긴다. Windows에서는 mlx를 import하지 않고는 그 함수를 부를 수 없다. 값은 MLX 모델 `config.json`과 같다.
  - `threshold` 0.5, `neg_threshold = max(threshold − 0.15, 0.01)` = 0.35
  - `min_speech_duration_ms` 250, `min_silence_duration_ms` 100, `speech_pad_ms` 30
  - 마지막 구간 끝은 `min(audio_len, len(probs) × 512)`, 패딩 뒤 끝은 `min(audio_len, end + pad)`로 자른다.
- **`vad.find_chunks`:** 폴더에 `silero_vad_16k_op15.onnx`가 있으면 `vad_onnx`, 없으면 MLX로 간다(ASR과 같은 폴더 판별). `merge`(30초 묶기)는 그대로 공유한다.
- **경계 차이 확인:** 발화 표본 일치율만으로는 30초 묶기가 바뀐 뒤 CER 변화를 막지 못한다. 그래서 8절에서 **같은 ASR에 MLX VAD 청크와 ONNX VAD 청크를 넣은 AI Hub 4세션 CER 차이**를 필수 기준으로 잰다.

## 6. 의존성·번들

### 6.1 `pyproject.toml`

```toml
dependencies = [
    ...
    "huggingface-hub>=1.33.0",  # 지금은 mlx-audio를 거쳐서만 들어온다. W5에서 mlx-audio에 darwin 표지를 달아도
    "numpy>=2.5.3",             # Windows의 모델 받기(models_install)·변환·VAD가 깨지지 않게 직접 의존성으로 올린다
    "tokenizers>=0.23.2",       # (세 판 모두 지금 잠금의 판이라 Mac 번들은 바뀌지 않는다)
    "onnxruntime>=1.32; sys_platform == 'win32'",   # Windows 변환·VAD 전용. macOS 번들은 onnx_mlx 그대로 (v3.99)
]
```

- win32 표지는 `onnxruntime`에만 단다. 세 패키지는 지금 `mlx-audio`·`transformers`의 전이 의존성으로만 들어온다(uv.lock).
- `mlx-audio`·`mlx-lm`에 `sys_platform == 'darwin'` 표지를 다는 일은 Windows 번들 PR(W5)에서 한다. 지금 Windows CI는 mlx를 설치만 하고(mlx 0.32.3에 win_amd64 휠이 있다) import하지 않으면 되고, 이 설계의 코드는 mlx를 import하지 않는다.
- **잠금:** 로컬 uv(0.9.7)가 `uv.lock`(revision 5)보다 오래되었다. 먼저 `uv self update`를 하고 `uv lock`을 돌린다. 옛 uv로 다시 잠그면 revision 3으로 내려가고 `resolution-markers`가 쓸데없이 바뀐다.
- **확인:** `uv export --frozen --no-dev --no-emit-project | grep -i onnx`에 `win32` 표지가 붙은 줄만 나와야 한다(`onnxruntime==1.32.0 ; sys_platform == 'win32'`, `flatbuffers` 같음).

### 6.2 macOS 번들 영향: 없음

- `build_app_bundle.sh`는 `uv export` 결과를 번들 파이썬(macOS)으로 `uv pip install --only-binary :all: --no-deps --require-hashes` 한다. 표지가 거짓이라 설치하지 않는다. 시험 복사본에서 68개 패키지에 onnxruntime·flatbuffers가 없음을 확인했다.
- `bundle_slim.py`는 설치하지 않으므로 영향이 없다. `bundle_trace.py`를 다시 돌리면 `tractus/asr_onnx`·`vad_onnx` 줄만 늘 수 있다(tractus는 통째로 설치되므로 상관없다).
  - `uv.lock` 변경 규칙에 따라 목록은 다시 만들어 본다. PR에는 "win32 전용, 목록 그대로"라고 적는다.
  - 벤치용 의존성 뒤에 `bundle_trace`를 돌리지 않는다. 측정은 `uv run --with onnxruntime==1.32.0`으로 하고 `.venv`를 깨끗하게 둔다.
- 검증:
  1. 저장소 복사본에서 번들을 만든다.
  2. `find Tractus.app -iname '*onnxruntime*'`가 비어야 한다.
  3. DMG 크기를 0.5.9와 비교한다.
- **CLAUDE.md·ARCHITECTURE.md:**
  - 목소리 프로필 절의 "`onnxruntime`·`sherpa-onnx`를 다시 넣지 않는다"에 "(macOS. Windows 변환·VAD는 win32 표지로 onnxruntime을 쓴다, docs/design/asr-onnx.md)"를 붙인다.
  - "mlx-audio를 올리면 `pytest -m slow tests/test_asr_onnx.py`를 돌린다"를 ASR 절에 더한다(7절).
  - ARCHITECTURE.md에 새 행을 남긴다(v3.99 결정의 Windows 예외, Mac 번들 크기 전후).
  - docs/windows/README.md W4의 onnxruntime 항목에 표시한다.

### 6.3 라이선스

- 새로 들어오는 것:
  - onnxruntime(MIT), flatbuffers(Apache-2.0)
  - protobuf(BSD-3)·packaging은 이미 있다
  - tokenizers(Apache-2.0, 이미 설치되어 있고 직접 의존성으로만 올림)
- 모델: andrewleech(Apache-2.0), Silero ONNX(MIT)
- **빈틈:** `check_licenses.py --only py`는 설치된 패키지만 읽고 macOS CI에서만 돈다. 그래서 win32 전용 의존성을 보지 못한다. `windows-core.yml`에 `uv run python scripts/check_licenses.py --only py`를 **`continue-on-error`가 없는 별도 단계**로 더한다.
- Windows 번들은 wheel만 쓴다. onnxruntime 1.32는 cp311–cp314 win_amd64 wheel이 있다(설치 크기 50.5MB).

## 7. 시험

가중치와 onnxruntime 없이 도는 것이 기본이다. 실제 모델·실제 그래프는 `slow`로만 돌린다.

| 파일 | 내용 | 어디서 |
| --- | --- | --- |
| `tests/test_asr.py` (그대로) | `mlx.core` import가 갈래 안으로 옮겨져 Windows에서 통과한다. windows-core 필수 단계에 넣는다 | 모두 |
| `tests/test_asr.py` (더함) | `Transcriber.load` 판별: 표지 파일이 있는 폴더 → `OnnxQwen3ASR.load`(가짜로 바꿔 끼움). 없으면 mlx 갈래. ONNX 폴더 + 다른 계열 → `ValueError` | 모두 |
| `tests/test_asr_onnx.py` (새로) | `decode`에 가짜 `run`(정해 둔 logits)·가짜 토크나이저를 넘겨 본다. ① `max_tokens`에서 멈추고 `generation_tokens`가 맞다 ② EOS에서 멈추고 EOS는 세지 않는다 ③ 온도 0은 argmax, 0.3은 시드 고정 rng로 표본 추출 ④ `parse_language`(`language Korean<asr_text>…`, 표지 없으면 `English`, 빈 본문) ⑤ `build_prompt`에 자주 쓰는 단어가 `", "`로 들어가고 빈 목록이면 시스템 칸이 빈다 ⑥ 1초 미만 오디오 채우기 ⑦ `audio_offset`이 첫 `audio_pad` 위치다 | 모두 |
| 같은 파일 (mlx-audio 고정 문자열) | `build_prompt`가 내는 **문자열**과 `parse_language` 사례를 mlx-audio 0.5.7(`qwen3_asr.py` 903–933행)에서 옮긴 리터럴과 대조한다. Dependabot이 mlx-audio를 올려 프롬프트가 바뀌면 slow 시험을 돌리라는 신호다(6.2절 CLAUDE.md 줄) | 모두 |
| 같은 파일 (Mac 대조) | `pytest.importorskip("transformers")`: `log_mel`과 `WhisperFeatureExtractor`(128 bins, `padding=True, truncation=False`)가 임의 음성 5초·31초에서 같다(`atol 1e-4`, 모양 `(1,128,500)`·`(1,128,3100)`) | Mac (Windows는 transformers가 없으면 건너뜀) |
| 같은 파일 (`slow`) | 모델 폴더가 있을 때 mlx-audio `_build_prompt`와 `build_prompt` + `tokenizers`의 **토큰 ID가 같다**(자주 쓰는 단어 + 한국어 고정, 자동 감지). 실제 0.6B ONNX로 가상 `say` 음성을 받아 적는다 | Mac `uv run --with onnxruntime==1.32.0 pytest -m slow tests/test_asr_onnx.py` |
| `tests/test_vad_onnx.py` (새로) | ① 순수 함수: 가짜 확률열 → 구간(임계값·최소 발화·최소 무음·패딩·끝 자르기) ② 가짜 세션(`run`이 받은 `input` 모양을 기록하고 `stateN = state + 1`을 돌려줌)으로 창 나누기·문맥 64·상태 이어받기·**길이가 512의 배수가 아닌 입력**의 꼬리 채우기 ③ `vad.find_chunks` 폴더 판별 ④ (`slow`) 실제 ONNX 그래프와 MLX판 확률 대조 | ①②③ 모두, ④ Mac `--with onnxruntime` |
| `tests/test_models.py` (더함) | `_windows_models()`: ID 집합 `{vad, asr-std, asr-lite}`, `ONE_OF` 집합, `convert` 묶음 = `asr_ids`, 파일 크기 합 = `size_bytes`. `_BY_ID`를 바꿔 끼워 `capability_status`: `diarize`·`align`·`smart-search`·`voices`·`live`가 `"platform"`. `config.json`만 있는 ONNX 폴더는 `usable`이 아니다. prune이 다른 플랫폼 폴더를 지우지 않는다. 기존 Mac 집합 시험은 `_mac_models()` 기준으로 그대로 | 모두 |
| `tests/test_pipeline*`·`test_cli.py` | `_free_mlx`가 mlx 없이 통과(`sys.modules`에 mlx가 없는 것처럼 바꿔 끼움). Windows 목록으로 `transcribe`가 끝까지 돌고 경고는 `platform` 하나(4.3절). `asr.runtime`이 새 노트·`--into`·`--append-to` 세 경로에서 저장소대로 쓰인다. onnxruntime import 실패 → `runtime_missing` | 모두 |

**CI**

- `ci.yml`(macOS)은 고치지 않는다. 새 시험은 onnxruntime 없이 돈다.
- `windows-core.yml`:
  - 반드시 통과할 단계에 `tests/test_asr.py tests/test_asr_onnx.py tests/test_vad_onnx.py tests/test_platform_compat.py`를 더한다.
  - 라이선스 검사를 별도 필수 단계로 더한다(6.3절, 의존성이 바뀌는 4번 PR).
  - 벤치 코드가 `tractus`를 부르므로 `paths`에 `bench/**`를 더한다.

**개발자가 Mac CPU에서 돌리기**

```bash
hf download andrewleech/qwen3-asr-0.6b-onnx --revision 4fc24a1402e74db89c4d2ef256875e71680128c4 \
  encoder.int4.onnx 'decoder_*.int4.onnx' decoder_weights.int4.data embed_tokens.bin tokenizer.json config.json \
  --local-dir models/qwen3-asr-0.6b-onnx-int4
uv run --with onnxruntime==1.32.0 pytest -m slow tests/test_asr_onnx.py
```

- 등록 전에는 앱·CLI가 ONNX 폴더를 고를 길이 없다. 개발 중 실제 변환은 `bench/run.py`와 `slow` 시험으로 한다.
- **주의:** 등록 전(5번 PR 전)에는 이 폴더가 등록되지 않은 모델 모양(`config.json`)이라 `tractus models prune`이 지운다. 받은 뒤에는 prune을 돌리지 않는다.

## 8. 측정 계획 (`bench/`)

### 8.1 벤치 코드 변경

- **같은 조건이 원칙이다.** 지금 MLX `qwen` 갈래는 `max_tokens` 없이 `generate`를 부른다(bench/asr.py:52, mlx-audio 기본 8192). 상한을 ONNX에만 걸면 루프가 짧게 잘려 ONNX의 CER·MER이 엉뚱한 이유로 좋아 보인다. 그래서 **두 갈래 모두** 제품과 같은 `asr.max_tokens_for(dur)`로 막고, MLX 기준선을 다시 잰다(8.2절).
- **반복 수는 한 정의로 센다:** "글에 루프가 있다(`score.repetitions`) 또는 상한에 닿았다". 두 런타임에 같게 적용하고 요약에 `cap: true`를 남겨 옛 행과 가른다.
- **`bench/asr.py`:**
  - 맨 위의 `import mlx.core`·`mlx_audio`를 쓰는 갈래 안으로 옮긴다.
  - `MODELS`에 `"qwen3-1.7b-onnx": ("qwen3-asr-1.7b-onnx-int4", "qwen-onnx")`, `"qwen3-0.6b-onnx": ("qwen3-asr-0.6b-onnx-int4", "qwen-onnx")`를 더한다.
  - `qwen-onnx` 갈래는 **제품 코드 `tractus.asr_onnx.OnnxQwen3ASR`를 그대로 부른다**(다른 벤치처럼 `sys.path`로 `tractus`를 불러옴). 따로 짠 디코더를 재지 않는다.
- **앱 경로 모드 `--app` (새로):** 제품 경로 `tractus.vad.find_chunks` + `tractus.asr.Transcriber.transcribe`를 두 런타임으로 돌린다. 기준선 모드(앱 재시도 없음)만으로는 빈 출력·오감지·온도 0.3·받아 적기 재시도와 토큰 상한이 ONNX의 `generation_tokens`·`language`로 실제 음성에서 먹는지 알 수 없어서다.
  - 낸다: ITN 뒤 CER, `repaired` 세그먼트 수, 재시도 종류별 횟수.
  - 재시도 횟수는 벤치가 `Transcriber._generate`를 감싸 인자로 센다(온도 > 0 → 루프 재시도, 자동 감지 뒤 `Korean` → 한국어 재시도, 단어 없이 다시 → 받아 적기). 제품 코드는 고치지 않는다.
  - `--vad <폴더>`로 VAD 폴더를 따로 고른다. 같은 ASR에 MLX VAD·ONNX VAD를 넣어 VAD만의 CER 차이를 본다(5절).
- **`bench/run.py`:**
  - `import mlx.core`·`resource`를 늦게 불러온다(Windows에는 `resource`가 없다).
  - 메모리 키는 지금의 `max_rss_gb`(run.py:114) 하나를 그대로 쓴다. Windows에서는 같은 키에 `ctypes`로 읽은 `GetProcessMemoryInfo().PeakWorkingSetSize`를 넣는다. `peak_mlx_gb`는 mlx를 불러왔을 때만 낸다.
  - `runtime`(`mlx`/`onnxruntime`), `ort_version`, `threads`, `cpu`(모델명·코어·RAM·전원), `cap` 칸을 요약에 더한다.
- **`bench/pyproject.toml`:** Windows에서 torch를 끌어오는 것은 `silero-vad>=6.2.3`(torch·torchaudio 의존)이다. 여기에만 `sys_platform == 'darwin'` 표지를 단다. `mlx-audio`는 그대로 둔다(Windows에서 설치만 되고 import하지 않는다. bench의 `tokenizers`가 mlx-audio를 거쳐 들어오므로 표지를 달면 `tractus.asr_onnx`가 깨진다). onnxruntime은 `uv run --with onnxruntime==1.32.0`으로 넣는다(벤치 잠금에 넣지 않음).
- **VAD 청크:** 기준선 모드의 ASR 측정은 지금처럼 torch-Silero 캐시(`bench/vad.py`)의 같은 청크를 쓴다. Windows에서는 Mac에서 만든 `bench/cache`(경계만, gitignore)를 복사해 쓴다. torch를 Windows에 깔지 않는다.
- **`bench/vad_compare.py` (새로):** 같은 음성에서 MLX VAD와 ONNX VAD의 발화 표본 일치율·청크 수 차이를 지표만 낸다(Mac에서 실행).

### 8.2 무엇을 재나

| 세트 | 지표 | 조건 |
| --- | --- | --- |
| FLEURS 한국어 | CER | `--lang fixed`, `--lang auto` |
| HiKE (한·영 혼용) | MER(PIER 포함), loops | `--lang fixed`, `--lang auto` |
| AI Hub 회의 4세션(로컬, 지표만) | CER, cer_pron, 반복·빈 출력 수, 용어 재현율 | `--lang fixed/auto` × `--glossary` 있음/없음 |
| AI Hub 4세션 `--app` | ITN 뒤 CER, `repaired` 수, 재시도 종류별 횟수 | 자동 감지 + 사전, 두 런타임 |
| AI Hub 4세션 `--app --vad` | 같은 ASR에서 MLX VAD 대 ONNX VAD의 CER 차이 | 1.7B 하나 |
| 메모리 최악 경우 | `max_rss_gb` | 30초 청크, 언어 고정, 사전 50개 이상(3.4절 루프 재시도 경로 포함) |
| 속도·메모리 | RTF, `load_s`, `max_rss_gb`, 첫 실행 시간(Defender 포함) | 1.7B·0.6B, 스레드 4·8·기본 |
| VAD | 발화 표본 일치율, 청크 수 차이 | `vad_compare.py` |

**같은 조건으로 다시 재는 MLX 8bit 기준선(2번 PR).** 위 표의 모든 조건을 두 크기 모두 같은 토큰 상한으로 다시 잰다. 지금 `bench/results/summary.jsonl`에 있는 값(상한 없음)은 참고로만 쓴다.

| 엔진 (상한 없는 옛 값) | AI Hub CER fixed / auto / fixed+단어 | FLEURS CER fixed (auto 없음) | HiKE MER fixed / auto (loops) | 용어 재현율 없음 / 넣음 | RTF (M3) |
| --- | --- | --- | --- | --- | --- |
| 1.7B MLX 8bit | 9.49 / 9.48 / 9.36 | 2.62 | 28.3 (2) / 24.14 (1) | 71.6% / 84.2% | 0.136 |
| 0.6B MLX 8bit | 11.47 / 11.50 / 없음 | 3.92 | 87.56 (3) / 26.1 (1) | 65.3% / 없음 | 0.055 |

- 0.6B HiKE fixed 87.56은 상한 없는 루프 3개에서 나온 값이다. 상한을 걸면 크게 바뀐다.
- 비어 있는 행(FLEURS auto, 0.6B 사전 넣음)은 다시 잴 때 채운다.

### 8.3 통과 기준 (제안. 소유자가 확정)

모든 비교는 8.2절에서 **같은 상한·같은 조건으로 다시 잰 MLX 행**과 한다.

| 항목 | 기준 |
| --- | --- |
| AI Hub CER | 같은 크기·같은 조건 MLX 대비 **+1.0 이내** |
| FLEURS CER | 같은 조건 MLX 대비 +1.0 이내 |
| HiKE MER | 같은 조건 MLX 대비 +2.0 이내(표본이 작아 흔들림이 크다) |
| 용어 재현율(단어 넣음) | 같은 크기 MLX 대비 −3%p 이내. 자주 쓰는 단어가 실제로 먹는지 보는 유일한 지표다 |
| 반복·빈 출력 | 같은 정의(8.1절)로 같은 조건 MLX보다 많지 않다. HiKE는 MLX에도 루프가 있다(옛 값 1.7B fixed 2·auto 1, 0.6B fixed 3) |
| `--app` 재시도 | `repaired`·재시도 종류별 횟수가 MLX보다 뚜렷하게 많지 않다 |
| VAD | 같은 ASR에서 ONNX VAD 청크의 AI Hub CER이 MLX VAD 대비 **+0.2 이내**(필수). 표본 일치율 ≥ 99%·청크 수 차이 ≤ 2%는 참고 |
| 배치 RTF | **1.7B ≤ 0.5**, 기준 기기에서(소유자가 CPU 모델·코어·RAM·AC 전원·전원 계획을 정하고 `cpu` 칸에 남긴다) |
| 최대 메모리 | 1.7B ≤ 6GB, 8.2절 최악 경우 포함(16GB 기기에서 앱·브라우저와 함께 돌 수 있게) |

**1.7B가 기준 기기에서 RTF 0.5를 넘을 때:**

1. 디코딩 고리에 ORT `io_binding()` + `OrtValue`로 KV를 세션 안에 두고 다시 잰다(3.3절, 모델 그대로).
2. Windows 기본 엔진을 메모리와 상관없이 0.6B로 둔다(같은 기준을 0.6B로 통과해야 한다).
3. 병합 디코더 판을 같은 세트로 잰다.
4. 그래도 안 되면 소유자 결정으로 넘긴다(plan 7.5 #5).

### 8.4 어디서 재나

| Mac(Apple M3, ORT CPU arm64)에서 | Windows 기준 기기에서만 |
| --- | --- |
| 품질 전부: FLEURS·HiKE·AI Hub CER, 용어 재현율, 반복·빈 출력, `--app` 재시도(두 크기, 두 런타임). 품질은 런타임 계산이 같으면 기계와 거의 상관없다 | RTF, 최대 메모리(최악 경우 포함), 로드 시간, 첫 실행(Defender 검사) 시간, 스레드 수 |
| VAD 경계 비교와 VAD CER 차이(MLX와 ONNX를 한 기계에서) | x64 `MatMulNBits` 커널이 arm64와 같은 값을 내는지: FLEURS + AI Hub 1세션을 다시 재서 Mac ONNX와 CER 차이 ≤ 0.2 |
| 프롬프트 토큰 ID·mel 대조(시험) | 설치본에서 받기(4.1GB)·이어받기·경로 길이, `physical_memory()` 보고값(`ullTotalPhys`와 설치 용량) |

결과는 `bench/results/summary.jsonl`·`REPORT.md`(지표만)와 이 문서 "측정 결과" 절에 남긴다. AI Hub 전사는 커밋하지 않는다.

**x64 러너 측정 (`.github/workflows/windows-asr-bench.yml`, 2026-11-27).** 기준 기기 전에 x64 커널 값을 보려고 GitHub `windows-latest` 러너(공개 저장소 표준: 4 vCPU·16GB RAM)에서 int8 판(`550f7a71`)과 Silero ONNX(`b3e3ee3c`)를 돌린다. 수동 실행과 이 워크플로·`bench/` 측정 코드를 고치는 PR에서 돈다. 모델 4.4GB와 FLEURS 0.3GB는 리비전 세 개를 묶은 키 하나로 `actions/cache`에 두고(저장소 한도 10GB, 받자마자 저장해 측정이 실패해도 남긴다. PR에서 만든 캐시는 그 PR에서만 보여 PR마다 한 벌 생길 수 있다), 측정마다 `run.py`를 따로 띄워 최대 메모리(`PeakWorkingSetSize`)를 따로 잡는다. 재는 것은 넷이다: ① FLEURS every8(48개) 언어 고정 스레드 4 ② 같은 것 스레드 2 ③ 앱 경로(`--app --vad silero-vad-v6-onnx`) ④ 메모리 최악 경우 `fleurs30`(FLEURS 클립을 이은 27–30초 묶음 8개 + 사전 50개, `--glossary`, 앱 경로라 루프 재시도·받아 적기 안전장치를 지난다). ④는 Mac 기준값이 없는 참고값이다: Mac에서 짧은 클립 48개(every8)가 6.24GB로 30초 1묶음(앱 경로 4.11GB)보다 컸으므로, 메모리는 청크 길이보다 호출 수·누적을 따라 커질 수 있다. 6GB 판정은 ①과 ④ 가운데 큰 값으로 한다. `run.py --threads`는 제품이 정한 세션 스레드(VAD의 1)를 바꾸지 않는다. ①②의 CER을 Mac M3 int8 값 2.74와 비교해 차이 0.2 이하면 x64 커널이 같은 값을 낸다고 본다. `fleurs30`의 사전은 FLEURS 정답 낱말이라 CER은 품질 지표가 아니다. 결과는 잡 요약 표와 아티팩트 `windows-asr-bench`(이 잡이 더한 요약 줄만)로 나온다. 전사 원문은 올리지 않고, AI Hub는 쓰지 않는다(그래서 위 표의 "AI Hub 1세션" 대조는 러너에서 하지 않는다). 러너는 기준 기기가 아니므로 RTF·메모리는 대략값이고, 8.3절 판정은 실기기 측정이 맡는다.

### 8.5 측정 결과 (Mac, 2026-11-19)

**결론: 1.7B int4는 AI Hub 회의·FLEURS CER을 통과하지만 용어 재현율과 HiKE(언어 고정)에서 떨어진다. 0.6B int4는 모든 세트에서 기준을 넘지 못한다.** 그래서 지금 판(andrewleech int4)을 그대로 등록하지 않는다. 다음 단계는 11절 10·11번 결정이다.

**조건**

- 기계: Apple M3(4P+4E), 16GB. ONNX는 onnxruntime 1.32.0 CPU(arm64, 스레드는 ORT 기본), MLX는 mlx-audio 0.5.7 GPU 8bit다.
- 모델: `andrewleech/qwen3-asr-1.7b-onnx` @ `df916193`, `-0.6b-onnx` @ `4fc24a14`의 int4 판. MLX는 등록된 `qwen3-asr-1.7b-8bit`·`0.6b-8bit`다.
- 두 런타임 모두 제품과 같은 토큰 상한(`max_tokens_for`)을 걸었다(`cap: true`). 반복은 "글의 루프 + 상한 도달 청크"다(8.1절).
- **부분 표본이다.** 처음 FLEURS 10개 시험이 다른 작업과 겹쳐 ONNX RTF 1.06으로 나와서, 전체 세트를 두 런타임으로 재면 17시간이 넘는다고 보고 표본을 줄였다. 실제 RTF는 0.2–0.29였고, 남은 시간에 FLEURS 전체와 HiKE 전체(언어 고정)를 더 쟀다. 두 런타임은 언제나 같은 표본을 썼다.
  - AI Hub `head8m`·`head30m`: 4세션마다 앞 8분·30분(32.4분·120.3분). 앞 발화가 모두 끝난 빈틈에서 자르고 정답도 거기까지 줄였다(`run.py --minutes`). 사전은 세션 전체 그대로 넣었다.
  - AI Hub `head20m`(`--app`): 세션 DGBAH21000195의 앞 20분 하나.
  - FLEURS `every8`(48개, 10.2분)·`every1`(전체 382개, 80.1분), HiKE `every16`(71개, 8.5분)·`every1`(전체 1121개, 133.3분).
- 한 번에 측정 하나만 돌렸다. 다른 에이전트가 같은 기계를 썼다: 측정 시작 직전(17:33–17:36)에 CPU 부하 시험(`yes` 16개)이 돌았고, 측정 중(17:36–21:16)에는 1분마다 본 그런 부하가 없었다(load average 2–11). **RTF는 이 Mac의 참고값이다.** 속도·메모리 판정은 Windows 기준 기기에서 다시 잰다(8.4절).

**결과** (점수: AI Hub·FLEURS는 CER, HiKE는 MER(PIER). 낮을수록 좋다)

| 크기 | 세트 · 표본 | 조건 | MLX 8bit | ONNX int4 | 차이 | 반복 / 빈 출력 (MLX → ONNX) | 용어 재현율 (MLX → ONNX) | RTF (MLX / ONNX) | 최대 RSS (MLX / ONNX) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.7B | AI Hub head8m | 고정 | 8.77 | 9.13 | +0.36 | 0/0 → 0/0 | 10/11 → 10/11 | 0.130 / 0.274 | 1.43 / 5.60 GB |
| 1.7B | AI Hub head8m | 고정 + 사전 | 8.96 | 9.01 | +0.05 | 0/0 → 0/0 | 11/11 → 10/11 | 0.131 / 0.251 | 2.45 / 5.73 GB |
| 1.7B | AI Hub head30m | 고정 + 사전 | 8.89 | 9.31 | +0.42 | 0/0 → 0/0 | **28/31 (90.3%) → 25/31 (80.6%)** | 0.129 / 0.253 | 3.25 / 5.84 GB |
| 1.7B | FLEURS 전체 | 고정 | 2.62 | 3.31 | +0.69 | 빈 출력 0 → 0 | — | 0.103 / 0.192 | 2.93 / 5.94 GB |
| 1.7B | FLEURS 전체 | 자동 | 2.63 | 3.34 | +0.71 | 빈 출력 0 → 0 | — | 0.111 / 0.196 | 3.64 / 5.73 GB |
| 1.7B | FLEURS every8 | 고정 / 자동 | 2.74 / 2.74 | 3.68 / 3.73 | +0.94 / +0.99 | 0 → 0 | — | 0.11 / 0.21 | 3.63 / 5.07 GB |
| 1.7B | HiKE 전체 | 고정 | 26.19 (32.7) | 29.02 (42.9) | **+2.83** | 루프 2 → **6** | — | 0.121 / 0.199 | 4.05 / 5.31 GB |
| 1.7B | HiKE every16 | 고정 | 25.00 (27.3) | 49.76 (45.2) | **+24.76** | 루프 0 → **2** | — | 0.118 / 0.225 | 4.22 / 5.68 GB |
| 1.7B | HiKE every16 | 자동 | 24.98 (32.8) | 25.85 (35.6) | +0.87 | 루프 0 → 0 | — | 0.124 / 0.205 | 2.93 / 5.23 GB |
| 0.6B | AI Hub head8m | 고정 | 10.30 | 14.47 | **+4.17** | 0/0 → **1**/0 | 9/11 → 7/11 | 0.049 / 0.153 | 2.23 / 4.36 GB |
| 0.6B | AI Hub head8m | 고정 + 사전 | 10.45 | 13.28 | **+2.83** | 0/0 → **1**/0 | 9/11 → 9/11 | 0.049 / 0.151 | 2.24 / 4.22 GB |
| 0.6B | FLEURS every8 | 고정 | 4.06 | 5.24 | **+1.18** | 0 → 0 | — | 0.044 / 0.105 | 3.27 / 3.95 GB |
| 0.6B | FLEURS every8 | 자동 | 4.01 | 8.96 | **+4.95** | 0 → **1** | — | 0.046 / 0.103 | 3.45 / 3.95 GB |

**앱 경로(`--app`, 제품 VAD + `Transcriber`: 재시도·ITN 포함)와 VAD**

| 크기 | 세트 · 표본 | 조건 | ASR / VAD | CER·MER | 재시도 (repaired) | 용어 | RTF | 최대 RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1.7B | AI Hub head20m | 자동 + 사전 | MLX / MLX | 11.89 | 0 (0) | 2/2 | 0.147 | 2.75 GB |
| 1.7B | AI Hub head20m | 자동 + 사전 | MLX / **ONNX** | 11.89 | 0 (0) | 2/2 | 0.146 | 2.85 GB |
| 1.7B | AI Hub head20m | 자동 + 사전 | ONNX / ONNX | 11.71 | 0 (0) | 2/2 | 0.285 | 5.77 GB |
| 0.6B | AI Hub head20m | 자동 + 사전 | MLX / MLX | 12.80 | 0 (0) | 1/2 | 0.057 | 2.50 GB |
| 0.6B | AI Hub head20m | 자동 + 사전 | ONNX / ONNX | 15.97 | 온도 1 (1) | 1/2 | 0.165 | 4.30 GB |
| 1.7B | HiKE every16 | 고정 | MLX / MLX | 27.49 (32.5) | 0 (0) | — | 0.129 | 2.65 GB |
| 1.7B | HiKE every16 | 고정 | ONNX / ONNX | 31.66 (37.2) | 0 (0) | — | 0.198 | 5.39 GB |

- `vad_compare.py aihub`(4세션 전체 311.5분): MLX와 ONNX Silero의 발화 표본 일치율 **100.000%**, 발화 구간 수와 30초 청크 수(688 / 688)가 세션마다 같다. 같은 1.7B MLX ASR에 VAD만 바꾼 CER 차이는 **0.00**(11.89 / 11.89)이다.
- 재시도 세기는 실제로 먹는다: 0.6B ONNX에서 온도 0.3 재시도 1번이 잡혔다(`retries {"temp": 1}`).

**8.3절 기준 판정 (품질만. 속도·메모리는 Windows에서 다시 잰다)**

| 항목 | 1.7B | 0.6B |
| --- | --- | --- |
| AI Hub CER (+1.0 이내) | **통과**: +0.36 · +0.05 · +0.42, 앱 경로 −0.18 | **실패**: +4.17 · +2.83, 앱 경로 +3.17 |
| FLEURS CER (+1.0 이내) | **통과**: 전체 382개 고정 +0.69, 자동 +0.71(every8은 +0.94 · +0.99) | **실패**: +1.18 · +4.95(every8) |
| HiKE MER (+2.0 이내) | **실패**: 고정 전체 +2.83(PIER +10.2), every16 +24.76, 앱 경로 every16 +4.17. 자동 every16 +0.87은 통과 | 재지 않음 |
| 용어 재현율 (−3%p 이내) | **실패**: head30m −9.7%p(31번 중 3번 더 놓침). head8m은 −9.1%p(11번 중 1번). 표본이 작아 한 번이 3–9%p다 | 같음(9/11) |
| 반복·빈 출력 (MLX보다 많지 않음) | AI Hub·HiKE 자동은 0으로 같음(FLEURS는 summary에 반복 칸이 없고, 로컬 원문으로 본 루프·상한 도달은 12회 모두 0). **HiKE 고정 every16에서 루프 2**, 전체 1121개에서 2 → 6으로 **실패** | **실패**: AI Hub 루프 1, FLEURS 자동 빈 출력 1 |
| `--app` 재시도 | **통과**: 0 / 0 | 1 / 0 (온도 재시도 1번) |
| VAD CER 차이 (+0.2 이내, 필수) | **통과**: 0.00, 일치율 100%, 청크 수 차이 0% | (같은 VAD) |
| 최대 메모리 (6GB 이하, 참고) | 4.80–5.94GB. 최악 경우(사전 50개)는 재지 않았다 | 3.95–4.36GB |

**관찰**

- **ONNX가 틀리는 방식:** HiKE 고정의 루프 둘은 영어 발화에서 "세종대왕은 조선의 세종대왕으로, …"·"2008년 8월 20일에 …"처럼 음성에 없는 한국어를 지어내며 반복했다. 같은 클립에서 MLX는 정상이었다. 앱 경로에서는 VAD가 앞뒤를 다듬은 입력이라 루프가 나지 않았지만 MER은 여전히 +4.17이다.
- **원인은 확인하지 않았다.** 어댑터의 프롬프트 토큰 ID·mel·인코더 길이는 mlx-audio와 같다(3.3절). 그래서 int4 RTN 양자화(`MatMulNBits`, accuracy_level 4)가 MLX 8bit보다 품질을 잃는 것으로 추정한다. 0.6B가 훨씬 크게 나빠지는 것도 이와 맞는다. fp32 판(디코더 8.1GB)은 이 16GB Mac에서 두 세션에 올리면 메모리가 모자라 재지 않았다.
- **메모리:** 1.7B ONNX가 AI Hub·FLEURS 전체에서 5.6–5.9GB다. 인코더 1.27GB + 디코더 가중치 2.23GB × 2 ≈ 5.7GB와 맞아, `decoder_init`·`decoder_step` 두 세션이 같은 가중치를 따로 올리는 것으로 보인다(확인하지 않음). 사전 50개 최악 경우를 더하면 6GB 기준을 넘을 수 있다.
- **속도(참고):** M3 CPU에서 1.7B ONNX RTF 0.19–0.29, 0.6B 0.10–0.17이다. plan 6.1의 0.26과 비슷하다.

**하지 않은 것** (시간 약 4시간 안에서 고른 순서: P1 → P6, 그다음 확장)

- AI Hub 전체 4세션(311.5분): 앞 8·30분만 쟀다. 자동 감지 기준선(`--lang auto`, 사전 없음)도 재지 않았다.
- 1.7B AI Hub head30m 사전 없음: head8m이 그 비교를 맡는다.
- 0.6B HiKE, 0.6B 사전 넣은 FLEURS, 0.6B 앱 경로 HiKE.
- `--app`의 AI Hub 4세션 전체와 `--app --vad`의 4세션: 세션 하나의 앞 20분만.
- 메모리 최악 경우(30초 청크 + 사전 50개 이상), 스레드 4·8, 첫 실행 시간: Windows 기준 기기 몫이다(8.4절).

### 8.6 int8 판 (Mac, 2026-11-25)

**결론: 같은 원본의 디코더를 8bit로 다시 양자화한 판이 8.3절 품질 기준을 모두 넘는다.** MLX 8bit와 점수가 거의 같고, 반복 루프는 오히려 적다. 남은 것은 최대 메모리(6GB 기준을 넘는 6.2–7.2GB)와 Windows 기기에서의 속도다.

**만든 것** (`voyagar/Qwen3-ASR-1.7B-onnx-int8` @ `550f7a71`, 변환 스크립트와 측정표를 모델 카드에 넣었다)

1. andrewleech @ `df916193`의 fp32 디코더 둘을 onnxruntime 1.32.0 `MatMulNBitsQuantizer` + `DefaultWeightOnlyQuantConfig(bits=8, block_size=64, is_symmetric=False)`로 양자화했다. 원본 `quantize_nbits.py`의 RTN 갈래는 ORT 1.32에서 `bits`를 무시해 4bit가 된다.
2. 원본 `share_weights.py`로 두 디코더가 가중치 파일 하나를 쓰게 했다.
3. `MatMulNBits` 197개 모두 `accuracy_level=4`(int8 계산)로 했다. `accuracy_level=0`(fp32 계산)은 M3에서 RTF 20을 넘었다.
4. `decoder_init`에만 있던 fp32 입력 임베딩 표(`lm_head.weight`, 1.24GB)를 fp16 + `Cast`로 바꿨다. 가중치 파일이 3.10GB에서 2.48GB로 줄었다. 측정 행의 최대 메모리는 바뀌지 않았다.
5. 파일 이름은 `.int4`를 그대로 둔다. 어댑터가 표지 `decoder_step.int4.onnx`와 그 이름들을 찾기 때문이다(3.1절). 안에 든 정밀도는 `config.json`의 `quantization`이 적는다.

**결과** (조건은 8.5절과 같다. 언어 고정, 제품 토큰 상한. `qwen3-1.7b-onnx-int8-al4`는 4번 전, `qwen3-1.7b-onnx-int8`은 올린 판이다)

| 세트 · 표본 | MLX 8bit | ONNX int4 | **ONNX int8** | 차이 (int8 − MLX) |
| --- | --- | --- | --- | --- |
| HiKE 전체 MER (PIER), 루프 | 26.19 (32.74), 2 | 29.02 (42.93), 6 | **26.83 (32.48), 1** | +0.64 |
| HiKE every16 MER (PIER), 루프 | 25.00 (27.29), 0 | 49.76 (45.25), 2 | **28.37 (28.34), 0** (4번 전후 같음) | +3.37 |
| AI Hub head30m + 사전 CER, 용어 | 8.89, 28/31 | 9.31, 25/31 | **8.86, 28/31** | −0.03, 0%p |
| AI Hub head8m + 사전 CER, 용어 | 8.96, 11/11 | 9.01, 10/11 | **8.79, 11/11** (4번 전후 같음) | −0.17 |
| FLEURS every8 CER | 2.74 | 3.68 | **2.74** | 0.00 |
| 최대 RSS | 3.25–4.22 GB | 5.31–5.94 GB | **6.08–7.16 GB** | |
| RTF (참고) | 0.10–0.13 | 0.19–0.27 | 0.31–0.47 | |

**8.3절 기준 판정:** AI Hub CER·FLEURS CER·HiKE MER(전체 +0.64)·용어 재현율·반복 모두 **통과**한다. every16의 +3.37은 71개 표본에서 짧은 단어 클립 몇 개가 흔든 값이고, 전체 1121개에서는 +0.64다. 최대 메모리는 **6GB 기준을 넘는다**.

**관찰**

- int4 판이 떨어진 원인은 양자화 정밀도였다. accuracy_level만 0으로 낮춘 int4(`qwen3-1.7b-onnx-al0`)는 HiKE every16 38.02, AI Hub head8m 용어 10/11로 조금만 나아졌다. 가중치를 8bit로 올려야 MLX 수준이 된다.
- 메모리: 디코더 두 세션이 각각 양자화 가중치를 미리 풀어 올리는 것(prepacking)으로 추정한다. `session.disable_prepacking`을 켜면 오히려 커지고(int4 3.5 → 4.9GB) 느려졌다(RTF 19). ORT Python에는 세션 사이에 미리 푼 가중치를 나누는 통로가 없다. Windows 기기에서 실제 메모리를 잰 뒤, 16GB 미만 기기에서 막을지 정한다.

**하지 않은 것**

- FLEURS 전체: 소유자 지시로 중간에 멈췄고, every8로 대신했다.
- fp32 판(상한): M3에서 RTF 12라 세트 전체를 재지 않았다.
- 자동 감지(`--lang auto`), 앱 경로(`--app`), Windows 기기에서의 속도·메모리(W4).

### 8.7 x64 러너 결과 (2026-11-27, 소유자 결정: 이 측정을 등록 관문으로 쓴다)

**결론: x64에서도 품질이 Mac과 같다(FLEURS CER 2.78 대 2.74, 차이 +0.04 ≤ 0.2). 등록 목록 PR(9절 5번)의 관문을 통과했다.** 소유자가 2026-11-27 기준 기기 측정(W4) 대신 이 러너 측정을 관문으로 정했다. 속도와 메모리는 러너 값이라 대략값이지만, 메모리가 Mac보다 크게 나와 Windows 최소 메모리를 정해야 한다(11절 12번).

- 러너: GitHub `windows-latest`, AMD EPYC 7763 논리 코어 4, RAM 16GiB, onnxruntime 1.32.0, int8 판 `550f7a71`. run 45957040553(PR #140).

| 측정 | 스레드 | n | 오류 | CER | RTF | 로드 s | 최대 메모리 (PeakWorkingSet) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FLEURS every8 언어 고정 | 4 | 48 | 0 | **2.78** (Mac 2.74) | 0.93 | 7.3 | 8.81 GB |
| 같은 것 | 2 | 48 | 0 | 2.78 | 0.96 | 9.6 | 8.83 GB |
| 앱 경로 + ONNX VAD | 4 | 48 | 0 | 3.11 (Mac 기준값 없음) | 0.69 | 7.8 | 8.66 GB |
| 메모리 최악: 30초 묶음 8개 + 사전 50개, 앱 경로 | 4 | 8 | 0 | (지표 아님) | 1.20 | 7.1 | **10.16 GB** |

- **속도:** 논리 코어 4개 공유 VM에서 RTF 0.7–0.93, 최악 1.2다. 1시간 노트 변환에 약 40–60분이 걸린다는 뜻이다. 보통 노트북(코어 8개 이상)은 더 빠를 것으로 보지만 재지 않았다. 스레드 2와 4의 차이가 작아(0.96 대 0.93) 이 러너에서는 메모리 대역폭이 병목으로 보인다(확인하지 않음).
- **메모리:** Mac(같은 세트 6.24GB)보다 2.6GB 크고 최악 경우 10GB를 넘는다. Windows `PeakWorkingSetSize`가 메모리 매핑된 가중치 파일 페이지까지 세는 차이일 수 있으나 확인하지 않았다. 어느 쪽이든 **8GB 기기에서는 쓸 수 없고, 16GB 기기에서도 앱·브라우저와 함께면 빠듯하다.** 줄일 후보: 병합 디코더(세션 하나, 9절 6번), 미리 푼 가중치 나누기. 0.6.0 이후 과제다.
- **앱 경로 CER 3.11:** VAD로 자른 청크라 클립 단위(2.78)와 조건이 다르다. Mac `--app` 같은 세트 값이 없어 대조하지 않았다.

## 9. 단계·PR 나누기

각 PR은 혼자 합쳐도 macOS 동작이 바뀌지 않는다.

| # | PR (브랜치 `windows/…`) | 내용 | 합친 뒤 상태 |
| --- | --- | --- | --- |
| 1 | `windows/asr-onnx-adapter` | `asr_onnx.py`(`decode` 분리), `vad_onnx.py`, 폴더 판별(`Transcriber.load`·`vad.find_chunks`), `_generate` numpy 기본, `_free_mlx` 가드, `runtime_missing`, 시험(7절, 가짜 세션), `windows-core.yml` 필수 시험 단계, CLAUDE.md의 mlx-audio 업그레이드 줄. **의존성·레지스트리는 고치지 않는다** | 코드는 있지만 등록되지 않아 사용자에게 보이지 않는다. Mac 동작은 그대로다 |
| 2 | `windows/asr-onnx-bench` | `bench/asr.py`·`run.py` 늦은 import + ONNX 갈래, **두 갈래 같은 토큰 상한**, `--app`·`--vad` 모드, 메모리 키 정리, `silero-vad` darwin 표지, `vad_compare.py`, **MLX 기준선 재측정**과 Mac ONNX 측정 결과(지표만), 이 문서 결과 절 | 같은 조건의 Mac 품질 숫자가 나온다 |
| 3 | ~~(소유자, W4)~~ → x64 러너(`windows-asr-bench.yml`) | 2026-11-27 소유자 결정으로 기준 기기 대신 러너 측정이 관문이다. 결과 8.7절(통과) | 런타임을 채택했다 |
| 4 | `windows/onnxruntime-dep` | `pyproject`: `onnxruntime` win32 표지 + `huggingface-hub`·`numpy`·`tokenizers` 직접 의존성, `uv lock`(새 uv), `windows-core.yml` 라이선스 필수 단계, ARCHITECTURE.md 행, CLAUDE.md 문장, Mac 번들 복사본 확인(onnxruntime 없음, DMG 크기) | Windows 설치에 onnxruntime이 들어간다 |
| 5 | `windows/registry-onnx` | `_mac_models`/`_windows_models`·`CAPABILITIES`·`_BY_ID`·`ONNX_REPOS`, `build_transcript`의 `runtime`, 기능 잠금 `"platform"`·`live` mac_only·`fix_command`, 파이프라인 단계 건너뛰기(4.3절), `usable` 조건, prune 합집합, Windows `physical_memory`, `models add` 거절, 문구·번역(4.1절 마지막 항목), `test_models`·파이프라인 시험 | **3번 측정이 기준을 통과했을 때만** 합친다(2026-11-27 러너 측정 통과, 8.7절). Windows에서 변환이 돈다 |
| 6 | 나중 | UNIVA ONNX 변환·업로드·측정(2.3절), 병합 디코더 측정, 0.6B 실시간 자막(`live_sim` Windows판), DirectML | — |

1·2번은 Mac에서 바로 할 수 있고 서로 기다리지 않는다. 4·5번은 3번 결과를 기다린다. Windows 번들(W5)은 5번 뒤에 하고, 이때 mlx `darwin` 표지와 Windows 모듈 목록을 다룬다.

## 10. 위험

| 위험 | 영향 | 대응 |
| --- | --- | --- |
| `model_type`이 Mac과 같다(`qwen3_asr`) | 판별을 빠뜨리면 ONNX 폴더를 mlx-audio가 읽다 죽는다 | 표지 파일 판별을 `load` 맨 앞에 두고 시험으로 고정한다 |
| Windows 목록에 없는 모델을 파이프라인이 찾음 | 화자 분리 안내의 `KeyError`로 변환이 죽는다 | 단계를 건너뛰고 `platform` 경고 하나(4.3절), CLI 시험 |
| 상류 코드의 프롬프트 ID 버그(9125·882) | 시스템 턴·자주 쓰는 단어가 조용히 깨진다 | 프롬프트 문자열을 통째로 토큰화한다. mlx-audio와 ID 대조 시험(`slow`) |
| mlx-audio를 올리며 프롬프트·언어 파싱이 바뀜 | Mac과 Windows 출력이 갈린다 | 고정 리터럴 시험(CI)이 신호를 주고, CLAUDE.md 줄에 따라 slow 대조를 돌린다 |
| `decoder_init`이 모든 위치의 logits `[1,S,151936]` f32를 낸다(토큰당 약 0.6MB) | 30초 청크 + 사전이면 순간 메모리가 는다. 언어 고정 루프 재시도는 사전 전체를 넣어(asr.py:198) GB 단위가 될 수 있다 | 최악 경우를 잰다(8.2절). 198행은 소유자 결정(11절 7번). 병합 디코더(마지막 위치만)를 측정 후보로 둔다 |
| 측정 조건이 런타임마다 다름 | ONNX가 엉뚱한 이유로 좋아 보인다 | 두 갈래 같은 상한, MLX 재측정, 반복 정의 통일(8.1절) |
| 보통 Windows CPU 속도 미측정, KV 복사 비용 | M3 RTF 0.26이 기준 기기에서 0.5를 넘을 수 있다 | 8.3절 대안 순서(io_binding 먼저) |
| int4 RTN 한국어 품질(0.6B) 미측정 | 저사양 엔진이 기준을 못 넘을 수 있다 | 0.6B도 같은 기준으로 잰다 |
| x64와 arm64 `MatMulNBits`(accuracy_level 4) 수치 차이 | Mac에서 잰 품질이 Windows와 다를 수 있다 | Windows에서 일부 세트를 다시 잰다(8.4절) |
| 온도 0.3 표본 추출이 mlx-lm과 다르게 구현될 위험 | 루프 재시도 성공률이 달라진다 | 같은 식(softmax/T, top_p 1)을 쓰고 `--app` 재시도 횟수로 확인한다 |
| `.data` 외부 파일이 두 세션에 두 번 올라갈 가능성 | 메모리가 2.2GB 더 든다 | plan 6.1의 4.3GB는 짧은 발화라 근거가 약하다. 최악 경우 측정으로 확인한다 |
| Silero ONNX와 MLX의 경계 차이 | 청크가 달라져 CER이 바뀐다 | 같은 ASR에서 VAD만 바꾼 CER 차이 ≤ 0.2(필수) |
| onnxruntime DLL 로드 실패 | 코드 없는 트레이스백 | `runtime_missing` 코드, `doctor` 점검 |
| Windows `physical_memory`가 설치 용량보다 작다 | 16GB 기기에서 늘 0.6B를 고른다 | `GetPhysicallyInstalledSystemMemory`(4.1절) |
| W5에서 mlx-audio에 darwin 표지 | 전이 의존성(`huggingface_hub`·`numpy`·`tokenizers`)이 빠져 받기·변환이 깨진다 | 4번 PR에서 직접 의존성으로 올린다 |
| 4.1GB 받기, Defender 첫 검사 | 첫 실행이 느리다 | 측정해 설치 안내에 적는다 |
| onnxruntime 재도입 규칙 위반으로 보일 수 있음 | CLAUDE.md·v3.99와 충돌 | win32 표지, Mac 번들 확인, 문서 세 곳 갱신 |
| 벤치 의존성이 `.venv`에 남아 `bundle_trace` 목록이 오염됨 | 목록에 잡음이 생긴다 | 측정은 `uv run --with`만 쓴다 |

## 11. 소유자가 정할 것

1. **Windows 항목 ID를 Mac과 같게(`asr-std`·`asr-lite`·`vad`) 둘지.** 권하는 답은 같은 ID다. 앱·설정·선택 코드가 그대로 맞고, 런타임은 `asr.model`(저장소)로 구별된다.
2. **통과 기준 확정:** AI Hub CER +1.0, RTF 0.5 외에 FLEURS(+1.0), HiKE(+2.0), 용어 재현율(−3%p), `--app` 재시도 수, VAD CER 차이(+0.2), 최대 메모리(6GB)를 기준으로 삼을지.
3. **Windows 기본 엔진:** Mac처럼 메모리 16GB 이상이면 1.7B로 할지, 측정 전까지 0.6B를 기본으로 할지.
4. **기준 기기:** RTF를 잴 Windows 기기(CPU 모델·코어·RAM·전원 조건). AI Hub 데이터와 `bench/cache`를 그 기기로 복사해도 되는지(재배포가 아니라 소유자 기기 안 이동).
5. **`asr-ko-univa` ONNX 변환·`voyagar` 업로드 시점,** 그리고 이번에는 면제 없이 `bench/` 세 세트를 잴지(권하는 답: 잰다).
6. **병합 디코더(rhasspy 0.6B·craigandrews 1.7B)를 첫 측정에 함께 넣을지,** 미리보기 뒤로 미룰지.
7. **언어 고정 루프 재시도가 사전 전체를 넘기는 것(asr.py:198)을 `hw`로 바꿀지.** Mac hotwords 규칙 변경이라 CLAUDE.md에 따라 가상 음성 A/B를 재거나 면제 기록을 남겨야 한다.
8. **미리보기에서 Windows `models add`(직접 추가)를 막을지**(권하는 답: 막는다).
9. **스레드 수 정책:** ORT 기본(물리 코어)으로 둘지, 녹음·앱 반응성을 위해 상한을 둘지.
10. **어떤 ONNX 판으로 W4를 이어갈지(8.5절, 2026-11-19 Mac 측정 뒤).** 지금 int4 판은 1.7B가 AI Hub CER은 통과하지만 용어 재현율(−9.7%p)·HiKE 언어 고정에서 떨어진다. 고를 수 있는 것: (가) 그대로 두고 기준을 다시 정한다, (나) 같은 원본에서 더 정밀한 판(int8, 또는 accuracy_level을 낮춘 int4)을 직접 변환해 같은 표본으로 다시 잰다(권하는 답), (다) 병합 디코더 판(6번)을 함께 잰다. (나)·(다)는 받는 크기·메모리가 커진다. → **2026-11-25 (나)로 진행(소유자 "제안 순서대로"):** int8 판 `voyagar/Qwen3-ASR-1.7B-onnx-int8`이 품질 기준을 모두 넘었다(8.6절). 남은 것은 최대 메모리 6GB 기준과 Windows 기기에서의 속도다.
11. **0.6B를 Windows 목록에 둘지.** int4 0.6B는 AI Hub +2.8–4.2, FLEURS 자동 +4.95로 기준에서 멀다(8.5절). 권하는 답: 더 정밀한 판이 기준을 넘기 전까지 Windows에는 1.7B 하나만 둔다. → **2026-11-25 소유자가 권하는 답대로 진행:** Windows에는 1.7B 하나만 둔다.
