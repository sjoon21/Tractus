# Phase 4 데스크톱 — 구성 요소 계약 (B안 우선, D안 백업)

B안(Tauri 데스크톱 앱)을 먼저 만들어 완성도를 보고, 부족하면 D안(메뉴바 녹음기 + Obsidian 플러그인)으로 간다.
두 안이 **녹음 헬퍼(`tractus-rec`)와 Python 코어 변경을 공유**하도록 경계를 정한다. 이 문서는 세 구성 요소 사이의 계약이다.

```text
┌──────────── Tauri 앱 (app/) ────────────┐
│ React UI ── invoke ──▶ Rust 명령          │
│                         ├─ 파일 직접 읽기 (meetings/*, transcript.json, summary.json, memos.json, audio.ogg)
│                         ├─ spawn: tractus-rec record ...   ── stdout JSON 이벤트 / stdin 명령
│                         ├─ spawn: tractus transcribe --recording <dir> --progress-json
│                         ├─ spawn: tractus summarize <id> --progress-json
│                         └─ 상주: tractus mcp (stdio JSON-RPC) ── search_meetings, status
└──────────────────────────────────────────┘
```

## 1. 녹음 헬퍼 `tractus-rec` (recorder/, Swift)

Swift Package 실행 파일. 마이크는 AVAudioEngine, 시스템 오디오는 Core Audio process tap(macOS 14.4+, `AudioHardwareCreateProcessTap` + private aggregate device)으로 받는다. **트랙을 섞지 않고 따로 쓴다.**

### 녹음 모드 (2026-10-02 결정)

주 사용 사례는 **여러 명이 한 방에 모이는 대면 회의**다. 화상·하이브리드 회의는 보조다. 헤드폰을 전제하지 않는다.

| 모드 | 앱이 넘기는 인자 | 내용 |
| --- | --- | --- |
| **대면 회의 (기본)** | `--no-system` | 마이크 하나로 방 안의 모든 사람을 녹음한다. 시스템 오디오가 없으니 에코 문제도 없다. 음성 처리(AGC·잡음 제거)를 켜지 않아 원음에 가깝게 녹음한다 |
| 화상·하이브리드 | `--echo-cancel` | 마이크 + 시스템 오디오. 스피커로 들어도 되도록 마이크 입력에 macOS 내장 에코 제거(AVAudioEngine voice processing)를 켜고, 다른 소리를 줄이는 ducking은 최소로 둔다 |

### `tractus-rec record --out <dir> [--no-mic] [--no-system] [--echo-cancel] [--fake]`

- `--echo-cancel`: 마이크 입력에 voice processing(에코 제거, AGC, 잡음 제거)을 켠다. 켜지 못하면 `warning`(`echo_cancel_failed`)을 내고 없이 녹음한다. `started` 이벤트와 `recording.json`에 `"echo_cancel": true|false`를 기록한다.

- `--fake`: 실제 장치 대신 생성한 신호(마이크 440 Hz, 시스템 660 Hz, 중간에 무음 구간)를 쓴다. 권한 없이 앱·테스트를 돌리는 개발용이다.

- `<dir>`을 만들고 다음을 쓴다.
  - `mic.wav`, `system.wav`: 48 kHz mono 16-bit PCM WAV. 녹음 중에 계속 디스크로 쓴다(메모리에 쌓지 않음).
  - `recording.json`: 녹음 정보 (아래 스키마). 메모·북마크가 들어올 때마다 원자적으로 다시 쓴다.
- **stdout**: JSON Lines 이벤트만 출력한다. 로그는 stderr로 보낸다.
- **stdin**: 한 줄에 명령 하나.
  - `bookmark`: 지금 시각에 북마크
  - `memo <텍스트>`: 지금 시각에 메모
  - `stop`: 녹음을 마무리하고 종료
- **stdin이 닫히면(EOF) `stop`과 같이 처리한다.** 앱은 녹음 내내 stdin 파이프를 열어 둬야 한다.
- SIGINT·SIGTERM을 받아도 `stop`과 같이 파일을 닫고 종료한다. 강제 종료돼도 WAV 헤더가 깨지지 않게 주기적으로 헤더를 갱신한다(또는 CAF로 쓰고 종료 시 변환).

이벤트:

