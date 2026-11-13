# Windows 지원 계획 (조사·결정 기록)

> 진행 순서와 할 일 목록은 [README.md](README.md)가 원본이다. 이 문서는 그 근거다: 2026-10-20 저장소 전수 조사·외부 조사(1–6절)와
> 2026-11-13 경쟁 앱 Yogurt(MIT) 코드 조사(7절). 원래 `docs/internal/windows-port.md`(커밋하지 않는 메모)였고, Windows 기기에서 이어서 작업할 수 있게
> 2026-11-13에 저장소로 옮겼다. 외부 조사의 링크·수치는 정하기 전에 다시 확인한다. 1–6절의 onnxruntime 서술은 7.1절이 바로잡는다.

## 1. 결론

- **가장 큰 일은 MLX를 대신할 런타임이다.** 변환·VAD·화자 분리·단어 정렬·검색 임베딩·실시간 자막이 모두 MLX(Apple Silicon)로 돈다. Windows에서는 Metal이 없어 CPU뿐이다.
- **런타임은 이미 의존성인 onnxruntime 하나로 모을 수 있다.** torch는 모델을 ONNX로 내보낼 때 개발 PC에서만 쓴다. 다만 Qwen3-ASR의 한국어 정확도(양자화 포함)를 Windows에서 잰 사람이 없다. **먼저 벤치로 될지부터 본다.**
- **녹음 프로그램은 다시 만든다.** Swift(AVAudioEngine·Core Audio tap)를 Rust `wasapi`로. 이벤트·파일 계약은 그대로 지킨다.
- **나머지는 대부분 작은 수정이지만 곳곳에 흩어져 있다.** `fcntl`, 0600 권한, 신호, `HOME`·PATH, `.app` 경로, ⌘ 단축키, "이 Mac" 문구.
- **0.5.0은 "Windows 미리보기"로 범위를 줄이는 것을 권한다.** 단어 정렬은 추정으로, 9명 이상 화자 분리·캘린더는 빼고, 실시간 자막은 벤치 결과에 따라 정한다.

## 2. 저장소에서 막히는 것 (전수 조사 요약)

