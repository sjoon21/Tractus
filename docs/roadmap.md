# Tractus 로드맵 — 클로바노트 격차 해소 (Phase 5~7)

> 작성 2026-10-06. 클로바노트 공식 도움말·요금표·릴리스 노트와 웹 클라이언트 UI 문자열로 기능 유무를 확인했다. 참고 코드는 MIT·Apache-2.0·BSD만 가져다 고친다. AGPL·GPL·LGPL과 비OSI 라이선스는 **아이디어로만** 참고한다. 스타 수와 라이선스는 2026-10-06에 `gh api`로 확인했다.

**결론:** 받은 격차표는 클로바노트를 과대평가했다. 실제로 막아야 할 격차는 **텍스트 편집, 재생 컨트롤, 파일 가져오기, 내보내기** 네 가지이고, 모두 Phase 5에서 약 9일이면 닫힌다. 단어 정렬, 회의 질의, 실시간 전사, 목소리 등록은 그다음 단계에서 차별화 기능으로 다룬다.

## 1. 격차표 정정

| 항목 | 클로바노트 실제 | Tractus 현재 | 판정 |
| --- | --- | --- | --- |
| 실시간 전사 | **부분 지원.** PC 웹에서 시작한 녹음에서만 켤 수 있다(`realtime_app_block`). 기본 흐름은 종료 후 변환이다 | 녹음 중에는 레벨미터, 북마크, 메모만 있다 | 필수 아님. Phase 7 |
| 텍스트 편집 | 있다. 구간 재생 편집, 단어 바꾸기·전체 바꾸기(참석자 이름 제외), 자주 쓰는 단어 등록 유도 | 화자 편집만 된다. `corrected_text` 필드는 있지만 비어 있다. md·vtt·요약·CLI 검색은 `s['text']`만 읽는다 | **최대 격차.** Phase 5 |
| 단어 단위 싱크 | 단어를 클릭하면 그 단어부터 재생한다. 재생 중 단어 강조(가라오케)는 **미확인** | 세그먼트 단위 이동과 강조. 세그먼트는 이미 **화자 전환 지점에서 나뉘고** 최대 30초다 | Phase 6 |
| 화자 수 | 선택지가 1~4명, '5명 이상'뿐이다. '무제한'은 근거가 없다 | Nemotron은 8명이 모델 상한이다. 백업 엔진(FluidAudio community-1)은 이미 정해 뒀다 | 우선순위 낮음 |
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
| **6.1 단어 타임스탬프** | `_run`에서 ASR 다음, `_free_mlx()` 뒤에 `align` 단계를 넣는다. 모델은 Qwen3-ForcedAligner-0.6B-8bit(Apache-2.0, revision 고정)이다. `tokenize_korean`을 `tokenize_space_lang`으로 바꿔 **soynlp(LGPL-3.0)를 피한다.** 입력은 60초에서 자른다. 단어 수가 맞지 않으면 `words`를 null로 둔다. 텍스트를 편집하면 difflib으로 시간을 옮기고 `approx`로 표시한다. `tractus align`으로 기존 회의를 채우고 `--no-align`으로 끌 수 있게 한다 | mlx-audio(MIT, 7994★) `qwen3_forced_aligner.py` L96-145, L637-760 (설치본 0.5.7). bbc/react-transcript-editor `stt-align-node.js` L102-185 (아이디어. 그대로 쓰면 한글이 지워진다) | 2.5 | 실제 대면 회의 30분으로 검증한다. 1시간 회의 정렬 시간이 90초 이하다(실측 RTF 0.02) |
| **6.2 가라오케·단어 탐색** | rAF 루프와 이진 탐색으로 현재 단어를 찾고 `CSS.highlights`로 강조한다. 단어마다 span을 만들지 않는다. 클릭하면 `caretRangeFromPoint` → 해당 단어로 `seekTo`. `approx` 단어는 세그먼트 시작으로 이동한다 | Scriberr `useKaraokeHighlight.ts` L19-117, `TranscriptView.tsx` L7-19 @a353078f | 1.5 | 1시간 회의에서 프레임 저하가 없다. macOS 14.4에서 동작한다 |
| **6.3 회의 질의(Ask)** | `tractus ask --progress-json`: stdin으로 질문을 받고 `sources`, `delta`, `done` 이벤트를 낸다. 회의 범위 질문은 `build_prompt`를 재사용한다. 전체 범위 질문은 상주 MCP `search_meetings` 결과에 이웃 3개 세그먼트를 붙인다. `[s0012]` 인용은 프롬프트에 없던 id를 버리고 TimeChip으로 표시한다. 대화는 `chat.json`에 6턴·12k자까지 저장한다. `TRACTUS_LOCAL_ONLY`를 따르고, 전송될 공급자를 표시한다 | stenolabs/stenoai(MIT, 1327★) `src/chat_query.py` L12-155 @48b9412f. Scriberr `internal/api/chat_handlers.go` L432-560. open-webui(비OSI, **아이디어만**) 인라인 인용 UI | 4.5 | 한국어 질문 20~30개로 평가 세트를 만든다. 인용을 클릭하면 해당 오디오로 이동한다. 근거가 없으면 '출처 없음'을 표시한다 |
| **6.4 음성 강조 필터** | Web Audio 체인: highpass 100Hz → peaking 3kHz +4dB → compressor → gain. `crossOrigin`은 설정하지 않는다 | wavesurfer.js `examples/webaudio.js` L19-50 @302fd210 | 1 | Ogg/Opus에서 1.5x 재생과 함께 동작한다 |
| **6.5 PDF** | print CSS와 `Webview::print()`로 macOS 'PDF로 저장'을 쓴다. Typst(Apache-2.0)는 CLI에서 PDF가 필요해질 때 도입한다 | tauri `crates/tauri/src/webview/mod.rs` L1622-1628 @79d35376. anarlog `crates/export-core/src/typst/` (업그레이드 경로) | 1 | 사이드바와 플레이어가 숨겨지고 한글이 선택 가능하다 |

