# 설치 안내

**한국어** · [English](en/setup.md)

Tractus는 저장소를 내려받아 내 Mac에서 직접 빌드해 씁니다. 도구는 `scripts/bootstrap.sh`가, 코어·녹음 프로그램·앱 빌드는 `scripts/install.sh`가 맡고, 앱을 처음 열면 나오는 **시작 점검**에서 모델을 받습니다. 이 문서는 그 과정을 순서대로 안내합니다.

- 대상: 이 저장소를 내려받아 빌드할 수 있는 개발자
- 빌드 없이 쓰려면 [GitHub 릴리스](https://github.com/sjoon21/Tractus/releases)의 미리 만든 앱(`.dmg`)을 받습니다: [§10](#10-미리-만든-앱-받기)
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
| `scripts/install.sh` | `uv sync`, `swift build`, `pnpm install`, `pnpm tauri build`를 차례로 실행하고, 끝에 `tractus doctor` 점검을 보여 줍니다 | 약 5분 (실측: Apple M3·16GB, 깨끗한 복사본에서 `--with-fluid`까지 5분 17초, 2026-10-15. 회선에 따라 달라집니다) |
| 모델 받기 | 앱의 시작 점검에서 받습니다 ([§2](#2-앱을-처음-열었을-때)) | 5~20분 (추정. 구성과 회선에 따라) |

- **터미널을 새로 열 필요는 없습니다.** `bootstrap.sh`가 설치한 도구는 같은 터미널에서 바로 씁니다. 예외는 Xcode 명령줄 도구나 Homebrew를 이번에 처음 설치한 경우, 그리고 Homebrew가 PATH에 없어 `/opt/homebrew/bin/brew`로 찾은 경우입니다. 뒤의 경우 스크립트가 끝에 알려 주는 `eval "$(/opt/homebrew/bin/brew shellenv)"`를 먼저 실행합니다. 이때는 두 스크립트가 안내하는 대로 설치를 끝내고 터미널을 새로 연 뒤 `bootstrap.sh`를 다시 실행합니다.
- 막히면 스크립트가 무엇을 하면 되는지 한국어로 알려 주고 종료 코드 1로 멈춥니다. Xcode 명령줄 도구(`xcode-select --install`)와 Homebrew는 시스템 창이나 관리자 암호가 필요해서 스크립트가 대신 설치하지 않습니다.
- 이미 도구를 갖췄다면(rustup, nvm 등으로 PATH에 있어도 됩니다) `bootstrap.sh`는 건너뛰고 `scripts/install.sh --check`만 해 봐도 됩니다.
- 한 번에 이어서 하려면 `scripts/bootstrap.sh --yes --with-install`입니다.
- 아무것도 바꾸지 않고 상태만 보려면 `scripts/bootstrap.sh --check`, `scripts/install.sh --check`입니다.
- 모델까지 받고 앱을 `~/Applications`에 복사하려면 `scripts/install.sh --models standard --copy-app`입니다.
- 새 버전으로 올리려면 `scripts/update.sh`, 쌓인 빌드 산출물을 지우려면 `scripts/clean.sh`입니다 ([§7](#7-업데이트), [디스크 사용량](#디스크-사용량)).

> **설치 뒤에는 저장소 폴더를 옮기거나 지우지 마세요.** 앱은 빌드한 저장소 안의 `.venv/bin/tractus`와 `recorder/.build/release/tractus-rec`를 실행합니다. 이 경로는 빌드할 때 앱에 들어갑니다. 폴더를 옮겼다면 `scripts/install.sh`를 새 위치에서 다시 실행합니다. 설정의 `tractus`·`tractus-rec` 경로는 기본이 `자동`이라 실행할 때마다 찾으므로 직접 고칠 필요가 없습니다. 예전에 직접 저장한 경로가 없어졌다면 앱이 자동으로 되돌리고 시작 점검에 `저장된 경로가 없어 자동 경로를 씁니다`라고 알립니다. 다른 위치의 실행 파일을 쓰려면 설정에서 `직접 지정`을 고르고 `찾아보기…`로 고릅니다.

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
| 권한 안내 | 마이크와 시스템 오디오 (macOS가 첫 녹음에서 묻습니다). 캘린더는 설정에서 연결할 때만 묻습니다 |
| AI 요약·질문 | API 키를 넣었는지 |

점검은 앱 사용을 막지 않습니다. 모델이 없는 기능은 눌러 보면 이유와 설치 방법을 알려 줍니다.

터미널에서도 같은 점검을 할 수 있습니다.

```bash
uv run tractus doctor            # 사람이 읽는 요약
uv run tractus doctor --json     # 앱이 읽는 JSON
```

### 모델 받기

모델은 `~/Library/Application Support/dev.tractus.app/models`에 받습니다(노트 폴더와 iCloud 동기화 밖입니다). 예전에 `~/Tractus/models`에 모델을 받았다면 그 폴더를 그대로 씁니다. 위치를 바꾸려면 앱의 `모델` 화면에서 `위치 바꾸기…`를 누르거나(설치한 모델을 새 폴더로 함께 옮깁니다), 터미널에서 `uv run tractus models move <폴더>`를 실행하거나, 환경변수 `TRACTUS_MODELS_DIR`을 씁니다. 저장소에 `.env`가 있으면 그 값을 따릅니다. 모델 목록에 없는 옛 폴더는 `모델` 화면의 `사용하지 않는 폴더 정리`(터미널은 `uv run tractus models prune`)로 지웁니다.

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
| `asr-std` | 표준 변환 엔진 (Qwen3-ASR 1.7B) | 2.5GB | 필수 (엔진 중 하나) | 텍스트 변환 |
| `asr-lite` | 저사양 변환 엔진 (Qwen3-ASR 0.6B) | 1.0GB | 필수 (엔진 중 하나) | 텍스트 변환, **실시간 텍스트 변환 (표준 엔진이 있어도 이 엔진이 따로 필요)** |
| `asr-ko-mix` | 영어 섞인 한국어 변환 엔진 (BuzzASR Korean, Whisper large-v3 한국어 파인튜닝) | 1.7GB | 필수 (엔진 중 하나) | 텍스트 변환 |
| `diarizer` | 참석자 구분 (Nemotron 3 Diarization) | 199MB | 권장 | 참석자 구분 (없으면 참석자 없이 변환) |
| `aligner` | 단어 싱크 (Qwen3 ForcedAligner 0.6B) | 1.3GB | 선택 | 단어 싱크 맞추기, 재생 중 단어 강조 |
| `embedding` | 스마트 검색 (Qwen3 Embedding 0.6B, 8bit) | 0.6GB | 선택 | 스마트 검색 (키워드 검색은 그대로 됨) |
| `voices` | 참석자 목소리 (3D-Speaker CAM++) | 28MB | 선택 | 참석자 목소리 등록과 이름 제안 |
| `fluid` | 9명 이상 참석자 구분 (FluidAudio) | 22MB + 헬퍼 | 선택 | 9명 이상 참석자 구분 (없으면 8명까지) |

- **`필수 (엔진 중 하나)`**: 변환 엔진(`asr-std`·`asr-lite`·`asr-ko-mix`)은 하나만 있으면 텍스트 변환이 됩니다. 다 받을 필요는 없습니다. 모델 화면에는 하나라도 설치돼 있으면 `변환 엔진: 설치됨`으로 보입니다. 표준 엔진은 가장 정확하고 메모리 16GB 이상을 권합니다. 가벼운 엔진은 메모리를 덜 쓰고, **실시간 텍스트 변환에는 이 엔진이 따로 필요합니다.** 표준 엔진(1.7B)도 실시간에 써 봤지만 글자가 확정되기까지 p95로 약 1.6~2초(부하가 있는 Mac에서 잰 값, 중간값도 약 1초 이상)라 기준 1초를 넘어 쓰지 않습니다 (2026-10-14 실측, docs/desktop.md §2.8).
- **`asr-ko-mix`(BuzzASR)**: 영어 용어가 많이 섞인 한국어 대화에서 표준 엔진보다 정확합니다(한·영 혼용 HiKE MER 22.8 vs 28.3, 영어 용어 재현율 86% vs 72%). 한국어만 쓰는 회의는 표준 엔진이 조금 더 정확합니다(AI Hub CER 9.5 vs 10.3). Whisper 계열이라 자주 쓰는 단어를 쓰지 않습니다. 모델 화면에서 `기본으로 쓰기`를 누르면 이 엔진으로 변환합니다.
- 기능이 아닌 항목도 있습니다. **녹음**은 모델 없이 됩니다. 변환 엔진이 없으면 녹음만 저장하고 `변환 대기 중인 녹음`으로 남깁니다. 나중에 모델을 받으면 변환합니다.
- **요약과 AI 질문**은 모델이 아니라 API 키가 필요합니다 ([API 키](#api-키-넣기)).
- `fluid`는 모델 외에 헬퍼 `tractus-diar`가 필요합니다. `scripts/install.sh --with-fluid`로 빌드한 뒤 받습니다(Swift 6.2 이상 필요).
- 모델 라이선스는 [NOTICE](../NOTICE)에 있습니다.

#### 구성 추천

| 구성 | 담긴 모델 | 디스크 | 대상 |
| --- | --- | --- | --- |
| 표준 | 필수(표준 엔진) + 참석자 구분 + 단어 싱크 + 스마트 검색 + 목소리 (실시간 텍스트 변환을 쓰려면 `asr-lite`를 더 받습니다) | 약 4.6GB | 메모리 16GB 이상 (`--preset standard`) |
| 저사양 | 저사양 엔진 + 참석자 구분 | 약 1.2GB | 메모리 8GB, 다른 작업과 같이 쓸 때 (`--preset lite`) |
| 필수만 | `vad` + 메모리에 맞는 변환 엔진 하나 | 1.0~2.5GB | 우선 써 보고 나중에 더 받을 때 (`--preset required`) |
| 전부 | 위 모든 모델 (헬퍼가 있으면 `fluid` 포함) | 약 5.7GB | (`--preset all`) |

필수만 받아도 기본 흐름은 모두 됩니다: 녹음하거나 파일을 가져와 텍스트로 변환하고, API 키가 있으면 요약합니다.

### API 키 넣기

요약과 AI 질문은 LLM API를 부릅니다. 전송하는 것은 질문과 근거 텍스트뿐이고 오디오는 보내지 않습니다.

- **앱:** 설정 > AI 요약·질문에서 AI 서비스(Upstage·OpenAI·Claude·Gemini·직접 입력)를 고르고 API 키(와 필요하면 서비스 주소·AI 모델 이름)를 넣은 뒤 `연결 테스트`로 확인합니다. 키는 서비스마다 앱 설정 폴더에 따로 저장되고 노트 폴더에는 쓰지 않습니다. 요약·질문을 요청하면 그 노트의 대화 내용(제목·참석자 이름 포함)이 고른 서비스로 전송됩니다. API 키는 5자부터 저장됩니다. 서비스를 둘 이상 등록하면 요약 탭과 AI 질문 입력창의 `AI 서비스` 칸에서 그때그때 고를 수 있고(처음 값은 `기본으로 사용`), 설정의 `스마트 검색 방식`에서 스마트 검색을 Upstage로 바꿀 수 있습니다(Upstage 키가 필요하고, 노트 내용과 검색어가 Upstage로 전송됩니다).
- **터미널:** 저장소 루트의 `.env.local`에 `UPSTAGE_API_KEY=...`처럼 넣습니다(git 제외). 다른 공급자·주소는 [AI 서비스와 키](ai-services.md#요약결정-사항할-일)의 공급자 표와 `.env.example`을 봅니다. `uv run tractus llm test`로 연결을 시험하고 `uv run tractus llm models --provider gemini`로 서비스의 AI 모델 ID를 봅니다. 서비스마다 주소·AI 모델을 따로 두려면 `.env.local`에 `GEMINI_BASE_URL`·`GEMINI_MODEL`처럼 씁니다. 검색 임베딩을 Upstage로 바꾸려면 `TRACTUS_EMBED=upstage`(노트의 문장과 검색어가 Upstage로 전송됩니다)와 `UPSTAGE_API_KEY`가 필요합니다.

키가 없어도 녹음, 변환, 검색, 내보내기는 모두 됩니다. 요약과 질문만 안 됩니다.

---

## 3. 요구 사항과 도구

| 항목 | 최소 | 권장 |
| --- | --- | --- |
| 칩 | Apple Silicon (M1 이상) | M1 Pro 이상 |
| macOS | 14.4 | 최신 버전 |
| 메모리 | 8GB | 16GB 이상 |
| 디스크 여유 | 15GB (빌드 산출물 약 3GB(실측, 9명 이상 구분 헬퍼 포함) + 모델 최대 5.7GB) | 25GB |

- **최소 사양은 설계 기준이고 직접 돌려 보지는 못했습니다.** 8GB는 메모리 사용량 계산으로, macOS 14.4는 아래 Core Audio process tap의 하한으로 정했습니다. 개발 기기는 Apple M3, 16GB, macOS 26.6입니다. 설치 시간과 빌드 용량은 이 기기에서 2026-10-15에 쟀고([디스크 사용량](#디스크-사용량)), 모델 크기는 레지스트리의 합입니다.
- 메모리 8GB에서는 저사양 구성(0.6B 모델)을 씁니다. 이 구성에서는 실시간 텍스트 변환(16GB 이상 필요)을 쓸 수 없습니다. 표준 구성(1.7B 모델)은 16GB 이상에서 권장합니다.
- Intel Mac은 지원하지 않습니다. 변환 모델이 MLX(Apple Silicon 전용)로 돌아갑니다.
- macOS 14.4는 시스템 오디오 녹음(Core Audio process tap)의 하한입니다.

### 디스크 사용량

2026-10-15에 깨끗한 복사본(`git archive`, 모델·빌드 산출물 없음)에서 `scripts/install.sh --with-fluid`를 한 번 돌려 `du`로 쟀습니다 (Apple M3, 16GB, 릴리스 빌드).

| 항목 | 크기 | 비고 |
| --- | --- | --- |
| `.venv` (코어) | 0.58GB | mlx, scipy, onnxruntime, transformers 등 |
| `recorder/.build` | 0.10GB | 녹음 프로그램 |
| `recorder/diar/.build` | 0.95GB | `--with-fluid`일 때만 (FluidAudio와 의존성) |
| `app/src-tauri/target` | 1.22GB | 릴리스 컴파일 산출물. 완성된 `Tractus.app`은 약 17MB |
| `app/node_modules` | 0.19GB | |
| **합계 (저장소 폴더)** | **약 3.05GB** | `--with-fluid` 없이는 약 2.1GB. 모델은 별도입니다 |

설치 시간은 전체 5분 17초였습니다: 녹음 프로그램 11초, 9명 이상 구분 헬퍼 167초(FluidAudio 내려받기 포함), 앱 릴리스 컴파일 약 2분.

개발하면서 `cargo build`·`pnpm tauri dev`를 쓰면 `app/src-tauri/target`이 더 커집니다(증분 캐시와 debug·release가 쌓입니다). 이 저장소를 계속 개발한 Mac에서는 `app/src-tauri/target` 12GB 이상(2026-10-15 실측 12.9GB, 계속 늘어납니다), `recorder/.build` 1.0GB, `recorder/diar/.build` 1.3GB, `bench/.venv` 1.2GB까지 불었습니다. 그래서 두 가지를 했습니다.

- **`[profile.dev] debug = "line-tables-only"`** (`app/src-tauri/Cargo.toml`): 개발 빌드가 줄 번호만 남기고 변수 정보는 만들지 않습니다. 깨끗한 개발 빌드(`cargo build` 한 번)의 `target`이 **2.88GB에서 2.08GB로 28% 줄었고**, 컴파일 시간은 64초와 68초로 차이가 없었습니다(2026-10-15 실측). 역추적(backtrace)의 파일·줄 번호는 그대로이고, 디버거(lldb)에서 지역 변수 값을 볼 수 없게 됩니다. 변수까지 봐야 하면 그 줄을 `debug = true`로 바꿉니다. 증분 컴파일은 기본값(켜짐) 그대로입니다. 릴리스 빌드(`install.sh`)에는 영향이 없습니다.
- **`scripts/clean.sh`**: 다시 만들 수 있는 산출물만 지웁니다 ([§4](#scriptscleansh)).

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

끝에는 읽기만 하는 **설치 점검**이 있습니다. `tractus doctor` 요약을 보여 주고, 앱 설정(`~/Library/Application Support/dev.tractus.app/settings.json`)에 직접 지정해 둔 `tractus_bin`·`rec_bin` 경로가 없거나 방금 만든 것과 다르면 경고합니다(`설정에서 경로를 '자동'으로 되돌리세요`). 경고만 하고 설치는 실패시키지 않으며, `--check`는 여전히 아무것도 바꾸지 않습니다.

### `scripts/update.sh`

```bash
scripts/update.sh --check                  # 받을 커밋만 보기 (git fetch와 git log뿐)
scripts/update.sh [install.sh 옵션]        # git pull --ff-only → 바뀐 커밋 보기 → scripts/install.sh → 설치 점검
```

`--check` 말고는 모든 옵션을 `install.sh`로 그대로 넘깁니다(예: `scripts/update.sh --with-fluid --models standard`). 멈추는 경우는 셋입니다: 작업 폴더에 고치지 않은 변경이 있을 때(새 파일은 세지 않습니다), 브랜치가 `origin`을 따라가지 않을 때(분리된 HEAD 포함), 내 커밋이 있어 빠르게 합칠 수 없을 때. 멈출 때는 아무것도 바꾸지 않고 이유를 알려 줍니다. 이미 최신이면 그렇게 말하고 끝나므로 여러 번 실행해도 안전합니다. 받은 뒤 설치가 중간에 실패해도 코드는 최신이니 문제를 고치고 `scripts/install.sh`를 다시 실행하면 됩니다.

### `scripts/clean.sh`

빌드 산출물의 크기를 보여 주고, 확인을 받은 뒤 지웁니다. 지운 뒤에는 `scripts/install.sh`가 다시 만듭니다.

| 옵션 | 효과 |
| --- | --- |
| (없음) | `app/src-tauri/target`, `recorder/.build`, `recorder/diar/.build`를 지웁니다. **완성된 `Tractus.app`도 `target` 안에 있으므로 함께 지워집니다** (`--copy-app`으로 복사해 둔 `~/Applications/Tractus.app`은 그대로입니다) |
| `--all` | 위에 더해 `app/node_modules`, `bench/.venv`도 지웁니다(다시 받아야 하므로 인터넷이 필요합니다) |
| `--yes` | 확인을 묻지 않습니다. 터미널이 아닌 곳에서는 이 옵션이 있어야 지웁니다 |
| `--force` | 이 저장소의 Tractus 앱·녹음 프로그램이 실행 중이어도 지웁니다 (기본은 실행 중이면 멈춥니다) |

**지우지 않는 것:** `.venv`(코어), `models/`, `data/`, 노트 폴더(`TRACTUS_HOME`), 소스. 정해진 폴더만 지우고, 저장소 밖을 가리키는 링크는 건너뜁니다.

## 5. 권한

| 권한 | 언제 묻나 | 거부했을 때 |
| --- | --- | --- |
| 마이크 | 처음 녹음할 때 macOS가 묻습니다 | 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 Tractus를 켭니다 |
| 시스템 오디오 | 시스템 소리를 함께 녹음하는 모드로 처음 녹음할 때 | 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 켭니다 |
| 캘린더 (선택) | 설정 > 캘린더에서 `캘린더 연결`을 누를 때만. 연결하지 않으면 묻지 않습니다 | 설정 화면의 `시스템 설정 열기`로 개인정보 보호 및 보안 > 캘린더에서 Tractus를 켭니다 |

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
| 모델 | `~/Library/Application Support/dev.tractus.app/models/` (예전에 `~/Tractus/models/`에 받았다면 그곳. `TRACTUS_MODELS_DIR`로 변경) |
| 앱 설정, 저장한 API 키 | `~/Library/Application Support/dev.tractus.app/` |
| 코어·녹음 프로그램·헬퍼·앱 빌드 | 저장소 폴더 안 (`.venv`, `recorder/.build`, `recorder/diar/.build`, `app/src-tauri/target`) |
| 코어·녹음 프로그램 (미리 만든 앱) | 앱 안 `Tractus.app/Contents/Resources/runtime/`(코어), `Resources/bin/`(녹음 프로그램). 앱 밖 폴더는 위와 같습니다 |

노트 폴더(`~/Tractus`)는 iCloud Drive·Dropbox·OneDrive·Google Drive나 Obsidian 볼트 안에 두지 않는 것을 권합니다. 노트와 오디오가 함께 동기화될 수 있습니다. 그런 폴더면 시작 점검의 `데이터 폴더`가 알려 주고 `폴더 바꾸기…`를 줍니다(노트는 옮기지 않으니 새 폴더로 직접 옮기고 앱을 다시 시작합니다).

## 7. 업데이트

```bash
cd Tractus
scripts/update.sh --check   # 받을 커밋 보기 (선택)
scripts/update.sh           # git pull --ff-only + scripts/install.sh (--with-fluid로 설치했다면 같은 옵션을 붙입니다)
```

앱이 켜져 있으면 끄고 실행합니다. 노트와 모델은 그대로 남습니다. 자세한 동작은 [§4](#scriptsupdatesh)입니다. 미리 만든 앱(`.dmg`)은 이 스크립트가 아니라 앱 안 `설정 > 업데이트`로 올립니다([§10](#데이터와-업데이트)).

**스마트 검색 모델이 8bit로 바뀐 버전(2026-10-15)으로 올리면:** 새 모델(0.6GB)을 모델 화면에서 받고 검색 벡터를 다시 만듭니다(`uv run tractus index`, 모델 식별자가 바뀌어 자동으로 전부 다시 만듭니다). 예전 모델 폴더(`qwen3-embedding-0.6b`, 1.2GB)는 "등록되지 않은 폴더"로 남으므로 `uv run tractus models prune`으로 지웁니다(`tractus models list`가 개수와 크기를 알려 줍니다). 새 모델은 아직 검색 품질을 평가하지 않았습니다([CLAUDE.md](../CLAUDE.md)의 면제 기록).

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
| 앱이 `tractus`나 `tractus-rec`를 실행할 수 없다고 함 | 저장소 폴더를 옮겼거나 빌드가 안 된 것입니다. 저장소에서 `scripts/install.sh`를 다시 실행합니다. 설정의 경로가 `자동`이면 새로 만든 파일을 찾고, `직접 지정`이면 `자동으로 되돌리기`나 `찾아보기…`로 고칩니다. 시작 점검의 `도구`에서 어느 경로를 쓰는지 볼 수 있습니다. 설치 끝의 점검도 저장된 경로가 맞지 않으면 알려 줍니다 |
| 모델 폴더에 예전 모델이 남아 용량을 차지함 | `uv run tractus models list`가 `등록되지 않은 폴더`의 개수와 크기를 알려 줍니다. `uv run tractus models prune`이 크기를 보여 주고 확인한 뒤 지웁니다 (등록된 모델·숨김 파일·링크는 건드리지 않습니다) |
| `app/src-tauri/target` 등이 너무 큼 | `scripts/clean.sh`로 빌드 산출물을 지우고(`--all`은 `node_modules`까지) 필요하면 `scripts/install.sh`로 다시 만듭니다 |
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
rm -rf "$HOME/Library/Application Support/dev.tractus.app"   # 앱 설정, 저장한 API 키, 기본 위치에 받은 모델 (모델은 다시 받을 수 있음)
rm -rf ~/Tractus/models                                 # 예전에 이 위치에 모델을 받았다면
rm -rf <저장소 폴더>                                    # 코어, 녹음 프로그램, 앱 빌드
tccutil reset All dev.tractus.app                       # 권한 초기화 (선택)
```

**`~/Tractus/meetings/`에는 노트와 녹음이 들어 있습니다.** 이 폴더는 위 명령에 넣지 않았습니다. 필요 없다고 확인한 뒤에만 지우세요.

## 10. 미리 만든 앱 받기

저장소 없이 도는 `Tractus.app`을 `.dmg`로 받아 쓰는 방법입니다. 앱 안에 코어(옮길 수 있는 Python, 의존성, `tractus`)와 녹음 프로그램(`tractus-rec`)이 들어 있어 Rust·Node·uv 같은 개발 도구가 필요 없습니다. 모델(수 GB)과 ffmpeg는 넣지 않았습니다.

> **지금 상태 (솔직하게):** 만든 Mac의 복사본에서 저장소·원래 Python 읽기를 막고(`sandbox-exec`) 환경을 비운(`env -i`) 채로 확인했습니다. **깨끗한 Mac(새 계정)에서는 아직 시험하지 못했고, 인터넷에서 내려받아 격리 표시가 붙은 상태의 Gatekeeper 동작과 마이크 권한이 어느 이름으로 뜨는지도 확인하지 못했습니다.** 정식 서명·공증은 하지 않았습니다(ad-hoc 서명). **macOS 14.4~15에서 돌려 보지도 못했습니다**(만든 Mac은 macOS 26.6): 빌드가 의존성 wheel을 가장 낮은 macOS용(`macosx_14_0`)으로 고정하고 14.4보다 새 시스템을 요구하는 Mach-O가 있으면 빌드를 멈추는 것까지만 확인했습니다. 이 검사를 넣기 전의 빌드는 `mlx`가 macOS 26.2 이상을 요구했습니다.

### 설치

1. [GitHub 릴리스](https://github.com/sjoon21/Tractus/releases)의 최신 릴리스에서 `Tractus-<버전>[-<날짜>]-arm64.dmg`를 받습니다. 이 DMG에는 9명 이상 참석자 구분 도우미(`tractus-diar`)가 없어서 참석자는 8명까지(Nemotron) 구분합니다. `.dmg`를 열고 `Tractus`를 `Applications` 바로가기로 끌어다 놓습니다. 관리자 암호는 필요 없습니다(`~/Applications`에 넣어도 됩니다). 같은 안내가 디스크 안의 `설치 안내.txt`에 있습니다.
2. 처음 열 때 "확인되지 않은 개발자" 경고가 나옵니다. 서명이 Apple에 등록된 것이 아니기 때문입니다.
   - macOS 15 이상: 앱을 한 번 열어 경고를 닫고, 시스템 설정 > 개인정보 보호 및 보안 아래쪽의 `그래도 열기`를 누른 뒤 암호를 입력합니다.
   - macOS 14.x: 앱을 control 키를 누른 채 클릭해 `열기`를 고릅니다.
   - 터미널: `xattr -dr com.apple.quarantine /Applications/Tractus.app` (내려받은 파일의 격리 표시를 지웁니다. `손상되었기 때문에 열 수 없습니다`라고 나올 때도 이 명령으로 풀립니다)
3. 처음 실행하면 **시작 점검** → **모델 받기** → **API 키** 순서입니다([§2](#2-앱을-처음-열었을-때)와 같습니다). 앞의 둘만 하면 녹음과 텍스트 변환은 됩니다.
4. **ffmpeg는 앱에 들어 있지 않습니다**(라이선스 때문에 넣지 않았습니다). 터미널에서 `brew install ffmpeg`로 설치합니다. 없으면 녹음은 되지만 텍스트 변환과 파일 가져오기는 안 됩니다(시작 점검이 알려 줍니다).

### 데이터와 업데이트

노트·모델·설정은 모두 앱 밖에 있습니다([§6](#6-폴더-안내)): 노트 `~/Tractus`, 모델 `~/Library/Application Support/dev.tractus.app/models`, 설정과 API 키 `~/Library/Application Support/dev.tractus.app/`. 어떤 방법으로 업데이트해도 데이터는 그대로 남습니다.

**업데이트는 앱 안에서 합니다(0.1.1부터).** 앱을 켜면 약 10초 뒤에 새 버전이 있는지 한 번 보고, 있으면 `새 버전이 있습니다: X` 알림과 `설정 열기` 단추가 보입니다(같은 실행에서 두 번 알리지 않습니다). `설정 > 업데이트`에는 지금 버전, `업데이트 확인` 단추, 상태 문구(`확인 중…` / `최신입니다` / 새 버전과 릴리스 노트 일부 + `업데이트 설치`)가 있습니다. `업데이트 설치`를 누른 뒤에만 받아서(`받는 중 N%`) 설치하고, `설치가 끝났습니다` 다음의 `다시 열기`를 누르면 새 버전으로 다시 뜹니다(녹음·변환 중에는 잠깁니다. 끝난 뒤 누르세요). 저절로 설치하지 않습니다. 켤 때의 확인이 실패하면(인터넷 없음 등) 아무것도 보이지 않고, 설정의 단추로 확인했을 때만 오류 문장이 보입니다.

- 새 버전은 공개 저장소의 **정식 릴리스**(pre-release 아님)에서만 찾습니다(`releases/latest`의 `latest.json`). 받은 파일은 저장소에 든 공개 키로 서명을 검사하고 맞지 않으면 설치하지 않습니다.
- **v0.1.0에는 이 기능이 없습니다.** 한 번은 새 `.dmg`를 받아 `Tractus.app`을 바꿔 넣습니다(앱을 끄고 덮어씁니다). 이 방법은 그 뒤에도 늘 됩니다.
- 업데이트마다 앱 전체(약 240MB)를 받습니다. 차이만 받지 않습니다.
- 앱을 새로 만들 때마다 ad-hoc 서명의 해시가 달라지므로 위 2번의 경고와 마이크·시스템 오디오 권한 확인이 다시 나올 수 있습니다([§5](#5-권한), 예상일 뿐 직접 확인하지는 못했습니다).
- 저장소에서 `scripts/install.sh`로 만든 앱에는 이 기능이 없고 `설정 > 업데이트`에 `저장소에서 만든 앱은 scripts/update.sh로 업데이트합니다` 한 줄만 보입니다([§7](#7-업데이트)).

지우려면 앱을 휴지통에 넣고, 데이터 폴더는 [§9](#9-제거)처럼 직접 지웁니다.

### 직접 만들기

```bash
scripts/build_app_bundle.sh --check               # 도구만 확인
scripts/build_app_bundle.sh [--out dist/bundle] [--with-fluid]   # → <out>/Tractus.app
scripts/make_dmg.sh dist/bundle/Tractus.app       # → dist/Tractus-<버전>[-<날짜>]-arm64.dmg (버전은 tauri.conf.json, 날짜는 만든 날. --version으로 정하면 날짜 없이 그 이름)
```

- `build_app_bundle.sh`는 `uv`의 Python 3.12(python-build-standalone)를 앱 안 `Contents/Resources/runtime/`에 복사해 줄이고(tkinter·idle·테스트·pip·헤더 삭제, universal2 wheel의 x86_64 조각 제거, `tests`·`*.pyi` 삭제), `uv.lock`에 고정된 의존성을 **wheel만**(`--only-binary :all:`, 소스 빌드는 거부) **해시를 검증하며**(`--require-hashes`) 설치합니다. macOS용 wheel이 여럿인 패키지(`mlx` 등)는 uv가 만든 Mac의 macOS 버전으로 고르면 너무 새 것이 걸리므로, `uv.lock`에 있는 가장 낮은 macOS용 wheel의 URL과 해시로 고정합니다. 빌드는 14.4보다 새 시스템을 요구하는 Mach-O가 하나라도 있으면 멈춥니다. 인터넷은 PyPI의 그 wheel을 받을 때만 쓰고(캐시가 있으면 쓰지 않습니다), 처음 한 번 `uv python install 3.12`가 Python을 받을 수 있습니다. `tractus-rec`를 빌드해 `Resources/bin/`에 넣고(`--with-fluid`면 `tractus-diar`도, Swift 6.2 이상), `pnpm tauri build --bundles app`의 `--config`로 `runtime/`·`bin/`을 `bundle.resources`에 합칩니다(`tauri.conf.json`에 고정하지 않은 것은 `install.sh`의 일반 빌드가 깨지지 않게 하려는 것입니다). 마지막에 안쪽 Mach-O를 모두 ad-hoc 서명하고 앱을 `Entitlements.plist`로 서명해 `codesign --verify --deep --strict`까지 합니다.
- 쓰는 곳은 `--out` 폴더, `app/src-tauri/target`, `app/dist`(`app/node_modules`가 없으면 거기도)뿐입니다. 저장소의 `.venv`와 `recorder/.build`는 건드리지 않습니다(녹음 프로그램은 `--out` 아래 임시 폴더에서 빌드합니다).
- 코어 실행 파일 `runtime/bin/tractus`는 자기 위치 기준으로 번들 안의 Python만 씁니다(링크로 불려도 진짜 위치를 찾고, Python은 `-I`로 띄워 `PYTHON*` 환경변수·사용자 site-packages를 보지 않습니다. `-I`로 막히지 않는 `PYTHONEXECUTABLE`·`__PYVENV_LAUNCHER__`는 지웁니다). 바이트코드는 미리 만들어 두고(`unchecked-hash`) 실행 중에는 쓰지 않습니다. 서명된 앱 안을 바꾸지 않으려는 것이고, 무거운 import의 시작이 약 2.3초에서 1.2초로 줄었습니다.
- 크기와 시간(Apple M3, 깨끗한 복사본, 2026-10-15 실측): 앱 약 694MB(Python 35MB, `site-packages` 632MB: mlx 155·transformers 111·onnxruntime 79·scipy 92, 바이트코드 약 126MB 포함, 앱 본체 16MB, 녹음 프로그램 0.3MB), `.dmg` 242MB, 빌드 약 2.5분(캐시가 따뜻할 때. 처음 175초).
- `.pkg`는 만들지 않습니다. 관리자 암호가 필요한 설치나 MDM 배포가 필요할 때만 이득이라서입니다.

#### 릴리스 만들기 (`scripts/release.sh`)

릴리스에 올릴 파일 한 벌은 `scripts/release.sh`가 만듭니다. 앱 안 업데이트가 읽는 `latest.json`을 만드는 곳은 이 스크립트뿐입니다.

```bash
pnpm --dir app tauri signer generate -w ~/.tauri/tractus.key --ci   # 서명 키가 없을 때 한 번 (비밀번호 없음, 있으면 덮어쓰지 않음)
scripts/release.sh                 # 만들기만 (기본). gh release create 명령은 출력만 합니다
scripts/release.sh --publish       # 위에 더해 GitHub 릴리스를 실제로 만듭니다
```

순서는 `build_app_bundle.sh` → 최종 서명된 `Tractus.app`을 `COPYFILE_DISABLE=1 tar czf Tractus.app.tar.gz`(앱 폴더가 아카이브 루트) → `pnpm tauri signer sign -f ~/.tauri/tractus.key`로 `.sig` → `latest.json` → `make_dmg.sh` → sha256입니다. 버전은 `app/src-tauri/tauri.conf.json`에서 읽고, 결과는 `dist/release/<버전>/`에 모입니다. `tauri build`의 `bundle.createUpdaterArtifacts`는 쓰지 않습니다. 그것이 만드는 tar.gz는 우리 스크립트의 마지막 ad-hoc 재서명 전의 앱이라 쓸모가 없습니다.

| 파일 | 쓰임 |
| --- | --- |
| `Tractus-<버전>-arm64.dmg` | 처음 설치하는 사람이 받는 디스크 이미지 |
| `Tractus-<버전>-arm64.dmg.sha256` | 디스크 이미지의 해시 |
| `Tractus.app.tar.gz` | 앱 안 업데이트가 받는 파일 (앱 전체, 약 240MB) |
| `Tractus.app.tar.gz.sig` | 위 파일의 서명 (`minisign` 형식, 앱이 공개 키로 검사) |
| `latest.json` | 앱이 읽는 안내 파일: `version`, `notes`, `pub_date`, `platforms.darwin-aarch64.{url, signature}`. `url`은 `https://github.com/sjoon21/Tractus/releases/download/v<버전>/Tractus.app.tar.gz` |

- **서명 키 `~/.tauri/tractus.key`는 반드시 백업합니다.** 공개 키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 들어 있어 이미 설치된 앱이 그 키로 서명을 검사합니다. 개인 키를 잃으면 새 키로 서명한 업데이트를 기존 설치본이 거부하므로, 모든 사용자가 다시 `.dmg`로 설치해야 합니다. 개인 키는 저장소에 넣지 않고 내용을 출력하지도 않습니다. 키가 없으면 스크립트는 안내하고 멈춥니다. 다른 위치의 키는 환경변수 `TAURI_SIGNING_PRIVATE_KEY_PATH`(경로) 또는 `TAURI_SIGNING_PRIVATE_KEY`(키 내용)로 줍니다. 만든 `.sig`가 앱의 공개 키와 맞는지는 `TRACTUS_UPDATE_ARTIFACT=<tar.gz> TRACTUS_UPDATE_SIG=<.sig> cargo test --test update_signature`(`app/src-tauri`)가 앱과 같은 방식으로 검사합니다(환경변수가 없으면 조용히 통과).
- **정식 릴리스여야 합니다.** 앱은 `releases/latest/download/latest.json`을 읽는데, GitHub의 `latest`는 pre-release가 아닌 가장 최근 릴리스만 가리킵니다. pre-release로 올리면 아무도 업데이트를 못 받습니다. 태그는 `v<버전>`이고 `latest.json`의 `url`이 그 태그를 가리키므로, 다른 이름으로 올리면 받기가 404로 실패합니다.
- 버전을 올릴 때는 `app/src-tauri/tauri.conf.json`·`app/src-tauri/Cargo.toml`·`app/package.json`·`pyproject.toml`을 함께 맞춥니다(`Cargo.lock`은 cargo가, `uv.lock`은 `uv lock`이 따라갑니다).
- 확인하지 못한 것: 업데이트 뒤 마이크·시스템 오디오 권한을 다시 묻는지(ad-hoc 재서명), 깨끗한 Mac(새 계정)에서의 설치·업데이트, macOS 14.4~15에서의 동작.
