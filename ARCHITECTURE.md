# Tractus — 아키텍처 백본 v3 (2026-10-01)

> **라이선스: Apache-2.0** · **원칙: Local-first + LLM은 API로 접근**
>
> **제품 정체성(2026-10-08): 메모·노트 앱이다. 녹음은 노트를 텍스트 변환·요약·AI 질문·검색으로 확장하는 기능이다.** 화면에서는 `노트`라고 부르고, 코드·CLI·JSON의 `meeting`(`meetings/`, `meeting_id`)은 그대로 둔다(WORDS.md §2).
>
> v2(서버형·엔터프라이즈 중심)에서 방향을 바꿨다. 사용자의 기기에서 녹음·전사·저장·검색이 끝나고, LLM만 OpenAI 호환 API로 호출한다.
> LLM이 로컬 Gemma 4 31B이든 Claude·OpenAI·Gemini·Upstage이든 **앱 입장에서는 전부 `base_url` + `model`만 다른 같은 API**다.

## 변경 이력

| 날짜 | 버전 | 변경 |
| --- | --- | --- |
| 2026-10-30 | v3.75 | **변환 엔진 목록(브랜치 `feat/engine-list-univa`).** 소유자 불만: 0.5.1의 드롭다운에는 받아 둔 엔진만 있었고, 설치한 앱의 모델 폴더(`~/Library/Application Support/dev.tractus.app/models`)에는 개발 Mac의 `models/custom-models.json`에 넣은 TeamUNIVA 모델이 없었다. ① `asr-ko-univa`(`TeamUNIVA/qwen3_asr_1.7b_ko` 3e66f586, Apache-2.0, bf16 4.7GB, 계열 `qwen3`)를 등록 목록에 올렸다(`level_note: one_of`, 벤치마크 면제: CLAUDE.md 기록). `--preset all`은 약 12GB. ② 모델 화면 `변환 엔진` 드롭다운이 모든 변환 엔진을 보이고, 받지 않은 엔진(`{이름} — 받기 ({크기})`)을 고르면 설정에 저장하고 받기를 시작한다(다 받기 전에는 받아 둔 다른 엔진으로 변환). |
| 2026-10-30 | v3.74 | **0.5.1 릴리스 준비(브랜치 `release/0.5.1`).** 버전 0.5.1을 다섯 매니페스트와 잠금 파일에 맞췄다. ① 사이드바 노트 목록: 날짜별 묶음을 달 머리글(접고 펼침, `SidebarFold.months`에 직접 정한 값만 저장, 기본은 이번 달·지난달·열어 둔 노트가 든 달만 펼침, 거르면 모두 펼침)로 묶고 검색창과 달 머리글을 `sticky`로 붙였다. 검색창(`QuickFind`)은 입력하는 동안 제목이 맞는 노트를 바로 열 수 있게 하고(↑↓·Enter, `quickMatch.ts`), 고르지 않은 Enter는 예전처럼 내용 검색(SearchView)이다. ② 모델 화면 맨 위 `변환 엔진` 드롭다운으로 기본 엔진을 고른다(줄마다 있던 `기본으로 쓰기`·`자동으로 고르기` 단추를 없앴다, 받아 둔 엔진만 고를 수 있음). ③ 코어 `asr.Transcriber._transcribe`: Qwen3 계열이 자동 감지에서 토큰 0개(영어로 오감지)를 내면 그 청크만 한국어로 다시 변환한다(직접 추가한 TeamUNIVA/qwen3_asr_1.7b_ko 간이 점검에서 30초 청크의 27%가 빔: docs/design/asr-engines.md). 직접 추가한 엔진이 있는 개발 Mac에서 실패하던 `test_convert_needs_any_one_transcription_engine`을 빈 모델 폴더 기준으로 고쳤다. 릴리스 노트 `docs/releases/v0.5.1.md`, 로드맵 항목. |
| 2026-10-29 | v3.73 | **0.5.0 릴리스 준비(브랜치 `release/0.5.0`).** 버전 0.5.0을 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)와 잠금 파일에 맞췄다. 0.4.4 이후: 변환 중에도 녹음(v3.71), 내보내기에서 넣을 내용 고르기(v3.72), 시작 때 새 버전을 큰 창으로 알림, 글만 있는 노트의 떠 있는 녹음 추가 단추, 새 앱 아이콘과 사이드바 로고. 이름은 Tractus 그대로(Oat로 바꾸기는 소유자가 취소). README 스크린샷·데모 GIF를 새 아이콘으로 다시 찍었다. 릴리스 노트 `docs/releases/v0.5.0.md`, 로드맵 항목. |
| 2026-10-29 | v3.72 | **내보내기에서 넣을 내용 고르기(브랜치 `feat/export-select`).** md·docx에 들어가는 요약이 요약 탭에서 고른 하나(사용자에게 보이지 않음)뿐이었다. 코어 `tractus export --summary KEY …(여러 번) --parts transcript,memo,marks`: `--parts`를 주면 고른 것만 머리 → 요약(준 순서) → 대화 내용(메모 노트는 메모 내용) → 메모 → 녹음 중 메모 순서로 md·docx 같게 쓰고, 빈 부분은 뺀다(변환 전 노트·메모 노트 포함). `--parts`가 없으면 예전과 같다(md 문자열과 docx 문단을 테스트로 고정). 다른 형식에 `--parts`, 모르는 부분, `--parts` 없는 여러 요약, 없는 key는 종료 코드 2. `store.render_markdown`을 머리·본문·메모 절 조각(`markdown_head`·`markdown_body`·`markdown_memo`·`mark_line`)으로 나눠 내보내기가 같은 줄을 쓴다. **회의록 docx를 고쳤다**: 요약 v2 `sections`로 그려서 이름표·세부 줄·접근 방식·참석·다음에 볼 날이 빠지고 이름표만 있는 안건은 제목째 사라졌다 → `minutes` 칸으로 그린다(`--parts` 없는 예전 경로도 바뀌는 유일한 곳). 기본 요약 docx는 예전처럼 `주제`를 넣지 않는다. Rust `export_meeting(…, summaries, parts)`(부분 allowlist, key마다 `is_summary_key`, parts는 md·docx만). 앱: Markdown·Word를 고르면 `내보낼 내용 고르기` 창(`ExportDialog.tsx`, 순수 로직 `exportPick.ts`): 이 노트에 있는 요약(회의록 → 완성된 노트 → 이전 형식의 회의록 → 요약 탭 순서)과 대화 내용·메모·녹음 중 메모, 처음에는 모두, 지난번에 끈 종류는 끈 채로(localStorage `tractus.export`), 하나도 없으면 `내보내기` 막음. 다른 형식과 Obsidian은 그대로. 확인: pytest 907, vitest 664(+6), tsc, cargo 200(+1), 금지어 검사, 미리보기 창 라이트·다크 × 900·1280. |
| 2026-10-27 | v3.71 | **변환 중에도 녹음(브랜치 `feat/record-while-converting`, 앱만).** 소유자 이슈: 연달아 하는 회의에서 앞 회의를 바로 변환하는 동안(`transcribe --recording`) 새 녹음이 막혀 다음 회의를 녹음하지 못했다. words-ok 막은 근거는 측정이 아니라 조심이었다(녹음 프로그램은 GPU를 쓰지 않는 작은 Swift 프로그램, 녹음과 변환은 다른 폴더). **결정(소유자): 기본은 함께 돈다. 실시간 텍스트 변환을 켜 둔 때만** 자막(0.6B)이 변환(1.7B)과 GPU를 나눠 써 밀리므로 예전처럼 막고 끄는 길을 알린다. `app/src/recordBusy.ts`(`recordBlock`·`convertsWhileRecording`·`LIVE_BLOCKS_RECORD`), App: 바로 변환 대기를 하나(`waitDir`)에서 줄(`waitList`)로 바꾸고 전사 대상 참조는 시작할 때 정한다(변환 중에 끝난 녹음이 앞 변환의 대상을 덮지 않게), 변환 전 노트의 변환은 자막을 켠 녹음일 때만 멈춘다(`pauseConvert`), **노트에 녹음 추가는 전처럼 변환이 끝난 뒤에**(파일에서 추가와 같은 상태 기계라 이번에 바꾸지 않았다), 변환 중에 앞 녹음의 변환이 끝나면 녹음 화면을 떠나지 않고 `열기` 알림, 실패는 녹음 화면에 보이지 않을 때(녹음 중·다음 녹음이 줄에 있음·다른 화면) 알림, 설정을 저장하면 실시간 텍스트 변환 값을 다시 읽는다, 녹음 화면은 녹음하는 동안 앞선 변환의 진행을 보이지 않고 사이드바에 `녹음을 텍스트로 변환` 카드, 녹음 단추는 막을 때만 `변환 중…`, 메뉴 막대는 `recordBlocked`로 `can_record`. 대기 문구 `wait_import`(앞선 파일 변환) → `wait_convert`(앞선 변환). 변환 엔진은 여전히 한 번에 하나다. 확인: vitest 658(+4, 메뉴 막대 기대값 갱신), tsc, cargo 199, 별도 코드 리뷰(줄에 선 다음 녹음이 앞 변환의 실패를 지우는 경우, `useCallback` 안의 낡은 자막 값, 설정 저장 뒤 자막 값을 고침. 두 변환이 함께 도는 경로는 없음). **확인 못 한 것:** 실제 앱에서 녹음 + 1.7B 변환을 함께 돌린 녹음 끊김·발열(측정 없이 소유자 결정), 팬 없는 Air. |
| 2026-10-23 | v3.70 | **0.4.4 릴리스 준비(브랜치 `feat/polish-v2`, 기능과 한 PR).** 버전 0.4.4를 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)와 잠금 파일에 맞췄다. 0.4.3 이후: AI 프롬프트를 md 파일로(v3.67), 스마트 교정 v2(v3.68), 경량화(v3.69). 릴리스 노트 `docs/releases/v0.4.4.md`, 로드맵 항목. |
| 2026-10-23 | v3.69 | **경량화: CLI 시작 시간과 미리 만든 앱 줄이기(브랜치 `feat/polish-v2`).** 소유자 요청 "애플리케이션 경량화". **(B) CLI 시작:** 앱은 제목·태그·텍스트를 고칠 때마다 CLI를 띄우는데, `import tractus.cli`가 numpy(번들에서 0.16초, 코어 5개 사용)·httpx·pydantic·urllib을 매번 불러왔다. numpy는 쓰는 함수 안에서(`from __future__ import annotations` + `TYPE_CHECKING`, asr·audio·align·diarize·vad·voices·embed·index), httpx·pydantic은 `llm.make_client`·`complete_json` 안에서, AI 기능 모듈(summarize·summaries·enhance·minutes·polish·sample_note·obsidian)과 live는 cli의 그 명령 안에서 불러온다. 회귀 테스트 `test_cli_starts_without_heavy_libraries`. **(A) 앱 줄이기:** `scripts/bundle_trace.py`가 테스트 전체(실제 모델 `slow`·`network` 포함, `llm` 제외)와 모델이 없는 계열(Whisper·SenseVoice)의 직접 import를 모듈 기록기로 돌려 **파일 기준**으로 `scripts/bundle_modules.txt`(2,298개)를 만들고(이름 기준이면 transformers가 옛 경로 별칭을 sys.modules에 올려 모델 폴더 139개가 쓰는 것처럼 보였다), `scripts/bundle_slim.py`가 번들 빌드 4단계에서 (0) `mlx_audio/stt/models/__init__.py`의 계열 17개 일괄 import를 우리 계열(qwen3_asr·whisper·sensevoice)만 남기고(실제 로딩은 `mlx_audio.utils`가 이름으로 찾는다. 나머지 계열이 transformers 모델 100여 개를 끌고 왔다) (1) transformers.models·mlx_audio·mlx_lm.models·scipy·onnxruntime의 하위 패키지 중 목록에 없는 것을 지우고 (2) 목록의 site-packages 모듈만 바이트코드를 만든다(표준 라이브러리는 전부). **측정(같은 0.4.3 코드, Apple M3):** 앱 698 → **538MB**(site-packages 633 → 476, pyc 145 → 37, transformers 112 → 12, 남은 것은 mlx 155·scipy 86·onnxruntime 71·numpy 34의 네이티브 바이너리), `.dmg` 233 → **179MB**, 업데이트 tar.gz 198 → **154MB**, 번들 CLI `notes list` 0.41 → **0.13초**, 18초 가상 대화 텍스트 변환 8.5–9.6 → 7.0–7.5초(쓰지 않는 계열을 불러오지 않는다). **옮겨 놓고 확인(sandbox-exec + env -i로 저장소 src·.venv·uv 파이썬·설치된 앱 읽기를 막음):** 실제 텍스트 변환(1.7B + Nemotron 2명 + 단어 싱크 + 검색 임베딩 + 숫자 표기), 목소리 등록·매칭(onnxruntime·scipy), 검색(키워드+벡터), docx 내보내기, AI 연결 실패 경로, 실시간 자막(가상 음성, 확정 4줄), MCP(도구 7개·search_meetings 벡터), `models download vad`(허브), Whisper·SenseVoice 계열과 WhisperProcessor import, 실행 뒤 `codesign --verify --deep --strict`. **확인 못 한 것:** Whisper·SenseVoice 모델로 실제 변환(모델이 이 Mac에 없다: import만), GUI 앱 실행. **규칙:** 의존성이나 위 패키지의 다른 부분을 쓰는 기능을 바꾸면 목록을 다시 만든다(CLAUDE.md 앱 번들 규칙). `tests/test_deferred.py::test_real_models_finish_then_convert_equals_the_direct_path`(slow)는 main에서도 실패한다(메모 낱말 hotwords, v3.53 이후 기대값이 낡음): 이번 변경과 무관. |
| 2026-10-23 | v3.68 | **스마트 교정 v2: 교정 + 정리(브랜치 `feat/polish-v2`, docs/design/transcript-polish.md "v2").** v1은 잘못 들은 말만 고쳐 효과가 미미했다(소유자). 프롬프트(`prompts/polish.md`)를 녹취록 교정 전문가 역할로 바꿔 잘못 들은 말 + 군말·반복 + 문장부호·띄어쓰기 + 맞춤법을 고치게 하고(말투·뜻·문장 경계는 그대로), 문맥을 녹취록 전체(6만 자 이하, 넘으면 앞뒤 30문장)로 넓혔다. `kind`에 `style`. 거르기를 새 동작에 맞췄다: `same`은 완전히 같을 때만, `short` 0.75 → 0.5, `edge`는 군말·되풀이 삭제를 허용, `rewrite`는 띄어쓰기만 바뀐 자리를 세지 않음. 앱: 받은 `term`·`name` 제안의 용어를 모아 알림 하나로 자주 쓰는 단어에 제안(`polish.termsFromSuggestions`), 단추 설명 문구. 소유자 결정으로 측정은 하지 않았다(실제 AI 스모크도 없음). 확인: pytest, vitest, tsc. |
| 2026-10-23 | v3.67 | **AI 프롬프트를 md 파일로(브랜치 `feat/polish-v2`).** 기능 6개(요약·요약 유형·회의록·노트 완성·AI 질문·스마트 교정)의 프롬프트 문구가 모듈마다 파이썬 문자열이라 한곳에서 비교·수정하기 어려웠다(소유자, YAML 대신 의존성 없는 md를 고름). `src/tractus/prompts/<기능>.md` + `common.md`(`complete_json`의 스키마·재요청 문구, 영어 화면 규칙 `lang_en`), 로더 `prompts.load`(`## 이름` 블록, `{{이름}}` = 같은 파일 블록, 한 단계). 모듈의 상수 이름(`SYSTEM_PROMPT`·`LANG_RULE`·`MEMO_PROMPT` …)은 그대로라 조립·테스트·`prompt_hash`가 바뀌지 않는다. 스키마 필드 설명과 검증 재요청 문구는 코드에 남겼다. 확인: 조립된 프롬프트 32가지(한국어·영어 화면 × 메모 유무 × 질문 범위, `complete_json` 재요청 포함)가 옮기기 전과 바이트까지 같음, wheel에 md 포함, pytest 894. |
| 2026-10-22 | v3.66 | **0.4.3 릴리스 준비(브랜치 `chore/release-0.4.3`).** 버전 0.4.3을 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)와 잠금 파일에 맞췄다. 0.4.2 이후: BuzzASR 변환 엔진 등록(v3.63, #43), 한국어 숫자 표기 바꾸기(v3.64, #44), 스마트 교정(v3.65, #45). 릴리스 노트 `docs/releases/v0.4.3.md`. |
| 2026-10-22 | v3.65 | **스마트 교정(화면 이름, 코드 polish, 브랜치 `feat/transcript-polish`, docs/design/transcript-polish.md).** 변환이 끝난 노트에서 AI가 잘못 들은 말이 있는 문장(타임스탬프 단위)의 고친 문장을 제안하고 사용자가 줄마다 수락·거절한다. 코어 `polish.py`: 고칠 범위 5천 자 + 앞뒤 30문장 문맥, 4개 동시(대화 전체를 한 번에 맡기면 일부만 돌려줘 두 번 실행의 겹침 0.10–0.45 → 0.57–0.68), 정답 후보는 회의록 블록(자주 쓰는 단어·확인한 참석자·메모), 문장부호만·크게 짧아짐·경계 옮기기는 버리고 짐작한 숫자(`number`)·여러 낱말 다시 쓰기(`rewrite`)는 표시, 사용자가 고친 줄은 고치지 않는다. `tractus polish run|show|accept|reject`, `polish.json`, 받은 줄은 선택 키 `corrected_by: "ai"`. 앱: 툴바 `스마트 교정`, 도는 동안 대화 내용 영역 테두리가 빛나고 남은 줄이 물결처럼 빛나며 구간마다 제안이 나타난다(progress `suggestions`·`range`), 줄 아래 낱말 diff + 수락·거절, 막대 `모두 수락`(표시 없는 것만)·`모두 거절`, 받은 줄 `스마트 교정됨`. 측정: 가상 회의 CER 21.45 → 18.96(제안 20, 나아짐 16), 실제 노트 5개 노트당 제안 40–80. WORDS.md §4.28. |
| 2026-10-22 | v3.64 | **한국어 숫자 표기 바꾸기(ITN, 브랜치 `feat/korean-itn`, docs/design/korean-itn.md).** Qwen3-ASR이 숫자 셋 중 둘을 한글로 적어 읽기 불편하고, 회의록 숫자 대조가 틀린 `숫자 확인`을 냈다. `itn.korean_numbers`(규칙, 새 의존성 없음)가 단위·조사 앞의 한자어 수와 긴 수만 숫자로 바꾼다(`이` 한 글자·고유어 수·붙여 쓴 한 글자 수는 대부분 그대로). 자리는 `asr.Transcriber.transcribe` 끝이라 모든 계열과 실시간 자막에 같다. `minutes.unverified_numbers`도 근거를 ITN으로 읽는다(옛 노트 포함). 측정: AI Hub 발화 단위 CER 9.48 → 9.14(바뀐 121, 나아진 113, 나빠진 7은 모두 정답이 한글 수), 세션 단위 1.7B 9.49 → 9.33·0.6B 11.47 → 10.98. 측정 도구: `bench/run.py --segments label|utt`, `score.cer_best`(표기 차이를 뺀 CER), `bench/itn_eval.py`. 같은 측정으로 자르기 손실은 0.15%p뿐이었다(VAD 9.49 vs 정답 경계 9.34). |
| 2026-10-22 | v3.63 | **BuzzASR 변환 엔진 등록(브랜치 `feat/asr-buzz-ko`).** 모델 목록에 `asr-ko-mix`(`변환 엔진 (영어 섞인 한국어)`, BuzzASR Korean 8bit, Whisper 계열, 1.7GB)를 더했다. HF에 MLX 판이 없어 소유자 계정에 8bit 변환본 `voyagar/BuzzASR-korean-mlx-8bit`(BuzzASR/korean @ `411b6854`, mlx-audio 0.5.7, 커밋 `b73fdad4`)를 올리고 리비전을 고정했다. `required` + `one_of`, 기본 엔진 순서는 그대로(고를 때만 쓴다), 앱 구성(표준·저사양·필수)에는 없고 `--preset all`에만 든다. 측정 근거는 docs/design/asr-engines.md(AI Hub CER 10.29 vs 9.49, HiKE MER 22.79 vs 28.3, 영어 용어 재현율 86.3% vs 71.6%). WORDS.md §4.14, docs/setup.md·en/setup.md·models.md·desktop.md §2.15. |
| 2026-10-21 | v3.62 | **릴리스 노트 페이지(브랜치 `feat/release-notes`).** 앱의 업데이트 칸에는 릴리스 노트의 앞 3줄만 보여 무엇이 바뀌는지 알 수 없었다(소유자). (1) **원본** `docs/releases/v<버전>.md`(앞머리 `version`·`date`·`summary`·`summary_en` + 한국어 본문 + `---` 뒤 `## English`). 지난 릴리스(0.1.0~0.4.1)는 GitHub 릴리스 본문을 그대로 옮겼다. (2) **웹** `scripts/releases_page.py`(markdown-it-py, 저장소 의존성 아님, `site.sh`가 `uv run --with`로 받는다)가 소개 사이트에 최신순 목록 `releases/`와 버전마다 한 페이지 `releases/v<버전>/`(한국어는 `ko/` 아래)를 만들고 sitemap에 더한다. 여러 제품의 changelog처럼 목록 + 버전별 고정 주소로 쌓인다. (3) **앱** 설정 › 업데이트에 `릴리스 노트 보기 ({X})`: Rust `open_release_notes(version)`이 버전 모양(숫자 세 마디)만 받아 주소를 만든다(화면이 주소를 넘기지 않는다). (4) **`release.sh`** 기본 노트가 `docs/releases/v<버전>.md`이고 `latest.json`의 `notes`는 요약 두 줄 + 한국어 페이지 주소(옛 앱도 앞 3줄에 보인다), GitHub 본문은 웹 링크 + 본문이다. 노트 파일이 없거나 앞머리가 깨지면 사전 점검에서 멈춘다. |
| 2026-10-21 | v3.61 | **0.4.2 릴리스 준비(브랜치 `chore/release-0.4.2`).** 버전 0.4.2를 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)와 잠금 파일에 맞췄다. 0.4.1 이후: 변환 엔진 고르기·바꾸기·직접 추가(v3.59, #40), 녹음 중 메모 고치기·지우기와 긴 메모 모양(v3.60, #41). BuzzASR는 목록에 넣지 않았다(등록 방식 미정, 직접 추가로 시험). 릴리스 노트는 `docs/releases/v0.4.2.md`(v3.62). |
| 2026-10-21 | v3.60 | **녹음 중 메모 고치기·지우기(브랜치 `fix/recording-memos`).** 녹음 중에 남긴 메모·북마크를 고치거나 지울 수 없다는 사용 피드백. (1) **녹음 헬퍼**: stdin `mark_edit <i> <텍스트>`(메모만)·`mark_delete <i>`, 결과는 `marks` 이벤트(전체 목록) + `recording.json` 다시 쓰기. Rust `rec_send`가 `index`를 받는다. (2) **코어** `tractus marks <노트> save`(`store.save_memos`, `note_lock`): 기존 항목의 `t`·`kind`가 맞는 것만 받아 글을 바꾸거나 빼고(새로 남기기·시각 바꾸기 거부), 빈 목록도 `memos.json`으로 남기고 `transcript.md`를 다시 그린다. (3) **앱** `MarkEdit.tsx`(두 번 누르기·연필로 고치기, 휴지통으로 지우기)를 녹음 화면과 노트의 대화 내용 사이 메모 줄에 썼다. 노트는 낙관적으로 바꾸고 편집 줄(`editQueue`)에 세워 저장하며 실패하면 되돌린다. 이미 만든 노트 완성은 옛 메모 제목을 그대로 둔다(다시 만들면 반영). (4) **긴 메모 모양**: 녹음 화면 목록은 시각·종류 칸이 줄을 바꾸지 않는 grid로(전에는 `1:15`·`메모`가 글자마다 쪼개졌다), 노트의 메모 줄은 시각이 메모 첫 줄 기준선에 앉게 했다. 새 메모 입력과 고치기 입력은 글에 맞춰 높이가 늘어나는 `GrowTextarea`(`components/ui/textarea.tsx`, Enter가 저장, 메모는 한 줄로 저장)다. |
| 2026-10-21 | v3.59 | **변환 엔진 고르기·바꾸기·직접 추가(브랜치 `feat/asr-engines`, 설계 docs/design/asr-engines.md, 0.4.2).** 받아 적는 코드가 Qwen3-ASR 두 개에 묶여 있고 앱에 엔진 설정이 없어, 새 모델이 나와도 앱을 새로 내야 했다. (1) **계열 어댑터**(`asr.Engine`, `ENGINES`): qwen3·whisper·sensevoice. 계열마다 다른 것은 호출 인자·자주 쓰는 단어(Whisper는 Phase 0 근거로 넣지 않음)·짧은 청크 오감지 재시도(Qwen만)·토큰 상한뿐이고 반복 루프 재시도는 공통이다. 계열은 모델 폴더 `config.json`의 `model_type`으로 정하고 모르는 값은 오류다. (2) **모델 목록**: `Model.engine`, 변환 기능의 하나면 되는 모델 = 변환 엔진 전체(`asr_ids`), 엔진을 정하지 않으면 메모리가 권하는 기본 엔진 → 다른 기본 엔진 → 받아 둔 다른 엔진. (3) **고르기**: `transcribe --engine <ID>`가 `--track`보다 우선, 없는 엔진이면 경고 `asr_engine_missing` 뒤 기본 엔진. `.job.json`·`transcript.json`의 `asr.engine`(계열), `track`은 기본 두 엔진이면 standard·lite 그대로, 나머지는 ID. 이어 할 엔진을 지웠으면 같은 노트 폴더에서 지금 엔진으로 처음부터(`asr_engine_changed`). 불러오기 실패는 `model_load_failed`. (4) **직접 추가**: `tractus models add <저장소> [--revision]`이 허브에서 파일 목록·크기·커밋 해시를 읽어 모델 폴더의 `custom-models.json`에 넣는다(ID `custom-…`, 폴더 이름 = ID). 지원 계열이 아니거나 safetensors·npz 가중치, 계열별 필수 파일(토크나이저 등)이 없으면 거부한다. 받기·지우기는 등록 모델과 같은 길, 지우면 목록에서도 빠지고, 정리(prune)는 직접 추가한 폴더를 지우지 않으며 모델 폴더를 옮기면 목록도 옮긴다. 라이선스는 카드 값을 그대로 적고 경고하지 않는다(소유자 결정). (5) **앱**: 모델 화면의 `기본 엔진` 표시·`기본으로 쓰기`·`자동으로 고르기`, `변환 엔진 직접 추가` 칸, 설정 `asr_engine`(`set_asr_engine`, `patch_settings`)을 변환(바로·가져오기·나중 변환) 때 `--engine`으로. 실시간 텍스트 변환은 Qwen3-ASR 0.6B 그대로다. 실제 허브로 `openai/whisper-tiny` 추가 → 받기 → 변환까지 확인했다. 한국어 후보 측정은 같은 행의 표(docs/design/asr-engines.md). |
| 2026-10-21 | v3.58 | **0.4.1 릴리스 준비(브랜치 `chore/release-0.4.1`).** 버전 0.4.1을 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)와 잠금 파일에 맞췄다. 0.4.0 이후: 회의록 탭(v3.56, #35), 메뉴 막대 아이콘 팝오버(v3.57, #34를 #36으로 이어받음, 공동 작성 최재강). 릴리스 노트는 `docs/internal/release-notes-0.4.1.md`(로컬). |
| 2026-10-20 | v3.57 | **메뉴 막대 팝오버(브랜치 `feat/tray-popover`, 이슈 #32).** 아이콘을 왼쪽 클릭하면 기본 메뉴 대신 팝오버 창(녹음 시각 + 둥근 녹음 단추, 변환 중 진행률, `Tractus 열기`·`종료`)이 아이콘 바로 아래에 뜨고, 오른쪽 클릭은 기본 메뉴(최근 노트 포함) 그대로다. 단추는 메뉴 항목과 같은 ID로 `on_menu_event`를 지나 화면이 처리하고(v3.24 규칙 그대로), 녹음 시각도 Rust 틱이 팝오버에 보낸다. 위치는 아이콘이 있는 화면의 배율로 계산한다(배율이 다른 화면을 함께 쓸 때 어긋나지 않게). **결정: 투명 창을 위해 Tauri `macOSPrivateApi`를 켠다.** 둥근 카드와 그림자 밖을 비우려면 투명 창이 필요하고, Tauri는 macOS에서 이것을 비공개 API로만 한다. 대가로 Mac App Store에는 낼 수 없다: 배포는 DMG(v3.27~v3.31)뿐이라 지금은 잃는 것이 없다. App Store로 내기로 하면 팝오버를 불투명한 네모 창으로 바꾸고 이 기능을 끈다. 계약은 docs/desktop.md §3.1, 문구는 WORDS.md §4.16. |
| 2026-10-20 | v3.56 | **회의록 탭(브랜치 `feat/meeting-minutes`, 설계 docs/design/meeting-minutes.md).** 회의록이 요약 유형 6개 중 하나라 회의록을 쓰는 사람에게 쓸모가 작다는 피드백으로, 녹음 노트의 오른쪽 패널에 `회의록` 탭을 따로 뒀다(`요약 · 회의록 · AI 질문 · 메모`). 사내 회의록 두 건의 모양(참석, 요약 표 `구분·논의 내용·조율 사항`, 안건별 이름표 목록, `[추가 논의 필요]`, 팀별 할 일)을 합친 한 형식이다. (1) **코어 `minutes.py`**: AI(strict JSON)는 근거가 달린 칸(agenda, topics의 discussed·agreed·points·approach·open, actions, next_meeting)만 내고 제목 `[YY.MM.DD]`·일시·참석·표는 코어가 그린다. 프롬프트가 각 칸이 회의록에서 어떻게 보이는지 알려 주고, 없는 칸은 비운다. 입력에 확인된 참석자 이름과 용어 표기 기준(변환 때 hotwords → 지금의 glossary)을 붙인다. (2) **근거 대조(결정적)**: 담당은 전체 이름이 근거에 있거나 `지훈님`처럼 부른 이름이 대화 속 전체 이름과 맞을 때만, 팀은 근거 줄을 말한 사람의 확인된 이름에 있거나 `저희 …팀`으로 말했을 때만, 기한·다음에 볼 날은 그 표현이 근거 문장에 그대로 있을 때만 남긴다. 근거에 없는 숫자는 `unverified`로 표시한다(지우지 않는다). (3) 저장은 요약 v2 `summaries/minutes.json`(`kind: minutes`, `minutes`·`attendees`·`edited_at` + 기존 소비자용 `sections`). `tractus summarize --template minutes`가 만들고, `tractus minutes <노트> show`가 칸·위키용 Markdown·짧은 판을, `save`가 칸 단위로 고친 값(모양·근거 ID 검사, 사람이 고친 담당·기한은 대조하지 않음)을 저장한다. (4) **앱**: `MinutesPanel`(칸 고치기, `담당 미정`·`기한 미정` 강조, `복사`·`짧게 복사`, 고친 뒤 다시 만들면 확인), Rust `minutes_show`·`minutes_save`. 요약 탭의 유형 메뉴·목록에서 `회의록`을 빼고 옛 `summary.json`은 회의록 탭에 `이전 형식`으로 보인다(코어 CLI 기본값·MCP는 그대로). 실제 AI 스모크 `pytest -m llm -k minutes`(가상 회의, Upstage 3회 통과). 소유자 45분 회의 노트(로컬 복사본)로 사람이 쓴 회의록과 비교했다: Gemini 계열은 안건·핵심 결정이 맞았고 solar-pro4는 분량 규칙을 지키지 않았다. |
| 2026-10-19 | v3.55 | **구글 검색 노출(SEO): 저장소 정보와 소개 사이트(브랜치 `feat/site`).** HN 등 커뮤니티 공개는 하지 않기로 했다(소유자, 2026-10-18). (1) 저장소 설명을 검색 결과 제목이 되는 문장(영어 핵심어 + 한국어)으로, 토픽 20개, 홈페이지를 소개 사이트로. (2) GitHub Pages 소개 사이트 `site/`(손으로 쓴 정적 HTML, 의존성 없음): 영어·한국어 첫 페이지와 벤치마크 페이지, `hreflang`·canonical·OG, `SoftwareApplication`·`FAQPage`·`TechArticle` 구조화 데이터(평점·후기 같은 지어낸 값은 넣지 않는다), `sitemap.xml`·`robots.txt`, 데모는 GIF 대신 mp4(1.2MB → 276KB), 공유 이미지 `assets/og*.png`. 스크린샷은 `scripts/site.sh`가 배포할 때 `docs/images`에서 모은다(저장소에 두 번 두지 않는다). 배포는 `.github/workflows/pages.yml`(Actions, `site/**`·`docs/images/**` 변경 때). Search Console 소유 확인은 소유자의 Google 계정으로 하고, 확인 태그는 `site/index.html`의 주석 자리에 넣는다. |
| 2026-10-18 | v3.54 | **0.4.0 릴리스 준비(브랜치 `chore/release-0.4.0`).** 버전 0.4.0을 다섯 매니페스트(`tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json`)에 맞췄다(`test_every_manifest_has_the_same_version`). 0.3.0 이후: 영어 화면 3단계(v3.44~v3.46), 알려진 한계 두 가지(v3.47), 대화 내용 읽기(v3.48), 패널 폭(v3.49), 메모 에디터(v3.50), 변환 안정성(v3.51), STT 기준선(v3.52), 자주 쓰는 단어 채우기(v3.53), 영어 사용자 문서(`docs/en/`). 릴리스 노트 초안은 `docs/internal/release-notes-0.4.0.md`(gitignore, 이 Mac에만 있음, 한국어 + 영어). 화상회의 트랙별 변환은 소유자 결정으로 뺐다(2026-10-18). |
| 2026-10-18 | v3.53 | **자주 쓰는 단어를 쉽게 채우기(브랜치 `feat/vocab`, 0.4.0 순서 4번을 바꾼 것).** 실측(v3.51·v3.52)에서 소유자 회의의 품질을 가장 크게 올리는 것은 자주 쓰는 단어였지만 실제 노트는 0개였다. (A) 변환할 때 노트의 제목·녹음 중 메모·내가 쓴 메모(글만 있는 노트의 본문, 메모 탭)에서 용어 후보를 골라 그 노트의 hotwords 끝에 붙인다(`asr.note_terms`: 영문·숫자가 섞인 낱말과 두 글자 이상 한글 낱말, 조사를 떼고, 흔한 말·숫자·시각은 빼고 20개까지. 자주 쓰는 단어보다 뒤라 상한 50개에 먼저 잘린다. `glossary.md`에는 쓰지 않는다. 변환 전 노트는 `memos.json`을 읽는다). (B) 대화 한 줄을 직접 고치면 고친 낱말을 자주 쓰는 단어로 제안한다(알림 + `추가`, `vocab.termFromEdit`: 바뀐 낱말 1~2개, 자모로 비교한 소리가 비슷함(0.3 이상), 동사·어미로 끝나지 않음, 숫자만 바뀐 것 제외). **실측(소유자의 실제 회의 노트 1건, 30.6분, 이 Mac에서만, 개수만):** 제목 "자원 온톨로지 미팅"에서 고른 2개만으로 "온톨로지" 오인식 10 → 0(맞게 7 → 30), 한자 줄 4 → 0. |
| 2026-10-18 | v3.52 | **STT 기준선과 측정 지표(브랜치 `bench/stt-baseline`, 0.4.0 순서 2번).** `bench/score.py`에 띄어쓰기를 살린 WER(`wer_ko`)과 혼자 떨어진 소리 군말을 양쪽에서 뺀 CER(`cer_nofill`)을 더했다(지금 CER은 띄어쓰기·문장부호를 지워서 읽기 품질이 보이지 않는다). `diar_eval.py asr`는 `--no-align`으로 돌린다(CER과 무관). 결과(AI Hub 4세션 5.2시간, 지금 앱 파이프라인 `tractus transcribe --track standard`, M3 16GB, 2026-10-18, 지표만): 화자 분리 없음 CER 9.48 / WER 24.37 / 군말 뺀 CER 9.07, **화자 경계에서 자름(지금) 9.58 / 24.63 / 9.16**. 세그먼트 688 → 1,196, 2초 미만 5 → 74인데 CER은 +0.10%p. 미검증 ②(청크가 짧아질 때 CER)를 닫는다: 화자 경계 분할의 비용은 작다. 그래서 "60–120초 창 + 단어 단위 화자 배정"(리서치 1순위)은 구조 비용에 비해 이득이 작아 보류하고, VAD 감도·여백부터 잰다. 군말도 0.4%p라 주원인이 아니다. 세션별 CER 6.5–12.1. |
| 2026-10-18 | v3.51 | **변환 안정성: 자주 쓰는 단어 안전장치와 루프 재시도(브랜치 `feat/asr-safety`, 0.4.0 순서 5번 일부).** 리서치(2026-10-18) 근거: Qwen3-ASR context는 공식적으로 "실험적"이고(issue #13), 무음·짧은 소리에서 목록을 그대로 받아 적으며(issue #186), 방해 단어가 100개를 넘으면 크게 나빠진다(Huber & Waibel, arXiv 2608.05759). 그래서 (1) 목록은 이 노트에 가까운 것부터(일정 참석자 → `--term` → glossary) 50개까지, (2) 1초 미만 청크에는 넣지 않고, (3) 서로 다른 단어 3개 이상이 출력의 80% 이상을 덮으면 목록을 받아 적은 것으로 보고 그 청크만 단어 없이 다시 변환한다(용어가 많은 정상 문장도 절반 넘게 덮어 0.5는 오탐). (4) 반복 루프가 난 청크(자동 감지)는 온도 0.3으로 한 번 더 돌려 루프가 없으면 그 결과를, 아니면 지금처럼 반복을 접는다(루프 청크만이라 비용은 작다). 전역 `repetition_penalty`·앞 청크 텍스트 문맥은 넣지 않았다. 측정: 드문 실패 구간만 건드려 CER 변화는 작을 것으로 보고, AI Hub에서 다시 잰다. 한글 표기 → 영어 원어 별칭은 측정 뒤로 미뤘다. (5) 5초 미만 청크가 중국어·일본어로 감지되면 한국어로 다시 변환한다(짧은 맞장구가 한자로 받아 적혔다). **실측(소유자의 실제 회의 노트 1건, 30.6분, 이 Mac에서만, 개수만):** 한자로 받아 적은 줄 4 → 1(안전장치) → 0(+분야 용어 32개). 분야 용어를 자주 쓰는 단어로 넣으면 "온톨로지" 오인식 10 → 0(맞게 7 → 23), "임베딩" 11 → 2, 루트 코즈·인시던트·프롬프트·사람 이름 오인식 모두 0, 말하지 않은 용어가 끼어든 곳 없음. 이 노트는 자주 쓰는 단어가 0개였다: 품질을 가장 크게 올리는 것은 모델·자르기가 아니라 자주 쓰는 단어를 채우는 일이다(다음 작업). |
| 2026-10-18 | v3.50 | **메모 에디터(브랜치 `feat/memo-editor`, 0.4.0 순서 7번).** 메모 입력창(`<textarea>`, 글은 Markdown 그대로)에 목록 이어 쓰기(Enter), 체크박스 토글(⌘Enter, `[ ]` 클릭), 고른 글 굵게·기울임(⌘B·⌘I)을 순수 함수(`memoEdit.ts`)로 붙였다. 바뀐 부분만 `execCommand("insertText")`로 넣어 macOS 실행 취소가 이어진다. ⌘B는 노트 목록 접기와 겹쳐, 메모 입력창에서 글자를 골랐을 때만 굵게 쓰고 아니면 그대로 목록을 접는다. 녹음 노트의 요약 패널에 `메모로 보내기`(고른 요약을 복사와 같은 마크다운으로 메모 끝에 붙임, 할 일은 체크박스). 계약은 docs/desktop.md §2.10. |
| 2026-10-18 | v3.49 | **패널 폭 조절(브랜치 `feat/panel-resize`, 0.4.0 순서 6번).** 펼친 왼쪽 노트 목록·오른쪽 패널의 경계를 끌어 폭을 바꾼다(손잡이 `role="separator"`, 키보드 ←/→·Home·End, 두 번 누르면 기본 폭). 왼쪽 200~400px, 오른쪽 280~560px, 가운데 최소 420px(`panels.clampWidth`). CSS 변수 `--sidebar-w`·`--rail`을 바꾸므로 레이아웃 코드는 그대로이고, 폭은 `localStorage` `tractus.panelWidths.v1`(이 Mac의 화면 편의, 설정 파일 아님). 창을 줄이면 그리는 폭만 맞춘다. 계약은 docs/desktop.md §3.2. |
| 2026-10-18 | v3.48 | **대화 내용 읽기(브랜치 `feat/transcript-reading`, 0.4.0 순서 3번).** (1) 같은 발언 안에서 앞 줄 끝과 2초(`lib.FLOW_GAP_S`) 안에 이어진 줄은 `is-flow`: 위 간격을 없애고 시각은 가리키거나 재생 중일 때만 보여 한 문단처럼 읽힌다(데이터·줄마다 누르기·고치기·단어 싱크는 그대로, 참석자 색 줄은 `:has(+ .is-flow)`로 잇는다). 리서치(Jones 2003)에서 화자 턴 문단이 가독성의 첫 단계였다. (2) 직전 문장 다시 듣기 `R`(`lib.replayStart`: 지금 대화의 처음, 시작한 지 1.5초 안이면 바로 앞 대화). (3) 볼륨·음소거: 목소리 선명하게(Web Audio)를 지나면 요소의 `volume`이 엔진마다 다르게 적용되므로 `voice.setPlaybackVolume`이 체인 끝 `GainNode`(master)에서 정하고 요소는 1로 둔다. 볼륨은 이 Mac의 브라우저 저장소에 기억하고 음소거는 기억하지 않는다. |
| 2026-10-18 | v3.47 | **알려진 한계 두 가지 정리(브랜치 `fix/known-limits`).** (1) 녹음 노트의 메모를 비워도 마지막 줄 번호를 transcript.json 선택 키 `memo_seq`(정수)로 남기고, 다시 쓰면 그다음 번호부터 이어 간다(`notes._memo_seq`: `memo.seq`·줄 ID·`memo_seq` 중 가장 큰 것). 전에는 `m0001`부터 다시 시작해 비운 메모를 가리키던 요약·질문 근거와 겹쳤다(v3.18 알려진 한계). 메모를 다시 쓰면 `memo_seq`는 지운다. 읽는 쪽은 바뀌지 않는다(`store.memo_lines`). (2) 글만 있는 노트에 녹음을 추가하는 동안(녹음·변환 중) 노트의 AI 질문 탭은 묻지 않고 `녹음이 끝나면 다시 쓸 수 있습니다`/`변환이 끝나면…`을 보인다(메모 노트가 녹음 노트로 바뀌며 근거 ID가 옮겨지는 중이다, v3.19 알려진 한계). |
| 2026-10-18 | v3.46 | **영어 화면 3단계: AI 결과 언어·노트 데이터·영어 README(브랜치 `feat/english-ui-3`).** AI 결과는 화면 언어를 따른다: 영어 화면이면 요약·노트 완성 프롬프트의 "노트에서 쓰인 언어로 쓴다" 줄만 "영어로 쓴다"로 바꾼다(`i18n.ai_prompt`). 프롬프트 본문은 한국어 그대로라 한국어 화면의 프롬프트와 품질 기준선은 바뀌지 않는다. AI 질문은 전처럼 질문의 언어로 답한다(질문하는 사람이 고른 언어가 더 정확한 신호다). 요약 유형 이름은 유형 파일의 `name_en`·`description_en`. 노트에 저장되는 문구(기본 제목, 요약·완성된 노트 머리말, `transcript.md`·`vtt`, 예시 노트)는 만들 때의 화면 언어이고 옛 노트는 고치지 않는다. 예시 노트는 같은 가상 회의를 옮긴 `sample_note_en.json`. README는 영어(`README.md`)와 한국어(`README.ko.md`), 영어 데모 GIF·스크린샷(`docs/images/demo-en.gif`, `docs/images/en/`). 영어 출력의 실제 AI 품질은 아직 재지 않았다(`pytest -m llm`은 한국어 경로). |
| 2026-10-18 | v3.45 | **영어 화면 2단계: Rust·코어 문장과 권한 창(브랜치 `feat/english-ui-2`).** 화면 언어를 `settings.json` `ui_lang`으로 옮기고 Rust가 정한다(메뉴 막대·코어가 같은 언어를 쓰게). Rust 문장은 `t()`/`tv()` + `en.json`(약 160개), 코어는 `TRACTUS_LANG=en`일 때만 영어(`tractus/i18n.py` + `i18n_en.json`, 약 300개: 오류·경고·모델과 기능 이름·내보낸 문서). 셸의 `LANG`은 보지 않는다(한국어 사용자의 터미널도 흔히 `en_US`라 CLI가 갑자기 영어가 되지 않게). MCP 출력·`store.stamp()`·노트 폴더 파일·저장되는 기본 제목·AI 프롬프트는 그대로다(3단계). 권한 창 문구는 `en.lproj`/`ko.lproj` `InfoPlist.strings`. `Speaker N`도 참석자 이름으로 쓸 수 없다(`store._clean_name`). 검사는 Rust 테스트와 `tests/test_i18n.py`(AST). |
| 2026-10-18 | v3.44 | **영어 화면 1단계: 화면 코드의 문구(브랜치 `feat/english-ui`).** 한국어 문구를 키로 쓰는 `t()`(`app/src/i18n.ts`)와 영어 사전(`app/src/en/*.ts`, 약 1,100개). 언어는 `시스템 설정`(macOS 첫 선호 언어가 한국어면 한국어, 아니면 영어. Rust `system_lang`)·한국어·English이고 설정 > 화면 > 언어에서 바꾼다(화면을 다시 연다). 새 라이브러리 없이 했다: 키를 따로 만들지 않아 한국어 화면·기존 테스트·WORDS 금지어 검사가 그대로다. `i18n.test.ts`가 빠진 번역과 `t()` 밖에 남은 한국어를 막는다. 날짜는 `locale()`. 다음 단계: Rust·코어 문장과 권한 창(2단계), AI 결과 언어·요약 유형·예시 노트(3단계), 영어 README. 계약은 docs/desktop.md §3.8, 문체·용어는 WORDS.md §7. |
| 2026-10-18 | v3.43 | **0.3.0 릴리스 준비(브랜치 `chore/release-0.3.0`).** 버전 0.3.0을 `tauri.conf.json`·`Cargo.toml`·`app/package.json`·`pyproject.toml`·플러그인 `plugin.json` 다섯 곳에 맞추고 어긋나면 실패하는 테스트(`test_every_manifest_has_the_same_version`)를 더했다. 쓰이지 않고 0.1.0에 멈춰 있던 `tractus.__version__`은 지웠다. 설치 안내 권한 표에 캘린더(설정에서 연결할 때만 묻는다)를 넣고, 릴리스 노트 초안은 `docs/internal/release-notes-0.3.0.md`(gitignore, 이 Mac에만 있음, `scripts/release.sh --notes-file`). 코드 스캔 오탐 2건(환경변수 이름 로그, 공개 서명 주석 출력)은 이유를 적어 닫았다. |
| 2026-10-18 | v3.42 | **0.3.0 전 노트가 많을 때의 속도(브랜치 `perf/notes-list`).** (1) 앱의 노트 목록은 `transcript.json`의 (수정 시각, 크기)가 그대로면 지난번 항목을 다시 쓰고 바뀐 노트만 읽는다(요약 여부·변환 전 트랙 크기는 매번 본다). 노트 1,000개에서 새로고침마다 2.2–2.8초 걸리던 전체 해석이 없어진다. (2) 새 메모·예시 노트는 목록 새로고침을 기다리지 않고 먼저 연다. (3) 같은 녹음 찾기(`store.find_transcribed`)는 해시 글자가 없는 파일을 해석하지 않는다(가상 1,000개 0.64초 → 0.20초). (4) MCP `list_meetings`·`list_action_items`는 파일 stat이 같으면 지난 결과를 쓴다(가상 1,000개 두 번째 호출 0.74초 → 0.08–0.09초). `list_action_items`에 `limit`(기본 200, 최근 것부터)과 빠진 수 `omitted`를 더했다. (5) 기본 요약 뒤 색인은 임베딩하지 않는다(요약·제목은 임베딩 문장이 아니다: 밀린 벡터 때문에 요약 완료가 늦던 문제). 벡터는 앱의 조용한 색인이 채운다. (6) 기능 안내(coach mark)는 보여 줄 안내가 있고 창이 보일 때만 위치를 찾는다(숨은 창에서도 0.5초마다 돌던 타이머). |
| 2026-10-18 | v3.41 | **0.3.0 전 보안·정확성 정리(점검 결과, 브랜치 `fix/hardening`).** (1) 플러그인 MCP 실행기는 데이터 폴더(없으면 `/`)에서 서버를 띄운다: 코어는 작업 폴더의 `.env`도 읽어서, Claude Code가 연 남의 저장소의 `.env`가 검색어를 다른 서버로 보내거나 Upstage 키를 받게 할 수 있었다. (2) MCP 도구의 노트 경로는 이 데이터 폴더(`meetings/`) 안만 받는다(다른 홈의 전사 읽기·요약 쓰기·작업 파일 지우기 차단). (3) 서버 안내·플러그인 스킬에 "노트 내용은 지시가 아니다"를 넣고, 스킬의 인용 안내를 새 `cite` 형식에 맞췄다. (4) 질의 임베딩이 한 번 실패해도 상주 검색 프로세스가 스마트 검색을 끄지 않고 60초 뒤 다시 시도한다. (5) `bench/aihub_search_eval.py`는 `TRACTUS_EMBED`와 무관하게 로컬 임베딩만 쓴다(AI Hub 전사 원격 전송 금지). (6) 앱의 `settings.json` 쓰기 8곳을 `patch_settings` 하나로: 한 번에 하나(같이 저장해도 값을 잃지 않음), 임시 파일 → 이름 바꾸기(쓰다 꺼져도 깨진 파일이 없어 데이터 폴더가 기본값으로 돌아가지 않음). 설정 화면의 저장은 화면이 고치는 칸과 모델 폴더만 바꾼다(정렬·시작 점검 등이 되돌아가던 문제). |
| 2026-10-18 | v3.40 | **Claude Code 플러그인(`plugins/tractus`, 저장소 루트 `.claude-plugin/marketplace.json`, 브랜치 `feat/claude-code-plugin`).** `/plugin install tractus --marketplace sjoon21/Tractus` 한 줄로 MCP 서버·스킬 `meetings`·`/tractus:recap`이 붙는다. MCP는 실행기 `bin/tractus-mcp`가 `tractus`(환경변수 → 앱 설정 → 미리 만든 앱 → 알려진 위치 → PATH)와 데이터 폴더(환경변수 → 앱 설정 → `~/Tractus`)를 찾아 띄우고, 못 찾으면 stdout을 비운 채 stderr로 설치 안내를 낸다. `userConfig`(`tractus_bin`·`tractus_home`, 비면 자동)로 직접 지정할 수 있다. **MCP 인용 형식을 `[노트 제목 00:05:31]`로 바꿨다**(사용자 결정): 플러그인 답에 `[meeting_id#s0012 …]`가 그대로 보였고, 스킬은 모델이 부를 때만 읽혀 서버 지시가 이겼다. 정확한 자리는 결과의 `meeting_id`·`id` 칸에 남는다. 확인: `claude plugin validate --strict`(마켓플레이스·플러그인), 실제 `claude --plugin-dir` 세션이 가상 회의(tests/fixtures/eval)에서 검색·인용(4회, 실제 노트는 쓰지 않음). |
| 2026-10-18 | v3.39 | **첫 사용자 온보딩(코어·앱, 브랜치 `feat/onboarding`).** 계약은 docs/desktop.md §2.20·§3.7, 문구는 WORDS.md §4.25. **결정(사용자 선택):** 세 겹 모두: (1) 홈의 `Tractus 시작하기` 목록(모델 → 예시 노트 → 첫 녹음 → 완성된 노트, 할 수 있는 단계는 실제 상태에서 읽는다), (2) 예시 노트(`tractus note sample`, 녹음·모델·AI 키 없이 바로 열어 보는 가상 회의. `"sample": true`라 검색 색인·MCP 목록·전체 AI 질문에서 뺀다), (3) 기능을 처음 마주칠 때 한 번씩 뜨는 안내 여섯 개(한 번에 하나). 10단계 차례 투어는 대부분 건너뛰므로 하지 않았다. 문구는 onboarding.ts·tips.ts에 모아 나중에 영어 화면의 번역 대상으로 둔다. 확인: pytest 766(+6), vitest 603(+7), cargo 179(+1), 미리보기 라이트·다크(안내 차례, Esc, 화면 변화 없음), 별도 코드 리뷰(MCP 할 일 목록의 예시 노트, 동시 실행으로 예시 노트 둘, 다른 것을 닫는 Esc, 자리 따라가기·화면 밖 자리, 반쪽 폴더 반영). |
| 2026-10-16 | v3.38 | **캘린더 일정으로 녹음하기(녹음 프로그램·코어·앱, 브랜치 `feat/calendar`).** 설계는 [docs/design/calendar.md](docs/design/calendar.md), 계약은 docs/desktop.md §1·§2.19·§3.6, 문구는 WORDS.md §4.24. **결정(사용자 선택):** (1) 홈에는 진행 중이거나 15분 안에 시작하는 일정 하나만 카드로. (2) 참석자 이름은 그 녹음의 음성 인식 힌트(자주 쓰는 단어에는 넣지 않는다)·이름 고르기·노트의 일정 정보에. (3) 알림 없음. (4) 캘린더는 설정에서 끄고, 처음에는 모두. **구조:** 읽기는 `tractus-rec calendar`(EventKit, Swift)가 하고 앱의 하위 프로세스라 권한 창은 앱 이름으로 뜬다(`NSCalendarsFullAccessUsageDescription`을 앱·녹음 프로그램 Info.plist에). 일정은 녹음 폴더 → 노트 폴더의 `event.json`으로만 다니고 transcript.json 스키마는 그대로다. 참석자 이메일은 어디에도 남기지 않는다. 연결하기 전에는 권한을 묻지 않는다(기본 꺼짐). 확인: pytest 760(+5), vitest 600(+3), cargo 178(+4), swift test 26(+4), 미리보기 라이트·다크, 별도 코드 리뷰(이름 자리에 든 이메일 빼기, 제목 없는·긴 제목 일정, 취소·거절한 일정 반영). 실제 권한 창과 실제 캘린더는 아직 확인하지 않았다. |
| 2026-10-16 | v3.37 | **Obsidian으로 보내기(코어·앱, 브랜치 `feat/obsidian-export`).** 노트 하나를 볼트의 `Tractus/` 아래 Markdown 하나로 쓴다. 설계는 [docs/design/obsidian-export.md](docs/design/obsidian-export.md), 계약은 docs/desktop.md §2.18, 문구는 WORDS.md §4.23. **결정(사용자 선택):** (1) 자동 동기화 없이 내보내기 메뉴에서 누를 때만 보낸다. (2) Tractus 폴더 구조를 볼트 하위 폴더로 그대로 쓴다. (3) 오디오는 설정으로 고르고 기본은 끈다. (4) 완성된 노트·요약(할 일은 `- [ ]`)·접힌 대화 내용을 넣는다. **안전:** 보낸 파일과 sha256을 `.tractus.json`에 적어 볼트에서 고친 파일은 묻고 나서만 덮어쓰고, 지우는 것은 고치지 않은 우리 파일뿐이며, 데이터 폴더와 겹치는 볼트는 거부한다. 확인: pytest 755(+13), vitest 597(+1), cargo 174(+4), 미리보기 라이트·다크, 별도 코드 리뷰(대소문자·정규화만 다른 경로를 같은 파일로 보기, 기록된 경로의 남의 파일 가리기 반영). |
| 2026-10-16 | v3.36 | **노트 완성(코어·앱, 브랜치 `feat/enhanced-notes`).** 내가 적은 메모를 뼈대로 대화 내용의 세부를 붙인 완성된 노트. 설계는 [docs/design/enhanced-notes.md](docs/design/enhanced-notes.md), 계약은 docs/desktop.md §2.17, 문구는 WORDS.md §4.22. **결정:** (1) 새 파일 종류 없이 요약 v2의 key `enhanced`(`kind`·`part`·`source`·`at` 선택 키)로 저장해 목록·내보내기·MCP·근거 옮기기를 그대로 쓴다. (2) 뼈대는 메모 탭 줄(`m####`)을 먼저, 녹음 중 메모·북마크(`memos.json`, 저장하지 않는 ID `r####`)를 시각 순으로 뒤에 둔다. 녹음 중 메모는 지금까지 어떤 AI 입력에도 들어가지 않았다. (3) 근거는 대화 줄(`s####`)만이고 메모 ID는 뼈대일 뿐이다. 메모 원문은 코어가 제목으로 쓰고 순서도 코어가 맞춘다(모델이 원문을 고치거나 순서를 바꿔도 재요청하지 않는다). (4) 기존 요약 프롬프트는 바꾸지 않는다. (5) 앱은 메모 탭의 `내 메모 \| 완성된 노트` 전환과 `노트 완성` 단추(요약과 같은 `summary_start`). 확인: pytest 742(+16), vitest 596(+4), `pytest -m llm -k enhance` 3회 통과(Upstage solar-pro4, 가상 회의만). |
| 2026-10-15 | v3.35 | **앱 화면 다시 디자인(앱만, 코어·Rust 로직은 그대로), 버전 0.2.0.** 손으로 쓴 `styles.css`(4,800줄, "종이 원고" 콘셉트)를 걷어 내고 Tailwind v4 + shadcn 방식 부품(`app/src/components/ui/`, Radix 없이 네이티브 요소)으로 옮겼다. 톤은 macOS 노트 앱(Granola·Apple Notes): 무채색 바탕, 색은 의미로만(녹음 = 시스템 빨강, 메모 = 노트 노랑, 초점 = 시스템 파랑). 규칙은 `app/DESIGN.md`, 토큰은 `app/src/theme.css`, 남은 전역 규칙은 `base.css`, 상태가 많은 노트 화면 선택자는 `components/note/note.css`. **새 기능:** 설정 `화면 > 테마`(시스템 설정·라이트·다크, 이 Mac의 브라우저 저장소, `themePref.ts`), 사이드바 `홈`과 설정·모델 화면의 `뒤로`(들어오기 전 화면으로), 홈 화면(빠른 동작·최근 노트·접히는 단축키). 창은 타이틀바를 겹친다(`titleBarStyle: Overlay`, 권한 `core:window:allow-start-dragging`·`allow-set-theme`). 개발 서버의 `/preview.html`은 가짜 IPC로 앱을 띄우는 화면 확인용이다(빌드에 들어가지 않는다). 이후 같은 날: 홈의 깜빡이는 점 격자 배경(`components/ui/flickering-grid.tsx`), AI 서비스 고르는 칸을 shadcn Model Selector 모양으로(라벨 없이, 서비스 로고 + AI 모델 이름, Lobe Icons MIT, NOTICE 10번), 설정 설명을 한두 마디로 줄이고 화면에서 환경변수 이름을 뺐다(WORDS.md 2026-10-15 결정), 사이드바 `AI 어시스턴트`(가리키면 움직이는 별 아이콘). 일부 긴 안내는 `title`로 옮겼다. |
| 2026-10-15 | v3.34 | **앱 안 업데이트(앱·스크립트·문서, 코어는 그대로), 저장소 공개 전환, 버전 0.1.1.** **결정:** Tauri 2 updater 플러그인(`tauri-plugin-updater` 2.14 + 다시 열기용 `tauri-plugin-process` 2.4)으로 **알림 + 사용자 확인 설치**다. 앱이 뜨고 약 10초 뒤와 `설정 > 업데이트`의 `업데이트 확인` 단추에서만 확인하고, 새 버전이 있으면 시작 때는 기존 알림 패턴(`새 버전 X가 있습니다` + `설정 열기`, 한 실행에 한 번)만, 설정에서는 릴리스 노트 일부 + `업데이트 설치`를 보인다. 받기·설치는 `업데이트 설치`를 누른 뒤에만, 끝나면 `다시 열기`로 relaunch. 자동 설치는 없다. 엔드포인트는 공개 저장소 정식 릴리스의 정적 `https://github.com/sjoon21/Tractus/releases/latest/download/latest.json`(플랫폼 `darwin-aarch64`, `url`은 같은 릴리스의 `Tractus.app.tar.gz`, `signature`는 `.sig`). 서명 키는 `~/.tauri/tractus.key`(비밀번호 없음, 저장소 밖, 백업 필수: 잃으면 기존 설치본이 새 서명을 거부), 공개 키만 `tauri.conf.json`의 `plugins.updater.pubkey`. **번들 한정:** Rust 명령 `update_available(): bool`이 `paths.rs`의 번들 판별(`../Resources/runtime/bin/tractus`)을 재사용해 미리 만든 앱에서만 확인하고, `install.sh`로 만든 앱·개발 실행에는 `저장소에서 만든 앱은 scripts/update.sh로 업데이트합니다` 한 줄만 보인다. 권한은 `updater:default`·`process:allow-restart`, CSP는 그대로(내려받기는 Rust). `bundle.createUpdaterArtifacts`는 쓰지 않고(`tauri build`의 tar.gz는 번들 스크립트의 마지막 ad-hoc 재서명 전이라 쓸모없다) 새 `scripts/release.sh`가 `build_app_bundle.sh` → `Tractus.app.tar.gz`(`COPYFILE_DISABLE=1`, 앱 폴더가 루트) → `tauri signer sign` → `.sig` → `latest.json` → `make_dmg.sh` → sha256을 `dist/release/<버전>/`에 모으고 `gh release create`는 출력만 한다(`--publish`로 실제 생성, 리드가 쓴다). 버전은 `tauri.conf.json`·`Cargo.toml`·`package.json`·`pyproject.toml` 모두 0.1.1. **버린 대안:** 알림만 하고 다운로드 페이지로 보내는 방식은 앱 안에서 설치가 안 되고 받은 파일의 서명을 검사하지 못해 버렸다. 자동 설치는 사용자 동의 없이 앱을 바꾸므로 처음부터 제외. **한계:** 업데이트마다 전체(약 240MB)를 받는다(차이 받기 없음). ad-hoc 재서명이라 업데이트 뒤 마이크·시스템 오디오 권한을 다시 물을 수 있다. v0.1.0에는 업데이터가 없어 한 번은 새 `.dmg`를 수동 설치한다. Apple Developer ID 서명·공증은 미래 일이다. **확인하지 못한 것:** 권한 재요청 여부, 깨끗한 Mac(새 계정)에서의 업데이트, macOS 14.4~15, 실제 릴리스에 대한 end-to-end 업데이트(첫 정식 릴리스 뒤에야 가능). 문구는 WORDS.md §4.21, 계약은 docs/desktop.md §3.5, 릴리스 절차는 docs/setup.md §10. **리뷰 반영(2026-10-15):** 설정 화면을 떠나도 확인·받기 상태가 멈추지 않게 `update.remembered`를 원본으로 삼고 React에는 결과만 준다(언마운트된 컴포넌트의 setState 갱신 함수는 돌지 않는다), 설치가 끝나면 `업데이트 확인`도 잠근다(같은 버전을 또 받지 않게); `release.sh`는 지난 산출물 다섯 개를 먼저 지운다(실패 시 새 tar.gz와 옛 dmg가 섞이지 않게); `relaunch`는 종료 확인(`begin_quit`·`onCloseRequested`)을 거치지 않으므로 녹음·변환·가져오기 중에는 `다시 열기`를 잠근다(`relaunchBlocked`); 시작 알림은 `새 버전이 있습니다: X`(조사를 버전 뒤에 붙이지 않는다); `plugins.updater.requireSignedVersion: true`로 서명에 적힌 버전과 `latest.json`의 `version` 대조를 강제한다(`release.sh`가 `--app-version`으로 서명, 서명 없는 옛 릴리스는 없다) |
| 2026-10-15 | v3.33 | **AI 서비스 설정 보강, Gemini 연결 수정, 선택 검색 임베딩(Upstage). 코어 부분:** (1) 서비스별 변수 `UPSTAGE_`·`OPENAI_`·`ANTHROPIC_`·`GEMINI_` + `BASE_URL`·`MODEL`. 우선순위는 인수 > 전역 `TRACTUS_LLM_BASE_URL`·`TRACTUS_LLM_MODEL` > 서비스별 > 표의 기본값이고, **전역 값은 `TRACTUS_LLM_PROVIDER`가 그 서비스이거나 비었을 때만**(`custom`은 항상) 쓴다: 전역 값이 다른 서비스를 가리킬 때 이 서비스의 키가 그 주소로 가지 않게. 앱이 주소·AI 모델을 싣는 서비스는 `TRACTUS_LLM_PROVIDER`도 같이 싣는다. (2) Gemini가 안 되던 원인(2026-10-15 실측): 기본 AI 모델 이름 `gemini-2.5-flash`가 새 사용자에게 404("gemini-3.8-flash를 쓰라"), 생각하는 AI라 `max_tokens=16`의 연결 테스트가 빈 답(`finish_reason=length`)을 받아 고장으로 보임, 일시적 503 "high demand". 고침: 기본 AI 모델을 별칭 `gemini-flash-latest`로(실제 요약으로 확인), 연결 테스트는 `max_tokens` 256이고 **HTTP 200이면 빈 답도 성공**(`empty: true`), 503·529·`UNAVAILABLE`·`overloaded`는 새 코드 `llm_busy`, 404는 서버 안내 문장을 키 가리고 200자로 `message`에 싣는다, 실제 호출의 SDK 재시도는 4회(지수 백오프). 새 명령 `tractus llm models [--provider P]` → `{"models": [ID…]}`(`GET /models`, 앞의 `models/` 제거). (3) **선택 검색 임베딩** `TRACTUS_EMBED=local`(기본)|`upstage`: `embed.UpstageEmbedder`(로컬 임베더와 같은 인터페이스. passage `solar-embedding-2-passage`, 질의 `solar-embedding-2-query`, 1024차원을 모든 응답에서 확인, 요청당 100개, 입력 3500자 초과는 자름, 429·5xx는 SDK 재시도), `MODEL_ID` `upstage/solar-embedding-2/1024`라 바꾸면 벡터가 다시 만들어진다. 선택 지점은 `embed.load_embedder` 하나(CLI 색인·검색·질의·MCP 공용). 실패는 색인·검색을 막지 않는다(벡터 `pending`, 키워드로 물러남, 오류 줄에 상태 코드만). 키는 `UPSTAGE_API_KEY`·주소는 `UPSTAGE_BASE_URL`만 읽는다(전역 주소는 읽지 않는다). **"MCP에 키를 넘기지 않는다"의 유일한 예외**: 이 모드일 때만 앱이 `TRACTUS_EMBED=upstage`와 Upstage 키 하나를 임베딩하는 실행(색인·변환·가져오기·요약·질문)과 MCP·검색 프로세스에만 싣는다(녹음 프로그램 등 나머지에는 없다). **실서버로 확인한 것:** Gemini 모델 목록·연결 테스트·요약(합성 노트), Upstage 임베딩 색인 15청크·검색(합성 노트, 0.9초). **확인하지 못한 것:** Upstage 임베딩의 검색 품질(`bench/search_eval.py` 미실행), 한도·대량 색인 때의 429, OpenAI·Claude 실서버. **앱 부분:** API 키 최소 5자(전엔 10자). 서비스마다 주소·AI 모델을 따로 저장(`llm_profiles`, 예전 설정은 읽을 때 옮김)하고 `llm_default`가 기본. 설정에 서비스 목록과 `등록됨`/`미등록` 배지, `기본으로 사용`, `AI 모델 목록 불러오기`(`tractus llm models`). 요약 탭·노트 질문·전체 질문 서랍에 `AI 서비스` 고르는 칸(등록된 서비스만, 하나뿐이면 감춤, 기능마다 기억)을 두고 고른 서비스의 키·주소·AI 모델만 싣는다. 요약 바닥글과 답변의 서비스·AI 모델 표기는 뺐다. `스마트 검색 방식`(이 Mac | Upstage)은 설정·`embedding_provider`: Upstage는 키가 있어야 하고 전송 확인을 거치며, 앱이 `TRACTUS_EMBED`를 늘 정하고 옵트인일 때만 Upstage 키 하나를 임베딩하는 실행과 MCP에 싣는다. 리뷰 반영(2026-10-15): 앱이 고른 서비스는 셸·`.env`의 `TRACTUS_LLM_PROVIDER`(다섯 서비스 중 하나)보다 먼저라 `TRACTUS_LLM_PROVIDER`·주소·AI 모델을 키와 함께 늘 싣는다(전엔 저장소 `.env`의 `upstage`가 Gemini 연결 테스트·모델 목록을 Upstage로 돌렸다), 로컬 전용 모드에서는 Upstage 스마트 검색을 고를 수 없다, 색인은 200줄마다 저장해 도중에 끊겨도 끝낸 만큼은 남는다. 기능 점검은 이때 Upstage 키로 준비 여부를 보고 모델 화면은 이 Mac 검색 모델을 `사용하지 않음`으로 보인다. 자세히는 docs/desktop.md §2.14 |
| 2026-10-15 | v3.32 | **AI 서비스를 고른다: OpenAI·Claude·Gemini·직접 입력(OpenAI 호환), 서비스 주소·API 키·AI 모델, 연결 테스트(코어·앱).** 새 라이브러리는 없다(`docs/llm-providers.md`의 결정): `llm.PROVIDERS` 표에 `custom`(주소·AI 모델을 사용자가 지정, 엄격 JSON 끔)을 더하고 `Provider.temperature`를 넣어 **Claude는 온도를 보내지 않는다**(호환 계층이 Claude 4.7 이상의 온도 1 미만을 400으로 거절). 환경변수 `TRACTUS_LLM_BASE_URL`(서비스 기본 주소를 바꿈, http/https + 호스트, 계정 정보 거절)과 직접 입력의 키 `TRACTUS_LLM_API_KEY`(주소가 이 Mac일 때만 비워도 된다). **로컬 전용 모드는 이름이 아니라 주소의 호스트로 판단한다**(파싱한 호스트가 정확히 `localhost`·`127.0.0.1`·`::1`일 때만 통과, `localhost.evil.com`·`user@host` 속임수 차단). openai SDK 오류를 `LLMError`로 바꿔 코드를 나눈다: `llm_auth`(401·403, 서버 문구는 버림) `llm_rate`(429) `llm_model`(404) `llm_context` `llm_conn`(연결·DNS·시간 초과) `llm_api`(그 밖). 키는 서버가 돌려준 문구에서도 가린다. `cli.py`는 `openai.APIError` 대신 `LLMError` 하나만 잡는다. 새 명령 `tractus llm test`(짧은 요청 한 번, 30초, 재시도 없음, 한 줄 JSON 또는 error 이벤트). 앱: `settings.json`에 `llm_provider`·`llm_base_url`·`llm_model`을 더하고(더하기만), 키는 서비스별 0600 파일(`llm_key`는 Upstage 그대로, 나머지 `llm_key.<서비스>`), 요약·질문·연결 테스트 실행에만 **고른 서비스의 키를 그 서비스의 환경변수로** 싣는다. 설정 화면에 서비스 목록·주소·AI 모델·`연결 테스트`, 질문 전 안내에 보내는 곳의 호스트. **리뷰 반영:** OpenAI도 온도를 보내지 않는다, 코어는 3xx를 따라가지 않는다(로컬 전용·이 Mac 검사를 우회하지 못하게), `llm test`는 총 30초 제한(앱은 35초에 kill), 앱이 서비스를 정하면 서비스 기본 주소도 싣는다(노트 폴더 `.env`의 `TRACTUS_LLM_BASE_URL`로 키가 가지 않게). **확인하지 못한 것:** 실제 OpenAI·Claude·Gemini 서버(키 없이 가짜 서버로만 시험했다), 앱 화면의 직접 조작(앱을 띄우지 않았다). 상세: docs/desktop.md §2.14, docs/llm-providers.md |
| 2026-10-15 | v3.31 | **리뷰 지적 수정(코어·앱·스크립트).** (1) `models prune`/`unregistered`는 모델 모양(완료 표시·`config.json`·`*.safetensors`)인 폴더만, 등록된 모델이 하나라도 든 곳에서만 대상으로 삼고, 노트 폴더(`TRACTUS_HOME`·`meetings/`·`recordings/` 보유)는 항상 비운다. `models move`도 노트 폴더를 목적지로 거부한다. 모델 폴더를 문서·노트 폴더로 잘못 고르면 사용자 폴더가 지워지던 경로를 막은 것이다. 확인 창은 지울 폴더 이름을 보인다. (2) 다른 볼륨으로 옮길 때 복사와 원본 삭제를 나눴다: 삭제가 실패해도 복사본은 두고 `leftover`로 알린다. (3) 앱을 켤 때 검색 갱신을 한 번 예약한다(끝내기 전 5분 안의 고침이 벡터 없이 남던 것). (4) 깨끗한 Mac에서 데이터 폴더가 없어 번들 코어 실행이 ENOENT로 실패하던 것: `tractus_cwd`가 폴더를 만든다. (5) 번들: 의존성을 `--require-hashes`로 설치하고, macOS용 wheel이 여럿이면 `uv.lock`의 가장 낮은 macOS용(`macosx_14_0`)을 URL·해시로 고정한다(uv가 만든 Mac의 macOS 26용 `mlx`를 골라 14.4~15에서 import가 안 되던 것). 빌드가 14.4보다 새 시스템을 요구하는 Mach-O를 보면 멈춘다(6b). 래퍼는 링크를 따라가고 파이썬을 `-I -B -u -X utf8`로 띄우며 `PYTHONEXECUTABLE`·`__PYVENV_LAUNCHER__`를 지운다. 번들 코어가 안 돌면 시작 점검이 `앱이 손상됨`으로 막는다. `tool_bin`은 `*.app/Contents/Resources/runtime/bin`의 파이썬일 때만 번들 후보를 본다. `install.sh` 점검은 doctor의 종료 코드를 본다. DMG 이름에 만든 날짜(`Tractus-<버전>-<날짜>-arm64.dmg`), `설치 안내.txt`에 확인하지 못한 단계 표기. **macOS 14.4~15 실행은 직접 확인하지 못했다.** |
| 2026-10-15 | v3.30 | **미리 만든 앱(P8)과 설치 디스크 이미지(P9)(스크립트·문서, 코어·앱 코드는 그대로).** `scripts/build_app_bundle.sh [--check] [--out D] [--with-fluid]`: uv의 python-build-standalone 3.12(실행 파일이 libpython을 `@executable_path` 기준으로 찾아 옮길 수 있다)를 `<앱>/Contents/Resources/runtime/`에 복사해 줄이고(tkinter·idle·테스트·pip·헤더·bin의 스크립트 삭제, 파이썬 56 → 35MB), `uv export --frozen --no-dev --no-emit-project`의 의존성을 `uv pip install --target … --only-binary :all:`(wheel만, sdist 거부)로 `site-packages`에 직접 설치하고 `uv build --wheel`로 만든 tractus를 얹는다. universal2 wheel의 x86_64 조각은 `lipo -thin arm64`로 버리고 `tests`·`*.pyi`·`mlx/include`를 지운 뒤 바이트코드를 `compileall --invalidation-mode unchecked-hash`로 미리 만든다(서명으로 봉인된 앱 안에 실행 중 쓰지 않으려고 `PYTHONDONTWRITEBYTECODE=1`. pyc 약 126MB가 더해지지만 무거운 import 시작이 2.3초 → 1.2초). 래퍼 `runtime/bin/tractus`는 자기 위치 기준으로 `python3.12 -P -c …`를 실행하고 `PYTHONHOME`·`PYTHONPATH`를 지우고 `PYTHONNOUSERSITE=1`을 둔다(`sys.executable`이 `runtime/bin`이라 P3의 `paths.tool_bin`이 `../../bin/tractus-rec`를 찾는다). `tractus-rec`(`--with-fluid`면 `tractus-diar`)는 `--scratch-path`로 임시 폴더에서 빌드해 `Resources/bin/`에 넣는다(저장소의 `.build`를 건드리지 않는다). **tauri `bundle.resources`는 `tauri.conf.json`에 고정하지 않고** `pnpm tauri build --bundles app --config '{"bundle":{"resources":{…}}}'`로 합친다: `runtime/`이 없는 `install.sh`의 일반 빌드가 깨지지 않게. 안쪽 Mach-O 전부를 ad-hoc 서명(하드런타임 없음: 켜면 library validation이 ad-hoc 라이브러리를 거부한다)하고 앱을 `Entitlements.plist`로 서명해 `codesign --verify --deep --strict`를 통과시킨다. `scripts/make_dmg.sh <앱> [--version X] [--out dist] [--check]`: `hdiutil create`(UDZO, `Applications` 바로가기, `설치 안내.txt`), 결과 `Tractus-<버전>-arm64.dmg`, 서명이 깨진 앱은 거부(`tests/test_bundle_scripts.py`). **결정: `.pkg`는 만들지 않는다**(관리자 암호가 필요한 설치·MDM 배포일 때만 이득이다. 그때는 같은 앱으로 `pkgbuild`). 측정(Apple M3, 복사본): 앱 694MB(runtime 671MB = python 35 + site-packages 632[mlx 155·transformers 111·onnxruntime 79·scipy 92], 앱 본체 16, 녹음 프로그램 0.3), `.dmg` 242MB, 빌드 175초(처음)·144초(캐시가 따뜻할 때). **옮겨 놓고 확인한 것:** 빌드한 앱을 다른 폴더에 복사해 저장소·원래 파이썬·원본 번들 읽기를 막은 `sandbox-exec` + `env -i`(PATH에 ffmpeg만)에서 `tractus --help`·`doctor --json`(녹음 프로그램은 복사본 `Resources/bin`)·실제 텍스트 변환(asr-lite + silero, 가상 음성 8초, 참석자 구분 모델 없음 경고 경로)·`tractus-rec record --fake` 3초·`tractus mcp` 표준 입출력의 `status` 호출이 돌았고, mlx(GPU)·onnxruntime·sqlite_vec(`vec0` 로드)·kaldi_native_fbank·numpy·scipy의 `__file__`이 모두 복사본 안이었다. 실행 뒤에도 `codesign --verify --deep --strict`가 통과한다(봉인을 깨지 않는다). **확인하지 못한 것:** 깨끗한 Mac(새 계정)에서의 실행, 격리(quarantine) 표시가 붙은 내려받은 상태의 Gatekeeper, 마이크·시스템 오디오 권한이 뜨는 이름, GUI 앱 실행(앱을 띄우지 않았다), 정식 서명·공증, macOS 14. 사용법: docs/setup.md §10 |
| 2026-10-15 | v3.29 | **스마트 검색 모델 8bit, 모델 폴더 정리, 코어의 저장소 의존 제거, 설치·업데이트·정리 스크립트(코어·스크립트).** (1) **임베딩을 bf16 공식 가중치(1.2GB)에서 `mlx-community/Qwen3-Embedding-0.6B-8bit`(0.6GB, revision `407ad232…`, apache-2.0, `config.json` quantization bits 8·group 64)로 바꿨다.** 폴더 `qwen3-embedding-0.6b-8bit`, 파일 8개(0.65GB). `embed.Embedder`는 `mlx_lm.utils.load_model`로 양자화 층을 싣고 `.model`(은닉 상태)을 쓰며 풀링·접두사·`QUERY_TASK`는 그대로다. `MODEL_ID`가 `…/8bit/…`로 바뀌어 벡터는 한 번 전부 다시 만든다. 확인한 것은 bf16 대비 코사인 0.999 이상(문장 4개·질의 1개)과 "바꿔 쓴 문장 0.80 > 무관한 문장 0.23"뿐이다. **소유자 결정(2026-10-15)으로 `bench/search_eval.py`·`aihub_search_eval.py`는 돌리지 않았다(CLAUDE.md의 평가 규칙 면제, 거기에도 기록). 8bit의 검색 품질은 검증되지 않았다.** 다음에 검색을 건드릴 때 둘 다 돌려 기준선을 다시 잡는다. 프리셋 크기: 표준 약 5.2 → 4.6GB, 전부 6.2 → 5.7GB. 옛 bf16 폴더는 "등록되지 않은 폴더"로 남는다. (2) `tractus models prune [--yes] [--json]`: 모델 폴더 바로 아래의 등록되지 않은 폴더만 지운다(숨김·파일·링크 제외, 받기 잠금, 지우기 직전 `remove`와 같은 검사). `models list --json`에 추가 키 `unregistered: [{name, bytes}]`. (3) **코어는 저장소 위치를 가정하지 않는다(P3).** 녹음·9명 이상 구분 프로그램 경로는 `paths.tool_bin`: 환경변수(`TRACTUS_REC_BIN`·`TRACTUS_DIAR_BIN`) → 앱 번들(`sys.executable`이 `<앱>/Contents/Resources/runtime/bin`이면 `../../bin/<이름>`) → 저장소에서 빌드한 것. 빌드 안내는 저장소 배치(`recorder/Package.swift`)일 때만 `swift build` 명령을 말하고 아니면 환경변수로 위치를 알리라는 일반 안내(`paths.build_hint`, `BUILD_HINTS` 상수는 `models_registry.build_hint()`로 바뀜). (4) 스크립트: `install.sh` 끝에 `tractus doctor` 요약과 앱 설정의 직접 지정 경로 점검(읽기 전용, 경고만, `--check`는 그대로), `update.sh [--check]`(깨끗한 작업 폴더·origin 추적 브랜치에서만 `git pull --ff-only` → 바뀐 커밋 → install, `tests/test_update_sh.py`), `clean.sh [--all] [--yes] [--force]`(`target`·`.build`만, 실행 중이면 거부). `app/src-tauri/Cargo.toml`에 `[profile.dev] debug = "line-tables-only"`: 깨끗한 개발 빌드의 `target`이 2.88GB → 2.08GB(−28%), 시간은 64초 → 68초. 깨끗한 복사본의 `install.sh --with-fluid` 실측: 5분 17초, 저장소 폴더 약 3.05GB(`.venv` 0.58, 녹음 프로그램 0.10, 헬퍼 0.95, `target` 1.22, `node_modules` 0.19, `Tractus.app` 약 17MB). 숫자와 사용법은 docs/setup.md. |
| 2026-10-15 | v3.28 | **경로 자동 해결, 모델 폴더 위치, 데이터 폴더 점검(코어·앱).** (A) 코어(`tractus`)·녹음 프로그램 경로는 설정이 비어 있으면 `자동`이다: 실행할 때마다 직접 지정(파일이 있을 때) → 환경변수(`TRACTUS_BIN`·`TRACTUS_REC_BIN`) → 앱 번들 안(`<앱>/Contents/Resources/runtime/bin/tractus`·`bin/tractus-rec`, `current_exe()` 기준) → 컴파일 때 저장소 → `~/.local/bin`·`/opt/homebrew/bin` 순으로 찾고 저장하지 않는다(`save_settings`는 자동 후보와 같은 값을 파일에 쓰지 않는다). 없는 저장 경로는 읽을 때 자동으로 되돌리고 시작 점검이 알린다. 설정 화면은 찾은 경로·출처와 `자동`/`직접 지정`(`찾아보기…`, `자동으로 되돌리기`), 시작 점검도 같은 단추를 준다. (B) 코어 `paths.models_dir()`: `TRACTUS_MODELS_DIR` → 등록된 모델이 이미 있는 `$TRACTUS_HOME/models` → 새 기본 `~/Library/Application Support/dev.tractus.app/models`(노트 폴더·iCloud 밖). `tractus models move <dest> [--yes]`가 등록된 모델 폴더만 옮기고(같은 볼륨은 rename, 공간·받기 잠금·같은 이름 확인을 먼저, `{moved, freed_bytes}`), 모델 화면에 `위치 바꾸기…`(옮긴 뒤에 설정 저장)와 `사용하지 않는 폴더 N개 정리`(`models list`의 `unregistered`, `models prune`)가 생겼다. (C) 시작 점검 `데이터 폴더`: iCloud Drive·Dropbox·OneDrive·Google Drive 안이거나 `.obsidian`이 있는 폴더 안이면 경고하고 `폴더 바꾸기…`(노트는 옮기지 않는다). 세부: docs/desktop.md §3.4, WORDS.md §4.19 |
| 2026-10-15 | v3.27 | **원본 녹음 용량 표시, 검색 갱신 간격(앱).** 변환 전 노트: Rust `meetings::info`가 `tracks_bytes`(`tracks/` 아래 파일 크기의 합, 변환 전 노트에만)를 목록·상세에 싣고, 노트 가운데에 `원본 녹음 N MB를 보관 중입니다…`(1 GB 이상·7일 초과면 `변환하지 않으면 용량을 계속 차지합니다.`), 사이드바 배지 `title`에 크기를 보인다(표시와 안내만, 자동 삭제 없음, `recorded.keptNotice`). 수정 뒤 검색 갱신(`indexSchedule.ts`)은 60초 조용 + 앞선 갱신 종료 뒤 5분 간격으로 바꿔 수정이 잦아도 임베딩 엔진을 자주 올리지 않는다(`docs/desktop.md` §3). 대기 표시(`dirty`)는 실패·비켜 감에서 지워지지 않는다. 앱을 끝내면 사라지지만 `tractus index`가 증분이라 다음 갱신이 따라잡는다. |
| 2026-10-14 | v3.26 | **양쪽 사이드 패널 접기·펼치기.** 왼쪽 노트 목록과 노트 화면의 오른쪽 패널(요약·AI 질문·메모)에 접기 단추(`⌘B`·`⌥⌘B`). 접어도 내용은 마운트한 채 `hidden`으로 숨겨 쓰던 메모·질문 스트림·요약 작업이 이어지고, 접는 패널 안의 초점은 단추로 옮긴다. 오른쪽을 접기 전에 `flushMemos()`로 메모를 저장하고 실패하면 접지 않는다. 접힌 왼쪽 띠에는 펼치기 단추와 녹음 단추가 남는다. 상태는 `localStorage` `tractus.panels.v1`(`{left, right}`), 저장한 값이 없고 창이 960px 미만이면 오른쪽만 접고 시작한다. 너비 애니메이션 없음. 자동 펼침은 녹음 노트의 메모 줄 열기와 `⌘K`(검색창이 목록 안)뿐이다. 코어·Rust 변경 없음 (docs/desktop.md §3.2, WORDS.md §4.17) |
| 2026-10-14 | v3.25 | **녹음과 변환 분리 (녹음 헬퍼·코어·앱).** 소유자 요청: "녹음과 변환을 분리하고 싶다 … 녹음을 끝내도 변환이 자동으로 실행되지 않고 나중에 변환할 수 있어야 한다." 새 노트 상태 **"변환 전"**: transcript.json에 선택 키 `"state": "recorded"`(`kind` 키는 없다 = 녹음 노트, `segments: []`, `audio` 채움, `asr` 없음), 변환하면 키가 사라진다. `tractus recording finish <녹음 폴더>`가 변환 없이 노트를 만들고(`audio.ogg`를 바로 들을 수 있고, 원본 트랙·`recording.json`은 노트의 `tracks/`에 보관, 녹음 중 메모·북마크는 `memos.json`), `tractus transcribe --into <노트>`가 나중에 같은 노트를 제자리에서 변환한다(`.job.json`의 `convert: true`로 이어하기, `store._job_pending`·`find_job(into=)`로 새 노트·덧붙이기 작업과 가름). 합치기는 `note_lock` 안에서 다시 읽어 결과 키만 덮어쓰므로 변환 중에 고친 제목·메모·태그가 살아남는다. 저장은 `transcript.json`이 마지막이고 `.finish.json`으로 어디서 끊겨도 같은 명령이 이어서 끝낸다(녹음 폴더는 끝까지 보존). 변환 전 노트를 읽는 모든 기능(검색·요약·AI 질문·내보내기·MCP·`notes list`·편집 명령)을 점검했다(docs/desktop.md §2.16). 바로 변환하는 길은 그대로다. "이어서 녹음"은 만들지 않았다(일시정지 후 계속이 같은 녹음 안에서 해결). 녹음 헬퍼는 `pause`·`resume` 명령과 `paused`·`resumed` 이벤트를 받고(§1: 일시정지 시간은 오디오 시계와 WAV에서 빠지고, 캡처 엔진은 계속 돌아 마이크 사용 표시가 켜져 있다), 앱은 `녹음을 끝내면`(`after_record`: 매번 묻기·바로 변환·나중에 변환) 설정과 끝낼 때 묻는 창, 변환 전 노트 화면·`변환 전 노트 모두 변환`을 갖는다(docs/desktop.md §3.3). |
| 2026-10-14 | v3.24 | **메뉴 막대(트레이) 아이콘 (이슈 #1).** macOS 메뉴 막대에 Tractus 아이콘: 상태 줄(`대기 중`/`녹음 중 12:34`/`변환 중 45%`), `녹음 시작`·`녹음 종료 및 변환`·`북마크 남기기`, `최근 노트` ▸(최근에 고친 순 5개), `Tractus 열기`, `종료`. 녹음 중에는 아이콘 옆에 경과 시간(`●12:34`). **역할 나누기:** 화면(webview)이 상태를 명령 `tray_update`로 밀어 주고(같은 값은 다시 보내지 않는다), Rust는 메뉴·아이콘·제목만 그린다. 녹음 시작·종료·북마크는 Rust가 하지 않고 이벤트 `tray-action`을 화면에 보내 창의 단추와 같은 함수로 처리한다(메모 저장·권한·마지막 녹음 방식·기능 잠금 그대로). 경과 시간은 화면 타이머가 아니라 Rust 1초 틱이 센다(숨은 webview는 타이머가 늦다). 설정 `tray_enabled`·`keep_in_tray`(둘 다 기본 켜짐, 실행 중 바로 적용): 켜져 있고 아이콘이 떠 있으면 창을 닫을 때 숨기기만 하고(Dock 클릭이 다시 보임) ⌘Q·`종료`는 기존 `begin_quit` 길이다. 아이콘은 검정 + 투명 템플릿 PNG(`scripts/make_tray_icons.py`, 자리표시자). Tauri 기능 `tray-icon`·`image-png` 추가(새 크레이트 `image`·`byteorder-lite`·`moxcms`·`pxfm`, 모두 MIT/Apache-2.0/BSD-3/Unlicense 계열). 리뷰 반영: 숨은 창에서 시작한 녹음이 실패·경고하면 창을 꺼낸다(`tray_show_if_hidden`), 가져오기 변환 중에도 상태 줄이 `변환 중`, 아이콘은 18pt 격자(18/36 px). 코어 변경 없음 (docs/desktop.md §3.1) |
| 2026-10-14 | v3.23.1 | **실시간에 표준 엔진(1.7B)을 쓸 수 있는지 재고(안 됨), 변환 엔진 표시를 `필수 (둘 중 하나)`로 바로잡음.** (A) `tractus live --engine lite\|std`(개발·벤치 전용, 기본 lite라 동작 그대로)로 같은 코드 경로에 1.7B를 올려 `bench/live_sim.py`(가상 `say` 대화 68초 ×2, 334초)로 쟀다(M3 16GB, 부하 평균 3–6). 확정 지연 p95가 1.59·1.73·1.95초로 기준 1.0초(단서 한도 1.25초)를 모두 넘어 **`not_feasible`**: 실시간은 계속 0.6B만 쓴다. RTF 0.29–0.33, 최대 footprint 3.45GB, 5분 메모리 증가 0%는 통과했고 CER도 더 낫지 않았다(0.186 대 0.150 · 0.178 대 0.164). 켠 직후 점유는 0.6B 1.14GB 대 1.7B 2.54GB. 기능 잠금·레지스트리·앱은 그대로다. 수치는 §2.6, `bench/results/live_summary.json`, docs/desktop.md §2.8. (B) `asr-std`·`asr-lite`가 둘 다 `필수`로 보여 둘 다 받아야 하는 것처럼 읽혔다. `models list`·`doctor`의 모델 항목에 추가 키 `level_note: "one_of"`를 두고 `level`은 `required` 그대로 둬서 옛 소비자를 깨지 않는다. 앱은 `필수 (둘 중 하나)`와 `변환 엔진: 설치됨`(둘 중 하나라도 있으면)을 보인다. 두 엔진의 용도 문구를 다시 썼다(가벼운 것: 실시간 텍스트 변환에는 이 엔진이 따로 필요, 표준: 가장 정확하고 16GB 이상 권장) |
| 2026-10-14 | v3.23 | **모델 받기·점검, 기능별 막기(코어).** 개발자가 저장소를 받아 직접 빌드해 쓰는 배포를 전제로, 필수 모델(VAD + 변환 엔진 하나)과 ffmpeg만 있으면 기본 흐름(녹음·가져오기 → 텍스트 변환 → 요약)이 돈다. `src/tractus/models_registry.py`가 모델 8개(`vad` `asr-std` `asr-lite` `diarizer` `aligner` `embedding` `voices` `fluid`)·기능 8개(`record` `convert` `diarize` `diarize-many` `align` `smart-search` `live` `voices`)·프리셋의 원본이다(저장소·리비전·파일 목록과 크기·URL·sha256, ASR·VAD도 리비전 고정). `tractus models list`(파일 크기로 `installed|missing|partial|corrupt`, 네트워크 없음)·`models download`(이어받기, 폴더당 한 프로세스 `flock`, 남은 공간 ≥ 크기×1.1, `.tractus-model.json`을 맨 마지막에, sha256 검증, SIGTERM이면 받던 파일을 남기고 130, 오류 코드 `no_network` `disk_full` `auth` `hash_mismatch` `helper_missing` `corrupt` `busy`)·`models remove`(모델 폴더 안만, 받기 중이면 거부)·`tractus doctor`(arm64·macOS 14.4+·8GB, ffmpeg·녹음·화자 분리 도우미, 기능별 `ready/missing/hint`, 없어도 종료 코드 0). **`--track` 없는 변환은 메모리가 권하는 엔진이 없으면 다른 쪽으로 바꾸고 경고 `asr_track_fallback`**(둘 다 없으면 `model_missing`). 코어의 받기 안내는 `tractus models download <id>`와 `hf download … --revision …`를 레지스트리에서 만든다. 결정: 손상 모델은 받기가 거부하고 `remove` 뒤 다시 받는다(코어는 `remove` 말고 파일을 지우지 않는다), `standard` 프리셋에는 실시간용 `asr-lite`가 없다(실시간은 0.6B가 따로 필요하다는 안내를 앱이 한다), fluid는 도우미 빌드 뒤에만 받는다 (docs/desktop.md §2.15) |
| 2026-10-14 | v3.22 | **설정에서 AI 키 등록(Upstage, 최소).** 앱 설정 폴더의 `llm_key`(0600, 원자적 쓰기)에 키를 두고, 요약·AI 질문을 돌리는 `tractus` 프로세스에만 `UPSTAGE_API_KEY`(+공급자가 없을 때 `TRACTUS_LLM_PROVIDER=upstage`)를 환경변수로 넘긴다. MCP·녹음 등에는 넘기지 않고, 앱 프로세스 환경의 값을 덮어쓰지 않는다. 노트 폴더·`settings.json`·webview에는 키가 나가지 않는다. 코어(Python) 변경 없음. 앱: 설정 › `AI 요약·질문`, 키가 없을 때 요약·질문 오류에 `설정 열기` (docs/desktop.md §2.14) |
| 2026-10-14 | v3.21.1 | **리뷰 반영(v3.19~v3.21).** (A) `_new_job`이 덧붙이기 작업을 새로 만들 때 이전 `.job.json`·`.chunks.jsonl`을 비운다(끝내지 못한 추가 뒤에 다른 파일을 추가하면 이전 파일의 청크가 새 전사에 섞이던 버그). 앱: 파일을 놓으면 확인 대화상자가 먼저 뜬다. (B) 노트 끌어 놓기를 HTML5에서 포인터 이벤트(`noteDrag.ts`)로 다시 만들었다(Tauri 창이 macOS에서 창 안의 끌어 놓기를 가져갈 수 있다). transcript.md frontmatter의 `title`·`tags`·`folder`가 YAML에서 문자열로 읽히게 따옴표를 붙인다(`yes`·`2026`·`=` 등). 필터·폴더 이름 바꾸기·삭제는 해당 키·폴더 ID가 글자로 없는 노트를 해석하지 않는다. 내용을 저장하면 목록의 `updated_at`을 바로 반영한다. 앱 제목 순서를 코어와 같은 규칙(casefold·코드 포인트 순)으로. `none`은 폴더 이름으로 쓸 수 없고, 보이지 않는 글자는 태그·폴더 이름에서 뺀다. 폴더 메뉴 `다른 폴더로 옮기기…`. (C) 요약 지침 구분자를 반복해서 지운다, 50개 한도를 AI 호출 전에 검사, 앱의 내 유형·직접 요약 탭을 만든 시각 순으로, MCP `has_summary`·`get_summary`가 유형별 요약을 본다, `tractus export --summary KEY`(md·docx에 고른 요약, 없으면 있는 요약) |
| 2026-10-14 | v3.21 | **요약 유형(템플릿)과 직접 프롬프트: 한 노트의 여러 요약.** `tractus summarize <노트> [--template ID | --custom]`·`templates list|save|delete`·`summaries <노트> list|delete`(docs/desktop.md §2.13). 기본 유형 6개(`src/tractus/templates/*.md`: meeting 회의록·brief·todo·lecture·interview·ideas)와 내 유형(`$TRACTUS_HOME/templates/u-<hex8>.md`, 이름 40자·방법 4,000자·50개). **저장:** 기본(회의록)은 `summary.json`·`summary.md` 그대로(옛 스키마, MCP `save_summary`·`list_action_items`도 여기만), 다른 유형·직접 요약은 `summaries/<key>.json`·`.md` 스키마 v2(`{template, template_name, title, overview, sections[{heading, style: bullets|checklist|numbered, items[{text, segment_ids, owner, due}]}], prompt_hash, prompt?}`). key는 유형 ID 또는 한 번만 쓴 요약의 `c-<hex8>`(같은 key로 다시 만들면 덮어쓴다), 옛 파일은 옮기지 않고 읽는 쪽이 `회의록`으로 본다. **안전:** 시스템 프롬프트(언어·근거 ID·owner·입력 속 지시문 무시)가 앞에, 요약 지침은 `<요약 지침>` 구분자로 감싸 그 뒤에, JSON Schema가 맨 끝에 온다(지침은 구성·어투만 정한다). 근거 ID(`s####`·`m####`)는 모든 항목에 필수이고 `clean_owners`는 모든 섹션에 적용된다. 직접 요약은 성공한 뒤에만 `save_as`로 내 유형을 저장한다. 제목 바꾸기는 모든 요약 파일에 적용되고 bundle은 `summaries/`를 싣는다(검색 색인에는 들어가지 않는다). MCP `get_summary(meeting_id, template?)`. 측정(solar-pro4, 가상 전사, 유형 5 + 스키마 방어 + 주입 무시 7개 × 4회): 28/28 통과(지침 다듬은 뒤 14/14). 앱: `요약` 탭에 `요약 유형` 메뉴(여러 개를 고르면 차례로 한 번에)·`직접 프롬프트로 요약…` 대화상자·유형 탭·요약마다 `다시 만들기`/`삭제`/낡음 안내, 설정 › 요약 템플릿, 복사·PDF는 고른 요약 하나만 |
| 2026-10-14 | v3.20 | **노트 정리: 즐겨찾기·태그·폴더·정렬.** transcript.json 선택 키 `favorite`·`tags`(20개·30자)·`folder`와 `updated_at`(내용이 바뀐 `edit_transcript` 저장에서만 올림), `$TRACTUS_HOME/folders.json`(3단계, 지워도 노트는 상위로). `tractus note meta`·`folders list|create|rename|move|delete`·`notes list --sort/--order`, `search --tag/--folder/--favorite`, MCP `list_meetings`·`search_meetings` 필터, transcript.md frontmatter `tags`·`favorite`·`folder`(docs/desktop.md §2.12). 앱: 사이드바 즐겨찾기·폴더 나무·태그·순서·제목 거르기, 노트 머리 ★·폴더·태그 편집기, 끌어 놓기 |
| 2026-10-14 | v3.19 | **글만 있는 노트에 녹음 추가.** `tractus transcribe <파일>|--recording <폴더> --append-to <노트>`(docs/desktop.md §2.11). 대상은 글만 있는 노트(`kind: "memo"`, 오디오 없음)여야 하고 아니면 종료 코드 2(`append_has_audio`·`append_note_missing`, WORDS 문장). 새 폴더를 만들지 않고 그 노트 폴더에서 평범한 파이프라인(VAD·화자 분리·ASR·단어 싱크·목소리 제안)을 돌린다. 끝나면 `note_lock` 안에서 노트를 녹음 노트로 바꾼다(`attach.finish_append`): ASR 세그먼트(`s####`)·`audio`·`asr`·`speakers`·`diarization`을 쓰고, 쓴 글은 `memo` 블록(`m####`)으로 옮기며, `kind`·`body`·`seg_seq`는 지우고 제목·id·`created_at`·그 밖의 키(`tags` 등)는 그대로 둔다. 메모 노트의 세그먼트 ID(`s####`)는 새 ASR ID와 번호가 겹치므로, 그 ID를 가리키던 `summary.json`(+`summary.md` 다시 만들기)·`chat.json`(인용 `segment_id`/`source`와 답 속 `[s0003]`)을 같은 줄의 `m####`로 옮긴다. 옮길 수 없는 ID(없어진 줄)는 그 인용 하나만 빠지고 항목·질문 기록은 남는다. 요약·질문 기록을 먼저, `transcript.json`을 마지막에 쓰고 옮기기는 같은 결과로 다시 돌 수 있어(이미 `m####`면 그대로) 끊겨도 같은 명령을 다시 돌리면 이어진다. 작업 파일(`.job.json`, 새 필드 `attach: true`)은 그 노트 폴더에 있고, 노트가 아직 메모 노트인 동안은 `transcript.json`이 있어도 낡은 것으로 지우지 않는다(`store._job_pending`, `find_job(…, append_to=)`가 새 노트를 만드는 작업과 덧붙이는 작업을 가른다). 검색 색인은 `transcript.json` 해시가 바뀌어 다시 만들어진다(메모 줄은 `source: "memo"` 청크). 앱은 녹음을 시작할 때 `recordings/<ULID>/attach.json`(`{"meeting_id"}`)을 쓰고(녹음 헬퍼는 모른다) `--append-to`를 명시해 넘긴다. attach.json만으로는 덧붙이지 않는다(`transcribe --recording`은 새 노트를 만든다). 끊긴 녹음은 `PendingRecording.attach_to`로 대상 노트를 기억해 사이드바에 `‘제목’ 노트에 추가할 녹음`으로 남는다. 앱: 메모 머리에 `녹음 추가`·`파일에서 추가`(파일 하나를 노트에 끌어 놓아도 된다), 추가하는 동안 글은 읽기 전용이고 삭제·요약은 막는다(Rust `busy`가 노트를 쓰는 중으로 표시). 알려진 한계: 추가하는 동안의 AI 질문은 막지 않는다(`chat.json`은 잠금이 없다). |
| 2026-10-13 | v3.18 | **노트 제목 바꾸기와 메모 노트.** `tractus note new|save|title`(docs/desktop.md §2.10). 메모는 오디오 없는 평범한 노트 폴더다: transcript.json에 `"kind": "memo"`, `audio.file: null`, `body`(사용자 글 그대로), `seg_seq`(마지막으로 낸 세그먼트 번호)가 있고 `segments`는 `body`의 비어 있지 않은 줄마다 하나(`start=end=0`, `line` = 줄 번호)다. 그래서 검색·AI 질문·요약·내보내기·MCP가 그대로 동작한다. 저장할 때 difflib로 줄을 맞춰 같은 줄·같은 자리에서 고친 줄은 ID를 이어받고 새 줄은 새 번호를 받아(s9999 다음은 처음으로 돌아가 빈 번호) 요약의 근거 ID가 유효하게 남는다. `kind`가 없는 옛 노트는 녹음 노트(파일을 고치지 않는다). 메모에는 vtt·`duration`·`asr`가 없고, srt·vtt 내보내기·단어 싱크·목소리 등록·참석자 지정·`segments edit`은 종료 코드 2로 거절한다. 시각 자리는 `store.stamp()`(메모는 `n번째 줄`)로 통일한다(ask 인용·검색 결과·MCP). 제목 바꾸기는 폴더 이름을 그대로 두고(찾는 기준은 ULID) transcript.json·md·vtt·summary.json/md 제목·색인을 `note_lock` 안에서 바꾼다.  **녹음 노트의 메모(v3.18 추가).** 녹음 노트도 사용자가 적은 메모를 가진다: transcript.json의 선택 키 `memo`(`body`, `lines[{id m####, line, text}]`, `seq`). 앱 오른쪽 패널의 세 번째 탭(요약 / AI 질문 / 메모)에서 쓰고 `tractus note save`가 메모 노트·녹음 노트 모두에 쓴다(녹음 노트는 `memo` 블록만, 비우면 키를 지운다, 출력에 `kind` 추가). 줄 ID 규칙은 메모 노트와 같은 코드(`notes.derive_lines`)다. 메모 줄은 색인에서 ASR과 섞이지 않는 자기 청크(`source: "memo"`, 스키마 변경 없음), AI 질문 근거의 별도 블록 `[내가 적은 메모]`, 요약 프롬프트의 별도 블록(`segment_ids`에 `m####`을 쓸 수 있음), transcript.md·txt·md·csv·docx의 `메모` 절, MCP의 `source: "memo"`·`get_transcript` 끝의 memo 구간으로 간다. 위치 표기는 `메모 n번째 줄`(`store.stamp`). 메모 없는 노트의 프롬프트·색인·내보내기는 바뀌지 않는다. 결정: 메모는 전사에 섞지 않고 별도 `source`로 가른다(오인식 보정·시각 가정이 달라서). 알려진 한계: 메모를 비우고 다시 쓰면 `m0001`부터 다시 시작해 옛 요약의 `m` 근거와 겹칠 수 있다. 측정(solar-pro4, 가상 노트만, 2026-10-13): `bench/ask_eval.py` 28문항은 메모 변경 전후 같다(정밀도 0.97, 재현율 0.93, 적중 1.00, 프롬프트가 글자 단위로 같음). `--memo`(메모가 달린 가상 노트 3건 + 답이 메모에만 있는 질문 6개 추가, 34문항): 정밀도 1.00, 재현율 0.94, 적중 1.00, 메모 질문 적중 6/6. 메모 블록을 대화 기록 뒤에 두면 노트 범위 질문에서 20회 중 5회 '근거 없음'으로 거절해 앞으로 옮겼다(0/40). `pytest -m llm` 7개 통과(3회).|
| 2026-10-13 | v3.17 | **한계 정리.** 노트 폴더 잠금 `store.note_lock`(`<노트>/.lock`, `fcntl.flock`)으로 transcript.json을 고치는 모든 경로(편집·화자·목소리·정렬 병합)를 직렬화한다. 원문으로 되돌리면 처음 정렬한 단어 시각을 복원한다(`words_asr`, 선택 키). 목소리 제안 거절은 `speakers[라벨].dismissed`로 남아 `voices match`가 다시 제안하지 않고, `voices forget`은 노트·미완 작업의 제안도 지운다. `voices enroll` 실패 시 voices.json 롤백, `voices list`에 `model_present`, `tractus render`, 끝난 노트에 남은 `.job.json` 정리. `docs/desktop.md` §2.1·2.2·2.6·2.7 **실시간·단어 싱크·화자 분리 가장자리 (영역 D).** (1) `tractus live`: 모델을 올리는 중에 정지가 오면 VAD·ASR 사이에서 멈춘다(ASR 로드 1–2초를 건너뛰어 상한 2초를 지킨다). (2) 밀림 방어(`MAX_LAG_S` 10초)를 step 끝이 아니라 ASR 앞에서도 본다: 낡은 발화는 전사하지 않고 건너뛰며(`done.stats.dropped_finals`), 그래서 `id`에 빈 번호가 생길 수 있다(문서 정정). (3) SIGINT·SIGTERM 핸들러를 끝나면 되돌린다. (4) `--progress-json` 없이 실행하면 확정 자막을 터미널에 찍는다. (5) `tractus align`: 모델이 못 맞춘 세그먼트는 `words: null` 대신 단어를 고르게 편 `approx: true` words로 채운다(스키마 키 추가 없음, 결과 JSON에 `approximate` 추가, `failed`는 단어 없는 세그먼트뿐). (6) 정렬 병합이 `store.note_lock` 안에서 읽고 쓴다. (7) `--diarizer fluid`가 60초 미만 클립이면 `fluid_short_clip` 경고(경고만, auto는 그대로). **앱 가장자리 (영역 C).** (1) 노트 삭제가 저장 중인 수정(문장·참석자·목소리 등록·내보내기)을 기다린다: 노트별 저장 줄(`editQueue.ts`)을 비운 뒤 지우고, Rust 짧은 명령이 노트를 쓰는 중으로 표시한다(`BusyGuard`). (2) 지워진 노트를 가리키는 전체 질문의 인용 칩은 눌리지 않고 `삭제된 노트입니다`. (3) 가라오케: 시작이 같은 단어와 길이 0인 단어를 균등 분할·최소 0.12초로 칠한다(`wordClock`, 이진 탐색 유지). (4) 단어 싱크 작업 상태를 노트 ID별 앱 저장소에 둔다(노트를 닫았다 열어도 진행 유지). (5) 목소리 모델이 없으면(`model_present: false`) 등록 체크를 끄고 이유를 보인다. (6) 문장을 고친 뒤 20초가 지나 앱이 한가하면 조용히 `tractus index`(Rust `index_refresh`)로 임베딩을 맞춘다. (7) Rust 오류의 OS 문구는 문장이 아니라 `자세히`로 간다(첫 줄 = 문장, 나머지 = 자세히). (8) 메모리 부족으로 켜지 않은 실시간 변환은 `일시 중지` 없이 그 문장만 보인다. (9) 삭제 거절은 `.job.json`이 있고 `transcript.json`이 없을 때만이다. **검색·질의 (영역 A).** (1) `Index.stats()`에 `pending`(지금 모델로 벡터가 없는 청크, 모델이 바뀌면 전체)을 더해 `tractus index` 요약·MCP `status` 힌트가 쓴다. 교정으로 바뀐 청크만 다시 임베딩함을 테스트로 고정했다. (2) 전체 범위 질의는 후속 질문에 직전 사용자 질문 최대 2개를 보탠 검색을 단독 질문 검색과 번갈아 섞는다(`ask._hits`, 단독 질문에 keyword 일치가 없을 때만, LLM 호출 없음). `bench/ask_eval.py --followups [--alone]`와 `tests/fixtures/eval/ask_followups.jsonl`. (3) 질문 a16의 '근거 없음'은 거절이 아니었다: 모델이 프롬프트 예시 `[<meeting_id>#s0012]`를 베끼거나 인용을 빠뜨려 인용이 하나도 안 남았다(옛 프롬프트 85회 중 4회, 새 프롬프트 100회 중 1회, 거절 문장은 185회 중 0회). 예시를 실제 ID로 바꾸고 `finalize`가 `<meeting_id>`를 받는다. (4) `done`과 `chat.json` 답에 `no_evidence`(인용이 없음)를 더했다(키 추가만). 옛 기록은 `ask.turn_no_evidence`가 `citations`로 판단한다. `docs/desktop.md` §2.5·2.1 **통합 점검.** 4개 영역을 합쳐 임시 홈에서 확인했다: 편집→되돌리기(원래 시각 복원), 정렬 병합과 편집·화자 이름 변경 동시 실행(잃은 갱신 0), 등록→거절→재매칭(거절 유지)→삭제(노트·미완 작업의 제안이 사라짐), `render --all`, `index`(벡터 없는 청크 → 0, 고친 문장이 의미 검색에 잡힘), 후속 질문 질의. 앱↔코어 계약은 `index_refresh`의 인수가 `tractus index`와 같고, `voices list --json`의 `model_present`를 Rust가 실제 출력 그대로 읽는다(`parses_real_core_outputs`). 알려진 한계: 설정의 스마트 검색 상태 줄(`vectors < indexed_chunks`)은 모델이 바뀌어 전체 벡터가 낡은 경우(`pending`)를 보이지 않는다. **리뷰 후속.** 임베딩 중 청크가 다시 쓰이면 낡은 벡터를 넣지 않는다(`_ensure_vectors`가 저장 직전에 청크 본문을 대조). `voices.json`은 `$TRACTUS_HOME/.voices.lock`(`voices.profiles_lock`, 노트 잠금 다음 순서)으로 등록·forget·롤백을 직렬화하고, `voices match`는 계산 중 forget된 사람의 제안을 버린다. `voices forget`은 그 사람을 가리키는 기록이 없는 노트를 다시 쓰지 않는다. `render --all`은 키가 빠진 transcript.json도 건너뛴다. 앱: 백그라운드 갱신 프로세스를 녹음·변환·질문 시작 때 멈추고 전체 질문도 busy로 표시한다. 오류 문장만 보이던 노트·목록·설정 화면에 `자세히`를 붙였다. 전체 질문 인용 칩은 창 복귀·질문 창 열기 때 목록을 다시 읽어 판단한다. 알려진 한계: 전체 범위 프롬프트의 인용 예시가 실제 ID라서 모델이 그대로 베끼면 근거 밖의 인용이 통과할 수 있다. 원격 LLM으로 `bench/ask_eval.py`를 후속 질문 유무로 나눠 재야 한다(미측정). |
| 2026-10-08 | v3.16 | **노트 삭제 (앱 전용).** 노트 화면 머리의 '삭제'와 사이드바 '변환 대기 중인 녹음'의 '삭제'가 앱 안 확인 대화상자(네이티브 모달 `<dialog>`, 초점은 '취소')를 거쳐 폴더를 **macOS 휴지통으로 옮긴다**(`trash` 크레이트 MIT, `NSFileManager`). 영구 삭제 없음. Rust 명령 `delete_meeting`·`delete_recording`이 ID·폴더 위치(심볼릭 링크 거절)·`.job.json`·쓰는 중인 작업(`AppState.busy`)을 검사한다. 검색 색인은 `Index.sync`가 사라진 폴더의 청크·키워드 색인·벡터를 지우므로(테스트 추가) **코어 명령을 더하지 않았고, MCP에 삭제 도구를 두지 않았다**. 목소리 프로필·자주 쓰는 단어는 건드리지 않는다. `docs/desktop.md` §2.9 |
| 2026-10-07 | v3.15 | **Phase 7.3 9명 이상 화자 — 두 번째 화자 분리 엔진.** Swift 헬퍼 `tractus-diar`(recorder/ 패키지, FluidAudio v0.17.5 = 커밋 `0b1f462`, Apache-2.0)가 `OfflineDiarizerManager`(pyannote community-1을 Core ML로 옮긴 것, 모델 `FluidInference/speaker-diarization-coreml` revision `df2625ac…`, CC-BY-4.0)를 오프라인으로 돌린다. `transcribe --diarizer auto|nemotron|fluid`(기본 auto): auto는 Nemotron을 돌리고 8채널을 모두 썼을 때만 fluid로 다시 돌린다. 헬퍼·모델이 없으면 `diarizer_cap`(auto)·`fluid_missing`(fluid) 경고 후 Nemotron 결과를 쓴다. `diarization.engine`, `--max-speakers` 상한 해제. AI Hub 17명 세션 confusion **28.5% → 6.9%**(같은 채점기로 Nemotron turn 직접 채점), 7명 세션 195는 3.2 → 3.8%(auto는 7명이라 다시 돌리지 않음). 앱 화자 색 슬롯 8 → 16(9번째부터 같은 잉크에 속 빈 점·빗금 막대). §2.4 |
| 2026-10-07 | v3.14 | **Phase 7.2 실시간 자막 core (옵트인, 미리보기).** `tractus live --recording <dir> [--progress-json] [--speakers] [--force]`: 녹음 중인 트랙 WAV를 꼬리부터 읽어 표본 위치로 섞고(amix normalize=0과 같음), 48k → 16k 상태 있는 FIR로 줄여 Silero `feed()`에 넣는다. 0.5초 무음이나 8초 상한에서 확정하고 3초마다 미리보기를 낸다. ASR은 Qwen3-ASR 0.6B 8bit만 쓴다. 아무것도 저장하지 않으며, 정지하면 이 워커가 먼저 끝나고 배치 전사가 정식 전사를 만든다. 가상 대화 68초 실시간 실측: 확정 지연 p50 0.60초·p95 0.72–0.76초, footprint 최대 1.8GB, GPU 사용률은 시스템 전체 29%에서 기준값을 뺀 약 12%p(프로세스 몫은 sudo가 필요해 재지 못함), 정지 → 종료 0.13–0.19초. 계약: `docs/desktop.md` §2.8, 설계: §2.6 |
| 2026-10-07 | v3.13 | **Phase 7.1 목소리 프로필 core.** onnxruntime 1.30(MIT, CPU)과 kaldi-native-fbank(Apache-2.0)로 3D-Speaker CAM++ zh_en advanced(192차원, Apache-2.0, sha256 고정)를 직접 돌려 화자 임베딩을 만든다. sherpa-onnx는 휠에 espeak-ng(GPL-3)가 정적 링크돼 있어 쓰지 않는다. `transcribe`는 화자 분리 뒤 등록된 목소리와 맞춰 `voices` 단계에서 이름을 **제안**한다(`speakers.S1.suggested`, 확정은 사용자). 매칭은 사람 중심 벡터와 코사인 + 헝가리안 1:1 + 임계값 + 2위와 차이 0.08. `tractus voices list\|enroll --consent\|forget\|match`, `tractus speakers <회의> dismiss`. 프로필은 `$TRACTUS_HOME/voices.json`(0600)에만 두고 회의 폴더·MCP·LLM·색인·내보내기로 보내지 않는다(§2.5). 계약: `docs/desktop.md` §2.7 |
| 2026-10-06 | v3.12 | **Phase 6.1 단어 타임스탬프 core.** Qwen3-ForcedAligner-0.6B-8bit(Apache-2.0, revision 고정)로 `segment.words`를 채운다. `transcribe`는 ASR 모델을 내린 뒤 `align` 단계를 돌린다(`--no-align`으로 끔, 모델이 없으면 `aligner_missing` 경고 후 words null). 기존 회의는 `tractus align <회의> [--force]`. 단어 = 표시 텍스트의 공백 토큰(1:1 불변식). mlx-audio의 한국어 토크나이저는 soynlp(LGPL-3)를 불러오므로 공백 토크나이저로 바꿔 끼운다. 텍스트를 고치면 difflib으로 시각을 옮기고 새 단어에 `approx`. 실제 대면 회의 44.7분(세그먼트 295개): 정렬 66초, 294개 성공·1개 실패, 불변식 위반 0. 계약: `docs/desktop.md` §2.6 |
| 2026-10-06 | v3.11 | **Phase 6.3 회의 질의 core.** `tractus ask [--meeting] [--from/--to] [--save] --progress-json`: stdin JSON(질문 + history), 이벤트 `stage(retrieve)` → `sources` → `stage(answer)` → `delta`* → `done{answer, citations, provider, model}`. 회의 범위는 전사 전체, 전체 범위는 색인 검색 8개 + 앞뒤 세그먼트. 인용은 근거와 대조해 없는 ID를 지운다. 근거가 없으면 LLM을 부르지 않는다. `--save`는 회의 폴더 `chat.json`(최근 50개). `llm.stream_chat`, `Index.meeting_dir`. 평가 세트 `tests/fixtures/eval/ask_questions.jsonl`(28개)·`bench/ask_eval.py`. 계약: `docs/desktop.md` §2.5 |
| 2026-10-06 | v3.10 | **Phase 5 core.** 표시 텍스트 `seg_text`(= `corrected_text` 우선)를 md·vtt·요약 프롬프트·MCP·색인·CLI 검색·내보내기에 적용. `tractus segments <회의> edit`(stdin JSON 묶음, 원문과 같으면 교정 해제, 색인은 `embed=False`), `tractus glossary add`, `tractus export --format txt\|md\|srt\|vtt\|csv\|docx\|bundle`(python-docx MIT 추가). 가져오기: 해시 전에 `decode` 단계, 중복이면 `duplicate` 경고 후 `done`, 동영상(mp4·mov)은 `-vn`, 오디오 없는 동영상은 오류. 계약: `docs/desktop.md` §2.2–2.4 |
| 2026-10-04 | v3.9 | **화자 분리 도입 (D3 변경).** Nemotron 3 Diarization(mlx-audio, 가중치 OpenMDW-1.1, revision 고정)을 ASR 전에 회의 전체로 1회 실행하고, 화자가 바뀌는 지점에서 VAD 청크를 나눈다. AI Hub 84분·7명 세션: 7/7명, confusion 2.9%, DER 7.6%, 14초. 백업은 FluidAudio community-1. `transcript.json` schema_version 2(`segment.speaker`, `speakers`, `diarization`), `tractus speakers` 편집 명령, `--no-diarize`·`--max-speakers`, MCP·요약 프롬프트에 화자 표시, 색인 스키마 3. `NOTICE`에 모델 라이선스 |
| 2026-10-02 | v3.8 | **Phase 4 시작: B안(Tauri) 우선, D안(메뉴바 + Obsidian) 백업.** 공용 녹음 헬퍼 `tractus-rec`(Swift, 마이크 + Core Audio process tap 2트랙), Tauri 앱 `app/` 초안, 코어 변경(audio.ogg, transcript.vtt, memos.json, `--recording`, `--keep-tracks`, `--progress-json`, `$TRACTUS_HOME/.env.local`). 구성 요소 계약: `docs/desktop.md` |
| 2026-10-02 | v3.7 | **Phase 3 완료.** 검색 색인(FTS5 음절 bigram + sqlite-vec, strict 우선 + 벡터 가중 0.3 결합), 로컬 임베딩(Qwen3-Embedding-0.6B bf16, mlx-lm), MCP 서버 7개 도구(세그먼트 단위 인용, `save_summary`). Gemini CLI → Antigravity CLI. 실제 ASR 평가에서 동일 가중 RRF가 키워드보다 나빠(hit@1 0.50 vs 0.85) 결합 방식 변경 |
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
| D3 | **화자 분리: 로컬 Nemotron 3 Diarization**, ASR 전에 회의 전체로 1회 (2026-10-04 변경, 이전: 제외) | 주 사용 사례인 대면 회의(마이크 1개)에서 "누가 말했나"는 음성 기반 화자 분리로만 얻는다. 새 의존성·torch 없이 ASR과 같은 mlx-audio에서 돈다. AI Hub 실측 confusion 2.9% (§2.4). 9명 이상은 FluidAudio community-1로 다시 돌린다 (v3.15, §2.4.1) |
| D4 | LLM 공급자: **로컬 Gemma 4 31B, OpenAI(Codex 포함), Claude, Gemini, Upstage Solar** | 전부 OpenAI 호환 엔드포인트 보유 (차이점은 §3.3) |
| D5 | **데이터는 로컬 파일이 원본**, SQLite는 재생성 가능한 인덱스 | 메모·전사가 기기를 떠나지 않음. 사용자가 다른 도구(Obsidian, 에이전트 CLI)로 직접 열람 가능 |
| D6 | 임베딩 기본값 **로컬 Qwen3-Embedding-0.6B** (공식 가중치 bf16, mlx-lm으로 실행; 2026-10-15부터 mlx-community 8bit 변환본, 평가 면제 v3.29), 상용 API는 선택 | 메모를 로컬에 두려는 원칙과 일치. M3에서 약 11문단/초, 질의 1건 약 50ms (§4.2) |
| D7 | Claude Code · Codex CLI · **Antigravity CLI(agy)** 연동은 **MCP 서버**로 제공 | 세 CLI 모두 MCP 지원. 에이전트가 자기 구독/키로 Tractus 데이터를 도구로 조회. Gemini CLI는 2026-06 개인 계정 지원이 끝나 agy로 대체 (§5) |

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
│        ├──▶ MCP 서버 (stdio) ─────▶ Claude Code / Codex CLI / Antigravity CLI  │
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
  → FFmpeg: 16kHz mono PCM (+ 보관용 audio.ogg: Ogg Opus 32kbps. 녹음 폴더면 마이크·시스템 트랙을 amix로 섞음)
  → Silero VAD (MLX 포팅): 무음 기준 분할, 청크 ≤ 30초 (경계는 무음 지점)
  → 화자 분리 (Nemotron 3 Diarization, 회의 전체 1회): 프레임별 화자 확률 → 단일 화자 평활 → turn [(시작, 끝, "S1"), …]
  → 청크를 화자가 바뀌는 지점에서 분할 (1초 미만 조각은 이웃 조각에 병합, 청크마다 화자 하나)
  → 화자 분리 모델 해제 (del + mx.clear_cache) 후 ASR 모델 로드
  → 청크별 Qwen3-ASR generate (language: 자동, hotwords: 용어집, max_tokens: 청크 길이 비례)
  → 세그먼트 = 청크 텍스트 + 청크 시작/끝 시각 + 청크 화자
  → 청크마다 .chunks.jsonl에 기록 (중단 후 같은 명령으로 이어하기. 청크 경계·화자는 .job.json에 있어 VAD·화자 분리를 다시 돌리지 않음)
  → 끝나면 transcript.json + transcript.md + transcript.vtt 저장
  → ASR 모델 해제 후 단어 정렬 (Qwen3-ForcedAligner-0.6B, 세그먼트마다 1회) → segment.words 채워 다시 저장
  → 정렬 모델 해제 후 검색 색인
```

- **타임스탬프 (v3.12):** 세그먼트 시각은 VAD 청크 경계다. 단어 시각은 **Qwen3-ForcedAligner-0.6B-8bit**(Apache-2.0)가 후처리로 채운다(`align.py`).
  - 단어 = 표시 텍스트(`seg_text`)의 공백 토큰이다. `words`가 null이 아니면 `len(words) == len(seg_text(s).split())`이고 `words[k].text`는 k번째 토큰과 같다.
  - mlx-audio의 `tokenize_korean`은 soynlp(LGPL-3)를 불러온다. 이를 공백 토크나이저로 바꿔 끼우고 `language="Korean"`으로 부른다. `tokenize_space_lang`은 한자를 글자마다 나눠 단어 수가 어긋나므로 쓰지 않는다.
  - 문장부호만 있는 토큰은 모델에 보내지 않고 앞 단어 끝에 길이 0으로 둔다. 시각은 세그먼트 안으로 자르고 줄지 않게 맞춘다.
  - 60초 넘는 세그먼트, 모델 단어 수 불일치, 모든 단어 길이 0이면 그 세그먼트의 `words`는 null이다(세그먼트 단위로만 이동). 8bit 모델은 110~140초를 넘으면 시간이 틀어지는데, 세그먼트는 30초 이하다.
  - 정렬 실패는 전사를 막지 않는다. 모델이 없거나 예외가 나면 경고만 내고 `words`는 null로 둔다. 나중에 `tractus align`으로 채운다.
- **용어집 주입:** 참석자 이름·제품명·약어를 프롬프트로 전달해 ASR 단계에서 고유명사 오류를 줄인다. 모델별 지원 방식이 달라 어댑터에서 처리한다. Qwen3-ASR은 `hotwords`로 넣는다(Phase 0: 용어 재현율 72% → 84%).
- **언어:** 청크별 자동 감지가 기본이다. `ko`로 고정하면 영어 위주 발화를 번역하거나 반복 루프에 빠진다(Phase 0). 고정은 사용자 설정으로만 연다.
- **청크 크기:** 최대 30초. Phase 0에서 15·30·60초의 CER 차이는 0.3%p 안이었다.
- **라우드니스 정규화는 하지 않는다.** Phase 0 측정이 정규화 없이 이뤄졌고, 효과를 측정하지 않은 처리를 넣지 않는다.
- **VAD:** `mlx-community/silero-vad-v6`(MLX 포팅, 1.3MB). Phase 0의 torch 버전과 발화 구간이 100% 같아 torch 의존성 없이 쓴다.
- **반복 루프 방지:** `max_tokens = 16 × 청크 초 + 32`(정상 발화 p99 6.4토큰/초의 약 2.5배). 4글자 이상이 연속 3회 반복되거나 상한에 닿으면 루프로 보고, 언어 고정이면 자동 감지로 한 번 재시도, 그래도 반복이면 반복 구간을 한 번만 남긴다. Phase 0 출력 기준 오탐은 HiKE 1/1121, AI Hub 5시간 0건.

### 2.4 화자 분리 — Nemotron 3 Diarization (2026-10-04 결정)

**결정: `mlx-community/Nemotron-3-Diarization`(revision `59ed2dbf…` 고정, 가중치 OpenMDW-1.1, 코드 mlx-audio MIT)을 프로세스 안에서 실행한다.** 이미 설치된 mlx-audio 0.5.7이 지원하므로 새 의존성·torch가 없다. 출력 채널이 8개라 **Nemotron은 화자가 최대 8명**이다(9번째부터는 기존 라벨에 합쳐짐). 9명 이상은 §2.4.1의 fluid로 다시 돌린다.

| 측정 (M3·16GB) | 결과 |
| --- | --- |
| AI Hub 한국어 회의 84분·화자 7명 (세션 1개, 로컬 전용) | **7/7명 검출, confusion 2.9%, DER 7.6%, 14초** |
| 같은 세션, 화자 경계로 나눈 청크의 화자 순도 | **99.6%** (기존 30초 VAD 청크 85.7%) |
| AI Hub 화자 7–9명 세션 3개 confusion | 2.9 / 10.9 / 4.7% (10.9%는 끝부분 라벨이 한 번 바뀐 탓). 17명 세션은 8명 상한 때문에 26.5% |
| AMI 원거리 마이크 17.5분·영어 4명 | confusion 1.0% (비교 후보 중 최저). DER 26.1%는 대부분 놓친 발화이고, 발화 구간은 VAD·ASR이 정하므로 confusion이 중요하다 |
| 속도·메모리 | RTF 0.003–0.0045, 90분 18.6초, 피크 1.2–2.2GB. 긴 녹음에서도 라벨이 유지됨 |
| 가상 2화자 (macOS `say` Yuna + Grandpa) | 2/2명, 청크 화자 전부 일치 (`pytest -m slow`) |

- **평활 (`diarize.smooth`):** 프레임(10ms)마다 확률이 가장 높은 화자 하나(최대 확률 > 0.5) → 화자별 11프레임 다수결(이진 median) → 같은 화자 사이 1초 이하 무음 메움 → 1초 미만 turn 제거 → 다시 메움. 라벨은 처음 말한 순서대로 S1, S2, …
- **청크 분할 (`diarize.split_chunks`):** 화자가 바뀌면 앞 turn 끝과 다음 turn 시작의 중간에서 자른다. 1초 미만 조각은 같은 청크의 이웃 조각에 붙인다. 청크 안에서만 자르므로 30초를 넘지 않는다. 어느 turn과도 겹치지 않는 청크는 화자 `null`.
- **`--max-speakers N`:** 말한 시간이 많은 N명만 남기고, 나머지 프레임은 남은 화자 중 확률이 가장 높은 쪽에 붙인다.
- **모델이 없거나 실패하면** 화자 없이 전사하고 알린다(`warning` 이벤트 + stderr). 임베딩 모델이 없을 때와 같은 방식이다.
- **엔진 교체 비용:** `Diarizer.diarize(pcm) → [(시작 초, 끝 초, "S1"), …]` 하나만 맞추면 된다. 두 번째 엔진 FluidAudio community-1은 v3.15에서 9명 이상 회의용으로 붙였다(§2.4.1).
- **탈락:** Sortformer v1(CC-BY-NC), v2.1(4명 상한), pyannote 원본(게이트, torch), sherpa-onnx CAM++(AI Hub confusion 7.4%, 17명 세션에서 화자 수 폭주).
- **미검증:** ① 실제 대면 회의(마이크 1개) 녹음. ② (v3.52에서 확인: 화자 경계 분할로 청크가 짧아져도 CER +0.10%p) ③ 같은 TTS 엔진 음성끼리는 한 화자로 합쳐진다(macOS Grandpa·Grandma). 가상 음성은 순위 근거로 쓰지 않는다.
- 엔진·파라미터를 바꾸면 AI Hub(로컬, 지표만)와 가상 음성 **둘 다**에서 DER·confusion을 다시 잰다.

#### 2.4.1 9명 이상 — FluidAudio community-1 (2026-10-07, v3.15)

**결정: 기본은 Nemotron 그대로 두고, Nemotron이 8채널을 모두 썼을 때만 Swift 헬퍼 `tractus-diar`로 다시 돌린다(`--diarizer auto`).** 8채널을 다 쓰면 9명 이상이거나 한 사람이 둘로 갈렸을 수 있는데, 두 경우 모두 fluid가 더 낫다(아래 표 190·196). 7명 이하 회의는 Nemotron만 돈다.

- **헬퍼:** `recorder/diar/`의 별도 Swift 패키지(녹음 프로그램 패키지는 Swift 5.10으로 빌드되게, FluidAudio의 `traits: []`가 요구하는 tools 6.2를 이쪽에만 둔다). FluidAudio v0.17.5(커밋 `0b1f46289fe2`, Apache-2.0, `Package.resolved` 고정)의 `OfflineDiarizerManager`: pyannote 분할 → WeSpeaker 임베딩 → PLDA·VBx 군집, 화자 수 상한 없음. 설정은 FluidAudio 기본(community-1, 임계값 0.6, Fa 0.07, Fb 0.8)이다. NeMo 텍스트 정규화(Rust 바이너리)는 패키지 `traits: []`로 링크하지 않는다. 의존 그래프에 GPL·LGPL·AGPL 없음(fastcluster BSD-2, vbx Apache-2.0).
- **모델:** `FluidInference/speaker-diarization-coreml` revision `df2625ac79a7ac6b65ad868fee6d80f320da4232`(FluidAudio가 고정), 21MB, `models/speaker-diarization`(FluidAudio가 정한 폴더 이름). 저장소의 CC-BY-4.0 범위 파일만 받는다(레거시 `wespeaker*` 등 제외). 출처 표기는 `NOTICE` 8번. 받기는 `tractus-diar download --models models/speaker-diarization` 한 번, 실행은 `ModelHub.offlineMode = true`로 네트워크를 쓰지 않는다.
- **연결:** `diarize.FluidDiarizer`가 회의 전체를 임시 16kHz WAV로 써서 `tractus-diar run --audio … --models … [--max-speakers N]`을 인수 배열로 부른다. 헬퍼는 WAV를 메모리로 읽는다(90분 ≈ 345 MB). FluidAudio 디스크 소스는 임시 폴더에 float32 사본을 쓰고 정상 종료 때만 지워서, 시간 초과(SIGKILL)면 회의 오디오가 남기 때문이다. 시간 제한 120초 + 0.2 × 길이. 결과 turn에는 `smooth`의 turn 단위 정리(`_tidy`: 1초 이하 무음 메움 → 1초 미만 turn 제거 → 다시 메움 → S1… 다시 붙임)만 한다. 헬퍼 위치: `$TRACTUS_DIAR_BIN`, 없으면 `<저장소>/recorder/diar/.build/release/tractus-diar`.
- **실패 처리:** auto에서 헬퍼·모델이 없으면 `diarizer_cap`, 실패하면 `diarizer_failed` 경고 후 Nemotron 결과(8명)를 쓴다. `--diarizer fluid`인데 없으면 `fluid_missing`, 실패하면 `diarizer_failed` 경고 후 Nemotron으로 돌린다. 쓴 엔진은 `diarization.engine`과 `.job.json`에 남고, 이어하기는 다시 돌리지 않는다.
- **8채널 판정:** 평활한 뒤 남은 라벨 수로 센다. 아주 잠깐 쓰인 채널은 평활에서 지워지므로 그 회의는 다시 돌리지 않는다. `--max-speakers`가 8 이하면 다시 돌리지 않는다.

AI Hub 4세션 실측(2026-10-07, M3 16GB, 로컬 전용·지표만, `bench/diar_eval.py der`). 화자 분리기 출력 turn을 그대로 채점했다: 10ms 프레임, collar ±0.25초, 겹침 포함, 헝가리안 1:1. AI Hub 라벨은 회의를 빈틈없이 덮어 오경보는 0이고, 혼동(confusion)을 본다. RTF는 모델 로드 포함.

| 세션 (길이, 참조 화자) | Nemotron DER / 놓침 / 혼동 | 화자 수 | fluid DER / 놓침 / 혼동 | 화자 수 | auto가 쓰는 엔진 |
| --- | --- | --- | --- | --- | --- |
| 190 (89.8분, 17명) | 37.0 / 8.5 / **28.5%** | 8 | 11.9 / 5.0 / **6.9%** | 12 | fluid (8채널) |
| 195 (83.6분, 7명) | 4.1 / 0.9 / **3.2%** | 7 | 5.9 / 2.1 / **3.8%** | 7 | Nemotron |
| 196 (65.9분, 7명) | 17.2 / 5.9 / 11.3% | 8 | 4.5 / 2.3 / 2.2% | 7 | fluid (8채널) |
| 201 (72.2분, 9명) | 6.3 / 1.0 / 5.3% | 8 | 6.5 / 1.2 / 5.4% | 8 | fluid (8채널) |
| 4세션 합 (311.5분) | 16.8 / 4.1 / 12.6% | 오차 평균 2.75명 | 7.5 / 2.7 / 4.7% | 오차 평균 1.5명 | |
| 속도 (RTF) | 0.0030 (90분 17.7초) | | 0.0039 (90분 22.0초) | | |

- **완료 기준 충족:** 17명 세션 confusion 6.9% < 26.5%. 26.5%는 v3.9 때 전사 세그먼트 화자로 잰 Nemotron 값이고, 같은 회의를 turn으로 직접 재면 28.5%다. 17명 중 12명을 찾는다(남은 5명은 다른 화자에 합쳐짐).
- **세션 195(7명)** 는 fluid가 혼동 +0.7%p, DER +1.8%p로 조금 나쁘다. auto는 이 회의에서 Nemotron이 7채널만 써서 다시 돌리지 않으므로 결과가 그대로다. 그래서 기본을 fluid로 바꾸지 않았다.
- 파라미터는 조정하지 않았다(FluidAudio 기본값). 위 세션으로 맞추면 평가가 아니게 된다.
- **헬퍼 단독:** 90분 세션 피크 footprint 0.90GB(RSS 0.71GB). Nemotron을 내린 뒤 별도 프로세스로 돈다. 첫 실행은 Core ML 컴파일로 약 4초 더 걸린다.

가상 음성(`say`, `bench/diar_synth.py`로 만들어 `bench/diar_eval.py der --set`으로 채점, 지표만):

| 세트 | Nemotron 혼동 (화자 수) | fluid 혼동 (화자 수) |
| --- | --- | --- |
| Yuna + Grandpa, 2명·8발화 29초 | 0.0% (2) | 12.0% (3) |
| Yuna + Grandpa + Flo, 3명·12발화 46초 | 0.0%, 놓침 34.8% (2) | 26.3% (2) |
| Yuna + Eloquence 8개, 9명·36발화 143초 | 34.6% (3) | 66.7% (3) |
| `pytest -m slow` Yuna + Grandpa 4발화 | 2/2명, 청크 화자 일치 | 2/2명, 청크 화자 일치 |

- 가상 음성은 짧고, Grandpa·Grandma·Eddy·Flo 같은 Eloquence 음성은 같은 엔진이라 서로 잘 합쳐진다. 두 엔진 모두 9명 가상 회의를 3명으로 본다. **순위 근거로 쓰지 않는다.** 2명 30초 가상 대화에서 fluid가 한 사람을 둘로 가른 것은 auto가 7채널 이하에서 fluid를 쓰지 않는 근거 중 하나다.
- 실제 E2E(`tractus transcribe`): `--diarizer fluid`로 가상 3명 → `diarization.engine: fluid`(2명으로 봄, 위 표와 같음). AI Hub 196 auto → `diarize(nemotron)` 다음 `diarize(fluid)` 단계가 나오고 7명. 헬퍼가 없을 때 `fluid_missing` 경고 후 Nemotron. fluid로 시작해 중간에 죽인 작업을 `--diarizer nemotron`으로 이어도 화자 분리를 다시 하지 않고 engine은 fluid.
- **미검증:** 실제 대면 회의(마이크 1개)에서 9명 이상.

### 2.5 목소리 프로필 — 화자 이름 제안 (2026-10-07, v3.13)

**결정: 등록한 사람의 화자 임베딩과 새 회의의 화자를 맞춰 이름을 _제안_만 한다.** 제안은 앱에 "홍길동 님인가요? (일치율 82%)" 배지로만 보이고, 사용자가 '맞음'(= 그 이름으로 rename)으로 확정하거나 '다름'(dismiss)으로 지운다. 오인식이 요약의 담당자 이름으로 번지지 않게 확정 전에는 어디에도 이름으로 쓰지 않는다.

| 항목 | 값 |
| --- | --- |
| 런타임 | onnxruntime 1.30.0 (MIT, CPU 2스레드) + kaldi-native-fbank 1.22.3 (Apache-2.0). MLX 메모리와 겹치지 않는다. 입력은 80차원 Kaldi fbank(25ms/10ms, povey, dither 0, snip_edges=False)에서 프레임 평균을 뺀 값이다(모델 메타데이터 `feature_normalize_type=global-mean`). sherpa-onnx는 쓰지 않는다: macOS 휠이 TTS용 espeak-ng(GPL-3.0)를 정적 링크하고, 라이선스 고지에도 빠져 있다. onnxruntime은 1.29 이상이어야 한다. 1.28까지(sherpa-onnx 1.13.8 내장 포함)는 `AveragePool(ceil_mode)`의 마지막 짧은 창을 창 크기 전체로 나눠 PyTorch 원본과 임베딩이 달라진다(긴 구간에서 cosine 약 0.975). 벤치의 매칭 지표는 두 런타임에서 같았다 |
| 모델 | 3D-Speaker CAM++ zh_en advanced `3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` (192차원, 28MB, Apache-2.0 — ModelScope `iic/speech_campplus_sv_zh_en_16k-common_advanced`). k2-fsa 릴리스 `speaker-recongition-models`, sha256 `aa3cfc16…ceba2`를 불러올 때 확인한다 |
| 화자 임베딩 | 그 화자 구간 중 1.5초 이상을 긴 것부터 3개(10초 넘으면 앞 10초) → 구간 임베딩의 정규화 평균. 전사 중에는 화자 분리 turn, 기존 회의는 세그먼트를 쓴다 |
| 사람 중심 벡터 | 등록 표본(최대 5개, 넘으면 가장 오래된 것을 버림)의 정규화 평균 |
| 매칭 (`voices.match`) | 코사인 행렬 → `scipy.optimize.linear_sum_assignment` 1:1 배정 → 점수 ≥ `THRESHOLD` **그리고** 그 화자의 2위 사람보다 0.08 이상 높을 때만 제안. `THRESHOLD` = 0.70 (아래 '벤치 근거') |
| 가상 음성 (`pytest -m slow`) | macOS `say` Yuna 문장 2개 사이 0.94, Grandpa 0.95, 서로 다른 음성 0.23–0.27 |

**벤치 근거 (`bench/voice_eval.py`, AI Hub 한국어 회의 4세션·40명·발화 1,427개, 로컬 전용, 지표만 `bench/results/voice_summary.json`).** 화자 앞 절반의 긴 3구간으로 등록하고, 뒤 절반을 3개씩 묶어 매칭한다(probe 229개). CAM++, T=0.70:

| 정답 기준 | 사람 | 맞음 | 틀림 | 제안 없음 | 미등록자 오제안 |
| --- | --- | --- | --- | --- | --- |
| AI Hub 라벨 그대로 (기본) | 32 | 88.2% | 1.3% | 10.5% | 11.4% |
| 두 세션 사회자 1쌍을 같은 사람으로 (민감도, 미검증) | 31 | 95.6% | 1.3% | 3.1% | 2.2% |

- AI Hub 화자 ID는 세션마다 새로 붙어 세션 간 동일인을 알 수 없다. 두 행의 차이는 거의 전부 서로 0.9로 맞는 두 세션 사회자 1쌍(probe 20개)이다. 같은 사람으로 묶은 근거는 모델 점수와 역할뿐이고, AI Hub 화자 메타데이터는 연령대·직업이 달라 오히려 다른 사람 쪽이다. 다른 사람이라면 이 정도로 닮은 목소리는 임계값으로 막을 수 없다(2위와 차이 규칙이 둘 다 등록됐을 때만 막는다). 그래서 이름은 제안으로만 남기고 사용자가 확정한다.
- **위 수치는 등록과 probe가 같은 녹음(같은 방·마이크·날)이다.** 실제 사용(회의 A에서 등록, 회의 B에서 매칭)의 재현율은 재지 못했다. 근거는 그 1쌍뿐이다: 같은 세션 probe 평균 0.891 → 다른 세션 평균 0.827, 최소 0.736(0.75 이상 95%, 0.70 이상 100%). 회의가 바뀌면 점수가 약 0.06 내려가므로 0.75 대신 0.70을 쓴다. 대가는 같은 세션 오제안 +0.4%p다. 실제 회의 간 데이터가 생기면 다시 잰다.
- 모델 3종(CAM++, ERes2NetV2, ERes2Net base)의 3구간 등록 EER은 모두 2.62%였다. 가장 작고(28MB) 빠른(RTF 0.0085) CAM++를 골랐다. NeMo TitaNet small(CC-BY-4.0)은 특징 추출이 달라 sherpa-onnx를 뺀 뒤 비교에서 제외했다.

- **흐름:** `transcribe`는 화자 분리 → `_free_mlx()` → 청크 분할 뒤, 등록된 사람이 있을 때만 `voices` 단계를 돌린다. 제안은 `.job.json`의 `suggestions`에 두므로 이어하기 때 다시 계산하지 않는다. 등록된 사람이 없으면 아무것도 하지 않는다(경고 없음). 사람은 있는데 모델이 없으면 `voices_model_missing`, 실패하면 `voices_failed` 경고를 내고 전사는 계속한다.
- **등록 (`tractus voices enroll <회의> S1 --name 홍길동 --consent`):** 그 화자의 이름을 확정하고(= `speakers rename`) 목소리 표본을 더한다. 이름이 정확히 같은 사람이 있으면 그 사람에, 없으면 새 사람으로. `--consent`가 없으면 종료 코드 2.
- **모델 교체:** `voices.json`의 `model`이 지금 `MODEL_ID`와 다르면 매칭에 쓰지 않고 `voices list`가 다시 등록하라고 알린다. 다음 등록 때 옛 모델의 표본은 지운다(지금 모델과 비교할 수 없는 생체정보라).
- 모델·`THRESHOLD`·구간 선택을 바꾸면 `bench/voice_eval.py`를 다시 돌린다.

#### 개인정보 — 목소리는 생체정보다

목소리 임베딩은 특정 개인을 알아볼 목적으로 처리하는 생체인식정보이므로 개인정보보호법 제23조의 **민감정보**로 다룬다.

| 규칙 | 구현 |
| --- | --- |
| 별도 동의 | 등록은 `--consent`(앱: "본인이거나 녹음·등록에 동의를 받은 사람입니다" 확인)가 있어야 한다. 프로필에 `consent: true`를 남긴다 |
| 이 Mac에만 저장 | `$TRACTUS_HOME/voices.json` 하나. 권한 0600으로 임시 파일을 만들어 원자적으로 바꿔 끼운다(기존 권한과 상관없이 결과는 0600). 깨진 파일은 덮어쓰지 않는다 |
| 밖으로 보내지 않음 | 벡터는 회의 폴더·`transcript.json`·MCP 도구·LLM 프롬프트·검색 색인·내보내기·로그에 쓰지 않는다. `voices list`도 이름·표본 수·등록일만 출력한다 |
| 제안은 표시 이름이 아님 | `speaker_name`·`speaker_display`는 확정한 `name`만 쓴다. 이름이 없으면 md·vtt·요약·AI 질문 프롬프트·내보내기에는 `참석자 N`(`speaker_display`, WORDS.md §2)이, MCP·색인·CLI에는 라벨(`S1`, `speaker_name`)이 나가고, `bundle` 내보내기의 transcript.json에서는 `suggested`를 뺀다. 요약 owner가 확정되지 않은 제안 이름이면 `clean_owners`가 null로 바꾼다 |
| 삭제 | `tractus voices forget <이름\|id>`가 사람을 지우고, 회의에 남은 그 사람의 제안도 지운다(확정한 이름은 사용자가 붙인 것이라 남긴다) |

---

### 2.6 실시간 자막 — 녹음 중 미리보기 (2026-10-07, v3.14)

**결정: 녹음하는 동안 작은 모델로 자막을 미리 보여 주기만 한다.** 실시간 자막은 저장하지 않는다. 녹음을 멈추면 `tractus live` 워커가 먼저 끝나고, 지금까지와 같은 배치 전사(1.7B + 화자 분리 + 단어 정렬)가 정식 전사를 만든다. 설정에서 켜야 동작한다(기본 꺼짐).

```
tractus-rec가 쓰는 mic.wav · system.wav (48 kHz int16, 헤더 크기 필드는 0.25초마다 갱신)
  → WavTail: 헤더의 크기 필드 대신 파일 크기로 표본 수를 센다. 반만 쓰인 표본은 다음에 읽는다
  → Mixer: 같은 표본 위치끼리 더하고 [-1, 1]로 자름 (배치의 amix normalize=0과 같음). 1초 넘게 멈춘 트랙은 0으로 채움
  → Resampler: 48k → 16k (97탭 Hamming windowed-sinc, 차단 7 kHz, 이전 블록 꼬리를 이어 붙이는 상태 있는 FIR)
  → Segmenter: Silero feed() 512표본(32ms)마다 → 발화 자르기
  → Live: Qwen3-ASR 0.6B 8bit (language 자동, hotwords = glossary.md) → live 이벤트
```

| 규칙 | 값 |
| --- | --- |
| 확정 (`final`) | 발화 중 무음 0.51초, 또는 8초 상한. 상한은 마지막 약 1초 중 가장 조용한 창에서 자르고 나머지는 다음 발화로 잇는다. 상한이 끝 쉼(0.19초 이상) 안에서 걸리면 쉼에서 끝난 것으로 본다 |
| 미리보기 (`partial`) | 말이 이어지는 동안 약 3초마다 지금까지의 발화 전체. 무음을 세는 중이면 말이 다시 나올 때까지 미룬다 |
| 쉼 미리 전사 | 쉼이 0.19초 이어지면 그 순간의 버퍼가 곧 확정될 오디오와 같다(끝 무음은 0.19초만 남기므로). 이때 전사해 `partial`로 내고, 0.51초에서 확정할 때 같은 문장을 다시 쓴다. 확정 지연에서 ASR 시간(0.2–0.4초)이 빠진다 |
| 버리는 소리 | 0.26초보다 짧은 발화, 텍스트가 빈 발화(보여 준 미리보기가 없을 때) |
| 뒤처짐 | 라이브 끝에서 1초 넘게 뒤인 미리보기는 건너뛴다. 10초 넘게 밀리면 `live_lagging` 경고를 한 번 내고 밀린 오디오를 버린 뒤 라이브 끝으로 간다. 버린 발화에 미리보기가 있었으면 그 문장으로 확정한다 |
| 정지 | stdin `stop` 줄, stdin EOF, SIGTERM·SIGINT. 디스크에 남은 오디오를 읽고, 측정한 RTF로 1초 안에 끝날 전사만 한다. 못 하면 보이던 미리보기 문장으로 확정한다 |
| 메모리 | 1.7B를 올리지 않는다. 물리 메모리가 16GB 미만이면 `--force` 없이는 거부한다 |

**실측 (`bench/live_sim.py`, 2026-10-07, M3 16GB).** macOS `say` 두 음성으로 만든 대화 68초(발화 9개)를 tractus-rec와 같은 형식으로 실시간 속도로 쓰면서 측정했다. 결과는 `bench/results/live_summary.json`에 있다.

| 지표 | 화자 끔 (기본) | `--speakers` |
| --- | --- | --- |
| 확정 지연 p50 / p95 (발화 끝 표본을 쓴 순간 → `final`) | 0.60초 / 0.76초 (다른 실행 0.72·0.74초) | 0.61초 / 0.79초 |
| 처리 지연 p50 / p95 (0.51초 무음이 다 쓰인 순간 → `final`) | 0.02초 / 0.15초 | 0.04초 / 0.21초 |
| ASR 시간 / 오디오 길이 | 0.118 | 0.131 |
| 최대 footprint (`footprint -p`, Metal 버퍼 포함) | 1.82GB (RSS 1.19GB) | 2.97GB (다른 실행 3.24GB) |
| GPU 사용률 평균 − 시작 전 기준값 (시스템 전체, `ioreg`) | 29.4% − 17.5% = 약 12%p (다른 실행 46% − 29% = 17%p) | 56.5% − 14.2% = 약 42%p |
| CER (final을 이은 문장 vs 대본) | 15% | 15% |
| 모델 로드 · 정지 → 종료 | 2.2초 · 0.13초 | 비슷함 |

- 확정 지연의 대부분은 설계상 무음 대기(0.51초)다. 쉼 미리 전사를 넣기 전에는 p95가 1.08초였다.
- CER은 0.6B 미리보기 기준이다. `say`가 숫자를 읽은 소리("오 퍼센트")를 모델이 "5%"로 쓰는 차이가 포함돼 있다. 정식 전사 품질과 비교하는 숫자가 아니다.
- **표준 엔진(1.7B)으로도 되는지 (2026-10-14, `tractus live --engine std`, M3 16GB, 부하 평균 3–6이라 가벼운 엔진도 같은 조건으로 다시 쟀다):** 안 된다. 확정 지연 p95는 가벼운 엔진 0.80–1.01초(조용할 때 0.76초)에 비해 표준 엔진 **1.59 · 1.73 · 1.95초**(68초 두 번·334초, p50 0.99–1.22초)로 기준 1.0초를 59–95% 넘는다(+25% 단서 한도 1.25초도 넘는다). RTF 0.29–0.33(기준 0.5), 최대 footprint 3.42–3.43GB(4.5GB), 334초 메모리 증가 0%(10%), 뒤처짐·버려진 `final` 0은 통과. 켠 직후 점유 2.54GB(가벼운 것 1.14GB, +1.40GB). CER은 0.186(68초)·0.178(334초)로 가벼운 엔진 0.150·0.164보다 낫지 않다(가상 음성, 표본 작음). 원인은 ASR 호출마다 시간이 약 두 배이고 확정 지연이 무음 대기 0.51초에 ASR 한 번을 더하기 때문이다. 다시 따져 볼 길: 무음 대기를 늘리거나 미리보기 주기를 줄이는 것, 조용한 Mac에서 다시 재는 것. 그 전에는 레지스트리의 `live` 기능이 `asr-lite`를 요구한다.
- GPU 사용률은 `powermetrics`(sudo 필요) 대신 `ioreg`의 `Device Utilization %`를 0.5초마다 읽었다. 이 값은 시스템 전체라 이 Mac의 다른 작업이 함께 잡힌다. 그래서 시작 전 1초의 기준값을 빼서 적었다. 실행 중에 다른 작업이 바뀌면 틀리는 근사이고, `live` 프로세스만의 몫은 재지 못했다. 로드맵의 GPU 점유율 목표(0.29) 달성 여부도 그래서 확인하지 못했다. 화자 끔과 `--speakers`는 각각 다른 실행이라 기준값이 다르다.

**실시간 화자 라벨은 `--speakers`로만 켠다(기본 끔, `speaker: null`).** mlx-audio 0.5.7의 Nemotron 3 Diarization `feed()` 스트리밍('low' 프리셋, 입력 지연 1.04초)이 동작은 한다. 가상 대화에서 S1·S2 두 화자가 나왔다. 하지만 인코더가 0.72초마다 화자 캐시(최대 528프레임) 전체를 다시 돌린다. 그래서 GPU 사용률 증가분(기준값을 뺀 값)이 약 세 배(12–17%p → 42%p), footprint가 약 1.2–1.4GB 늘었다. 팬 없는 MacBook Air에서 녹음과 함께 오래 돌리기에는 부담이 커서 앱은 켜지 않는다. 라벨은 미리보기 안에서 처음 나온 순서이고 최종 전사의 라벨과 다를 수 있다. 정확도(DER)는 재지 않았다. 배치 화자 분리 엔진·파라미터는 바꾸지 않았으므로 §2.4의 DER 재측정 규칙에는 해당하지 않는다.

- **미검증:** 팬 없는 M3 Air에서 1시간 연속 사용할 때의 발열·스로틀링(사람이 직접 확인), 실제 대면 회의(원거리 마이크·겹침 발화)에서의 지연과 품질, 시스템 오디오를 섞은 화상 회의.

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
| Q&A (`tractus ask`, v3.11) | 질문 + 최근 대화(6개 메시지·12k자) + 근거: 회의 범위는 전사 전체(10만 자 초과 시 회의 안 검색), 전체 범위는 하이브리드 검색 상위 8개 청크 + 앞뒤 세그먼트 1개(§4.3, 날짜 필터) | 구조화 출력 대신 **평문 스트리밍**(`stream=True`) + 인라인 인용 `[s0012]` / `[meeting_id#s0012]`. 코어가 근거와 대조해 `{answer, citations[{meeting_id, segment_id, start}]}`를 만든다(없는 ID는 답에서 삭제). 근거가 없으면 "노트 내용에서 답을 찾지 못했습니다." |

- 모든 추출 항목에 **근거 `segment_ids`를 필수**로 둔다. UI에서 클릭하면 해당 오디오 위치로 이동하고, 환각 여부를 검증하는 데도 쓴다. 전사에 없는 ID나 빈 근거는 검증 실패로 보고 1회 재요청한다.
- 전사 줄에는 화자 표시 이름이 붙는다(`[s0012 00:05:31 김민수] …`, 이름이 없으면 `S1`). 화자는 자동 추정이라 owner는 사용자가 이름을 붙인 화자만 쓸 수 있고, `S1` 같은 라벨은 쓰지 않는다. 그 밖에 "제가 하겠습니다"처럼 말한 사람만 가리키면 owner는 null로 둔다.
- 프롬프트만으로는 라벨이 새어 나온다(2026-10-04 solar-pro4: 라벨이 붙은 가상 회의 3회 중 3회 owner `S2`). 그래서 `S1`·`Speaker 1`·"화자 1"·"발언자"·세그먼트 ID 형태의 owner는 저장 전에 null로 바꾼다(`summarize.clean_owners`, 대소문자 무시). `summarize`와 MCP `save_summary` 모두 `write_summary`를 거치므로 에이전트가 저장한 요약도 같다.
- AI Hub처럼 외부 반출이 제한된 데이터의 전사는 원격 공급자로 보내지 않는다. 스모크 테스트는 가상 회의 전사(`tests/fixtures/sample_meeting.json`)만 쓴다.
- Q&A는 답을 글자 단위로 보여 줘야 해서 JSON 스키마를 쓰지 않는다. 인용 검증은 재요청 없이 후처리로 한다(`ask.finalize`). 가상 회의 5건 × 질문 28개(`bench/ask_eval.py`, solar-pro4, 2026-10-06, 하이브리드·키워드 검색 각각): 인용 정밀도 0.97–1.00, 재현율 0.85–0.96, 정답 인용 질문 0.95–1.00, 답 없는 질문 5–6/6 '근거 없음', 첫 토큰 p50 0.4초. **검색 재현율은 아직 재지 않았다**: 말뭉치가 세그먼트 62개뿐이라 전체 범위 질문도 말뭉치의 35–58%(p50, 최대 71%)를 근거로 보내 정답이 빠질 수 없다. 검색 수치는 가상 방해 회의(50건 이상)를 섞은 뒤에 적는다. 모델이 예시의 `<meeting_id>` 꺾쇠를 그대로 베끼는 경우가 있어 파서가 받아 준다(v3.17: 전체 범위 프롬프트의 예시를 자리표시자 대신 실제 근거 줄의 ID로 바꿨고, 베낀 `[<meeting_id>#s0012]`는 답에서 정리한다).
- Gemma 4 31B 컨텍스트 안에 1시간 회의가 충분히 들어가므로 map-reduce 요약은 기본 경로에서 제외한다(입력 길이가 컨텍스트를 넘을 때만 사용).

---

## 4. 저장소 · 임베딩 · 검색 (전부 로컬)

### 4.1 파일 레이아웃 — 파일이 원본

```
~/Tractus/
├── meetings/
│   └── 2026-10-01_주간회의_01J9X.../
│       ├── audio.ogg             # 원본 (Ogg Opus 재인코딩 보관. Phase 1 회의는 audio.opus, Obsidian은 .opus를 열지 못함)
│       ├── transcript.vtt        # WebVTT 자막 (큐 ID = 세그먼트 ID). 브라우저 <track>, Obsidian Media Extended용
│       ├── memos.json            # 녹음 중 메모·북마크 [{t, kind, text}] (있을 때만)
│       ├── tracks/               # --keep-tracks일 때 녹음 원본 트랙 (화자 분리 대비)
│       ├── transcript.json       # 기계용 원본 (§6 스키마)
│       ├── transcript.md         # 사람/에이전트용 (타임스탬프 포함)
│       ├── summary.md            # LLM 산출물 (frontmatter에 provider/model 기록)
│       ├── summary.json          # 같은 내용의 기계용 원본 (MCP list_action_items 등에서 사용)
│       └── notes.md              # 사용자 메모
├── glossary.md                   # 용어집 (ASR 프롬프트 + LLM 교정에 공용)
├── voices.json                   # 목소리 프로필 (권한 0600, 생체정보 — §2.5). 회의 폴더·색인·MCP로 내보내지 않음
└── .tractus/
    └── index.sqlite              # FTS5 + sqlite-vec — 삭제해도 파일로부터 재생성 가능
```

- Markdown을 원본으로 두면 Obsidian 같은 도구나 에이전트 CLI가 별도 연동 없이 그대로 읽을 수 있다.
- 동기화·백업은 사용자가 원하는 도구(iCloud, Syncthing, git)에 맡기고, 앱은 관여하지 않는다.

### 4.2 임베딩

**결정 (2026-10-02 실측): 공식 `Qwen/Qwen3-Embedding-0.6B` 가중치(Apache-2.0, revision `97b0c614` 고정)를 bf16으로 mlx-lm(MIT)에 올려 직접 실행한다.** *(2026-10-15 변경: `mlx-community/Qwen3-Embedding-0.6B-8bit`(revision `407ad232`, 0.6GB)로 바꿨다. 아래 표의 실측은 bf16 기준이고 8bit는 검색 평가를 돌리지 않았다(소유자 면제), v3.29.)* 1024차원, 오른쪽 패딩 + 마지막(EOS) 토큰 풀링 + L2 정규화, 질의에만 `Instruct: …\nQuery:` 지시문(모델 카드 기본값, 영어)을 붙인다.

| 확인 항목 | 결과 |
| --- | --- |
| 정확도 | torch fp32 참조 구현 대비 코사인 최소 0.9998, 모델 카드 예시 점수 오차 0.003 이내 |
| 속도·메모리 (M3) | 400자 한국어 약 11문단/초, 질의 1건 약 50ms, 피크 1.4–1.8GiB, 첫 로드 약 3초 |
| 제외: `mlx-embeddings` | **GPL-3**이라 Apache-2.0 배포물의 의존성으로 쓸 수 없다 |
| 제외: mxfp8 · 4bit-DWQ 변환본 | fp32 대비 최저 코사인 0.88 / 0.90으로 품질 손실이 크다. 이 기기에서는 양자화가 오히려 느리다 |
| 제외: 왼쪽 패딩 | 패딩 마스크 없이 쓰면 결과가 틀린다(코사인 0.63) |

- 인덱스 메타에 `embedding_model`(저장소·revision·dtype·차원·지시문)을 저장한다. 값이 달라지면 벡터 테이블을 새로 만들고 전부 다시 임베딩한다.
- 임베딩 모델이 없거나 올리지 못하면 **키워드 검색만** 한다. 벡터가 빠진 청크는 다음 `tractus index`에서 채운다.
- 청크는 연속 세그먼트를 300–500자로 묶고, 각 세그먼트의 ID·시각·텍스트를 함께 저장한다(세그먼트 단위 인용용).

| 다른 옵션 | 위치 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| BGE-M3 | 로컬 | MIT | mlx-lm에 XLM-RoBERTa 구현이 없어 미검증 |
| OpenAI embeddings | API | — | |
| Gemini `gemini-embedding-001` | API (OpenAI 호환) | — | |
| Upstage `solar-embedding-2-*` | API (OpenAI 호환) | — | query/passage 모델이 분리됨. 1세대 Embed는 2026-12-31 서비스 종료 |
| ~~Claude~~ | — | — | 임베딩 API 없음 |
| ~~EmbeddingGemma~~ | — | Gemma 이용약관 | Apache-2.0이 아니라 기본값에서 제외 |

### 4.3 검색

**SQLite 하나에 FTS5(키워드) + sqlite-vec 0.1.9(벡터, 버전 고정)를 둔다.** 위치는 `$TRACTUS_HOME/.tractus/index.sqlite`이고, 파일에서 언제든 다시 만들 수 있는 캐시다.

- **한국어 키워드:** FTS5 `trigram`은 2음절 질의("예산", "회의")를 못 찾는다. 앱에서 **음절 bigram**으로 바꾼 텍스트를 FTS5(unicode61)에 넣는다. bigram은 공백을 넘지 않고, 영문은 소문자 단어, 숫자는 쉼표를 뗀다(`v2.4` → `v` + `2.4`). 질의는 단어마다 phrase로 묶어 AND로 찾고, 모자라면 조사를 뗀 어간의 OR 질의로 보충한다(`partial`). 리서치 합성 코퍼스에서 bigram AND 재현율 0.96, trigram 0.33, unicode61 원문 0.30.
- **형태소 분석기는 쓰지 않는다.** Kiwi는 LGPL-3이라 기본 의존성에서 제외했다.
- **결합: strict 우선 + 가중 RRF.** 질의 단어가 모두 들어 있는 키워드 결과를 bm25 순으로 먼저 놓고, 나머지(일부만 맞은 키워드 + 벡터)는 RRF(k=60, 벡터 가중 0.3)로 뒤에 붙인다. 리랭커는 쓰지 않는다.
- **요약 항목(결정·할 일)은 검색 색인에 넣지 않는다.** 넣으면 가상 평가셋 hit@1이 0.97 → 0.87로 떨어졌다. 에이전트는 `get_summary`, `list_action_items`로 따로 본다.
- **동기화:** transcript.json의 stat(mtime·크기)이 같으면 건너뛰고, 다르면 sha256을 비교해 바뀐 회의만 다시 색인한다. 잘못된 회의 파일은 오류로 기록하고 나머지는 계속 색인한다. 벡터 쓰기는 끝에서 한 번에 하며, 빠진 벡터도 이때 채운다.
- **날짜 필터**는 준 경우에만 건다. 키워드 쪽은 meetings 조인, 벡터 쪽은 vec0 메타데이터 열(`meeting_date`)로 KNN 안에서 거른다.

**검색 평가 (2026-10-02, `bench/search_eval.py` · `bench/aihub_search_eval.py`)**

| 결합 방식 | 가상 회의 5건·30질의 hit@1 / MRR | AI Hub 실제 ASR 4세션·139질의 hit@1 / hit@5 / MRR |
| --- | --- | --- |
| 키워드만 | 0.90 / 0.94 | 0.85 / 0.88 / 0.86 |
| 벡터만 | 0.83 / 0.91 | 0.23 / 0.38 / 0.30 |
| RRF 동일 가중 | 0.97 / 0.98 | 0.50 / 0.70 / 0.60 |
| **strict 우선 + 벡터 0.3 (채택)** | **0.97 / 0.98** | **0.80 / 0.91 / 0.85** |

- 가상 평가셋은 손으로 만든 의미 질의(예: "돈 문제 논의한 회의")가 들어 있다. 하지만 청크가 15개뿐이라 hit@5는 모든 방식에서 1.0으로 포화된다. 그래서 hit@1과 MRR로 비교한다.
- AI Hub 평가셋은 사람이 쓴 정답 전사에서 LLM 없이 뽑은 어휘 질의(영문 용어, 드문 단어, 문장 조각)다. 이 질의로 Tractus의 실제 ASR 전사를 검색한다. 질의가 어휘 위주라 키워드에 유리하고, 의미 질의는 들어 있지 않다.
- 동일 가중 RRF는 회의가 길어지면 벡터 쪽 잡음이 정확한 키워드 결과를 밀어낸다. 벡터가 확실히 도움이 되는 경우는 영문 용어 질의다. ASR이 "MRI"를 한글로 적어도 벡터는 찾는다(term 질의 hit@5: 키워드 0.45, 채택안 0.80).
- AI Hub 평가는 지표만 출력한다. 질의·전사 텍스트는 출력하지 않고 저장소 밖에 둔다.

---

## 5. 에이전트 연동 — MCP 서버

Claude Code, Codex CLI, Antigravity CLI(agy)가 Tractus를 도구로 쓰도록 **로컬 stdio MCP 서버**(`tractus mcp`, 공식 SDK `mcp` 2.2)를 제공한다. 에이전트는 각자의 구독이나 키로 동작하고, Tractus는 로컬 데이터 조회와 요약 저장만 담당한다. **MCP 서버는 LLM을 호출하지 않는다.**

| 도구 | 기능 | 주석 |
| --- | --- | --- |
| `status()` | 데이터 위치, 회의·청크·벡터 수, 색인 오류, 안내 | 읽기 전용 |
| `search_meetings(query, limit, date_from?, date_to?, meeting_id?)` | 하이브리드 검색. 결과마다 세그먼트 2–3개와 **세그먼트별 `cite`·`speaker`** | 읽기 전용 |
| `list_meetings(date_from?, date_to?)` | 회의 목록 (날짜순, 요약 유무) | 읽기 전용 |
| `get_transcript(meeting_id, offset, max_segments)` | `[s0012 00:05:31 김민수] 텍스트` 줄 형식(화자 이름, 없으면 라벨, 모르면 생략), `next_offset`로 페이지 이동 | 읽기 전용 |
| `get_summary(meeting_id)` | summary.md | 읽기 전용 |
| `list_action_items(meeting_id?, date_from?, date_to?)` | 요약이 있는 회의들의 할 일 + 요약이 없는 회의 목록 | 읽기 전용 |
| `save_summary(meeting_id, summary, author)` | 에이전트가 쓴 요약을 스키마·segment_ids 검증 후 저장 (`provider: mcp`, `model: author`) | **쓰기** |

- **인용 형식:** `[노트 제목 00:05:31]`(v3.40, 메모는 `n번째 줄`). 사람이 읽는 인용이고 정확한 자리는 결과의 `meeting_id`·세그먼트 `id` 칸에 있다(v3.39까지는 `[meeting_id#s0012 00:05:31]`: Claude Code 플러그인 답에 내부 ID가 그대로 보여 바꿨다, 사용자 결정 2026-10-18). 검색 결과는 세그먼트 여러 개를 묶은 청크라, 청크 단위로 인용하면 엉뚱한 세그먼트를 가리킨다(초기 구현에서 Codex·agy가 그렇게 인용함). 그래서 세그먼트마다 `cite`를 준다.
- **도구는 모두 async다.** SDK는 sync 도구를 워커 스레드에서 돌리는데, sqlite 연결과 MLX 스트림은 스레드에 묶여 있다.
- **MCP 서버는 임베딩하지 않는다.** 회의가 많으면 첫 동기화가 몇 분 걸려 stdio 응답이 멈추기 때문이다. 새 회의는 키워드로 바로 검색되고, 벡터는 transcribe·summarize 뒤의 자동 색인이나 `tractus index`가 채운다(`status`가 남은 수를 알려 줌).
- **예상된 실패는 `ToolError`로 돌려준다**(없는 회의, 잘못된 segment_ids). 그 외 예외는 SDK가 메시지를 가린다.
- **stdout은 JSON-RPC 전용이다.** 로그와 모델 로딩 출력은 stderr로 보낸다(실제 하위 프로세스 테스트로 확인).
- 등록 방법은 README "MCP 연동"에 있다. 주의할 점이 셋 있다.
  - Codex는 셸 환경변수를 MCP 서버에 넘기지 않는다. `env`를 직접 지정해야 한다.
  - agy 헤드리스 모드는 전역 `~/.gemini/antigravity-cli/settings.json`의 `permissions.allow`에 `mcp(tractus/*)`가 있어야 도구를 허용한다. 워크스페이스 설정은 무시된다.
  - Gemini CLI는 개인 계정에서 `IneligibleTierError`로 인증이 막혀 지원 대상에서 뺐다.

**인수 테스트 (2026-10-02, 가상 회의 코퍼스, 각 CLI 헤드리스 실행)**

| CLI | 과거 회의 질의 ("regression test 담당자·기한, 근거 인용") | 요약 작성 → `save_summary` |
| --- | --- | --- |
| Claude Code 2.1 | ✅ 정답 세그먼트 s0007 인용, 20초 | ✅ 결정 3·할 일 3, 검증 통과 (데이터의 요일 오류까지 지적) |
| Codex CLI 0.158 | ✅ s0007 인용 | ✅ 결정 4·할 일 2, 검증 통과 |
| Antigravity CLI 1.2 | ✅ s0007 인용, 41초 | ✅ 결정 3·할 일 2, 검증 통과 |

세 CLI 모두 할 일(담당자 박지영 9월 8일, 윤서아 금요일)을 사람이 쓴 기준 요약과 같게 뽑았다. API 키가 없는 공급자의 요약 품질은 이 경로(§0, Phase 2 대안)로 비교한다.

---

## 6. 전사 스키마 (transcript.json)

```jsonc
{
  "schema_version": 2,          // 2: 화자 (2026-10-04). 1(화자 없음)도 그대로 읽는다
  "meeting_id": "01J9X...",
  "created_at": "2026-10-01T14:00:00+09:00",
  "title": "주간회의",
  // v3.18 메모 노트(선택 키): "kind": "memo" | 없음(= "recording"), "body": "사용자 글 그대로", "seg_seq": 마지막으로 낸 세그먼트 번호.
  //   메모는 audio = {"file": null, "duration_sec": 0, "source": "memo", "sha256": null}, asr 없음, segments[].line(본문 줄 번호, 1부터)·start=end=0. docs/desktop.md §2.10
  // v3.18 녹음 노트의 메모(선택 키, 없으면 메모 없음): "memo": {"body": "사용자 글", "lines": [{"id": "m0001", "line": 1, "text": "…"}], "seq": 마지막으로 낸 번호}. ID m####는 s####와 다른 번호 공간
  // v3.19 글만 있는 노트에 녹음을 더하면(`transcribe --append-to`) kind·body·seg_seq가 사라지고 글은 위의 "memo" 블록이 된다 (제목·id·created_at은 그대로). docs/desktop.md §2.11
  // v3.20 노트 정리(선택 키): "favorite": true, "tags": ["…"], "folder": "<폴더 ULID>", "updated_at": ISO 시각. 폴더 목록은 $TRACTUS_HOME/folders.json. docs/desktop.md §2.12
  "audio": { "file": "audio.ogg", "duration_sec": 3612.4, "source": "주간회의.m4a", "sha256": "…" },  // sha256: 같은 파일 재전사 방지·이어하기 식별
  "asr": { "model": "mlx-community/Qwen3-ASR-1.7B-8bit", "track": "standard", "runtime": "mlx-audio", "language": "auto", "hotwords": ["WTO"] },
  "speakers": {                 // 세그먼트에 쓰인 라벨만. 화자 분리를 안 했으면 {}
    "S1": { "name": "김민수" },   // tractus speakers <회의> rename S1 김민수
    "S2": { "name": null },
    "S3": { "name": null, "suggested": { "person_id": "01K…", "name": "홍길동", "score": 0.82 } }  // 목소리 제안 (v3.13, §2.5). 이름이 없을 때만
  },
  "diarization": {              // 화자 분리를 안 했거나 모델이 없었으면 null
    "engine": "nemotron",       // v3.15: nemotron | fluid. fluid면 model FluidInference/speaker-diarization-coreml, params는 min_turn_s·fill_gap_s·min_piece_s·max_speakers만. 예전 회의에는 없다(= nemotron)
    "model": "mlx-community/Nemotron-3-Diarization",
    "revision": "59ed2dbfc1346dcea9d423c71306a3a2499c568f",
    "params": { "threshold": 0.5, "median_frames": 11, "min_turn_s": 1.0, "fill_gap_s": 1.0, "min_piece_s": 1.0, "max_speakers": null }
  },
  "segments": [
    {
      "id": "s0001",
      "start": 12.34,
      "end": 18.90,
      "text": "다음 분기 budget 부터 보겠습니다",
      "lang": "ko",
      "speaker": "S1",          // speakers의 라벨. 모르면 null
      "corrected_text": null,   // 사용자 교정 (tractus segments edit). 표시 텍스트 = corrected_text ?? text. 원문 text는 보존
      "words": [                // 단어 시각 (v3.12). 정렬 안 했거나 실패하면 null
        { "text": "다음", "start": 12.34, "end": 12.71 },
        { "text": "분기", "start": 12.71, "end": 13.10, "approx": true }   // approx: 텍스트 편집 뒤 시각을 추정한 단어
      ],
      "words_asr": null         // 선택. 처음 고치기 직전의 words 복사본. 원문으로 되돌리면 words로 복원하고 지운다
    }
  ]
}
```

- **표시 이름**은 `speakers[라벨].name`, 없으면 라벨(`S1`), `speaker`가 null이면 표시하지 않는다. `transcript.md`는 `[00:00:12] **김민수**: …`, `transcript.vtt`는 `<v 김민수>…`.
- **목소리 제안** `suggested`는 표시 이름이 아니다. rename(앱의 '맞음')·dismiss('다름')가 지우고, merge하면 없어지는 화자의 제안도 사라진다. dismiss한 사람은 `speakers[라벨].dismissed`(person_id 목록)에 남아 같은 참석자에 다시 제안하지 않는다. 벡터는 여기에 없다(`voices.json`에만).
- **화자 편집** (`tractus speakers <회의> rename|set|merge|dismiss`)은 transcript.json을 고친 뒤 md·vtt를 다시 쓰고 검색 색인을 갱신한다. 오디오는 건드리지 않는다. 편집하면 schema_version 1 전사도 2가 된다.
  - 이름에서 `` []<>*_`\ `` 문자는 뺀다(md 굵게·VTT `<v>`·MCP 줄 `[s0012 00:05:31 이름]`이 깨지지 않게). `S2`처럼 라벨 모양인 이름은 거부한다.
  - 화자 편집은 청크 본문을 바꾸지 않으므로 색인은 기존 벡터를 그대로 옮겨 쓰고 임베딩 모델을 올리지 않는다(`sync(embed=False)`). 본문이 바뀐 청크만 다음 임베딩 동기화에서 다시 임베딩한다.
- **텍스트 편집** (`tractus segments <회의> edit`)은 `corrected_text`만 바꾸고 원문 `text`는 그대로 둔다. 원문과 같게 고치면 null로 돌린다. md·vtt·요약·검색·MCP·내보내기는 모두 `corrected_text ?? text`를 쓴다. 화자 편집처럼 md·vtt를 다시 쓰고 `sync(embed=False)`로 색인한다(본문이 바뀐 청크는 다음 임베딩 동기화까지 키워드로만 찾힌다).
- **단어 시각** `words[k]`는 `seg_text(s).split()[k]`와 1:1이다. 시각은 회의 기준 초(소수 둘째 자리), 세그먼트 안, 줄지 않음, `start <= end`. 텍스트를 고치면 `align.remap_words`가 difflib으로 같은 단어의 시각은 그대로 두고, 바뀌거나 새로 생긴 단어는 앞뒤 단어 사이에 고르게 펴서 `approx: true`를 붙인다. 원문으로 되돌려도 불변식은 지켜지지만 추정한 시각은 남는다(`tractus align --force`로 다시 맞춘다). 단어는 색인하지 않는다.
- **이어하기 파일** `.job.json`의 `chunks`는 `[시작 표본, 끝 표본, 화자]`이고, `diarizer`에 위 `diarization` 값을, `suggestions`에 목소리 제안을 둔다. 예전 `[시작, 끝]`도 읽는다(화자 null).

---

## 7. 기술 스택

| 영역 | 선택 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| 코어 / CLI / 로컬 API | Python 3.12, FastAPI, Typer | MIT | |
| LLM·임베딩·ASR 클라이언트 | `openai` SDK | Apache-2.0 | 유일한 모델 클라이언트 |
| 검증 | Pydantic v2 | MIT | |
| ASR 런타임 (macOS) | mlx-audio (라이브러리로 직접 호출) | MIT | `hotwords` 때문에 서버 대신 프로세스 안에서 호출 (D1). Windows 대비용은 llama.cpp `llama-server` |
| VAD | Silero VAD v6 (mlx-audio MLX 포팅) | MIT | torch 불필요 |
| 화자 분리 | Nemotron 3 Diarization (mlx-audio `mlx_audio.vad`) | 코드 MIT / 가중치 OpenMDW-1.1 | 최대 8명, revision 고정 (§2.4) |
| 목소리 프로필 | onnxruntime 1.30.0 + kaldi-native-fbank 1.22.3 + 3D-Speaker CAM++ zh_en advanced | MIT / Apache-2.0 / 가중치 Apache-2.0 | sha256 고정, 매칭은 scipy `linear_sum_assignment` (§2.5). sherpa-onnx는 espeak-ng(GPL-3) 정적 링크라 쓰지 않음 |
| 단어 정렬 | Qwen3-ForcedAligner-0.6B-8bit (mlx-audio `mlx_audio.stt`) | 코드 MIT / 가중치 Apache-2.0 | revision 고정, soynlp 대신 자체 공백 토크나이저 (§2.3) |
| 오디오 변환 | FFmpeg (**외부 바이너리로 호출**) | LGPL/GPL | 번들하지 않음 → Apache-2.0 배포물과 분리 |
| 저장·검색 | SQLite FTS5 + sqlite-vec 0.1.9 (고정) | Public Domain / MIT·Apache | pre-1.0이라 업그레이드 시 테스트 재실행 |
| 임베딩 런타임 | mlx-lm (Qwen3Model) | MIT | mlx-embeddings는 GPL-3이라 제외 |
| MCP | 공식 MCP Python SDK `mcp` 2.2 (`MCPServer`) | MIT | 2.x에서 FastMCP가 MCPServer로 이름이 바뀜 |
| UI (Phase 4) | Tauri 2 + React + TypeScript (B안). 백업은 SwiftUI 메뉴바 녹음기 + Obsidian 플러그인 (D안) | MIT·Apache | 2026-10-02 결정, `docs/desktop.md` |
| 녹음 (Phase 4) | `tractus-rec` (Swift): AVAudioEngine 마이크 + Core Audio process tap 시스템 오디오, 2트랙 WAV | — | B·D 공용 |

모델 가중치는 저장소에 포함하지 않고 사용자가 `hf download`로 받는다. 다운로드 링크와 명령은 `README.md`에 있다. 라이선스: Qwen3-ASR · Qwen3-ForcedAligner · Qwen3-Embedding(mlx-community 8bit 변환본) · Gemma 4는 Apache-2.0, Silero VAD는 MIT, Nemotron 3 Diarization은 OpenMDW-1.1, 3D-Speaker CAM++는 Apache-2.0(GitHub 릴리스에서 `curl`로 받는다). 기본으로 받는 모델의 라이선스는 저장소 루트 `NOTICE`에 모았다.

---

## 8. 로드맵

| Phase | 범위 | 완료 기준 |
| --- | --- | --- |
| **0. ASR 선정 (Mac)** ✅ 2026-10-02 | 개발 기기 1대(M3·16GB)에서 4개 모델(Qwen3-ASR 1.7B·0.6B, 대조군 Whisper-turbo, 참고 Nemotron 3.5)을 mlx-audio로 측정. 지표: CER(ko), WER(en), 코드스위칭 MER·PIER, RTF, 최대 메모리, 1시간 파일 완주 여부. 상세는 아래 "Phase 0 실행 계획" | 기본·저사양 트랙의 모델 확정 |
| **1. 전사 CLI** ✅ 2026-10-02 | `tractus transcribe <file>` → §4.1 레이아웃 생성. VAD 청킹, 이어하기, 용어집 | 1시간 한국어 회의를 두 트랙 모두에서 완주 → AI Hub 66분 회의: lite 4.1분(CER 9.22%), standard 10.1분(CER 7.23%). Ctrl+C·`kill -9` 후 재실행으로 173/173 청크 복구 |
| **2. LLM 연동** 🔶 2026-10-02 | 공급자 설정, 요약·Action Item, 검증·재시도, 5개 공급자 스모크 테스트 | 같은 전사로 5개 공급자 모두 스키마 통과 → **Upstage(solar-pro4) 통과**(재요청 없이 3/3, 1회 7초). OpenAI·Claude·Gemini는 API 키를 받는 대로 `pytest -m llm`으로 확인. 키가 끝내 없으면 Phase 3 MCP로 각 CLI에서 품질을 본다 |
| **3. 검색 + MCP** ✅ 2026-10-02 | 임베딩, FTS5 bigram, RRF, MCP 서버, 3개 CLI 등록 가이드 | Claude Code·Codex·Gemini CLI에서 과거 회의 질의 성공 → Gemini CLI 대신 agy. **세 CLI 모두 질의(정답 세그먼트 인용)와 요약 저장 성공** (§5) |
| **4. UI + 녹음** 🔶 진행 중 | B안(Tauri 앱) 우선, D안(메뉴바 녹음기 + Obsidian 플러그인) 백업. 공용: 녹음 헬퍼 `tractus-rec`, 코어 변경(audio.ogg, transcript.vtt, memos.json, `--recording`, `--progress-json`). 계약: `docs/desktop.md` | `docs/desktop.md` §4 판정 기준으로 B안을 평가해 확정 |
| **5. 품질 격차 해소** 🔶 진행 중 | 클로바노트 대비 실제 격차: 재생 컨트롤(배속·점프·무음 건너뛰기), 전사 텍스트 편집·찾아 바꾸기, 파일 가져오기(동영상 포함), 내보내기(txt·md·srt·csv·docx·묶음). 상세: `docs/roadmap.md` | 각 항목의 완료 기준 (`docs/roadmap.md` §2) |
| **6. 차별화** 🔶 진행 중 | 단어 타임스탬프(Qwen3-ForcedAligner) + 가라오케·단어 탐색, 회의 질의(Ask, 인용 포함), 음성 강조 필터, PDF | `docs/roadmap.md` §3 |
| 7. 사람과 실시간 | 목소리 프로필(로컬 화자 임베딩), 실시간 전사(옵트인), 9명 이상 화자 엔진 | `docs/roadmap.md` §4 |
| 이후 | **Windows 지원(llama.cpp GGUF 경로)** | 필요가 확인될 때 |

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

1. ~~기본 실행 형태~~ → **2026-10-02: 데스크톱 앱.** B안(Tauri)을 먼저 만들어 보고, 부족하면 D안(메뉴바 녹음기 + Obsidian 플러그인)으로 간다. 근거: 시스템 오디오(상대방 목소리) 녹음은 어느 쪽이든 네이티브 코드(Core Audio process tap)가 필요하고, Obsidian(Electron)은 시스템 오디오 권한이 없다
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
- 화자 분리: [Nemotron-3-Diarization (MLX)](https://huggingface.co/mlx-community/Nemotron-3-Diarization) · [OpenMDW-1.1](https://openmdw.ai/license/1-1/) · [FluidAudio](https://github.com/FluidInference/FluidAudio)
- 데이터: [AI Hub 회의 음성](https://aihub.or.kr/aidata/30709) · [주요 영역별 회의 음성인식 데이터](https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=464)
