# Tractus 데스크톱 앱 (B안)

Tauri 2 + React + TypeScript + Vite로 만든 앱이다. 구성 요소 사이의 계약은 [`docs/desktop.md`](../docs/desktop.md) §3에 있다.

- 회의 목록, 전사, 요약, 메모는 Rust가 `$TRACTUS_HOME/meetings/*`에서 직접 읽는다.
- 검색만 상주하는 `tractus mcp`(stdio JSON-RPC)의 `search_meetings`로 한다.
- 녹음은 `tractus-rec record`로, 전사·요약·단어 타이밍은 `tractus transcribe|summarize|align --progress-json`으로 한다. 셋 다 하위 프로세스로 띄우고, stdout의 JSON 이벤트를 화면에 그대로 전달한다.

## 개발 명령

```bash
cd app
pnpm install
pnpm test                                   # vitest: 시각 → 세그먼트 찾기, 시간 형식, 메모 끼워 넣기, MCP 응답 해석, 속도·무음 건너뛰기·찾아 바꾸기·되돌리기·가져오기·내보내기 이름, 질의 이벤트·인용 파싱·대화 기록 자르기·전송 안내(ask.test.ts), PDF 인쇄 문서(print.test.ts), 단어 찾기·단어 타이밍 검사·단어 클릭 시각(Phase 6.1·6.2), 목소리 제안 표시·기억하기 동의 검사(Phase 7.1)
pnpm build                                  # tsc + vite → dist/
pnpm tauri dev                              # 개발 실행 (Vite 1420 포트)
pnpm tauri build --debug --bundles app      # → src-tauri/target/debug/bundle/macos/Tractus.app

cd src-tauri
cargo test      # transcript/summary/memos 읽기, media 스킴 Range 응답, MCP 줄 단위 송수신(가짜 서버), 하위 프로세스 이벤트 전달·kill, ask 인수·stdin, chat.json, LLM 설정 읽기, words 너그럽게 읽기, 작업 인수(align 포함), 목소리 제안 너그럽게 읽기, voices 인수(동의 필수)·목록 읽기
TRACTUS_TEST_HOME=<합성 홈> cargo test meetings   # 다른 회의 폴더로 읽기 테스트 (기본: ../../tests/fixtures/eval)
```

합성 데이터로 띄워 보려면 다음처럼 실행한다. 설정 파일이 아직 없으면 환경변수 값을 기본값으로 쓴다.

```bash
TRACTUS_HOME=/path/to/synthetic-home src-tauri/target/debug/bundle/macos/Tractus.app/Contents/MacOS/tractus-app
```

## 설정

설정은 `~/Library/Application Support/dev.tractus.app/settings.json`에 저장한다. 앱 왼쪽 아래 "설정"에서 바꾼다.

| 항목 | 기본값 | 설명 |
| --- | --- | --- |
| `home` | `$TRACTUS_HOME` 또는 `~/Tractus` | `meetings/`, `recordings/`가 들어 있는 폴더 |
| `models_dir` | `$TRACTUS_MODELS_DIR` 또는 빈 값 | 비우면 tractus 기본값(`$TRACTUS_HOME/models`) |
| `tractus_bin` | `<저장소>/.venv/bin/tractus` | 절대 경로로 둔다. GUI 앱은 셸 PATH를 물려받지 않는다 |
| `rec_bin` | `<저장소>/recorder/.build/release/tractus-rec` | 녹음 헬퍼 경로 |
| `fake_recorder` | `false` | 개발용. `record --fake`로 띄워 권한 없이 녹음 흐름을 시험한다 |
| `rec_mode` | `in_person` | 마지막으로 고른 녹음 방식. 사이드바 녹음 버튼 아래 스위치로 바꾸고, 바꿀 때마다 이 값만 저장한다(다른 값은 설정 화면에서 저장할 때만 파일에 쓴다) |

## 편집·가져오기·내보내기 (Phase 5)

코어 CLI를 인수 배열로 실행한다(셸을 거치지 않는다). 계약은 `docs/roadmap.md` §2다.