| 등급 | 개수 | 대표 |
| --- | --- | --- |
| 막힘 (안 바꾸면 동작 불가) | 5 | MLX/Metal, 녹음 프로그램(Swift), Rust `std::os::unix`(`llm_key.rs:12`), `.app` 경로 구조(`paths.rs`·`paths.py`), Python `import fcntl`(`store.py` 등 5곳) |
| 기능 빠짐·고장 | 18 | fluid 화자 분리(CoreML), 캘린더(EventKit), 실시간 자막의 WAV 꼬리 읽기(파일 공유), PATH 덮어쓰기(`lib.rs:192`), `HOME`(`lib.rs:118`), `/bin/kill`(`models.rs:427`), 콘솔 창(`CREATE_NO_WINDOW` 없음), 창 제목줄 설정, 트레이 제목(Windows 미지원), `os.kill(pid, 0)`(Windows에서 Ctrl+C 신호), `os.fchmod`, doctor가 늘 "부족", SIGTERM, ⌘ 단축키, 권한 안내 문구, 플러그인 bash 실행기, `say` 음성 기반 시험·벤치 |
| 작은 수정 | 17 | `os.sysconf` 메모리, 화면 언어 감지(`defaults read`), 휴지통 COM, ffmpeg 안내 문구, docx 한글 글꼴(Malgun Gothic), MCP 경로 검사의 `..\`, Windows 예약 파일 이름·260자, "이 Mac"·Finder 문구 |
| 패키징·CI | 5 | `build_app_bundle.sh`·`make_dmg.sh`·`release.sh`(전부 macOS 도구), 개발 스크립트·Brewfile, CI가 전부 `macos-latest`, Tauri `bundle.targets`·`.ico`, 업데이트 `latest.json`이 `darwin-aarch64`만 |

이미 Windows에서 되는 것: onnxruntime(CAM++ 목소리 프로필), sqlite-vec, kaldi-native-fbank, numpy·scipy·tokenizers, python-docx, openai, mcp. ARM64는 wheel이 없는 패키지가 있어 당장은 x64만.

## 3. 기능별 Windows 경로 (외부 조사 요약, 확인 필요)

| 기능 | 권장 | 대안 | 노력 | 위험 |
| --- | --- | --- | --- | --- |
| 변환 Qwen3-ASR | onnxruntime 직접 export(INT8/INT4, 프롬프트를 직접 만들어 자주 쓰는 단어 유지) | OpenVINO GenAI `ASRPipeline`(`context` 인자, Intel CPU·iGPU) / ggml 보조 실행 파일(CrispASR, MIT, Vulkan·CUDA) | M~L | 양자화 한국어 CER 미측정, INT4·FP16에서 빈 출력·반복 사례 |
| VAD | Silero ONNX + onnxruntime(MIT, torch 없이) | — | S | MLX 결과와 경계 차이 |
| 단어 정렬 | 0.5.0은 `approx` 추정(모델 없음으로 막음) | ForcedAligner ONNX export(단일 forward라 쉬운 편) | S → M | 한국어 경계 정확도 |
| 화자 분리 | Nemotron-3 ONNX(8명까지, parakeet-rs 방식) | pyannote segmentation-3.0 ONNX(MIT) + CAM++ 군집화(9명 이상·실패 시) | M | 커뮤니티 이식본, DER 다시 재기 |
| 검색 임베딩 | Qwen3-Embedding-0.6B ONNX int8(onnxruntime 1.23 이상) | GGUF + llama.cpp | S | `MODEL_ID`가 바뀌어 다시 색인, 검색 평가 둘 다 다시 |
| 녹음 | Rust `wasapi` 크레이트(MIT)로 `tractus-rec.exe`: 마이크 + loopback, 트랙 따로 | Windows 10은 endpoint loopback | M~L | 앱별 loopback은 Windows 11 전용, 블루투스·장치 전환 |
| ffmpeg | 사용자가 `winget install`(지금 Homebrew와 같은 정책, 번들 안 함) | 녹음 WAV는 표준 `wave`로 읽어 ffmpeg 없이 변환 | S | — |
| 설치·업데이트 | Tauri NSIS `perUser`(관리자 권한 없음), WebView2 bootstrapper, updater `windows-x86_64` | MSI | M | site-packages 경로 260자, Defender 첫 실행 지연 |
| 코드 서명 | OV 인증서(클라우드 HSM) | Azure Artifact Signing(한국 개인은 가입 불가로 보임) | S(+평판 수 주) | 서명 안 하면 SmartScreen 경고 |
| 키 보관 | Windows 자격 증명 관리자 또는 DPAPI | 파일 + ACL | S~M | 지금 0600 파일 규칙의 대체 |

## 4. 먼저 정할 것 (소유자 결정)

1. **대상:** Windows 11 x64만 / Windows 10까지. 앱별 소리 녹음(process loopback)은 11 전용이다.
2. **범위:** 0.5.0을 "미리보기"로 낼지(단어 정렬 추정, 9명 이상·캘린더 없음), 기능을 다 맞춘 뒤 낼지.
3. **변환 런타임 후보:** 벤치로 고른다. onnxruntime 직접 export / OpenVINO GenAI / ggml 보조 실행 파일.
4. **코드 서명:** OV 인증서 비용을 쓸지, 처음에는 서명 없이(SmartScreen 경고) 낼지.
5. **시험 장비:** Windows PC(가능하면 Intel·AMD CPU 노트북 하나 + NVIDIA 데스크톱 하나). Mac에서는 Windows용 설치 파일을 만들 수 없어 CI `windows-latest`도 필요하다.

## 5. 순서 (제안)

0. **벤치 스파이크 (가부 판단).** Windows PC에서 Qwen3-ASR 1.7B/0.6B를 onnxruntime(INT8)과 OpenVINO로 AI Hub(로컬, 지표만) CER·RTF·메모리, 자주 쓰는 단어 재현율. 기준 MLX 8bit CER 9.49, 용어 재현율 84%. 여기서 안 되면 계획을 다시 짠다.
1. **이식성 정리 (Mac에도 안전, main에 바로).** 코어: 파일 잠금(`fcntl` → 플랫폼별), `fchmod`·0600, `os.kill(pid, 0)`, `sysconf`, 신호 → stdin 정지, `paths`(앱 데이터 위치·`.exe`), doctor. Rust: `cfg(unix)`, `HOME`, PATH, `CREATE_NO_WINDOW`, `/bin/kill`, 언어 감지. 화면: ⌘/Ctrl 단축키 갈래. CI에 `windows-latest`로 pytest·cargo test 추가(모델 없이 도는 것만).
2. **런타임 갈래.** 기능마다 백엔드를 두고(`asr`·`vad`·`diarize`·`embed`) `models_registry`에 플랫폼별 모델 항목. 기능 잠금(`CAPABILITIES`)은 그대로 쓴다. ONNX 백엔드 구현 + `bench/` 재측정(CLAUDE.md 규칙: ASR·화자 분리·검색).
3. **녹음 프로그램 (Rust `wasapi`).** 지금 계약(JSON Lines, stdin `stop`·`pause`·`memo`, `mic.wav`·`system.wav` 48k mono, `recording.json`, `--fake`·`check`) 그대로. 실시간 자막이 읽을 수 있게 파일 공유 모드.
4. **번들·설치·업데이트·서명.** Windows용 python-build-standalone + wheel만, NSIS perUser, `latest.json`에 `windows-x86_64`, release 스크립트·CI.
5. **화면·문구·문서.** 창 제목줄(기본 제목줄 또는 직접 만든 단추), 트레이 경과 시간(툴팁), 권한 안내(`ms-settings:privacy-microphone`), "이 Mac" → 플랫폼 문구(WORDS.md 규칙부터), README·setup·site.

## 6. 벤치가 필요한 것

- 양자화별 Qwen3-ASR 한국어 CER(AI Hub), 반복·빈 출력 비율, 자주 쓰는 단어 재현율
- 보통 CPU(i5·Ryzen 5, 16GB)의 RTF·메모리, 실시간 자막(0.6B, 확정 지연 p95 1초 이하) 가능 여부
- DirectML·CUDA·OpenVINO GPU별 속도·정확도
- Nemotron ONNX와 segmentation + CAM++의 DER(`bench/diar_eval.py`). 가상 음성은 `say` 대신 Windows 음성이라 기준이 달라진다
- ONNX 임베딩 검색 품질(`search_eval`·`aihub_search_eval` 둘 다)
- 번들 크기, 첫 실행 시간(Defender 포함)

### 6.1 Mac에서 먼저 잰 것: ONNX int4 (2026-10-22)

`andrewleech/qwen3-asr-1.7b-onnx`(Apache-2.0, revision `df916193`)의 int4 판(인코더 FP32 1.27GB + 디코더 int4 2.2GB + `embed_tokens.bin` 622MB, 합계 3.8GB)을 onnxruntime 1.30 **CPU**로 돌렸다. 시험 뒤 모델은 지웠다(소유자 요청: 디스크). 코드는 저장소 밖 일회성 스크립트였다.

| AI Hub 세션 1 앞 60발화 (6.7분, 정답 발화 구간) | CER | 표기 차이 뺀 CER | RTF | 최대 메모리 |
| --- | --- | --- | --- | --- |
| MLX 8bit (GPU, 지금 제품) | 10.07 | 9.15 | 약 0.17 | — |
| ONNX int4 (CPU, Apple M3 4P+4E) | **9.51** | 9.03 | **0.26** | 4.3GB |

- **int4로 내려도 한국어 정확도가 나빠지지 않았다**(60발화라 차이는 잡음 범위). 반복·빈 출력 0.
- **CPU만으로 실시간보다 약 4배 빠르다.** Windows 보통 CPU(i5·Ryzen 5)에서는 더 느릴 것이라 그쪽에서 다시 재야 한다.
- CoreML 실행 공급자는 큰 그래프를 거의 맡지 못한다(목소리 모델에서 1785개 중 33개 노드). Mac에서 GPU 가속 대체로 쓸 수는 없다.
- 직접 짠 부분: 인코더 → `decoder_init`(input_ids + audio_features + audio_offset) → `decoder_step` 탐욕 디코딩(임베딩은 `embed_tokens.bin`에서 찾는다), 프롬프트는 mlx-audio `_build_prompt`와 같은 문자열(`language Korean<asr_text>`). 자주 쓰는 단어는 mlx-audio처럼 시스템 프롬프트에 넣으면 되지만 재지 않았다.
- 남은 것: 전체 4세션·자주 쓰는 단어 재현율, 0.6B(실시간 자막), Windows CPU 속도.


## 7. 2026-11-13 Yogurt 참고 계획

> 2026-11-13 소유자 결정: Windows 지원을 **조금씩 시작한다.** 경쟁 앱 Yogurt(MIT, Electron, Windows x64·Linux 배포 중)의 코드를 읽어 시행착오를 줄인다. Yogurt는 읽기만 했다(실행·설치·빌드 안 함). 아래 `Y:`는 Yogurt 저장소 루트다(`git clone https://github.com/FrigadeHQ/yogurt`, 읽은 판: 커밋 `6bd8c3f`, 2026-11-12).
> 가져다 쓰는 코드는 MIT라 저작권 고지가 필요하다: 옮긴 파일 머리에 출처 주석, NOTICE에 Yogurt MIT 전문 한 항목.

