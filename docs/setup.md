# 설치 안내

Tractus는 저장소를 내려받아 내 Mac에서 직접 빌드해 씁니다. 도구는 `scripts/bootstrap.sh`가, 코어·녹음 프로그램·앱 빌드는 `scripts/install.sh`가 맡고, 앱을 처음 열면 나오는 **시작 점검**에서 모델을 받습니다. 이 문서는 그 과정을 순서대로 안내합니다.

- 대상: 이 저장소를 내려받아 빌드할 수 있는 개발자
- 필요한 것: Apple Silicon Mac, macOS 14.4 이상, 디스크 여유 15GB, 인터넷(설치와 모델 받기에만 씀)
- `sudo`는 쓰지 않습니다. 스크립트는 인터넷에서 받은 스크립트를 실행하지도 않습니다.

## 1. 빠른 설치

명령 세 개입니다.

```bash
git clone https://github.com/sjoon21/Tractus.git && cd Tractus
scripts/bootstrap.sh      # 빌드 도구 준비 (Homebrew로 빠진 것만 설치)
scripts/install.sh        # 코어, 녹음 프로그램, 앱 빌드
```

| 명령 | 하는 일 | 걸리는 시간 |
| --- | --- | --- |
| `scripts/bootstrap.sh` | Xcode 명령줄 도구와 Homebrew를 확인하고, [Brewfile](../Brewfile)의 도구(Rust, Node.js, pnpm, uv, ffmpeg) 중 빠진 것만 설치한 뒤 `install.sh --check`로 마지막 점검을 합니다. 설치 전에 한 번 묻습니다 | 도구가 이미 있으면 몇 초, 설치가 필요하면 몇 분 (회선에 따라) |
| `scripts/install.sh` | `uv sync`, `swift build`, `pnpm install`, `pnpm tauri build`를 차례로 실행합니다 | 15~30분 (추정. 처음 Rust를 컴파일할 때) |
| 모델 받기 | 앱의 시작 점검에서 받습니다 ([§2](#2-앱을-처음-열었을-때)) | 5~20분 (추정. 구성과 회선에 따라) |

- **터미널을 새로 열 필요는 없습니다.** `bootstrap.sh`가 설치한 도구는 같은 터미널에서 바로 씁니다. 예외는 Xcode 명령줄 도구나 Homebrew를 이번에 처음 설치한 경우, 그리고 Homebrew가 PATH에 없어 `/opt/homebrew/bin/brew`로 찾은 경우입니다. 뒤의 경우 스크립트가 끝에 알려 주는 `eval "$(/opt/homebrew/bin/brew shellenv)"`를 먼저 실행합니다. 이때는 두 스크립트가 안내하는 대로 설치를 끝내고 터미널을 새로 연 뒤 `bootstrap.sh`를 다시 실행합니다.
- 막히면 스크립트가 무엇을 하면 되는지 한국어로 알려 주고 종료 코드 1로 멈춥니다. Xcode 명령줄 도구(`xcode-select --install`)와 Homebrew는 시스템 창이나 관리자 암호가 필요해서 스크립트가 대신 설치하지 않습니다.
- 이미 도구를 갖췄다면(rustup, nvm 등으로 PATH에 있어도 됩니다) `bootstrap.sh`는 건너뛰고 `scripts/install.sh --check`만 해 봐도 됩니다.
- 한 번에 이어서 하려면 `scripts/bootstrap.sh --yes --with-install`입니다.
- 아무것도 바꾸지 않고 상태만 보려면 `scripts/bootstrap.sh --check`, `scripts/install.sh --check`입니다.
- 모델까지 받고 앱을 `~/Applications`에 복사하려면 `scripts/install.sh --models standard --copy-app`입니다.

> **설치 뒤에는 저장소 폴더를 옮기거나 지우지 마세요.** 앱은 빌드한 저장소 안의 `.venv/bin/tractus`와 `recorder/.build/release/tractus-rec`를 실행합니다. 이 경로는 빌드할 때 앱에 들어갑니다. 폴더를 옮겼다면 `scripts/install.sh`를 새 위치에서 다시 실행합니다. 앱 설정에 경로를 이미 저장했다면 설정에서 `tractus`와 `tractus-rec` 경로도 새 위치로 고칩니다.

## 2. 앱을 처음 열었을 때

```bash
open app/src-tauri/target/release/bundle/macos/Tractus.app    # 또는 ~/Applications/Tractus.app
```

처음 열 때 "확인되지 않은 개발자" 경고가 나오면 [§5](#5-권한)를 봅니다. 순서는 시작 점검 → 모델 받기 → API 키입니다. 앞의 둘만 하면 녹음과 텍스트 변환은 됩니다.

### 시작 점검

처음 열면 **시작 점검**이 자동으로 나옵니다. 설정이나 첫 화면에서 언제든 다시 열 수 있습니다. 항목마다 통과·주의·막힘을 보여 주고, 막힌 항목에는 고치는 방법이 붙습니다.

| 구역 | 확인하는 것 |
| --- | --- |
| 시스템 | Apple Silicon, macOS 14.4 이상, 메모리, 디스크 여유 |
| 도구 | ffmpeg(없으면 `brew install ffmpeg` 안내와 `다시 확인`), 녹음 프로그램, 코어 위치 |
| 모델 | 필수 모델이 있는지, 표준·저사양·필수만 설치 버튼 |
| 권한 안내 | 마이크와 시스템 오디오 (macOS가 첫 녹음에서 묻습니다) |
| AI 요약·질문 | API 키를 넣었는지 |

점검은 앱 사용을 막지 않습니다. 모델이 없는 기능은 눌러 보면 이유와 설치 방법을 알려 줍니다.

터미널에서도 같은 점검을 할 수 있습니다.

```bash
uv run tractus doctor            # 사람이 읽는 요약
uv run tractus doctor --json     # 앱이 읽는 JSON
```

### 모델 받기

모델은 `~/Tractus/models`에 받습니다. 위치를 바꾸려면 앱 설정의 `변환 엔진 위치`나 환경변수 `TRACTUS_MODELS_DIR`을 씁니다. 저장소에 `.env`가 있으면 그 값을 따릅니다.

앱은 왼쪽 아래의 `모델` 화면에서 받고 지웁니다. 터미널에서는 다음 명령을 씁니다.

```bash
uv run tractus models list                          # 설치 상태 (--json 가능)
uv run tractus models download --preset standard    # 구성 하나를 통째로
uv run tractus models download diarizer aligner     # 모델 ID로 골라서
uv run tractus models remove aligner                # 하나 지우기
```

받다가 끊겨도 같은 명령을 다시 실행하면 이어 받습니다.

#### 모델 안내표

| ID | 이름 | 크기 | 수준 | 없으면 못 쓰는 기능 |
| --- | --- | --- | --- | --- |
| `vad` | 목소리 구간 감지 (Silero VAD v6) | 1.2MB | 필수 | 텍스트 변환, 실시간 텍스트 변환 |
| `asr-std` | 표준 변환 엔진 (Qwen3-ASR 1.7B) | 2.5GB | 필수 (표준 또는 저사양 중 하나) | 텍스트 변환 |
| `asr-lite` | 저사양 변환 엔진 (Qwen3-ASR 0.6B) | 1.0GB | 필수 (표준 또는 저사양 중 하나) | 텍스트 변환, **실시간 텍스트 변환 (표준 엔진이 있어도 이 모델이 따로 필요)** |
| `diarizer` | 참석자 구분 (Nemotron 3 Diarization) | 199MB | 권장 | 참석자 구분 (없으면 참석자 없이 변환) |
| `aligner` | 단어 싱크 (Qwen3 ForcedAligner 0.6B) | 1.3GB | 선택 | 단어 싱크 맞추기, 재생 중 단어 강조 |
| `embedding` | 스마트 검색 (Qwen3 Embedding 0.6B) | 1.2GB | 선택 | 스마트 검색 (키워드 검색은 그대로 됨) |
| `voices` | 참석자 목소리 (3D-Speaker CAM++) | 28MB | 선택 | 참석자 목소리 등록과 이름 제안 |
| `fluid` | 9명 이상 참석자 구분 (FluidAudio) | 22MB + 헬퍼 | 선택 | 9명 이상 참석자 구분 (없으면 8명까지) |

- 기능이 아닌 항목도 있습니다. **녹음**은 모델 없이 됩니다. 변환 엔진이 없으면 녹음만 저장하고 `변환 대기 중인 녹음`으로 남깁니다. 나중에 모델을 받으면 변환합니다.
- **요약과 AI 질문**은 모델이 아니라 API 키가 필요합니다 ([API 키](#api-키-넣기)).
- `fluid`는 모델 외에 헬퍼 `tractus-diar`가 필요합니다. `scripts/install.sh --with-fluid`로 빌드한 뒤 받습니다(Swift 6.2 이상 필요).
- 모델 라이선스는 [NOTICE](../NOTICE)에 있습니다.

#### 구성 추천

| 구성 | 담긴 모델 | 디스크 | 대상 |
| --- | --- | --- | --- |
| 표준 | 필수(표준 엔진) + 참석자 구분 + 단어 싱크 + 스마트 검색 + 목소리 | 약 5.2GB | 메모리 16GB 이상 (`--preset standard`) |
| 저사양 | 저사양 엔진 + 참석자 구분 | 약 1.2GB | 메모리 8GB, 다른 작업과 같이 쓸 때 (`--preset lite`) |
| 필수만 | `vad` + 메모리에 맞는 변환 엔진 하나 | 1.0~2.5GB | 우선 써 보고 나중에 더 받을 때 (`--preset required`) |
| 전부 | 위 모든 모델 (헬퍼가 있으면 `fluid` 포함) | 약 6.2GB | (`--preset all`) |

필수만 받아도 기본 흐름은 모두 됩니다: 녹음하거나 파일을 가져와 텍스트로 변환하고, API 키가 있으면 요약합니다.

### API 키 넣기

요약과 AI 질문은 LLM API를 부릅니다. 전송하는 것은 질문과 근거 텍스트뿐이고 오디오는 보내지 않습니다.

- **앱:** 설정 > AI 요약·질문에서 Upstage API 키를 붙여 넣습니다. 앱 설정 폴더에 저장되고 노트 폴더에는 쓰지 않습니다.
- **터미널:** 저장소 루트의 `.env.local`에 `UPSTAGE_API_KEY=...`처럼 넣습니다(git 제외). 다른 공급자는 [README](../README.md#요약결정-사항할-일)의 공급자 표와 `.env.example`을 봅니다.

키가 없어도 녹음, 변환, 검색, 내보내기는 모두 됩니다. 요약과 질문만 안 됩니다.

---

## 3. 요구 사항과 도구

| 항목 | 최소 | 권장 |
| --- | --- | --- |
| 칩 | Apple Silicon (M1 이상) | M1 Pro 이상 |
| macOS | 14.4 | 최신 버전 |
| 메모리 | 8GB | 16GB 이상 |
| 디스크 여유 | 15GB (빌드 산출물 약 2.5GB(추정) + 모델 최대 6.2GB) | 25GB |

- **최소 사양은 설계 기준이고 직접 돌려 보지는 못했습니다.** 8GB는 메모리 사용량 계산으로, macOS 14.4는 아래 Core Audio process tap의 하한으로 정했습니다. 개발 기기는 Apple M3, 16GB, macOS 26.6이고 설치 시간과 용량 숫자도 추정치입니다.
- 메모리 8GB에서는 저사양 구성(0.6B 모델)을 씁니다. 이 구성에서는 실시간 텍스트 변환(16GB 이상 필요)을 쓸 수 없습니다. 표준 구성(1.7B 모델)은 16GB 이상에서 권장합니다.
- Intel Mac은 지원하지 않습니다. 변환 모델이 MLX(Apple Silicon 전용)로 돌아갑니다.
- macOS 14.4는 시스템 오디오 녹음(Core Audio process tap)의 하한입니다.

### 도구

`scripts/bootstrap.sh`가 아래 도구를 확인하고 빠진 것을 Homebrew로 설치합니다. 직접 설치해도 됩니다.

| 도구 | 용도 | 설치 | 필수 |
| --- | --- | --- | --- |
| Xcode 명령줄 도구 (Swift 5.10 이상, Xcode 15.3. 개발 기기의 Swift 6.4·Xcode 27에서만 빌드 확인) | 녹음 프로그램 빌드 | `xcode-select --install` | 필수 |
| Swift 6.2 이상 (Xcode 26) | 9명 이상 참석자 구분 헬퍼(`tractus-diar`) 빌드 | Xcode 업데이트 | `--with-fluid`일 때만 |
| Homebrew | 아래 도구 설치 | <https://brew.sh>의 공식 설치 명령 | 도구를 직접 설치한다면 없어도 됨 |
| Rust (`cargo`) | 앱(Tauri) 빌드 | `brew install rust` (rustup으로 이미 있으면 그대로 씁니다) | 필수 |
| Node.js 22.12 이상 | 앱 화면 빌드 | `brew install node` | 필수 |
| pnpm | 앱 의존성 | `brew install pnpm` | 필수 |
| uv | 코어(Python) 설치 | `brew install uv` | 필수 |
| ffmpeg | 오디오 읽기, 파일 가져오기, 텍스트 변환 | `brew install ffmpeg` | 변환에 필수 |

- Swift가 낮으면 Xcode를 업데이트합니다. Xcode 15.3은 macOS 13.5 이상, Xcode 16은 14.5 이상, Xcode 26은 15.6 이상에서 설치됩니다. 명령줄 도구만으로는 최신 Swift가 없을 수 있습니다.
- Swift 6.2가 필요한 것은 `tractus-diar`뿐이고 별도 패키지(`recorder/diar/`)입니다. 이 헬퍼가 쓰는 FluidAudio가 요구해서 나눴습니다. 헬퍼 없이도 8명까지 참석자 구분은 됩니다.
- **ffmpeg는 앱에 넣지 않았습니다**(라이선스). 없어도 설치와 녹음은 됩니다. 텍스트 변환과 파일 가져오기는 ffmpeg가 있어야 합니다.
- `brew bundle --file Brewfile`로 한 번에 설치할 수도 있습니다. 다만 `bootstrap.sh`와 달리 rustup 같은 다른 방법으로 이미 깔린 도구도 Homebrew 것으로 따로 설치합니다.

## 4. 설치 스크립트

### `scripts/bootstrap.sh`

| 옵션 | 효과 |
| --- | --- |
| `--check` | 아무것도 설치하지 않고 상태만 보여 줍니다. `brew bundle check` 결과도 함께 보여 줍니다 |
| `--yes` | 설치 전 확인을 묻지 않습니다. 터미널이 아닌 곳(CI 등)에서는 이 옵션이 있어야 설치합니다 |
| `--with-install` | 준비가 끝나면 이어서 `scripts/install.sh`를 실행합니다 |

종료 코드: 0 준비됨, 1 막힌 항목(Xcode 도구·Homebrew 없음, 설치 실패 등), 2 옵션 오류.

### `scripts/install.sh`

`--check`는 아무것도 바꾸지 않습니다. ✓(통과), `!`(경고), ✗(막힘)를 보여 주고, 막힘이 있으면 종료 코드 1로 끝납니다. 도구가 빠졌다면 `scripts/bootstrap.sh`를 먼저 실행하라고 안내합니다.

스크립트는 같은 순서로 네 단계를 실행합니다. 여러 번 실행해도 안전합니다.

| 단계 | 명령 | 결과 |
| --- | --- | --- |
| 1 | `uv sync` | `.venv/bin/tractus` (코어) |
| 2 | `swift build -c release` (`recorder/`) | `recorder/.build/release/tractus-rec` (녹음 프로그램) |
| 3 | `pnpm install --frozen-lockfile` | 앱 의존성 |
| 4 | `pnpm tauri build --bundles app` | `app/src-tauri/target/release/bundle/macos/Tractus.app` |

| 옵션 | 효과 |
| --- | --- |
| `--with-fluid` | 9명 이상 참석자 구분 헬퍼도 빌드합니다. `recorder/diar/`에서 `swift build -c release`를 실행해 `recorder/diar/.build/release/tractus-diar`를 만듭니다. Swift 6.2 이상이 필요하고, 처음에는 FluidAudio를 받아 2~3분 더 걸립니다. 실패해도 나머지 설치는 계속됩니다 |
| `--models <구성>` | 끝에 모델을 받습니다. `required`, `standard`, `lite`, `all` 중 하나입니다 ([모델 받기](#모델-받기)) |
| `--copy-app` | 만든 앱을 `~/Applications/Tractus.app`으로 복사합니다 |

## 5. 권한

| 권한 | 언제 묻나 | 거부했을 때 |
| --- | --- | --- |
| 마이크 | 처음 녹음할 때 macOS가 묻습니다 | 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 Tractus를 켭니다 |
| 시스템 오디오 | 시스템 소리를 함께 녹음하는 모드로 처음 녹음할 때 | 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 켭니다 |

권한은 미리 확인할 수 없습니다. 시작 점검은 안내만 합니다. 대면 회의 기본 모드는 마이크만 씁니다.

### "확인되지 않은 개발자" 경고

직접 빌드한 앱은 ad-hoc 서명이라 Apple 공증을 받지 않았습니다. 빌드한 Mac에서 바로 열면 보통 경고가 없습니다. 다른 Mac으로 복사하거나 내려받은 앱을 열 때 경고가 나오면 둘 중 하나를 씁니다.

- macOS 14 이하: Finder에서 앱을 우클릭하고 `열기`를 고릅니다.
- macOS 15 이상: 앱을 한 번 열어 본 뒤 시스템 설정 > 개인정보 보호 및 보안 > `그래도 열기`를 고릅니다.
- 터미널에서 격리 속성을 지워도 됩니다: `xattr -dr com.apple.quarantine ~/Applications/Tractus.app` (`--copy-app`을 쓰지 않았다면 `app/src-tauri/target/release/bundle/macos/Tractus.app`)

## 6. 폴더 안내

| 무엇 | 어디에 |
| --- | --- |
| 노트(오디오, 대화 내용, 요약) | `~/Tractus/meetings/` (환경변수 `TRACTUS_HOME`으로 변경) |
| 자주 쓰는 단어, 목소리 등록 | `~/Tractus/glossary.md`, `~/Tractus/voices.json` |
| 검색 색인 | `~/Tractus/.tractus/` (지워도 노트에서 다시 만들어집니다) |
| 모델 | `~/Tractus/models/` (`TRACTUS_MODELS_DIR`) |
| 앱 설정, 저장한 API 키 | `~/Library/Application Support/dev.tractus.app/` |
| 코어·녹음 프로그램·헬퍼·앱 빌드 | 저장소 폴더 안 (`.venv`, `recorder/.build`, `recorder/diar/.build`, `app/src-tauri/target`) |

## 7. 업데이트

```bash
cd Tractus
git pull
scripts/install.sh          # 바뀐 부분만 다시 빌드합니다 (--with-fluid로 설치했다면 같은 옵션을 붙입니다)
```

앱이 켜져 있으면 끄고 실행합니다. 노트와 모델은 그대로 남습니다. 임베딩 모델이 바뀐 버전이면 검색 벡터를 다시 만듭니다(`uv run tractus index`).

## 8. 문제 해결

| 증상 | 확인하고 고치기 |
| --- | --- |
| `ffmpeg`가 없다고 나옴 | `brew install ffmpeg`(또는 `scripts/bootstrap.sh`) 뒤에 시작 점검에서 `다시 확인`을 누릅니다. 앱은 `/opt/homebrew/bin`, `/usr/local/bin`과 시스템 폴더에서 찾습니다. 다른 곳에 설치했다면 `/opt/homebrew/bin`에 링크를 만듭니다 |
| 변환 버튼이 눌리지 않고 이유가 나옴 | 변환 엔진이나 `vad`가 없는 것입니다. 안내의 `모델 설치`로 받습니다 |
| 모델이 `일부만 받음`으로 보임 | 받기가 중간에 끊긴 것입니다. 다시 받으면 이어 받습니다 (앱은 `이어 받기`) |
| 모델이 `손상`으로 보임 | 받은 파일이 깨진 것입니다. `uv run tractus models remove <ID>` 뒤에 `uv run tractus models download <ID>`로 다시 받습니다. 앱의 `다시 받기`는 이 두 단계를 한 번에 합니다 |
| 모델 받기가 중간에 멈춤 | 같은 명령을 다시 실행하면 이어 받습니다. 디스크 여유와 인터넷을 확인합니다 |
| 변환 중 앱이 느려지거나 메모리 오류가 남 | 다른 앱을 끄고, 8GB Mac은 저사양 구성으로 바꿉니다. 실시간 텍스트 변환은 메모리를 약 2GB 더 씁니다. 끄는 것을 권합니다 |
| 녹음 소리가 비어 있음 | 마이크 권한을 확인합니다 ([권한](#5-권한)). 시스템 소리가 비면 시스템 오디오 녹음 권한을 확인합니다 |
| 앱이 `tractus`나 `tractus-rec`를 실행할 수 없다고 함 | 저장소 폴더를 옮겼거나 빌드가 안 된 것입니다. 저장소에서 `scripts/install.sh`를 다시 실행하고, 설정의 경로가 저장소 안 파일을 가리키는지 확인합니다 |
| 요약이 `키가 없다`거나 `인증하지 못했다`고 나옴 | 설정 > AI 요약·질문에서 키를 다시 넣습니다 |
| `scripts/bootstrap.sh`가 Xcode 명령줄 도구나 Homebrew가 없다며 멈춤 | 이 두 가지는 스크립트가 대신 설치하지 않습니다. 화면에 나온 명령(`xcode-select --install`, brew.sh의 설치 명령)을 직접 실행한 뒤 다시 실행합니다 |
| 도구를 설치했는데 `command not found` | Homebrew를 방금 처음 설치했다면 터미널을 새로 엽니다(설치 끝에 나온 `Next steps` 두 줄도 따라 합니다). 그 밖에는 새 터미널이 필요 없습니다 |
| Node.js가 낮다고 나오는데 `brew install node`를 이미 함 | PATH에서 이전 버전(nvm 등)이 먼저 잡힌 것입니다. `which -a node`로 확인하고 앞선 쪽을 정리합니다 |
| `swift build`가 Swift 버전 오류를 냄 | `swift --version`을 확인합니다. 녹음 프로그램(`recorder/`)은 5.10 이상(Xcode 15.3), 9명 이상 구분 헬퍼(`recorder/diar/`)는 6.2 이상(Xcode 26)이 필요합니다. 헬퍼만 필요하지 않다면 `--with-fluid` 없이 설치합니다 |
| `tractus-diar` 빌드가 실패함 | 기본 기능에는 영향이 없습니다(참석자 구분은 8명까지). Swift 6.2 이상인지 확인하고 `cd recorder/diar && swift build -c release`로 다시 시도합니다. 처음에는 FluidAudio를 받으므로 인터넷이 필요합니다 |
| 설치 점검 결과를 다시 보고 싶음 | `scripts/bootstrap.sh --check`, `scripts/install.sh --check`, `uv run tractus doctor` |

## 9. 제거

```bash
rm -rf ~/Applications/Tractus.app                       # 복사했다면
rm -rf "$HOME/Library/Application Support/dev.tractus.app"   # 앱 설정과 저장한 API 키
rm -rf ~/Tractus/models                                 # 모델 (다시 받을 수 있음)
rm -rf <저장소 폴더>                                    # 코어, 녹음 프로그램, 앱 빌드
tccutil reset All dev.tractus.app                       # 권한 초기화 (선택)
```

**`~/Tractus/meetings/`에는 노트와 녹음이 들어 있습니다.** 이 폴더는 위 명령에 넣지 않았습니다. 필요 없다고 확인한 뒤에만 지우세요.