| 기능 | 앱 | 코어 |
| --- | --- | --- |
| 문장 고치기 | 세그먼트를 두 번 누르거나 Enter. Enter·포커스 이탈은 저장, Esc는 취소, ⌘Z는 묶음 단위 되돌리기. 한글 조합 중 Enter는 무시한다 | `tractus segments <회의> edit` (stdin `{"edits":[…]}`) |
| 찾아 바꾸기 | ⌘F. 모두 바꾸기는 편집 1회·되돌리기 1그룹. '용어집에 추가'를 켜면 바꾼 말을 넣는다 | `tractus glossary add -- <용어>` |
| 파일 가져오기 | 사이드바 버튼(대화상자) 또는 창에 끌어 놓기. 큐에 넣고 하나씩 전사한다(녹음 전사와 겹치지 않고, 녹음 전사가 먼저다). 이미 전사한 파일이면 알림의 **열기**로 기존 회의를 연다. 전사 중에 창을 닫으면 묻는다 | `tractus transcribe <파일> --progress-json` (`job_start` kind `import`) |
| 내보내기 | 회의 머리말 '내보내기' → 저장 대화상자 → Finder에서 보여 주기. 요약 레일의 '요약 복사'는 마크다운으로 복사 | `tractus export <회의> --format … --out … --force` |
| 재생 | ←/→ 5초(Shift 10초), Shift+, / Shift+. 속도(localStorage에 기억), 무음 건너뛰기(화자를 고르면 그 화자만 듣기) | — |

문장 편집·화자 편집·내보내기는 한 줄로 세워 차례로 실행한다(코어가 transcript.json을 잠금 없이 고친다).

## 질문·목소리 강조·PDF (Phase 6)

| 기능 | 앱 | 코어 |
| --- | --- | --- |
| 회의에 질문 | 오른쪽 레일 '질문' 탭. 답이 스트리밍되고 `[s0012]`는 시각 칩(누르면 그 위치로 이동). 근거 목록은 '근거 N'을 펼친다. 근거가 없으면 '출처 없음'. 지난 질문은 `chat.json`을 Rust에서 읽어 보여 준다 | `tractus ask --meeting <id> --save --progress-json` (stdin `{"question", "history"}`, docs/desktop.md §2.5) |
| 전체 회의에 질문 | 사이드바 버튼 또는 ⌘J → 오른쪽 서랍(Esc로 닫기, 대화는 앱을 끌 때까지 남는다). 기간을 고를 수 있다. `[<회의 ID>#s0012]` 칩은 그 회의를 그 시각으로 연다 | `tractus ask [--from D] [--to D] --progress-json` |
| 전송 안내 | 입력란 아래 "질문과 관련 전사 일부가 Upstage(solar-pro4)로 전송됩니다". 보내기 전에는 셸 > 실행 폴더 `.env.local` > `.env` > `$TRACTUS_HOME` 순서로 읽은 `TRACTUS_LLM_PROVIDER`·`TRACTUS_LLM_MODEL`·`TRACTUS_LOCAL_ONLY`(키는 읽지 않는다)를 늘 보여 준다. 실제로 답한 공급자·모델(`done`)은 각 답 아래에 따로 적는다(근거가 없어 LLM을 부르지 않은 답은 빼고) | — |
| 멈추기 | 질문 중 '멈추기' 또는 회의 화면을 떠나면 프로세스를 kill한다. 코어는 `done` 직전에 chat.json을 쓰므로, 멈춘 뒤에 `done`이 도착하면 그 답을 받아 화면과 기록을 맞춘다 | — |
| 목소리 강조 | 플레이어 토글. highpass 100 Hz → peaking 3 kHz +4 dB → 압축 → gain(`voice.ts`). 처음 켤 때 요소마다 한 번 Web Audio 체인을 만든다. 속도·피치 유지는 그대로 | — |
| PDF | '내보내기' → PDF → macOS 인쇄 대화상자의 'PDF로 저장'. 인쇄용 문서(제목, 날짜, 길이, 화자, 요약, 시각·화자 붙은 전사)를 body 아래에 두고 `@media print`로 앱을 숨긴다 | — |
| 가라오케 | 재생 중인 단어를 인주색 배경으로 칠한다. 단어마다 span을 만들지 않고 세그먼트 글자 노드 위 Range 하나를 CSS Highlight `karaoke`로 바꾼다. 재생 중에만 rAF로 돌고 (세그먼트, 단어)가 바뀔 때만 Range를 바꾼다. 찾기 강조가 위에 보인다(우선순위 −1). 고치는 중인 세그먼트는 칠하지 않는다 | transcript.json `words` (docs/desktop.md §2.6) |
| 단어 클릭 | 문장을 한 번 누르면 `caretRangeFromPoint`로 누른 단어를 찾아 그 단어 시작으로 이동한다. 보간한 단어(`approx`)·시간 칸·키보드·단어 타이밍 없는 세그먼트는 세그먼트 시작. 드래그로 글을 고르면 이동하지 않는다. 두 번 누르기·Enter 편집은 그대로 | — |
| 단어 타이밍 만들기 | 단어 타이밍이 하나도 없는 예전 회의의 머리말 버튼. 진행률을 버튼에 보이고, 끝나면 회의를 다시 읽는다 | `tractus align <id> --progress-json` (`job_start` kind `align`) |