### 7.1 위 1–6절에서 고칠 것

- **앱별 소리 녹음(process loopback)은 Windows 11 전용이 아니다.** Yogurt는 Windows 10 2004(19041) 이상에서 `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` + `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`로 "자기 앱만 빼고 모든 앱"을 녹음하고, 안 되면 출력 전체(endpoint loopback)로 물러난다(`Y:app/native/yogurt-audio-win/src/win/mod.rs` `start_system`·`process_loopback`). 4절 1번의 "11 전용" 근거가 약해졌다.
- **onnxruntime은 이제 의존성이 아니다**(v3.99, 목소리는 `onnx_mlx`). 1절·2절의 "이미 의존성인 onnxruntime", "이미 Windows에서 되는 것: onnxruntime"은 옛 이야기다. Windows에서 ONNX를 쓰면 의존성을 다시 들이는 결정이 된다(번들 약 75MB).

### 7.2 구성 요소별: Yogurt가 하는 것 / 가져올 것 / 남는 우리 일

| 구성 요소 | Yogurt (Windows) | 가져올 것 (MIT) | 남는 우리 일 |
| --- | --- | --- | --- |
| 녹음 프로그램 | Rust `windows` 0.62.2 크레이트로 WASAPI 직접. 마이크는 shared mode, 통신 역할을 쓰지 않아 통화 앱의 마이크를 건드리지 않음. 시스템 소리는 process loopback → endpoint 물러남. 장치 바뀜은 `IMMNotificationClient`로 받아 300ms 모였다가 다시 만듦. QPC 시계로 시각을 맞추고 빈 구간은 무음으로 채움(`gap.rs`). `panic = "abort"`, 정적 CRT(VC++ 런타임 설치 불필요) (`Y:app/native/yogurt-audio-win/src/{win/mod.rs,record.rs,gap.rs,resample.rs}`, `Cargo.toml`) | `win/mod.rs`의 장치 나열·`process_loopback`·`parent_pid`·장치 알림·`Clock`, `gap.rs`, `record.rs`의 한 스레드 이벤트 고리 구조, 마이크 거절 판별(`StartError::Denied`) | **파일 계약이 다르다.** Yogurt는 Ogg Opus(`me.ogg`·`them.ogg`) + stdout으로 16k PCM을 흘린다. 우리는 `mic.wav`·`system.wav` 48k mono + `recording.json` + JSON Lines 이벤트 + stdin `stop`·`pause`·`memo`(docs/desktop.md §1). Opus·Ogg·PCM 스트림은 버리고 WAV 쓰기·우리 이벤트 이름으로 바꾼다. `--fake`·`check`도 새로 |
| 마이크 권한 | 권한 창이 없다. 개인정보 설정(ConsentStore)에서 꺼져 있으면 시작이 거절되고 `no-mic` 경고(`record.rs` 166행 부근) | 거절 판별 방식, CI에서 레지스트리로 거절·허용을 만드는 법(`Y:.github/workflows/native-windows-audio.yml` "microphone turned off") | 앱 안내: `ms-settings:privacy-microphone` 열기(지금 Mac의 시스템 설정 열기와 같은 자리, 이번 브랜치 `feat/permission-guide`의 갈래) |
| 통화 감지(선택) | 마이크를 쓰는 프로세스 목록(Core Audio 세션 + ConsentStore), 창 제목(`Y:app/native/yogurt-system/src/win.rs`) | 나중에 "통화 시작 알림"을 만들면 그대로 참고 | 지금 Tractus에 없는 기능. 미리보기 범위 밖 |
| 변환(ASR) | whisper.cpp `whisper-server`를 127.0.0.1 임의 포트로 띄움. 한 실행 파일에 `GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON` + `GGML_VULKAN=ON`: 시작할 때 CPU 변형 중 가장 좋은 것과, 드라이버가 있으면 **Vulkan**을 고름. CUDA 빌드 없음, `GGML_NATIVE=OFF`·OpenMP 끔·정적 CRT. 모델은 large-v3-turbo q5_0 / small / base / tiny(`Y:app/scripts/whisper-build.mjs`, `Y:app/src/main/asr/server.ts`, `Y:catalog/catalog.json` `whisperCpp`) | 빌드 플래그 묶음, Vulkan SDK sha256 고정 CI(`Y:.github/workflows/native-whisper.yml`), 남은 프로세스를 `tasklist`로 확인 후 죽이기(`server.ts` `windowsName`) | 모델·런타임 선택 자체(7.4). Whisper를 그대로 쓰면 한국어 품질이 떨어진다 |
| 속도로 모델 고르기 | 짧은 클립을 돌려 RTF ≤ 0.5인 첫 모델을 고르고 하드웨어 키로 저장(`Y:packages/picker/src/asr.ts` `pickBySpeed`·`KEEPS_UP_RTF`·`speedKey`), GPU 종류(통합·외장·없음)로 후보를 거름 | 이 방식 그대로(코드 100줄 남짓). 1.7B/0.6B 중 고르기에 맞다 | 기준값은 우리 `bench/`로 정한다 |
| VAD | whisper-server 안의 Silero ggml(`ggml-silero-v6.2.0.bin`) | — | 우리는 Python에서 Silero를 부른다. 런타임을 정한 뒤 그 런타임의 Silero(ONNX 또는 ggml)로. 경계 차이는 변환 CER로 함께 잰다 |
| 화자 분리 | 없음(트랙 "나/상대"만) | — | 전부 우리 일. 미리보기에서는 끔(화자 없이 변환, 이미 있는 `warning` 경로) |
| 단어 정렬 | 없음 | — | 미리보기에서는 `approx` 추정(모델 없음 경로, 이미 있음) |
| 검색 임베딩 | node-llama-cpp + EmbeddingGemma 300M GGUF | llama.cpp 계열로 임베딩을 돌리는 예 | 미리보기는 키워드 검색만(FTS5, `pending` 그대로) 또는 이미 있는 Upstage 옵트인. 로컬 벡터는 Stage 2 |
| 목소리 프로필 | 없음 | — | `onnx_mlx`가 MLX에 묶임. 미리보기에서 끔(기능 잠금) |
| 실시간 자막 | 녹음 프로그램이 stdout으로 PCM을 흘리고 whisper-server가 greedy로 부분 결과 | stdout PCM 방식은 참고만 | 우리는 WAV 꼬리 읽기. Rust `std::fs::File`과 Python `open()`은 Windows에서 공유 읽기·쓰기를 허용하므로 계약을 바꾸지 않아도 될 가능성이 높다(Windows에서 확인). 미리보기 범위 밖 |
| LLM | 로컬 llama.cpp(node-llama-cpp, CUDA·Vulkan 백엔드 포함) | — | 우리는 원격 OpenAI 호환 API라 그대로 된다. `custom`·`gemma-local`의 localhost 규칙도 같다 |
| 앱 경로·트레이 | Electron `appData`(`%APPDATA%\Yogurt`), 실행 파일 옆 `resources/bin/*.exe` | 폴더 규칙(설정은 `%APPDATA%`, 큰 모델은 `%LOCALAPPDATA%`가 관례) | Tauri `paths.rs`의 `.app/Contents/Resources` 가정, `HOME`·PATH 덮어쓰기, `/bin/kill`, `CREATE_NO_WINDOW`, 트레이 제목(Windows는 툴팁만) |
| 설치·업데이트 | electron-builder NSIS `oneClick: true`, `perMachine: false`, x64만, **서명 없음**. electron-updater가 `latest.yml`로 업데이트(`Y:app/electron-builder.yml` 93–116행, `Y:app/src/main/updates.ts`) | "서명 없이 per-user NSIS로 먼저 낸다"는 선례. 설치본을 CI에서 실제로 설치하고 도우미가 도는지 보는 단계(`Y:.github/workflows/preview.yml` "Install it"·"installed helpers run") | Tauri NSIS `installMode: currentUser` + updater `windows-x86_64` 항목, `release.sh` 갈래. Python 런타임 번들(python-build-standalone Windows판) |
| MCP 플러그인 실행기 | Windows는 named pipe(`\\.\pipe\yogurt-mcp-…`) 중계 실행 파일, 앱이 MCP 서버(`Y:app/native/yogurt-mcp-relay/src/main.rs`) | 프로필 폴더 찾기(`%APPDATA%`) 정도 | 우리 MCP는 코어 Python이 stdio로 직접 돈다. 중계가 필요 없다. `bin/tractus-mcp`(bash)만 `.cmd` 또는 작은 exe로 |
| 코어 POSIX | (해당 없음, Node) | — | 2절 그대로: `fcntl` 15곳(`store.note_lock`·`folders.json` 등) → `msvcrt.locking` 또는 `portalocker`류 없이 직접 갈래, `os.fchmod`·0600 → ACL 또는 그냥 사용자 폴더, `os.kill(pid, 0)`, `os.sysconf`, 신호 → stdin `stop` |
| 시험 | CI `windows-latest`에서 VB-CABLE 가상 사운드 카드를 해시 고정으로 설치하고 마이크 거절·허용·다른 앱 소리·자기 소리 빼기·endpoint 물러남을 실제로 녹음 시험. VC++ 런타임 의존 검사(`Y:.github/workflows/native-windows-audio.yml`) | **이 워크플로를 거의 그대로**(장치 없는 스모크 → 가상 카드 → 권한 거절 → 허용 → 시나리오) | 우리 `--fake`·이벤트에 맞춘 스모크 스크립트 |

