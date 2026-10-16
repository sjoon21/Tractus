## 요약

<!-- 무엇을 왜 바꾸는지 한두 문장 -->

## 변경

-

## 테스트 계획

- [ ] `uv run pytest` / `cd app && pnpm test && pnpm build` / `cargo test` / `swift test` (CI가 같은 것을 돈다)
- [ ] 사용자 문구를 바꿨으면 `scripts/check_words.sh` (WORDS.md §5)
- [ ] 새 의존성이 있으면 `uv run python scripts/check_licenses.py` (copyleft 금지)
- [ ] 화면을 바꿨으면 `/preview.html`에서 라이트·다크, 폭 900·1280·1600
- [ ] 프롬프트·스키마를 바꿨으면 `uv run pytest -m llm` (가상 회의만, CI에서는 돌지 않는다)

## 알려진 한계

-