**단어 타이밍을 쓰는 조건:** `words`의 수와 글자가 표시 텍스트(`corrected_text ?? text`)의 공백 토큰과 같을 때만 쓴다(`lib.ts usableWords`). 문장을 고치면 저장하는 동안(낙관적 반영)은 어긋나서 세그먼트 단위로 돌아가고, 저장이 끝나면 코어가 다시 맞춘 `words`가 담긴 회의를 받아 다시 단어 단위가 된다. Rust는 `words`가 이상하면 null로 읽는다(회의 전체를 못 읽지 않게).

**`media://` + Web Audio:** WKWebView에서 커스텀 스킴 오디오도 `crossOrigin` 없이 `MediaElementAudioSourceNode`로 소리가 난다(macOS 26.6, 페이지 오리진 `tauri://localhost`·`http://localhost:1420` 둘 다 실측, Ogg Opus 1.5배속). `crossOrigin="anonymous"`를 붙이면 CORS 헤더가 없는 지금 응답은 재생이 막힌다(`NotSupportedError`). 그래서 붙이지 않는다.

**인쇄:** Tauri 2는 macOS에서 `window.print()`를 `plugin:webview|print`(WKWebView `printOperation`)로 바꿔 둔다. 그래서 권한 `core:webview:allow-print`가 필요하다. 여백은 `@page`로 준다(wry가 여백 0으로 인쇄한다). 화면의 `ss06`·`tnum` 대체 글리프는 PDF에서 글자로 복사되지 않아(2026 → 202!) 인쇄 문서는 기본 글리프를 쓴다.

## 목소리 프로필 (Phase 7.1)

계약은 [`docs/desktop.md`](../docs/desktop.md) §2.7이다. 목소리 벡터는 앱으로 오지 않는다. 코어가 `$TRACTUS_HOME/voices.json`(권한 0600)에만 두고, 앱은 이름·표본 수·등록일만 받는다.

