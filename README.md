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

ASR 모델 하나(트랙에 맞게)와 VAD 모델을 받습니다. `hf`는 `huggingface_hub` CLI입니다(`uv tool install "huggingface_hub[cli]"`).

```bash
export TRACTUS_MODELS_DIR=$PWD/models   # 모델 위치. 생략하면 ~/Tractus/models

# 기본 트랙 (2.3 GB)
hf download mlx-community/Qwen3-ASR-1.7B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-1.7b-8bit
# 저사양 트랙 (1.0 GB)
hf download mlx-community/Qwen3-ASR-0.6B-8bit --local-dir $TRACTUS_MODELS_DIR/qwen3-asr-0.6b-8bit
# VAD (1.3 MB, 두 트랙 공용)
hf download mlx-community/silero-vad-v6 --local-dir $TRACTUS_MODELS_DIR/silero-vad-v6
# 검색용 임베딩 (1.1 GB, 선택 — 없으면 키워드 검색만 함). revision을 고정해서 받습니다
hf download Qwen/Qwen3-Embedding-0.6B --revision 97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3 --local-dir $TRACTUS_MODELS_DIR/qwen3-embedding-0.6b
```

| 모델 | 용도 | 라이선스 |
| --- | --- | --- |
| [mlx-community/silero-vad-v6](https://huggingface.co/mlx-community/silero-vad-v6) | 무음 기준 청크 분할 (Silero VAD v6의 MLX 포팅) | MIT |
| [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 의미 검색 (공식 가중치를 mlx-lm으로 실행) | Apache-2.0 |

## 사용법

```bash
uv run tractus transcribe 주간회의.m4a
uv run tractus transcribe 주간회의.m4a --title "3분기 예산 회의" -t 김철수 -t "Project Atlas"
uv run tractus transcribe 주간회의.m4a --track lite      # 0.6B 모델
```

전사가 끝나면 `~/Tractus/meetings/` 아래에 회의 폴더가 생깁니다. 위치는 `TRACTUS_HOME` 환경변수로 바꿀 수 있습니다.

```text
~/Tractus/meetings/2026-10-02_3분기_예산_회의_01K6.../
├── audio.ogg         원본을 mono Ogg Opus 32kbps로 보관 (1시간 약 14MB, Obsidian에서 재생 가능)
├── transcript.json   기계용 원본 (스키마: ARCHITECTURE.md §6)
├── transcript.md     사람·에이전트용, [HH:MM:SS] 타임스탬프 (녹음 중 메모·북마크 포함)
├── transcript.vtt    WebVTT 자막 (플레이어 동기화용)
└── memos.json        녹음 중 메모·북마크 (데스크톱 앱으로 녹음했을 때)
```

| 옵션 | 설명 |
| --- | --- |
| `--track standard\|lite` | 생략하면 메모리 16GB 이상이면 `standard`(1.7B), 아니면 `lite`(0.6B) |
| `--language auto\|ko\|en` | 기본 `auto`. `ko`로 고정하면 영어 위주 발화를 번역할 수 있어 권장하지 않습니다 |
| `-t`, `--term` | 이 회의의 용어(참석자 이름, 제품명). 여러 번 지정할 수 있습니다 |
| `--title` | 회의 제목. 생략하면 파일 이름 |
| `--recording <폴더>` | 데스크톱 녹음기(`tractus-rec`)가 만든 녹음 폴더를 전사 (마이크·시스템 트랙을 섞음). 끝나면 녹음 폴더를 정리하고, `--keep-tracks`면 원본 트랙을 `tracks/`에 보관 |
| `--progress-json` | 진행 상황을 stdout에 JSON Lines로 출력 (데스크톱 앱용, `docs/desktop.md`) |

- **용어집:** `~/Tractus/glossary.md`에 `- 용어` 형식으로 적어 두면 모든 회의에 적용됩니다. `-t`로 준 용어와 합쳐서 전달됩니다.
- **이어하기:** 중간에 Ctrl+C로 멈추거나 종료돼도 같은 명령을 다시 실행하면 끝난 청크 다음부터 이어서 진행합니다.
- **중복 방지:** 이미 전사한 파일(같은 SHA-256)은 다시 전사하지 않습니다. 다시 하려면 회의 폴더를 지우세요.

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
uv run pytest -m slow    # 실제 모델로 짧은 음성 전사 (models/ 필요)
uv run pytest -m llm     # 실제 LLM API 스모크 테스트 (키가 있는 공급자만, 가상 회의 전사 사용)
uv run python bench/search_eval.py   # 검색 평가 (가상 회의 5건, 질의 30개)
```

## 저장소 구조

```text
ARCHITECTURE.md   설계 백본 (결정 사항, 로드맵, Phase 0 결과)
src/tractus/      CLI, 전사, LLM 요약, 검색, MCP (audio · vad · asr · store · llm · summarize · embed · index · mcp_server · cli)
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
