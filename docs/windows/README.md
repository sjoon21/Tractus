# Windows 지원 — 진행 현황과 인수인계

Mac에서 할 수 있는 준비(Stage 0)는 끝났고, 남은 일은 Windows 기기에서 한다. 이 문서는 Windows 기기에서 저장소를 받은 사람이 **여기만 보고 이어서 작업할 수 있게** 쓴다. 근거와 조사 기록은 [plan.md](plan.md)에 있다.

- **소유자 결정 (2026-11-13):** Windows는 조금씩 시작한다. Mac에서 할 수 있는 데까지만 Mac에서 하고, 나머지는 소유자가 Windows 기기에서 진행한다.
- **참고:** 경쟁 앱 Yogurt(FrigadeHQ/yogurt, MIT, Windows x64를 이미 배포)의 코드. 옮긴 코드는 파일 머리 주석과 [NOTICE](../../NOTICE) 12번에 출처를 남긴다.
- **변하지 않는 규칙:** ASR·화자 분리·검색의 런타임과 모델은 `bench/` 측정 없이 바꾸지 않는다(CLAUDE.md). macOS 동작은 Windows 작업 때문에 바뀌면 안 된다.

## 1. 한눈에 보기

| 구성 요소 | Mac에서 끝낸 것 (Stage 0) | Windows 기기에서 할 일 | 상태 |
| --- | --- | --- | --- |
| 녹음 프로그램 | `recorder/win/` Rust `tractus-rec.exe`. Swift판과 같은 계약, `--fake` 계약 시험, Windows 대상 컴파일 검사, CI 빌드·시험 (#110) | 실제 마이크·시스템 소리 녹음 확인 (W1) | 코드 있음, 실기기 미확인 |
| 코어 (Python) | 플랫폼 갈래 모듈로 `fcntl`·`fchmod`·`os.kill`·`sysconf` 정리, CI `windows-core.yml` (#109). W2: Windows CI 0 실패 (2.2) | 실제 기기에서 `uv run pytest`·`tractus doctor` 확인 (W2 남은 항목) | CI 통과, 실기기 미확인 |
| 앱 (Tauri, Rust) | `cfg` 갈래로 경로·하위 프로세스·클립보드·권한·언어 감지 정리, CI `windows-app.yml` (#111) | `pnpm tauri dev`로 창 띄우기, 녹음 연결 (W3) | 진행 중 |
| 텍스트 변환 (ASR) | Mac CPU에서 ONNX 판 측정. 1.7B int8 판(`voyagar/Qwen3-ASR-1.7B-onnx-int8`)이 품질 기준 통과 (설계 8.6절). 등록 목록 Windows 갈래·onnxruntime win32 의존성 코드 준비(브랜치 `windows/registry-onnx`, v3.151, 측정 관문 결정 뒤 합침) | int8 판의 속도·메모리를 Windows CPU에서 재기 (W4) | Windows 측정 남음 |
| VAD·화자 분리·단어 정렬·검색 임베딩·목소리·실시간 자막 | VAD는 Silero ONNX로 등록(필수). 나머지는 등록 목록에 없어 코어가 `platform`으로 잠근다: 변환은 그 단계를 건너뛰고 경고 하나, `align`·`voices`·`live`는 종료 코드 2 (v3.151) | Stage 2에서 하나씩 (W6) | 코어 잠금 준비, 앱 화면 남음 |
| 설치·업데이트 | `scripts/build_windows_bundle.sh`(NSIS currentUser, python-build-standalone + wheel + `tractus-rec.exe`)와 CI 설치 스모크 `windows-bundle.yml` (2.9) | 실기기 설치·SmartScreen·Smart App Control 확인, 자동 업데이트는 다음 판 (W5) | CI 설치 스모크, 실기기 미확인 |

PR 번호는 이 문서를 쓸 때의 것이다. 합쳐졌는지는 `git log --oneline -- recorder/win src/tractus/platform_compat.py`로 본다.

## 2. Mac에서 끝낸 것 (Stage 0)

### 2.1 Windows 녹음 프로그램 `recorder/win/` (#110)

- **계약은 Swift판과 같다** ([docs/desktop.md §1](../desktop.md)): `record`·`check`·`mic-permission`, stdout JSON Lines 이벤트, stdin 명령, `mic.wav`·`system.wav`(48 kHz mono 16-bit), `recording.json`. 그래서 앱과 코어는 이 프로그램을 macOS판처럼 부르면 된다.
- **분리 구조:**

  | 파일 | 운영체제 | 역할 |
  | --- | --- | --- |
  | `protocol.rs` | 공통 | stdin 명령·인수·메모·`recording.json`·이벤트 출력 |
  | `wav.rs` | 공통 | WAV 쓰기, 0.25초마다 헤더 갱신, 끊긴 구간 0으로 메우기 |
  | `meter.rs` | 공통 | 소리 크기(dBFS), 0만 오는 시스템 오디오 감지, float→16-bit, 1분마다 트랙별 가장 큰 소리 진단 로그 |
  | `fake.rs` | 공통 | `--fake` 신호 (마이크 440 Hz, 시스템 660 Hz) |
  | `recorder.rs` | 공통 | 녹음 상태 기계 (Swift `Recorder.swift`와 같은 규칙), 장치 바뀜 알림 300ms 묶기 |
  | `gap.rs` | 공통(Windows만 씀) | loopback 무음 채우기 (Yogurt) |
  | `mix.rs` | 공통(Windows만 씀) | 출력 장치 여럿을 들린 시각대로 한 트랙으로 섞기 (Yogurt 1b016b0) |
  | `win.rs` | Windows | WASAPI 마이크, 시스템 소리(기본 출력 전체 + 다르면 기본 통신 장치, `TRACTUS_REC_LOOPBACK=process`면 Tractus만 뺀 process loopback), 장치 바뀜, QPC 시계, 연 장치 이름 로그 (Yogurt) |

- **시스템 소리 (0.6.0, Yogurt ff38a76·1b016b0):** 기본값은 기본 출력 장치 전체(endpoint loopback, Tractus 소리 포함)다. 기본 통신 장치(`eCommunications`, Teams가 통화 소리를 내는 곳)가 기본 출력과 다르면 그것도 열어 `mix.rs`로 섞는다. 파일은 그대로 `system.wav` 하나다. process loopback("Tractus를 뺀 모든 앱")은 `TRACTUS_REC_LOOPBACK=process`일 때만 쓴다: Yogurt에서 새 Teams 소리를 하나도 못 들은 기기가 있었다(#35, 기본 출력이 Jabra 헤드셋). 기본 출력·통신 장치·입력 장치가 바뀌면 알림을 300ms 묶어 그 트랙만 한 번 다시 연다(알림은 역할마다 따로 오고 블루투스 핸즈프리 전환 때 몰려 온다).
- **진단 로그 (stderr, 계약 이벤트는 그대로):** 연 장치의 이름(`마이크: …`, `시스템 오디오: 출력 전체 …: …`, `… 기본 통신 장치도 함께 …: …`)과 1분마다 트랙별 가장 큰 소리(`지난 60초 가장 큰 소리: 마이크 -12.5 dBFS, 시스템 오디오 -80.0 dBFS (상대 소리 없음)`, -57 dBFS 아래면 `상대 소리 없음`)를 남긴다. 장치 이름과 소리 크기뿐이고 녹음 내용은 남지 않는다. 앱이 이 줄을 파일로 남기는 것은 앱 로그 작업(0.6.0 계획 21번) 몫이다.
- **Windows에서 다른 점:** 에코 제거가 없어 `--echo-cancel`은 경고 후 끈다. 시스템 오디오 권한이 없어 `system_zero` 감시를 끈다. 마이크 권한 창이 없어 `mic-permission`은 상태만 읽는다. `mic-apps`(통화 감지)·`calendar`는 없다.
- **확인한 것:** 단위 시험 23개(Stage 0의 14개에 0.6.0 녹음 수정에서 섞기 7·알림 묶기 1·소리 로그 1을 더했다). 계약 시험 2개(같은 명령을 Swift판과 Rust판 `--fake`에 넣어 이벤트 종류·키와 `recording.json`이 같은지 비교). Mac에서 `cargo check --target x86_64-pc-windows-msvc`. CI `windows-recorder.yml`에서 빌드·시험·VC++ 런타임 의존 없음·장치 없는 러너에서 계약대로 끝나는지.

### 2.2 코어 이식성 정리 (#109)

- **새 모듈 `src/tractus/platform_compat.py`:** 파일 잠금(`lock_file`·`unlock_file`: POSIX `fcntl.flock` / Windows `msvcrt.locking` 0번째 바이트), `restrict_to_owner`(POSIX 0600 / Windows 아무것도 안 함), `pid_alive`(POSIX `os.kill(pid, 0)` / Windows `OpenProcess`), `physical_memory`(POSIX `sysconf` / Windows `GlobalMemoryStatusEx`). macOS 동작은 그대로다.
- **바꾼 호출 지점:** `store.note_lock`·`edit_glossary`, `organize.folders_lock`, `sample_note.create`, `voices.profiles_lock`·`save_profiles`, `models_install.download_lock`·`lock_held`, `models_registry.physical_memory`, `paths.tool_bin`(Windows면 `.exe`).
- **주의:** Windows 잠금은 강제 잠금이다. 다른 프로세스가 잠긴 바이트를 읽으면 `PermissionError`가 난다. 잠금 파일에 내용을 쓰지 않는 지금 방식에서는 문제가 없지만, 잠근 파일을 다른 프로세스가 읽는 코드를 새로 만들면 확인한다.
- **`uv sync --locked`는 Windows에서도 된다** (mlx 0.32.3에 win_amd64 휠이 있다). 다만 `import mlx.core`는 DLL 로드에 실패한다.
- **Windows CI 첫 결과 (run 43354607376):** 777 통과 / 55 실패 / 123 오류. 그때 전체 시험은 `continue-on-error`였다. W2(v3.139)부터는 실패하면 빨간색이다(필수 검사가 아니라 macOS 합치기·릴리스는 막지 않는다).

  | 원인 (W2에서 로그로 확인) | 건수 | W2에서 한 것 |
  | --- | --- | --- |
  | 러너에 ffmpeg가 없다: 가짜 음성을 만드는 픽스처의 `subprocess.run(["ffmpeg", …])`가 `FileNotFoundError` (`test_cli`·`test_deferred`·`test_attach`·`test_align`·`test_calendar_event`·`test_trio`) | 오류 119 + 실패 1 | `windows-core.yml`에 `choco install ffmpeg --version 9.0.2` (고정) |
  | ffmpeg 뒤에 드러남: `commands.pipeline._free_mlx`가 `mlx.core`를 무조건 불러와, 모델이 없어 화자 분리·정렬을 건너뛴 변환도 `ImportError`로 끝났다 | 80 | **코어 수정:** 불러오지 못하면 비울 MLX 버퍼도 없으므로 돌아간다 |
  | `mlx.core` DLL 로드 실패: 가짜 모델이어도 `mx.array`를 부른다 (`test_asr`·`test_onnx_mlx`·`test_live`) | 19 | `mac_only(NO_MLX)`로 건너뜀. MLX 대체는 W4 |
  | 줄바꿈: `store._write_atomic`이 텍스트 모드라 Windows에서 `\r\n`으로 써서 Obsidian sha256이 어긋났다(`edited`) | 5 | **코어 수정:** `newline="\n"`. `_write_atomic`으로 쓰는 파일(transcript·md·vtt·요약·Obsidian)은 Mac과 같은 바이트다. `memos.json`(`pipeline` `write_text`)·`.chunks.jsonl`(덧붙이기)·`models_install`·`voices`는 아직 텍스트 모드라 Windows에서 `\r\n`이다(JSON은 그대로 읽힌다) |
  | cp1252 기본 인코딩: 시험 코드의 `read_text()`·`write_text()` (`test_env`·`test_paths`·`test_bundle_slim`·`test_plugin`·`test_obsidian`) | 6 | 시험에 `encoding="utf-8"`. 코어의 파일 읽기·쓰기는 이미 utf-8이다(`PYTHONWARNDEFAULTENCODING=1`로 확인, 남은 곳은 ASCII뿐) |
  | bash·`#!` 스크립트 `WinError 193` (`test_update_sh` 7, `test_plugin` 실행기 6, `test_diarize` 가짜 fluid 도우미 6, `test_models` 1) | 20 | `mac_only`로 건너뜀: `update.sh`·`bin/tractus-mcp`는 bash, fluid 도우미 `tractus-diar`는 Swift·CoreML |
  | 0600·실행 비트 (`test_voices`·`test_integrity`·`test_cli`·`test_plugin`) | 4 | Windows에서는 권한 비트 검사만 뺀다. 나머지 검사는 돈다 |
  | `paths.APP_MODELS`가 `~/Library/Application Support/...` | 1 | `platform_compat.APP_MODELS`: Windows는 `%LOCALAPPDATA%\dev.tractus.app\models` (plan.md 7.2 관례, 설정은 `%APPDATA%`. `LOCALAPPDATA`가 비면 `~/AppData/Local`. 2026-11-19 권하는 안으로 진행) |
  | `tool_bin`의 `.app` 번들·`swift build` 기대 (`test_diarize`) | 2 | 건너뜀: fluid 도우미는 macOS 전용이다. **`tool_bin` 자체는 Windows에서도 `tractus-rec.exe`를 찾아야 하는데 그 배치 시험은 없다**(W3·W5 할 일) |
  | SIGTERM 종료 코드 130 (`test_models`) | 1 | 건너뜀. Windows 앱은 받기를 `taskkill /F /T`로 멈춘다(2.3, 받은 부분은 남는다). stdin `stop`은 만들지 않았다 |

- **W2 결과 (2026-11-19, 브랜치 `windows/w2-core-tests`):** run 44468214894 55 실패 / 784 통과 / 5 건너뜀 / 123 오류 → run 44479877128 **0 실패 / 921 통과 / 47 건너뜀**(늘어난 42개는 위 표의 `mac_only`). macOS는 965 통과 / 3 건너뜀(새 시험 1개, 새 건너뜀 없음). 건너뛸 시험은 `tests/conftest.py`의 `mac_only(이유)`로 함수마다 표시한다(`update.sh`만 파일 전체).
- **아직 안 본 것:** 실제 Windows 기기(이 결과는 `windows-latest` 러너뿐), `slow`·`llm`·`network` 시험, `tractus doctor --json`. 전체 시험 단계는 아직 `continue-on-error`다.


### 2.3 앱 이식성 정리 (#111)

- **하위 프로세스:** 새 `procs::command`를 6곳(calendar·calls·mcp·permissions·recording·settings)이 쓴다. Windows에서는 `CREATE_NO_WINDOW`로 콘솔 창을 띄우지 않는다.
- **경로 (`paths.rs`):** 번들은 실행 파일 옆 `runtime/bin/tractus.exe`·`bin/tractus-rec.exe`, 저장소 배치는 `.venv/Scripts/tractus.exe`·`recorder/win/target/release/tractus-rec.exe`를 찾는다. `~/`는 `USERPROFILE`로 푼다. Homebrew PATH 덮어쓰기는 macOS만.
- **macOS 전용으로 막은 것:** `pbcopy`·`osascript` 클립보드 대체(Windows는 webview 클립보드), `defaults` 언어 감지(Windows는 `LANG`, 없으면 한국어), 통화 감지(`calls.rs`).
- **Windows 갈래:** 받기 멈추기는 `taskkill /F /T`(받은 부분은 남는다), 트레이 경과 시간은 툴팁, 권한 열기는 마이크만 `ms-settings:privacy-microphone`.
- **키 파일:** 0600 권한은 `cfg(unix)`만. Windows는 `%APPDATA%` 폴더의 기본 권한에 맡긴다. ACL 좁히기·DPAPI는 Stage 1 전에 정한다(`shortcut:` 주석).
- **빌드:** `icons/icon.ico`를 더했다(Windows 리소스 빌드에 필요). `trash`의 `coinit_apartmentthreaded` 기능을 Windows에서만 켠다. 새 크레이트는 없다.
- **시험:** sh 스크립트·`/usr/bin/python3`·유닉스 신호·유닉스 경로를 쓰는 시험 25개는 `#[cfg(unix)]`로 뺐다. **이 25개가 다루는 프로세스 정지·kill 경로는 Windows에서 한 번도 돌지 않았다.**
- **Windows CI:** `windows-app.yml` 네 번째 실행에서 185 통과 / 0 실패. 고치다가 실제 버그 하나(`.venv/Scripts/`의 코어를 저장소 루트에서 실행하지 않던 것)도 잡았다.
- **W3에서 직접 볼 것:** 트레이(툴팁 갱신·왼쪽 클릭 팝오버·메뉴), WebView2와 클립보드, 창 제목줄(macOS 전용 설정), 콘솔 창이 정말 안 뜨는지, `taskkill` 받기 멈추기, `ms-settings` 열기, 휴지통(COM), 화면 언어(Windows 표시 언어를 읽지 않아 늘 한국어로 뜰 수 있다).


### 2.4 Windows CI

| 워크플로 | 돌리는 것 | 언제 |
| --- | --- | --- |
| `windows-recorder.yml` | `recorder/win` 빌드·시험·장치 없는 스모크 | `recorder/win/**` PR, 매주, 수동 |
| `windows-core.yml` | 코어 pytest (모델 없는 것) | `src/tractus/**` 등 PR, 매주, 수동 |
| `windows-app.yml` | `app/src-tauri` cargo check·test | `app/src-tauri/**` PR, 매주, 수동 |
| `windows-bundle.yml` | 설치본 만들기 → `/S` 설치 → 설치된 런타임으로 `doctor --json`·한글 제목 메모·`notes list`·`record --fake`·앱 20초 → 서명 없는 파일 수·가장 긴 경로·크기 요약 → `/S` 제거 뒤 앱 데이터 유지 확인 (2.9) | `windows/bundle-*` 브랜치 push, 번들 관련 경로 PR, 수동 |

macOS CI(`ci.yml`)는 그대로다. Windows CI가 실패해도 macOS 릴리스는 막지 않는다.

### 2.5 앱 기본기 (0.6.0 계획 15·16·18·19·20·22번, 브랜치 `windows/app-basics`)

- **화면의 운영체제 판별은 `app/src/platform.ts` 한 곳이다:** `isWindows()`는 userAgent(WebView2에는 `Windows`가 든다)로 가른다. 미리보기는 `/preview.html?os=windows`로 Windows 화면을 강제한다(`?os=mac`도 된다). 앞으로 단축키·문구 정리(계획 11번)도 이것을 쓴다.
- **앱 하나만 띄우기 (15):** `tauri-plugin-single-instance`(MIT/Apache-2.0)를 Windows에서만 붙인다(`[target.'cfg(windows)'.dependencies]`, `lib.rs`에서 맨 먼저 등록). 두 번째 실행은 뜨지 않고 기존 창을 `tray::show_main`으로 앞으로 가져온다(숨긴 창도 다시 보인다). macOS는 OS가 이미 하나만 띄우므로 붙이지 않는다: macOS 빌드에는 이 크레이트가 들어가지 않는다.
- **트레이 아이콘 (16):** macOS는 그대로 단색 템플릿(`tray-idle@2x`·`tray-recording@2x`). Windows는 템플릿 표시가 없어 검정 아이콘이 어두운 작업 표시줄에서 안 보이므로 컬러 앱 아이콘(`icons/32x32.png`), 녹음 중은 빨간 점을 얹은 `icons/tray/tray-win-recording.png`(32 px)다.
- **녹음 중에는 변환을 시작하지 않는다 (18):** `recordBusy.convertsWhileRecording`이 Windows면 실시간 텍스트 변환과 상관없이 녹음이 끝날 때까지 기다린다(int8 변환이 CPU 전 코어·6–7GB를 쓴다, 설계 asr-onnx.md 8.6). 파일 가져오기도 녹음이 끝날 때까지 기다린다(`jobSchedule.canStartImport`, macOS는 그대로 녹음 중에도 시작). 녹음을 시작할 때 돌던 변환 전 노트의 변환은 멈췄다가 녹음이 끝나면 이어서 한다(`pauseConvert`, macOS는 자막을 켰을 때만). 이미 돌던 바로 변환·가져오기는 멈추지 않는다. 기다리는 노트에는 `녹음이 끝나면 변환을 시작합니다`가 보인다. 변환 스레드 상한은 Windows 측정 뒤 다시 본다.
- **삭제 안내 경로 (19):** `remove.ts`·`lib.baseName`이 역슬래시 경로도 자른다. Windows 문구는 `되돌리려면 휴지통에서 ‘{폴더}’ 폴더를 복원하세요.`(WORDS.md §4.9). 확인 단추 `휴지통으로 이동`의 영어(`Move to Trash`)는 계획 11번에서 `Recycle Bin`으로 맞춘다.
- **렌더 오류 복구 화면 (20):** `ErrorBoundary.tsx`가 메인 창 전체를 감싼다. 렌더 오류가 나면 흰 창 대신 `화면을 그리지 못했습니다` + `다시 불러오기`(+ 접힌 `자세히`)를 보인다. 녹음 미니 창·메뉴 막대 팝오버에는 아직 없다.
- **업데이트 확인 끄기 (22):** `paths.rs` `update_available`이 macOS 번들일 때만 참이다(`latest.json`에 `darwin-aarch64`만 있다). Windows 설정의 업데이트 절에는 `Windows 판은 아직 앱 안에서 업데이트하지 않습니다. 새 버전은 소개 사이트에서 받으세요.` 한 줄만 보인다. 켜는 일은 W5의 `latest.json` 결정 뒤다.
- **Mac에서 확인 못 한 것:** Mac에서는 `ring` 빌드 스크립트가 MSVC 헤더를 요구해 앱의 Windows 대상 `cargo check`가 안 된다. 단일 실행 플러그인 호출은 macOS에서 잠깐 켜서 컴파일만 확인했고, Windows 컴파일은 `windows-app.yml`이 본다.

### 2.6 화면의 플랫폼 표기·단축키 (0.6.0 계획 11번, 브랜치 `windows/ui-platform-text`)

- **문구:** macOS 문구가 원본(`t()` 키)이고 Windows에서만 화면에 내기 직전에 바꾼다: 화면 `platform.forOs`(`t()`·`Kbd`), Rust `i18n.rs` `WINDOWS_WORDS`. `이 Mac` → `이 컴퓨터`, `메뉴 막대` → `알림 영역`, `brew install ffmpeg` → `winget install Gyan.FFmpeg`, 영어 `Trash` → `Recycle Bin`(표: WORDS.md §8). 끝내는 법은 앱 메뉴(⌘Q)가 없어 `알림 영역의 Tractus 아이콘에서 종료`로 따로 둔다. 코어는 ffmpeg·메모리 안내를 `platform_compat.WINDOWS`로 고르고 `doctor`가 `brew`를 내지 않는다. 시작 점검의 Apple Silicon·macOS 버전 줄은 Windows에서 `Windows` 행 하나로 바뀐다(2.7).
- **단축키:** `platform.isMod`가 macOS ⌘(`metaKey`), Windows Ctrl(`ctrlKey`)이다. ⌘K 팔레트·⌘N·⌘J·⌘F·⌘Z·메모 ⌘S·⌘Enter·⌘B/⌘I·패널 ⌘B/⌥⌘B가 모두 이것을 쓴다. 표기는 `Ctrl+K`·`Ctrl+Alt+B`.
- **창:** `titleBarStyle: Overlay`·`hiddenTitle`·`trafficLightPosition`은 macOS 전용이라 Windows는 기본 제목줄이 따로 생긴다. 화면 맨 위 52px 줄(창 끌기 자리, 패널 접기 단추)은 겹치는 것이 없어 그대로 둔다. 기기에서 보고 빈 띠가 거슬리면 Windows만 줄인다.
- **아직 macOS 문구인 것:** 권한(마이크·시스템 오디오)·캘린더 안내의 `시스템 설정 › 개인정보 보호 및 보안`(계획 13번에서 기능 잠금과 함께).

### 2.7 앱 쪽 등록 목록 반영·macOS 전용 기능 잠금 (0.6.0 계획 12·13번, 브랜치 `windows/ui-registry-locks`)

- **목록에서 만든다 (12):** 앱은 운영체제가 아니라 코어 등록 목록(`models list`·`doctor`)을 보고 그린다(설계 asr-onnx.md 4.4). `models.ts` `visiblePresets`: 목록에 `asr-lite`가 없으면 `저사양 구성 설치`, 표준이 더하는 기능 모델(참석자 구분·단어 싱크·스마트 검색·목소리)이 하나도 없으면 `표준 구성 설치`를 숨기고, 남은 단추가 하나면 그것을 강조한다. `presetIds`는 목록에 없는 ID를 내지 않는다(권장 트랙이 lite여도 `asr-lite`가 없으면 `asr-std`). 변환 엔진이 하나뿐이면 엔진 고르기·직접 추가를 그리지 않고 그 엔진을 `모델` 표에 둔다. 점검의 필수 모델 행은 엔진이 하나면 `변환 엔진 파일`, 목록에 없는 권장·선택 행은 없다. macOS 목록은 모두 있으므로 결과가 같다.
- **`platform` 잠금:** `caps.ts` `decide`가 `missing`의 `platform`을 맨 먼저 보고 이유만 낸다(`Decision.fix`가 `null`이면 고치는 단추를 그리지 않는다). 노트의 참석자 구분 안내도 보이지 않는다. 오류 코드 `platform`·`unsupported_platform`은 `lib.ts` `ERROR_TEXT`에 문장이 있고, 경고 `platform`은 건너뛴 단계 이름이 든 코어 문장을 그대로 보인다(WORDS.md §4.7).
- **메모리 경고:** Windows에서 `doctor.system.standard_recommended`가 false면 구성 단추 아래와 점검 메모리 행에 경고(변환 중 약 7GB, 막지 않음). 점검의 `Apple Silicon`·`macOS 14.4 이상` 행은 Windows에서 `Windows` 행 하나(코어 `problems`의 `unsupported_arch`·`windows_too_old`면 막힘)로 바뀐다.
- **macOS 전용 기능 (13):** 캘린더(설정 `캘린더` 섹션, 홈의 곧 시작하는 일정 카드, 이번 주 띠의 일정·`메모 준비`)는 Windows에서 숨기고 일정을 읽지 않는다(띠는 노트만, 빈 날 `노트가 없습니다`). Rust `calendar_next`·`calendar_week`는 캘린더가 꺼져 있으면 녹음 프로그램을 부르지 않는다. 통화 감지 설정 두 줄을 숨긴다(Rust `calls::start`가 macOS에서만 돈다). 9명 이상 구분(fluid)은 Windows 목록에 없어 모델 화면에 없고, 점검의 `9명 이상 구분 도구` 행도 숨긴다. Claude Code 플러그인(`plugins/tractus`, bash 실행기 `bin/tractus-mcp`)은 앱 화면에 설정이 없다: Windows에서 쓸 수 없다는 것은 docs/mcp.md 몫이고, 앱 안 검색 프로세스(`mcp.rs`, `tractus mcp`)는 그대로 돈다.
- **미리보기:** `/preview.html?os=windows`는 가짜 점검·모델 데이터도 Windows 목록 모양(vad·asr-std, 나머지 기능 `platform`, 메모리 15.7GB)으로 바꾼다.

### 2.8 하위 프로세스 정리·앱 로그·녹음 중 종료 확인 (0.6.0 계획 17·21·23번, 브랜치 `windows/proc-log-quit`)

- **하위 프로세스 트리 정리 (17):** 앱이 띄운 프로세스(`procs::spawn`)는 Windows에서 앱 전체에 하나인 Job Object(`KILL_ON_JOB_CLOSE`, `windows-sys` 0.61, 이미 `Cargo.lock`에 있던 크레이트)에 들어간다. 앱이 끝나면(작업 관리자의 강제 종료 포함) 코어(`tractus.exe` 실행기 → python)·실시간 텍스트 변환·검색 프로세스와 그 자손(ffmpeg)이 함께 끝난다. 남으면 업데이트·제거가 실패한다. **녹음 프로그램은 넣지 않는다**(stdin EOF로 스스로 WAV를 마무리해야 한다, macOS와 같다). 멈추기는 `procs::kill_tree` = `taskkill /F /T`(자손까지, 질문 멈추기·변환 멈추기·검색 정보 갱신 멈추기·연결 테스트 시간 초과·검색 프로세스 다시 띄우기·실시간 변환 정지 시간 초과). macOS는 지금처럼 `Child::kill`이다. 알려진 틈: 띄운 직후에 Job에 넣으므로 그 사이 몇 ms 안에 생긴 손자는 Job 밖이다(멈추기는 `taskkill /T`가 잡는다).
- **시험:** `cfg(unix)` 25개 가운데 정지·kill 경로를 sh 대신 시험 실행 파일 자신을 하위 프로세스로 띄우는 `procs::tests::test_child`로 다시 썼다. 두 OS에서 도는 것: JSON 줄 전달·종료 코드·stderr, kill·stop·정지 시간 초과(`procs`), 검색 정보 갱신 멈추기(`lib`), 연결 테스트 시간 초과(`llm_key`), 받기 멈추기(`models`). Windows에서만 도는 것: 멈추기가 손자까지 끝내는지, Job을 닫으면 자식·손자가 끝나는지. Mac에서는 앱 전체의 Windows 대상 `check`가 안 되므로 `procs.rs`·`applog.rs`만 작은 크레이트로 `cargo check --tests --target x86_64-pc-windows-msvc` 했다(통과). 실제로 도는지는 `windows-app.yml`이 본다.
- **앱 로그 (21):** `%APPDATA%\dev.tractus.app\logs\app.log`(+ `app.old.log`, 1 MB씩). 앱 진단, 실패한 하위 프로세스의 stderr 꼬리, 녹음 프로그램의 진단을 남기고 노트 문장·제목·이름·키·사용자 이름은 가린다(docs/desktop.md §3.10). macOS도 같은 파일을 쓴다.
- **녹음 중 종료 확인 (23):** 트레이 `종료`·창 닫기로 앱이 끝나려 할 때 녹음 중이면 창을 보이고 `녹음을 끝내고 종료할까요?`를 묻는다(macOS의 ⌘Q도 같다).

### 2.9 Windows 설치본 (v3.155)

- **만들기:** Windows(Git Bash)에서 `scripts/build_windows_bundle.sh [--out D] [--ffmpeg <폴더>]` → `dist/windows/Tractus_<버전>_x64-setup.exe`. 순서는 macOS `build_app_bundle.sh`와 같다: python-build-standalone `cpython-3.12.16+20261110` x86_64-pc-windows-msvc install_only(sha256 고정) → tkinter·테스트·pip 줄이기 → `uv export --frozen` wheel만(`--require-hashes`, `sys_platform` 표지는 번들 파이썬 기준) (win32 표지가 붙은 `onnxruntime==1.32.0`·`flatbuffers`도 여기서 들어간다, v3.151) → tractus wheel → `bundle_slim.py`(macOS와 같은 목록) → 표준 라이브러리·site-packages 전체 바이트코드(unchecked-hash) → 번들 파이썬으로 `tractus.cli`·`asr_onnx`·`onnxruntime` 불러오기 → `recorder/win` `tractus-rec.exe` → 경로 길이 → `pnpm tauri build --bundles nsis --config <파일>`. `bundle.resources`와 `installMode: currentUser`는 `--config`로만 합치고 `tauri.conf.json`에 고정하지 않는다. 서명·업데이트 아티팩트는 없다.
- **설치 폴더:** 기본 `%LOCALAPPDATA%\Tractus\`에 앱 실행 파일, `runtime\`(python.exe와 `Lib\site-packages`), `bin\tractus-rec.exe`, `uninstall.exe`. 앱은 코어를 `runtime\python.exe -I -B -u -X utf8 -m tractus.cli`로 띄운다(`paths.rs` `core_args`): pip 콘솔 스크립트 `tractus.exe`는 만든 곳의 파이썬 절대 경로를 품어 설치본에서는 쓸 수 없다. `-B`라 설치 폴더에 `__pycache__`를 쓰지 않는다. 코어 `paths.tool_bin`은 `sys.executable`이 `runtime\` 바로 아래면 `..\bin\`에서 녹음 프로그램을 찾는다. 설치본은 업데이트를 확인하지 않는다(`update_available`이 macOS 번들에서만 참, 2.5의 22번). 설정의 업데이트 절에는 Windows 안내 한 줄만 보인다.
- **제거:** `uninstall.exe`(또는 설정 › 앱)는 설치 폴더만 지운다. 앱 설정·키(`%APPDATA%\dev.tractus.app`)와 모델(`%LOCALAPPDATA%\dev.tractus.app\models`, 약 4GB)과 노트(`~\Tractus`)는 남는다(CI가 `/S` 제거 뒤 표시 파일로 확인). **주의:** Tauri 기본 제거 창의 `앱 데이터 삭제` 확인란을 사용자가 켜면 `%APPDATA%`·`%LOCALAPPDATA%`의 `dev.tractus.app`(모델·키·설정)을 지운다. 노트는 이 경우에도 남는다. 확인란을 없애려면 NSIS 템플릿을 따로 둬야 해서 미리보기에서는 그대로 둔다.
- **ffmpeg:** 넣지 않는다(LGPL 빌드를 넣을지는 소유자 결정 대기). `--ffmpeg <폴더>`는 `bin\`에 복사만 하고, 코어는 아직 `PATH`의 ffmpeg만 찾는다. 넣기로 정하면 앱이 하위 프로세스 `PATH` 앞에 `<설치 폴더>\bin`을 붙이고 NOTICE·`check_licenses`를 함께 본다.
- **CI 결과 (run 45962753053, 커밋 e407005, 2026-11-27, `windows-latest`):** 빌드 424초, 설치본 101.1MB, 설치 폴더 483.8MB·파일 14,455개. 서명 안 된 `.exe`·`.dll`·`.pyd` **240 / 247**(`.pyd` 210, `.dll` 22, `.exe` 8: 앱·`tractus-rec.exe`·`python.exe`·`python312.dll`·휠의 확장 모듈 전부). 가장 긴 경로는 러너에서 194자, 사용자 이름 20자를 가정하면 203자(`onnxruntime\tools\ort_format_model\…\__pycache__\…pyc`)이고 260자 이상은 0개. 설치된 런타임으로 `doctor --json`(녹음 프로그램을 `bin\tractus-rec.exe`로 찾음, `system.problems` 없음, ffmpeg 없음), 한글 제목 메모 만들기·목록, `record --fake`(started…stopped, `mic.wav`·`system.wav`·`recording.json`), 앱 20초(앱이 띄운 번들 `python.exe` 하위 프로세스: 이 run에서는 로그로 봤고, 지금은 스모크가 없으면 실패시킨다), `/S` 제거(설치 폴더에 남은 파일 0개, `%APPDATA%`·`%LOCALAPPDATA%\dev.tractus.app` 표시 파일 그대로)가 모두 통과했다.

## 3. Windows 기기 준비

| 도구 | 설치 | 확인 |
| --- | --- | --- |
| Git | `winget install Git.Git` | `git --version` |
| Visual Studio Build Tools (C++ 데스크톱 개발, Windows SDK) | `winget install Microsoft.VisualStudio.2022.BuildTools` 뒤 "C++를 사용한 데스크톱 개발" 선택 | `cl` (Developer PowerShell) |
| Rust (MSVC) | `winget install Rustlang.Rustup` → `rustup default stable-x86_64-pc-windows-msvc` | `cargo --version` |
| Node 22 + pnpm 11 | `winget install OpenJS.NodeJS.LTS` → `npm i -g pnpm@11` | `pnpm -v` |
| uv (Python 3.12) | `winget install astral-sh.uv` | `uv --version` |
| ffmpeg | `winget install Gyan.FFmpeg` | `ffmpeg -version` |
| WebView2 | Windows 11은 기본 설치 | — |

```powershell
git clone https://github.com/sjoon21/Tractus.git
cd Tractus
git clone https://github.com/FrigadeHQ/yogurt ..\yogurt   # 참고용 (plan.md의 `Y:` 경로). 실행하지 않아도 된다
```

## 4. Windows 기기에서 할 일 (순서대로)

### W1. 녹음 프로그램을 실제 장치로 확인

```powershell
cd recorder\win
cargo test
cargo build --release
.\target\release\tractus-rec.exe check            # {"mic":"granted","system":"ok|zero","os":"windows"}
.\target\release\tractus-rec.exe record --out $env:TEMP\rec1 --no-system   # 몇 초 말한 뒤 stop 입력하고 Enter
```

- [ ] `check`: 마이크가 `granted`인가. 설정 › 개인정보 › 마이크에서 "데스크톱 앱 접근"을 끄면 `denied`인가.
- [ ] 마이크만 녹음: `mic.wav`가 재생되고, `level` 이벤트의 `mic`가 말할 때 올라가는가.
- [ ] 시스템 소리: 유튜브 등을 재생하며 `--no-mic` 없이 녹음했을 때 `system.wav`에 들어가는가. stderr의 `시스템 오디오: 출력 전체 …: <장치 이름>`이 실제 출력 장치인가.
- [ ] **새 Teams·Zoom 통화의 상대 목소리**가 `system.wav`에 들어가는가 (기본값 = 출력 전체, Yogurt #35). 1분마다 나오는 `지난 60초 가장 큰 소리` 줄에 통화 중인데 `상대 소리 없음`이 찍히지 않는가.
- [ ] **헤드셋이 기본 통신 장치이고 스피커가 기본 출력일 때**(소리 설정 › 장치 › "기본 통신 장치로 설정"): stderr에 `기본 통신 장치도 함께 녹음해 섞습니다: <헤드셋 이름>`이 나오고, Teams 상대 목소리와 스피커로 튼 유튜브가 둘 다 `system.wav` 한 파일에 들어가는가. 두 장치가 같으면 이 줄이 없고 한 번만 녹음되는가(소리가 두 겹이 아닌가).
- [ ] `TRACTUS_REC_LOOPBACK=process`로 띄우면 `Tractus를 뺀 모든 앱 (process loopback)`이 나오고 앱(W3 이후)의 소리가 `system.wav`에 들어가지 않는가. 기본값에서는 Tractus 소리도 들어간다(의도한 것).
- [ ] 장치 바뀜: 녹음 중 헤드셋을 꽂고 빼면 `mic_restarted`·`system_restarted`가 **바뀜마다 한 번씩만** 나오고(알림 300ms 묶기) 두 WAV 길이가 같은가. 기본 통신 장치만 바꿔도 `system_restarted`가 나오는가.
- [ ] 블루투스 헤드셋(통화 모드)에서 소리가 빨라지거나 끊기지 않는가 (Yogurt 이슈 #23·#27과 같은 증상). 핸즈프리로 바뀔 때 `_restarted`가 연달아 쏟아지지 않는가 (Yogurt #152).
- [ ] 일시정지·메모: `pause`·`memo 글`·`resume`·`stop` → `recording.json`의 `marks`·`pauses`.
- [ ] 1시간 녹음: 메모리가 늘지 않고 WAV 헤더가 맞는가.

문제를 고치면 `cargo test`(계약 시험 포함)가 계속 통과해야 한다.

### W2. 코어 시험을 Windows에서 통과시키기

```powershell
uv sync
uv run pytest -q
```

- [x] `windows-core.yml`이 알려 준 실패 목록부터 고친다 (2.2 참고, 2026-11-19 CI 0 실패).
- [ ] 경로 길이 260자, 예약 파일 이름(`CON` 등), 줄바꿈(CRLF)에 걸리는 시험이 없는가. (CRLF: `_write_atomic`을 고쳤다. 260자·예약 이름은 아직 안 봤다)
- [ ] `tractus doctor --json`이 Windows에서 무엇을 "부족"으로 내는지 보고, 미리보기 범위에 맞게 고친다. (`doctor.system()`의 Windows x64·빌드 19041+ 점검과 `winget install Gyan.FFmpeg` 안내까지는 반영됨. 실제 기기 실행 확인 남음)

### W3. 앱을 Windows에서 띄우기

```powershell
cd app
pnpm install
pnpm tauri dev
```

- [ ] 창이 뜨고 노트 목록·메모 노트가 된다.
- [x] 코어 `paths.tool_bin`도 `tractus-rec.exe`를 찾는다(`.exe`, `recorder/win/target/release`). (`doctor.recorder_bin()`이 Windows에서 `recorder/win/target/release/tractus-rec`를 넘기고 `test_paths.py`에 Windows 배치 시험을 더함, 2026-11-25)
- [ ] 녹음 버튼이 `recorder\win\target\release\tractus-rec.exe`를 찾는다 (`paths.rs`의 Windows 갈래, 2.3 참고). 못 찾으면 설정 › 경로에서 직접 지정해 본다.
- [ ] 하위 프로세스가 콘솔 창을 띄우지 않는다 (`CREATE_NO_WINDOW`).
- [x] 코어 표준 입출력은 Windows에서도 UTF-8이다(2026-11-25, v3.145): 앱은 `PYTHONIOENCODING=utf-8`을 주고, 코어가 시작할 때 `platform_compat.utf8_stdio()`로 다시 맞춘다(번들 파이썬 `-I`는 환경변수를 보지 않는다). 기기에서 볼 것: 한국어 제목 노트를 만들고 목록·검색에 제목이 깨지지 않는가.
- [ ] 2.5의 앱 기본기: 앱을 두 번 실행하면 창이 하나만 남고 앞으로 오는가(창을 닫아 트레이에 숨긴 상태에서도), 트레이 아이콘이 밝은·어두운 작업 표시줄 모두에서 보이고 녹음 중 빨간 점으로 바뀌는가(125%·150% 배율에서 흐리지 않은가), 녹음 중에 변환 전 노트의 변환이 기다리는가, 노트 삭제 창의 폴더 이름과 휴지통 `복원`이 맞는가, 설정의 업데이트 절에 확인 단추가 없는가.
- [ ] 회사망 HTTPS 검사: 코어는 시작할 때 `truststore.inject_into_ssl()`로 OS 인증서 저장소를 믿는다(`env.trust_system_certificates`, CLI 콜백·MCP 시작). 기기에서 볼 것: 사내 루트 인증서가 있는 망(또는 mitmproxy 루트를 `신뢰할 수 있는 루트 인증 기관`에 넣은 상태)에서 모델 받기·AI 연결 테스트가 되는가. Tauri 업데이터(reqwest)는 따로 확인한다.
- [ ] 트레이 아이콘·녹음 미니 창이 어떻게 보이는지 기록한다.
- [ ] 2.6의 단축키: Ctrl+K·Ctrl+N·Ctrl+J·Ctrl+F·Ctrl+B·Ctrl+Alt+B가 앱 동작을 하고 WebView2 기본 동작(Ctrl+N 새 창, Ctrl+F 페이지 찾기, Ctrl+J 다운로드 등)이 뜨지 않는가. 한국어 IME 상태에서도 같은가. 메모 입력창 Ctrl+S·Ctrl+Enter·Ctrl+B/I. 화면 문구에 `Mac`·`⌘`·`메뉴 막대`가 남지 않았는가(설정·시작 점검·모델·삭제 창). 제목줄 아래 52px 윗줄이 어색하지 않은가.
- [ ] 2.8: 변환·질문 중에 앱을 트레이 `종료`로 끝내고, 작업 관리자로도 강제 종료해 본 뒤 `tractus.exe`·`python.exe`·`ffmpeg.exe`가 남지 않는가. 녹음 중 종료는 묻고, `녹음 끝내고 종료` 뒤 `tractus-rec.exe`가 스스로 끝나며 다음 실행에 `변환 대기 중인 녹음`이 보이는가(WAV가 재생되는가). `%APPDATA%\dev.tractus.app\logs\app.log`에 사용자 이름·노트 제목이 없는가. Windows 종료·로그오프 중에 녹음하고 있으면 묻는 창이 종료를 막지 않는가.

### W4. 텍스트 변환 런타임 고르기 (결정 필요)

후보와 측정 기준은 [plan.md 7.4절](plan.md#74-windows-변환-런타임-후보-고르기-전에-bench-측정-필수)에 있다. 순서는 다음을 권한다.

1. **A. Qwen3-ASR ONNX int4** (onnxruntime CPU). Mac CPU에서 이미 CER 9.51, RTF 0.26을 쟀다. Windows 보통 CPU(i5·Ryzen 5, 16GB)에서 같은 60발화를 다시 잰다.
2. **B. Qwen3-ASR ggml 이식본** (Vulkan). A와 같은 세트로 비교한다. 라이선스·성숙도부터 확인한다.
3. **C. Whisper (whisper.cpp)**는 마지막 수단이다. Phase 0 한국어 CER이 14.92로 Qwen 9.49보다 나쁘고, 사전(프롬프트)을 넣으면 더 나빠진다.

- [x] A의 어댑터(설계 [docs/design/asr-onnx.md](../design/asr-onnx.md) 9절 1번 PR, v3.141): `asr_onnx`·`vad_onnx`, 모델 폴더 표지 파일로 가르기, Qwen에 numpy 넘기기(`test_asr`의 Qwen 시험이 Windows에서 돈다), `runtime_missing`. 등록·의존성은 아직이라 사용자에게 보이지 않는다.
- [ ] 측정은 `bench/`로 하고 AI Hub 전사는 로컬에만 둔다(지표만 커밋).
- [x] Mac 품질 측정(설계 9절 2번 PR, v3.142, 결과는 설계 8.5절): 1.7B int4는 AI Hub CER을 통과하지만 용어 재현율·HiKE 언어 고정에서 떨어지고, 0.6B int4는 모든 세트에서 떨어진다. M3 CPU RTF는 1.7B 0.19–0.29. 남은 것: 판 고르기(설계 11절 10·11번)와 Windows 기준 기기의 속도·메모리.
- [x] 더 정밀한 판(설계 8.6절, 2026-11-25): 같은 원본 디코더를 8bit(accuracy_level 4)로 다시 양자화해 `voyagar/Qwen3-ASR-1.7B-onnx-int8`에 올렸다. HiKE 전체 MER +0.64, AI Hub CER −0.03·용어 같음, FLEURS every8 같음으로 품질 기준을 모두 넘는다. 최대 메모리는 6.1–7.2GB로 6GB 기준을 넘는다. 0.6B는 Windows 목록에 두지 않는다. 남은 것: Windows 기준 기기의 속도·메모리, 등록 목록 갈래.
- [x] (코어, 브랜치 `windows/registry-onnx`, v3.151) `models_registry`의 `_mac_models`/`_windows_models`, 기능 잠금 `platform`, 파이프라인 단계 건너뛰기, 권하는 엔진·구성을 목록으로(`preferred_asr`·`pick_asr`·`preset_ids`·`engines`). 합치는 것은 측정 관문 결정 뒤. 앱 구성 단추·엔진 고르기·`caps.ts`는 앱 PR에서.
- [x] onnxruntime은 win32 표지로만 들였다(`onnxruntime==1.32.0; sys_platform == 'win32'`, v3.151). macOS 번들에는 들어가지 않는다(v3.99 규칙은 macOS에 그대로).

### W5. 설치본과 "Windows 미리보기"

- [x] Tauri NSIS `installMode: currentUser`, 서명 없음 (`scripts/build_windows_bundle.sh`, 2.9절, v3.155).
- [ ] 첫 실행의 SmartScreen 안내("추가 정보 → 실행")와 Smart App Control·회사 WDAC 기기에서 서명 없는 `.dll`·`.pyd`가 막힐 수 있다는 안내를 README에 넣는다(5절 서명).
- [x] Windows용 Python 런타임(python-build-standalone 3.12.16) + wheel만으로 코어를 번들한다. `mlx`는 Windows 휠이 있어 그대로 들어간다(불러오지 않는다). 빼는 것은 의존성 표지를 바꿀 때 함께 본다.
- [x] 설치본을 CI에서 실제로 설치하고 `tractus doctor`·한글 제목 메모·`tractus-rec record --fake`·앱 20초·제거를 도는 스모크 (`windows-bundle.yml`, Yogurt `preview.yml` "Install it" 참고). **변환 한 번은 아직**: 모델 받기가 들어간 측정 워크플로가 따로 있어 다음 단계에서 붙인다.
- [ ] 실기기: 설치 → SmartScreen → 첫 실행(Defender 첫 검사 시간) → 녹음·변환 → 제거·다시 설치(남은 python·tractus-rec 프로세스가 막지 않는지).
- [ ] 업데이트 `latest.json`에 `windows-x86_64`를 넣을지는 미리보기 뒤에 정한다.

미리보기 범위: 녹음 → 변환(W4 런타임 하나) → 요약·질문(원격 AI) → 키워드 검색 → 내보내기. 화자 분리·단어 싱크·목소리·실시간 자막·로컬 스마트 검색·캘린더·통화 감지는 기능 잠금으로 막고 이유를 보인다.

### W6. 그 뒤 (Stage 2)

화자 분리 → 단어 정렬 → 로컬 검색 임베딩 → 목소리 → 실시간 자막 → 코드 서명 순서다. 하나씩 `bench/`로 다시 잰다(plan.md 7.3절).

## 5. 소유자가 정할 것

| 결정 | 권하는 답 | 근거 |
| --- | --- | --- |
| 대상 OS | Windows 11 x64 + Windows 10 22H2는 "되면 됨" | Yogurt 기준으로 Windows 10 2004 이상이면 앱별 소리 녹음이 된다 |
| 서명 | 미리보기는 서명 없이, SmartScreen 안내로. 정식판 전에 서명 방법을 정한다 | OV 인증서는 비용이 든다. Yogurt는 2026-11-17부터 Azure Artifact Signing으로 서명하고(`5a16c3a`·`c80bd7a`), Code Integrity가 서명 없는 DLL을 막은 #99 뒤로 DLL·네이티브 모듈까지 모두 서명한다(`20674b9`, SmartScreen 안내는 `f559f4f`에서 지움). **Smart App Control·회사 WDAC 기기에서는 서명 없는 `.dll`·`.pyd`가 막혀 앱이 뜨지 않을 수 있다.** Tractus 설치본의 서명 없는 파일 수는 `windows-bundle.yml` 잡 요약에 나온다 |
| 시험 장비 | 노트북 1대(16GB) 이상, 가능하면 NVIDIA 데스크톱 | CI로는 블루투스·장치 바뀜·실제 속도를 못 본다 |
| 변환 런타임 기준 | MLX 대비 CER +1.0 이내, 배치 RTF 0.5 이하 | 숫자는 W4 측정 뒤 다시 본다 |
| Whisper 허용 | 저사양 마지막 수단으로만 | Phase 0 탈락 결정을 뒤집는 일이다 |
| 배포 리듬 | Mac과 같은 버전 번호, 릴리스에 Windows 파일을 "미리보기"로 함께 | 업데이트 `latest.json`은 나중에 |

## 6. 작업 규칙

- Windows 작업은 `windows/` 접두어 브랜치(예: `windows/w1-recorder-devices`)에서 하고 PR로 main에 합친다. macOS 동작이 바뀌는 변경은 macOS CI(`ci.yml`)가 통과해야 한다.
- 플랫폼 갈래는 한 곳에 모은다. 코어는 `src/tractus/platform_compat.py`, 앱은 `cfg(windows)`/`cfg(target_os = "macos")`, 녹음 프로그램은 `recorder/win`과 `recorder/`(Swift)로 나눈다.
- 녹음 프로그램의 계약을 바꾸면 Swift판·Rust판·docs/desktop.md §1·계약 시험(`recorder/win/tests/contract.rs`)을 함께 고친다.
- Yogurt에서 코드를 더 옮기면 파일 머리 주석과 NOTICE 12번에 파일을 적는다.
- 결정과 측정 결과는 ARCHITECTURE.md 변경 기록과 이 문서의 1절 표에 남긴다.