| 기능 | 앱 | 코어 |
| --- | --- | --- |
| 기억하기 | 이름 바꾸기 폼(화자 막대에서 두 번 누르기, 칩·⋯ 메뉴)의 '이 목소리 기억하기'. 고르면 두 번째 체크 "본인이거나 녹음·등록에 동의를 받은 사람입니다"가 나타나고, 이것까지 골라야 저장된다(생체정보, 개인정보보호법 제23조). 이름 바꾸기와 등록이 명령 한 번이다 | `tractus voices enroll <회의> <라벨> --name=<이름> --consent` (`voices_enroll`, `consent: true`가 아니면 Rust가 거부) |
| 제안 | 전사 때 등록된 목소리와 맞으면 화자 막대에 점선 배지 "홍길동? · 자동 인식 82%"와 **확정**·**아님**을 붙인다. 확정 전에는 칩·전사·내보내기·요약에 라벨(S1)이 그대로 보인다 | transcript.json `speakers.S1.suggested` (Rust는 이상한 값을 null로 읽는다) |
| 확정·아님 | 확정은 그 이름으로 rename, 아님은 제안만 지운다. 다른 화자 편집과 같은 줄에 선다 | `tractus speakers <회의> rename` / `dismiss -- <라벨>` (`edit_speakers` op `dismiss`) |
| 목록·삭제 | 설정 › 목소리. 이름·표본 수·등록일. 삭제는 앱 안에서 한 번 더 묻는다. 임베딩 모델이 바뀌면 다시 등록하라고 알린다 | `tractus voices list --json` (`voices_list`), `tractus voices forget -- <id>` (`voices_forget`, ID로만) |
| 진행 | 전사 단계 `voices` → "목소리 맞춰 보는 중". `voices_model_missing`·`voices_failed` 경고는 다른 경고처럼 보여 주고 전사는 계속된다 | `transcribe --progress-json` |

`voices list --json`은 `{"people": [{"id", "name", "samples", "created_at"}], "reenroll": bool}`(docs/desktop.md §2.7)로 읽어 앱에는 `needs_reenroll`로 넘긴다. 목록 그대로, `samples`가 목록인 것도 받는다(`voices.rs parse_list`).

## 녹음 방식

주로 쓰는 경우는 한 방에서 여러 사람이 Mac 주위에 둘러앉은 대면 회의다. 화상·하이브리드 회의는 그다음이다. 어느 쪽이든 헤드폰 없이 스피커로 들어도 되게 한다.

| 방식 | `tractus-rec record` 인수 | 녹음 화면 |
| --- | --- | --- |
| 대면 회의 (기본) | `--no-system` | 마이크 레벨미터만. 시스템 오디오를 받지 않으므로 에코 문제가 없다 |
| 화상·하이브리드 | `--echo-cancel` | 마이크·시스템 오디오 레벨미터. 마이크 입력에 macOS 에코 제거를 켜서 스피커로 나온 상대방 목소리를 지운다 |

인수 변환은 `lib.ts`의 `recFlags`가 한다. Rust `rec_start`는 이 두 인수만 받고 나머지는 거부한다. 에코 제거를 켜지 못하면 헬퍼가 `echo_cancel_failed` 경고를 내고 녹음을 계속하며, 앱은 그 메시지에 영향(같은 말이 두 번 전사될 수 있음)을 덧붙여 보여 준다.

하위 프로세스에는 다음 환경변수를 명시적으로 넘긴다.

- `TRACTUS_HOME`, `TRACTUS_MODELS_DIR`
- `PATH`: ffmpeg를 찾도록 `/opt/homebrew/bin`을 포함한다.
- `PYTHONUNBUFFERED=1`: 진행 이벤트가 버퍼에 묶이지 않게 한다.

