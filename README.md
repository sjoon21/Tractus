# Tractus

회의 녹음을 **내 Mac 안에서** 전사하고, 요약·검색만 LLM API로 처리하는 회의록 도구입니다.
오디오와 전사본은 기기를 떠나지 않습니다. LLM은 로컬(Gemma)이든 상용(Claude·OpenAI·Gemini·Upstage)이든 OpenAI 호환 API 하나로 호출합니다.

- 라이선스: [Apache-2.0](LICENSE)
- 설계 문서: [ARCHITECTURE.md](ARCHITECTURE.md)
- 진행 상황: Phase 0(ASR 모델 선정)·Phase 1(전사 CLI)·Phase 2(LLM 요약, Upstage)·**Phase 3(검색 + MCP) 완료** → 다음은 Phase 4(UI + 녹음)

## ASR 모델 (확정, 2026-10-02)

Phase 0 실측으로 두 트랙을 정했습니다. 두 모델은 같은 계열이라 파이프라인·프롬프트가 같고, 트랙 전환은 모델 경로만 바꾸면 됩니다.

| 트랙 | 모델 | 받을 곳 (MLX 8bit) | 원본 | 크기 | 대상 기기 |
| --- | --- | --- | --- | --- | --- |
| **기본 (Standard)** | Qwen3-ASR-1.7B | [mlx-community/Qwen3-ASR-1.7B-8bit](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit) | [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | 2.3 GB | 통합 메모리 16GB 이상 또는 M1 Pro 이상 |
| **저사양 (Lite)** | Qwen3-ASR-0.6B | [mlx-community/Qwen3-ASR-0.6B-8bit](https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit) | [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | 1.0 GB | 8GB Mac, 다른 작업과 병행할 때 |

- 두 모델 모두 **Apache-2.0**입니다. 가중치는 저장소에 넣지 않고 각자 `models/`에 받습니다(`.gitignore` 처리).
- 런타임은 [mlx-audio](https://github.com/Blaizzy/mlx-audio)입니다. `mlx-audio`는 `mlx-community` 변환본을 씁니다. `aufklarer/…` 변환본은 speech-swift 전용이라 호환되지 않습니다.

### Phase 0 측정 결과 요약

개발 기기(Apple M3, 16GB)에서 측정했습니다. 숫자는 낮을수록 좋습니다. 전체 표는 [bench/results/REPORT.md](bench/results/REPORT.md)에 있습니다.

| 모델 | 한국어 회의 CER | 한·영 혼용 MER | 영어 회의 WER | 1시간 회의 처리 시간 | 피크 메모리 |
| --- | --- | --- | --- | --- | --- |
| Qwen3-ASR-1.7B (기본) | 9.49% | 24.1 | 9.50% | 8.2분 | 3.6 GB |
| Qwen3-ASR-0.6B (저사양) | 11.47% | 26.1 | 10.14% | 3.3분 | 2.0 GB |
| Whisper-large-v3-turbo (대조군, 미채택) | 14.92% | 26.6 | 14.28% | 6.0분 | 2.2 GB |
| Nemotron 3.5 ASR 0.6B (참고, 미채택) | 10.93% | 45.1 | 14.13% | 7.6분 | 2.0 GB |

## 시작하기

### 요구 환경

- macOS + Apple Silicon (M1 이상)
- [uv](https://docs.astral.sh/uv/), Python 3.12 이상
- FFmpeg (`brew install ffmpeg`)

### 설치

```bash
git clone https://github.com/sjoon21/Tractus.git && cd Tractus
uv sync            # .venv에 tractus CLI 설치
cp .env.example .env   # 개발 기본값 (경로, LLM 공급자)
```

API 키는 `.env.local`에 넣습니다(git 제외). 우선순위는 셸 환경변수 > `.env.local` > `.env`입니다.

```bash
# .env.local
UPSTAGE_API_KEY=up_...
```

### 모델 받기

ASR 모델 하나(트랙에 맞게), VAD 모델, 화자 분리 모델, 단어 정렬 모델을 받습니다. `hf`는 `huggingface_hub` CLI입니다(`uv tool install "huggingface_hub[cli]"`).

```bash
export TRACTUS_MODELS_DIR=$PWD/models   # 모델 위치. 생략하면 ~/Tractus/models

# 기본 트랙 (2.3 GB)
hf download mlx-community/Qwen3-ASR-1.7B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-1.7b-8bit
# 저사양 트랙 (1.0 GB)
hf download mlx-community/Qwen3-ASR-0.6B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-0.6b-8bit
# VAD (1.3 MB, 두 트랙 공용)
hf download mlx-community/silero-vad-v6 --local-dir $TRACTUS_MODELS_DIR/silero-vad-v6
# 화자 분리 (199 MB, 선택 — 없으면 화자 없이 전사함). revision을 고정해서 받습니다
hf download mlx-community/Nemotron-3-Diarization --revision 59ed2dbfc1346dcea9d423c71306a3a2499c568f --local-dir $TRACTUS_MODELS_DIR/nemotron-3-diarization
# 9명 이상 화자 분리 (21 MB, 선택 — 없으면 8명까지). Swift 헬퍼를 빌드하고 헬퍼로 받습니다 (revision은 FluidAudio가 고정)
(cd recorder && swift build -c release --product tractus-diar)   # → recorder/.build/release/tractus-diar (다른 위치면 TRACTUS_DIAR_BIN)
recorder/.build/release/tractus-diar download --models $TRACTUS_MODELS_DIR/speaker-diarization
# 단어 타이밍 (1.2 GB, 선택 — 없으면 세그먼트 단위로만 이동). revision을 고정해서 받습니다
hf download mlx-community/Qwen3-ForcedAligner-0.6B-8bit --revision 0e1a68e91d815300c7c9754b2a7639378b23db15 --local-dir $TRACTUS_MODELS_DIR/qwen3-forcedaligner-0.6b-8bit
# 검색용 임베딩 (1.1 GB, 선택 — 없으면 키워드 검색만 함). revision을 고정해서 받습니다
hf download Qwen/Qwen3-Embedding-0.6B --revision 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3 --local-dir $TRACTUS_MODELS_DIR/qwen3-embedding-0.6b
# 목소리 프로필 (28 MB, 선택 — 등록한 사람의 이름을 제안할 때만 씀). GitHub 릴리스에서 받고 sha256을 확인합니다
mkdir -p $TRACTUS_MODELS_DIR/3dspeaker-campplus-zh-en && curl -L -o $TRACTUS_MODELS_DIR/3dspeaker-campplus-zh-en/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
shasum -a 256 $TRACTUS_MODELS_DIR/3dspeaker-campplus-zh-en/*.onnx   # aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2
```

| 모델 | 용도 | 라이선스 |
| --- | --- | --- |
| [mlx-community/silero-vad-v6](https://huggingface.co/mlx-community/silero-vad-v6) | 무음 기준 청크 분할 (Silero VAD v6의 MLX 포팅) | MIT |
| [mlx-community/Nemotron-3-Diarization](https://huggingface.co/mlx-community/Nemotron-3-Diarization) | 화자 분리 (최대 8명, mlx-audio로 실행) | [OpenMDW-1.1](https://openmdw.ai/license/1-1/) |
| [FluidInference/speaker-diarization-coreml](https://huggingface.co/FluidInference/speaker-diarization-coreml) | 9명 이상 화자 분리 (pyannote community-1의 Core ML 변환, Swift 헬퍼 `tractus-diar`로 실행) | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) (출처 표기 필요) |
| [mlx-community/Qwen3-ForcedAligner-0.6B-8bit](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) | 단어 타이밍 (재생 중 단어 강조, 단어 클릭 이동) | Apache-2.0 |
| [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 의미 검색 (공식 가중치를 mlx-lm으로 실행) | Apache-2.0 |
| [3D-Speaker CAM++ zh_en](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced) ([ONNX 변환](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)) | 목소리 프로필 (화자 임베딩, onnxruntime으로 CPU 실행) | Apache-2.0 |

모델 라이선스 고지는 [NOTICE](NOTICE)에 있습니다.

## 사용법

```bash
uv run tractus transcribe 주간회의.m4a
uv run tractus transcribe 주간회의.m4a --title "3분기 예산 회의" -t 김철수 -t "Project Atlas"
uv run tractus transcribe 주간회의.m4a --track lite      # 0.6B 모델
uv run tractus transcribe 주간회의.m4a --max-speakers 4  # 참석자가 4명이면 상한을 준다
uv run tractus transcribe 화면녹화.mp4                   # 동영상은 소리만 전사
```

FFmpeg가 읽는 형식은 모두 받습니다: 오디오(m4a, mp3, wav, aac, flac, ogg, webm …)와 동영상(mp4, mov, mkv …). 오디오 트랙이 없는 동영상은 오류로 끝납니다.

전사가 끝나면 `~/Tractus/meetings/` 아래에 회의 폴더가 생깁니다. 위치는 `TRACTUS_HOME` 환경변수로 바꿀 수 있습니다.

```text
~/Tractus/meetings/2026-10-02_3분기_예산_회의_01K6.../
├── audio.ogg         원본을 mono Ogg Opus 32kbps로 보관 (1시간 약 14MB, Obsidian에서 재생 가능)
├── transcript.json   기계용 원본 (스키마: ARCHITECTURE.md §6)
├── transcript.md     사람·에이전트용, `[HH:MM:SS] **화자**: 텍스트` (녹음 중 메모·북마크 포함)
├── transcript.vtt    WebVTT 자막 (플레이어 동기화용, 화자는 <v 이름>)
└── memos.json        녹음 중 메모·북마크 (데스크톱 앱으로 녹음했을 때)
```

| 옵션 | 설명 |
| --- | --- |
| `--track standard\|lite` | 생략하면 메모리 16GB 이상이면 `standard`(1.7B), 아니면 `lite`(0.6B) |
| `--language auto\|ko\|en` | 기본 `auto`. `ko`로 고정하면 영어 위주 발화를 번역할 수 있어 권장하지 않습니다 |
| `-t`, `--term` | 이 회의의 용어(참석자 이름, 제품명). 여러 번 지정할 수 있습니다 |
| `--title` | 회의 제목. 생략하면 파일 이름 |
| `--recording <폴더>` | 데스크톱 녹음기(`tractus-rec`)가 만든 녹음 폴더를 전사 (마이크·시스템 트랙을 섞음). 끝나면 녹음 폴더를 정리하고, `--keep-tracks`면 원본 트랙을 `tracks/`에 보관 |
| `--no-diarize` | 화자 분리를 하지 않습니다 (모델이 없으면 자동으로 이렇게 됩니다) |
| `--max-speakers N` | 화자 수 상한. 말한 시간이 많은 N명만 남기고 나머지는 가까운 화자에 붙입니다 (Nemotron은 8명이 한계) |
| `--diarizer auto\|nemotron\|fluid` | 화자 분리 엔진. 기본 `auto`: Nemotron으로 나누고, 8명을 모두 쓰면(9명 이상일 수 있음) `tractus-diar`(fluid)로 다시 나눕니다. 헬퍼나 모델이 없으면 경고하고 Nemotron 결과를 씁니다 |
| `--no-align` | 단어 타이밍을 만들지 않습니다 (모델이 없으면 자동으로 이렇게 됩니다) |
| `--progress-json` | 진행 상황을 stdout에 JSON Lines로 출력 (데스크톱 앱용, `docs/desktop.md`) |

- **용어집:** `~/Tractus/glossary.md`에 `- 용어` 형식으로 적어 두면 모든 회의에 적용됩니다. `-t`로 준 용어와 합쳐서 전달됩니다.
- **이어하기:** 중간에 Ctrl+C로 멈추거나 종료돼도 같은 명령을 다시 실행하면 끝난 청크 다음부터 이어서 진행합니다.
- **중복 방지:** 이미 전사한 파일(같은 SHA-256)은 다시 전사하지 않습니다. 다시 하려면 회의 폴더를 지우세요.
- **단어 타이밍:** 전사가 끝나면 세그먼트 텍스트를 오디오에 맞춰 단어마다 시각을 붙입니다(`transcript.json`의 `words`, 1시간 회의 약 1.5분). 앱은 이것으로 재생 중인 단어를 강조하고, 단어를 클릭하면 그 단어부터 재생합니다. 예전 회의는 `uv run tractus align 01K6X3`으로 채웁니다(`--force`: 이미 있는 것도 다시).
- **화자 분리:** 전사 전에 회의 전체에서 목소리로 화자를 나눠 `S1`, `S2` …로 붙입니다. Nemotron은 8명까지이고, 9명 이상 회의는 `tractus-diar` 헬퍼를 빌드하고 모델을 받아 두면 자동으로 그쪽으로 다시 나눕니다(AI Hub 17명 회의 혼동 28.5% → 6.9%). 자동 추정이라 틀릴 수 있으니 아래 명령으로 이름을 붙이고 고칩니다.

### 화자 이름 붙이기·고치기

```bash
uv run tractus speakers 01K6X3 list                 # 화자별 세그먼트 수·발화 시간 (--json: 앱용 JSON)
uv run tractus speakers 01K6X3 rename S1 "김민수"   # 이름 붙이기 ("" 이면 지움)
uv run tractus speakers 01K6X3 set s0012 S2         # 세그먼트 하나의 화자 바꾸기 (S2 대신 new: 새 화자)
uv run tractus speakers 01K6X3 merge S3 S1          # S3을 S1에 합치기
```

`transcript.json`을 고친 뒤 `transcript.md`·`transcript.vtt`를 다시 쓰고 검색 색인을 갱신합니다. 오디오는 건드리지 않습니다. 이름을 붙인 화자는 요약에서 담당자(owner)로 쓰일 수 있고, `S1` 같은 라벨은 쓰이지 않습니다.

### 목소리 기억하기

```bash
uv run tractus voices enroll 01K6X3 S1 --name "홍길동" --consent   # S1을 홍길동으로 확정하고 목소리 등록
uv run tractus voices list                                          # 등록된 사람 (--json: 앱용)
uv run tractus voices match 01K6X3                                  # 기존 회의에 이름 제안 다시 계산
uv run tractus speakers 01K6X3 dismiss S2                           # 틀린 제안 지우기 (맞으면 그 이름으로 rename)
uv run tractus voices forget "홍길동"                               # 등록 삭제 (회의에 남은 제안도 지움)
```

목소리를 등록하면 다음 전사부터 비슷한 목소리의 화자에 "홍길동?" 같은 **제안**이 붙습니다. 제안은 앱에만 보이고, 확정하기 전에는 md·vtt·요약·검색·MCP·내보내기에 이름으로 쓰이지 않습니다.

> **동의가 필요합니다.** 목소리는 생체정보(개인정보보호법 제23조 민감정보)입니다. 본인이거나 녹음·등록에 동의를 받은 사람만 등록하세요(`--consent` 없이는 등록되지 않습니다). 등록한 목소리는 `~/Tractus/voices.json`(권한 0600)에만 저장되고 이 Mac 밖으로 보내지 않습니다. 목소리 모델을 바꾸면 다시 등록해야 합니다.

### 전사 텍스트 고치기·용어집

```bash
echo '{"edits":[{"id":"s0012","text":"쿠버네티스 클러스터를 늘립니다"}]}' | uv run tractus segments 01K6X3 edit
uv run tractus glossary add 쿠버네티스 "Project Atlas"
```

`segments edit`는 stdin의 JSON으로 여러 세그먼트를 한 번에 고칩니다. 고친 문장은 `corrected_text`에 들어가고 ASR 원문(`text`)은 그대로 남습니다. 원문과 같게 고치면 교정이 지워집니다. md·vtt·요약·검색·MCP·내보내기는 모두 고친 문장을 씁니다. 없는 세그먼트 ID나 빈 문장이 하나라도 있으면 아무것도 바꾸지 않습니다. `glossary add`는 `~/Tractus/glossary.md`에 중복 없이 용어를 더하고, 다음 전사부터 적용됩니다.

### 내보내기

```bash
uv run tractus export 01K6X3 --format docx --out 주간회의.docx
uv run tractus export 01K6X3 --format bundle --out 주간회의.zip --force   # 있으면 덮어쓰기
```

| 형식 | 내용 |
| --- | --- |
| `txt` | `[HH:MM:SS] 화자: 문장` |
| `md` | transcript.md + summary.md |
| `srt`, `vtt` | 자막 |
| `csv` | `시작,끝,화자,문장` (UTF-8 BOM, 한국어 Excel에서 바로 열림) |
| `docx` | 제목·일시·화자·요약(있으면)·전사. Word·Pages 한글 글꼴 지정 |
| `bundle` | 오디오·전사·요약·메모를 묶은 zip |

### 요약·결정 사항·할 일

```bash
uv run tractus summarize 01K6X3          # meeting_id 일부 또는 회의 폴더 경로
uv run tractus summarize 01K6X3 --provider upstage --model solar-pro4
```

회의 폴더에 `summary.md`(사람용)와 `summary.json`(기계용)이 생깁니다. 모든 주제·결정·할 일에는 근거 세그먼트와 타임스탬프가 붙습니다. **LLM 공급자에는 전사 텍스트만 전송되고 오디오는 전송되지 않습니다.**

| 공급자 (`--provider`) | 키 | 기본 모델 | 상태 |
| --- | --- | --- | --- |
| `upstage` | `UPSTAGE_API_KEY` | `solar-pro4` | ✅ 검증됨 |
| `openai` | `OPENAI_API_KEY` | 없음 (`--model` 필요) | 키 대기 |
| `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | 키 대기 |
| `gemini` | `GEMINI_API_KEY` | 없음 (`--model` 필요) | 키 대기 |
| `gemma-local` | 없음 (`localhost:11434`) | `gemma4:31b` | 로컬 서버 필요 |

`TRACTUS_LOCAL_ONLY=1`이면 원격 공급자를 막습니다. 구독형 CLI(`claude -p`, `codex exec`, `agy`)는 약관 문제로 공급자로 쓰지 않습니다(ARCHITECTURE.md §0).

### 검색

```bash
uv run tractus index                     # 색인 갱신 (transcribe·summarize 뒤에는 자동으로 됨)
uv run tractus index --rebuild           # 처음부터 다시
uv run tractus search "GPU 서버 구매" --from 2026-07-01 --to 2026-09-30
```

키워드(한국어 음절 bigram)와 의미(로컬 임베딩)를 함께 씁니다. 색인은 `~/Tractus/.tractus/index.sqlite`에 있고, 지워도 회의 폴더에서 다시 만들어집니다.

### 회의에 질문하기

```bash
echo "GPU 서버 구매는 어떻게 하기로 했어?" | uv run tractus ask --meeting 01K6X3          # 이 회의 전사 전체로 답
echo "검색 latency 목표는?" | uv run tractus ask --from 2026-07-01 --to 2026-09-30      # 모든 회의에서 검색해 답
echo '{"question":"담당자는?","history":[{"role":"user","content":"Redis 캐시 얘기야"}]}' | uv run tractus ask --meeting 01K6X3 --save
```

답의 문장마다 근거 세그먼트가 `[s0012]`(회의 범위) 또는 `[meeting_id#s0012]`(전체 범위)로 붙고, 끝에 근거 시각을 모아 보여 줍니다. 근거에 없는 ID는 지웁니다. 기록에 답이 없으면 "회의 기록에서 근거를 찾지 못했습니다."라고 답합니다. `--save`는 질문과 답을 회의 폴더의 `chat.json`에 남깁니다(최근 50개).

**공급자에는 질문, 최근 대화(6개 메시지), 근거 세그먼트만 전송됩니다.** 회의 범위는 그 회의 전사 전체(10만 자가 넘으면 회의 안에서 검색한 부분), 전체 범위는 검색 상위 8개 결과와 앞뒤 세그먼트입니다. 전체 범위에서 검색 결과가 없으면 LLM을 부르지 않습니다. 공급자 선택과 `TRACTUS_LOCAL_ONLY`는 요약과 같습니다. 앱 연동 계약은 `docs/desktop.md` §2.5에 있습니다.

### 녹음 중 실시간 자막 (미리보기)

```bash
uv run tractus live --recording ~/Tractus/recordings/01K… --progress-json   # 녹음 중인 폴더. stdin에 stop을 쓰거나 Ctrl-D로 끝냄
```

녹음하는 동안 작은 모델(Qwen3-ASR 0.6B)로 말을 끊어 자막을 미리 보여 줍니다. 앱에서는 설정의 "녹음 중 실시간 자막 (미리보기)"을 켜면 씁니다(기본 꺼짐).

- **저장하지 않습니다.** 녹음을 멈추면 지금처럼 1.7B·화자 분리·단어 정렬로 정식 전사를 다시 만듭니다.
- 말이 0.5초 멈추면 문장을 확정합니다. 길게 이어지면 3초마다 미리보기를, 8초마다 확정을 냅니다. 실측 확정 지연은 p95 0.72~0.76초입니다(가상 대화, M3).
- 메모리를 약 2GB 더 씁니다. 16GB 미만 Mac에서는 `--force` 없이는 실행하지 않습니다. 화자 라벨(`--speakers`)은 GPU를 약 세 배로 써서 기본으로 끕니다.
- 앱 연동 계약은 `docs/desktop.md` §2.8에 있습니다.

## MCP 연동 (Claude Code · Codex · Antigravity)

에이전트 CLI가 Tractus를 도구로 써서 과거 회의를 검색합니다. 근거를 `[meeting_id#s0012 00:05:31]` 형식으로 인용하고, 요약을 직접 써서 저장할 수도 있습니다. **MCP 서버는 LLM을 호출하지 않습니다.** 추론은 각 CLI가 자기 구독·키로 합니다.

먼저 한 번 색인합니다(벡터는 CLI 쪽에서 만듭니다): `uv run tractus index`

아래 예시의 `/path/to/Tractus`는 이 저장소 경로입니다. `.venv/bin/tractus`는 `uv sync` 뒤에 생깁니다.

**Claude Code** — 이름을 `-e`보다 앞에 둡니다.

```bash
claude mcp add -s user tractus -e TRACTUS_HOME=$HOME/Tractus -e TRACTUS_MODELS_DIR=/path/to/Tractus/models \
  -- /path/to/Tractus/.venv/bin/tractus mcp
```

**Codex CLI** — Codex는 셸 환경변수를 MCP 서버에 넘기지 않으므로 `env`를 꼭 적습니다. `~/.codex/config.toml`:

```toml
[mcp_servers.tractus]
command = "/path/to/Tractus/.venv/bin/tractus"
args = ["mcp"]
env = { TRACTUS_HOME = "/Users/me/Tractus", TRACTUS_MODELS_DIR = "/path/to/Tractus/models" }
# 읽기 도구는 자동 승인됩니다. 요약 저장(save_summary)까지 묻지 않고 쓰려면 다음 줄을 추가합니다.
# tools.save_summary.approval_mode = "approve"
```

**Antigravity CLI (agy)**

```bash
agy mcp add --env TRACTUS_HOME=$HOME/Tractus --env TRACTUS_MODELS_DIR=/path/to/Tractus/models \
  tractus /path/to/Tractus/.venv/bin/tractus mcp
```

헤드리스(`agy -p`)에서 쓰려면 `~/.gemini/antigravity-cli/settings.json`의 `permissions.allow`에 `"mcp(tractus/*)"`를 추가합니다. 워크스페이스 설정은 무시됩니다. Gemini CLI는 개인 계정 지원이 끝나 대상에서 뺐습니다.

| 도구 | 기능 |
| --- | --- |
| `status` | 데이터 위치, 색인 상태 (결과가 비어 보이면 먼저 확인) |
| `search_meetings` | 하이브리드 검색, 날짜·회의 필터, 세그먼트별 인용 표기 |
| `list_meetings` | 기간별 회의 목록 |
| `get_transcript` | 전사 원문 (페이지 단위) |
| `get_summary` / `list_action_items` | 요약, 할 일 |
| `save_summary` | 에이전트가 쓴 요약을 검증해서 저장 (유일한 쓰기 도구) |

예: `claude -p "지난 분기 GPU 서버 구매 결정이 어떻게 바뀌었는지 내 회의 기록에서 찾아서 근거와 함께 알려줘"`

### 개발

```bash
uv run pytest            # 단위·CLI 테스트 (모델·API 키 불필요)
uv run pytest -m slow    # 실제 모델로 짧은 음성 전사·가상 2화자 분리 (models/ 필요, fluid는 헬퍼와 모델이 있을 때만)
uv run python bench/diar_eval.py der --engine nemotron fluid   # 화자 분리 DER (AI Hub, 로컬 전용·지표만. --set DIR: 가상 음성)
uv run pytest -m llm     # 실제 LLM API 스모크 테스트 (키가 있는 공급자만, 가상 회의 전사 사용)
uv run python bench/search_eval.py   # 검색 평가 (가상 회의 5건, 질의 30개)
uv run python bench/ask_eval.py      # 회의 질의 평가 (가상 회의 5건, 질문 28개, 설정된 LLM 공급자 호출)
```

## 저장소 구조

```text
ARCHITECTURE.md   설계 백본 (결정 사항, 로드맵, Phase 0 결과)
src/tractus/      CLI, 전사, 화자 분리, LLM 요약, 검색, MCP (audio · vad · diarize · asr · live · store · llm · summarize · ask · embed · index · export · mcp_server · cli)
tests/            pytest
bench/            Phase 0 ASR 벤치마크 (코드, 지표 요약, 리포트)
models/           모델 가중치 (git 제외, 직접 받음)
data/             벤치마크 데이터셋 (git 제외)
```

## Phase 0 벤치마크 재현

```bash
cd bench
./setup.sh            # 의존성, 확정 모델 2개, 공개 데이터셋, HiKE 평가 코드
./setup.sh --phase0   # 비교용 Whisper·Nemotron까지 받기 (run_all.sh 재현 시 필요)
./run_all.sh && ./run_extra.sh
uv run python rescore.py && uv run python report.py > results/REPORT.md
```

- 공개 데이터셋: [FLEURS ko_kr](https://huggingface.co/datasets/google/fleurs) (CC-BY-4.0), [HiKE](https://huggingface.co/datasets/thetaone-ai/HiKE) (Apache-2.0), [AMI](https://huggingface.co/datasets/edinburghcstr/ami) (CC-BY-4.0)
- [AI Hub 주요 영역별 회의 음성인식 데이터](https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=464)는 내국인만 신청할 수 있고 승인이 필요합니다. 받은 파일은 `data/aihub-meeting/`에 두세요. **재배포가 금지되어 있으니 절대 커밋하지 마세요.**