```jsonc
{"event":"started","dir":"/…/recordings/01K…","tracks":["mic","system"],"sample_rate":48000,"started_at":"2026-10-02T14:00:00+09:00"}
{"event":"level","t":12.25,"mic":-23.1,"system":-41.7}        // 250ms마다, dBFS (트랙이 없으면 null)
{"event":"mark","t":95.0,"kind":"bookmark","text":null}
{"event":"mark","t":130.5,"kind":"memo","text":"예산 다시 확인"}
{"event":"warning","code":"system_zero","message":"시스템 오디오가 5초 동안 정확히 0입니다. 시스템 설정 > 개인정보 보호 > 화면 및 시스템 오디오 녹음 권한을 확인하세요"}
{"event":"warning","code":"mic_denied","message":"마이크 권한이 없습니다"}
{"event":"stopped","dir":"/…","duration":3605.2}
{"event":"error","message":"…"}                               // 치명적 오류 후 종료 코드 1
```

- `system_zero`: tap을 연 뒤 **처음 5초 동안 표본이 정확히 0만** 들어오면 권한 문제로 보고 **한 번만** 알린다. 0이 아닌 표본이 한 번이라도 들어오면 권한이 있는 것이므로 이후 무음(상대 음소거 등)에는 알리지 않는다. minutes·Meetily와 같은 방식이다.
- 그 밖의 경고 코드: `mic_restarted`·`system_restarted`(입출력 장치가 바뀌어 다시 연결함), `mic_failed`·`system_failed`(다시 연결 실패, 2초마다 재시도). 앱은 모르는 코드면 `message`를 그대로 보여 준다.
- `level`: `-100`은 완전한 무음 또는 그 구간에 표본 없음, `null`은 녹음하지 않는 트랙이다. 장치가 끊긴 동안은 무음으로 채워 두 트랙 길이를 맞춘다.
- 거부·종료: `<dir>`에 `mic.wav`·`system.wav`·`recording.json`이 이미 있으면 시작하지 않는다(`error`, 종료 코드 1). WAV 하나가 4 GiB(약 12.4시간)에 이르면 `error`를 내고 종료한다.
- 이벤트 JSON의 키 순서는 정해져 있지 않다.

### `tractus-rec check`

권한 상태를 JSON 한 줄로 출력하고 종료한다: `{"mic":"granted|denied|undetermined","system":"ok|zero|error","macos":"26.6"}`. `system`은 1초 동안 tap을 열어 0이 아닌 표본이 들어오는지 본다(재생 중인 소리가 없으면 `zero`일 수 있으니 참고용).

### `recording.json`

```jsonc
{
  "schema_version": 1,
  "started_at": "2026-10-02T14:00:00+09:00",
  "duration": 3605.2,                 // 종료 시 채움, 녹음 중에는 null
  "tracks": {"mic": "mic.wav", "system": "system.wav"},
  "marks": [{"t": 95.0, "kind": "bookmark", "text": null}, {"t": 130.5, "kind": "memo", "text": "예산 다시 확인"}]
}
```

### 권한

- 실행 파일에 Info.plist(`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`)를 `-sectcreate __TEXT __info_plist`로 넣는다.
- 앱이 하위 프로세스로 실행하면 macOS는 권한을 **부모 앱**(Tractus.app)에 묻는다. 그래서 Tauri 앱의 Info.plist에도 같은 키를 넣는다.

## 2. Python 코어 변경 (src/tractus/)

| 변경 | 내용 |
| --- | --- |
| `audio.ogg` | 새 회의는 `audio.ogg`(Ogg Opus 32kbps mono)로 보관한다. Obsidian은 `.opus`를 열지 못한다. `transcript.json`의 `audio.file`이 실제 파일 이름이다. 예전 `audio.opus` 회의도 그대로 읽는다 |
| `transcript.vtt` | 세그먼트마다 WebVTT 큐(큐 ID = 세그먼트 ID). Obsidian Media Extended, 브라우저 `<track>`이 그대로 읽는다 |
| `memos.json` | 녹음 중 메모·북마크 `[{"t": 초, "kind": "memo"\|"bookmark", "text": str\|null}]`. `transcript.md`에도 시각 순으로 끼워 넣는다 |
| `tractus transcribe --recording <dir>` | `recording.json`의 트랙들을 FFmpeg `amix`로 섞어 전사한다. `marks`는 `memos.json`으로 옮긴다. 성공하면 녹음 폴더를 지운다(`--keep-tracks`면 회의 폴더의 `tracks/`로 옮김). 회의 시각은 `started_at` |
| `--progress-json` | `transcribe`·`summarize`가 stdout에 JSON Lines를 출력한다. 사람용 출력은 원래대로 stderr로 보낸다 |