### 7.3 단계 계획

**Stage 0 — Mac에서 지금 할 수 있는 것 (Windows 릴리스 비용 없음)**

1. **Windows 녹음 프로그램 설계·골격** `recorder/win/`(Rust, 새 크레이트 `tractus-rec`):
   - 계약은 `tractus-rec`(Swift) 그대로: 명령(`record`·`check`·`--fake`), JSON Lines 이벤트 이름, stdin `stop`·`pause`·`resume`·`memo`, `mic.wav`·`system.wav` 48k mono, `recording.json`. **앱·코어는 바꾸지 않는다.**
   - Yogurt에서 `win/mod.rs`(장치·loopback·알림·QPC), `gap.rs`, `record.rs` 고리 구조를 출처 주석과 함께 옮긴다. Opus·Ogg·PCM 스트림 부분은 가져오지 않는다.
   - 플랫폼 무관 부분(WAV 쓰기·헤더 갱신, 이벤트 직렬화, 무음 채우기, 리샘플)은 `cfg(windows)` 밖에 두어 **Mac에서 `cargo test`**로 돈다. `--fake`도 Mac에서 돌려 Swift판과 출력 모양을 비교하는 계약 시험을 둔다(`tests/`에 이벤트 모양 고정).
   - `cargo check --target x86_64-pc-windows-msvc`는 Mac에서 SDK 없이 안 되므로 CI에서.
