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

## 단어 정렬 모델 (2026-10-06)

| 모델 | revision | 로컬 경로 | 라이선스 |
| --- | --- | --- | --- |
| `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | `0e1a68e91d815300c7c9754b2a7639378b23db15` | `models/qwen3-forcedaligner-0.6b-8bit` | Apache-2.0 |

- `mlx_audio.stt.utils.load`로 프로세스 안에서 돈다. ASR 모델을 내린 뒤(`_free_mlx`) 세그먼트마다 1회 돌리고, 끝나면 내린 뒤 색인한다.
- **soynlp(LGPL-3) 금지.** mlx-audio의 `tokenize_korean`이 soynlp를 불러오므로 `align.Aligner`가 `aligner_processor.tokenize_korean`을 `align.tokenize`(공백 토큰마다 하나)로 바꿔 끼우고 `language="Korean"`으로 부른다. `tokenize_space_lang`은 한자를 글자마다 나눠 단어 수가 어긋나므로 쓰지 않는다.
- **불변식:** `words`가 null이 아니면 `words[k]["text"] == seg_text(s).split()[k]`이다. 텍스트를 바꾸는 코드는 `align.remap_words`로 `words`를 함께 옮긴다(`store.apply_text_edits`).
- 모델이 없거나 실패하면 `words`는 null이고 `aligner_missing`/`aligner_failed` 경고만 낸다. `tractus align <회의>`가 나중에 채운다.

## 목소리 프로필 (Phase 7.1, 2026-10-07)

| 모델 | 로컬 경로 | 라이선스 |
| --- | --- | --- |
| 3D-Speaker CAM++ zh_en advanced (k2-fsa 릴리스 ONNX, sha256 `aa3cfc16…ceba2`) | `models/3dspeaker-campplus-zh-en/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | Apache-2.0 |

- 런타임은 `onnxruntime`(1.29 이상, CPU) + `kaldi-native-fbank`다. **`sherpa-onnx`를 넣지 않는다**(휠에 espeak-ng GPL-3가 정적 링크). 화자 분리 뒤, 등록된 사람이 있을 때만 `voices` 단계를 돌린다. 결과는 `speakers.S1.suggested` **제안**이고 `name`(사용자 확정)이 아니다.
- **벡터는 `$TRACTUS_HOME/voices.json`(0600)에만 둔다.** 회의 폴더·transcript.json·MCP·LLM 프롬프트·색인·내보내기·로그·stdout에 쓰지 않는다. `voices list`도 이름·표본 수만 낸다.
- **제안 이름을 표시 이름으로 쓰지 않는다.** `store.speaker_name`은 `name`만 본다. bundle 내보내기는 `suggested`를 뺀다. `summarize.clean_owners(s, transcript)`는 확정되지 않은 제안 이름 owner를 null로 바꾼다.
- **등록에는 동의가 필수다**(`voices enroll --consent`, 개인정보보호법 제23조). `--consent` 없이 등록하는 경로를 만들지 않는다.
- **모델·`voices.THRESHOLD`·`MARGIN`·구간 선택·onnxruntime 버전을 바꾸면 `bench/voice_eval.py`(AI Hub, 로컬 전용, 지표만, 저장소 루트에서 `uv run --with soundfile python bench/voice_eval.py`)를 다시 돌린다.** AI Hub 라벨 행과 ALIASES 민감도 행을 둘 다 보고, 수치가 같은 세션 기준임을 적는다. 모델을 바꾸면 `MODEL_ID`가 바뀌어 기존 프로필은 매칭에서 빠지고 다시 등록해야 한다.
- 테스트는 가짜 임베더를 쓴다. 실제 모델은 `pytest -m slow`(가상 `say` 음성)만.

## 실시간 자막 (Phase 7.2, 2026-10-07)

