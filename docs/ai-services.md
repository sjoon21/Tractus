# AI 서비스와 키

**한국어** · [English](en/ai-services.md)

요약과 AI 질문은 LLM API가 필요합니다. 키가 없어도 녹음, 변환, 검색, 내보내기는 모두 됩니다.

- **앱:** 설정 › `AI 요약·질문`에서 AI 서비스(Upstage·OpenAI·Claude·Gemini·직접 입력)를 고르고 서비스 주소·API 키·AI 모델을 입력한 뒤 `연결 테스트`를 누릅니다(입력한 내용을 먼저 저장합니다). 키는 서비스마다 따로 앱 설정 폴더(`~/Library/Application Support/dev.tractus.app/`)에만 저장되고 노트 폴더에는 쓰지 않습니다. 서비스 주소는 기본값이 미리 채워져 있고, OpenAI·직접 입력은 AI 모델 이름을 직접 적어야 하고, Gemini는 비워 두면 항상 최신 Flash(`gemini-flash-latest`)를 씁니다. `직접 입력`은 OpenAI와 호환되는 서비스(OpenRouter, 사내 게이트웨이, Ollama 등)의 주소와 키를 넣는 칸이고, 이 Mac의 주소(`localhost`)는 키 없이 쓸 수 있습니다. 서비스마다 주소·AI 모델·키를 따로 저장하고(`등록됨`/`미등록`), 둘 이상 등록하면 요약 탭과 AI 질문 입력창의 서비스 단추(로고와 이름)에서 그때그때 고릅니다(처음 값은 `기본으로 사용`). `AI 모델 목록 불러오기`는 서비스가 아는 AI 모델 이름을 AI 모델 칸의 제안으로 보여 줍니다. API 키는 5자부터 저장됩니다. `스마트 검색 방식`에서 스마트 검색을 Upstage로 바꿀 수 있고(Upstage 키 필요, 노트 내용과 검색어가 Upstage로 전송됩니다), 이 Mac(기본)으로 되돌릴 수 있습니다.
- **터미널:** 저장소 루트의 `.env.local`(git 제외)에 넣습니다. 우선순위는 셸 환경변수 > `.env.local` > `.env`입니다. `uv run tractus llm test --provider claude`로 연결을 시험합니다.

```bash
# .env.local
UPSTAGE_API_KEY=up_...
```

### 요약·결정 사항·할 일

공급자는 OpenAI 호환 API 키 방식만 씁니다. `TRACTUS_LLM_PROVIDER`나 `--provider`로 고르고, `TRACTUS_LLM_BASE_URL`로 서비스 주소를, `TRACTUS_LLM_MODEL`로 AI 모델을 바꿉니다. 서비스마다 따로 두려면 `UPSTAGE_`·`OPENAI_`·`ANTHROPIC_`·`GEMINI_` 뒤에 `BASE_URL`·`MODEL`을 붙인 변수를 씁니다(`.env.example`). 우선순위는 인수 > 전역 값(`TRACTUS_LLM_PROVIDER`가 그 서비스이거나 비었을 때만) > 서비스별 값 > 기본값입니다. 서비스가 알려 주는 AI 모델 ID는 `uv run tractus llm models --provider gemini`로 봅니다.

| 공급자 | 키 | 기본 모델 | 상태 |
| --- | --- | --- | --- |
| `upstage` | `UPSTAGE_API_KEY` | `solar-pro4` | 검증됨 |
| `openai` | `OPENAI_API_KEY` | 없음 (`--model` 필요) | 키 대기. 온도를 보내지 않는다 (gpt-5·o 계열이 거절) |
| `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | 키 대기. 호환 계층으로 연결하며 온도를 보내지 않는다 |
| `gemini` | `GEMINI_API_KEY` | `gemini-flash-latest` (별칭. `gemini-2.5-flash`는 새 사용자에게 404) | 요약 검증됨. 주소 `https://generativelanguage.googleapis.com/v1beta/openai` |
| `custom` | `TRACTUS_LLM_API_KEY` (`localhost` 주소면 생략) | 없음 (`TRACTUS_LLM_BASE_URL`·`--model` 필요) | OpenAI 호환 서비스 |
| `gemma-local` | 없음 (`localhost:11434`) | `gemma4:31b` | 로컬 서버 필요 |

앱에서는 Upstage·OpenAI·Claude·Gemini·직접 입력(`custom`)의 키를 서비스별로 등록할 수 있습니다. 실제 서버로 확인한 것은 Upstage 요약·Gemini 요약·연결 테스트·AI 모델 목록뿐이고, OpenAI·Claude는 키가 없는 가짜 서버로만 시험했습니다. `TRACTUS_LOCAL_ONLY=1`이면 주소의 호스트가 이 Mac(`localhost`·`127.0.0.1`·`::1`)이 아닌 서비스를 막습니다. 구독형 CLI(`claude -p`, `codex exec`, `agy`)는 약관 문제로 공급자로 쓰지 않습니다(ARCHITECTURE.md §0).

### 검색 임베딩 (선택)

기본은 이 Mac의 Qwen3-Embedding입니다. `TRACTUS_EMBED=upstage`(앱은 설정)로 바꾸면 Upstage `solar-embedding-2`를 씁니다. **노트의 문장(색인할 때)과 검색어(검색할 때)가 Upstage로 전송됩니다.** 키는 `UPSTAGE_API_KEY`(주소는 `UPSTAGE_BASE_URL`)이고, 바꾸면 벡터가 다시 만들어집니다. 키가 없거나 호출이 실패하면 단어 일치 검색으로 물러납니다. 검색 품질은 아직 `bench/search_eval.py`로 재지 않았습니다.