2. **이식성 정리**(5절 1번, Mac 동작은 그대로): 코어 `fcntl`·`fchmod`·`kill`·`sysconf`·신호를 `paths.py` 옆 작은 플랫폼 모듈 하나로 모은다. Rust `cfg(unix)`·`HOME`·PATH·`/bin/kill`·`CREATE_NO_WINDOW`. 화면 ⌘/Ctrl. 한 PR에 다 넣지 않고 영역별로.
3. **Windows CI(빌드·테스트만, 배포 없음)**: `windows-latest`에서 (a) `uv run pytest`의 모델 없는 부분(실패 목록을 먼저 받아 `skipif`로 표시한 뒤 줄여 감), (b) `recorder/win` `cargo build --release` + `cargo test` + 장치 없는 스모크, (c) `app/src-tauri` `cargo check`. Yogurt처럼 VC++ 런타임 의존 검사. 매주·수동 실행으로 시작(PR마다 돌리면 느림).
4. **ASR 후보 측정 준비**: `bench/`에 Windows에서 돌 수 있는 실행기를 더한다(Mac에서도 CPU로 돌려 숫자를 맞춰 본다, 6.1절처럼).

**Stage 1 — "Windows 미리보기" 최소 범위**

- 녹음(마이크 + 시스템 소리, Stage 0의 Rust 녹음 프로그램) → 텍스트 변환(7.4에서 고른 런타임 하나, 화자·단어 정렬·목소리 없음) → 요약·질문(원격 LLM) → 키워드 검색 → 내보내기.
- 메모 노트·노트 정리·사전(자주 쓰는 단어, 런타임이 받을 수 있을 때)·Obsidian 내보내기는 코어가 이식되면 따라온다.
- 빠지는 것(기능 잠금으로 막고 이유를 보여 줌): 화자 분리, 단어 싱크(추정만), 목소리 프로필, 실시간 텍스트 변환, 스마트 검색 로컬 벡터(Upstage 옵트인은 가능), 캘린더, 9명 이상 화자.
- 배포: 서명 없는 NSIS per-user x64, GitHub 릴리스에 "미리보기"로 따로(업데이트 `latest.json`의 `windows-x86_64`는 Stage 1 끝에 켤지 결정). 설치본을 CI에서 실제로 설치해 `tractus doctor`·`record --fake`·변환 한 번을 도는 스모크(Yogurt `preview.yml` 방식, Mac의 `Bundle smoke`와 짝).
- 문구: "이 Mac" 등 플랫폼 문구를 WORDS.md에 규칙부터 정하고 고친다.