`tractus_bin`이 `<저장소>/.venv/bin/` 아래에 있으면 저장소 루트에서 실행한다. CLI가 현재 폴더의 `.env.local`(API 키)을 읽기 때문이다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `src-tauri/src/lib.rs` | 설정, Tauri 명령(`list_meetings`, `list_recordings`, `load_meeting`, `edit_speakers`, `edit_segments`, `glossary_add`, `export_meeting`, `mcp_call`, `rec_start`, `rec_send`, `job_start`, `ask_start`, `ask_cancel`, `load_chat`, `llm_config`), 앱 종료 시 녹음 정지 |
| `src-tauri/src/voices.rs` | 목소리 프로필 명령(`voices_list`, `voices_enroll`, `voices_forget`)과 인수·목록 읽기 (Phase 7.1) |
| `src-tauri/src/meetings.rs` | transcript.json, summary.json, memos.json 읽기. 손상된 회의는 건너뛴다. 전사 안 된 녹음(`recordings/<ULID>/recording.json`) 목록과 녹음 폴더 검사 |
| `src-tauri/src/mcp.rs` | 상주 MCP 클라이언트. initialize(`2025-11-25`) → initialized 순서로 연결하고, 하위 프로세스가 죽으면 다시 띄운다 |
| `src-tauri/src/procs.rs` | 하위 프로세스 stdout JSON Lines를 이벤트로 전달하고, 종료할 때 `exit` 이벤트(stderr 끝부분 포함)를 보낸다 |
| `src-tauri/src/media.rs` | 회의 오디오 전용 `media://` 스킴(아래 참고) |
| `src/lib.ts` | 순수 로직: 시간·세그먼트·단어 계산, 녹음·작업 이벤트 → 화면 상태(`recReduce`, `jobReduce`) (`lib.test.ts`) |
| `src-tauri/Entitlements.plist` | 마이크 entitlement (서명하면 hardened runtime이 켜져서 필요하다) |
| `src/api.ts` | 명령·이벤트 연결, `useJob`, `useRecorder` |
| `src/TranscriptTools.tsx` | 문장 편집기, 찾기·바꾸기 막대, 내보내기 메뉴 (Phase 5) |
| `src-tauri/src/ask.rs` | `tractus ask` 인수·stdin JSON, 전송 안내용 LLM 설정 읽기 (Phase 6) |
| `src/ask.ts`, `src/AskPanel.tsx` | 질의 이벤트 → 화면 상태, 인용 파싱, 대화 기록 자르기 / 질문 탭·전체 회의 서랍 |
| `src/voice.ts` | 목소리 강조 Web Audio 체인 |
| `src/print.ts`, `src/PrintSheet.tsx` | PDF 인쇄 문서 다듬기 / 인쇄 레이아웃 |
| `src/*View.tsx`, `App.tsx` | 화면. `App.tsx`는 파일 가져오기 큐·끌어 놓기 덮개·알림도 맡는다 |

**오디오를 asset protocol 대신 `media://`로 여는 이유:** Tauri asset protocol은 파일 내용으로 MIME을 추정한다. 그래서 Ogg Opus를 `audio/opus`로 보내는데, WKWebView는 `audio/opus`를 재생하지 못한다(`MEDIA_ERR_SRC_NOT_SUPPORTED`). 같은 파일을 `audio/ogg`로 보내면 재생된다(macOS 26.6에서 확인). 그래서 `media.rs`가 MIME을 `audio/ogg`로 고정하고, 탐색에 필요한 Range 요청을 직접 처리한다. 회의 폴더 밖의 파일이나 `.ogg`/`.opus`가 아닌 파일은 403으로 거부한다. 프론트엔드는 계약대로 `convertFileSrc(path, "media")`를 쓴다.

**디자인:** 종이 원고 위에 스위스식 타이포그래피를 얹었다. 글꼴은 Pretendard(SIL OFL 1.1)이고, npm 패키지를 번들에 넣어 쓴다(CDN 없음). 색은 의미가 있을 때만 쓴다.

- 인주색: 지금 재생 중인 위치와 녹음 중 상태
- 황토색: 사람이 남긴 메모와 북마크
- 파랑: 키보드 초점

라이트·다크 테마는 시스템 설정을 따른다.

**서명:** `tauri.conf.json`의 `bundle.macOS.signingIdentity`가 `"-"`라서 번들 전체를 ad-hoc 서명한다. 서명 식별자가 `dev.tractus.app`이 되고 Info.plist가 서명에 묶인다(`codesign -dv`로 확인). 그런데 ad-hoc 서명에는 고정된 인증서가 없다. 그래서 macOS는 권한을 코드 해시로 기억하고, 다시 빌드하면 권한을 다시 물을 수 있다. 권한을 빌드와 상관없이 유지하려면 Apple Development 또는 Developer ID 인증서로 서명해야 한다(v1 범위 밖). 권한이 꼬이면 `tccutil reset Microphone dev.tractus.app`과 `tccutil reset AudioCapture dev.tractus.app`으로 초기화한다.

## 단축키

| 키 | 동작 |
| --- | --- |
| `⌘K` | 검색 입력으로 이동 |
| `⌘J` | 전체 회의에 질문 (서랍 열기·닫기) |
| `Space` | 재생 / 일시정지 (회의 상세, 입력 중이 아닐 때) |
| `B` | 북마크 (녹음 중, 입력 중이 아닐 때). 물리 키(`e.code`)로 보므로 한글 입력 상태에서도 동작한다 |

