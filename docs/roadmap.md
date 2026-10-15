# 로드맵

## 진행 현황

- [x] Phase 0: ASR 모델 선정 (Qwen3-ASR 1.7B·0.6B, 2026-10-02)
- [x] Phase 1: 텍스트 변환 CLI (VAD 청킹, 이어하기, 자주 쓰는 단어)
- [x] Phase 2: LLM 요약 (근거 대화 필수, 검증과 재요청)
- [x] Phase 3: 검색(키워드 + 의미)과 MCP 서버
- [x] Phase 4: Tauri 앱과 녹음 프로그램 (마이크 + 시스템 오디오)
- [x] Phase 5: 대화 내용 수정, 찾아 바꾸기, 파일 가져오기, 내보내기, 재생 컨트롤
- [x] Phase 6: 단어 싱크, AI 질문, PDF, 목소리 선명하게
- [x] Phase 7: 참석자 목소리 프로필, 실시간 텍스트 변환(미리보기), 9명 이상 참석자 구분
- [x] 메모 노트와 녹음 노트의 `메모` 탭, 글만 있는 노트에 녹음 추가 (v3.18~v3.19)
- [x] 즐겨찾기·태그·폴더·목록 순서, 요약 유형과 직접 프롬프트 (v3.20~v3.21)
- [x] 설정에서 AI 키 등록, 모델 받기와 시작 점검, 기능별 막기 (v3.22~v3.23)
- [x] 메뉴 막대 아이콘: 창 없이 녹음 시작·종료·북마크, 최근 노트, 창을 닫아도 남기기 (v3.24, 이슈 #1). 설정 `메뉴 막대에 Tractus 표시`·`창을 닫아도 메뉴 막대에 남기기`(둘 다 기본 켜짐, 바로 적용)
- [x] 녹음 일시정지·계속, 녹음과 변환 분리(`변환 전` 노트), 좌우 패널 접기 (v3.25~v3.26)
- [x] 경로 자동 찾기, 모델 폴더 옮기기·정리, 스마트 검색 모델 8bit, 설치·업데이트·정리 스크립트 (v3.27~v3.29)
- [x] 미리 만든 앱(`build_app_bundle.sh`)과 설치 디스크 이미지(`make_dmg.sh`) (v3.30~v3.31)
- [x] 첫 프리릴리스 v0.1.0: GitHub 릴리스에 `.dmg`로 올림
- [x] 앱 안 업데이트: `설정 > 업데이트`에서 새 버전 확인·설치(알림 뒤 사용자가 누를 때만 설치, Tauri updater, 공개 저장소 릴리스의 `latest.json`, `scripts/release.sh`), 저장소 공개 전환 (v3.34)
- [x] 화면 다시 디자인: Tailwind v4 + shadcn 방식, 라이트·다크 모드, 홈 화면, 뒤로 가기, AI 서비스 로고 (v3.35, v0.2.0)
- [ ] 깨끗한 Mac(새 계정)과 macOS 14.4~15에서 미리 만든 앱 실행, 내려받은 `.dmg`의 Gatekeeper 동작과 권한 이름 확인
- [ ] 팬 없는 M3 Air에서 1시간 연속 녹음 + 실시간 텍스트 변환의 발열·지연 확인
- [ ] 실제 대면 회의(원거리 마이크)의 단어 싱크·목소리 인식 정확도, 9명 이상 참석자 구분 측정
- [ ] OpenAI·Claude·Gemini 공급자 검증 (지금은 키 대기, Upstage만 검증)
- [ ] 서명·공증을 받은 설치 파일 (지금은 ad-hoc 서명이라 처음 열 때 경고가 나옵니다)
- [ ] WKWebView에서 손으로 확인하지 못한 화면 점검 (노트 끌어 놓기, 요약 유형 메뉴). 단어 강조 등 WebKit 기능은 macOS 26.6에서만 확인했고 최소 버전 14.4에서는 확인하지 못했습니다
- [ ] 키를 Keychain에 저장 (지금은 앱 설정 폴더의 0600 파일)
- [ ] Windows 지원 (llama.cpp GGUF 경로, 필요가 확인될 때)

**알려진 한계:** 메모를 모두 지우고 새로 쓰면 줄 ID가 `m0001`부터 다시 시작해 옛 요약의 근거와 겹칠 수 있습니다. 녹음을 추가하는 동안의 AI 질문은 막지 않습니다. 여러 유형을 한 번에 만드는 요약은 중간에 취소할 수 없습니다. 목록은 [ARCHITECTURE.md](../ARCHITECTURE.md) 변경 이력과 [docs/desktop.md](desktop.md) 각 절의 `알려진 한계`가 원본입니다.

전체 계획과 근거는 [docs/roadmap.md](roadmap.md)와 [ARCHITECTURE.md §8](../ARCHITECTURE.md)에 있습니다. 제안할 기능과 알려진 문제는 [이슈](https://github.com/sjoon21/Tractus/issues)에 남겨 주세요.

---

## Tractus 로드맵 — 클로바노트 격차 해소 (Phase 5~7)

> 작성 2026-10-06. 클로바노트 공식 도움말·요금표·릴리스 노트와 웹 클라이언트 UI 문자열로 기능 유무를 확인했다. 참고 코드는 MIT·Apache-2.0·BSD만 가져다 고친다. AGPL·GPL·LGPL과 비OSI 라이선스는 **아이디어로만** 참고한다. 스타 수와 라이선스는 2026-10-06에 `gh api`로 확인했다.

**결론:** 받은 격차표는 클로바노트를 과대평가했다. 실제로 막아야 할 격차는 **텍스트 편집, 재생 컨트롤, 파일 가져오기, 내보내기** 네 가지이고, 모두 Phase 5에서 약 9일이면 닫힌다. 단어 정렬, 회의 질의, 실시간 전사, 목소리 등록은 그다음 단계에서 차별화 기능으로 다룬다.

## 1. 격차표 정정

| 항목 | 클로바노트 실제 | Tractus 현재 | 판정 |
| --- | --- | --- | --- |
| 실시간 전사 | **부분 지원.** PC 웹에서 시작한 녹음에서만 켤 수 있다(`realtime_app_block`). 기본 흐름은 종료 후 변환이다 | 녹음 중에는 레벨미터, 북마크, 메모만 있다 | 필수 아님. Phase 7 |
| 텍스트 편집 | 있다. 구간 재생 편집, 단어 바꾸기·전체 바꾸기(참석자 이름 제외), 자주 쓰는 단어 등록 유도 | 화자 편집만 된다. `corrected_text` 필드는 있지만 비어 있다. md·vtt·요약·CLI 검색은 `s['text']`만 읽는다 | **최대 격차.** Phase 5 |
| 단어 단위 싱크 | 단어를 클릭하면 그 단어부터 재생한다. 재생 중 단어 강조(가라오케)는 **미확인** | 세그먼트 단위 이동과 강조. 세그먼트는 이미 **화자 전환 지점에서 나뉘고** 최대 30초다 | Phase 6 |
| 화자 수 | 선택지가 1~4명, '5명 이상'뿐이다. '무제한'은 근거가 없다 | Nemotron은 8명이 모델 상한이다. 8명을 다 쓰면 FluidAudio community-1(`tractus-diar`)로 다시 나눈다(v3.15, 상한 없음) | 7.3 완료 |
| 목소리 등록 | NAVER WORKS Business 이상 플랜에서만 된다(2026-04 출시, 관리자 활성화, 동의 필요) | 없다 | 고가치. Phase 7 |
| 배속·점프 | 0.8/1/1.2/1.5/1.8/2x, **5초** 앞뒤 이동. 개인 무료 플랜은 1x만 | `<audio>` 재생과 슬라이더뿐이다 | Phase 5 |
| 무음 건너뛰기 | **없다** | 없다. VAD와 세그먼트 간격 정보는 이미 있다 | 저비용 차별화. Phase 5 |
| 잡음 필터 | **없다** | 없다 | Phase 6 (선택) |
| AI 질의 | 공식 근거 **없음**(제3자 블로그만 언급). 요약 템플릿, 프리셋, 다중 요약 탭은 있다 | MCP로 외부 CLI에서만 질의된다 | 차별화. Phase 6 |
| 파일 가져오기 | 오디오만 된다(m4a, mp3, aac, wav, 300MB). **동영상은 안 된다** | CLI `tractus transcribe`는 ffmpeg가 읽는 모든 형식(동영상 포함)을 받고, sha256으로 중복을 막는다. 앱 UI만 없다 | Phase 5 |
| 내보내기 | txt, hwp, docx, xlsx, srt. **PDF는 없다.** 공유 링크(비밀번호, 시작 시각) | 파일로 md, vtt, json을 저장한다. UI는 없다 | Phase 5 |
| 용어집 | 언어별 최대 1,000개 | `glossary.md` → Qwen3-ASR `hotwords`로 이미 있다(용어 재현율 72% → 84%) | 동등 |

## 2. Phase 5 — 품질 격차 해소 (약 9일)

먼저 **선행 작업**을 한다. `seg_text(s)` 헬퍼(`corrected_text or text`)를 만들고 `store.py:291`(render_vtt), `store.py:316`(render_markdown), `summarize.py:60`, `mcp_server.py:194`, `cli.py:423`에 적용한다. 이 작업 없이는 사용자가 고친 내용이 어떤 출력에도 반영되지 않는다.

| 항목 | 접근 | 참고 코드 | 일수 | 완료 기준 |
| --- | --- | --- | --- | --- |
| **5.1 재생 컨트롤** | `playbackRate` 0.8~2x(`preservesPitch` 기본값 유지), ←/→ ±5초, Shift ±10초, Shift+,/. 로 속도 조절, 속도는 localStorage에 기억한다. `isTypingTarget`이 contentEditable과 range 입력도 걸러내게 넓힌다 | bbc/react-transcript-editor(MIT, 620★) `packages/components/media-player/src/config/defaultHotKeys.js` @54b0a18a. wavesurfer.js(BSD-3, 10428★) `src/player.ts` L382-386 @302fd210 | 0.5 | 편집 중에는 단축키가 동작하지 않는다. 모든 점프가 `seekTo`를 거친다 |
| **5.2 무음 건너뛰기** | 토글을 켜면 세그먼트 간격이 1.0초를 넘을 때 `next.start - 0.2`로 이동한다. 화자 필터와 조합하면 '이 화자만 듣기'가 된다. 절약한 시간을 표시한다 | 오픈소스 구현 없음 | 0.5 | `segmentIndexAt` 단위 테스트 |
| **5.3 텍스트 편집** | 코어에 `apply_text_edits`와 `tractus segments <회의> edit`(stdin으로 JSON 묶음, 원문과 같으면 해제)를 추가한다. 편집 후 `_sync_index_quietly`를 호출한다. Rust `edit_segments`는 `edit_speakers`(lib.rs:290-306)를 복제한다. UI는 더블클릭 또는 Enter로 `contentEditable="plaintext-only"`를 열고, Cmd+Enter나 blur로 저장, Esc로 취소한다. 한글 조합 중 Enter(`isComposing ‖ keyCode===229`)는 무시한다. 변경은 낙관적으로 반영하고 `inFlight`로 직렬화한다. Cmd+Z로 되돌리고, '수정됨' 표시와 '요약 다시 만들기' 안내를 단다 | fastrepl/anarlog(MIT, enterprise/ 제외, 9434★) `apps/desktop/src/session/components/note-input/transcript/renderer/segment.tsx` L234-330 @abbaf07f. Muesli-HQ/muesli(MIT) `MeetingDetailView.swift` L232-243 @8d318839 (아이디어) | 2.5 | 편집 결과가 md·vtt·요약·검색에 반영된다. 재전사 후에도 원문 `text`는 보존된다. 한글 조합 중 저장이 일어나지 않는다 |
| **5.4 찾기·바꾸기** | 클라이언트에서 부분 문자열로 찾는다. 강조는 CSS Custom Highlight API로 한다. 바꾸기는 편집 1회 묶음, 되돌리기 1그룹으로 처리하고 화자 이름은 바꾸지 않는다. '용어집에 추가' 체크박스는 중복을 제거하고 `glossary.md`에 넣는다 | anarlog `search/bar.tsx` L159-200, `chat/tools/session-correction.ts` L428-455. rishikanthc/Scriberr(MIT, 3087★) `useKaraokeHighlight.ts` L4-16 @a353078f | 1 | 200개 세그먼트를 한 번에 바꾸는 호출이 1회다. 다음 전사에 hotwords가 반영된다 |
| **5.5 파일 가져오기** | Tauri `onDragDropEvent`(플러그인 불필요)와 `tauri-plugin-dialog` open을 쓴다. 확장자 allowlist는 대소문자를 구분하지 않는다. `job_start`에 kind `import`를 추가하고, 파일은 큐에 넣어 1개씩 처리한다. 코어는 중복일 때 `duplicate` 경고를 낸다. 해시 계산 전에 stage `decode`를 먼저 내보낸다 | thewh1teagle/vibe(MIT, 7696★) `desktop/src/pages/main/hooks/use-drop-target.ts` L12-71 @53056d6b. Zackriya-Solutions/meetily(MIT, 31460★) `frontend/src/app/layout.tsx` L159-208 @a2cb62e8 | 1.5 | mp4, mov, m4a, mp3, wav, webm 전사 성공. 같은 파일을 다시 넣으면 기존 회의를 연다. 오디오가 없는 영상은 오류를 표시한다 |
| **5.6 내보내기** | `tractus export <회의> --format txt\|md\|srt\|vtt\|csv\|docx\|bundle`. CSV는 `utf-8-sig`, SRT는 render_vtt를 변형한다. DOCX는 python-docx를 쓰고 `w:eastAsia` 폰트를 지정한다. bundle은 zipfile로 묶는다. 앱은 dialog `save()` 뒤 `revealItemInDir`, 요약 복사 버튼을 둔다 | chidiwilliams/buzz(MIT, 21834★) `buzz/transcriber/file_transcriber.py` L253-313 @100589fd. vibe `desktop/src/lib/docx.ts` L1-131 (레이아웃 수치), `transcript-export.ts` L166-187 (CSV) | 2 | 한국어 Excel에서 CSV가 깨지지 않는다. Word와 Pages에서 한글 폰트가 정상이다. 내보낸 결과에 `corrected_text`가 우선 반영된다 |

라이브러리: `@tauri-apps/plugin-dialog`, `tauri-plugin-opener`(MIT/Apache-2.0), python-docx 1.2.0(MIT)과 lxml(BSD-3, 8.6MB). xlsx는 실제 요구가 생기면 XlsxWriter(BSD-2)로 만든다.

## 3. Phase 6 — 차별화 (약 10일)

| 항목 | 접근 | 참고 코드 | 일수 | 완료 기준 |
| --- | --- | --- | --- | --- |
| **6.1 단어 타임스탬프** | `_run`에서 ASR 다음, `_free_mlx()` 뒤에 `align` 단계를 넣는다. 모델은 Qwen3-ForcedAligner-0.6B-8bit(Apache-2.0, revision 고정)이다. `tokenize_korean`을 공백 토크나이저로 바꿔 **soynlp(LGPL-3.0)를 피한다**(`tokenize_space_lang`은 한자를 글자마다 나눠 단어 수가 어긋난다). 입력은 60초에서 자른다. 단어 수가 맞지 않으면 `words`를 null로 둔다. 텍스트를 편집하면 difflib으로 시간을 옮기고 `approx`로 표시한다. `tractus align`으로 기존 회의를 채우고 `--no-align`으로 끌 수 있게 한다 | mlx-audio(MIT, 7994★) `qwen3_forced_aligner.py` L96-145, L637-760 (설치본 0.5.7). bbc/react-transcript-editor `stt-align-node.js` L102-185 (아이디어. 그대로 쓰면 한글이 지워진다) | 2.5 | 실제 대면 회의 30분으로 검증한다. 1시간 회의 정렬 시간이 90초 이하다(실측 RTF 0.02) |
| **6.2 가라오케·단어 탐색** | rAF 루프와 이진 탐색으로 현재 단어를 찾고 `CSS.highlights`로 강조한다. 단어마다 span을 만들지 않는다. 클릭하면 `caretRangeFromPoint` → 해당 단어로 `seekTo`. `approx` 단어는 세그먼트 시작으로 이동한다 | Scriberr `useKaraokeHighlight.ts` L19-117, `TranscriptView.tsx` L7-19 @a353078f | 1.5 | 1시간 회의에서 프레임 저하가 없다. macOS 14.4에서 동작한다 |
| **6.3 회의 질의(Ask)** | `tractus ask --progress-json`: stdin으로 질문을 받고 `sources`, `delta`, `done` 이벤트를 낸다. 회의 범위 질문은 `build_prompt`를 재사용한다. 전체 범위 질문은 상주 MCP `search_meetings` 결과에 이웃 3개 세그먼트를 붙인다. `[s0012]` 인용은 프롬프트에 없던 id를 버리고 TimeChip으로 표시한다. 대화는 `chat.json`에 6턴·12k자까지 저장한다. `TRACTUS_LOCAL_ONLY`를 따르고, 전송될 공급자를 표시한다 | stenolabs/stenoai(MIT, 1327★) `src/chat_query.py` L12-155 @48b9412f. Scriberr `internal/api/chat_handlers.go` L432-560. open-webui(비OSI, **아이디어만**) 인라인 인용 UI | 4.5 | 한국어 질문 20~30개로 평가 세트를 만든다. 인용을 클릭하면 해당 오디오로 이동한다. 근거가 없으면 '출처 없음'을 표시한다 |
| **6.4 음성 강조 필터** | Web Audio 체인: highpass 100Hz → peaking 3kHz +4dB → compressor → gain. `crossOrigin`은 설정하지 않는다 | wavesurfer.js `examples/webaudio.js` L19-50 @302fd210 | 1 | Ogg/Opus에서 1.5x 재생과 함께 동작한다 |
| **6.5 PDF** | print CSS와 `Webview::print()`로 macOS 'PDF로 저장'을 쓴다. Typst(Apache-2.0)는 CLI에서 PDF가 필요해질 때 도입한다 | tauri `crates/tauri/src/webview/mod.rs` L1622-1628 @79d35376. anarlog `crates/export-core/src/typst/` (업그레이드 경로) | 1 | 사이드바와 플레이어가 숨겨지고 한글이 선택 가능하다 |

**6.1 상태 (2026-10-06, core 완료):** `align.py`, `transcribe`의 `align` 단계, `tractus align`, 편집 뒤 `remap_words`. 실측(M3·16GB, Qwen3-ForcedAligner-0.6B-8bit):

| 회의 | 세그먼트 | 정렬 시간 | 성공 / 실패 | 불변식 위반 | 길이 0 단어 |
| --- | --- | --- | --- | --- | --- |
| 실제 대면 회의 29.4분 (스모크, `tokenize_space_lang`) | 176 | 37.6초 (RTF 0.021) | 단어 수 불일치 2 | — | 일부 |
| 실제 대면 회의 44.7분 (`tractus align`, 공백 토크나이저) | 295 | 66.1초 (RTF 0.025), 명령 전체 74초 | 294 / 1 | 0 | 321 / 5,328 (6%) |

1시간 회의로 환산하면 정렬 약 89초로 완료 기준(90초)의 경계다. 실패한 1개는 한 단어짜리 세그먼트에서 모델이 길이 0을 낸 경우다.

**6.2 상태 (2026-10-06, 구현 완료):** Highlight API 가라오케(재생 중에만 rAF, 단어 span 없음), `caretRangeFromPoint` 단어 클릭 이동(`approx` 단어는 세그먼트 시작), 기존 회의용 '단어 타이밍 만들기' 버튼. 실제 회의 295개 세그먼트에서 294개가 쓰인다(`usableWords`). **WKWebView에서 칠하기·클릭 이동은 사람이 확인해야 한다**(`app/README.md` 점검 목록).

요약 템플릿 선택(`~/Tractus/templates/*.md`)은 요청이 오면 추가한다.

## 4. Phase 7 — 사람과 실시간 (약 12일)

| 항목 | 접근 | 참고 코드 | 일수 | 완료 기준 |
| --- | --- | --- | --- | --- |
| **7.1 목소리 프로필** | onnxruntime(MIT)·kaldi-native-fbank(Apache-2.0)와 3D-Speaker CAM++ zh_en(192차원, 28MB, Apache-2.0)을 쓴다(sherpa-onnx는 espeak-ng GPL-3 정적 링크라 뺐다). 이름을 바꿀 때 '기억하기'를 체크하면 화자당 1.5~10초 구간 최대 3개로 등록한다. `voices.json`은 권한 0600, 1인당 최대 5개를 둔다. 매칭은 `linear_sum_assignment`와 임계값 + 2위와 차이 0.08로 한다. '자동 인식 82%' 배지를 달고 미확정으로 남긴다. `tractus voices list\|enroll\|forget`을 둔다. 벡터는 MCP와 LLM으로 내보내지 않는다. 다른 사람을 등록할 때는 동의 확인(개인정보보호법 23조)을 받는다 | anarlog `crates/voiceprint/src/matching.rs` L1-165, `lib.rs` L36-100. k2-fsa/sherpa-onnx(Apache-2.0, 15121★) `python-api-examples/speaker-identification.py` L114-250 @99ddefaa | 5 | `bench/voice_eval.py`로 한국어 EER을 재고 FAR 1%가 되는 임계값을 정한다 |
| **7.2 실시간 전사 (옵트인)** | `tractus live --recording <dir>`: 커지는 WAV를 꼬리부터 읽고 Silero `feed()`를 쓴다. 0.5초 무음이나 8초 상한에서 확정하고, 3초마다 미리보기를 낸다. Qwen3-ASR 0.6B를 쓴다. 화자 라벨(Nemotron 'low' 스트리밍)은 `--speakers` 옵트인이다. 정지하면 워커가 먼저 종료하고 배치 전사가 최종본이 된다. 16GB 미만 기기에서는 기본으로 꺼 둔다 | yazinsai/OpenOats(MIT, 2596★) `StreamingTranscriber.swift` L89-260, `DiarizationManager.swift` L19-63 @c6c6f164. meetily `audio/pipeline.rs` L16-27 | 4.5 | 시뮬레이션 실측: 확정 지연 p95 0.70초, GPU 점유율 0.29, 최대 메모리 3.4GB. 팬 없는 M3 Air에서 1시간 연속 테스트 |
| **7.3 9명 이상 화자** | `recorder/diar/`에 `tractus-diar`(FluidAudio v0.17.5, `offlineMode`)를 추가하고 `--diarizer auto\|nemotron\|fluid`로 고른다. auto는 Nemotron 8채널이 모두 쓰였을 때만 재실행한다 | FluidInference/FluidAudio(Apache-2.0, 2960★, 가중치 CC-BY-4.0) `OfflineDiarizerManager.swift` L127-180, `ProcessCommand.swift` L120-160 @0b1f4628(v0.17.5 태그. 처음 적은 04e363c2는 태그 커밋이 아니었다) | 2.5 | AI Hub 17명 세션에서 confusion이 26.5%보다 낮아진다 |

**7.1 상태 (2026-10-07, core 완료):** `voices.py`(onnxruntime 1.30 + kaldi-native-fbank + CAM++ zh_en advanced, sha256 고정), `transcribe`의 `voices` 단계(제안은 `.job.json`에 남겨 이어하기 때 다시 계산하지 않음), `tractus voices list|enroll --consent|forget|match`, `tractus speakers <회의> dismiss`. 제안(`speakers.S1.suggested`)은 표시 이름·md·vtt·요약·MCP·색인·내보내기에 나가지 않는다. 가상 음성(`say` Yuna·Grandpa) 같은 목소리 0.94–0.95, 다른 목소리 0.23–0.27. `bench/voice_eval.py`(AI Hub 4세션·40명·발화 1,427개)로 모델 3종을 비교해 CAM++와 `THRESHOLD` = 0.70을 골랐다. 3구간 등록 EER 2.62%. 매칭 시뮬레이션(등록과 probe가 같은 세션)은 AI Hub 라벨 그대로 맞음 88.2% / 틀림 1.3% / 없음 10.5% / 미등록자 오제안 11.4%, 두 세션 사회자 1쌍을 같은 사람으로 보면(미검증) 95.6% / 1.3% / 3.1% / 2.2%. **다른 회의에서의 재현율은 재지 못했다.** 그 1쌍의 세션 간 점수가 평균 0.827·최소 0.736으로 같은 세션보다 약 0.06 낮아 0.70을 골랐다(ARCHITECTURE §2.5, `bench/results/voice_summary.json`).

**7.3 상태 (2026-10-07, 완료):** `recorder/`에 두 번째 실행 파일 `tractus-diar`(이후 Swift 6.2 요구를 이쪽에만 두려고 `recorder/diar/` 별도 패키지로 나눴다)(FluidAudio v0.17.5, `run`은 `ModelHub.offlineMode`, `download`로 모델을 한 번 받음)를 넣고, `diarize.FluidDiarizer`·`transcribe --diarizer auto|nemotron|fluid`로 붙였다(설계 ARCHITECTURE.md §2.4.1, 계약 `docs/desktop.md` §2). **완료 기준 충족:** AI Hub 17명 세션 confusion 6.9%(Nemotron을 같은 방식으로 재면 28.5%, v3.9 기록 26.5%), 찾은 화자 12/17명. 7명 세션 195는 fluid가 3.2 → 3.8%로 조금 나쁘지만 auto는 이 회의를 다시 돌리지 않는다. 4세션 합 confusion 12.6% → 4.7%, RTF 0.0039. 가상 `say` 음성에서는 두 엔진 모두 같은 엔진(Eloquence) 음성을 합쳐 순위 근거가 되지 않는다(2명 30초에서 fluid가 3명으로 봄). 앱 화자 색 슬롯을 16칸으로 늘렸다(9번째부터 속 빈 점·빗금 막대). 지표: `bench/results/diar_summary.json`. **실제 대면 회의 9명 이상은 재지 못했다.**

**7.2 상태 (2026-10-07, core 완료):** `live.py`와 `tractus live --recording <dir> [--progress-json] [--speakers] [--force]`(계약 `docs/desktop.md` §2.8, 설계 ARCHITECTURE.md §2.6). 커지는 WAV를 파일 크기 기준으로 꼬리부터 읽고, 트랙을 표본 위치로 합산·클립하고, 48k → 16k 상태 있는 FIR로 줄여 Silero `feed()`에 넣는다. 0.5초 무음·8초 상한에서 확정하고 3초마다 미리보기를 낸다. 0.19초 쉼에서 미리 전사해 두고 확정 때 다시 쓴다. 뒤처지면 미리보기부터 건너뛰고, 10초 넘게 밀리면 `live_lagging` 후 라이브 끝으로 간다. 아무것도 저장하지 않는다. `bench/live_sim.py` 실측(가상 `say` 대화 68초, 실시간, M3 16GB, 화자 끔):

| 지표 | 목표 | 실측 |
| --- | --- | --- |
| 확정 지연 p95 | 0.70초 | 0.76초 (같은 조건 다른 실행 0.72·0.74초. p50 0.60초, 발화 9개, 무음 대기 0.51초 포함) |
| GPU 점유율 | 0.29 | **확인 못 함.** `live` 프로세스만의 몫은 `powermetrics`(sudo 필요)로만 잴 수 있어 재지 않았다. `ioreg` 시스템 전체 평균 29.4%에서 시작 전 기준값 17.5%를 빼면 약 12%p(같은 조건 다른 실행 17%p)이지만, 실행 중 다른 작업이 섞인 근사다 |
| 최대 메모리 | 3.4GB 이하 | footprint 1.82GB (RSS 1.19GB, MLX 최대 1.68GB) |
| 정지 → 종료 | 2초 이내 | 0.13초 (앱 순서 통합 확인 0.18–0.24초) |

**7.2 표준 엔진(1.7B) 실측 (2026-10-14, `tractus live --engine std`, M3 16GB, 가상 `say` 대화 68초 ×2·334초, 화자 끔, 부하 평균 3–6):** 가벼운 엔진(0.6B)과 같은 조건으로 나란히 쟀다. 결론은 **실시간에는 쓸 수 없다(`not_feasible`)**. 레지스트리의 `live`는 계속 `asr-lite`를 요구한다.

| 지표 | 목표 | 가벼운 엔진 (0.6B) | 표준 엔진 (1.7B) |
| --- | --- | --- | --- |
| 확정 지연 p95 | 1.0초 이하 (단서 한도 1.25초) | 0.80–1.01초 (조용할 때 0.76초) | **1.59 · 1.73 · 1.95초 → 실패** (+59–95%) |
| ASR 시간 / 오디오 길이 | 0.5 이하 | 0.14–0.17 | 0.29–0.33 |
| 최대 footprint | 4.5GB 이하 | 1.85GB | 3.42–3.43GB (켠 직후 2.54GB, 가벼운 것보다 +1.40GB) |
| 334초 메모리 증가 | 10% 이하 | +0.1% | +0.0% |
| `live_lagging`·버려진 `final` | 없음 | 0 · 0 | 0 · 0 |
| CER (가상 음성) | 참고 | 0.150 · 0.164 | 0.186 · 0.178 |

위 표의 목표(1.0초·단서 한도 1.25초·4.5GB·RTF 0.5·증가 10%)는 이 점검을 위해 새로 정한 기준이고, 바로 위 7.2 표의 원래 목표(p95 0.70초, 최대 메모리 3.4GB)보다 느슨하다. 원래 목표로 보면 표준 엔진은 p95뿐 아니라 최대 메모리(3.42–3.43GB)도 넘고, 가벼운 엔진도 p95 0.70초를 이미 넘었다(0.76초). GPU 점유율 증가분은 표준 엔진 약 25–37%p(시작 전 기준값 5–23%가 흔들려 근사)이고 원래 목표(0.29)와 직접 견주지 않았다. 원인과 다시 따져 볼 길은 ARCHITECTURE.md §2.6. 부하 평균이 기준 4를 넘는 실행이 있었으나(보안 프로그램) 표준 엔진의 초과가 너무 커서 다시 재지 않았다. 전체 값은 `bench/results/live_summary.json`.

- Nemotron 'low' 스트리밍 화자 라벨은 동작하지만 GPU 사용률 증가분(기준값 뺀 값)이 약 42%p로 화자 끔(12–17%p)의 약 세 배, footprint가 2.97–3.24GB로 늘어 `--speakers` 옵트인으로 뺐다. 앱은 켜지 않는다(`speaker: null`).
- **앱 통합 확인 (2026-10-07):** 실제 `tractus-rec record --fake`(mic + system 두 트랙) 녹음 중에 `tractus live`를 띄우고 앱과 같은 순서(녹음 stop → 자막 stop → stdin 닫기 → 5초 대기)로 멈췄다. 0.24초 만에 `done` 뒤 종료 코드 0, 남은 프로세스 없음. 이어서 `transcribe --recording`이 성공했다. 가상 대화(실시간)로도 같은 순서를 돌렸다: final 14개, 정지 → 종료 0.18초, 자막 프로세스가 끝난 뒤 정식 전사(1.7B + 화자 분리 + 정렬)가 성공. 그 이벤트(`app/src/fixtures/live_say.jsonl`)를 앱 `liveReduce` 테스트에 넣었고, 앱 명령 그대로 실제 `tractus live`를 띄우는 Rust 테스트(`cargo test -- --ignored real_live`)를 두었다.
- **남은 일 (사람만 할 수 있음):** 팬 없는 M3 Air에서 1시간 연속 녹음 + 실시간 자막으로 발열·스로틀링·확정 지연 확인. 실제 대면 회의(원거리 마이크)와 화상 회의(시스템 오디오 혼합)에서 미리보기 품질 확인.

## 5. 하지 않는 것

| 항목 | 이유 |
| --- | --- |
| 클라우드 공유 링크 | '오디오는 기기를 떠나지 않는다' 원칙(ARCHITECTURE §1)에 어긋난다. 번들 파일과 Finder 공유로 대신한다 |
| 화상회의 봇 | 클라우드 전용 기능이다. 시스템 오디오 탭으로 대신한다 |
| hwp 내보내기, ML 잡음 제거(RNNoise 등) | 수요 대비 비용이 크다 |
| 전체 회의 에이전트형 채팅 | MCP가 이미 담당한다 |
| Nemotron 3.5 스트리밍을 기본으로 사용 | 코드스위칭 MER 45.1, 용어 재현율 1.1%로 나쁘다. 1일짜리 실험 플래그로만 둔다 |
| soynlp, ffmpeg 번들 | LGPL·GPL 라이선스 문제가 있다 |

## 6. 위험

- **편집 보존:** `transcript.json`은 잠금 없이 읽고 고쳐 쓴다. 텍스트 편집과 화자 편집을 같은 `inFlight`로 직렬화한다. 나중에 LLM 교정을 넣으면 출처(`corrected_by`)를 추가해 사용자 편집을 덮어쓰지 않게 한다.
- **편집 지연:** 저장할 때마다 Python을 띄우므로 약 3초가 걸린다(추정). 체감이 나쁘면 상주 `tractus mcp` 프로세스로 옮긴다.
- **정렬 정확도:** 깨끗한 TTS 음성으로만 검증했다. 원거리 마이크, 발화 겹침, 웃음 소리 구간은 아직 측정하지 않았다. 8bit 모델은 110~140초를 넘으면 시간이 틀어진다.
- **WebKit 하한:** Highlight API, `plaintext-only`, `preservesPitch`는 macOS 26.6에서만 확인했다. 앱 최소 버전인 14.4에서는 확인하지 않았다.
- **질의 품질:** 자연어 한국어 질문으로 검색했을 때의 재현율, Upstage의 스트리밍 응답과 인라인 인용 준수 여부를 아직 확인하지 않았다.
- **목소리 프로필:** 한국어 EER은 AI Hub로만 쟀다(`bench/voice_eval.py`). 실제 대면 회의(원거리 마이크)에서는 아직 재지 않았다. 오인식은 요약의 담당자 이름으로 번진다. 생체정보이므로 로컬 저장과 삭제 명령이 필수다.
- **실시간 전사:** 장시간 사용 시 발열을 확인하지 않았다. 실시간 화자 라벨은 최종 라벨과 다를 수 있으므로 이름 변경은 최종 전사 뒤에만 허용한다.
- **클로바노트 근거의 수명:** 웹 클라이언트 청크 해시는 배포 때마다 바뀐다. 증거로 쓴 웹 클라이언트 문자열은 위 표의 출처 URL에 있다.