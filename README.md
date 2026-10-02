# Tractus

회의 녹음을 **내 Mac 안에서** 전사하고, 요약·검색만 LLM API로 처리하는 회의록 도구입니다.
오디오와 전사본은 기기를 떠나지 않습니다. LLM은 로컬(Gemma)이든 상용(Claude·OpenAI·Gemini·Upstage)이든 OpenAI 호환 API 하나로 호출합니다.

- 라이선스: [Apache-2.0](LICENSE)
- 설계 문서: [ARCHITECTURE.md](ARCHITECTURE.md)
- 진행 상황: Phase 0(ASR 모델 선정) 완료, **Phase 1(전사 CLI) 완료** → 다음은 Phase 2(LLM 요약)

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
```

### 모델 받기

ASR 모델 하나(트랙에 맞게)와 VAD 모델을 받습니다. `hf`는 `huggingface_hub` CLI입니다(`uv tool install "huggingface_hub[cli]"`).

```bash
export TRACTUS_MODELS_DIR=$PWD/models   # 모델 위치. 생략하면 ~/Tractus/models

# 기본 트랙 (2.3 GB)
hf download mlx-community/Qwen3-ASR-1.7B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-1.7b-8bit
# 저사양 트랙 (1.0 GB)
hf download mlx-community/Qwen3-ASR-0.6B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-0.6b-8bit
# VAD (1.3 MB, 두 트랙 공용)
hf download mlx-community/silero-vad-v6 --local-dir $TRACTUS_MODELS_DIR/silero-vad-v6
```

VAD는 [mlx-community/silero-vad-v6](https://huggingface.co/mlx-community/silero-vad-v6)(Silero VAD v6의 MLX 포팅, MIT)입니다.

## 사용법

```bash
uv run tractus transcribe 주간회의.m4a
uv run tractus transcribe 주간회의.m4a --title "3분기 예산 회의" -t 김철수 -t "Project Atlas"
uv run tractus transcribe 주간회의.m4a --track lite      # 0.6B 모델
```

전사가 끝나면 `~/Tractus/meetings/` 아래에 회의 폴더가 생깁니다. 위치는 `TRACTUS_HOME` 환경변수로 바꿀 수 있습니다.

```text
~/Tractus/meetings/2026-10-02_3분기_예산_회의_01K6.../
├── audio.opus        원본을 mono Opus 32kbps로 보관 (1시간 약 14MB)
├── transcript.json   기계용 원본 (스키마: ARCHITECTURE.md §6)
└── transcript.md     사람·에이전트용, [HH:MM:SS] 타임스탬프
```

| 옵션 | 설명 |
| --- | --- |
| `--track standard\|lite` | 생략하면 메모리 16GB 이상이면 `standard`(1.7B), 아니면 `lite`(0.6B) |
| `--language auto\|ko\|en` | 기본 `auto`. `ko`로 고정하면 영어 위주 발화를 번역할 수 있어 권장하지 않습니다 |
| `-t`, `--term` | 이 회의의 용어(참석자 이름, 제품명). 여러 번 지정할 수 있습니다 |
| `--title` | 회의 제목. 생략하면 파일 이름 |

- **용어집:** `~/Tractus/glossary.md`에 `- 용어` 형식으로 적어 두면 모든 회의에 적용됩니다. `-t`로 준 용어와 합쳐서 전달됩니다.
- **이어하기:** 중간에 Ctrl+C로 멈추거나 종료돼도 같은 명령을 다시 실행하면 끝난 청크 다음부터 이어서 진행합니다.
- **중복 방지:** 이미 전사한 파일(같은 SHA-256)은 다시 전사하지 않습니다. 다시 하려면 회의 폴더를 지우세요.

### 개발

```bash
uv run pytest            # 단위·CLI 테스트 (모델 불필요)
uv run pytest -m slow    # 실제 모델로 짧은 음성 전사 (models/ 필요)
```

## 저장소 구조

```text
ARCHITECTURE.md   설계 백본 (결정 사항, 로드맵, Phase 0 결과)
src/tractus/      CLI와 전사 파이프라인 (audio · vad · asr · store · cli)
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
