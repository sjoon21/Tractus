# 기여 안내

이슈와 풀 리퀘스트를 환영합니다. 큰 변경은 먼저 이슈로 의견을 나눠 주세요.

## 저장소 구성

```text
ARCHITECTURE.md   설계 백본 (결정 사항, 변경 이력, 로드맵, Phase 0 결과)
CLAUDE.md         에이전트·기여자 작업 지침 (모델·파이프라인 기본값, 데이터 규칙)
WORDS.md          화면에 보이는 말의 용어표와 금지어 검사
src/tractus/      코어: CLI, 변환, 참석자 구분, 요약, 질문, 검색, MCP
app/              Tauri 2 데스크톱 앱 (Rust + React + TypeScript + Tailwind v4). 화면 규칙은 app/DESIGN.md
recorder/         Swift 패키지: 녹음 프로그램 tractus-rec (diar/: 도우미 tractus-diar)
scripts/          bootstrap.sh (개발 도구 설치), install.sh (빌드), update.sh (업데이트), clean.sh (빌드 산출물 정리),
                  build_app_bundle.sh (미리 만든 앱), make_dmg.sh (.dmg)
Brewfile          bootstrap.sh가 읽는 도구 목록
docs/             설치(setup), 사용법(usage), CLI(cli), MCP(mcp), 동작 방식(how-it-works), 모델(models),
                  AI 서비스(ai-services), 앱 계약(desktop), 로드맵(roadmap), 공급자(llm-providers), 스크린샷(images/)
tests/            pytest (가상 회의 fixtures)
bench/            Phase 0 벤치마크와 평가 스크립트 (지표 요약과 리포트만 커밋)
```

```bash
uv run pytest                       # 단위·CLI 테스트 (모델·API 키 불필요)
uv run pytest -m slow               # 실제 모델 테스트 (models/ 필요)
uv run pytest -m llm                # 실제 LLM API 스모크 (키가 있는 공급자만)
uv run python bench/search_eval.py  # 검색 평가 (가상 회의)
uv run python bench/ask_eval.py     # AI 질문 평가 (가상 회의, 설정된 LLM 호출)
cd app && pnpm install && pnpm test && pnpm build   # 앱: vitest, tsc, vite
cd app/src-tauri && cargo test                      # 앱 Rust 테스트
(cd recorder && swift build -c release && swift test)       # 녹음 프로그램 (Swift 5.10 이상)
(cd recorder/diar && swift build -c release && swift test)  # 9명 이상 구분 도우미 (Swift 6.2 이상)
scripts/build_app_bundle.sh --check && scripts/make_dmg.sh --check   # 미리 만든 앱·.dmg 도구 확인 (만들기는 docs/setup.md §10)
cd app && pnpm tauri dev                            # 개발 실행 (브라우저 미리보기: http://localhost:1420/preview.html, 가짜 데이터)
```

화면에 보이는 문구를 바꿨다면 커밋 전에 [WORDS.md §5](WORDS.md)의 금지어 검사를 저장소 루트에서 돌립니다. 출력이 없으면 통과입니다(`rg`가 PCRE2를 지원해야 합니다).

## 기여하기

1. 저장소를 포크하고 브랜치를 만듭니다 (`git checkout -b feat/기능-이름`)
2. 변경과 테스트를 함께 작성하고 `uv run pytest`와 `cd app && pnpm test`를 통과시킵니다
3. 커밋 메시지는 `<type>: <설명>` 형식입니다. type은 `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci` 중 하나로 영문 그대로 쓰고, 설명과 본문은 한국어로 씁니다
   ```text
   feat: 노트 제목 수정 추가
   ```
4. 브랜치를 올리고 풀 리퀘스트를 엽니다. GitHub Actions(`CI`)가 Apple Silicon Mac에서 다음을 돌리고, 모두 통과해야 main에 합칠 수 있습니다
   - 코어 `pytest`(모델·실제 AI·내려받기 테스트는 빼고)
   - 앱 `pnpm test`·`pnpm build`·`cargo test`
   - 녹음 프로그램 `swift test`
   - 금지어 검사 `scripts/check_words.sh`, copyleft 검사 `scripts/check_licenses.py`

기여 전에 알아 둘 규칙은 [CLAUDE.md](CLAUDE.md)에 있습니다.

- 설계 결정을 바꾸려면 [ARCHITECTURE.md](ARCHITECTURE.md)부터 고칩니다. 새 벤치마크 없이 ASR 모델을 바꾸거나 추가하지 않습니다.
- 사용자에게 보이는 말은 [WORDS.md](WORDS.md)를 따릅니다 (`노트`, `텍스트로 변환`, `참석자`).
- 표시 텍스트는 `store.seg_text(s)`로 읽습니다. 원문 `text`는 바꾸지 않습니다.
- `models/`, `data/`, `bench/results/raw/`, API 키는 커밋하지 않습니다. AI Hub 데이터와 그 전사는 재배포가 금지되어 있고, 원격 LLM에도 보내지 않습니다.
- copyleft 의존성(GPL, LGPL 등)을 넣지 않습니다. `uv run python scripts/check_licenses.py`가 Python·npm·Rust 의존성을 검사합니다.
- 보안 문제는 공개 이슈가 아니라 [SECURITY.md](SECURITY.md)의 비공개 신고로 알려 주세요.