요약 템플릿 선택(`~/Tractus/templates/*.md`)은 요청이 오면 추가한다.

## 4. Phase 7 — 사람과 실시간 (약 12일)

| 항목 | 접근 | 참고 코드 | 일수 | 완료 기준 |
| --- | --- | --- | --- | --- |
| **7.1 목소리 프로필** | sherpa-onnx(Apache-2.0)와 3D-Speaker CAM++ zh_en(192차원, 28MB, Apache-2.0)을 쓴다. 이름을 바꿀 때 '기억하기'를 체크하면 화자당 1.5~10초 구간 최대 3개로 등록한다. `voices.json`은 권한 0600, 1인당 최대 5개를 둔다. 매칭은 `linear_sum_assignment`와 임계값 + 2위와 차이 0.08로 한다. '자동 인식 82%' 배지를 달고 미확정으로 남긴다. `tractus voices list\|enroll\|forget`을 둔다. 벡터는 MCP와 LLM으로 내보내지 않는다. 다른 사람을 등록할 때는 동의 확인(개인정보보호법 23조)을 받는다 | anarlog `crates/voiceprint/src/matching.rs` L1-165, `lib.rs` L36-100. k2-fsa/sherpa-onnx(Apache-2.0, 15121★) `python-api-examples/speaker-identification.py` L114-250 @99ddefaa | 5 | `bench/voice_eval.py`로 한국어 EER을 재고 FAR 1%가 되는 임계값을 정한다 |
| **7.2 실시간 전사 (옵트인)** | `tractus live --recording <dir>`: 커지는 WAV를 꼬리부터 읽고 Silero `feed()`를 쓴다. 0.5초 무음이나 8초 상한에서 확정하고, 3초마다 미리보기를 낸다. Qwen3-ASR 0.6B와 Nemotron 'low' 설정을 쓴다. 정지하면 워커가 먼저 종료하고 배치 전사가 최종본이 된다. 16GB 미만 기기에서는 기본으로 꺼 둔다 | yazinsai/OpenOats(MIT, 2596★) `StreamingTranscriber.swift` L89-260, `DiarizationManager.swift` L19-63 @c6c6f164. meetily `audio/pipeline.rs` L16-27 | 4.5 | 시뮬레이션 실측: 확정 지연 p95 0.70초, GPU 점유율 0.29, 최대 메모리 3.4GB. 팬 없는 M3 Air에서 1시간 연속 테스트 |
| **7.3 9명 이상 화자** | `recorder/`에 `tractus-diar`(FluidAudio v0.17.5, `offlineMode`)를 추가하고 `--diarizer auto\|nemotron\|fluid`로 고른다. auto는 Nemotron 8채널이 모두 쓰였을 때만 재실행한다 | FluidInference/FluidAudio(Apache-2.0, 2960★, 가중치 CC-BY-4.0) `OfflineDiarizerManager.swift` L127-180, `ProcessCommand.swift` L120-160 @04e363c2 | 2.5 | AI Hub 17명 세션에서 confusion이 26.5%보다 낮아진다 |

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
- **목소리 프로필:** CAM++의 한국어 EER을 측정하지 않았다. 오인식은 요약의 담당자 이름으로 번진다. 생체정보이므로 로컬 저장과 삭제 명령이 필수다.
- **실시간 전사:** 장시간 사용 시 발열을 확인하지 않았다. 실시간 화자 라벨은 최종 라벨과 다를 수 있으므로 이름 변경은 최종 전사 뒤에만 허용한다.
- **클로바노트 근거의 수명:** 웹 클라이언트 청크 해시는 배포 때마다 바뀐다. 증거로 쓴 웹 클라이언트 문자열은 위 표의 출처 URL에 있다.