# Windows 지원 — 진행 현황과 인수인계

Mac에서 할 수 있는 준비(Stage 0)는 끝났고, 남은 일은 Windows 기기에서 한다. 이 문서는 Windows 기기에서 저장소를 받은 사람이 **여기만 보고 이어서 작업할 수 있게** 쓴다. 근거와 조사 기록은 [plan.md](plan.md)에 있다.

- **소유자 결정 (2026-11-13):** Windows는 조금씩 시작한다. Mac에서 할 수 있는 데까지만 Mac에서 하고, 나머지는 소유자가 Windows 기기에서 진행한다.
- **참고:** 경쟁 앱 Yogurt(FrigadeHQ/yogurt, MIT, Windows x64를 이미 배포)의 코드. 옮긴 코드는 파일 머리 주석과 [NOTICE](../../NOTICE) 12번에 출처를 남긴다.
- **변하지 않는 규칙:** ASR·화자 분리·검색의 런타임과 모델은 `bench/` 측정 없이 바꾸지 않는다(CLAUDE.md). macOS 동작은 Windows 작업 때문에 바뀌면 안 된다.

## 1. 한눈에 보기

| 구성 요소 | Mac에서 끝낸 것 (Stage 0) | Windows 기기에서 할 일 | 상태 |
| --- | --- | --- | --- |
| 녹음 프로그램 | `recorder/win/` Rust `tractus-rec.exe`. Swift판과 같은 계약, `--fake` 계약 시험, Windows 대상 컴파일 검사, CI 빌드·시험 (#110) | 실제 마이크·시스템 소리 녹음 확인 (W1) | 코드 있음, 실기기 미확인 |
| 코어 (Python) | 플랫폼 갈래 모듈로 `fcntl`·`fchmod`·`os.kill`·`sysconf` 정리, CI `windows-core.yml` (#109) | 남은 실패 시험 고치기 (W2) | 진행 중 |
| 앱 (Tauri, Rust) | `cfg` 갈래로 경로·하위 프로세스·클립보드·권한·언어 감지 정리, CI `windows-app.yml` (#111) | `pnpm tauri dev`로 창 띄우기, 녹음 연결 (W3) | 진행 중 |
| 텍스트 변환 (ASR) | Mac CPU에서 ONNX int4 Qwen3-ASR 측정 (CER 9.51, RTF 0.26, plan.md 6.1) | 후보 런타임을 Windows CPU에서 측정하고 고르기 (W4) | 결정 필요 |
| VAD·화자 분리·단어 정렬·검색 임베딩·목소리·실시간 자막 | — | 미리보기에서는 기능 잠금, Stage 2에서 하나씩 (W6) | 미착수 |
| 설치·업데이트 | — | NSIS per-user 설치본, Python 런타임 번들, 설치 후 스모크 (W5) | 미착수 |

PR 번호는 이 문서를 쓸 때의 것이다. 합쳐졌는지는 `git log --oneline -- recorder/win src/tractus/platform_compat.py`로 본다.

## 2. Mac에서 끝낸 것 (Stage 0)

### 2.1 Windows 녹음 프로그램 `recorder/win/` (#110)

- **계약은 Swift판과 같다** ([docs/desktop.md §1](../desktop.md)): `record`·`check`·`mic-permission`, stdout JSON Lines 이벤트, stdin 명령, `mic.wav`·`system.wav`(48 kHz mono 16-bit), `recording.json`. 그래서 앱과 코어는 이 프로그램을 macOS판처럼 부르면 된다.
- **분리 구조:**

  | 파일 | 운영체제 | 역할 |
  | --- | --- | --- |
  | `protocol.rs` | 공통 | stdin 명령·인수·메모·`recording.json`·이벤트 출력 |
  | `wav.rs` | 공통 | WAV 쓰기, 0.25초마다 헤더 갱신, 끊긴 구간 0으로 메우기 |
  | `meter.rs` | 공통 | 소리 크기(dBFS), 0만 오는 시스템 오디오 감지, float→16-bit |
  | `fake.rs` | 공통 | `--fake` 신호 (마이크 440 Hz, 시스템 660 Hz) |
  | `recorder.rs` | 공통 | 녹음 상태 기계 (Swift `Recorder.swift`와 같은 규칙) |
  | `gap.rs` | 공통(Windows만 씀) | loopback 무음 채우기 (Yogurt) |
  | `win.rs` | Windows | WASAPI 마이크, Tractus만 뺀 process loopback → 출력 전체, 장치 바뀜, QPC 시계 (Yogurt) |

- **Windows에서 다른 점:** 에코 제거가 없어 `--echo-cancel`은 경고 후 끈다. 시스템 오디오 권한이 없어 `system_zero` 감시를 끈다. 마이크 권한 창이 없어 `mic-permission`은 상태만 읽는다. `mic-apps`(통화 감지)·`calendar`는 없다.
- **확인한 것:** 단위 시험 13개. 계약 시험 2개(같은 명령을 Swift판과 Rust판 `--fake`에 넣어 이벤트 종류·키와 `recording.json`이 같은지 비교). Mac에서 `cargo check --target x86_64-pc-windows-msvc`. CI `windows-recorder.yml`에서 빌드·시험·VC++ 런타임 의존 없음·장치 없는 러너에서 계약대로 끝나는지.

### 2.2 코어 이식성 정리 (#109)

- **새 모듈 `src/tractus/platform_compat.py`:** 파일 잠금(`lock_file`·`unlock_file`: POSIX `fcntl.flock` / Windows `msvcrt.locking` 0번째 바이트), `restrict_to_owner`(POSIX 0600 / Windows 아무것도 안 함), `pid_alive`(POSIX `os.kill(pid, 0)` / Windows `OpenProcess`), `physical_memory`(POSIX `sysconf` / Windows `GlobalMemoryStatusEx`). macOS 동작은 그대로다.
- **바꾼 호출 지점:** `store.note_lock`·`edit_glossary`, `organize.folders_lock`, `sample_note.create`, `voices.profiles_lock`·`save_profiles`, `models_install.download_lock`·`lock_held`, `models_registry.physical_memory`, `paths.tool_bin`(Windows면 `.exe`).
- **주의:** Windows 잠금은 강제 잠금이다. 다른 프로세스가 잠긴 바이트를 읽으면 `PermissionError`가 난다. 잠금 파일에 내용을 쓰지 않는 지금 방식에서는 문제가 없지만, 잠근 파일을 다른 프로세스가 읽는 코드를 새로 만들면 확인한다.
- **`uv sync --locked`는 Windows에서도 된다** (mlx 0.32.3에 win_amd64 휠이 있다). 다만 `import mlx.core`는 DLL 로드에 실패한다.
- **Windows CI 첫 결과 (run 43354607376):** 777 통과 / 55 실패 / 123 오류. 전체 시험은 `continue-on-error`이고 실패 목록만 요약에 남긴다.

  | 원인 | 건수 | W2에서 할 일 |
  | --- | --- | --- |
  | 하위 프로세스 `FileNotFoundError` (`test_cli`·`test_deferred`·`test_attach`·`test_align`) | 121 | 러너에 ffmpeg가 없어서로 보인다. ffmpeg를 깔고 다시 돌려 원인을 확정한다 |
  | `mlx.core` DLL 로드 실패 (`test_asr`·`test_onnx_mlx`) | 19 | MLX 시험에 Windows skip 표시. MLX 대체는 W4 |
  | cp1252 인코딩 (`test_env`·`test_obsidian` 등) | 6 | `open()`에 `encoding="utf-8"`이 빠진 곳 찾기, 또는 `PYTHONUTF8=1` |
  | `.sh` 실행 `WinError 193` (`test_update_sh`·`test_plugin`) | — | macOS 전용 skip 표시 |
  | 0600 권한 검사 (`test_voices`·`test_integrity`) | — | Windows에서는 권한 검사를 건너뛰거나 ACL로 바꿀지 결정 |
  | macOS 경로 기대 (`~/Library/...`, `.app` 번들) | — | Windows 앱 데이터 폴더(`%APPDATA%`·`%LOCALAPPDATA%`)를 정하고 `paths.py`에 갈래 |
  | SIGTERM 종료 코드 130 (`test_models`) | — | Windows는 신호 대신 stdin `stop` |


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

macOS CI(`ci.yml`)는 그대로다. Windows CI가 실패해도 macOS 릴리스는 막지 않는다.

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
- [ ] 시스템 소리: 유튜브 등을 재생하며 `--no-mic` 없이 녹음했을 때 `system.wav`에 들어가는가.
- [ ] Tractus만 빼기: 앱에서 띄운 경우 Tractus 소리가 `system.wav`에 들어가지 않는가 (W3 이후 확인).
- [ ] 장치 바뀜: 녹음 중 헤드셋을 꽂고 빼면 `mic_restarted`·`system_restarted`가 나오고 두 WAV 길이가 같은가.
- [ ] 블루투스 헤드셋(통화 모드)에서 소리가 빨라지거나 끊기지 않는가 (Yogurt 이슈 #23·#27과 같은 증상).
- [ ] 일시정지·메모: `pause`·`memo 글`·`resume`·`stop` → `recording.json`의 `marks`·`pauses`.
- [ ] 1시간 녹음: 메모리가 늘지 않고 WAV 헤더가 맞는가.

문제를 고치면 `cargo test`(계약 시험 포함)가 계속 통과해야 한다.

### W2. 코어 시험을 Windows에서 통과시키기

```powershell
uv sync
uv run pytest -q
```

- [ ] `windows-core.yml`이 알려 준 실패 목록부터 고친다 (2.2 참고).
- [ ] 경로 길이 260자, 예약 파일 이름(`CON` 등), 줄바꿈(CRLF)에 걸리는 시험이 없는가.
- [ ] `tractus doctor --json`이 Windows에서 무엇을 "부족"으로 내는지 보고, 미리보기 범위에 맞게 고친다.

### W3. 앱을 Windows에서 띄우기

```powershell
cd app
pnpm install
pnpm tauri dev
```

- [ ] 창이 뜨고 노트 목록·메모 노트가 된다.
- [ ] 녹음 버튼이 `recorder\win\target\release\tractus-rec.exe`를 찾는다 (`paths.rs`의 Windows 갈래, 2.3 참고). 못 찾으면 설정 › 경로에서 직접 지정해 본다.
- [ ] 하위 프로세스가 콘솔 창을 띄우지 않는다 (`CREATE_NO_WINDOW`).
- [ ] 트레이 아이콘·녹음 미니 창·⌘ 단축키(Windows는 Ctrl)가 어떻게 보이는지 기록한다. 고칠 목록은 WORDS.md 규칙("이 Mac" 같은 플랫폼 문구)부터 정한다.

### W4. 텍스트 변환 런타임 고르기 (결정 필요)

후보와 측정 기준은 [plan.md 7.4절](plan.md#74-windows-변환-런타임-후보-고르기-전에-bench-측정-필수)에 있다. 순서는 다음을 권한다.

1. **A. Qwen3-ASR ONNX int4** (onnxruntime CPU). Mac CPU에서 이미 CER 9.51, RTF 0.26을 쟀다. Windows 보통 CPU(i5·Ryzen 5, 16GB)에서 같은 60발화를 다시 잰다.
2. **B. Qwen3-ASR ggml 이식본** (Vulkan). A와 같은 세트로 비교한다. 라이선스·성숙도부터 확인한다.
3. **C. Whisper (whisper.cpp)**는 마지막 수단이다. Phase 0 한국어 CER이 14.92로 Qwen 9.49보다 나쁘고, 사전(프롬프트)을 넣으면 더 나빠진다.

- [ ] 측정은 `bench/`로 하고 AI Hub 전사는 로컬에만 둔다(지표만 커밋).
- [ ] 고르면 `models_registry`에 플랫폼별 모델 항목을 더하고, 기능 잠금(`CAPABILITIES`)은 그대로 쓴다.
- [ ] onnxruntime을 다시 들이면(번들 약 75MB) 그 결정을 ARCHITECTURE.md에 남긴다(v3.99에서 뺐다).

### W5. 설치본과 "Windows 미리보기"

- [ ] Tauri NSIS `installMode: currentUser`, 서명 없음. 첫 실행의 SmartScreen 안내("추가 정보 → 실행")를 README에 넣는다.
- [ ] Windows용 Python 런타임(python-build-standalone) + wheel만으로 코어를 번들한다. MLX 의존성은 Windows에서 빠지게 한다.
- [ ] 설치본을 CI에서 실제로 설치하고 `tractus doctor`·`tractus-rec record --fake`·변환 한 번을 도는 스모크 (Yogurt `.github/workflows/preview.yml` "Install it" 참고).
- [ ] 업데이트 `latest.json`에 `windows-x86_64`를 넣을지는 미리보기 뒤에 정한다.

미리보기 범위: 녹음 → 변환(W4 런타임 하나) → 요약·질문(원격 AI) → 키워드 검색 → 내보내기. 화자 분리·단어 싱크·목소리·실시간 자막·로컬 스마트 검색·캘린더·통화 감지는 기능 잠금으로 막고 이유를 보인다.

### W6. 그 뒤 (Stage 2)

화자 분리 → 단어 정렬 → 로컬 검색 임베딩 → 목소리 → 실시간 자막 → 코드 서명 순서다. 하나씩 `bench/`로 다시 잰다(plan.md 7.3절).

## 5. 소유자가 정할 것

| 결정 | 권하는 답 | 근거 |
| --- | --- | --- |
| 대상 OS | Windows 11 x64 + Windows 10 22H2는 "되면 됨" | Yogurt 기준으로 Windows 10 2004 이상이면 앱별 소리 녹음이 된다 |
| 서명 | 미리보기는 서명 없이, SmartScreen 안내로 | Yogurt도 서명 없이 배포 중. OV 인증서는 비용이 든다 |
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
