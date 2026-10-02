# Tractus — 아키텍처 백본 v3 (2026-10-01)

> **라이선스: Apache-2.0** · **원칙: Local-first + LLM은 API로 접근**
>
> v2(서버형·엔터프라이즈 중심)에서 방향을 바꿨다. 사용자의 기기에서 녹음·전사·저장·검색이 끝나고, LLM만 OpenAI 호환 API로 호출한다.
> LLM이 로컬 Gemma 4 31B이든 Claude·OpenAI·Gemini·Upstage이든 **앱 입장에서는 전부 `base_url` + `model`만 다른 같은 API**다.

## 변경 이력

| 날짜 | 버전 | 변경 |
| --- | --- | --- |
| 2026-10-02 | v3.6 | **Phase 2 (Upstage) 완료.** `tractus summarize` — 요약·주제·결정·할 일 추출, strict JSON + Pydantic 검증 + segment_ids 검증 + 1회 재요청. `.env`/`.env.local` 개발 환경. 구독형 CLI 조사 결과 API 키 방식만 채택(agy 사용 금지). 나머지 공급자는 키 대기, 대안은 MCP |
| 2026-10-02 | v3.5 | **Phase 1 완료.** `tractus transcribe` CLI (`src/tractus/`). ASR은 mlx-audio 프로세스 내 호출로 변경(D1, `hotwords` 때문), VAD는 MLX 포팅 Silero로 torch 제거, 라우드니스 정규화 제외, 반복 루프 방지 규칙 확정, 스키마에 `title`·`audio.source`·`audio.sha256`·`asr.hotwords` 추가 |
| 2026-10-02 | v3.4 | **Phase 0 완료.** 기본 트랙 Qwen3-ASR-1.7B, 저사양 트랙 0.6B 확정. Phase 1 기본값: 언어 자동 감지, `hotwords` 용어집, 30초 청크, 반복 루프 방지. Nemotron은 코드스위칭 성능 때문에 저사양 후보에서 제외. 벤치마크 코드 `bench/` 추가 |
| 2026-10-01 | v3.3 | Phase 0 실행 계획 구체화: 개발 기기 1대(M3·16GB)로 한정, 모델·데이터셋을 저장소 안 `models/`·`data/`에 저장, 런타임은 mlx-audio로 단일화(llama.cpp는 Windows 단계로 연기), 데이터셋 확정(FLEURS·HiKE·AI Hub 회의·AMI), 대조군 비교 규칙과 판정 기준 추가 |
| 2026-10-01 | v3.2 | **프로젝트명 `Audius` → `Tractus`.** 사유: `Audius`는 2018년부터 운영 중인 탈중앙화 음악 스트리밍 서비스(audius.co, GitHub `AudiusProject`)와 이름이 겹침. 폴더 `~/workspace/Audius` → `~/workspace/Tractus`, 데이터 디렉터리 `~/Tractus/`, 설정 `~/.config/tractus/`, 인덱스 `.tractus/`, CLI `tractus` |
| 2026-10-01 | v3.1 | ASR을 macOS 우선으로 전환. 기본 트랙 Qwen3-ASR-1.7B MLX 8bit, 저사양 트랙 0.6B MLX 8bit. Nemotron 3.5는 실시간 후보로 보류, Fun-ASR-Nano(LiteRT)·Confucius4-R2T2 제외 |
| 2026-10-01 | v3 | Local-first + LLM API 접근 구조로 재설계, Apache-2.0 확정, 화자 분리 제외 |
| 2026-10-01 | v2 | 초안 최신화 (서버형·엔터프라이즈 중심) — v3로 대체됨 |

---

## 0. 결정 사항 요약

| # | 결정 | 근거 |
| --- | --- | --- |
| D1 | LLM·임베딩 접근은 **OpenAI 호환 API**(`chat/completions`, `embeddings`)로 통일. **ASR은 mlx-audio를 프로세스 안에서 호출**한다(2026-10-02 변경) | 로컬·상용 교체가 설정 변경만으로 가능. ASR은 `mlx_audio.server`의 `/v1/audio/transcriptions`가 `hotwords`를 모델까지 전달하지 않아 용어집을 못 쓰므로 직접 호출한다. 클라우드 ASR이 필요해지면 같은 `Transcriber` 인터페이스 뒤에 HTTP 구현을 추가한다 |
| D2 | **ASR은 로컬 필수 실행, macOS(Apple Silicon) 우선.** 투트랙: **기본 = Qwen3-ASR-1.7B MLX 8bit**, **저사양 = Qwen3-ASR-0.6B MLX 8bit**. Windows/Linux는 후순위(GGUF 경로 예약) | Apache-2.0, Fleurs-ko CER 2.57% / 3.72%, 두 트랙이 같은 모델 계열이라 파이프라인·프롬프트가 동일 (§2) |
| D3 | **화자 분리 제외** (스키마에 `speaker: null` 슬롯만 유지) | 경량화. 추후 LLM 또는 경량 모델로 추가 |
| D4 | LLM 공급자: **로컬 Gemma 4 31B, OpenAI(Codex 포함), Claude, Gemini, Upstage Solar** | 전부 OpenAI 호환 엔드포인트 보유 (차이점은 §3.3) |
| D5 | **데이터는 로컬 파일이 원본**, SQLite는 재생성 가능한 인덱스 | 메모·전사가 기기를 떠나지 않음. 사용자가 다른 도구(Obsidian, 에이전트 CLI)로 직접 열람 가능 |
| D6 | 임베딩 기본값 **로컬 Qwen3-Embedding-0.6B**, 상용 API는 선택 | 메모를 로컬에 두려는 원칙과 일치. CPU로도 개인 규모 처리 가능 |
| D7 | Claude Code · Codex CLI · Gemini CLI 연동은 **MCP 서버**로 제공 | 세 CLI 모두 MCP 지원. 에이전트가 자기 구독/키로 Tractus 데이터를 도구로 조회 |

> **"Claude, Codex, Gemini에서 쓸 수 있게"의 해석:** 두 가지로 모두 대응한다. ① Tractus가 이 3사 모델을 **LLM 공급자로 호출**(§3), ② 3사 에이전트 CLI가 Tractus를 **도구로 호출**(§5, MCP). 사용자의 구독 계정(OAuth)을 앱이 대신 사용하는 방식은 채택하지 않는다.
>
> **구독형 CLI 조사 (2026-10-02):**
>
> | CLI | 비대화형 실행 | 약관 | 판단 |
> | --- | --- | --- | --- |
> | Claude Code `claude -p` | ✓ (`--json-schema`) | 본인 스크립트는 구독 사용량에서 차감되는 공식 용도. 단 서드파티 제품이 claude.ai 로그인을 제공하는 것은 사전 승인 없이 금지. `--bare`는 API 키만 받음 | 제품 기능으로 넣지 않음 |
> | Codex `codex exec` | ✓ (`--output-schema`) | OpenAI 문서는 프로그래밍 방식 워크플로에 API 키 사용을 권장 | 제품 기능으로 넣지 않음 |
> | Antigravity `agy -p` | ✓ | "서드파티 소프트웨어로 Antigravity에 접근하면 약관 위반" — 계정 정지 사례 있음. Google은 AI Studio API 키를 대안으로 안내 | **사용 금지** |
>
> 따라서 LLM 공급자는 API 키 방식만 둔다. 키가 없는 공급자는 ②(MCP)로 각 CLI에서 Tractus를 호출해 품질을 본다.