- **미리보기 전용이다.** `tractus live`는 아무것도 저장하지 않는다(회의 폴더·색인·로그·stdout 외 어디에도 자막 텍스트를 쓰지 않는다). 정식 전사는 녹음을 멈춘 뒤 배치 `transcribe --recording`이 만든다. 앱은 `stop`을 보내 워커가 끝난 **뒤에** 배치 전사를 띄운다.
- 모델은 Qwen3-ASR **0.6B** 8bit와 Silero `feed()`만 쓴다. 1.7B를 올리지 않는다. 물리 메모리 16GB 미만이면 `--force` 없이 거부한다.
- 실시간 화자 라벨(`--speakers`, Nemotron 스트리밍 'low')은 기본으로 끈다. GPU 사용률 증가분(시스템 전체 − 시작 전 기준값)이 약 세 배(12–17%p → 42%p)라서다. `gpu_util_mean`은 시스템 전체 값이니 `gpu_util_delta`로 비교한다. 최종 라벨과 다를 수 있다.
- **확정 규칙·임계값(`live.SILENCE_FRAMES`, `MAX_FRAMES`, `PARTIAL_FRAMES`, `TAIL_FRAMES`, 뒤처짐 상한)을 바꾸면 `uv run python bench/live_sim.py`(가상 `say` 대화, 실시간 약 75초)를 다시 돌려** `bench/results/live_summary.json`의 확정 지연·footprint·GPU를 비교한다. AI Hub 파일은 `--source`/`--reference`로 로컬에서만 재고 지표만 남긴다.
- 테스트는 가짜 VAD·ASR로 돈다(`tests/test_live.py`). 실제 모델은 `pytest -m slow`의 `test_real_live_captions_follow_a_growing_recording`(2배속).

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
| `align.py` | 단어 정렬(Qwen3-ForcedAligner): `tokenize`(soynlp 대체), `Aligner.align`, `align_segments`, 편집 뒤 시각 옮기기 `remap_words` |
| `store.py` | 회의 폴더, `.job.json`·`.chunks.jsonl`(이어하기, 목소리 제안 포함), transcript.json/md/vtt (schema_version 2: 화자), `apply_speaker_edit`(rename·set·merge·dismiss), `apply_suggestions`, `apply_text_edits`(words도 옮김), `seg_text`(표시 텍스트 = `corrected_text` 우선), `add_glossary_terms` |
| `live.py` | 실시간 자막(미리보기): `WavTail`(커지는 WAV 꼬리 읽기), `Mixer`(트랙 합산·클립), `Resampler`(48k → 16k FIR), `Segmenter`(Silero feed, 0.5초 무음·8초 상한·3초 미리보기·쉼 미리 전사), `Live`(ASR·뒤처짐·정지), `SpeakerTrack`(선택) |
| `voices.py` | 목소리 프로필: CAM++ 임베딩(onnxruntime + kaldi-native-fbank), 화자 구간 고르기, `voices.json`(0600, 원자적 쓰기), `match`(헝가리안 + 임계값 + 2위와 차이) |
| `export.py` | 내보내기 txt·md·srt·vtt·csv(utf-8-sig)·docx(python-docx, `w:eastAsia`)·bundle(zip) |
| `llm.py` | 공급자 표(`PROVIDERS`), `complete_json`: strict JSON + Pydantic 검증 + 1회 재요청, `stream_chat`: 평문 스트리밍 |
| `summarize.py` | 요약 스키마, segment_ids 검증, summary.md/json |
| `ask.py` | 회의 질의: 근거 모으기(회의 전사 전체 / 검색 8개 + 앞뒤 이웃), 프롬프트, 인용 대조·정리(`finalize`), 대화 기록 자르기, `chat.json` |
| `env.py` | `.env` / `.env.local` 로더 |
| `paths.py` | `TRACTUS_HOME`, `TRACTUS_MODELS_DIR` 해석 (CLI·MCP 공용) |
| `embed.py` | Qwen3-Embedding-0.6B (공식 가중치 bf16, mlx-lm), `LazyEmbedder` |
| `index.py` | SQLite FTS5 음절 bigram + sqlite-vec, 증분 동기화, strict 우선 + 가중 RRF |
| `mcp_server.py` | MCP 서버 7개 도구 (`build_server(home, embedder)`) |
| `cli.py` | `tractus transcribe`, `align`, `summarize`, `ask`, `index`, `search`, `speakers`, `voices`, `segments`, `glossary`, `export`, `mcp` |

