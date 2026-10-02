# Tractus — 에이전트 작업 지침

Local-first 회의록 도구. ASR·저장·검색은 사용자 Mac에서 하고, LLM만 OpenAI 호환 API로 호출한다. 설계 결정은 `ARCHITECTURE.md`가 원본이다. 바꾸려면 그 문서부터 고친다.

## ASR 모델 (Phase 0 확정, 2026-10-02)

| 트랙 | 모델 (MLX 8bit) | 로컬 경로 |
| --- | --- | --- |
| 기본 | `mlx-community/Qwen3-ASR-1.7B-8bit` | `models/qwen3-asr-1.7b-8bit` |
| 저사양 | `mlx-community/Qwen3-ASR-0.6B-8bit` | `models/qwen3-asr-0.6b-8bit` |

- 런타임은 `mlx-audio`(`mlx_audio.stt.utils.load`)를 **프로세스 안에서** 호출한다. `mlx_audio.server` HTTP 엔드포인트는 `hotwords`를 전달하지 않으므로 쓰지 않는다. 두 트랙은 모델 경로만 다르고 코드는 같다.
- VAD는 `mlx-community/silero-vad-v6`(`models/silero-vad-v6`). torch를 의존성에 넣지 않는다.
- Whisper·Nemotron은 Phase 0에서 탈락했다(`ARCHITECTURE.md` §8 "Phase 0 결과"). 새 벤치마크(`bench/`) 없이 ASR 모델을 바꾸거나 추가하지 않는다.

## ASR 파이프라인 기본값 (Phase 0 근거)

- **언어는 자동 감지(`language=None`)가 기본이다.** `Korean`으로 고정하면 영어 위주 발화를 한국어로 번역하거나 반복 루프에 빠진다.
- **용어집은 `hotwords=[...]`로 넣는다.** 용어 재현율이 72%에서 84%로 오른다.
- **청크는 Silero VAD로 무음 지점에서 최대 30초 단위로 자른다.**
- **반복 루프를 막는다.** 청크 길이에 비례한 `max_tokens` 상한을 두고, 반복을 감지하면 재시도한다. 0.6B에서 한 발화가 11,000자 넘게 반복된 사례가 있다.

## 데이터와 저장소 규칙

- 다음은 커밋하지 않는다(`.gitignore` 처리됨):
  - `models/`(가중치), `data/`(데이터셋)
  - `bench/results/raw/`(전사 원문), `bench/cache/`
- `data/aihub-meeting/`은 AI Hub 데이터다. 재배포가 금지되어 있다. 여기서 나온 전사 텍스트도 커밋하지 않는다.
- 커밋해도 되는 벤치마크 산출물은 지표 요약(`bench/results/summary.jsonl`)과 리포트(`bench/results/REPORT.md`)뿐이다.

## 코드 구조 (`src/tractus/`)

| 모듈 | 역할 |
| --- | --- |
| `audio.py` | FFmpeg 외부 호출(디코딩, Opus 보관), SHA-256 |
| `vad.py` | VAD 발화 구간 → 30초 이하 청크 |
| `asr.py` | `Transcriber`: 청크 전사, 토큰 상한, 반복 루프 재시도·보정 |
| `store.py` | 회의 폴더, `.job.json`·`.chunks.jsonl`(이어하기), transcript.json/md |
| `cli.py` | `tractus transcribe` |

환경변수: `TRACTUS_HOME`(기본 `~/Tractus`), `TRACTUS_MODELS_DIR`(기본 `$TRACTUS_HOME/models`). 개발 중에는 `TRACTUS_MODELS_DIR=$PWD/models`.

## 자주 쓰는 명령

```bash
uv run pytest                                       # 단위·CLI 테스트 (모델 불필요)
uv run pytest -m slow                               # 실제 모델 테스트
uv run tractus transcribe <파일>                    # 전사

cd bench && uv sync                                 # 벤치마크 의존성
uv run python run.py qwen3-1.7b hike --lang auto    # 실험 1회 (모델 × 데이터셋 × 조건)
uv run python rescore.py                            # 추론 없이 지표만 다시 계산
uv run python report.py > results/REPORT.md         # 표 생성
uv run python score.py                              # 채점 함수 자체 테스트
```