**Stage 2 이후**

- 화자 분리(Nemotron ONNX 또는 segmentation + CAM++, `bench/diar_eval.py`로 DER), 단어 정렬(ForcedAligner ONNX/ggml), 로컬 검색 임베딩(Qwen3-Embedding ONNX 또는 GGUF, 검색 평가 둘 다), 목소리(CAM++ — `onnx_mlx`의 numpy 경로로 CPU 실행이 되는지 먼저 확인), 실시간 텍스트 변환(0.6B, 확정 지연 p95 1초 기준을 Windows CPU에서 재기).
- 코드 서명, 업데이트 자동 확인, Windows 10 지원 범위 정리, ARM64는 그 뒤.

### 7.4 Windows 변환 런타임 후보 (고르기 전에 `bench/` 측정 필수)

CLAUDE.md 규칙대로 **`bench/` 측정 없이 ASR 런타임·모델을 바꾸지 않는다.** 후보마다 AI Hub(로컬, 지표만) CER·반복/빈 출력 비율·자주 쓰는 단어 재현율, FLEURS·HiKE, Windows 보통 CPU(i5·Ryzen 5, 16GB)와 Vulkan/CUDA GPU의 RTF·최대 메모리를 잰다. 기준: MLX 8bit Qwen3-ASR-1.7B CER 9.49, 용어 재현율 84%.