진행 이벤트:

```jsonc
{"event":"stage","stage":"decode"}            // decode | vad | encode | load_model | transcribe | index | summarize
{"event":"progress","done":37,"total":145}
{"event":"done","meeting_id":"01K…","meeting_dir":"/…/meetings/2026-10-02_…"}
{"event":"error","message":"…"}               // 종료 코드 1
```

## 3. Tauri 앱 (app/)

- **스택:** Tauri 2 + React + TypeScript + Vite. 오디오는 자체 `media://` URI 스킴(`convertFileSrc(path, "media")`, MIME `audio/ogg`, HTTP Range 지원, `TRACTUS_HOME` 밖 경로 거부)으로 `<audio>`에 연결한다. Tauri 기본 asset protocol은 `.ogg`/`.opus`의 MIME과 Range 처리가 맞지 않아 쓰지 않는다(`app/README.md`).
- **남은 녹음:** `recordings/<ULID>/recording.json`이 남아 있는 폴더는 "전사 안 된 녹음"으로 보여 준다. 코어는 전사에 **성공했을 때만** 녹음 폴더를 지운다(앱이 강제 종료되거나 전사가 실패해도 녹음은 남는다).
- **API 키·모델 위치:** 코어는 현재 폴더에 이어 `$TRACTUS_HOME/.env` / `.env.local`도 읽는다. 저장소 밖에 설치한 앱은 `$TRACTUS_HOME/.env.local`에 `UPSTAGE_API_KEY`, `TRACTUS_MODELS_DIR` 등을 둔다.
- **설정:** `TRACTUS_HOME`(기본 `~/Tractus`), `TRACTUS_MODELS_DIR`, `tractus` 실행 파일 경로(기본: 저장소 `.venv/bin/tractus`), `tractus-rec` 경로. GUI 앱은 셸 PATH를 물려받지 않으므로 절대 경로로 둔다.
- **데이터:** 회의 목록·전사·요약·메모는 Rust에서 파일을 직접 읽는다. 검색만 상주 `tractus mcp`의 `search_meetings`로 한다(색인·임베딩 모델을 매번 올리지 않으려고).

### v1 화면

| 화면 | 기능 |
| --- | --- |
| 사이드바 | 회의 목록(날짜별), 검색 입력, 녹음 시작 버튼 |
| 녹음 | 경과 시간, 트랙별 레벨미터, 북마크(단축키), 메모 입력(Enter → 경과 시각과 함께 저장), 정지 → 전사 진행률 |
| 회의 상세 | 오디오 플레이어. 전사 세그먼트를 클릭하면 그 위치로 이동하고, 재생 중인 세그먼트를 강조·자동 스크롤. 메모·북마크를 시각 순으로 함께 표시. 요약 패널(결정 사항·할 일, 항목의 시각을 클릭하면 이동). 요약이 없으면 "요약 만들기" |
| 검색 결과 | 세그먼트 단위 결과. 클릭하면 회의 상세의 해당 시각으로 이동 |

### 제외 (v1)

실시간 전사, 화자 분리 UI, 전사 텍스트 직접 편집(찾아 바꾸기는 다음 단계), 회의 자동 감지, 자동 업데이트, 공증.

## 4. B안 판정 기준 (D안으로 갈지 정할 때)

| 기준 | 통과 조건 |
| --- | --- |
| 녹음 | 실제 화상회의 1시간을 마이크·시스템 2트랙으로 끊김 없이 녹음, 권한 문제를 사용자에게 알림 |
| 리뷰 UI | 클릭 → 재생 위치 이동, 현재 세그먼트 강조, 요약 항목 → 원문 이동이 매끄러움 |
| 성능 | 앱 시작 3초 이내, 1시간 회의 상세 화면이 끊김 없이 스크롤 |
| 유지보수 | 1인이 Rust·TS·Swift·Python 네 언어를 감당할 수 있는지 (구현하면서 체감 기록) |
| Obsidian | 같은 회의 폴더를 볼트에서 열었을 때 노트·오디오·자막이 그대로 쓰이는지 (D안과 공통) |