---

## 1. 로컬 vs 상용 경계

```
┌──────────────────────────── 사용자 기기 (항상 로컬) ────────────────────────────┐
│                                                                                │
│  녹음/업로드 ─▶ FFmpeg(16kHz mono) ─▶ Silero VAD 청킹 ─▶ Qwen3-ASR (mlx-audio)  │
│                                                          프로세스 내 호출·로컬 │
│                                                                │               │
│                                                                ▼               │
│  ~/Tractus/ (원본 데이터)  ◀──── transcript.json / transcript.md / notes.md      │
│        │                                                                       │
│        ▼                                                                       │
│  index.sqlite (FTS5 + sqlite-vec)  ◀── [임베딩 엔드포인트] 기본: 로컬 Qwen3-Emb  │
│        │                                                                       │
│        ├──▶ MCP 서버 (stdio) ─────▶ Claude Code / Codex CLI / Gemini CLI       │
│        │                                                                       │
└────────┼───────────────────────────────────────────────────────────────────────┘
         │  (사용자가 선택한 작업에 한해 텍스트만 전송)
         ▼
   [LLM 엔드포인트]  ── 로컬/사내 Gemma 4 31B │ OpenAI │ Claude │ Gemini │ Upstage
```

| 구성요소 | 위치 | 상용 대체 가능? | 비고 |
| --- | --- | --- | --- |
| 오디오 원본 | **로컬 고정** | ✗ | 외부 전송 없음 |
| ASR | **로컬 고정** | 현재 ✗ (필요 시 `Transcriber` 뒤에 HTTP 구현 추가) | 오디오는 가장 민감한 데이터. mlx-audio를 프로세스 안에서 호출한다(D1) |
| 전사·메모·요약 저장 | **로컬 고정** | ✗ | Markdown + JSON 파일 |
| 검색 인덱스 | **로컬 고정** | ✗ | SQLite 단일 파일 |
| 임베딩 | 로컬 기본 | ○ (OpenAI, Gemini, Upstage) | 공급자 변경 시 전체 재색인 필요 (§4.2) |
| LLM (요약·추출·Q&A) | **API** | ○ (5개 공급자) | 로컬 Gemma도 API로 접근 |

**외부로 나가는 데이터는 "LLM 호출 시 프롬프트에 담긴 텍스트"뿐**이다. 설정에 `local_only = true`를 두면 LLM·임베딩 모두 로컬 엔드포인트만 허용한다(완전 오프라인 모드).

---

## 2. ASR — 0차 과제: 로컬 모델 선정

### 2.1 요구사항

- 한국어 / 영어 / **한·영 혼용(코드스위칭)** — 회의에서 영어 기술 용어가 섞이는 경우가 기본
- **1순위 플랫폼: macOS + Apple Silicon** (M1 이상, 통합 메모리 8–16GB도 고려). Windows/Linux(CUDA)는 후순위
- 라이선스: Apache-2.0과 충돌 없음 (모델은 번들하지 않고 사용자가 다운로드하지만, 기본값은 허용형 라이선스로)
- 1시간 녹음을 실시간보다 충분히 빠르게(RTF ≪ 1) 처리

### 2.2 후보 검토 (2026-10-01)

| 모델 | 크기 / 라이선스 | 한국어 | Mac 실행 | 판단 |
| --- | --- | --- | --- | --- |
| **Qwen3-ASR-1.7B** | 1.7B / Apache-2.0 | Fleurs-ko CER **2.57%** (오프라인) | MLX 8bit ≈ 2.3GB (mlx-audio, speech-swift) · GGUF Q8_0 2.17GB (llama.cpp) | ✅ **기본 트랙** |
| **Qwen3-ASR-0.6B** | 0.6B / Apache-2.0 | Fleurs-ko CER **3.72%** (오프라인) | MLX 8bit (mlx-audio, speech-swift) · GGUF | ✅ **저사양 트랙** |
| Nemotron 3.5 ASR Streaming 0.6B (2026-06) | 0.6B / OpenMDW-1.1 (허용형, 상업 이용 가능, 고지 유지) | Fleurs-ko CER **7.12%** (스트리밍, 1.12s 청크) | NeMo-Speech.cpp(Metal, GGUF Q8_0), speech-swift | 🔶 **실시간 트랙 예비 후보** (아래 설명) |
| Whisper-large-v3-turbo | 0.8B / MIT | 지원 | whisper.cpp, mlx-audio, speech-swift(CoreML) | ❌ Phase 0 대조군. 실제 회의 CER 14.9%로 Qwen3-ASR 두 모델보다 낮음 |
| ~~Fun-ASR-Nano-2512 (LiteRT)~~ | 0.8B / Apache-2.0 | **공식 지원 언어 아님** (zh/en/ja) | LiteRT-LM (오디오 인코더는 CPU 전용) | ❌ 한국어 미지원, 발화당 30초 제한, 타임스탬프 없음 |
| ~~Confucius4-R2T2 (NetEase)~~ | 2B / 코드 Apache-2.0, **가중치 NetEase 자체 라이선스** | 부가 지원 수준, 한국어 수치 없음 | vLLM/CUDA만 지원 | ❌ 가중치 라이선스 문제, zh/en 최적화, Mac 런타임 없음 |
| ~~SenseVoice-Small~~ | FunASR 모델 라이선스 | 지원 | — | ❌ 자체 라이선스 |
| ~~Parakeet / Canary~~ | — | 미지원 | — | ❌ 한국어 없음 |
| ~~VibeVoice-ASR / Cohere Transcribe~~ | 9B / 2B | — | — | ❌ 저사양 Mac에는 큼 (기본 트랙 대비 이점 불명확) |

#### 최종 의견

**1) 투트랙 모두 Qwen3-ASR로 간다. 기본은 1.7B, 저사양은 0.6B이며 둘 다 MLX 8bit.**
- 같은 모델 계열이라 VAD 청킹, 언어 설정, 프롬프트, 후처리 코드가 완전히 같다. 트랙 전환은 모델 ID 하나만 바꾸면 된다.
- 0.6B의 한국어 CER 3.72%는 Nemotron(7.12%)의 절반 수준이다. 단 Nemotron 수치는 스트리밍 조건이라 직접 비교에는 한계가 있다.
- 4bit는 쓰지 않는다. llama.cpp 실측에서 1.7B는 Q4_K_M일 때 영어 WER이 2.84% → 3.28%로 나빠졌고, 0.6B는 거의 변화가 없었다. 저사양 트랙의 메모리를 더 줄여야 할 때만 0.6B 4bit를 Phase 0에서 검토한다.