| 후보 | 런타임 | 장점 | 위험 |
| --- | --- | --- | --- |
| A. Qwen3-ASR ONNX(int4/int8) | onnxruntime CPU(+ DirectML 선택) | 6.1절에서 Mac CPU로 CER 9.51·RTF 0.26 확인. 모델 계열이 Mac과 같아 품질 설명이 같다. hotwords를 프롬프트로 넣을 수 있음 | onnxruntime을 다시 들임(번들 약 75MB), 디코딩 고리를 직접 짬, 보통 Windows CPU 속도 미측정, GPU 가속 불확실 |
| B. Qwen3-ASR ggml 이식(CrispASR류 보조 실행 파일, Vulkan·CUDA) | ggml(whisper.cpp와 같은 계열) | Yogurt의 빌드 방식(`GGML_BACKEND_DL` + Vulkan, 정적 CRT, 한 실행 파일)을 그대로 쓸 수 있다. GPU를 드라이버만으로 씀 | 커뮤니티 이식본의 성숙도·라이선스·양자화 품질 미확인, hotwords 지원 확인 필요 |
| C. Whisper(whisper.cpp, Yogurt와 같음) | ggml | 가장 검증된 Windows 경로, Yogurt 빌드·CI를 거의 그대로 | **한국어 품질이 나쁘다**: Phase 0 Korean CER Qwen3-ASR 9.49 vs Whisper-large-v3-turbo 14.92. Phase 0에서 프롬프트(용어)가 CER을 크게 나쁘게 해 사전도 못 씀. 이미 탈락한 모델이라 등록 목록에 다시 올리려면 측정 + 소유자 결정 |
| D. OpenVINO GenAI | OpenVINO | Intel CPU·iGPU에서 빠를 수 있음, `context` 인자 | Intel 외 장비, 번들 크기, 의존성 |