환경변수는 `.env.example`에 모두 있다. 개발 중에는 저장소 루트의 `.env`(기본값)와 `.env.local`(API 키)을 CLI가 읽는다. 우선순위는 셸 > `.env.local` > `.env`.

## 검색·MCP 규칙

- **표시 텍스트는 언제나 `store.seg_text(s)`(`corrected_text`가 있으면 그것, 없으면 `text`)다.** 출력·프롬프트·색인·내보내기에서 `s['text']`를 직접 읽지 않는다. 원문 `text`는 바꾸지 않는다.

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
- **회의 질의(`ask`)는 원격 공급자로 질문, 최근 대화, 근거 세그먼트 텍스트만 보낸다.** 오디오·요약·근거 밖 전사는 보내지 않는다. 답의 인용은 `ask.finalize`가 근거와 대조해 없는 ID를 지운다. 프롬프트를 바꾸면 `uv run pytest -m llm`과 `bench/ask_eval.py`(가상 회의만)를 돌린다.
- **AI Hub 데이터의 전사를 원격 LLM에 보내지 않는다.** 테스트는 `tests/fixtures/sample_meeting.json`(가상 회의)만 쓴다.
- API 키를 코드·로그·커밋·대화에 남기지 않는다. `.env.local`에만 둔다.

## 자주 쓰는 명령

```bash
uv run pytest                                       # 단위·CLI 테스트 (모델 불필요)
uv run pytest -m slow                               # 실제 모델 테스트
uv run pytest -m llm                                # 실제 LLM API 스모크 (키 있는 공급자만)
uv run tractus summarize <meeting_id>               # 요약
echo "질문" | uv run tractus ask [--meeting <id>] [--from/--to YYYY-MM-DD] [--save]   # 회의 질의 (앱: stdin JSON + --progress-json)
uv run tractus index / search "<질의>"              # 색인, 검색
uv run tractus speakers <meeting_id> list --json    # 화자 (rename S1 이름 / set s0012 S2|new / merge S3 S1 / dismiss S1)
uv run tractus voices enroll <meeting_id> S1 --name 이름 --consent   # 목소리 등록 + 이름 확정 (list --json / forget / match)
echo '{"edits":[{"id":"s0012","text":"새 문장"}]}' | uv run tractus segments <meeting_id> edit   # 텍스트 교정 → {"changed": N}
uv run tractus glossary add 쿠버네티스 "Project Atlas"  # 용어집 추가 → {"added": N}
uv run tractus export <meeting_id> --format docx --out 회의.docx [--force]   # txt|md|srt|vtt|csv|docx|bundle → {"path": …}
uv run python bench/search_eval.py                  # 검색 평가 (가상)
uv run python bench/ask_eval.py                     # 질의 평가 (가상 회의만 원격 LLM으로)
uv run tractus transcribe <파일> [--no-align]       # 전사 (+ 단어 타이밍)
uv run tractus align <meeting_id> [--force]         # 단어 타이밍 채우기 → {"aligned": N, "failed": M, "skipped": K}
echo stop | uv run tractus live --recording <녹음 폴더> --progress-json   # 녹음 중 실시간 자막 (stdin stop/EOF로 끝, 저장 안 함)
uv run python bench/live_sim.py                     # 실시간 자막 시뮬레이션 (가상 대화, 실시간 약 75초)

cd bench && uv sync                                 # 벤치마크 의존성
uv run python run.py qwen3-1.7b hike --lang auto    # 실험 1회 (모델 × 데이터셋 × 조건)
uv run python rescore.py                            # 추론 없이 지표만 다시 계산
uv run python report.py > results/REPORT.md         # 표 생성
uv run python score.py                              # 채점 함수 자체 테스트
```
