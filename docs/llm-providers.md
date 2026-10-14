# 사용자 LLM 연결 — 도입 결정 메모 (2026-10-14)

배포 전 마지막 기능: 사용자가 자기 API 키로 원하는 LLM을 쓰게 한다. 공급자마다 코드를 직접 짜고 유지하지 않고, 쓸 수 있는 오픈소스가 있으면 쓰고 싶다는 요청에 대한 조사 결과다. 사실은 2026-10-14에 PyPI·GitHub·공식 문서에서 확인했다. 확인 못 한 것은 "미확인"으로 적었다.

## 1. 결론

**새 라이브러리를 들이지 않는다. 지금 쓰는 `openai` SDK를 그대로 두고, "공급자 목록(프리셋 표) + 사용자 지정 OpenAI 호환 주소" 기능을 만든다.** OpenAI, Gemini, OpenRouter, Mistral, DeepSeek, Groq, Together, Upstage, Ollama, LM Studio, llama.cpp는 모두 `base_url`과 키만 다른 같은 방식(Chat Completions)으로 부를 수 있다. 유지할 것은 공급자별 코드가 아니라 한 줄짜리 표(주소, 기본 모델, JSON 스키마 지원 여부)다. 요약·질문에 쓰는 구조화 출력은 이미 "프롬프트에 스키마 + Pydantic 검증 + 1회 재시도"로 돼 있어서, 엄격 스키마를 지원하지 않는 공급자도 그대로 돌아간다.

**LiteLLM은 쓰지 않는다.** 기능은 가장 넓지만(공급자 약 165개) 설치 크기가 195MB(지금 openai만이면 약 23MB), 네이티브 확장 22개를 코드서명해야 하고, 기본값으로 import 때 GitHub에 접속하며, 2026-03에 PyPI 계정이 탈취돼 악성 버전(1.82.7, 1.82.8)이 올라갔던 이력이 있다. 이 악성 코드는 환경변수에서 키를 훔쳐 가는 종류였다. 사용자 API 키를 다루는 앱에는 맞지 않는다.

**나중에 Claude 정식 지원(Bedrock·Vertex 제외)이 필요해지면** 먼저 직접 짠 어댑터(약 70줄)를 고려하고, 그래도 라이브러리를 원하면 `any-llm-sdk`(Mozilla.ai, Apache-2.0)를 두 번째 후보로 둔다. v1에는 넣지 않는다.

## 2. 비교표