- 권하는 순서: **A를 Windows에서 먼저 재고**(이미 Mac 숫자가 있음), B를 같은 세트로 비교한다. C는 "Qwen이 Windows에서 너무 느린 장비용 마지막 수단" 후보로만 재고, 기본으로 두지 않는다.
- 고른 뒤 모델 목록 규칙: `models_registry`에 플랫폼별 모델 항목, 기능 잠금은 그대로.

### 7.5 위험과 소유자 결정

1. **대상 OS**: Windows 11 x64만 / Windows 10 22H2까지. Yogurt 근거로 10 2004 이상이면 앱별 소리도 된다. 10은 2025-10 지원 종료라 **11 x64 + 10 22H2 "되면 됨"**을 권한다.
2. **서명 없는 설치본 UX**: SmartScreen "Windows의 PC 보호" → `추가 정보` → `실행`을 설치 안내에 그림과 함께 넣을지, 미리보기부터 OV 인증서를 살지. Yogurt는 서명 없이 내고 있다. 서명 없이 내면 자동 업데이트 설치본도 같은 경고를 받는다.
3. **시험 장비**: Windows 실기기 없이 CI만으로는 블루투스 마이크·장치 바뀜·Defender 첫 실행 지연·실제 CPU 속도를 볼 수 없다. 최소 노트북 1대(Intel 또는 AMD, 16GB), 가능하면 NVIDIA 데스크톱 1대. 원격 기기 대여도 선택지.
4. **변환 런타임 선택 기준**: CER 허용 폭(예: MLX 대비 +1.0 이내?), RTF 상한(배치 0.5 이하?), onnxruntime 재도입(번들 크기) 허용 여부.
5. **Whisper 허용 여부**: 측정 결과 Qwen이 너무 느린 장비에 Whisper를 "저사양" 대안으로 둘지. Phase 0 탈락 결정을 뒤집는 일이라 소유자 결정.
6. **배포 리듬**: Windows 미리보기를 Mac과 같은 버전 번호로 낼지, 별도 태그로 낼지. 업데이트 `latest.json`에 Windows를 언제 넣을지.
7. **MIT 고지 방식**: 옮긴 Rust 파일마다 머리 주석 + NOTICE 항목(권장).

기타 위험: python-build-standalone Windows판 + wheel만(`--only-binary`)으로 mlx 없는 의존성 묶음을 따로 관리해야 함(`pyproject` 플랫폼 표지), site-packages 경로 260자, Windows 가상 음성(`say` 대체)으로 바뀌는 시험 기준, 사용자 Mac 가정 문구가 WORDS.md 곳곳에 있음.