## 수동 테스트 체크리스트

자동 검증으로는 확인할 수 없는 항목이다. 권한 대화상자와 실제 소리가 필요하다.

- [ ] **마이크 권한:** 처음 녹음을 시작하면 "Tractus"가 마이크 권한을 묻는다. 거부하면 녹음 화면에 `mic_denied` 경고가 뜬다.
- [ ] **시스템 오디오 권한:** "화상·하이브리드"로 처음 녹음하면 "화면 및 시스템 오디오 녹음" 권한을 묻는다(대면 회의는 묻지 않는다). 권한이 없으면 5초 뒤 `system_zero` 경고가 뜬다.
- [ ] **대면 회의:** "대면 회의"로 두고, 노트북을 테이블 가운데에 둔 채 여러 사람이 돌아가며 5분 동안 말한다. 레벨미터는 마이크 하나만 보여야 한다. 전사에서 먼 자리 사람의 말도 빠지지 않는지 기록한다.
- [ ] **화상·하이브리드 (스피커):** "화상·하이브리드"로 바꾸고, 헤드폰 없이 스피커로 화상회의를 들으며 녹음한다. 두 레벨미터가 보여야 한다. 전사에 상대방의 같은 말이 두 번(시스템 트랙과 스피커 → 마이크) 나오지 않아야 한다. 상대방 목소리가 작아지지(ducking) 않는지도 본다.
- [ ] **에코 제거 비교:** 같은 조건으로 터미널에서 `tractus-rec record --out <dir>`(에코 제거 없이)와 `--echo-cancel`을 각각 1분씩 녹음해 `mic.wav`를 들어 비교한다. 에코 제거 쪽에서 스피커 소리가 확실히 줄어야 한다.
- [ ] 녹음 방식을 바꾸고 앱을 다시 띄운다. 마지막으로 고른 방식이 그대로 선택돼 있어야 한다.
- [ ] 실제 화상회의를 "화상·하이브리드"로 1시간 녹음한다. 경과 시간과 두 레벨미터가 끊기지 않고, 앱 메모리가 계속 늘지 않아야 한다.
- [ ] 녹음 중 `B`로 북마크를 남기고, 메모를 입력한 뒤 Enter를 누른다. 녹음 화면 목록과 `recording.json` 모두에 시각이 함께 남아야 한다.
- [ ] 정지하면 전사 진행률(단계, done/total)이 보이고, 끝나면 새 회의 상세로 넘어간다. 메모와 북마크가 전사 사이에 시각 순으로 보여야 한다.
- [ ] 녹음 중 다른 회의를 열었다가 사이드바의 "녹음 중" 버튼으로 돌아온다.
- [ ] 녹음 중 앱을 종료(⌘Q)한다. 녹음 폴더의 WAV가 정상으로 열려야 한다. 다시 띄우면 사이드바 "전사 안 된 녹음"에 그 녹음이 보이고, 누르면 전사된다.
- [ ] 전사에 실패한 녹음(예: ffmpeg를 PATH에서 빼고 시험)도 "전사 안 된 녹음"에 남는다. 새 녹음을 시작한 뒤에도 거기서 다시 전사할 수 있어야 한다.
- [ ] **한글 입력:** 한글 입력 상태에서 메모를 "예산 확인"처럼 마지막 글자를 조합 중인 채로 Enter한다. 메모가 한 번만 저장되고, 입력란에 글자가 남지 않아야 한다(조합 중 Enter는 무시되므로 Enter를 한 번 더 눌러야 할 수 있다). 한글 입력 상태에서 `B`와 `⌘K`도 동작해야 한다.
- [ ] **권한 유지:** 권한을 허용한 뒤 앱을 다시 빌드하고 녹음한다. 권한을 다시 묻는지, 권한 목록에 "Tractus"로 나오는지(`tractus-app`가 아니라) 기록한다.
- [ ] `audio.ogg`(새 형식)와 `audio.opus`(예전 형식) 회의를 모두 재생한다. 스크러버로 1시간 회의의 뒤쪽까지 탐색해 본다.
- [ ] 세그먼트를 클릭하면 그 위치로 이동한다. 재생 중인 세그먼트가 강조되고 자동으로 스크롤된다. 직접 스크롤하면 자동 스크롤이 멈추고 "현재 위치로" 버튼이 보인다.
- [ ] 요약 패널에서 결정 사항, 할 일, 주제의 시각 칩을 누르면 원문 위치로 이동한다.
- [ ] 검색 결과로 회의를 열고 재생하다가 "요약 만들기"를 누른다. 요약이 끝나도 재생 위치가 검색 시각으로 되돌아가지 않아야 한다.
- [ ] 요약이 없는 회의에서 "요약 만들기"를 누른다. 진행 단계가 표시되고, 끝나면 패널이 채워진다. API 키가 없으면 오류 메시지가 보여야 한다.
- [ ] `⌘K`로 검색한다. 결과 세그먼트를 클릭하면 해당 회의의 그 시각으로 이동한다. 첫 검색은 색인 동기화 때문에 조금 걸릴 수 있다.
- [ ] 설정에서 경로를 바꾸고 저장한다. 목록이 다시 읽히고, 검색 서버 상태에 새 홈의 회의 수가 나와야 한다.
- [ ] 1시간 회의 상세를 끊김 없이 스크롤할 수 있어야 한다. 앱은 3초 안에 떠야 한다(B안 판정 기준).
- [ ] 라이트·다크 테마를 전환하고, Tab으로 이동할 때 초점 표시가 보이는지 확인한다.
- [ ] **목소리 강조 (귀로):** 실제 회의 오디오에서 토글을 켜고 끄며 듣는다. 말소리가 또렷해지고 웅웅거림이 줄어야 한다. 소리가 끊기거나 무음이 되면 안 된다. 1.5배속에서도 피치가 그대로여야 한다. 켠 채로 잠자기 뒤 재생해도 소리가 나야 한다.
- [ ] **PDF:** '내보내기' → PDF → 인쇄 대화상자 왼쪽 아래 'PDF' → 'PDF로 저장'. 사이드바·플레이어가 없고, 한글을 선택·복사할 수 있고, 세그먼트가 페이지 경계에서 잘리지 않아야 한다. 다크 테마에서도 흰 종이여야 한다.
- [ ] **가라오케·단어 클릭:** `tractus align`을 마친 회의를 재생한다. 단어 강조가 소리와 맞게 움직이고, 일시정지·스크러버 이동 뒤에도 맞는 단어에 멈춰야 한다. 찾기(⌘F) 강조가 단어 강조 위에 보여야 한다. 문장 중간 단어를 한 번 누르면 그 단어부터, 두 번 누르면 편집이 열려야 한다. 글을 드래그해 고르면 이동하지 않아야 한다. 문장을 고친 뒤 저장이 끝나면 그 문장도 다시 단어 단위로 강조돼야 한다. 1시간 회의에서 재생 중 스크롤이 끊기지 않아야 한다.
- [ ] **단어 타이밍 만들기:** 예전 회의(words 없음)에서 버튼을 누른다. 진행률이 버튼에 보이고, 끝나면 버튼이 사라지고 단어 강조가 시작된다. 정렬 중에 문장을 하나 고쳐도 그 수정이 남아야 한다.
- [ ] **질문 (회의):** '질문' 탭에서 한글로 묻고, 조합 중 Enter는 보내지 않는지, Shift+Enter는 줄바꿈인지 본다. 답이 흘러나오고 시각 칩을 누르면 이동한다. 회의를 다시 열면 지난 질문이 보인다. '멈추기'로 멈춘다.
- [ ] **질문 (전체):** ⌘J로 열고 묻는다. 칩을 누르면 그 회의가 그 시각으로 열린다. Esc로 닫고 ⌘J로 다시 열면 대화가 남아 있다. 전송 안내 문구가 설정한 공급자와 맞는지 본다.