| 선택지 | 라이선스 | 크기·의존성 | 지원 공급자 | 구조화 출력 | 스트리밍 | 텔레메트리 | 보안 이력 | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **openai SDK + 프리셋 + 사용자 지정 주소** (현재 방식 확장) | Apache-2.0 | 14패키지 / 약 24MB (이미 설치됨, 추가 0) | OpenAI 호환이면 모두. Claude·Gemini는 호환 계층 경유 | 엄격 스키마는 공급자별로 다름. 없으면 프롬프트+검증+재시도 | 전 공급자 가능 | 없음. 설정한 주소로만 접속 | 공개 advisory 0, yank 0 | **채택** |
| **LiteLLM** (SDK로만) | 휠은 MIT. 저장소의 `enterprise/` 폴더만 별도 상용 라이선스 (휠에는 없음) | 58패키지 / 195MB, 네이티브 .so 22개, boto3·HF 필수 | 약 165개 | 공급자별 네이티브 방식으로 변환 (요청 모양만 확인, 실서버 미확인) | 가능 | **기본값으로 접속함**: import 때 raw.githubusercontent.com. 환경변수 3개로 끌 수 있음 | 2026-03 PyPI 탈취(키·환경변수 탈취 코드). 저장소 advisory 17건(프록시 쪽) | 비채택 |
| **any-llm-sdk** (Mozilla.ai) | Apache-2.0 | 코어 26패키지 / 40MB (openai+anthropic SDK가 대부분). 공급자별 extra는 추가 | 53개 | Anthropic·Gemini·Ollama 등 공급자별 변환 (소스로만 확인) | 가능 | 코어에는 없음. `[platform]`·`[otari]`·`[all]` extra는 Mozilla.ai 서비스 연동이라 쓰지 않음 | advisory 0, PyPI 출처 증명(attestation) 있음 | 후보 (v1 이후) |
| aisuite | MIT (PyPI 메타데이터에는 비어 있음) | 코어 10MB. 하지만 openai extra가 `openai<2`를 요구해 현재 `>=3.23`과 충돌 | 28개 | **없음**. Anthropic은 오류, Gemini는 조용히 무시 | 가능 | 없음 | advisory 0, 출처 증명 없음 | 비채택 |
| pydantic-ai-slim | MIT | `[openai]` 26패키지 / 42MB, Claude·Gemini 추가 시 40패키지 / 79MB | 많음 (공급자별 SDK 필요) | 가능 (Native/Tool/Prompted) | 가능 | 기본은 없음. 첫 실행 때 홍보 배너를 stderr에 출력 (`PYDANTIC_AI_NO_BANNER=1`로 끔) | 주변 기능 advisory 12~16건, 코어 경로는 해당 없음 | 보류 (에이전트 프레임워크라 과함) |
| instructor | MIT | 41패키지 / 39MB, `jiter<0.15` 등 상한 핀 | 약 23개 | 있으나 현재 코드보다 약함(strict 미전송) | 구조화 스트리밍만 (일반 텍스트 아님) | 없음 | advisory 0 | 비채택 (이득 없음) |
| rust-genai | MIT OR Apache-2.0 | Rust 크레이트 | 약 30개 | 미확인 | 가능 | 기본 없음 | advisory 0, 1인 유지, 0.7 릴리스 후보 단계 | 비채택 (LLM 로직이 Python에 있음) |
| Vercel AI SDK | Apache-2.0 | npm | 많음 | 가능 | 가능 | 기본 공급자가 Vercel AI Gateway라 `provider/model` 문자열을 쓰면 노트 내용이 Vercel을 거칠 수 있음 | 코어 외 하네스 패키지 advisory 6건 | 비채택 (웹뷰에서 키 노출, CORS) |

출처: PyPI JSON API(`pypi.org/pypi/<패키지>/json`), `gh api repos/<소유자>/<저장소>/security-advisories`, 각 공급자 공식 문서. 이번 메모 작성 시 직접 재확인한 것: `any-llm-sdk` 1.34.0 라이선스 Apache-2.0과 의존성(`openai>=2.18,<4`), `litellm` 1.105.0 라이선스 MIT, PyPI 목록에 악성 1.82.7·1.82.8이 없음. LiteLLM 침해 경위는 https://github.com/BerriAI/litellm/issues/24518 를 근거로 했고 직접 다시 읽지는 않았다. 설치 크기·import 접속 수치는 조사원이 Python 3.12, Apple Silicon에서 측정한 값이다.

## 3. 권장 구조

