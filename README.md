# Tractus

회의 녹음을 **내 Mac 안에서** 전사하고, 요약·검색만 LLM API로 처리하는 회의록 도구입니다.
오디오와 전사본은 기기를 떠나지 않습니다. LLM은 로컬(Gemma)이든 상용(Claude·OpenAI·Gemini·Upstage)이든 OpenAI 호환 API 하나로 호출합니다.

- 라이선스: [Apache-2.0](LICENSE)
- 설계 문서: [ARCHITECTURE.md](ARCHITECTURE.md)
- 진행 상황: **Phase 0(ASR 모델 선정) 완료** → 다음은 Phase 1(전사 CLI)

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

### 모델 받기

저장소 루트에서 실행합니다. `hf`는 `huggingface_hub` CLI입니다(`uv tool install "huggingface_hub[cli]"` 또는 `pip install -U "huggingface_hub[cli]"`).

```bash
# 기본 트랙 (2.3 GB)
hf download mlx-community/Qwen3-ASR-1.7B-8bit --local-dir models/qwen3-asr-1.7b-8bit

# 저사양 트랙 (1.0 GB)
hf download mlx-community/Qwen3-ASR-0.6B-8bit --local-dir models/qwen3-asr-0.6b-8bit
```

받은 모델이 동작하는지 확인합니다.

```bash
cd bench && uv sync
uv run python -c "from mlx_audio.stt.utils import load; m = load('../models/qwen3-asr-0.6b-8bit'); print(m.generate('<녹음 파일>.wav').text)"
```

## 저장소 구조

```text
ARCHITECTURE.md   설계 백본 (결정 사항, 로드맵, Phase 0 결과)
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
