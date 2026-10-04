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

## 화자 분리 모델 (2026-10-04 확정)

| 모델 | revision | 로컬 경로 | 라이선스 |
| --- | --- | --- | --- |
| `mlx-community/Nemotron-3-Diarization` | `59ed2dbfc1346dcea9d423c71306a3a2499c568f` | `models/nemotron-3-diarization` | OpenMDW-1.1 |

- `mlx_audio.vad.load`로 프로세스 안에서 돈다. ASR 전에 회의 전체로 1회 돌리고, 화자가 바뀌는 지점에서 VAD 청크를 나눈다. 최대 8명.
- 화자 분리 모델은 ASR 모델을 올리기 전에 내린다(`del` + `mx.clear_cache()`).
- 모델이 없거나 실패하면 화자 없이 전사하고 `warning` 이벤트 + stderr로 알린다. 이어하기는 화자 분리를 다시 돌리지 않는다.
- **화자 분리 엔진·평활 파라미터를 바꾸면 AI Hub(로컬, 지표만)와 가상 음성(macOS `say`) 둘 다에서 DER·confusion을 다시 잰다.** 백업 엔진은 FluidAudio community-1이고, `Diarizer.diarize(pcm) → [(시작, 끝, "S1"), …]`만 맞추면 된다.
- 가상 음성은 `say -v Yuna`와 `say -v "Grandpa (한국어(한국))"`처럼 **엔진이 다른** 음성을 쓴다. 그냥 `Eddy`처럼 쓰면 영어 음성이 골라져 한국어가 거의 빈 오디오가 된다. Grandpa·Grandma처럼 같은 엔진 음성은 한 화자로 합쳐질 수 있다.

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
| `diarize.py` | 화자 분리(Nemotron 3), 단일 화자 평활(`smooth`), 화자 경계로 청크 나누기(`split_chunks`) |
| `asr.py` | `Transcriber`: 청크 전사, 토큰 상한, 반복 루프 재시도·보정 |
| `store.py` | 회의 폴더, `.job.json`·`.chunks.jsonl`(이어하기), transcript.json/md/vtt (schema_version 2: 화자), `apply_speaker_edit` |
| `llm.py` | 공급자 표(`PROVIDERS`), `complete_json`: strict JSON + Pydantic 검증 + 1회 재요청 |
| `summarize.py` | 요약 스키마, segment_ids 검증, summary.md/json |
| `env.py` | `.env` / `.env.local` 로더 |
| `paths.py` | `TRACTUS_HOME`, `TRACTUS_MODELS_DIR` 해석 (CLI·MCP 공용) |
| `embed.py` | Qwen3-Embedding-0.6B (공식 가중치 bf16, mlx-lm), `LazyEmbedder` |
| `index.py` | SQLite FTS5 음절 bigram + sqlite-vec, 증분 동기화, strict 우선 + 가중 RRF |
| `mcp_server.py` | MCP 서버 7개 도구 (`build_server(home, embedder)`) |
| `cli.py` | `tractus transcribe`, `summarize`, `index`, `search`, `speakers`, `mcp` |

환경변수는 `.env.example`에 모두 있다. 개발 중에는 저장소 루트의 `.env`(기본값)와 `.env.local`(API 키)을 CLI가 읽는다. 우선순위는 셸 > `.env.local` > `.env`.

## 검색·MCP 규칙

- 검색 결합 방식이나 토크나이저를 바꾸면 `bench/search_eval.py`(가상)와 `bench/aihub_search_eval.py`(AI Hub, 로컬 전용)를 **둘 다** 돌려 비교한다. 가상 평가셋만 보면 동일 가중 RRF가 좋아 보이지만, 실제 ASR 전사에서는 키워드 단독보다 나빴다.
- 임베딩 모델·revision·지시문을 바꾸면 `embed.MODEL_ID`가 바뀌어 벡터가 전부 다시 만들어진다.
- `mlx-embeddings`(GPL-3), Kiwi(LGPL-3) 같은 copyleft 의존성을 넣지 않는다.
- MCP 도구는 async로 쓴다(sqlite·MLX는 스레드에 묶임). 예상된 실패는 `ToolError`로 던진다. stdout에는 아무것도 출력하지 않는다.
- MCP 서버는 임베딩하지 않는다(`sync(embed=False)`). 벡터는 CLI가 만든다.
- 에이전트 CLI 인수 테스트에는 `tests/fixtures/eval`(가상 회의)만 쓴다. AI Hub 전사가 들어 있는 홈을 MCP에 연결하지 않는다.

## LLM 규칙

- 공급자는 OpenAI 호환 API 키 방식만 쓴다. `claude -p`, `codex exec`, `agy`를 공급자로 붙이지 않는다(약관, ARCHITECTURE.md §0).
- 모든 추출 항목은 근거 `segment_ids`가 필수다. 프롬프트·스키마를 바꾸면 `uv run pytest -m llm`으로 확인한다.
- 화자는 자동 추정이다. owner에는 사용자가 이름을 붙인 화자만 쓰고 `S1` 같은 라벨은 쓰지 않는다. 프롬프트만으로는 새어 나와서 `summarize.clean_owners`가 null로 바꾼다.
- **AI Hub 데이터의 전사를 원격 LLM에 보내지 않는다.** 테스트는 `tests/fixtures/sample_meeting.json`(가상 회의)만 쓴다.
- API 키를 코드·로그·커밋·대화에 남기지 않는다. `.env.local`에만 둔다.

## 자주 쓰는 명령

```bash
uv run pytest                                       # 단위·CLI 테스트 (모델 불필요)
uv run pytest -m slow                               # 실제 모델 테스트
uv run pytest -m llm                                # 실제 LLM API 스모크 (키 있는 공급자만)
uv run tractus summarize <meeting_id>               # 요약
uv run tractus index / search "<질의>"              # 색인, 검색
uv run tractus speakers <meeting_id> list --json    # 화자 (rename S1 이름 / set s0012 S2|new / merge S3 S1)
uv run python bench/search_eval.py                  # 검색 평가 (가상)
uv run tractus transcribe <파일>                    # 전사

cd bench && uv sync                                 # 벤치마크 의존성
uv run python run.py qwen3-1.7b hike --lang auto    # 실험 1회 (모델 × 데이터셋 × 조건)
uv run python rescore.py                            # 추론 없이 지표만 다시 계산
uv run python report.py > results/REPORT.md         # 표 생성
uv run python score.py                              # 채점 함수 자체 테스트
```