**2) Nemotron 3.5는 저사양 트랙이 아니라 "실시간 트랙" 후보로 보류한다.**
- 강점은 정확도가 아니라 구조에 있다. Cache-aware RNNT 구조라 80ms–1.12s 청크로 진짜 스트리밍이 되고, 메모리 사용이 일정하며, LLM형 디코더처럼 같은 문장을 반복하는 환각이 구조적으로 적다. 문장부호도 기본으로 붙는다.
- 회의 후 배치 전사가 1순위인 현재 범위에서는 한국어 정확도가 더 높은 Qwen3-ASR이 낫다. 라이브 자막이 로드맵에 올라오면 Phase 0 결과를 바탕으로 다시 평가한다.

**3) Mac 런타임은 MLX가 1순위, GGUF(llama.cpp)는 Windows 대비용으로 예약한다.**

| 런타임 | 언어 | OpenAI 호환 `/v1/audio/transcriptions` | 장점 | 주의 |
| --- | --- | --- | --- | --- |
| **mlx-audio** (`mlx-community/Qwen3-ASR-*-8bit`) | Python | ✓ (`mlx_audio.server`, 단 `hotwords` 미전달) | 코어(Python)와 같은 언어, ForcedAligner·스트리밍 API 포함 | **채택.** 서버가 아니라 라이브러리로 직접 호출 (D1) |
| speech-swift (`aufklarer/Qwen3-ASR-1.7B-MLX-8bit`) | Swift | 실시간 WebSocket(`/v1/realtime`) 중심 | MLX+CoreML 하이브리드, Silero VAD·화자분리(pyannote/Sortformer)·Nemotron까지 한 패키지, `brew install speech` | macOS 15+ 필요. **네이티브 Mac 앱(Phase 4) 단계의 유력 후보** |
| llama.cpp (`unslothai/Qwen3-ASR-1.7B-GGUF:Q8_0`) | C++ | ✓ (`llama-server`) | 크로스플랫폼 → **Windows 지원 시 그대로 재사용** | **b9173 이상 필수**(이전 빌드는 반복 출력 버그), `asr_text` 출력 형식 이슈(#26749)를 어댑터에서 처리 |

> 주의: 같은 "MLX 8bit"라도 **런타임마다 가중치 리포가 다르다.** aufklarer 변환본은 speech-swift 전용이고, mlx-audio는 `mlx-community` 변환본을 쓴다.
>
> 세 런타임 모두 OpenAI 호환 엔드포인트를 갖고 있지만, Tractus는 용어집(`hotwords`)을 쓰려고 mlx-audio를 라이브러리로 직접 호출한다(D1). 다른 런타임은 Windows 지원이나 네이티브 앱 단계에서 `Transcriber` 구현을 추가하고 속도·메모리를 다시 잰다.

**트랙 정의 (2026-10-02 Phase 0 실측으로 확정, §8 "Phase 0 결과"):**

| 트랙 | 모델 | 대상 Mac | 예상 메모리 |
| --- | --- | --- | --- |
| **기본 (Standard)** | `mlx-community/Qwen3-ASR-1.7B-8bit` | M1 Pro 이상 또는 통합 메모리 16GB 이상 | 모델 ≈ 2.3GB + 런타임 |
| **저사양 (Lite)** | `mlx-community/Qwen3-ASR-0.6B-8bit` | 8GB Mac, 다른 작업과 병행 시 | 모델 ≈ 1GB 내외 + 런타임 |

첫 실행 시 통합 메모리 용량으로 트랙을 자동 추천하고, 사용자가 언제든 바꿀 수 있게 한다.

> **메모리 경합 주의:** Mac은 통합 메모리라서 Gemma 4 31B를 같은 기기에서 돌리면(4bit 기준 약 18–20GB) ASR과 메모리를 나눠 쓴다. 32GB 이상이면 동시 적재가 가능하지만, 그보다 작으면 **ASR 완료 → 모델 언로드 → LLM 호출** 순서로 실행한다. Gemma를 별도 서버에 두면 이 문제는 없다.

### 2.3 ASR 파이프라인 (1차 과제)

```
입력(m4a/mp3/wav/webm)
  → FFmpeg: 16kHz mono PCM (+ 보관용 audio.opus 32kbps)
  → Silero VAD (MLX 포팅): 무음 기준 분할, 청크 ≤ 30초 (경계는 무음 지점)
  → 청크별 Qwen3-ASR generate (language: 자동, hotwords: 용어집, max_tokens: 청크 길이 비례)
  → 세그먼트 = 청크 텍스트 + 청크 시작/끝 시각
  → 청크마다 .chunks.jsonl에 기록 (중단 후 같은 명령으로 이어하기)
  → 끝나면 transcript.json + transcript.md 저장
```

- **타임스탬프:** 화자 분리가 없으므로 단어 단위 타임스탬프는 1차 범위에서 제외한다. VAD 청크 경계가 곧 세그먼트 타임스탬프이며, "문장 클릭 → 해당 위치 재생" UX에는 이것으로 충분하다. 단어 단위가 필요해지면 **Qwen3-ForcedAligner-0.6B**(Apache-2.0, 한국어 포함 11개 언어, 5분 단위)를 후처리로 추가한다.
- **용어집 주입:** 참석자 이름·제품명·약어를 프롬프트로 전달해 ASR 단계에서 고유명사 오류를 줄인다. 모델별 지원 방식이 달라 어댑터에서 처리한다. Qwen3-ASR은 `hotwords`로 넣는다(Phase 0: 용어 재현율 72% → 84%).
- **언어:** 청크별 자동 감지가 기본이다. `ko`로 고정하면 영어 위주 발화를 번역하거나 반복 루프에 빠진다(Phase 0). 고정은 사용자 설정으로만 연다.
- **청크 크기:** 최대 30초. Phase 0에서 15·30·60초의 CER 차이는 0.3%p 안이었다.
- **라우드니스 정규화는 하지 않는다.** Phase 0 측정이 정규화 없이 이뤄졌고, 효과를 측정하지 않은 처리를 넣지 않는다.
- **VAD:** `mlx-community/silero-vad-v6`(MLX 포팅, 1.3MB). Phase 0의 torch 버전과 발화 구간이 100% 같아 torch 의존성 없이 쓴다.
- **반복 루프 방지:** `max_tokens = 16 × 청크 초 + 32`(정상 발화 p99 6.4토큰/초의 약 2.5배). 4글자 이상이 연속 3회 반복되거나 상한에 닿으면 루프로 보고, 언어 고정이면 자동 감지로 한 번 재시도, 그래도 반복이면 반복 구간을 한 번만 남긴다. Phase 0 출력 기준 오탐은 HiKE 1/1121, AI Hub 5시간 0건.

### 2.4 화자 분리 — 추후 경로

1차에서는 제외하고, 스키마의 `speaker` 필드만 남겨둔다. 추가 경로는 세 가지다.

| 경로 | 방식 | 한계 |
| --- | --- | --- |
| A. 텍스트 LLM | 전사 텍스트만으로 발화 전환·역할(질문자/발표자) 추정 | 목소리 정보가 없어 정확도에 한계. "누가 말했나"보다는 "발화 전환점 추정" 수준 |
| B. 오디오 입력 LLM (Gemini 등) | 오디오를 클라우드로 보내 화자 라벨링 | **오디오 외부 전송** → `local_only`와 충돌, 옵션으로만 |
| C. 로컬 경량 모델 | pyannote community-1 (코드 MIT, 가중치 CC-BY-4.0) | GPU 없이 CPU로도 동작할 만큼 가벼워, 병목은 연산량이 아니라 통합 복잡도 |

> 실제로 화자 분리가 필요해지면 **C가 가장 현실적**이다. A는 보조 수단으로 둔다.

---

## 3. LLM 레이어 — OpenAI 호환 API

### 3.1 공급자 설정

> **Phase 2 구현 (2026-10-02):** 공급자 5개(base_url, 키 환경변수, 기본 모델, `json_schema` 지원 여부)는 `src/tractus/llm.py`의 `PROVIDERS`에 내장했다. 선택과 키는 환경변수로 준다: `TRACTUS_LLM_PROVIDER`, `TRACTUS_LLM_MODEL`, `TRACTUS_LOCAL_ONLY`, `<공급자>_API_KEY`. 개발 중에는 저장소 루트의 `.env`(기본값)와 `.env.local`(키)에서 읽는다(우선순위: 셸 > `.env.local` > `.env`). 아래 `config.toml`은 사용자가 공급자를 추가·수정해야 할 때 도입한다.

앱 코드는 `openai` SDK 하나만 쓰고, 공급자는 설정 파일로만 정의한다. API 키는 환경변수나 OS 키체인에서 읽고, 설정 파일에는 저장하지 않는다.

```toml
# ~/.config/tractus/config.toml   (model 값은 예시 — 실제 ID는 각 콘솔에서 확인)
local_only = false

[llm.default]
provider = "gemma-local"

[providers.gemma-local]            # Ollama / llama.cpp server / vLLM / LM Studio
base_url = "http://localhost:11434/v1"
model    = "gemma4:31b"
json_schema = true                  # 로컬 서버는 대부분 JSON 스키마 강제 지원

[providers.openai]                 # GPT·Codex 계열
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
model = "<gpt-model>"
json_schema = true

[providers.claude]
base_url = "https://api.anthropic.com/v1/"
api_key_env = "ANTHROPIC_API_KEY"
model = "claude-sonnet-5-5"
json_schema = false                 # 호환 레이어는 response_format / strict 를 무시함

[providers.gemini]
base_url = "https://generativelanguage.googleapis.com/v1beta/openai/"
api_key_env = "GEMINI_API_KEY"
model = "<gemini-model>"
json_schema = true

[providers.upstage]
base_url = "https://api.upstage.ai/v1"
api_key_env = "UPSTAGE_API_KEY"
model = "<solar-pro-3 계열 ID>"
json_schema = true                  # Phase 2에서 실측 확인

[tasks]                             # 작업별로 공급자를 다르게 지정 가능 (생략 시 llm.default)
summary = "claude"
qa      = "gemma-local"
```

### 3.2 공급자별 호환성 차이 (설계에 반영할 점)

| 항목 | OpenAI | Claude (호환 레이어) | Gemini (호환, beta) | Upstage | 로컬 (vLLM/Ollama/llama.cpp) |
| --- | --- | --- | --- | --- | --- |
| Chat Completions | ✓ | ✓ | ✓ | ✓ | ✓ |
| `response_format` JSON Schema | ✓ | **무시됨** | ✓ | ✓ **strict 필수** (2026-10-02 실측) | ✓ (guided decoding) |
| tool `strict` | ✓ | **무시됨** | 부분 | 확인 필요 | 서버별 상이 |
| Embeddings | ✓ | **없음** | ✓ (`gemini-embedding-001` 등) | ✓ (query/passage **모델 분리**) | 서버별 상이 |
| 오디오 입력 | ✓ | **제거됨** | ✓ | ✗ | 모델별 상이 |
| 프롬프트 캐싱 | 자동 | **미지원** (네이티브 API만 지원) | — | — | — |
| system 메시지 | 다중 허용 | 맨 앞 하나로 합쳐짐 | ✓ | ✓ | ✓ |
| 미지원 파라미터 | — | 조용히 무시 | 조용히 무시 | — | — |

Anthropic은 OpenAI 호환 레이어를 "테스트·비교용이며 장기 운영용은 아님"으로 명시하고 있다. 따라서 **최소 공통분모로 설계**한다.

1. **구조화 출력은 `response_format`에 의존하지 않는다.** 프롬프트에 JSON 스키마를 넣고 → 응답을 Pydantic으로 검증하고 → 실패하면 오류 메시지를 붙여 1회 재요청한다. 이 경로는 5개 공급자 모두에서 동작한다. `json_schema = true`인 공급자에는 `response_format`을 추가로 붙여 실패율만 낮춘다.
2. **system 메시지는 하나만** 사용한다(Claude의 합치기 동작과 결과가 같아짐).
3. `temperature`는 0–1 범위만 사용한다(Claude는 1을 넘으면 1로 잘라냄).
4. **네이티브 Claude 어댑터는 만들지 않는다.** Claude의 JSON 검증 실패율이나 캐싱 비용이 실측으로 문제가 되면 그때 추가한다. 여러 공급자를 엔드포인트 하나로 묶고 싶은 사용자는 LiteLLM 프록시를 앞단에 둘 수 있게 문서로만 안내한다. LiteLLM은 2026-03 PyPI 공급망 침해(1.82.7/1.82.8)가 있었으므로 코어 의존성에는 넣지 않는다.

### 3.3 LLM 작업 정의

| 작업 | 입력 | 출력 (Pydantic 스키마) |
| --- | --- | --- |
| 전사 교정 (선택) | 세그먼트 배열 `[{id, text}]` + 용어집 | `[{id, corrected_text}]` — 원문은 보존하고 diff로 표시 |
| 요약 | 전사 전체 (1시간 ≈ 2–3만 토큰, 한 번에 입력) | `{title, summary, topics[{title, segment_ids[]}], decisions[{text, segment_ids[]}], action_items[{task, owner\|null, due\|null, segment_ids[]}]}`. 주제 시간 범위는 segment_ids에서 계산한다 |
| Q&A | 질문 + 로컬 검색 결과(§4) | `{answer, citations[{meeting_id, segment_id}]}` |

- 모든 추출 항목에 **근거 `segment_ids`를 필수**로 둔다. UI에서 클릭하면 해당 오디오 위치로 이동하고, 환각 여부를 검증하는 데도 쓴다. 전사에 없는 ID나 빈 근거는 검증 실패로 보고 1회 재요청한다.
- 화자 분리가 없으므로 "제가 하겠습니다"처럼 말한 사람만 가리키는 할 일은 owner를 null로 둔다(모델이 "화자" 같은 값을 지어내는 것을 막는 규칙).
- AI Hub처럼 외부 반출이 제한된 데이터의 전사는 원격 공급자로 보내지 않는다. 스모크 테스트는 가상 회의 전사(`tests/fixtures/sample_meeting.json`)만 쓴다.
- Gemma 4 31B 컨텍스트 안에 1시간 회의가 충분히 들어가므로 map-reduce 요약은 기본 경로에서 제외한다(입력 길이가 컨텍스트를 넘을 때만 사용).

---

## 4. 저장소 · 임베딩 · 검색 (전부 로컬)

### 4.1 파일 레이아웃 — 파일이 원본

```
~/Tractus/
├── meetings/
│   └── 2026-10-01_주간회의_01J9X.../
│       ├── audio.opus            # 원본 (재인코딩 보관)
│       ├── transcript.json       # 기계용 원본 (§6 스키마)
│       ├── transcript.md         # 사람/에이전트용 (타임스탬프 포함)
│       ├── summary.md            # LLM 산출물 (frontmatter에 provider/model 기록)
│       ├── summary.json          # 같은 내용의 기계용 원본 (MCP list_action_items 등에서 사용)
│       └── notes.md              # 사용자 메모
├── glossary.md                   # 용어집 (ASR 프롬프트 + LLM 교정에 공용)
└── .tractus/
    └── index.sqlite              # FTS5 + sqlite-vec — 삭제해도 파일로부터 재생성 가능
```

- Markdown을 원본으로 두면 Obsidian 같은 도구나 에이전트 CLI가 별도 연동 없이 그대로 읽을 수 있다.
- 동기화·백업은 사용자가 원하는 도구(iCloud, Syncthing, git)에 맡기고, 앱은 관여하지 않는다.

### 4.2 임베딩

| 옵션 | 위치 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| **Qwen3-Embedding-0.6B** | 로컬 (llama.cpp / Ollama / TEI) | Apache-2.0 | **기본값**. CPU로 개인 규모 처리 가능, 다국어 상위권 |
| BGE-M3 | 로컬 | MIT | 대안 |
| OpenAI embeddings | API | — | |
| Gemini `gemini-embedding-001` | API (OpenAI 호환) | — | |
| Upstage `solar-embedding-2-*` | API (OpenAI 호환) | — | **query/passage 모델이 분리**됨 → 설정에 `query_model`/`passage_model` 두 필드 필요. 1세대 Embed는 2026-12-31 서비스 종료 |
| ~~Claude~~ | — | — | 임베딩 API 없음 |
| ~~EmbeddingGemma~~ | — | Gemma 이용약관 | Apache-2.0이 아니라 기본값에서 제외 |

- 벡터 테이블에 `embedding_model`을 함께 저장하고, 설정된 모델과 다르면 **재색인을 강제**한다(서로 다른 모델의 벡터는 같은 공간에서 비교할 수 없음).
- 청크 단위는 VAD 세그먼트를 묶은 300–500자 정도로 하고, 원본 `segment_ids`와 시각을 함께 저장한다.

### 4.3 검색

- **SQLite + FTS5 + sqlite-vec**를 쓴다. 단일 파일이고 서버가 필요 없다. sqlite-vec은 0.1.x(pre-1.0)라 버전을 고정하며, 개인 규모(수십만 청크)에서는 brute-force KNN으로 충분하다.
- **한국어 키워드 검색 주의:** FTS5 `trigram` 토크나이저는 3글자 미만 질의를 찾지 못하는데, "예산"·"회의"처럼 2음절 단어가 대부분이다. 앱에서 **음절 bigram으로 전처리한 텍스트를 FTS5(unicode61)에 넣는다.** 의존성이 없고 몇 줄이면 된다. 형태소 분석기(Kiwi 등)는 정확도가 실측으로 부족할 때만 검토한다.
- 하이브리드 결합은 키워드 결과와 벡터 결과를 **RRF(Reciprocal Rank Fusion)**로 합친다. 리랭커는 기본 경로에서 제외한다.

---

## 5. 에이전트 연동 — MCP 서버

Claude Code, Codex CLI, Gemini CLI가 Tractus를 도구로 쓰도록 **로컬 stdio MCP 서버**를 제공한다. 에이전트는 각자의 구독이나 키로 동작하고, Tractus는 로컬 데이터 조회만 담당한다.

| 도구 | 기능 |
| --- | --- |
| `search_meetings(query, limit)` | 하이브리드 검색 → 세그먼트 + 회의 메타데이터 |
| `get_transcript(meeting_id, start?, end?)` | 전사 본문 (구간 지정 가능) |
| `get_summary(meeting_id)` | summary.md |
| `list_action_items(status?)` | 전체 회의의 할 일 목록 |
| `transcribe(path)` | 로컬 파일 전사 실행 (긴 작업 → 작업 ID 반환) |

- 세 CLI의 등록 방법(`claude mcp add`, Codex `config.toml`, Gemini `settings.json`)은 README에 예시로 제공한다.
- MCP 서버는 LLM을 호출하지 않는다. 요약·추론은 호출한 에이전트가 직접 수행하므로 키가 중복되지 않는다.

---

## 6. 전사 스키마 (transcript.json)

```jsonc
{
  "schema_version": 1,
  "meeting_id": "01J9X...",
  "created_at": "2026-10-01T14:00:00+09:00",
  "title": "주간회의",
  "audio": { "file": "audio.opus", "duration_sec": 3612.4, "source": "주간회의.m4a", "sha256": "…" },  // sha256: 같은 파일 재전사 방지·이어하기 식별
  "asr": { "model": "mlx-community/Qwen3-ASR-1.7B-8bit", "track": "standard", "runtime": "mlx-audio", "language": "auto", "hotwords": ["WTO"] },
  "segments": [
    {
      "id": "s0001",
      "start": 12.34,
      "end": 18.90,
      "text": "다음 분기 budget 부터 보겠습니다",
      "lang": "ko",
      "speaker": null,          // 화자 분리 도입 전까지 항상 null
      "corrected_text": null,   // LLM 교정 결과 (원문 보존)
      "words": null             // ForcedAligner 도입 시 채움
    }
  ]
}
```

---

## 7. 기술 스택

| 영역 | 선택 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| 코어 / CLI / 로컬 API | Python 3.12, FastAPI, Typer | MIT | |
| LLM·임베딩·ASR 클라이언트 | `openai` SDK | Apache-2.0 | 유일한 모델 클라이언트 |
| 검증 | Pydantic v2 | MIT | |
| ASR 런타임 (macOS) | mlx-audio (라이브러리로 직접 호출) | MIT | `hotwords` 때문에 서버 대신 프로세스 안에서 호출 (D1). Windows 대비용은 llama.cpp `llama-server` |
| VAD | Silero VAD v6 (mlx-audio MLX 포팅) | MIT | torch 불필요 |
| 오디오 변환 | FFmpeg (**외부 바이너리로 호출**) | LGPL/GPL | 번들하지 않음 → Apache-2.0 배포물과 분리 |
| 저장 | SQLite + sqlite-vec | Public Domain / MIT·Apache | |
| MCP | 공식 MCP Python SDK | MIT | |
| UI (Phase 4) | Next.js + wavesurfer.js + TipTap, 또는 Tauri 데스크톱 셸 | MIT | Phase 3 이후 결정 |

모델 가중치는 저장소에 포함하지 않고 사용자가 `hf download`로 받는다. 다운로드 링크와 명령은 `README.md`에 있다. 라이선스: Qwen3-ASR · Qwen3-ForcedAligner · Qwen3-Embedding · Gemma 4는 Apache-2.0, Silero VAD는 MIT.

---

## 8. 로드맵

| Phase | 범위 | 완료 기준 |
| --- | --- | --- |
| **0. ASR 선정 (Mac)** ✅ 2026-10-02 | 개발 기기 1대(M3·16GB)에서 4개 모델(Qwen3-ASR 1.7B·0.6B, 대조군 Whisper-turbo, 참고 Nemotron 3.5)을 mlx-audio로 측정. 지표: CER(ko), WER(en), 코드스위칭 MER·PIER, RTF, 최대 메모리, 1시간 파일 완주 여부. 상세는 아래 "Phase 0 실행 계획" | 기본·저사양 트랙의 모델 확정 |
| **1. 전사 CLI** ✅ 2026-10-02 | `tractus transcribe <file>` → §4.1 레이아웃 생성. VAD 청킹, 이어하기, 용어집 | 1시간 한국어 회의를 두 트랙 모두에서 완주 → AI Hub 66분 회의: lite 4.1분(CER 9.22%), standard 10.1분(CER 7.23%). Ctrl+C·`kill -9` 후 재실행으로 173/173 청크 복구 |
| **2. LLM 연동** 🔶 2026-10-02 | 공급자 설정, 요약·Action Item, 검증·재시도, 5개 공급자 스모크 테스트 | 같은 전사로 5개 공급자 모두 스키마 통과 → **Upstage(solar-pro4) 통과**(재요청 없이 3/3, 1회 7초). OpenAI·Claude·Gemini는 API 키를 받는 대로 `pytest -m llm`으로 확인. 키가 끝내 없으면 Phase 3 MCP로 각 CLI에서 품질을 본다 |
| **3. 검색 + MCP** | 임베딩, FTS5 bigram, RRF, MCP 서버, 3개 CLI 등록 가이드 | Claude Code·Codex·Gemini CLI에서 과거 회의 질의 성공 |
| **4. UI + 녹음** | 플레이어-텍스트 동기화, 메모 편집, 브라우저/데스크톱 녹음 | |
| 이후 | 화자 분리(§2.4 C), 단어 타임스탬프, 실시간 전사(Nemotron 3.5 재평가), **Windows 지원(llama.cpp GGUF 경로)** | 필요가 확인될 때 |

### Phase 0 실행 계획

#### 환경 (2026-10-01 확정)

| 항목 | 결정 |
| --- | --- |
| 테스트 기기 | **현재 개발 기기 1대만 쓴다.** Apple M3(8코어), 통합 메모리 16GB, macOS 26.6. 다른 기기와 비교하지 않는다 |
| 저사양(8GB) 판정 | 8GB Mac은 직접 측정할 수 없다. 0.6B의 **최대 메모리 예산**으로 대신 판정한다(아래 판정 기준) |
| 런타임 | **mlx-audio 하나.** Qwen3-ASR·Whisper·Nemotron 3.5를 모두 지원해 네 모델을 같은 런타임에서 비교할 수 있다. llama.cpp Q8_0 측정은 Windows 지원 단계로 미룬다 |
| 모델 저장 위치 | 저장소 안 `models/` (`.gitignore` 처리됨). 예: `hf download mlx-community/Qwen3-ASR-1.7B-8bit --local-dir models/qwen3-asr-1.7b-8bit` |
| 데이터셋 저장 위치 | 저장소 안 `data/` (`.gitignore` 처리됨). AI Hub 데이터는 재배포가 금지되므로 커밋하지 않는다 |

#### 모델과 역할

| 모델 | 가중치 (`models/` 아래) | 역할 | 이 비교로 답할 질문 |
| --- | --- | --- | --- |
| Qwen3-ASR-1.7B 8bit | `mlx-community/Qwen3-ASR-1.7B-8bit` | 기본 트랙 후보 | — |
| Qwen3-ASR-0.6B 8bit | `mlx-community/Qwen3-ASR-0.6B-8bit` | 저사양 트랙 후보 | — |
| Whisper-large-v3-turbo | `mlx-community/whisper-large-v3-turbo` | **대조군** | Qwen3-ASR이 가장 널리 쓰이는 기본값보다 실제로 나은가 |
| Nemotron 3.5 ASR Streaming 0.6B | `mlx-community/nemotron-3.5-asr-streaming-0.6b` | **참고** (실시간 트랙 예비 후보) | 같은 0.6B급에서 정확도를 얼마나 잃고, 속도·메모리를 얼마나 얻는가 |

#### 공정 비교 규칙

- 네 모델 모두 같은 파이프라인(§2.3: FFmpeg 16kHz mono → Silero VAD 청킹 → mlx-audio)을 거친다. 모델마다 바뀌는 것은 모델 경로뿐이다.
- 같은 오디오, 같은 청크 경계, 같은 텍스트 정규화, 같은 채점 스크립트를 쓴다.
- 언어 설정은 두 조건으로 잰다: 자동 감지, 고정(`ko`, Nemotron은 `ko-KR`).
- Nemotron은 파일 전사에 가장 유리한 1.12초 청크로 돌린다. 지연 시간별 측정(80ms–560ms)은 실시간 트랙이 로드맵에 올라올 때 한다.
- 용어집 프롬프트 비교는 Qwen3-ASR(context)과 Whisper(`initial_prompt`)만 한다. Nemotron(RNN-T)은 프롬프트 입력이 없다.
- 모델 로드 시간은 RTF에서 뺀다. 워밍업 1회 뒤에 잰다.

#### 데이터셋

| # | 데이터셋 | 측정 대상 | 사용 분량 | 라이선스·입수 |
| --- | --- | --- | --- | --- |
| D-1 | FLEURS `ko_kr` test ([google/fleurs](https://huggingface.co/datasets/google/fleurs)) | **파이프라인 검증.** 공개 수치(1.7B 2.57%, 0.6B 3.72%, Nemotron 7.12%)를 재현하는지 확인 | test 전체 (낭독체 짧은 발화) | CC-BY-4.0, 바로 다운로드 |
| D-2 | HiKE ([thetaone-ai/HiKE](https://huggingface.co/datasets/thetaone-ai/HiKE)) | **한·영 코드스위칭.** MER, PIER, 단어·구·문장 수준별 오류 | 1,121개 발화 전체 (2–25초, 자연 발화, 개발·비즈니스·의료 등 주제) | Apache-2.0, 비게이트 |
| D-3 | AI Hub 주요 영역별 회의 음성인식 데이터 ([dataSetSn=464](https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=464)) | **한국어 실제 회의.** CER, 겹침 발화·잡음 구간 | Validation에서 30–60분 회의 3건 | 내국인만 신청 가능, 승인 필요, 재배포 금지 |
| D-4 | AMI Meeting Corpus ([edinburghcstr/ami](https://huggingface.co/datasets/edinburghcstr/ami) `ihm` test) | **영어 회의.** WER | test 16개 회의(약 9시간) 중 3건 | CC-BY-4.0 |
| D-5 | 1시간 장시간 파일 | **완주 여부, 반복 출력, 최대 메모리, RTF** | 1건. D-3 또는 AMI Mix-Headset 원본 중 가장 긴 회의를 쓰고, 60분이 안 되면 이어 붙인다 | D-3·D-4와 같음 |

- D-1에서 우리 CER이 공개 수치와 1%p 넘게 다르면 파이프라인이나 정규화가 잘못된 것이다. 이를 먼저 고치고 D-2 이후로 넘어간다.
- D-3은 데이터를 받은 뒤 원본이 회의 세션 단위인지 발화 단위인지 확인한다. 발화 단위면 같은 세션의 발화를 시간순으로 이어 붙여 정답 전사를 만든다.
- 직접 녹음한 한·영 혼용 회의는 선택 사항이다. D-2와 D-3이 공개 데이터로 코드스위칭과 장시간 회의를 각각 덮는다. 다만 "장시간 + 코드스위칭"을 함께 덮는 공개 데이터는 없다. 판정이 애매하면 1건을 녹음하고 수작업으로 교정한 전사를 만들어 추가한다.

#### 지표와 채점

| 지표 | 계산 방법 |
| --- | --- |
| CER (ko) | `jiwer`. 문장부호와 공백을 지운 뒤 문자 단위로 계산하고, 영어는 소문자로 바꾼다. 숫자 표기 차이("3개" vs "세 개")는 정규화하지 않고 오류로 둔 뒤, 표본 검토에서 비중을 확인한다 |
| WER (en) | Whisper `EnglishTextNormalizer`를 적용한 뒤 `jiwer`로 계산한다 |
| MER · PIER | **HiKE 공식 평가 스크립트를 그대로 쓴다**(`BaseASR` 인터페이스 구현). 논문 수치와 바로 비교할 수 있다 |
| RTF | 처리 시간 ÷ 오디오 길이 |
| 최대 메모리 | MLX 피크(`mx.get_peak_memory()`)와 프로세스 RSS(`/usr/bin/time -l`)를 함께 기록한다 |
| 반복 출력 | D-5에서 같은 문장이 연속 3회 이상 나온 구간의 수 |
| 완주 | D-5를 크래시나 중단 없이 끝내는지 |

#### 실험 매트릭스

| 실험 | 모델 | 데이터셋 | 조건 |
| --- | --- | --- | --- |
| E1 기본 비교 | 4개 전부 | D-1 ~ D-4 | 언어 고정. 자동 감지는 D-2·D-3만 (D-1·D-4는 단일 언어) |
| E2 장시간 | 4개 전부 | D-5 | 언어 고정 |
| E3 용어집 | 1.7B, Whisper | D-3 | 용어집 없음 / 있음. D-2는 정답을 보지 않고 만들 용어집이 없어 제외 |
| E4 청크 길이 | 1.7B | D-3 | 15초 / 30초 / 60초 |
| E5 4bit (조건부) | 0.6B 4bit | D-2, D-3, D-5 | 0.6B 8bit가 메모리 예산을 넘을 때만 → **실행 안 함**(피크 2.0GB) |

#### 판정 기준

- **기본 트랙:** 1.7B가 D-2 MER과 D-3 CER에서 모두 Whisper보다 낮고, D-5를 완주하며, RTF ≤ 0.2(1시간 회의를 12분 안에)이면 확정한다. Whisper가 어느 한쪽에서라도 이기면 §2.2를 다시 검토한다.
- **저사양 트랙:** 0.6B의 D-5 최대 메모리가 3GB 이하이고(8GB Mac에서 OS·브라우저와 함께 돌린다고 가정), D-2·D-3에서 Whisper보다 나쁘지 않으면 확정한다. 메모리 예산을 넘으면 E5를 돌린다.
- **Nemotron:** 트랙 결정에는 쓰지 않는다. 0.6B 대비 정확도 차이와 RTF·메모리를 기록해 실시간 트랙 재평가 자료로 남긴다. 단 D-3 CER이 0.6B보다 낮으면 저사양 후보로 올린다.
- **파이프라인 기본값:** E1의 언어 조건, E3의 용어집, E4의 청크 길이 결과로 Phase 1 기본값을 정한다.

#### Phase 0 결과 (2026-10-02)

28회 실행, 오류 0건. 재현 방법과 전체 표는 `bench/`(`setup.sh --phase0` → `run_all.sh` → `run_extra.sh` → `rescore.py` → `report.py`)와 `bench/results/REPORT.md`에 있다. 판정 후 비교 모델(Whisper·Nemotron)은 로컬에서 지웠고, `setup.sh`는 기본으로 확정 모델 2개만 받는다.

**결론: 기본 트랙 1.7B, 저사양 트랙 0.6B로 확정한다. Phase 1 기본값은 언어 자동 감지, Qwen3-ASR `hotwords` 용어집 사용, 최대 30초 청크다.**

| 모델 | FLEURS-ko CER | HiKE MER (고정 / 자동) | AI Hub 회의 CER | AMI WER | RTF (AI Hub) | 피크 메모리 (AI Hub) |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-ASR-1.7B | **2.62** | 28.3 / **24.1** | **9.49** | **9.50** | 0.136 (1시간 → 8.2분) | 3.63 GB |
| Qwen3-ASR-0.6B | 3.92 | 87.6 / 26.1 | 11.47 | 10.14 | **0.055** (1시간 → 3.3분) | 2.00 GB |
| Whisper-turbo (대조군) | 3.08 | 27.7 / 26.6 | 14.92 | 14.28 | 0.100 | 2.15 GB |
| Nemotron 3.5 (참고) | 7.02 | 59.4 / 45.1 | 10.93 | 14.13 | 0.127 | 2.02 GB |

- 모든 수치는 낮을수록 좋다. FLEURS는 네 모델 모두 공개 수치와 0.5%p 안에서 재현됐다(파이프라인 검증 통과).
- AI Hub는 승인받은 **샘플 4개 세션(66–90분, 공중파 토론, 의료 분야, 총 5.2시간)**만 썼다. 분야가 하나뿐이라 절대값보다 모델 간 순위를 봐야 한다.

**판정**

| 항목 | 기준 | 결과 | 판정 |
| --- | --- | --- | --- |
| 기본 트랙 1.7B | D-2 MER·D-3 CER 모두 Whisper보다 낮음, D-5 완주, RTF ≤ 0.2 | MER 24.1 vs 26.6(자동 감지 기준), CER 9.49 vs 14.92, 4세션 완주, RTF 0.136 | ✅ 확정 |
| 저사양 트랙 0.6B | D-5 피크 ≤ 3GB, D-2·D-3에서 Whisper보다 나쁘지 않음 | 피크 2.0GB, MER 26.1 vs 26.6, CER 11.47 vs 14.92 | ✅ 확정 (언어 자동 감지 조건) |
| Nemotron | D-3 CER이 0.6B보다 낮으면 저사양 후보 | 10.93 < 11.47로 **조건 충족** | ❌ 후보에서 제외 (아래) |

- **1.7B와 Whisper의 HiKE 비교:** 언어 고정 조건 평균은 Whisper가 0.6포인트 앞선다(27.7 vs 28.3). 하지만 1.7B 중앙값이 15.4로 Whisper(18.2)보다 낮고, 평균 차이는 영어 위주 문장 몇 건의 번역 오류 때문이다. 실제 기본값인 자동 감지에서는 1.7B가 앞선다.
- **Nemotron을 저사양 후보에서 뺀 이유:** 회의 CER 조건은 충족했다. 그러나 1순위 요구사항인 한·영 코드스위칭(§2.1)에서 MER 45.1로 다른 모델의 두 배에 가깝다. 영문 약어를 한글 발음으로 적어 용어 재현율도 1.1%다(1.7B 72%). 속도도 0.6B보다 2.3배 느리다. 실시간 트랙 예비 후보 지위는 유지한다.

**Phase 1에 반영할 발견**

| 발견 | 근거 | Phase 1 반영 |
| --- | --- | --- |
| 언어를 `ko`로 고정하면 영어 위주 발화를 한국어로 **번역**하고, 0.6B는 반복 루프에 빠진다 | 0.6B HiKE MER 87.6(고정) → 26.1(자동), MER 100% 초과 58건. Nemotron은 영어 발화를 아예 출력하지 않음(빈 출력 150/1121) | **언어 기본값 = 자동 감지.** 한국어 회의에서는 차이 없음(1.7B 9.49 → 9.48) |
| LLM형 디코더의 반복 루프 | 한 발화에서 같은 구절이 11,000자 넘게 반복 | 청크 길이에 비례한 `max_tokens` 상한, 반복 감지 시 언어 자동 감지로 재시도 |
| Qwen3-ASR `hotwords` 용어집은 효과가 있다 | 용어 재현율 71.6% → 84.2%, CER 9.49 → 9.36, 부작용 없음 | 용어집 기본 사용 |
| Whisper `initial_prompt`에 영문 용어만 나열하면 출력이 영어로 끌려간다 | 한 세션의 영문 비율 1.2% → 26.8%, CER 16.7 → 58.3 | 어댑터가 모델별로 용어집 주입 방식을 다르게 처리 |
| 청크 길이 영향은 작다 | 15초 9.69 / 30초 9.49 / 60초 9.39, RTF는 같은 수준 | **30초 유지.** 60초와의 차이(0.1%p)는 세션 4개 기준 잡음 수준이고, 청크가 길면 피크 메모리가 늘고 반복 루프 한 번의 손실이 커진다 |
| 짧은 발화가 많으면 Whisper가 느려진다 | AMI RTF 0.43 (30초 고정 입력 창) | 해당 없음 (Whisper 미채택) |

---

## 9. 열린 질문

1. 기본 실행 형태: CLI + 로컬 웹 UI vs 데스크톱 앱(Tauri). 녹음 UX 때문에 결국 데스크톱이 유리할 가능성이 큼
2. Gemma 4 31B 배치: 사용자 기기 vs 팀 공용 서버. VRAM 경합(§2.2) 정책이 여기에 달려 있음
3. 클라우드 ASR 옵션을 UI에 노출할지, 설정 파일에만 둘지
4. ~~제품명~~ → **해결 (2026-10-01): `Tractus`로 변경** (§변경 이력 참고). 공개 전 상표(KIPRIS·USPTO)·도메인·GitHub org·PyPI 패키지명 선점 확인은 여전히 필요

---

## 참고 자료

- Qwen3-ASR: [GitHub](https://github.com/QwenLM/Qwen3-ASR) · [Technical Report](https://arxiv.org/html/2601.21337v2) · [mlx-audio Qwen3-ASR](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/qwen3_asr/README.md) · [mlx-audio](https://github.com/Blaizzy/mlx-audio) · [MLX 8bit (speech-swift용)](https://huggingface.co/aufklarer/Qwen3-ASR-1.7B-MLX-8bit) · [GGUF (unsloth)](https://huggingface.co/unslothai/Qwen3-ASR-1.7B-GGUF) · [llama.cpp 양자화 벤치](https://github.com/shershah1024/qwen3-asr-llamacpp) · [llama.cpp 반복 출력 버그 #22357](https://github.com/ggml-org/llama.cpp/issues/22357) · [asr_text 출력 이슈 #26749](https://github.com/ggml-org/llama.cpp/issues/26749) · [vllm-metal STT](https://docs.vllm.ai/projects/vllm-metal/en/latest/stt/)
- speech-swift: [GitHub](https://github.com/soniqo/speech-swift)
- Nemotron 3.5 ASR Streaming: [Hugging Face](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) · [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) · [OpenMDW-1.1](https://openmdw.ai/license/1-1/)
- 제외 모델: [Fun-ASR-Nano-2512 LiteRT](https://huggingface.co/litert-community/Fun-ASR-Nano-2512) · [Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)
- transcribe.cpp (GGUF 다중 ASR 런타임): [GitHub](https://github.com/handy-computer/transcribe.cpp)
- Whisper-large-v3-turbo: [Hugging Face](https://huggingface.co/openai/whisper-large-v3-turbo)
- Fun-ASR: [MLT-Nano-2512](https://huggingface.co/FunAudioLLM/Fun-ASR-MLT-Nano-2512) · [GitHub](https://github.com/QwenAudio/Fun-ASR) · SenseVoice 라이선스 이슈: [Sipher #16](https://github.com/Eiriksb/Sipher/issues/16)
- Cohere Transcribe: [Hugging Face](https://huggingface.co/OpenASR/cohere-transcribe-03-2026)
- Gemma 4: [Model card](https://ai.google.dev/gemma/docs/core/model_card_4) · [31B-it](https://huggingface.co/google/gemma-4-31B-it) · [Apache-2.0 전환](https://the-decoder.com/googles-gemma-4-is-now-available-with-apache-2-0-licensing-for-the-first-time/)
- Claude OpenAI SDK 호환: [Docs](https://platform.claude.com/docs/en/api/openai-sdk)
- Gemini OpenAI 호환: [Docs](https://ai.google.dev/gemini-api/docs/openai)
- Upstage: [Solar Pro 3](https://www.upstage.ai/blog/en/solar-pro-3-0127) · [Chat API](https://console.upstage.ai/api/chat) · [Embeddings API](https://console.upstage.ai/api/embeddings)
- LiteLLM 공급망 침해: [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/)
- 임베딩: [Qwen3 Embedding](https://arxiv.org/pdf/2506.05176) · [EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma)
- 검색: [sqlite-vec 하이브리드 검색](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html) · [sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases) · [한국어 trigram 이슈](https://github.com/chroma-core/chroma/issues/1073)
- pyannote community-1: [블로그](https://www.pyannote.ai/blog/community-1)
- 데이터: [AI Hub 회의 음성](https://aihub.or.kr/aidata/30709) · [주요 영역별 회의 음성인식 데이터](https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=464)