1. **공급자 목록은 표 하나로 관리한다.** 항목은 이름, 주소, 기본 모델, 엄격 JSON 스키마 지원 여부, 로컬 여부, 온도 정책. 지금은 `llm.py`의 `PROVIDERS`, `app/src/ask.ts`의 `PROVIDERS`, CLI 도움말, `.env.example`, README 등 네 곳에서 따로 적고 있다. 표를 한 곳(코어가 JSON으로 내보냄)으로 합치고 앱은 그것을 읽는다.
2. **UX는 "프리셋 + 직접 입력".** 설정 화면에 프리셋 선택(OpenAI, Gemini, OpenRouter, Mistral, DeepSeek, Groq, Together, Upstage, Claude, Ollama, LM Studio)과 "직접 입력"(주소, 키, 모델 ID, "엄격 JSON 스키마 지원" 체크, 기본 꺼짐)을 둔다. 모델 ID는 사용자가 쓴 그대로 넘긴다. "테스트" 버튼(`GET /models` 또는 아주 짧은 호출)과, 요청이 어디로 가는지(내 Mac / 외부 클라우드) 표시를 둔다. Jan, Obsidian Copilot 등 비슷한 앱들도 같은 구조다.
3. **키 저장은 macOS 키체인.** Tauri(Rust) 쪽에서 `keyring` 크레이트(MIT OR Apache-2.0, v4.2.0, macOS는 `apple-native-keyring-store` 경유)로 저장하고, 키를 웹뷰에 돌려주지 않는다. 요약·질문을 실행할 때만 자식 프로세스 환경변수(`<PROVIDER>_API_KEY`)로 넣는다. 녹음 헬퍼와 `tractus mcp`가 공유하는 `child_env()`에는 넣지 않는다. 설정 파일(`settings.json`), 명령줄 인자, 로그, `chat.json`에는 키를 남기지 않는다. 개발·CLI용 `.env.local`은 그대로 둔다. `tauri-plugin-stronghold`는 마스터 비밀번호가 필요해 쓰지 않는다.
4. **로컬 전용 모드.** 지금은 공급자 이름으로 로컬 여부를 정한다. 사용자 지정 주소가 생기면 이름으로는 판단할 수 없으므로 호스트(`localhost`, `127.0.0.1`, `::1`)로 판단한다. `TRACTUS_LOCAL_ONLY`가 켜져 있으면 그 밖의 주소는 `llm_local_only`로 막는다. 안 하면 사용자 지정 주소가 로컬 전용 모드를 우회한다.
5. **구조화 출력 폴백은 현재 로직을 그대로 쓴다.** 스키마는 항상 프롬프트에 넣고, 표의 `json_schema`가 참인 공급자에만 `response_format`을 추가로 보낸다. 검증 실패 시 1회 재시도. DeepSeek는 `json_object`만 문서화돼 있으니 `json_schema=False`로 둔다. 새 공급자·사용자 지정 주소의 기본값은 `False`다. 이 값으로 공급자 기능 지원 여부를 자동 추론하지 않는다.
6. **온도는 생략할 수 있어야 한다.** Anthropic 문서에 따르면 호환 계층에서 Claude 4.7 이상은 온도 1 미만 값이 400 오류다. 지금 코드는 온도 0.2를 항상 보내고 `claude` 기본 모델이 `claude-sonnet-5-5`라서, 현재 `claude` 공급자는 이미 실패하고 있을 가능성이 크다(미확인, API 호출 안 해봄). 표에 온도 정책(`omit` 가능)을 넣는다.
7. **오류를 구분한다.** 지금은 SDK 오류가 모두 "연결하지 못했습니다"로 나온다. 키 오류(401/403), 사용량 초과(429), 입력이 너무 김, 모델 없음(404), 서버 꺼짐(Ollama 등)을 나누고 문구는 `WORDS.md`를 따른다. `cli.py`가 `openai.APIError`를 직접 잡는 것도 `llm.py`의 자체 예외로 바꾼다.
8. **Claude는 2단계로.** v1은 호환 계층으로 가되 온도를 생략하고(위 6), 엄격 스키마는 끄고 검증+재시도에 맡긴다. 호환 계층은 Anthropic이 "production-ready가 아니다"라고 밝힌 것이 위험이다. 정식 `/v1/messages` 어댑터(약 70줄, `max_tokens` 필수)는 v1.1에서 판단한다.
9. **Azure OpenAI, Bedrock, Vertex는 v1에서 제외한다.** 키 붙여넣기가 아니라 클라우드 자격증명(SigV4, OAuth)이 필요하다. 필요한 사용자는 OpenRouter나 직접 띄운 OpenAI 호환 게이트웨이를 "사용자 지정 주소"로 쓰면 된다.
10. **테스트.** `tests/test_llm.py`의 `FakeClient`는 그대로 유지하거나 `httpx.MockTransport`로 바꾼다. 공급자 표의 필수 필드 검증, 로컬 전용 호스트 판정, 오류 매핑 단위 테스트를 추가한다. 실제 호출은 기존 `uv run pytest -m llm` 스모크(키가 있는 공급자만)로 한다.

유지 부담은 "표 한 줄 추가" 수준이다. 공급자별 코드는 없다.

## 4. 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 공급자 호환 계층의 조용한 무시 (Anthropic `response_format`, Gemini "beta") | 프롬프트+검증+재시도가 항상 최종 안전망. 모르는 공급자는 `json_schema=False` 기본. 공급자별 `-m llm` 스모크로 사전 확인 |
| 사용자 지정 주소로 노트가 엉뚱한 서버에 전송 | 설정 화면과 질문 전 안내문에 목적지 호스트를 표시. 로컬 전용 모드는 호스트로 차단. https 아닌 외부 주소는 경고 |
| 키 유출 | 키체인 저장, 선택한 공급자 호출에만 환경변수로 전달, 로그·`progress-json`·`chat.json`·`settings.json`에 기록 금지. 오류 문구에 요청 헤더를 넣지 않음. 환경변수가 불안하면 stdin으로 전달하도록 바꿀 수 있음 (프로토콜 변경 필요) |
| 공급망 (`openai`는 주 며칠 간격으로 릴리스) | `openai`를 정확한 버전으로 고정하고 `uv.lock`의 해시로 설치 확인. 올릴 때는 `-m llm` 스모크 후에. 나중에 any-llm을 쓰게 되면 같은 방식으로 정확히 고정, `[platform]`·`[otari]`·`[all]`은 설치하지 않음 |
| 키체인 접근 권한이 앱 서명에 묶임 (서명 안 된 개발 빌드는 접근 확인 창이 반복될 수 있음, 일반 동작이고 이 프로젝트에서는 미검증) | 서명된 빌드로 사전 확인. 키를 Python이 직접 읽지 않고 Rust가 환경변수로 전달 |
| 모델 ID·기능이 계속 바뀜 | 기본 모델을 못 박지 않는다 (OpenAI·Gemini는 이미 `None`). 사용자 입력 모델 ID를 그대로 전달. 모델 목록은 선택 사항 |

## 5. 구현 계획

| 순서 | 작업 | 대략 공수 |
| --- | --- | --- |
| 1 | `llm.py`: 공급자 표 확장(온도 정책, 사용자 지정 주소), 자체 예외 정의, 호스트 기반 로컬 판정, 테스트. `claude` 온도 문제 먼저 수정 | 0.5~1일 |
| 2 | `cli.py`: `openai.APIError` 대신 자체 예외로 매핑, 오류 코드 확장. `tractus llm providers --json`으로 표 노출 | 0.5일 |
| 3 | Rust: `keyring` 크레이트로 키 저장·삭제·존재 확인 명령(키는 반환하지 않음). 요약·질문·사용자 지정 요약 세 곳에서만 환경변수 주입 | 1일 |
| 4 | UI: 설정 화면(프리셋, 직접 입력, 테스트 버튼, 목적지 표시), `ask.ts`의 중복 표 제거, `lib.ts` 오류 문구 추가 | 1~1.5일 |
| 5 | 서명된 빌드에서 키체인 동작 확인, 공급자별 `-m llm` 스모크(키 있는 곳만), `.env.example`·README·`CLAUDE.md`·`ARCHITECTURE.md` 갱신 | 0.5~1일 |
| 6 (v1.1) | Claude 정식 어댑터 여부 결정 (직접 약 70줄 또는 any-llm) | 0.5~1일 |

합계 약 3.5~5일(v1 기준). 1~2번을 먼저 끝내면 UI 없이도 `.env.local`로 새 공급자를 바로 시험할 수 있다.

## 6. 오너에게 묻고 싶은 것

1. 배포 시점에 Claude를 정식 지원으로 내세울 것인가? 호환 계층(온도 생략)으로 충분하다고 보면 v1.1로 미룬다. 아니면 5번 이후 바로 어댑터를 추가한다.
2. Azure OpenAI·Bedrock·Vertex 사용자를 v1에서 포기해도 되는가? (OpenRouter 등 게이트웨이를 쓰라고 안내)
3. 사용자 지정 주소에 원격 http(비 https)를 허용할 것인가, 로컬(루프백)만 허용할 것인가?
4. 키 전달 방식을 환경변수로 시작해도 되는가? 같은 사용자의 다른 프로세스가 환경변수를 볼 수 있는지가 마음에 걸리면 stdin 전달로 바꾸는데, 요약·질문의 입력 형식이 바뀐다 (macOS에서 실제 노출 범위는 미확인).
