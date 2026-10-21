# Phase 4 데스크톱 — 구성 요소 계약 (B안 우선, D안 백업)

B안(Tauri 데스크톱 앱)을 먼저 만들어 완성도를 보고, 부족하면 D안(메뉴바 녹음기 + Obsidian 플러그인)으로 간다.
두 안이 **녹음 헬퍼(`tractus-rec`)와 Python 코어 변경을 공유**하도록 경계를 정한다. 이 문서는 세 구성 요소 사이의 계약이다.

```text
┌──────────── Tauri 앱 (app/) ────────────┐
│ React UI ── invoke ──▶ Rust 명령          │
│                         ├─ 파일 직접 읽기 (meetings/*, transcript.json, summary.json, memos.json, audio.ogg)
│                         ├─ spawn: tractus-rec record ...   ── stdout JSON 이벤트 / stdin 명령
│                         ├─ spawn: tractus transcribe --recording <dir> --progress-json
│                         ├─ spawn: tractus recording finish <dir> --progress-json   (녹음만 저장, 변환 안 함 → "변환 전" 노트, §2.16)
│                         ├─ spawn: tractus transcribe --into <id> --progress-json   (변환 전 노트를 나중에 변환, §2.16)
│                         ├─ spawn: tractus summarize <id> --progress-json
│                         ├─ spawn: tractus speakers <id> rename | set | merge   (화자 목록은 transcript.json을 직접 읽는다)
│                         ├─ spawn: tractus ask [--meeting <id>] --progress-json   (stdin JSON, 대화 기록은 chat.json을 직접 읽는다)
│                         ├─ spawn: tractus live --recording <dir> --progress-json  (녹음 중 실시간 자막, 설정에서 켰을 때만. stdin stop)
│                         └─ 상주: tractus mcp (stdio JSON-RPC) ── search_meetings, status
└──────────────────────────────────────────┘
```

## 1. 녹음 헬퍼 `tractus-rec` (recorder/, Swift)

Swift Package 실행 파일. 마이크는 AVAudioEngine, 시스템 오디오는 Core Audio process tap(macOS 14.4+, `AudioHardwareCreateProcessTap` + private aggregate device)으로 받는다. **트랙을 섞지 않고 따로 쓴다.**

### 녹음 모드 (2026-10-02 결정)

주 사용 사례는 **여러 명이 한 방에 모이는 대면 회의**다. 화상·하이브리드 회의는 보조다. 헤드폰을 전제하지 않는다.

| 모드 | 앱이 넘기는 인자 | 내용 |
| --- | --- | --- |
| **대면 녹음 (기본)** | `--no-system` | 마이크 하나로 방 안의 모든 사람을 녹음한다. 시스템 오디오가 없으니 에코 문제도 없다. 음성 처리(AGC·잡음 제거)를 켜지 않아 원음에 가깝게 녹음한다 |
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
  - `mark_edit <i> <텍스트>`: `marks[i]`(0부터, 남긴 순서) 메모의 글을 바꾼다. 북마크·없는 번호는 바꾸지 않는다 (v3.60)
  - `mark_delete <i>`: `marks[i]` 메모·북마크를 지운다. 둘 다 결과를 `marks` 이벤트(전체 목록)로 알리고 `recording.json`을 다시 쓴다
  - `pause`: 일시정지 (2026-10-14). 아래 "일시정지" 절을 본다
  - `resume`: 일시정지를 풀고 이어서 녹음
  - `stop`: 녹음을 마무리하고 종료 (일시정지 중에도 된다)
- **stdin이 닫히면(EOF) `stop`과 같이 처리한다.** 앱은 녹음 내내 stdin 파이프를 열어 둬야 한다.
- SIGINT·SIGTERM을 받아도 `stop`과 같이 파일을 닫고 종료한다. 강제 종료돼도 WAV 헤더가 깨지지 않게 주기적으로 헤더를 갱신한다(또는 CAF로 쓰고 종료 시 변환).

이벤트:

```jsonc
{"event":"started","dir":"/…/recordings/01K…","tracks":["mic","system"],"sample_rate":48000,"started_at":"2026-10-02T14:00:00+09:00"}
{"event":"level","t":12.25,"mic":-23.1,"system":-41.7}        // 250ms마다, dBFS (트랙이 없으면 null)
{"event":"mark","t":95.0,"kind":"bookmark","text":null}
{"event":"mark","t":130.5,"kind":"memo","text":"예산 다시 확인"}
{"event":"marks","marks":[{"t":130.5,"kind":"memo","text":"예산 확인"}]}   // mark_edit·mark_delete 뒤의 전체 목록. 앱은 목록을 이것으로 바꾼다
{"event":"paused","elapsed":95.0}                             // 일시정지됨. elapsed = 멈춘 오디오 시각
{"event":"resumed","elapsed":95.0}                            // 계속함. elapsed는 paused와 같은 오디오 시각에서 이어진다
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

#### 일시정지 (2026-10-14)

- `pause`·`resume` 명령은 `paused`·`resumed` 이벤트로 확인한다(`elapsed`는 초, 소수 둘째 자리). **이미 일시정지 중인 `pause`와 일시정지 중이 아닌 `resume`은 아무 일도 없다**(이벤트·경고 없음). 앱은 이벤트가 올 때만 상태를 바꾼다.
- **오디오 시계는 일시정지 시간을 뺀다.** `started` 이후 녹음된 시간만 센다. `level.t`, `mark.t`, `paused/resumed.elapsed`, `stopped.duration`, `recording.json`의 `duration`·`marks[].t`·`pauses[].at`이 모두 이 시계다. 앱은 `elapsed`를 이벤트에서만 받는다(벽시계 타이머로 세지 않는다).
- 일시정지 중에는 **두 트랙의 표본을 모두 버린다.** WAV에는 일시정지 구간이 없고(0으로 메우지도 않는다) 두 트랙은 계속 같은 길이다. 계속하면 같은 오디오 시각에서 이어 쓴다. 캡처 엔진은 계속 돌므로 macOS 마이크 사용 표시(주황 점)는 일시정지 중에도 켜져 있다. 마이크를 놓지 않는다.
- 일시정지 중에는 **`level` 이벤트를 내지 않는다**(`paused`와 `resumed` 사이에 없다). 앱은 `paused`를 받으면 미터를 비우고 `resumed` 뒤에 다시 받는다. 시스템 오디오 경고(`system_zero`)·장치 재연결 감시도 표본이 오는 동안만 동작한다.
- 일시정지 중에도 `bookmark`·`memo`는 받고, **멈춘 오디오 시각**(= `paused.elapsed`)에 찍는다.
- `stop`·SIGINT·SIGTERM·stdin EOF는 일시정지 중에도 똑같이 마무리한다(WAV 헤더 확정, `recording.json`, `stopped`). 이때 `duration`은 멈춘 오디오 시각이다. 일시정지 중에 강제 종료돼도 `pause` 시점까지는 WAV가 재생된다(헤더를 그때 갱신한다).
- 녹음을 시작하자마자(첫 표본 전) `pause`해도 된다. 첫 표본은 오디오 시각에 맞춰 놓이므로 일시정지 시간이 앞에 들어가지 않는다.

### `tractus-rec check`

권한 상태를 JSON 한 줄로 출력하고 종료한다: `{"mic":"granted|denied|undetermined","system":"ok|zero|error","macos":"26.6"}`. `system`은 1초 동안 tap을 열어 0이 아닌 표본이 들어오는지 본다(재생 중인 소리가 없으면 `zero`일 수 있으니 참고용).

### `tractus-rec calendar access|request|list|next` (v3.38)

macOS 캘린더(EventKit) 읽기. 설계: [docs/design/calendar.md](design/calendar.md). 모두 한 줄 JSON이고 권한이 없으면 목록은 빈 채 성공한다.

- `access` → `{"access": "granted|denied|undetermined|restricted|write_only"}` (묻지 않는다). `request` → 권한 창(처음일 때만) 뒤 같은 모양.
- `list` → `{"access", "calendars": [{"id", "title", "source"}]}` (계정 → 이름 순).
- `next [--ahead 분(1~1440, 기본 15)] [--exclude 캘린더ID]…` → `{"access", "events": [{"id", "title", "start", "end", "calendar", "attendees": ["이름"]}]}`. 끝나지 않았고 `ahead`분 안에 시작하는 일정을 시작 순으로(종일·제목 없음·취소·내가 거절한 일정 제외, 제목은 200자까지). 참석자는 이름 있는 사람만이고 **이메일은 내보내지 않는다**(`@`가 든 이름은 뺀다. 앱 `calendar::clean_event`·코어 `clean_event`도 같다).

### `recording.json`

```jsonc
{
  "schema_version": 1,
  "started_at": "2026-10-02T14:00:00+09:00",
  "duration": 3605.2,                 // 종료 시 채움, 녹음 중에는 null
  "tracks": {"mic": "mic.wav", "system": "system.wav"},
  "marks": [{"t": 95.0, "kind": "bookmark", "text": null}, {"t": 130.5, "kind": "memo", "text": "예산 다시 확인"}],
  "pauses": [{"at": 95.0, "wall_start": "2026-10-02T14:20:00+09:00", "wall_end": "2026-10-02T14:41:12+09:00"}]  // 추가 키(2026-10-14). 끝난 일시정지만 있고 없으면 []
}
```

- `duration`, `marks[].t`, `pauses[].at`은 **오디오 시계**(일시정지를 뺀 시각)다. 그래서 WAV 길이 = `duration`이고 WAV 위치 = `t`다. `pauses[].wall_start/wall_end`는 벽시계(로컬 오프셋 ISO, 초 단위)라서 일시정지가 실제로 언제였는지 알 수 있다. 일시정지 중에 종료하면 열려 있던 일시정지는 종료 때 닫힌다. `pauses`가 없는 옛 파일은 `[]`로 읽는다.

### 권한

- 실행 파일에 Info.plist(`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`, `NSCalendarsFullAccessUsageDescription`)를 `-sectcreate __TEXT __info_plist`로 넣는다.
- 앱이 하위 프로세스로 실행하면 macOS는 권한을 **부모 앱**(Tractus.app)에 묻는다. 그래서 Tauri 앱의 Info.plist에도 같은 키를 넣는다.

## 2. Python 코어 변경 (src/tractus/)

| 변경 | 내용 |
| --- | --- |
| `audio.ogg` | 새 회의는 `audio.ogg`(Ogg Opus 32kbps mono)로 보관한다. Obsidian은 `.opus`를 열지 못한다. `transcript.json`의 `audio.file`이 실제 파일 이름이다. 예전 `audio.opus` 회의도 그대로 읽는다 |
| `transcript.vtt` | 세그먼트마다 WebVTT 큐(큐 ID = 세그먼트 ID). Obsidian Media Extended, 브라우저 `<track>`이 그대로 읽는다 |
| `memos.json` | 녹음 중 메모·북마크 `[{"t": 초, "kind": "memo"\|"bookmark", "text": str\|null}]`. `transcript.md`에도 시각 순으로 끼워 넣는다 |
| `tractus marks <노트> save` (v3.60) | stdin `{"marks": [...]}`: 녹음 중 메모·북마크를 고치거나 지운 목록을 `memos.json`에 쓴다(`note_lock`). 항목은 기존 항목과 `t`·`kind`가 맞아야 하고(새로 남기기·시각 바꾸기 불가, 종료 코드 2 + `bad_input`), 메모 글은 한 줄·500자, 비우면 지운다. 모두 지워도 빈 `memos.json`을 남긴다(변환 전 노트가 녹음 폴더의 원래 메모를 다시 읽지 않게). `transcript.md`를 다시 그린다. → `{"marks": [...]}` |
| `tractus transcribe --recording <dir>` | `recording.json`의 트랙들을 FFmpeg `amix`로 섞어 전사한다. `marks`는 `memos.json`으로 옮긴다. 성공하면 녹음 폴더를 지운다(`--keep-tracks`면 회의 폴더의 `tracks/`로 옮김). 회의 시각은 `started_at` |
| `--progress-json` | `transcribe`·`summarize`가 stdout에 JSON Lines를 출력한다. 사람용 출력은 원래대로 stderr로 보낸다 |
| 화자 분리 (2026-10-04) | `transcribe`가 VAD 다음에 화자 분리를 한다(기본 켜짐, `--no-diarize`로 끔, `--max-speakers N`으로 상한. v3.15부터 상한 없음, Nemotron은 8명까지). 엔진은 `--diarizer auto|nemotron|fluid`(기본 auto: Nemotron이 8명을 모두 쓰면 Swift 헬퍼 `tractus-diar`로 다시 나눈다. 앱은 넘기지 않으므로 auto). 라벨은 `S1`…`Sn`이고 n은 8을 넘을 수 있다(앱 화자 색은 16칸: 잉크 8개, 9번째 슬롯부터 같은 잉크에 속 빈 점·빗금 막대, 16명이 넘으면 겹친다). `transcript.json` schema_version 2: `segments[].speaker`(`"S1"`… 또는 null), 최상위 `speakers: {"S1": {"name": null}}`, `diarization`(끄거나 모델이 없으면 null). 표시 이름 = `name`, 없으면 라벨, `speaker`가 null이면 md·vtt에 표시 안 함(앱은 화자 있는 회의에서 "알 수 없음" 참석자 칩으로 보여 주고 참석자를 고를 수 있게 한다). schema_version 1 회의는 `speakers`가 없다 (ARCHITECTURE.md §6) |
| `tractus speakers` | 화자 편집. transcript.json을 고치고 md·vtt를 다시 쓴 뒤 검색 색인을 갱신한다. 오디오는 건드리지 않는다. 아래 §2.1 |
| 표시 텍스트 (Phase 5) | 어디서나 `corrected_text`가 null이 아니면 그것, 아니면 `text`(코어 `store.seg_text`). md·vtt·요약 프롬프트·MCP·색인·CLI 검색·내보내기가 모두 따른다. 앱도 같은 규칙으로 표시한다 |
| `tractus segments` | 텍스트 편집. 아래 §2.2 |
| `tractus glossary add` | 용어집 추가. 아래 §2.3 |
| `tractus export` | 내보내기. 아래 §2.4 |
| `tractus note meta`, `folders`, `notes list` (v3.20) | 즐겨찾기·태그·폴더와 목록 정렬·필터. 아래 §2.12 |
| `tractus note` (v3.18) | 직접 쓰는 메모 노트(오디오 없음)와 노트 제목 바꾸기. 아래 §2.10 |
| `tractus recording finish`, `tractus transcribe --into <노트>` (v3.25) | 녹음과 변환을 나눈다: 녹음을 변환 없이 "변환 전" 노트로 저장하고 나중에 그 자리에서 변환한다. 아래 §2.16 |
| `tractus transcribe --append-to <노트>` (v3.19) | 글만 있는 노트에 녹음을 덧붙여 녹음 노트로 바꾼다. 아래 §2.11 |
| `tractus ask` (Phase 6) | 회의 질의. 아래 §2.5 |
| 단어 타이밍 (Phase 6) | `transcribe`가 전사 뒤 `segments[].words`를 채운다(`--no-align`으로 끔). 기존 회의는 `tractus align`. 아래 §2.6 |
| 목소리 프로필 (Phase 7.1) | `transcribe`가 화자 분리 뒤 등록된 목소리와 맞춰 `speakers.S1.suggested`에 이름을 제안한다. `tractus voices`, `tractus speakers <회의> dismiss`. 아래 §2.7 |
| 실시간 자막 (Phase 7.2) | 녹음 중 `tractus live --recording <dir> --progress-json`. 미리보기 전용이고 아무것도 저장하지 않는다. 아래 §2.8 |
| 가져오기 (Phase 5) | 앱 job kind `import` = `tractus transcribe <파일> --progress-json` (다른 작업과 같은 환경변수). ffmpeg가 읽는 모든 형식을 받는다(m4a, mp3, wav, webm, mp4, mov …). 동영상은 소리만 쓴다(`-vn`) |

진행 이벤트:

```jsonc
{"event":"stage","stage":"decode"}            // decode | vad | diarize | voices | encode | load_model | transcribe | align | index | summarize
{"event":"progress","done":37,"total":145}
{"event":"stage","stage":"diarize","engine":"nemotron"}       // engine: nemotron | fluid. auto가 다시 나누면 diarize가 두 번 (nemotron → fluid)
{"event":"warning","code":"diarizer_missing","message":"…"}   // 화자 분리 모델이 없음 → 화자 없이 계속 (diarizer_failed: 실패 → 화자 없이 계속, --diarizer fluid 실패면 Nemotron으로 계속. diarizer_cap_failed: auto의 9명 이상 재시도(fluid)만 실패 → Nemotron 결과(8명)로 계속)
{"event":"warning","code":"diarizer_cap","message":"…"}       // auto: 8명을 모두 썼지만 tractus-diar 헬퍼나 모델이 없음 → Nemotron 결과(8명)로 계속. message에 빌드·받기 명령
{"event":"warning","code":"fluid_missing","message":"…"}      // --diarizer fluid인데 헬퍼나 모델이 없음 → Nemotron으로 계속
{"event":"warning","code":"fluid_short_clip","message":"…"}   // --diarizer fluid인데 클립이 60초보다 짧음 → 경고만 하고 fluid로 계속 (community-1이 짧은 클립에서 화자를 과하게 나눈다). auto는 이 경고가 없다(8명을 다 쓴 긴 노트에서만 fluid)
{"event":"warning","code":"aligner_missing","message":"…"}    // 단어 정렬 모델이 없음 → words null로 완료 (aligner_failed: 실패 → words null로 완료). 모델이 있는데 한 세그먼트만 못 맞추면 경고 없이 단어를 고르게 편 words(approx)로 완료
{"event":"warning","code":"voices_model_missing","message":"…"} // 등록된 목소리가 있는데 모델이 없음 → 제안 없이 계속 (voices_failed: 실패 → 제안 없이 계속)
{"event":"warning","code":"asr_track_fallback","message":"…"}   // --track 없이 변환할 때 메모리가 권하는 트랙의 변환 엔진이 없고 다른 쪽이 있어 그쪽으로 변환 (§2.15)
{"event":"warning","code":"duplicate","message":"…"}           // 이미 전사된 파일 → 바로 기존 회의의 done이 이어진다 (종료 코드 0)
{"event":"done","meeting_id":"01K…","meeting_dir":"/…/meetings/2026-10-02_…"}
{"event":"error","message":"…","code":"audio_failed"}   // 종료 코드 1 (중단은 130). code는 있을 때만
```

- **`error`의 `code`(선택, 2026-10-07).** 앱은 `code`를 WORDS.md §4.7의 문장으로 바꾸고 `message`는 `자세히`에 접는다. `code`가 있는 `message`는 CLI용이라 기술적일 수 있다. `code`가 없으면 작업별 기본 문장을 보인다. 코어가 내는 코드:

  | 코드 | 명령 | 언제 |
  | --- | --- | --- |
  | `model_missing` | transcribe, live, align | ASR·VAD·단어 정렬 모델이 없음 (`message`에 `tractus models download <id>`와 `hf download …`, §2.15) |
  | `audio_failed` | transcribe, align, recording finish | ffmpeg가 오디오를 읽지 못함, 소리 없는 파일 |
  | `ffmpeg_missing` | transcribe, align, recording finish | ffmpeg가 설치되지 않음 (`brew install ffmpeg`) |
  | `recording_missing` | transcribe `--recording`·`--into`, recording finish | `recording.json`을 읽지 못함, 녹음된 트랙이 없음. finish는 녹음 폴더가 없어도(종료 코드 2). `--into`는 아니다(아래 `note_audio_missing`) |
  | `note_audio_missing` | transcribe `--into` | 변환 전 노트에 `tracks/`도 `audio.ogg`도 없음(종료 코드 2). 마이크 안내가 아니라 노트의 문장 `이 노트의 녹음 파일을 찾을 수 없습니다.` |
  | `interrupted` | transcribe, recording finish | 전사·저장 중 중단 (종료 코드 130, 같은 명령으로 이어하기) |
  | `incomplete` | transcribe | 전사되지 않은 청크가 남아 transcript.json을 쓰지 못함 |
  | `align_interrupted` | transcribe | 단어 정렬 중 중단. 전사는 저장됨 (종료 코드 130) |
  | `no_segments` | summarize | 세그먼트가 없음 |
  | `llm_config` | summarize, ask, llm test | 서비스·키·AI 모델·주소 설정이 없거나 잘못됨 (잘못된 `TRACTUS_LLM_BASE_URL` 포함) |
  | `llm_local_only` | summarize, ask, llm test | `TRACTUS_LOCAL_ONLY`인데 주소의 호스트가 이 Mac(localhost·127.0.0.1·::1)이 아님 |
  | `llm_auth` | summarize, ask, llm test | 키가 맞지 않거나 권한이 없음 (HTTP 401·403). `message`에 서버 문구를 싣지 않는다 |
  | `llm_rate` | summarize, ask, llm test | 사용량 한도·요청 폭주 (HTTP 429) |
  | `llm_busy` (v3.33) | summarize, ask, llm test | AI 서비스가 바쁨 (HTTP 503·529, `UNAVAILABLE`·`overloaded`·`high demand`). SDK가 4회 다시 보낸 뒤에도 같을 때만 나온다 |
  | `llm_model` | summarize, ask, llm test | AI 모델을 찾을 수 없음 (HTTP 404, `model_not_found`). `message`에 서버 안내 문장을 싣는다(키 가림, 200자까지: Gemini는 "gemini-3.8-flash를 쓰라"고 알려 준다) |
  | `llm_context` | summarize, ask, llm test | 입력이 AI 모델의 컨텍스트 길이를 넘음 |
  | `llm_conn` | summarize, ask, llm test | 연결 거절·DNS·시간 초과 |
  | `llm_api` | summarize, ask, llm test | 그 밖의 AI 서비스 오류 (HTTP 5xx 등). `message`는 `호스트 HTTP 상태: 서버 문구(200자까지, 키·키처럼 긴 토큰은 `***`로 가림)` |
  | `llm_invalid` | summarize, ask | 요약 응답이 2회 연속 검증 실패(`message`는 짧은 문장, 원문은 stderr), 질의 답이 빔 |
  | `live_low_memory` | live | 메모리 16GB 미만, `--force` 없음 |
  | `live_failed` | live | 녹음 파일·WAV 형식 오류 등으로 실시간 전사를 멈춤 |
  | `bad_input` (추가) | recording finish | 제목이 비었거나 120자 초과 (종료 코드 2, 아무것도 만들지 않음) |
  | `not_recorded` | transcribe `--into` | 대상이 "변환 전" 노트가 아님: 이미 변환했거나 메모 노트이거나, 변환하는 사이 다른 실행이 먼저 변환함 (종료 코드 2, §2.16) |
  | `not_converted` | summarize, align, speakers·segments·voices의 편집 명령 | "변환 전" 노트라 대화 내용이 없음 (종료 코드 2). `ask`는 같은 코드의 **경고**만 내고 LLM을 부르지 않는다 (§2.16) |
  | `append_note_missing`, `append_has_audio` | transcribe `--append-to` | 대상 노트가 없음 / 글만 있는 노트가 아님 (종료 코드 2, §2.11). 경고 `append_remap_failed`: 요약·질문 기록의 근거를 옮기지 못함 |

  회의를 찾지 못한 오류(`resolve_meeting`)와 ask의 입력 오류에는 `code`가 없다.

- `diarize` 단계는 모델이 있을 때만 나온다(84분 회의 약 14초, fluid는 90분 약 22초). auto가 fluid로 다시 나누면 `engine`만 다른 `diarize`가 한 번 더 나온다. 이어하기에서는 다시 하지 않는다(처음 쓴 엔진이 `.job.json`에 남는다).
- `voices` 단계는 등록된 목소리가 있고 화자 분리를 했을 때만 나온다(화자당 구간 3개 임베딩, onnxruntime CPU). 등록된 사람이 없으면 단계도 경고도 없다. 이어하기에서는 다시 하지 않는다.
- `align` 단계는 `transcribe` 다음, `index` 전에 나온다(모델이 있고 `--no-align`이 아닐 때). `progress`는 세그먼트 단위다(`done`/`total`). 44.7분 회의 약 66초.
- `align` 중에 중단하면 전사는 이미 저장돼 있다. `error`(`code: align_interrupted`) 메시지에 `tractus align <id>` 안내가 있고 종료 코드는 130이다.
- `warning`은 종료가 아니다. 앱은 `message`를 알림으로 보여 주고 진행을 계속 표시한다.
- `transcribe`는 첫 이벤트로 `{"event":"stage","stage":"decode"}`를 낸다. 큰 파일의 SHA-256 계산(중복 확인)보다 먼저 나온다.
- 이미 전사된 파일이면 `stage(decode)` → `warning(duplicate)` → `done`(기존 회의의 `meeting_id`·`meeting_dir`) 순서다. 앱은 화면을 바꾸지 않고 "이미 텍스트로 변환한 파일입니다" 알림에 **열기**를 붙인다(고치던 문장을 잃지 않게).
- 오디오 트랙이 없는 동영상은 `{"event":"error","message":"음성 파일을 읽지 못했습니다: 소리가 없는 파일입니다. 소리 없는 동영상인지 확인하세요: …","code":"audio_failed"}`, 종료 코드 1.

### 2.1 `tractus speakers <회의>` (화자 편집)

`<회의>`는 meeting_id(일부) 또는 회의 폴더 경로다. 편집 명령은 성공하면 종료 코드 0, 잘못된 인자(없는 라벨·세그먼트, 같은 화자 병합)는 stderr에 이유를 쓰고 종료 코드 1이다. 편집 뒤 앱은 transcript.json을 다시 읽는다.

| 명령 | 동작 |
| --- | --- |
| `tractus speakers <회의> list --json` | 아래 JSON 한 줄을 stdout에 출력 |
| `tractus speakers <회의> rename S1 "김민수"` | 이름 지정. `""`이면 이름을 지운다. `` []<>*_`\ `` 문자는 빠지고, `S2`·`참석자 2`처럼 자동 이름 모양인 이름은 exit 1 |
| `tractus speakers <회의> set s0012 S2` | 세그먼트 하나의 화자 변경. `S2` 대신 `new`면 다음 라벨(예: `S4`)을 만든다 |
| `tractus speakers <회의> merge S3 S1` | S3의 세그먼트를 모두 S1으로 옮기고 S3을 없앤다. S1에 이름이 없으면 S3의 이름을 이어받는다. S3의 목소리 제안은 사라진다 |
| `tractus speakers <회의> dismiss S1` | 목소리 제안을 지운다(앱의 '다름'). 거절한 사람은 `speakers.S1.dismissed`에 남아 `voices match`가 같은 참석자에 다시 제안하지 않는다(§2.7). 제안을 받아들이는 '맞음'은 제안된 이름으로 `rename`한다. rename은 언제나 제안을 지운다(거절 기록은 지우지 않는다) |

세그먼트가 하나도 남지 않은 라벨은 `speakers`에서 지워진다.

**동시 쓰기 (`<노트>/.lock`).** transcript.json을 읽고 고쳐 쓰는 모든 명령(`speakers`·`segments edit`·`voices enroll|match|forget`·`align`의 병합·`render`)은 읽기부터 쓰기까지를 `store.note_lock`(`fcntl.flock`, 노트 폴더의 숨김 파일 `.lock`) 안에서 한다. 앱이 편집하는 동안 정렬이나 목소리 매칭이 끝나도 서로의 수정을 덮어쓰지 않는다. 잠금은 프로세스가 죽으면 OS가 푼다. `.lock`은 내용이 없는 파일이고 bundle 내보내기에 들어가지 않는다.

```jsonc
// tractus speakers 01K6X3 list --json
{"meeting_id":"01K6X3…","speakers":[
  {"label":"S1","name":"김민수","display":"김민수","suggested":null,"segments":31,"talk_sec":812.4},
  {"label":"S2","name":null,"display":"S2","suggested":{"person_id":"01K…","name":"홍길동","score":0.82},"segments":18,"talk_sec":402.0}],
 "diarization":{"engine":"nemotron","model":"mlx-community/Nemotron-3-Diarization","revision":"59ed2dbf…","params":{…}}}   // 화자 분리 안 했으면 speakers [], diarization null. engine: nemotron | fluid(model FluidInference/speaker-diarization-coreml, revision df2625ac…). 예전 회의에는 engine이 없다
```

### 2.2 `tractus segments <회의> edit` (텍스트 편집)

stdin으로 JSON 객체 하나를 받는다. 앱은 argv로 실행하고(셸 없이) `TYPER_USE_RICH=0`을 준다.

```jsonc
// stdin
{"edits":[{"id":"s0012","text":"새 문장"},{"id":"s0013","text":"원문 그대로"}]}
// stdout (한 줄)
{"changed":2}
```

- 각 편집의 `text`는 앞뒤 공백을 지우고 연속 공백·줄바꿈을 한 칸으로 줄인다. 그 값이 원문 `text`와 같으면 `corrected_text = null`(교정 해제), 다르면 `corrected_text = 그 값`이다. 원문 `text`는 그대로 둔다.
- 바뀐 세그먼트에 `words`가 있으면 새 표시 텍스트에 맞게 옮긴다(§2.6). 같은 단어는 시각을 그대로 두고, 바뀌거나 새로 생긴 단어에는 `approx: true`가 붙는다.
- 처음 고칠 때 그 세그먼트의 `words`를 `words_asr`(선택 키)에 복사해 둔다. 고친 문장이 원문과 같아지면(교정 해제) 추정한 단어 대신 `words_asr`를 `words`로 정확히 되돌리고 `words_asr`를 지운다. 앱·내보내기·MCP는 `words_asr`를 읽지 않는다.
- `changed`는 `corrected_text`가 실제로 바뀐 세그먼트 수다. 0이면 파일을 쓰지 않는다.
- 없는 id, 빈 텍스트, 형식 오류(JSON 아님, `edits`가 목록이 아님, `id`·`text`가 문자열이 아님)가 하나라도 있으면 아무것도 쓰지 않고 stderr에 이유를 쓴 뒤 종료 코드 1이다.
- 저장은 화자 편집과 같다. transcript.md·vtt를 먼저, transcript.json을 마지막에 원자적으로 쓴다. 색인은 `sync(embed=False)`로 갱신한다. 본문이 바뀐 청크는 다음 임베딩 동기화(`tractus index`, 전사·요약 뒤)까지 키워드로만 찾힌다. 그런 청크의 수는 `Index.stats()['pending']`(MCP `status`의 `hint`, `tractus index` 마지막 줄)이고, `tractus index`는 이 청크만 한 번에 임베딩한다(`tests/test_index.py::test_text_edit_leaves_pending_until_index_then_embeds_only_edited_chunk`). 임베딩 모델이 바뀌면 옛 벡터는 쓸 수 없어 `pending`이 청크 전체다.
- 편집 뒤 앱은 transcript.json을 다시 읽는다. 요약(summary.*)은 다시 만들지 않는다.

### 2.3 `tractus glossary add <용어> [<용어>…]`

`$TRACTUS_HOME/glossary.md`에 `- 용어` 줄로 덧붙인다(없으면 머리말 `# 자주 쓰는 단어`와 안내 한 줄로 만든다). 앱은 찾아 바꾸기의 `바꾼 말을 자주 쓰는 단어에 추가`와, 대화 한 줄을 직접 고쳤을 때의 제안(v3.53, `vocab.termFromEdit`: 바뀐 낱말 1~2개, 자모로 비교해 소리가 비슷함, 동사·어미로 끝나지 않음, 숫자만 바뀐 것 제외, 한 번 물은 낱말은 그 화면에서 다시 묻지 않음)에서 부른다. 앞뒤 공백을 지우고, 빈 값과 이미 있는 용어(대소문자 구분)는 건너뛴다. stdout: `{"added":N}`. 용어가 `-`로 시작할 수 있으므로 앱은 `tractus glossary add -- <용어>…`처럼 `--`를 앞에 둔다. 다음 전사부터 hotwords로 들어간다.

### 2.4 `tractus export <회의> --format <형식> --out <경로> [--force]`

파일을 쓰고 stdout에 `{"path":"<절대 경로>"}`를 출력한다. `--out`이 이미 있으면 `--force`일 때만 덮어쓰고, 아니면 종료 코드 1이다. 모든 형식이 화자는 `store.speaker_display`(이름, 없으면 `S3` → `참석자 3`, 화자를 모르면 비움), 본문은 `corrected_text ?? text`를 쓴다. transcript.md·vtt도 같다.

| 형식 | 내용 |
| --- | --- |
| `txt` | 제목, `날짜 시각 · 길이` 줄, 빈 줄, 그다음 `[HH:MM:SS] 참석자 1: 대화 내용` (화자를 모르면 `[HH:MM:SS] 대화 내용`) |
| `md` | transcript.md와 같은 내용(메모·북마크 포함) + summary.md가 있으면 `---` 뒤에 붙인다 |
| `srt` | 번호 큐, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, 본문 `참석자 1: 대화 내용` |
| `vtt` | transcript.vtt와 같다 |
| `csv` | UTF-8 BOM(utf-8-sig), 열 `시작,끝,참석자,내용`, 시각은 `HH:MM:SS` |
| `docx` | 제목, 일시·길이, `참석자 N명 (김민수, 참석자 2)`, summary.json이 있으면 요약·결정 사항·할 일, 그다음 제목 `대화 내용` 아래 시각 + **참석자** + 대화 내용. 한글 글꼴 `w:eastAsia = Apple SD Gothic Neo` |
| `bundle` | 회의 폴더의 audio.ogg(또는 audio.opus), transcript.json/md/vtt, summary.md/json, memos.json 중 있는 것을 `<회의 폴더 이름>/…`로 묶은 zip. `tracks/`는 넣지 않는다 |

### 2.5 `tractus ask` (회의 질의, Phase 6)

```text
tractus ask [--meeting <회의>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--provider P] [--model M] [--save] --progress-json
```

stdin으로 JSON 객체 하나를 받는다. 앱은 argv로 실행하고(셸 없이) `TYPER_USE_RICH=0`을 준다. 사람이 터미널에서 쓸 때는 질문 평문도 받는다(`{`로 시작하지 않으면 평문).

```jsonc
{"question": "오늘 결정된 예산이 얼마야?",                       // 비어 있으면 안 됨, 최대 2,000자
 "history": [{"role": "user", "content": "…"}, {"role": "assistant", "content": "…"}]}   // 생략 가능. 최근 6개 메시지, 합쳐서 12k자까지만 쓴다
```

| 범위 | 근거 | 인용 표기 |
| --- | --- | --- |
| `--meeting` 있음 | 그 회의 전사 전체(`seg_text`, 화자 표시 이름, `[s0012 00:05:31 김민수] 텍스트` 줄). 10만 자가 넘으면 그 회의 안에서 검색한 결과로 바꾼다 | `[s0012]` |
| `--meeting` 없음 | 로컬 색인 하이브리드 검색 상위 8개 청크 + 청크마다 앞뒤 세그먼트 1개. `--from`·`--to`로 회의 날짜를 거른다. 임베딩 모델이 없거나 벡터가 없는 청크는 키워드로만 찾는다(색인은 `sync(embed=False)`) | `[<meeting_id>#s0012]` |

`--from`·`--to`는 전체 범위에서만 쓴다. `--save`는 `--meeting`과 함께만 쓸 수 있다(아니면 `error`, 종료 코드 1).

이벤트 (stdout JSON Lines):

```jsonc
{"event":"stage","stage":"retrieve"}
{"event":"sources","sources":[{"meeting_id":"01K…","title":"3분기 예산 계획 회의","date":"2026-07-08","segment_id":"s0012","speaker":"김민수","start":176.6,"text":"…"}]}   // speaker는 표시 이름 또는 null
{"event":"stage","stage":"answer"}
{"event":"delta","text":"3분기 총 예산은 "}             // 0개 이상. 스트리밍 원문 조각 (인용 정리 전)
{"event":"done","answer":"3분기 총 예산은 … [s0012]","citations":[{"meeting_id":"01K…","segment_id":"s0012","start":176.6}],"provider":"upstage","model":"solar-pro4","no_evidence":false}
{"event":"error","message":"…","code":"llm_api"}         // 종료 코드 1. code: llm_config | llm_local_only | llm_auth | llm_rate | llm_busy | llm_model | llm_context | llm_conn | llm_api | llm_invalid (입력 오류는 없음)
{"event":"warning","code":"chat_save_failed","message":"…"}   // --save 저장 실패 (done 바로 앞). 답(done)은 그대로 나온다
```

- **앱은 `done`의 `answer`로 스트리밍 텍스트를 바꿔 표시한다.** `done`에서 인용을 정리한다: 근거(`sources`)에 있는 ID만 `[s0012]` / `[<meeting_id>#s0012]` 하나씩으로 다시 쓰고(`[s0012, s0013]` → `[s0012][s0013]`), 근거에 없는 ID는 답에서 지운다. `citations`는 답에 남은 인용을 처음 나온 순서로 중복 없이 모은 것이다.
- **`no_evidence`(v3.17)는 답에 인용이 하나도 남지 않았다는 뜻이다**(`citations`가 비었다). 거절 답이거나, 모델이 인용을 빠뜨렸거나, 인용이 모두 근거와 맞지 않은 경우다. 앱의 '근거 대화 없음' 배지는 답 문장이 아니라 이 값(옛 기록은 `citations`가 비었는지)으로 정한다. 거절 문장은 코어 버전과 질문 언어마다 달라서 비교하지 않는다. 코어에는 `ask.turn_no_evidence(turn)`이 있다: `no_evidence` 키가 있으면 그 값, 없는 옛 `chat.json` 답은 `citations`가 비었는지로 판단한다.
- 근거에 답이 없으면 답은 `노트 내용에서 답을 찾지 못했습니다.`(질문이 한국어가 아니면 같은 뜻의 질문 언어)이고 `citations`는 비어 있다. 전체 범위에서 검색 결과가 하나도 없으면 LLM을 부르지 않고 `sources: []` 다음에 바로 이 답으로 `done`을 낸다(`stage answer`·`delta` 없음).
- 공급자 해석은 `summarize`와 같다(`--provider` > `TRACTUS_LLM_PROVIDER`, `TRACTUS_LOCAL_ONLY`, 키 없음 오류 메시지 동일). 이런 오류는 첫 이벤트로 `error`가 나온다. 앱은 보내기 전에 설정된 `TRACTUS_LLM_PROVIDER`로 "질문과 관련 대화 일부가 Upstage(solar-pro4)로 전송됩니다"를 표시한다. 실제로 답한 곳(`done`의 `provider`·`model`)은 각 답 아래에 적는다. 근거가 없어 LLM을 부르지 않은 `done`은 `provider`·`model`이 `null`이다(아무것도 보내지 않았으므로 전송 안내에 쓰지 않는다).
- **전체 범위 검색은 후속 질문에 직전 사용자 질문을 보탠다**(v3.17). `그럼 그건 언제까지야?`는 단독으로 검색하면 쓸 만한 근거가 없다. 단독 질문에 모든 단어가 들어 있는 청크가 없으면, `history`의 마지막 사용자 질문 최대 2개(각 300자까지)를 앞에 붙인 질의의 결과를 단독 질문 결과와 번갈아 섞는다(`ask._hits`, 단독 결과가 앞선다). 단독 질문이 스스로 근거를 찾으면 기록을 쓰지 않는다. LLM 호출은 늘지 않고 검색은 이 Mac에서만 일어난다. 회의 범위가 10만 자를 넘어 회의 안에서 검색할 때도 같다.
- **원격 공급자로는 질문, history, `sources`의 텍스트만 보낸다.** 오디오, 요약, 다른 회의 전사는 보내지 않는다.
- 취소: 앱은 자식 프로세스를 종료한다. `chat.json`은 `done`을 내보내기 직전에 원자적으로 쓰므로, 답 도중에 끊으면 기록이 바뀌지 않고 `done`을 받았다면 이미 저장돼 있다.

`--save` (회의 범위): `done`을 내보내기 직전에 `<회의 폴더>/chat.json`에 한 쌍을 덧붙이고 최근 50개만 남겨 원자적으로 쓴다. 앱은 회의를 열 때 이 파일을 Rust에서 직접 읽어 대화 기록을 보여 준다. 파일이 없으면 새로 만든다. 깨졌거나 형식이 다르면(`schema_version` ≠ 1) 기록을 잃지 않게 덮어쓰지 않고 `warning chat_save_failed`를 낸다(답은 그대로 나온다). 색인·내보내기에는 들어가지 않는다.

```jsonc
{"schema_version":1,"meeting_id":"01K…","turns":[
  {"question":"…","answer":"… [s0012]","citations":[{"meeting_id":"01K…","segment_id":"s0012","start":176.6}],
   "provider":"upstage","model":"solar-pro4","no_evidence":false,"created_at":"2026-10-06T15:10:30+09:00"}]}
```

`--progress-json` 없이 실행하면 정리된 답을 stdout에 출력하고, 인용이 있으면 빈 줄 뒤에 `근거:`와 `[s0012 00:02:56]` 줄을 붙인다.

### 2.6 `tractus align <회의> [--force] [--progress-json]` (단어 타이밍, Phase 6)

`audio.ogg`를 디코딩해 `words`가 null인 세그먼트를 정렬하고 transcript.json·md·vtt를 다시 쓴다. `--force`면 모든 세그먼트를 다시 맞춘다. 단어는 색인하지 않으므로 색인은 갱신하지 않는다.

```jsonc
// stdout (--progress-json 없을 때, 한 줄). aligned + approximate + failed + skipped = 세그먼트 수
{"aligned":293,"approximate":1,"failed":0,"skipped":0}
// --progress-json: stage(decode) → stage(align) → progress* → done (같은 숫자를 done에 싣는다)
{"event":"done","meeting_id":"01K…","meeting_dir":"/…","aligned":293,"approximate":1,"failed":0,"skipped":0}
```

- 정렬할 세그먼트가 없으면 모델을 올리지 않고 바로 끝난다(`skipped` = 세그먼트 수).
- 모델이 없으면 `error`(`code: model_missing`, 메시지에 `hf download … --revision … --local-dir …`), 종료 코드 1.
- **정렬하는 동안 앱에서 고친 세그먼트는 덮어쓰지 않는다.** 저장 직전에 transcript.json을 다시 읽고, 표시 텍스트가 정렬을 시작할 때와 같은 세그먼트에만 `words`를 쓴다. 나머지는 `skipped`로 센다. 읽기부터 쓰기까지는 `note_lock` 안이다. `transcribe`의 align 단계도 같은 방식으로 저장한다(transcript.json이 생긴 뒤라 그 사이에 회의를 편집할 수 있다).
- **`approximate`는 모델이 단어 시각을 못 낸 세그먼트다**(60초 초과, 모델 단어 수 불일치, 모두 길이 0, 한 토큰짜리 쓰레기 출력). `words`를 null로 두지 않고 표시 텍스트의 공백 토큰을 세그먼트 전체에 고르게 펴서 **모든 단어에 `approx: true`**를 붙인다. 앱은 words가 있는 세그먼트로 그대로 보여 주고(단어 하나하나의 시각만 추정), `words[k].text == seg_text(s).split()[k]` 불변식도 그대로다. words가 있으므로 `tractus align`은 이 세그먼트를 건너뛰고, `--force`가 다시 맞춘다.
- `failed`는 표시 텍스트에 단어가 하나도 없는 세그먼트뿐이다. `words`는 null로 남는다. 스키마(required 키)는 바뀌지 않았다.
- 저장은 `store.note_lock`(`<노트>/.lock`, `fcntl.flock`) 안에서 transcript.json을 다시 읽고 쓴다. 정렬이 끝나는 순간 앱·`speakers`·`voices`가 같은 노트를 고쳐도 서로 덮어쓰지 않는다.

`words` 스키마 (ARCHITECTURE.md §6):

```jsonc
"words": null   // 정렬 안 했거나, 표시 텍스트에 단어가 없음
"words": [{"text": "예산은", "start": 12.34, "end": 12.80}, {"text": "사억", "start": 12.80, "end": 13.20, "approx": true}]
```

- **불변식:** `words`가 null이 아니면 `words.length`가 표시 텍스트의 공백 토큰 수(Python `str.split()`, 앱은 `/\S+/g`)와 같고 `words[k].text`는 k번째 토큰과 같다. 드문 공백 문자(U+FEFF 등)에서 둘이 어긋나면 앱은 그 세그먼트를 세그먼트 단위로만 다룬다. 표시 텍스트 = `corrected_text ?? text`. 앱은 어긋나면(낙관적 편집 직후 등) 그 세그먼트의 `words`를 쓰지 않는다.
- 시각은 회의 기준 초(소수 둘째 자리)다. 세그먼트 `[start, end]` 안에 있고, 앞 단어보다 줄지 않으며, `start <= end`다. 길이 0인 단어가 있다(문장부호만 있는 토큰, 모델 출력). 실측 회의에서 6%다.
- `words_asr`(선택): 텍스트를 처음 고치기 직전의 `words` 복사본이다(같은 형식). `words`가 null이었거나 한 번도 고치지 않은 세그먼트에는 없다. 원문으로 되돌릴 때만 쓰인다(§2.2).
- `approx: true`는 텍스트 편집 뒤 시각을 추정한 단어에만 있다. 앱은 이런 단어를 클릭하면 세그먼트 시작으로 이동한다.

### 2.7 `tractus voices` (목소리 프로필, Phase 7.1)

목소리 임베딩은 생체정보(개인정보보호법 제23조 민감정보)다. `$TRACTUS_HOME/voices.json`(권한 0600)에만 저장하고 이 Mac 밖으로 보내지 않는다. 회의 폴더·transcript.json·MCP·LLM·색인·내보내기·로그·stdout 어디에도 벡터를 쓰지 않는다 (ARCHITECTURE.md §2.5).

| 명령 | 동작 · stdout (한 줄 JSON) |
| --- | --- |
| `tractus voices list --json` | `{"people":[{"id","name","samples","created_at"}],"reenroll":false,"model_present":true}`. `reenroll: true`면 모델이 바뀌어 등록된 목소리를 매칭에 쓰지 않는다(다시 등록 필요). `model_present`: 목소리 인식 파일이 있고 sha256이 맞아 쓸 수 있다 |
| `tractus voices enroll <회의> S1 --name 홍길동 --consent` | 그 화자를 `홍길동`으로 확정(= `speakers rename`)하고 목소리 표본을 더한다. 이름이 정확히 같은 사람에 붙고(최대 5개, 넘으면 가장 오래된 것을 버림) 없으면 새 사람. `{"person_id","name","samples"}`. `--consent`가 없으면 동의 안내와 함께 **종료 코드 2**. 없는 라벨·쓸 수 없는 이름·1.5초 이상 이어 말한 구간이 없음·모델 없음은 종료 코드 1이고 아무것도 바꾸지 않는다. 임베딩 뒤 voices.json → transcript.json 순서로 쓰고, transcript.json 쓰기가 실패하면 voices.json을 이전 상태로 되돌린다 |
| `tractus voices forget <이름\|id>` | 사람을 지우고, 모든 노트에 남은 그 사람의 제안·거절 기록과 끝나지 않은 변환 작업(`.job.json`)의 제안도 지운다(확정한 이름은 그대로). 변환 중인 작업은 저장 직전에 등록 여부를 다시 확인한다. `{"forgotten":N}` |
| `tractus voices match <회의> [--progress-json]` | 기존 회의의 제안을 다시 계산한다. 이름을 확정한 화자와, 이 회의에서 이미 확정된 이름의 사람은 건너뛴다. 사용자가 `dismiss`한 사람(`speakers[라벨].dismissed`)은 그 참석자에 다시 제안하지 않는다(다른 참석자에는 제안할 수 있다). `{"suggested":N}`. `--progress-json`: `stage(decode)` → `stage(voices)` → `done{…, "suggested":N}`. 등록된 사람이 없으면 오디오를 읽지 않고 `{"suggested":0}` |

transcript.json의 제안 (ARCHITECTURE.md §6):

```jsonc
"speakers": {"S2": {"name": null, "suggested": {"person_id": "01K…", "name": "홍길동", "score": 0.82}, "dismissed": ["01K…"]}}   // dismissed: 사용자가 '다름'으로 거절한 person_id (선택). bundle에는 name만 나간다
```

- `name`은 언제나 **사용자가 확정한 이름**이다. 제안은 이름이 없는 화자에만 있다. 앱은 배지 "홍길동 님인가요? (일치율 82%)"(`score` × 100, 반올림)와 **맞음**(→ `speakers rename S2 홍길동`)·**다름**(→ `speakers dismiss S2`)을 보여 준다.
- 표시 이름은 제안을 쓰지 않는다(`S2`). md·vtt·요약·MCP·색인·내보내기도 같다. `bundle`의 transcript.json에는 `suggested`가 없다.
- 등록은 앱의 이름 바꾸기 대화상자에서 '이 참석자 목소리 등록 (다음 녹음에서 자동 인식)'과 동의 확인("본인이거나 녹음·등록에 동의를 받은 사람입니다")을 둘 다 체크했을 때만 `voices enroll --consent`로 한다(이름 바꾸기도 같이 된다).
- 모델 파일: `$TRACTUS_MODELS_DIR/3dspeaker-campplus-zh-en/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx`. sha256이 다르면 오류(다른 모델의 벡터와 비교하지 않게).

### 2.7.1 `tractus render <노트>|--all` (문서 다시 만들기)

transcript.json은 그대로 두고 transcript.md·vtt만 다시 만든다. 표시 문구(`참석자 N` 등)가 바뀐 뒤 기존 노트에 반영할 때 쓴다. 노트마다 `note_lock` 안에서 쓰고, 읽을 수 없는 노트는 `--all`에서 건너뛰며 stderr에 알린다. stdout: `{"rendered":N}`. 노트 하나와 `--all` 중 정확히 하나만 지정한다(아니면 종료 코드 2).

### 2.7.2 끝난 노트에 남은 `.job.json`

`transcript.json`이 있으면 그 노트는 끝난 것이다. 변환 마지막에 transcript.json을 쓴 직후 끊겨 `.job.json`·`.chunks.jsonl`이 함께 남아도 이어하기 대상이 아니고, `find_job`·`find_transcribed`·`find_meeting_dir`가 그 파일들을 지운다. 앱의 삭제 거절도 같은 기준이다: `.job.json`이 있고 `transcript.json`이 **없을 때만** 거절한다(변환이 끝나지 않은 노트). 둘 다 있으면 끝난 노트이므로 삭제할 수 있다(`removal.rs`).

### 2.8 `tractus live` (실시간 자막, Phase 7.2)

```text
tractus live --recording <녹음 폴더> [--progress-json] [--speakers] [--force] [--engine lite|std]
```

녹음하는 동안 자막을 **미리보기로만** 보여 준다. Qwen3-ASR 0.6B로 발화마다 전사하고 아무것도 저장하지 않는다. 정식 전사는 녹음을 멈춘 뒤 지금처럼 `transcribe --recording`이 만든다 (ARCHITECTURE.md §2.6).

- **입력:** tractus-rec가 쓰는 중인 `<dir>`. `recording.json`의 `tracks`를 읽는다. 아직 없으면 5초까지 기다리고, 끝내 없으면 있는 `mic.wav`·`system.wav`를 쓴다. 둘 다 없으면 `error`다. 트랙이 여럿이면 표본 위치끼리 더해 자른다(배치 전사의 amix normalize=0과 같다).
- **앱 실행:** 설정 "녹음 중 실시간 텍스트 변환 (미리보기)"을 켰을 때만 녹음이 시작되면 띄운다. argv로 실행하고(셸 없이) `TYPER_USE_RICH=0`을 준다. `<dir>`은 그 녹음의 폴더다. 회의를 여는 job으로 세지 않는다.
- **정지:** stdin `stop` 줄, stdin EOF, SIGTERM이면 남은 오디오를 마무리하고 `done`을 낸 뒤 종료 코드 0으로 끝난다(실측 0.2초, 상한 약 2초). **모델을 올리는 중에 정지가 오면** VAD·ASR 모델 사이에서 멈춘다: 아직 시작하지 않은 모델은 올리지 않고(ASR 0.6B 로드가 1–2초라 이것이 상한을 지킨다), 자막 없이 `done`(`audio_sec` 0)으로 끝난다. 이미 올리는 중인 모델 하나는 끝나기를 기다린다. 앱은 녹음을 멈출 때 먼저 `stop`을 보내고 끝나기를 기다린다(5초 넘으면 kill). 그다음 지금과 같이 `transcribe --recording`을 시작한다. 앱이 죽으면 stdin EOF로 같이 끝난다.
- **밀림 방어:** 루프는 step마다 디스크의 오디오를 모두 읽는다. 라이브 끝에서 `MAX_LAG_S`(10초)보다 뒤처진 발화는 **ASR을 돌리기 전에** 건너뛴다(`live_lagging` 경고 한 번, `done.stats.dropped_finals`). 보이던 `partial`이 있으면 그 문장으로 `final`을 내 화면에 `partial`이 남지 않게 한다. 그러므로 `final`이 나올 때 그 발화는 라이브 끝에서 약 10초 + ASR 한 번 안에 있다. 쌓인 양이 step 끝에서도 10초를 넘으면 밀린 오디오를 통째로 건너뛴다.
- **터미널:** `--progress-json` 없이 실행하면 이벤트를 내지 않고 확정된 자막만 `[mm:ss] 문장`(화자가 있으면 `[mm:ss] S1: 문장`) 줄로 stdout에 찍는다. `SIGINT`·`SIGTERM` 핸들러는 실행하는 동안만 걸고 끝나면 원래대로 되돌린다.
- **`--engine lite|std` (개발·벤치 전용, 앱은 쓰지 않는다):** 기본 `lite`(0.6B)가 위 동작 그대로다. `std`는 표준 엔진(1.7B)으로 같은 코드 경로를 돌려 실시간이 가능한지 재는 용도다(`bench/live_sim.py --engine std`, 결과는 `bench/results/live_summary.json`의 `engine`·`run`). 기능 잠금(`capabilities`의 `live`)은 여전히 0.6B를 요구한다.
- **표준 엔진(1.7B)으로도 되는지 잰 결과 (2026-10-14, M3 16GB): 안 된다 (`not_feasible`). 그래서 실시간 텍스트 변환은 계속 가벼운 엔진(0.6B)만 쓴다.** 같은 코드 경로를 `bench/live_sim.py --engine std`로 가상 `say` 대화(68초 두 번, 334초 한 번, 실시간)에 돌렸다. 판정 기준은 (a) `live_lagging` 경고·버려진 `final` 없음, (b) 확정 지연 p95 1.0초 이하(+25%인 1.25초까지는 단서를 달고 가능), (c) ASR 시간/오디오 길이 0.5 이하, (d) 최대 footprint 4.5GB 이하, (e) 5분 실행 중 메모리 증가 10% 이하이고 전부 통과해야 가능이다.

  | 지표 | 가벼운 엔진 (0.6B) | 표준 엔진 (1.7B) | 기준 |
  | --- | --- | --- | --- |
  | 확정 지연 p95 | 0.80–1.01초 (조용할 때 0.76초) | **1.59 · 1.73 · 1.95초** (68초 두 번·334초). p50 0.99–1.22초. 68초 실행의 p95는 발화 9개의 최댓값에 가까워 334초(발화 45개) 값이 더 믿을 만하다 | 1.0초 이하. **+59% ~ +95%라 단서 한도 1.25초도 넘는다** |
  | ASR 시간 / 오디오 길이 | 0.14–0.17 (조용할 때 0.118) | 0.29–0.33 | 0.5 이하, 통과 |
  | 최대 footprint | 1.85GB | 3.42–3.43GB (정상 상태 2.58GB, 순간 최대 3.4GB) | 4.5GB 이하, 통과 |
  | 켠 직후 점유(무음 30초) | 1.14GB | 2.54GB (**+1.40GB**) | — |
  | 334초 동안 메모리 증가 | +0.1% | +0.0% (구간별 최대 3.43 → 3.42GB) | 10% 이하, 통과 |
  | `live_lagging`·버려진 `final` | 0 · 0 | 0 · 0 (건너뛴 `partial` 2 · 2 · 9) | 없음, 통과 |
  | CER (`say` 대본 대비) | 0.150 (68초) · 0.164 (334초) | 0.186 (68초) · 0.178 (334초) | 참고. 표준이 더 낫지 않다 |

  이유: 1.7B는 호출마다 ASR 시간이 약 두 배(0.3 대 0.15)이고, 확정 지연은 설계상 무음 대기 0.51초에 ASR 한 번이 더해진다. 표준 엔진의 처리 지연 p95(무음 대기를 뺀 값)가 1.03–1.59초로 가벼운 엔진의 0.24–0.89초보다 길다. 실시간 속도(RTF)와 메모리는 문제가 없고 **확정 지연만 기준을 넘는다.** 품질에서 얻는 것도 없다(이 가상 음성 기준). 실행 중 부하 평균이 3–6이었다(백그라운드 보안 프로그램). 가벼운 엔진도 조용할 때보다 느려졌지만(p95 0.76 → 0.80–1.01초) 표준 엔진의 초과는 그걸로 설명되지 않는 크기라 다시 재지 않았다. 다시 따져 볼 길은 무음 대기를 늘리거나 미리보기 주기를 줄이는 것, 조용한 Mac에서 다시 재는 것이다. 결과 전체는 `bench/results/live_summary.json`의 `engine`·`run`.
- **메모리:** 물리 메모리 16GB 미만이면 `--force` 없이는 `error`(`code: live_low_memory`), 종료 코드 1이다. 앱과 기본 경로는 1.7B를 올리지 않는다(가벼운 엔진의 실측 최대 footprint 1.85GB. 표준 엔진은 위 실측대로 지연 때문에 쓰지 않는다).
- **화자:** 기본은 `speaker: null`이다. `--speakers`를 주면 Nemotron 스트리밍으로 `"S1"`…을 붙인다. 미리보기 안에서만 쓰는 라벨이라 최종 전사의 라벨과 다를 수 있다. GPU 사용률 증가분이 약 세 배가 되므로 앱은 쓰지 않는다(ARCHITECTURE.md §2.6).
- 모델(`silero-vad-v6`, `qwen3-asr-0.6b-8bit`)이 없으면 `error`(`code: model_missing`, 메시지에 `hf download …`), 종료 코드 1.

이벤트 (stdout JSON Lines):

```jsonc
{"event":"stage","stage":"live_load"}     // 녹음 파일을 기다리고 모델을 올린다 (약 2초). 그동안 쌓인 오디오는 뒤에 따라잡는다
{"event":"stage","stage":"live"}
{"event":"live","kind":"partial","id":"l0001","start":12.34,"end":15.40,"text":"오늘 회의는 다음 분기","speaker":null}
{"event":"live","kind":"final","id":"l0001","start":12.34,"end":16.02,"text":"오늘 회의는 다음 분기 예산 검토입니다.","speaker":null}
{"event":"warning","code":"live_lagging","message":"…"}  // 녹음을 따라가지 못해 밀린 구간을 건너뜀 (한 번만). 녹음·정식 전사에는 영향 없음
{"event":"done","stats":{"audio_sec":68.2,"asr_sec":8.1,"asr_rtf":0.119,"asr_calls":41,"finals":14,"partials":27,"skipped_partials":0,"dropped_finals":0,"peak_memory_gb":1.68}}
{"event":"error","message":"…","code":"live_failed"}   // 종료 코드 1. code: live_low_memory | model_missing | live_failed
```

- `start`·`end`는 녹음 시작 기준 초(소수 둘째 자리)다. `id`는 발화마다 `l0001`부터 늘어난다. 너무 짧아 버린 발화(기침·클릭)는 번호를 쓰지 않지만, **뒤처져 건너뛴 발화는 번호가 이미 매겨져 있어 `id`에 빈 번호가 생긴다.** `id`는 오름차순일 뿐 연속이라고 가정하지 않는다.
- **같은 `id`의 `partial`은 앞의 `partial`을 바꾸고, `final`은 그 `id`의 `partial`을 바꾼다.** `final` 뒤에는 같은 `id`가 다시 오지 않는다. `id` 순서는 시각 순서다.
- `partial`은 말이 이어지는 동안 약 3초마다, 그리고 0.19초 쉼마다 나온다. 쉼에서 나온 `partial`은 보통 0.3초 뒤 같은 문장의 `final`로 바뀐다. 뒤처지면 `partial`부터 건너뛴다.
- **`final`의 `text`가 빈 문자열이면 그 `id`의 줄을 지운다.** 보여 준 `partial`이 있을 때만 나온다(보여 준 적 없는 빈 발화는 아무 이벤트도 내지 않는다).
- `warning`은 종료가 아니다. 이 밖에 `--speakers`에서만 `diarizer_missing`·`diarizer_failed`가 나올 수 있다(화자 없이 계속).
- `done.stats`는 측정용이다. 앱은 쓰지 않아도 된다. 키는 늘어날 수 있다.

### 2.9 노트·녹음 삭제 (앱 전용, 코어 변경 없음)

삭제는 **앱만** 한다. `tractus delete`도, MCP 삭제 도구도 만들지 않았다. 이유:

- 검색 색인은 이미 폴더가 사라지면 스스로 정리한다(`Index.sync`: 없어진 노트의 청크·키워드 색인(`chunks_fts`)·벡터(`chunks_vec`)를 지운다, 임베더는 올리지 않는다. `tests/test_index.py::test_deleted_note_leaves_no_rows_or_vectors_without_loading_the_embedder`). `tractus index`·`search`·`ask`·MCP 모두 동기화부터 하므로 지워진 노트는 검색·질문에 나오지 않는다.
- 에이전트(MCP·CLI)가 사용자의 노트를 지우게 할 이유가 없다. 지우는 일은 확인 대화상자를 거치는 사람의 동작이다.

Tauri 명령 (`src-tauri/src/removal.rs`, `lib.rs`):

| 명령 | 인수 | 하는 일 |
| --- | --- | --- |
| `delete_meeting` | `id` (meeting_id) | `$TRACTUS_HOME/meetings/<폴더>`를 macOS 휴지통으로 옮긴다. 반환값 없음 |
| `delete_recording` | `dir` (녹음 폴더 절대 경로) | 변환 전 녹음 `$TRACTUS_HOME/recordings/<ULID>`를 휴지통으로 옮긴다 |

- **휴지통:** `trash` 크레이트(MIT) + `NSFileManager trashItemAtURL`. Finder 자동화 권한이 필요 없고 entitlement도 필요 없다(앱은 샌드박스가 아니다). 일부 시스템에서는 'Put Back'이 보이지 않을 수 있으므로 앱 안내는 "휴지통에서 폴더를 꺼내 원래 폴더에 다시 넣으세요"라고 쓴다. 영구 삭제는 하지 않는다.
- **검사(전부 통과해야 옮긴다):** ID는 영숫자만(`..`·`/`·`\` 거절) → `find_dir`로 폴더를 찾고(없으면 "노트를 찾을 수 없습니다") → 폴더가 `meetings/` 바로 아래의 진짜 폴더여야 한다(`symlink_metadata`로 링크 거절, 정규화한 부모가 정규화한 `meetings/`와 같아야 한다. `meetings/` 자체가 다른 곳으로 연결돼 있어도 그 아래 폴더는 허용) → `.job.json`이 있고 `transcript.json`이 없으면 거절(변환이 끝나지 않은 노트. 둘 다 있으면 끝난 노트라 허용, §2.7.2) → 그 노트를 쓰는 작업이 있으면 거절 → `transcript.json`의 `meeting_id`가 같아야 한다. 녹음은 `is_recording_dir`(ULID, `recordings/` 바로 아래) + 같은 폴더 검사 + 녹음·변환 중이면 거절.
- **쓰는 중 표시(`AppState.busy`):** `job_start`(`summarize`·`align`은 노트 ID, `transcribe`는 녹음 폴더, `import`는 `<import>`), `ask_start`(`--meeting`이 있는 질문은 그 노트), `rec_start`(녹음 폴더)가 프로세스 시작 때 대상을 올리고 `exit` 이벤트에서 내린다. 짧은 명령(`edit_segments`·`edit_speakers`·`export_meeting`·`voices_enroll`)도 호출하는 동안 그 노트를 올린다(`BusyGuard`, 끝나면 Drop으로 내림). 전체 질문(`--meeting` 없음)은 표시하지 않는다.
- **삭제와 저장 줄(앱):** 노트마다 하나의 저장 줄(`editQueue.ts`)에 문장 수정·참석자 편집·목소리 등록·내보내기가 선다. 삭제 확인을 누르면 줄을 막고(새 수정은 `노트를 삭제하는 중이라 지금은 수정할 수 없습니다`) 저장 중인 작업이 끝나길 기다린 뒤 `delete_meeting`을 부른다. Rust의 쓰는 중 표시는 그 사이를 뚫은 호출에 대한 방어선이다(없는 노트로 실패하지 않고 `이 노트를 처리하는 중이라 …` 문장으로 거절).
- **색인 정리:** 성공하면 백그라운드로 MCP `status`를 부른다(= `sync(embed=False)`). 실패해도 삭제는 성공이다(검색·질문이 먼저 동기화하므로 지워진 노트는 나오지 않는다).
- **오류 문자열:** 첫 줄이 화면 문장, 둘째 줄부터가 원래 오류(앱이 `자세히`로 접는다).
- **건드리지 않는 것:** 목소리 프로필(`voices.json`)과 자주 쓰는 단어(`glossary.md`)는 노트 데이터가 아니다. 노트를 지워도 그대로다.

### 2.10 `tractus note` (메모 노트와 제목 바꾸기, v3.18)

노트 제목을 바꾸고, 녹음 없이 직접 쓰는 **메모 노트**를 만든다. 세 명령 모두 stdout에 JSON 한 줄을 쓰고, 입력 오류는 종료 코드 2와 stderr 마지막 줄의 문장(WORDS.md §4.7)이다. 성공하면 키워드 색인을 조용히 갱신한다(`sync(embed=False)`, 바뀐 청크의 벡터는 대기 상태이고 앱의 조용한 색인 작업이 채운다).

| 명령 | stdin | stdout | 오류 (종료 코드 2, 아무것도 쓰지 않음) |
| --- | --- | --- | --- |
| `tractus note new [--title T]` | 선택. `{"title"?: str, "body"?: str}`. 비었거나 터미널이면 빈 메모 | `{"meeting_id": "01K…", "meeting_dir": "<절대 경로>"}` | 입력 형식, 제목 120자 초과, 본문 200,000자·5,000줄 초과 |
| `tractus note save <노트>` | `{"body": str}` (필수, 본문 통째로) | `{"saved": true, "segments": N, "changed": bool, "kind": "memo"\|"recording"}` (`N`: 메모의 줄 수. 메모 노트는 세그먼트 수와 같다) | 입력 형식, 한도 초과, 노트 없음. **메모 노트와 녹음 노트 모두 된다**(녹음 노트는 아래 "녹음 노트의 메모") |
| `tractus note title <노트>` | `{"title": str}` (필수) | `{"title": "<정리된 제목>"}` | 비었음, 120자 초과, 입력 형식, 노트 없음 |

- **제목 우선순위(`note new`):** `--title` > stdin의 `title` > `메모 HH:MM`(이 Mac의 현지 시각). 폴더는 `$TRACTUS_HOME/meetings/<YYYY-MM-DD>_<제목>_<ULID>/`(기존 `meeting_dir_name` 규칙).
- **제목 정리(`store.one_line` + 길이):** 공백·줄바꿈은 한 칸, 제어 문자는 뺀다. 1–120자(코드 포인트 기준, 이모지 하나는 1자). `note title`은 녹음·메모 모두 된다. **폴더 이름은 바꾸지 않는다**(찾는 기준은 ULID, 앱도 meeting_id로 찾는다). `note_lock` 안에서 transcript.json(+ md·vtt 다시 쓰기), `summary.json`의 `title`, `summary.md`의 첫 `# ` 줄을 새 제목으로 바꾸고(요약이 없으면 건너뜀), 색인을 갱신한다. 같은 제목이면 아무것도 다시 쓰지 않는다.
- **본문 정리(`note save`·`note new`):** `\r\n`·`\r` → `\n`, `\n`·`\t` 외의 제어 문자(C0·C1·DEL)는 뺀다. 줄 앞뒤 공백은 본문에 그대로 두되 세그먼트 텍스트에서는 `strip()`한다.

**메모 노트의 transcript.json** (schema_version 2, 평범한 노트 폴더다):

```jsonc
{ "schema_version": 2, "kind": "memo", "meeting_id": "01K…", "title": "장보기", "created_at": "2026-10-13T13:09:21+09:00",
  "audio": { "file": null, "duration_sec": 0, "source": "memo", "sha256": null },
  "body": "우유\n\n계란",          // 사용자 글 그대로 (\n 줄바꿈)
  "seg_seq": 2,                     // 마지막으로 낸 세그먼트 번호 (지워도 줄지 않는다)
  "speakers": {}, "diarization": null,
  "segments": [ { "id": "s0001", "start": 0.0, "end": 0.0, "text": "우유", "lang": null, "speaker": null, "corrected_text": null, "words": null, "line": 1 },
                { "id": "s0002", "start": 0.0, "end": 0.0, "text": "계란", "lang": null, "speaker": null, "corrected_text": null, "words": null, "line": 3 } ] }
```

- **`kind`가 없으면 녹음 노트다.** 옛 파일을 고치지 않는다. 판별은 `store.is_memo(t)`.
- **세그먼트 = 본문의 비어 있지 않은 줄**(`notes.derive_segments`). `line`은 본문을 `\n`으로 나눴을 때의 1부터 센 줄 번호(빈 줄 포함, 입력창의 줄과 같다). 앱은 `body`가 진실이고 `segments`는 거기서 만든 파생물이다.
- **ID 유지:** `note save`는 옛 세그먼트 텍스트 목록과 새 줄 목록을 `difflib.SequenceMatcher`로 맞춘다. 같은 줄은 ID를 이어받고, 같은 자리에서 고친 줄(`replace` 구간의 앞 `min(옛, 새)`개)도 ID를 이어받는다(**지시서에서의 변경:** 고친 줄에 새 ID를 주면 타자 한 번마다 ID가 소진돼 요약의 근거가 금방 끊긴다). 그 밖의 새 줄은 `seg_seq` 다음 번호를 받는다. 번호는 `s9999` 다음에 처음으로 돌아가 쓰이지 않는 번호를 고른다(ID 형식이 `s\d{4}`라 5자리를 쓰지 않는다. 그래서 줄 수 한도가 5,000이다). 줄이 지워지면 그 ID를 가리키던 요약 근거는 앱이 "없는 대화"로 처리한다.
- **요약이 낡았는지**는 앱이 정한다(앱이 센 편집 횟수). 코어는 `note save`가 `"changed": true`를 돌려줄 때만(본문 또는 세그먼트가 실제로 바뀜) 앱이 편집 횟수를 올릴 수 있게 한다.
- **md:** frontmatter `meeting_id`·`title`·`created_at`·`kind: memo`(`duration`·`asr_model` 없음), `# 제목`, 줄마다 빈 줄로 나눈 문단. **vtt는 만들지 않는다**(`render_files`가 메모는 건너뛴다).
- **다른 기능과의 관계:** 색인·검색(`Hit.segments[].line`, `start`·`end`는 0), `ask`(근거·인용에 `line`, 프롬프트 줄은 `[s0003] 내용`), `summarize`(시각 없는 프롬프트 `메모 제목: …`/`[s0001] …`와 메모용 시스템 문구, `summary.md`에 시각 없음), `export`(아래), MCP(`list_meetings.kind`, `search_meetings`·`get_transcript`의 시각 자리는 `n번째 줄`, 안내문에 한 줄 추가), 삭제(폴더째 휴지통, 변경 없음)가 그대로 동작한다.
- **export:** `txt`(제목, 일시, 빈 줄, 본문 그대로), `md`(transcript.md + 요약), `csv`(`줄,내용`), `docx`(일시만, 제목 `메모 내용`), `bundle`(audio·vtt 없음)은 된다. **`srt`·`vtt`는 종료 코드 2 + `메모는 자막 파일로 내보낼 수 없습니다.`** (`export.UnsupportedFormat`, `MEMO_FORMATS`).
- **거절하는 명령(종료 코드 2):** `align`(`no_audio` 코드), `speakers rename|set|merge|dismiss`, `segments edit`, `voices enroll`. `voices match`·`render`·`index`·`search`는 그대로 돌고 메모에는 할 일이 없다. `live`·`transcribe`는 녹음 전용이다.
- **한도:** 본문 200,000자(`notes.MAX_BODY`), 비어 있지 않은 줄 5,000개(`notes.MAX_LINES`), 제목 120자.
- **동시성:** `note save`·`note title`은 `edit_transcript`(= `note_lock`) 안에서 읽고 쓰므로 앱의 다른 편집과 서로 덮어쓰지 않는다. 같은 노트에 저장이 겹치면 나중 것이 이긴다(본문을 통째로 쓴다). 앱은 노트마다 저장 줄(`editQueue`)로 직렬화한다.

#### 녹음 노트의 메모 (오른쪽 패널 메모 탭, v3.18)

녹음 노트(`kind` 없음)도 사용자가 직접 적은 메모를 가질 수 있다. 앱은 오른쪽 패널의 마지막 탭(요약 / 회의록 / AI 질문 / 메모)에서 쓰고, 같은 `tractus note save <노트>`로 저장한다. 메모 노트가 입력창이 본문 전체인 노트라면 이것은 **녹음 옆에 붙는 글**이다. 녹음 중 남기는 메모·북마크(`memos.json`)와는 다른 것이다.

```jsonc
// transcript.json (녹음 노트)에 선택 키 "memo"가 생긴다. 없으면 메모가 없는 것이다 (옛 노트는 migration 없이 그대로)
"memo": { "body": "예산은 동결합니다\n\n견적은 김철수 님이 받습니다",   // 사용자 글 그대로 (\n 줄바꿈, clean_body를 거친 것)
          "lines": [ { "id": "m0001", "line": 1, "text": "예산은 동결합니다" },    // 비어 있지 않은 줄마다 하나, line = 1부터 센 줄 번호(빈 줄 포함)
                     { "id": "m0002", "line": 3, "text": "견적은 김철수 님이 받습니다" } ],
          "seq": 2 }                                                                // 마지막으로 낸 번호 (지워도 줄지 않는다)
```

- **저장:** `note save`는 `edit_transcript`(= `note_lock`) 안에서 `memo` 블록만 쓴다. `segments`·`words`·`speakers`·`summary`·오디오는 건드리지 않는다. **본문이 비었거나 공백뿐이면 `memo` 키를 지운다**(`changed`는 지울 것이 있었을 때만 true). 그래서 비운 뒤 다시 쓰면 번호가 `m0001`부터 새로 시작한다(요약에 남은 옛 `m` 근거가 새 줄과 겹칠 수 있음 — `ponytail` 주석). 한도·정리(`clean_body`, 200,000자, 5,000줄, 제어 문자, `\r\n`)와 오류 문장은 메모 노트와 같다. 같은 본문이면 다시 쓰지 않는다.
- **줄 ID `m####`**는 ASR 세그먼트 ID `s####`와 **다른 번호 공간**이다. 유지 규칙은 메모 노트와 같은 코드(`notes.derive_lines(body, old, seq, prefix)`: 같은 줄·같은 자리에서 고친 줄·끼워 넣으며 고친 줄(닮은 정도 0.5 이상)은 ID를 잇고, 새 줄은 `seq` 다음 번호, `m9999` 다음은 처음으로 돌아가 빈 번호). `store.memo_lines(t)`가 `[{id, line, text}]`를 돌려주고, 키가 없거나 형식이 달라도(손상·옛 노트) 빈 목록이다. 메모 노트(`kind: memo`)에는 `memo` 키가 없다(세그먼트가 메모).
- **transcript.md:** 대화 내용 뒤에 `## 메모` 절(줄마다 문단). **transcript.vtt는 그대로**(자막만).
- **색인·검색:** 메모 줄은 ASR 청크와 섞이지 않는 **자기 청크**(`store.memo_segments`: `start=end=0`, `line`, `source: "memo"`)로 같은 노트의 청크 뒤에 들어간다. 스키마는 그대로다(청크의 `segments` JSON에 `source`가 실린다). `Hit.segments[]`에 `{"id": "m0003", "line": n, "source": "memo", "start": 0.0, "end": 0.0, "text", "speaker": null}`, `Hit.source`는 `"memo"` \| `"transcript"`. 본문이 바뀌면 transcript.json이 바뀌어 다시 색인되고, 본문이 그대로인 청크는 벡터를 옮겨 쓴다.
- **MCP:** `search_meetings`의 세그먼트에 `source`(`"transcript"`\|`"memo"`)가 더해지고 메모 줄은 `id` `m0003`, `line` n(메모 본문의 줄 번호, 메모 노트의 줄에도 붙는다. 그 밖에는 null), `time` `메모 n번째 줄`, `cite` `[meeting_id#m0003 메모 n번째 줄]`이다. 앱은 `line`을 먼저 읽고, 없으면 `time`에서 줄 번호를 읽는다. `get_transcript`는 **마지막 쪽(`(끝)`) 뒤**에 `memo (사용자가 직접 적은 메모, 음성 인식 아님, N줄):` 구간과 줄마다 `[m0003 메모 n번째 줄] 텍스트`를 붙인다(중간 쪽에는 없다, 쪽 나누기는 ASR 세그먼트 기준). `list_meetings`(`segments` = ASR 세그먼트 수)는 그대로. `save_summary`는 `segment_ids`를 ASR ID ∪ 메모 ID로 검증하고, `list_action_items`의 `cite`는 전사 근거가 있으면 그 시각, 메모 줄뿐이면 `메모 n번째 줄`이다.
- **AI 질문:** 노트의 근거에 메모 줄이 **따로 라벨 붙은 블록 `[내가 적은 메모]`**(줄마다 `[m0003] 내용`)로 들어가고(노트 제목 줄 다음, **대화 기록보다 앞**이다. 뒤에 두었더니 solar-pro4가 20회 중 5회 메모를 못 보고 '근거 없음'으로 답해 앞으로 옮겼다(0/40). 메모와 대화가 함께 있으면 대화에는 `[대화 기록]` 라벨이 붙는다), 이때만 시스템 프롬프트에 메모 규칙(`ask.MEMO_PROMPT`)이 붙는다(메모 없는 노트의 프롬프트는 글자 하나 다르지 않다). 근거 형식 `{"segment_id": "m0003", "line": n, "source": "memo", "start": 0.0, …}`. `finalize`는 `[m0003]`·`[meeting_id#m0003]`을 근거와 대조해 받고, 인용은 `{"meeting_id", "segment_id": "m0003", "start": 0.0, "line": n, "source": "memo"}`(`source`는 메모 줄에만)다. 전체 범위 검색은 메모 청크를 포함하고 메모 줄도 앞뒤 1줄씩 함께 보낸다(ASR 대화와는 따로). 원격으로 나가는 것은 근거로 고른 줄뿐이라 데이터 최소화 규칙은 그대로다. `tractus ask`의 터미널 인용은 `[m0003 메모 n번째 줄]`.
- **요약:** 프롬프트 끝에 `사용자가 적은 메모:` 블록(줄마다 `[m0003] 내용`, 시각 없음)이 붙고 시스템 프롬프트에 `RECORDING_MEMO_PROMPT`가 붙는다. 요약 항목은 `segment_ids`에 `m` ID를 쓸 수 있다. 검증은 ASR ID ∪ 메모 ID. `summary.md`의 위치는 전사 근거 `[HH:MM:SS]`(주제는 `[시작–끝]`), 메모 근거 `메모 n번째 줄`(여러 줄이면 `메모 n–m번째 줄`), 섞이면 `[00:00:03–00:01:05, 메모 3번째 줄]`. 요약 JSON의 `segment_ids`에는 `m0003`이 그대로 남는다(앱은 현재 줄 번호를 다시 찾는다). 요약이 낡았는지는 앱이 정한다(메모 저장도 편집 횟수를 올린다, 코어가 더하는 것은 없다).
- **내보내기:** `txt`(대화 뒤 빈 줄, `메모`, 빈 줄, 줄마다), `md`(transcript.md와 같은 `## 메모` 절), `csv`(**표 모양 그대로 4열**, 대화 행 뒤에 `메모 n번째 줄,,,내용` 행: 시작 칸이 위치 표시. utf-8-sig 유지), `docx`(`대화 내용` 뒤 제목 `메모`, 줄마다 문단), `bundle`(transcript.json·md에 이미 포함). `srt`·`vtt`는 그대로(자막에 메모를 넣지 않는다).
- **위치 표기:** `store.stamp(s)`는 `source == "memo"`면 `메모 n번째 줄`, 메모 노트의 줄(`line`만)이면 `n번째 줄`, 그 밖에는 `HH:MM:SS`.
- **동시성:** 메모 저장과 문장 교정·참석자 편집·목소리 등록·정렬 병합이 모두 `note_lock` 안에서 읽고 쓴다. 다른 편집은 `{**t, …}`·`deepcopy`로 새 전사를 만들어 `memo` 키를 그대로 이어 가고(테스트로 고정), 녹음 노트의 `write_transcript`는 새 노트를 만들 때만 돈다.

- **메모 입력창 편집 도움(v3.50, 앱 `memoEdit.ts`).** 글은 Markdown 그대로 저장된다(코어는 모른다). Enter: 목록 줄(`- `, `* `, `1. `, `- [ ] `)이면 다음 줄에 같은 표지를 잇고(체크박스는 빈 칸, 번호는 +1), 내용 없는 목록 줄이면 표지를 지워 목록을 끝낸다. ⌘Enter: 지금 줄의 체크박스를 토글하고, 체크박스가 아니면 `- [ ] `를 붙인다. `[ ]` 안을 눌러도 토글한다. 고른 글에 ⌘B(`**`)·⌘I(`*`), 다시 누르면 벗긴다. 바뀐 부분만 `insertText`로 넣어 ⌘Z가 된다. 한글 조합 중·읽기 전용(녹음 추가 중)에는 하지 않는다.
- **요약을 메모로 보내기(v3.50).** 녹음 노트의 요약 패널 단추 `메모로 보내기`: 고른 요약을 복사와 같은 마크다운(할 일은 `- [ ]`)으로 메모 끝에 빈 줄 하나를 두고 붙인다. 쓰던 메모를 먼저 저장하고(`flushMemos`), 최신 본문에 붙여 `note save`(편집 줄 `editQueue`)한 뒤 메모 편집기를 새 본문으로 다시 연다. 메모 노트에는 단추가 없다(요약의 원본이 메모 본문이다).

### 2.11 `tractus transcribe --append-to` (글만 있는 노트에 녹음 추가, v3.19)

글만 있는 노트(메모 노트, §2.10)에 녹음을 더해 **평범한 녹음 노트로 바꾼다.** 노트의 폴더·제목·`meeting_id`·`created_at`은 그대로이고, 쓴 글은 녹음 노트의 메모(`memo` 블록)가 된다.

```
tractus transcribe <파일> --append-to <노트>            # 파일에서 추가 (앱 job kind import + appendTo)
tractus transcribe --recording <녹음 폴더> --append-to <노트>   # 녹음으로 추가 (앱 job kind transcribe + appendTo)
```

- **대상 검사(처리 전, 종료 코드 2, 아무것도 쓰지 않는다).** `--progress-json`이면 먼저 `error` 이벤트(`message`는 WORDS 문장)를 내고, stderr 마지막 줄도 같은 문장이다.

  | 코드 | 언제 | 문장 |
  | --- | --- | --- |
  | `append_note_missing` | 노트를 찾지 못함(없음·지워짐·ID가 모호함) | `‘{ref}’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.` |
  | `append_has_audio` | 메모 노트가 아님(= 이미 녹음이 있음) 또는 `audio.file`이 있음. 한 번 추가한 노트에 다시 `--append-to`해도 같다 | `이미 녹음이 있는 노트에는 녹음을 추가할 수 없습니다.` |
  | `append_remap_failed` (경고, 종료 코드 0) | 변환은 끝났지만 `summary.json`·`summaries/*.json`·`chat.json`이 깨져 있어 근거를 옮기지 못함 | `요약이나 질문 기록의 일부를 새 내용에 맞게 옮기지 못했습니다.` |

- **이벤트는 `transcribe`와 같다**: `stage(decode)` → … → `done`(`meeting_id` = 대상 노트, `meeting_dir` = 그 노트 폴더). 중복 파일(이미 변환한 같은 오디오)이면 `stage(decode)` → `warning(duplicate)` → `done`(**다른** 노트의 `meeting_id`)이고 대상 노트는 건드리지 않는다(종료 코드 0). 대상 검사가 중복 검사보다 먼저다. `title`·`--keep-tracks` 등 다른 옵션은 그대로이고 `--title`은 무시한다(제목은 노트의 것).
- **노트 폴더 안에서 돈다.** `audio.ogg`를 노트 폴더에 쓰고, `memos.json`(녹음 중 메모·북마크)은 새 녹음처럼 쓴다. 이어하기 파일 `.job.json`(새 필드 `attach: true`)·`.chunks.jsonl`도 그 폴더에 둔다. 평소 `store._clean_stale_job`은 `transcript.json`이 있으면 작업 파일을 낡은 것으로 지우지만, 노트가 **아직 메모 노트인 동안**(`store._job_pending`)은 지우지 않는다. 변환이 끝나 메모 노트가 아니게 되면 낡은 파일이 되어 지워진다. `find_job(meetings, sha, append_to=<meeting_id>)`는 그 노트에 덧붙이는 작업만, `append_to` 없이는 새 노트를 만드는 작업만 찾는다. 중단(종료 코드 130)해도 노트는 글만 있는 채 그대로이고 같은 명령으로 이어진다. 그 사이 앱·`tractus note save`로 글을 고쳐도 변환이 끝날 때 읽은 최신 글을 옮긴다.
- **변환(`attach.finish_append`, `note_lock` 안).** 새 변환 결과(`store.build_transcript`)를 노트에 합친다:
  - 쓰는 것: `schema_version`·`audio {file: "audio.ogg", duration_sec, source, sha256}`·`asr`·`speakers`·`diarization`·`segments`(ASR `s####`).
  - 지우는 것: `kind`(없음 = 녹음)·`body`·`seg_seq`. 쓴 글이 비어 있지 않으면 `memo {body, lines[{id m####, line, text}], seq}`(`notes.derive_lines(body, None, 0, "m")`, 줄 번호는 본문 기준 그대로).
  - 그대로 두는 것: `meeting_id`·`title`·`created_at`과 위에 없는 모든 키(다른 기능이 더한 선택 키 포함).
  - 줄 ID 옮김표 `attach.id_map`: 메모 노트의 세그먼트 `s####` → 같은 줄(`line`)의 `m####`. `line`이 없는 아주 옛 세그먼트는 순서로 짝짓는다.
  - **참조 옮기기.** 옮김표를 모르는 ID는 빠진다(그 인용 하나만. 항목·질문 기록은 남는다). 이미 `m####`인 ID는 그대로 둔다(끊긴 뒤 다시 돌아도 같은 결과).
    - `summary.json`: `topics`·`decisions`·`action_items`의 `segment_ids`를 옮기고 `summary.md`를 새 전사로 다시 만든다(`[메모 3번째 줄]`). 근거가 모두 빠진 항목은 `segment_ids: []`로 남는다.
    - `summaries/<key>.json`(§2.13 요약 유형별 요약): 모든 섹션 항목의 `segment_ids`를 같은 방식으로 옮기고 `.md`를 다시 만든다. 한 파일이 깨져 있어도 나머지는 옮긴다.
    - `chat.json`: 인용의 `segment_id`(→ `m####`)·`source: "memo"`·`start: 0.0`(`line`은 그대로), 답 문장 속 `[s0003]`(→ `[m0003]`, 못 옮기면 그 표기만 지운다), 인용이 모두 빠지면 `no_evidence`를 `true`로 다시 정한다. 다른 노트의 인용(`[<다른 ID>#s0003]`)은 건드리지 않는다.
    - 검색 색인: `transcript.json` 해시가 바뀌어 `sync`가 다시 만든다(메모 줄은 `source: "memo"` 청크, ASR 청크는 `transcript`). md·vtt는 `save_transcript`가 다시 쓴다(`## 메모` 절, vtt는 이제 만들어진다).
  - **정리 정보(§2.12)**: `favorite`·`tags`·`folder`는 다른 키처럼 그대로 이어지고 `updated_at`만 지금으로 올린다(녹음이 붙은 것은 내용이 바뀐 것이다). md 머리말에는 그 값이 그대로 다시 쓰인다.
  - **쓰기 순서**: `summary.json`·`summaries/`·`chat.json`을 먼저, `transcript.json`을 마지막에(완료 표시). 요약·질문 기록이 깨져 있으면 그 파일은 그대로 두고 `append_remap_failed` 경고만 낸다(노트는 변환된다).
- **기존 녹음 경로는 그대로다.** `--append-to`가 없으면 `write_transcript`(= `build_transcript` + 쓰기)가 새 노트를 만든다.

**녹음 폴더의 `attach.json`(앱이 쓴다).** `recordings/<ULID>/attach.json` = `{"meeting_id": "<대상 노트 ULID>"}`. 앱이 녹음을 시작하기 전에 쓰고, 녹음 헬퍼(`tractus-rec`)는 모른다. 코어는 읽기만 한다(`attach.read_attach_target(dir)`: 없거나 모양이 다르면 `None`). **`transcribe --recording`은 attach.json만 보고 덧붙이지 않는다**: 앱이 `--append-to`를 명시해 넘긴다(옛 앱·터미널 사용자가 모르는 새 노트 대신 기존 노트가 바뀌는 놀라움을 막는다). 변환이 성공하면 코어가 녹음 폴더의 파일을 모두 지우므로 attach.json도 사라진다.

**Tauri 쪽 (`src-tauri/src/attach.rs`).**

| 명령·구조 | 변경 |
| --- | --- |
| `rec_start(flags, target?)` | `target`(노트 ID)이 있으면 글만 있는 노트인지·쓰는 중이 아닌지 검사하고(`attach::check_target`), 녹음 폴더를 만들어 `attach.json`을 쓴 뒤 시작한다. 녹음하는 동안 그 노트를 쓰는 중(`busy`)으로 표시해 삭제를 거절한다. 시작하지 못하면 attach.json과 빈 폴더를 지운다 |
| `job_start(kind, target, job, appendTo?)` | `appendTo`는 `transcribe`·`import`만 받고(`attach::with_target`), 같은 검사 뒤 인수에 `--append-to <ID>`를 붙인다. 그 노트도 작업이 끝날 때까지 쓰는 중으로 표시한다 |
| `list_recordings` → `PendingRecording.attach_to` | attach.json의 노트 ID(없거나 형식이 다르면 null). 그 노트가 아직 있고 글만 있는지는 앱이 목록에서 본다(`attach.resolveTarget`) |

**앱 흐름(`app/src/attach.ts`의 `attachReduce`).** `idle → recording → converting → idle`(파일에서 추가·남은 녹음은 `idle → converting`). 대상 노트가 `recording`·`converting`인 동안 글은 읽기 전용이고 삭제·요약은 막힌다. 녹음 추가: 쓰던 글을 저장(`flushMemos`) → `rec_start(target)` → 녹음 화면(`‘제목’ 노트에 녹음 추가 중`) → 정지하면 `job_start(transcribe, appendTo)` → `done`이면 그 노트를 다시 읽어(노트 화면 `key`) 녹음 노트 모습으로 연다. 파일에서 추가: 파일 선택 또는 글만 있는 노트에 파일 하나를 끌어 놓기(놓으면 `‘제목’ 노트에 파일을 추가할까요?` 확인 대화상자가 먼저 뜬다: 노트가 녹음 노트로 바뀌어 되돌릴 수 없고, 읽던 노트를 실수로 바꾸지 않게) → `job_start(import, appendTo)`. 실패하면 노트는 글만 있는 채 그대로이고 남은 녹음은 사이드바에 `‘제목’ 노트에 추가할 녹음`으로 남아 같은 노트에 이어서 추가한다(노트가 없어졌으면 새 노트로 변환한다). 녹음을 더한 노트를 열면 요약이 있을 때 낡았다는 안내가 뜬다.

**테스트.** `tests/test_attach.py`(가짜 ASR·화자 분리 + 실제 FFmpeg, 18개 + `slow` 1개): 변환·ID 옮김(요약·질문 기록)·`memo` 블록·md/vtt·색인·알 수 없는 키 보존·빈 글·화자 분리, 오류(녹음 노트·두 번째 추가·없는 노트·중복·깨진 요약·변환하는 사이 다른 실행이 먼저 붙인 노트는 덮어쓰지 않음 — 종료 코드 2 `append_has_audio`), 이어하기(중간 글 수정 반영), 끝내지 못한 추가 뒤에 다른 파일을 추가하면 이전 파일의 청크를 이어받지 않고 모두 새로 전사(`_new_job`이 이전 `.job.json`·`.chunks.jsonl`을 비움), `find_job` 분리, `attach.json` 읽기와 비-자동 추가. `slow`는 실제 모델로 `say` 음성을 메모 노트에 덧붙인다. 앱: `attach.test.ts`(흐름 상태·대상 찾기·문구), `cargo test`(`attach.rs`: 대상 검사·attach.json·인수·남은 녹음).

### 2.12 노트 정리: 즐겨찾기·태그·폴더·순서 (v3.20)

노트에 즐겨찾기·태그·폴더를 붙이고 목록을 거르고 정렬한다. 모두 선택 키라 옛 노트는 그대로 열리고, 읽는 쪽은 키가 없거나 모양이 달라도 "정리하지 않은 노트"로 본다.

**데이터 (transcript.json 최상위, 노트 종류 무관, `edit_transcript`로만 쓴다)**

| 키 | 모양 | 규칙 |
| --- | --- | --- |
| `favorite` | `true` | 없으면 아님. `false`로 바꾸면 키를 지운다 |
| `tags` | `["아이디어", …]` | 20개까지, 한 개 30자(글자 수)까지. 앞뒤 공백·앞의 `#`·제어 문자를 떼고 NFC로 합치며, 공백은 한 칸으로 줄인다. 쉼표는 거절한다. 폭 없는 공백·BOM 같은 보이지 않는 서식 문자(Cf)는 뺀다(눈에 같은 태그가 둘이 되지 않게. 이모지를 잇는 ZWJ는 남김). 대소문자 구분 없이 같은 태그는 먼저 쓴 모양 하나만 남긴다(쓴 모양 그대로 저장). 빈 목록이면 키를 지운다 |
| `folder` | 폴더 ULID | 없으면 폴더 없음. 폴더 파일에 없는 ID(지워졌거나 손으로 고침)는 폴더 없음으로 읽는다 |
| `updated_at` | ISO 시각 | `store.edit_transcript`가 **내용**이 바뀐 저장(본문·대화 내용 수정·메모·제목·참석자 등)에서 올린다. 위 세 키만 바뀐 저장(`store.META_KEYS`)은 올리지 않는다. 없으면 `created_at`, 그것도 없으면 파일 수정 시각 (앱은 `created_at`까지) |

다른 쓰기 경로가 transcript.json을 통째로 새로 만들 때(예: 변환으로 노트를 바꿔 쓰기) `store.META_KEYS`의 키를 옮겨 와야 한다.

**`$TRACTUS_HOME/folders.json`** `{"version": 1, "folders": [{"id", "name", "parent": ID|null, "order": int, "created_at"}]}`. 읽기는 너그럽다(깨졌으면 빈 목록, 읽을 수 없는 항목·겹친 ID는 버림, 없는 부모는 최상위, 고리는 끊음). 쓰기는 `$TRACTUS_HOME/.folders.lock`(flock) 안에서 원자적으로 하고, 깨진 파일은 `folders.json.corrupt`로 옆에 남긴 뒤 새로 쓴다. 이름은 한 줄 40자 이하(`/` 불가, NFC, 보이지 않는 글자는 뺌), `none`(대소문자 무관)은 쓸 수 없고(CLI·MCP의 폴더 인수 `none`이 `폴더 없음`이라 이름으로 고를 수 없다), 같은 위치에서 NFC·casefold로 겹치지 않고, 깊이는 3단계까지다. 잠금 순서는 폴더 → 노트다.

**CLI (`organize.py`, `organize_cli.py`; 오류는 종료 코드 2 + WORDS 문장)**

| 명령 | stdout |
| --- | --- |
| `tractus note meta <노트>` + stdin `{"favorite"?: bool, "tags"?: [..], "folder"?: "<ID>"\|null}` | `{"favorite": bool, "tags": [..], "folder": ID\|null}` (저장된 값). 준 키만 바뀐다. 모르는 키·잘못된 형식·없는 폴더·태그 한도 초과면 아무것도 쓰지 않는다 |
| `tractus folders list [--json]` | `{"folders": [{id, name, parent, order, created_at}]}` (위치별 order·이름 순) |
| `tractus folders create --name N [--parent ID\|이름]` | `{"folder": {…}}` |
| `tractus folders rename ID --name N` | `{"folder": {…}}`. 이름만 바꾸고 그 폴더 노트의 transcript.md를 다시 만든다 |
| `tractus folders move ID --parent ID\|none` | `{"folder": {…}}`. 새 위치의 맨 끝. 자기 후손 안으로·하위 가지를 포함해 3단계를 넘게·이름이 겹치게 옮기면 거절 |
| `tractus folders delete ID` | `{"deleted": ID, "moved_notes": N, "moved_folders": M}`. 노트는 지우지 않는다: 노트는 상위 폴더(없으면 폴더 없음)로(노트별 `edit_transcript`), 하위 폴더는 한 단계 위로(이름이 겹치면 `이름 (2)`). 순서는 노트 → folders.json → md라 중간에 끊겨도 노트를 잃지 않고 같은 명령을 다시 하면 된다 |
| `tractus notes list [--json] [--favorite] [--tag T]… [--folder ID\|이름\|none] [--sort created\|updated\|title\|duration] [--order asc\|desc]` | `{"notes": [{meeting_id, title, kind, created_at, updated_at, duration_sec, favorite, tags, folder}]}`. 기본은 `updated` 내림차순. 태그는 모두 붙은 노트(AND), 폴더는 하위 폴더 포함. 제목 순서는 NFC·casefold 비교(로케일 무관, 코드 포인트 순서), 같으면 만든 시각·ID. 앱의 사이드바 순서도 같은 규칙이다(`foldKey`는 `toUpperCase().toLowerCase()`로 `ß`→`ss` 같은 접기를 맞추고 `cmpCodePoints`로 비교한다. 이모지 같은 보충 평면 글자의 자리가 JS 기본 `<`와 다르기 때문. 파이썬 `sorted(key=casefold)`와 같은 순서임을 `organize.test.ts`가 본다) |
| `tractus search … [--tag T]… [--folder …] [--favorite]` | 같은 필터로 검색 범위를 좁힌다. 태그는 필터일 뿐 검색어로 색인하지 않는다 (`Index.search(meeting_ids=)`, 키워드는 SQL, 벡터는 후보를 받아 거른다) |

MCP: `list_meetings`는 `favorite`·`tags`·`folder`(이름)·`folder_id`를 싣고 `tag`·`folder`·`favorite` 필터를 받으며, `search_meetings`도 같은 세 필터를 받는다(없는 폴더는 `ToolError`). `transcript.md` frontmatter에는 `tags: [a, b]`·`favorite: true`·`folder: <이름>`이 있을 때만 붙는다(Obsidian이 읽는다. 폴더 이름은 렌더할 때 folders.json에서 찾으므로 이름을 바꾸면 그 폴더 노트만 다시 만든다).

**앱 (`organize.rs`, `organize.ts`, `useOrganize.ts`, `NoteLibrary.tsx` 외)**

- Rust: `meetings::list`가 `favorite`·`tags`·`folder`·`updated_at`을 너그럽게 읽는다(이상한 값은 없는 것). `list_folders`(folders.json을 직접 읽음), `note_meta`(노트를 쓰는 중으로 표시), `folders_create|rename|move|delete`(바뀐 폴더 목록을 돌려줌, 이름은 `--name=` 꼴), `set_list_prefs`(설정 파일의 `list_sort`·`list_order`만 바꿈). 인수·한도는 코어와 같은 문장으로 한 번 더 검사한다.
- 사이드바: 제목 거르기 상자(⌘K 검색과 별개) + 순서 선택(최근 수정 순·만든 순·제목 순·길이 순)과 오름·내림 단추(설정에 저장, 기준을 바꾸면 처음 방향은 시각·길이 내림차순, 제목 오름차순) → `즐겨찾기`(있을 때) → `폴더`(나무, 접힘, 하위 폴더 포함 노트 수, `폴더 없음` 줄) → `태그`(칩과 노트 수, 여럿을 고르면 AND) → `전체 노트`(고른 폴더·태그로 걸러짐, `모두 해제`). 시각 순서는 그 시각의 날짜별로 묶고 제목·길이 순서는 묶지 않는다. 접힘은 `localStorage`(편의일 뿐, 없어도 동작).
- 바꾸기: 노트 줄을 폴더 줄에 끌어 놓기(**포인터 이벤트**로 직접 한다: `noteDrag.ts`. Tauri 창은 파일 끌어 놓기(`onDragDropEvent`)가 켜져 있으면 macOS에서 창 안의 HTML5 `dragover`·`drop`을 먼저 가져가므로(`wry` `drag_drop.rs`가 핸들러가 true일 때 WebKit에 넘기지 않는다) `draggable`·`dataTransfer`를 쓰지 않는다. 5px 움직이면 끌기가 시작되고 따라오는 말풍선이 보이며, 폴더 줄(`data-folder-drop`) 위에서 놓으면 옮기고 Esc는 취소한다. 마우스·펜만, 터치는 스크롤이 먼저), 줄의 `…` 메뉴(가리키거나 초점이 갈 때 보임: 즐겨찾기·`폴더로 이동…`·`태그 편집…`), 노트 머리의 ★(`aria-pressed`)·폴더 단추·태그 편집기. 폴더 만들기·이름 바꾸기는 줄 안 입력창, 폴더 메뉴의 `다른 폴더로 옮기기…`는 폴더 고르기(그 폴더와 하위 폴더는 목록에서 뺀다. 깊이·이름 겹침은 코어가 거절하고 문장을 알린다), 삭제는 확인 대화상자(노트는 남는다고 말한다). 모두 낙관적으로 먼저 보이고 노트별 저장 줄(`editQueue`)에 세워 저장하며, 실패하면 바꾼 키만 되돌리고 알린다.
- 태그 편집기: Enter·쉼표로 더하고 빈 칸에서 Backspace로 마지막 태그를 빼며 기존 태그를 제안한다(↑↓·Enter). 한글 조합 중에는 아무것도 하지 않는다(`isImeKey`, 쉼표는 조합이 끝난 뒤 처리).
- 성능: 줄은 `memo`로 막고(컨텍스트를 읽지 않고, 메뉴는 열 때만 올림) CSS `content-visibility: auto`로 화면 밖은 그리지 않는다. 합성 노트 2,000개: Rust 목록 읽기 약 0.2초(디버그 빌드), 정렬·걸러내기·태그 집계·나무 합쳐 수십 ms, 서버 렌더 2,002줄 약 0.2초. **작은 노트로 잰 값이다.** 코어는 노트를 열 때 transcript.json 전체를 해석하므로 비용은 노트 크기에 비례한다(1시간짜리 단어 타이밍 포함 약 0.9MB 노트 300개: `list_notes` 약 2초, 즉 노트당 약 6.5ms). 필터를 건 `matching_ids`·`list_notes`는 그 키(`"tags"`·`"favorite"`·`"folder"`)가 글자로 없는 노트를, 폴더 이름 바꾸기·삭제는 그 폴더 ID가 글자로 없는 노트를 해석하지 않고 건너뛴다(필터가 없는 목록은 모든 노트의 제목이 필요해 건너뛸 수 없다). 노트 수천 개 × 큰 노트면 목록 캐시가 필요하다.

**테스트.** `tests/test_organize.py`(38개: 태그·폴더 규칙·한도, 부분 갱신, 기본값이면 키 삭제, `updated_at`, 동시 편집·동시 폴더 만들기, 폴더 나무 연산·깊이·삭제 의미·이름 충돌, 깨진·이상한 파일, 목록·정렬(한글 제목)·필터, md frontmatter, 색인 필터, MCP, frontmatter가 YAML에서 문자열로 읽히는지). `app/src/organize.test.ts`(정렬(파이썬과 같은 순서)·나무·끌어 놓기 대상·태그·필터·낙관적 갱신·접힘·2,000개 성능), `noteDrag.test.ts`(포인터 끌기), `organizeView.test.ts`(서버 렌더), cargo `organize::tests`(폴더 읽기·인수·검증·설정 병합·목록 읽기·2,000개).

**알려진 한계.** `tractus folders order`(폴더 순서 바꾸기)는 없다(만든 차례). 앱의 끌어 놓기(포인터 방식)는 WKWebView에서 손으로 확인하지 못했다(`noteDrag.test.ts`가 가짜 DOM으로 문턱·놓기·취소만 본다. 같은 일을 줄 메뉴·노트 머리로 할 수 있다). 내용을 저장하면 앱이 코어가 올린 `updated_at`을 목록에 바로 반영한다(`touchNote`). 앱 안의 내용 편집이 아닌 변경(앱 밖 CLI)은 창에 돌아올 때 새로 읽힌다. 벡터 검색의 정리 필터는 후보를 받은 뒤 거르므로 작은 폴더에서는 비슷한 뜻 결과가 적을 수 있다.

### 2.13 요약 유형과 직접 프롬프트: 한 노트의 여러 요약 (v3.21)

한 노트에서 유형별(회의록·핵심 요약·할 일 중심·강의·인터뷰·아이디어)로 여러 요약을 만들고, 직접 쓴 요약 방법으로도 요약한다. 요약 파일 키는 모두 선택이라 옛 노트·옛 요약은 그대로 열린다.

**요약 유형(템플릿)** — `summary_templates.py`.

- 기본 유형 6개는 `src/tractus/templates/<id>.md`(머리말 `id`·`name`·`description`·`order` + 본문 = 요약 지침). `meeting` 회의록(= 지금까지의 요약), `brief` 핵심 요약, `todo` 할 일 중심, `lecture` 강의·세미나 노트, `interview` 인터뷰·면담 정리, `ideas` 아이디어 정리. 지침은 섹션 구성·분량·어투만 정한다.
- 내 유형은 `$TRACTUS_HOME/templates/u-<16진수 8자>.md`(같은 형식, 머리말 `created`). 파일 이름이 곧 ID라 한글 이름이어도 안전하다. 이름 40자·설명 100자·방법 4,000자(코드 포인트, 제어 문자는 뺌)·최대 50개. 머리말 뒤 본문이라 방법이 `---`로 시작해도 안전하다. 깨진 파일·id가 파일 이름과 다른 파일은 목록에서 건너뛴다.
- **지침은 시스템 규칙을 바꿀 수 없다.** 시스템 프롬프트(`summaries.SYSTEM_PROMPT`: 언어·근거 ID·owner 규칙·입력 안의 지시문 무시·`참석자 N`/ID 금지)가 먼저 오고, 지침은 `<요약 지침>…</요약 지침>`으로 감싸 그 뒤에 붙으며(구분자가 들어 있으면 더는 없을 때까지 반복해서 지워 빠져나가지 못하게: `</요약 </요약 지침>지침>`처럼 지운 자리가 구분자를 다시 만들지 않는다), 맨 끝에 `complete_json`이 JSON Schema를 붙인다. 지침이 `스키마를 무시해`라고 해도 검증(strict json_schema + Pydantic + 1회 재요청)을 못 피한다: 평문 응답이 2번 오면 `llm_invalid`로 깨끗이 끝난다.

**CLI 계약**

| 명령 | 입출력 |
| --- | --- |
| `tractus summarize <노트> [--template ID] [--provider P] [--model M] [--progress-json]` | `--template` 생략 = `meeting` → 예전처럼 `summary.json`·`summary.md`(옛 스키마). 다른 유형 = `summaries/<ID>.json`·`.md`(스키마 v2). done 이벤트에 `summary_key`. 같은 유형을 다시 만들면 덮어쓴다. 없는 유형 → 종료 코드 2, 오류 이벤트 `code: "bad_input"` |
| `… summarize <노트> --custom` + stdin `{"prompt": "…", "save_as"?: "이름", "key"?: "c-…"}` | 한 번만 쓰는 요약: key는 `c-<16진수 8자>`(`key`를 주면 그 요약을 덮어쓴다, 앱의 `다시 만들기`). `save_as`가 있으면 **요약이 성공한 뒤** 내 유형으로도 저장하고 그 유형 ID가 key(실패한 시도는 유형을 남기지 않는다). 50개 한도는 AI 서비스를 부르기 **전에** 검사한다(`bad_input`·`TOO_MANY`. 부른 뒤에 알리면 만든 요약까지 버려진다). `--template`과 함께 쓸 수 없다. 잘못된 입력은 종료 코드 2·`bad_input`(AI 서비스를 부르기 전) |
| `tractus templates list [--json]` | `{"templates": [{id, name, description, prompt, builtin}]}` (기본 유형 → 내 유형) |
| `tractus templates save --name N [--description D] [--id u-…]` + stdin `{"prompt"}` | 저장한 유형 하나(같은 키). `--id`는 고칠 내 유형. 기본 유형 ID·없는 ID·한도 초과는 종료 코드 2 + WORDS 문장 |
| `tractus templates delete ID` | `{"deleted": ID}`. 기본 유형은 거절. 그 유형으로 만든 요약 파일은 남는다 |
| `tractus summaries <노트> list [--json]` / `delete KEY` | `{"summaries": [{key, template, name, title, generated_at, provider, model, custom}]}` (기본 → 기본 유형 순서 → 내 유형·직접 요약 만든 순). 앱도 같은 순서다: Rust `read_docs`가 기본 다음 파일들을 `generated_at`(같으면 key) 순으로 돌려주고, 기본 유형은 `orderDocs`가 목록 순서로 다시 놓는다(내 유형·직접 요약의 key는 무작위라 파일 이름 순은 만든 순서가 아니다). key `meeting`은 `summary.json`. `delete`는 json+md를 지우고 `{"deleted": KEY}`, 없거나 모양이 틀린 key는 종료 코드 2 (경로 조작 불가: key는 `[a-z]{3,12}`·`u-…`·`c-…`만) |

**요약 파일**

- `summary.json`(+`.md`): 기본(회의록). 옛 스키마(`title`·`summary`·`topics`·`decisions`·`action_items`)를 그대로 쓰고 MCP `save_summary`도 여기에 쓴다. 옛 파일은 옮기지 않는다 — 읽는 쪽이 옛 스키마(`sections` 없음)를 `회의록`으로 본다.
- `summaries/<key>.json`(+`.md`) 스키마 v2: `{"schema_version": 2, "meeting_id", "template", "template_name", "prompt_hash", "prompt"?, "provider", "model", "generated_at", "title", "overview", "sections": [{"heading", "style": "bullets"|"checklist"|"numbered", "items": [{"text", "segment_ids", "owner"|null, "due"|null}]}]}`. `prompt`는 기본 유형이 아닐 때만(직접 요약·내 유형: 앱이 `다시 만들기`·`템플릿으로 저장`에 쓴다), `prompt_hash`는 지침의 sha256 앞 12자. 모든 항목에 근거 ID(`s####` 대화, `m####` 메모, 노트에 있는 것만)가 필수이고 `clean_owners`(이름을 붙인 참석자만, `S1`·`참석자 N`·ID·확정되지 않은 목소리 제안 이름은 null)가 모든 섹션에 적용된다. 내용이 하나도 없는 응답(개요도 항목도 없음)은 재요청 대상이다. md는 `## 섹션`, 항목 끝 ` [00:00:03]`·` [메모 3번째 줄]`, 체크리스트 `- [ ] … — 담당, 기한`.
- 제목 바꾸기(`note title`)는 모든 요약 파일의 `title`·md 첫 제목을 함께 바꾼다. 검색 색인에는 들어가지 않고(변경 없음), `bundle` 내보내기에는 `summaries/`의 json·md가 들어간다. 노트를 삭제하면 폴더째 휴지통이라 요약도 함께 간다. 노트 목록의 `요약 없음` 배지(`has_summary`)는 어느 요약이든 있으면 사라진다(Rust `summaries::any_summary`). MCP `list_meetings`의 `has_summary`도 같다(`summaries.has_any_summary`).
- MCP: `get_summary(meeting_id, template?)`는 기본 요약 또는 지정한 key의 md(없으면 가진 key 목록과 함께 `ToolError`). 기본 요약이 없어도 다른 유형의 요약이 있으면 "없다" 대신 그 key들과 `template=<key>`로 읽을 수 있다고 알려 준다(에이전트가 `save_summary`로 덮어쓰지 않게). `save_summary`는 기본 요약만 쓴다. `list_action_items`는 **기본 요약만** 읽는다(유형별 요약의 체크리스트는 모으지 않는다 — 같은 할 일이 유형마다 되풀이될 수 있어서).
- md·docx 내보내기는 요약 하나를 싣는다: `tractus export … --summary KEY`(앱은 요약 탭에서 고른 요약의 key를 넘긴다), 안 주면 기본 요약, 기본 요약이 없으면 처음 있는 요약. 없는 key는 종료 코드 2(`요약을 찾을 수 없습니다.`). docx는 기본 요약을 `요약`·`결정 사항`·`할 일`로, 유형별 요약을 `요약 · 이름`과 섹션(번호·체크 모양대로)으로 쓴다. txt·srt·vtt·csv에는 요약이 없고 bundle은 모든 요약을 싣는다.

**개인정보.** 원격 AI 서비스로 나가는 것은 전과 같은 노트 내용(대화 내용 + 메모)에 요약 지침(내가 쓴 방법 포함)이 더해진 것뿐이다. 오디오·다른 노트·질문 기록은 나가지 않는다. 노트 안의 지시문은 요약할 내용일 뿐이다(모든 유형에서 주입 문구가 시스템 프롬프트에 섞이지 않음을 테스트로 고정).

**측정 (solar-pro4, 가상 전사만, 2026-10-14).** `uv run pytest -m llm -k "template or custom_prompt"`(7개: 유형 5 + 직접 요약 스키마 방어 + 전사 속 지시문 무시, 이름 없는 화자 라벨 `S1`·`S2`를 붙인 어려운 입력 포함) 4회: 28/28 통과(지침 다듬기 전 2회 14/14, 다듬은 뒤 2회 14/14). 확인한 것: 스키마 통과, 모든 항목에 근거, owner에 `S#`·`참석자 N` 없음, 한국어, 유형별 형태(`brief`는 섹션 1개·항목 3–7개, `todo`는 체크리스트에 김민수·박지영, `lecture`는 TTL·write-back 포함, `interview`는 질문별 섹션 2개 이상, `ideas`는 아이디어별 섹션 + 다음 단계). 지침을 다듬은 것: 시스템 규칙에 `owner는 그 일을 하기로 한 사람, due는 그 일의 기한`(인터뷰에서 고객사 담당자가 후속 조치 담당으로 들어간 사례)과 `같은 내용을 되풀이하지 않는다`(아이디어의 다음 단계가 중복된 사례)를 더했다. 이 수치는 가상 전사 5건의 통과율이며 유형별 요약 품질(사람이 보는 정확도)은 재지 않았다.

**앱 (`summaries.rs`, `summaries.ts`, `summaryQueue.ts`, `SummariesPanel.tsx`, `CustomSummaryDialog.tsx`, `TemplatesSettings.tsx`)**

- Rust 명령: `templates_list|templates_save|templates_delete`(코어 `templates`를 부름, 이름·설명은 `--name=`·`--description=` 꼴), `summaries_list`(요약 파일을 직접 읽어 원본 JSON + `key`를 돌려줌, 깨진 파일·이상한 이름은 건너뜀), `summaries_delete`(`summaries <노트> delete`), `summary_start`(`job_start`와 같은 `job` 이벤트·노트 삭제 막기, `--template ID` 또는 `--custom` + stdin). 모든 ID·key는 모양을 검증해 인수에 넣는다.
- `요약` 탭 맨 위: `요약 유형` 메뉴(체크박스 목록: 기본 유형 + 설명, 내 유형, `직접 프롬프트로 요약…`) + `요약 만들기`. 여러 유형을 고르면 **차례로** 하나씩(`summaryQueue.ts`) 돌고 진행 줄에 `n / N · 이름 · 단계`가 보인다. 하나가 실패하면 남은 것은 멈추고 실패한 유형 이름과 오류를 보인다. (기존 작업 UI에 취소가 없어 취소는 두지 않았다.)
- 만든 요약은 탭(유형 이름)으로 고르고, 선택한 요약에 `요약 복사`·`다시 만들기`·`삭제`(앱 안 확인). 낡은 요약 안내는 요약마다 따로다(요약을 만들 때의 편집 횟수 기준). 새 요약은 개요 + 섹션(번호·체크리스트·글머리 스타일, 담당·기한, 시각·`메모 n번째 줄` 근거 칩), 옛 요약은 예전 모양 그대로. 복사·PDF 인쇄(`printDoc(detail, 고른 요약)`)는 고른 요약 하나만이다.
- 직접 프롬프트 대화상자: 요약 방법 입력(글자 수 `n / 4,000`, 예시 placeholder), `템플릿으로 저장` + 이름. 네이티브 모달 `<dialog>`, Esc 취소, ⌘Enter가 만들기(Enter는 줄바꿈, 이름 칸은 Enter), 글자 조합(IME) 중에는 키를 가로채지 않는다.
- 설정 › 요약 템플릿: 기본 유형(읽기 전용, `요약 방법 보기`, `복사해서 만들기`)과 내 유형(이름·설명·방법 고치기, 삭제는 앱 안 확인).

**테스트.** `tests/test_templates.py`(42개: 로더·머리말, 내 유형 CRUD·한도·오류 문장·종료 코드·깨진 파일, 요약 저장 위치·덮어쓰기·목록 순서·삭제, 옛 요약 읽기, 직접 요약·`save_as`·`key` 덮어쓰기·실패 시 유형 미저장, 적대적 지침(구분자 닫기·평문 응답), 근거·owner 검증, md 렌더링, bundle, 제목 바꾸기, MCP `template` 인수, 모든 유형에서 주입 문구 분리). `tests/test_llm_smoke.py`의 `-m llm` 7개. `app/src/summaries.test.ts`(파일 읽기·순서·탭 이름·복사 md·인쇄 모델·유형 고르기·다시 만들기·입력 검사), `summaryQueue.test.ts`(차례 실행·실패 중단), `print.test.ts`, cargo `summaries::tests`(ID·인수·입력 검사·너그러운 읽기).

**알려진 한계.** `list_action_items`는 기본 요약만 본다. 앱의 여러 유형 만들기는 취소할 수 없다(프로세스를 멈추는 UI가 작업에 없다). 지운 내 유형으로 만든 요약은 `prompt`가 파일에 남아 있어 `다시 만들기`가 새 직접 요약으로 만들어진다. 요약 유형 메뉴·직접 프롬프트 대화상자는 WKWebView에서 손으로 확인하지 못했다(vitest·cargo·tsc만). 요약 방법에 노트 밖의 내용을 지어내라는 지침을 써도 막지는 못한다(근거 ID 검증이 노트에 없는 ID와 근거 없는 항목만 거른다).

### 2.14 AI 서비스·API 키·연결 테스트 (v3.22, v3.32에서 여러 서비스로, v3.33에서 서비스별 설정·서비스 고르기·Upstage 스마트 검색)

설정 › `AI 요약·질문`에서 서비스(Upstage·OpenAI·Claude·Gemini·직접 입력(OpenAI 호환))와 서비스 주소·API 키·AI 모델을 정하면 `.env.local` 없이 요약·AI 질문이 돈다. 설계 근거는 `docs/llm-providers.md`. 새 라이브러리는 없고, 코어의 서비스 표(`llm.PROVIDERS`)와 `openai` SDK가 그대로 일한다.

- **설정(`settings.json`, 더하기만, v3.33).** `llm_default`(기본 `upstage`: 서비스를 따로 고르지 않을 때), `llm_profiles`(`{서비스: {base_url, model}}`: 서비스마다 따로, `""` = 서비스 기본값), `embedding_provider`(`local` 기본 | `upstage`, 아래). **예전 `llm_provider`·`llm_base_url`·`llm_model`은 읽을 때 옮긴다**(`llm_key::migrate_llm`: 그 서비스가 `llm_default`가 되고 비어 있지 않은 주소·AI 모델은 그 서비스의 프로필이 된다. 새 형식이 이미 있으면 예전 값은 버리고, 다음에 저장하면 예전 키는 파일에서 사라진다). 모르는 서비스 이름은 버리거나 `upstage`로 되돌린다. `save_settings`는 이 세 값을 지금 값으로 지킨다: 서비스 선택은 `llm_settings_save(provider, base_url, model)`(한 서비스의 프로필만)·`llm_default_save(provider)`·`embedding_provider_save(provider)`만 바꾼다(주소·AI 모델 검사 후 그 키만 병합 저장). 화면이 오래된 설정 객체를 되돌려 보내도 덮어쓰지 못한다. 화면은 기본값과 같은 주소·AI 모델을 빈 값으로 저장한다(기본값이 바뀌면 따라간다).
- **키 파일.** 앱 설정 폴더(macOS `~/Library/Application Support/dev.tractus.app/`)의 서비스별 파일, `0600`(만들 때 `OpenOptions::mode`, 다시 쓸 때도 맞춘다), 임시 파일 + rename. **Upstage는 예전 이름 그대로 `llm_key`**, 나머지는 `llm_key.openai`·`llm_key.claude`·`llm_key.gemini`·`llm_key.custom`. 서비스 이름은 고정 목록(`upstage|openai|claude|gemini|custom`, `^[a-z0-9-]+$`)에 있는 것만 파일 이름에 쓴다. `$TRACTUS_HOME`(노트 폴더)에는 두지 않는다. 동기화될 수 있기 때문이다.
- **명령.** `llm_key_status(provider)` → `{"saved": bool}`, `llm_key_save(provider, key)`(트림, **5**~200자, 인쇄 가능한 ASCII만), `llm_key_delete(provider)`(없어도 성공), `llm_settings` → `{default, profiles: {서비스: {base_url, model}}, saved: {서비스: bool}, registered: [서비스], env_override, provider_fixed, embedding_provider}`(키는 불리언만. `registered`는 쓸 수 있는 서비스 = 키가 있거나 이 Mac 주소의 직접 입력, 표의 순서. `default`는 `llm_default`가 등록돼 있으면 그것, 아니면 등록된 첫 서비스. `env_override`는 셸·`.env.local`·노트 폴더 `.env`의 `TRACTUS_LLM_*`가 화면 선택보다 먼저 적용되는가, `provider_fixed`는 그중 서비스 자체를 환경이 정하는가), `llm_settings_save`, `llm_default_save`, `llm_test(provider?)`, `llm_models(provider?)` → `{models, code, message}`(`tractus llm models`, 연결 테스트와 같은 35초 제한). 키는 webview로 돌아오지 않고 `settings.json`·인수·로그·진행 이벤트·오류 문구·`chat.json`에 들어가지 않는다.
- **주입.** `Settings::tractus_llm(args, provider?)`가 `tractus`와 같되 **이번에 고른 서비스(없으면 기본 서비스)의 키만 그 서비스의 환경변수로** 더한다(요약·질문·연결 테스트·모델 목록은 `provider`를 인수로 받는다. 모르는 서비스는 실행하지 않고 오류): `UPSTAGE_API_KEY`·`OPENAI_API_KEY`·`ANTHROPIC_API_KEY`·`GEMINI_API_KEY`·직접 입력은 `TRACTUS_LLM_API_KEY`. 앱 프로세스 환경에 그 변수가 이미 있으면 넣지 않는다(셸 > 저장한 키 > `.env.local`·`.env`). **앱이 서비스를 정할 때는 `TRACTUS_LLM_PROVIDER=<서비스>`와 `TRACTUS_LLM_BASE_URL`을 키와 함께 늘 싣고, 비어 있지 않으면 `TRACTUS_LLM_MODEL`도 싣는다.** 셸·`.env.local`·`.env`(`ask::llm_config`와 같은 순서)가 다섯 서비스 중 하나(예: 저장소 `.env`의 `TRACTUS_LLM_PROVIDER=upstage`)를 정해 두어도 앱이 고른 서비스가 이긴다: 안 그러면 Gemini를 등록해도 연결 테스트·모델 목록·요약이 Upstage로 돌았다(2026-10-15 리뷰). 환경이 다른 서비스를 정해 두었고 AI 모델 칸이 비어 있으면 그 서비스의 모델이 새지 않게 이 서비스의 기본 AI 모델을 싣는다(`default_model`). 환경이 앱 밖의 서비스(`gemma-local` 등)를 정했거나, 고른 서비스를 쓸 수 없는 채 환경이 서비스를 정했으면(키를 `.env.local`에만 두는 개발 환경) 환경 것이므로 아무것도 싣지 않는다(`provider_fixed`는 앞의 경우만). **주소 칸이 비어 있으면 서비스 기본 주소를 싣는다**(프로세스 환경변수는 dotenv 값이 덮지 못한다). 안 그러면 `$TRACTUS_HOME/.env`(노트 폴더, 동기화·공유될 수 있다)나 셸의 `TRACTUS_LLM_BASE_URL`이 고른 서비스의 키와 대화 내용을 받는다. 주소가 없는 직접 입력은 키를 싣지 않는다. 처음 상태(Upstage, 키 없음, 기본 주소·AI 모델)는 지금까지와 똑같이 아무것도 싣지 않는다. **서비스별 변수(`UPSTAGE_BASE_URL`·`<서비스>_MODEL` 등)는 앱이 싣지 않는다**: 앱은 늘 고른 서비스의 `TRACTUS_LLM_BASE_URL`(프로필 주소, 비면 기본 주소)을 싣고, 코어는 전역 값을 서비스별 값보다 먼저 쓴다(서비스가 같을 때). 그래서 `.env`의 서비스별 주소는 앱에서는 키를 받지 못한다(CLI에서만 쓴다). **쓰는 곳은 AI 서비스를 부르는 실행뿐이다:** 요약 작업(`job_start` kind `summarize`, `summary_start`의 유형·직접 요약), `ask_start`, `llm_test`, `llm_models`. 녹음·실시간·변환·정렬·나머지 명령에는 어떤 서비스의 키도 주소도 넣지 않는다(`tests`: `injection_follows_the_selected_provider`). 예외는 아래 Upstage 스마트 검색뿐이다.
- **직접 입력의 키.** 비워도 되는 것은 주소가 이 Mac(localhost·127.0.0.1·::1, Ollama 등)일 때뿐이다. 화면이 막고, 코어(`resolve_provider`)가 요약·질문에서 다시 막고(`llm_config`), `llm_test`는 실행하기 전에 Rust가 한 번 더 본다.
- **전송 안내.** `llm_config`는 환경이 정한 값이 먼저이고 없으면 화면의 선택을 돌려준다: `{provider, model, local_only, host}`. `host`는 서비스 기본 주소가 아닌 주소를 쓸 때의 호스트(`host[:포트]`)이고 주소 전체는 화면으로 나가지 않는다. 키가 없는 서비스는 `provider: null`(설정되지 않음, 이 Mac 주소의 직접 입력은 예외). 안내문은 `{AI 서비스}({AI 모델})로 전송됩니다. 보내는 곳: {호스트}`이고, 호스트가 이 Mac이면 `이 Mac의 AI(...)가 처리합니다`.
- **연결 테스트.** `llm_test(provider)`는 저장된 선택과 키로 `tractus llm test`를 **인수 없이**(서비스·주소·AI 모델은 위 환경변수로) 돌려, 요약·질문과 같은 해석·환경을 쓴다. 한 번에 하나만 돌고(대상 `<llm-test>`, 노트는 잠그지 않는다) 결과는 `{ok, provider, model, host, latency_ms, empty}`(응답이 비어 와도 `ok`: `empty`면 화면은 `응답을 받았습니다`) 또는 `{ok: false, code, message}`다(실행하지 못했을 때만 reject). 화면은 `연결 테스트` 단추를 누르면 입력한 내용을 먼저 저장하고 시험한다. 코어 `tractus llm test [--provider P] [--model M]`는 한 줄 JSON `{"ok":true,"provider":…,"model":…,"host":"api.anthropic.com","latency_ms":N}`을 stdout에 내거나(요청은 짧은 질문 한 번, 출력 토큰 16개 제한, 재시도 없이, 읽기마다가 아니라 **총 30초 제한**: 코어가 스레드로 재고 앱은 35초에 프로세스를 죽여 `<llm-test>` 잠금을 푼다), error 이벤트 한 줄 + 종료 코드 1을 낸다. 키는 어디에도 출력하지 않는다.
- **코어 규칙.** `TRACTUS_LLM_BASE_URL`은 서비스 기본 주소를 바꾼다(http/https + 호스트, 끝의 `/` 정리, 계정 정보·공백·역슬래시가 든 주소는 `llm_config`). `TRACTUS_LOCAL_ONLY`는 이름이 아니라 **주소의 호스트**로 판단한다(파싱한 호스트가 정확히 `localhost`·`127.0.0.1`·`::1`일 때만 통과: `localhost.evil.com`·`user@host` 속임수는 막는다). Claude(호환 계층이 Claude 4.7 이상에서 온도 1 미만을 거절)와 OpenAI(gpt-5·o 계열이 기본값이 아닌 온도를 거절하고 AI 모델 이름은 사용자가 고른다)는 온도를 보내지 않는다(`Provider.temperature=None`). 나머지는 0.2다. 코어는 **3xx를 따라가지 않는다**(`follow_redirects=False`): 설정한 주소가 이 Mac 확인·로컬 전용 검사를 통과한 뒤 다른 호스트로 대화 내용을 넘기지 못하게 한다. 3xx는 `llm_api`로 보인다. 엄격 JSON(`response_format`)은 표의 `json_schema`가 참인 서비스에만 붙고, Claude·직접 입력은 프롬프트 + 검증 + 1회 재요청이다.
- **화면(설정).** 서비스 다섯이 줄지어 보이고 서비스마다 `등록됨`/`미등록` 배지(기본 서비스는 `기본` 배지도)가 붙는다. 누르면 그 서비스의 칸이 열린다: 주소 칸에 그 서비스의 기본 주소가 채워지고(placeholder도 같다), AI 모델 칸은 비워 두고 placeholder가 기본값(없으면 `AI 모델 이름을 입력하세요`)을 보인다. **서비스마다 주소·AI 모델·키를 따로 저장한다.** AI 모델이 필요한 서비스(OpenAI·직접 입력)는 이름 없이 `저장`·`연결 테스트`가 막힌다. 직접 입력은 주소도 필요하다. `기본으로 사용`은 등록된 서비스만 고르고, 처음 등록한 서비스는 저절로 기본이 된다. `AI 모델 목록 불러오기`는 입력한 내용을 저장한 뒤 `llm_models`로 서비스가 아는 이름을 받아 AI 모델 칸의 `<datalist>`(제안)로 보인다(`/models`가 되는 서비스는 어디서나). https가 아닌 주소는 이 Mac이 아니면 경고한다(막지는 않는다). 키 입력창은 `type=password`, 저장하면 비우고 다시 채우지 않는다. 요약·질문이 `llm_config`로 끝나면 `AI 키가 없어 …`와 `설정 열기`, `llm_auth`·`llm_model`도 `설정 열기`를 보인다(`llmKey.ts`, 나머지 코드는 문장만).
- **요약·질문마다 서비스 고르기(v3.33).** 요약 탭(`요약 유형` 옆)·노트 AI 질문 입력창·전체 노트 질문 서랍에 `AI 서비스` 칸(`LlmServicePicker.tsx`)이 있다. **등록된 서비스만** 나오고 하나뿐이면 보이지 않으며 환경이 서비스를 정하면(`provider_fixed`) 감춘다. 처음 값은 기본 서비스, 고른 서비스는 요약·질문 기능마다 `localStorage`(`tractus:llm-choice:summary|ask`, 읽기·쓰기 모두 try/catch)에 기억하고 그 서비스가 더는 등록돼 있지 않으면 기본으로 돌아간다. 고른 서비스는 `summary_start`·`job_start`(summarize)·`ask_start`의 `provider`로 넘어가고, 보내기 전 안내(`llm_config(provider)`)도 그 서비스의 호스트를 말한다. 요약이 도는 동안은 칸이 잠긴다(여러 유형을 차례로 만들 때 서비스가 섞이지 않게). **요약 바닥글(`요약: Upstage(solar-pro4)`)과 답변 아래의 서비스 이름은 화면에서 뺐다**(WORDS §6 2026-10-15).
- **Upstage 스마트 검색(옵트인, v3.33).** 설정의 `스마트 검색 방식` 선택(`이 Mac(기본)` | `Upstage solar-embedding-2`, 코어 `TRACTUS_EMBED`). Upstage는 Upstage 키가 있어야 고를 수 있고(`embedding_provider_save`도 거절), 고르기 전에 전송 확인 창을 한 번 보인다(노트 내용·검색어가 가고 정책을 확인하지 못했다는 것·정보를 새로 만든다는 것). 바꾸면(어느 쪽이든) `indexer.touch()`로 기존의 조용한 갱신 흐름을 탄다: 코어 `MODEL_ID`가 바뀌어 벡터를 다시 만들고, 그동안은 단어 일치로 찾는다. **앱은 `TRACTUS_EMBED`를 늘 정한다**(`Settings::embed_mode`, `child_env` 안): 이 Mac이면 `local`, 그래서 `.env`의 `TRACTUS_EMBED=upstage`가 선택을 뒤집어 노트 내용을 보내거나 벡터를 계속 다시 만들지 못한다. **"키는 요약·질문 실행에만"의 유일한 예외:** 옵트인일 때만 `UPSTAGE_API_KEY`(Upstage 키 하나, 셸에 이미 있으면 덮지 않는다)와 `UPSTAGE_BASE_URL`(Upstage 프로필 주소, 없으면 기본 주소: 노트 폴더 `.env`의 주소가 키를 받지 못하게 늘 정한다)을 문장·검색어를 임베딩하는 실행에만 싣는다(`Settings::embed_key_env`): 색인(`index_refresh`), 변환·가져오기(`job_start`·`start`, `tractus_embed`), 요약·질문(`tractus_llm`: 요약 뒤의 색인, 질문의 검색), 상주 검색 프로세스(`mcp_spawn`). 녹음 프로그램·화자·내보내기·용어집·점검 같은 나머지 실행(`child_env`, `tractus`)에는 방식(`TRACTUS_EMBED`)만 있고 키·주소는 없다(`tests`: 녹음 프로그램 환경 포함). 주소를 바꾸면 상주 검색 프로세스도 다시 뜬다(`llm_settings_save`). 키·방식이 바뀌면 `McpClient::set_spawn`으로 상주 프로세스가 다음 호출에 새 환경으로 다시 뜬다. 다른 서비스의 키는 어느 경우에도 가지 않는다(`tests`: `upstage_search_opt_in_is_the_only_way_a_key_reaches_the_search_processes`). 로컬 전용 모드(`TRACTUS_LOCAL_ONLY`)에서는 코어가 Upstage를 쓰지 않으므로(단어 일치로만 찾는다) 설정은 Upstage를 고를 수 없게 하고(`local_only`, `embedding_provider_save`도 거절), 이미 골라 둔 상태면 `smart-search`를 `missing: ["local-only"]`로 알린다. 기능 점검(`doctor_report`의 `apply_embedding`)은 이 모드에서 `smart-search`를 Upstage 키가 있으면 준비됨, 없으면 `missing: ["upstage-key"]`(이유 `설정에서 API 키를 등록하세요`, 고치는 단추 `설정 열기`)로 바꾸고, 모델 화면은 이 Mac의 검색 모델 줄 상태를 `사용하지 않음`으로 보인다. Upstage 임베딩의 검색 품질은 아직 `bench/`로 재지 않았다.
- **시작 점검.** `AI 요약·질문`의 `API 키` 행은 쓸 수 있는 서비스(`registered`: 키가 있거나 이 Mac 주소의 직접 입력)가 하나라도 있는지 본다.
- **테스트.** Rust `llm_key.rs`(검증, 서비스별 0600 파일·예전 `llm_key` 경로, 서비스 이름 안전성, 주소·호스트 파싱, 환경 주입 규칙, 오류 문구에 키 없음, 연결 테스트 출력 해석)와 `lib.rs`(`saved_key_reaches_only_llm_commands`, `injection_follows_the_selected_provider`: 서비스마다 자기 프로필·변수에만 싣고 녹음·일반 실행에는 없음, `upstage_search_opt_in_…`: 옵트인일 때만 Upstage 키 하나, `llm_settings_defaults_and_migration`: 예전 설정 옮기기, `llm_test_runs_the_core_with_injected_env`: 가짜 코어 스크립트로 test·models), `models.rs`(`upstage_search_needs_the_key_not_the_local_model`), `llmKey.test.ts`(서비스 고르기·기억·스마트 검색 문구)·`caps.test.ts`·`ask.test.ts`. 코어 `tests/test_llm_providers.py`(로컬 가짜 서버).

### 2.15 모델 받기·지우기와 시작 점검 (v3.23)

개발자가 저장소를 받아 직접 빌드해 쓰는 배포를 전제로, 모델과 도구가 없을 때 **조용히 실패하지 않게** 한다. 필수 모델(VAD + 변환 엔진 하나)과 ffmpeg만 있으면 녹음·가져오기 → 텍스트 변환 → 요약이 돈다. 나머지 모델이 없으면 코어는 해당 단계를 건너뛰며 경고를 내고, 앱은 그 기능의 단추를 막고 이유와 `모델 화면 열기`를 보인다. **모델을 쓰는 기능을 새로 만들면 `src/tractus/models_registry.py`에 모델·기능을 선언하고 앱에서 막는다** (CLAUDE.md).

**원본.** `src/tractus/models_registry.py` 하나다. 저장소·리비전·폴더·파일 목록과 크기·URL·sha256, 단계(`required`·`recommended`·`optional`), 기능(`CAPABILITIES`)이 여기 있다. `diarize`·`align`·`embed`·`voices`의 상수는 그대로 두고 레지스트리가 가져온다(`tests/test_models.py`가 일치를 검사한다). ASR·VAD의 저장소·리비전은 레지스트리가 원본이고 `cli.MODELS`·`VAD_MODEL`이 가져간다. 코어의 받기 안내 문구(`hf download … --revision … --local-dir …`와 `tractus models download <id>`)도 레지스트리에서 만든다. ASR·VAD도 리비전을 고정한다(2026-10-14 시점 HEAD, 파일 크기를 허브 API로 대조).

| id | 모델 | 단계 | 크기 | 폴더 | 이게 없으면 못 쓰는 기능 |
| --- | --- | --- | --- | --- | --- |
| `vad` | Silero VAD v6 | 필수 | 1.2MB | `silero-vad-v6` | `convert`, `live` |
| `asr-std` | Qwen3-ASR 1.7B 8bit | 필수 (둘 중 하나) | 2.5GB | `qwen3-asr-1.7b-8bit` | `convert` (둘 다 없을 때) |
| `asr-lite` | Qwen3-ASR 0.6B 8bit | 필수 (둘 중 하나), 실시간은 항상 | 1.0GB | `qwen3-asr-0.6b-8bit` | `convert` (둘 다 없을 때), `live` |
| `diarizer` | Nemotron-3 Diarization | 권장 | 0.2GB | `nemotron-3-diarization` | `diarize` |
| `aligner` | Qwen3-ForcedAligner 0.6B 8bit | 선택 | 1.3GB | `qwen3-forcedaligner-0.6b-8bit` | `align` |
| `embedding` | Qwen3-Embedding 0.6B 8bit (mlx-community 변환본, 2026-10-15에 bf16 공식 가중치에서 바꿈) | 선택 | 0.6GB | `qwen3-embedding-0.6b-8bit` | `smart-search` |
| `voices` | 3D-Speaker CAM++ zh_en ONNX | 선택 | 28MB | `3dspeaker-campplus-zh-en` | `voices` |
| `fluid` | FluidAudio 화자 분리 + 도우미 `tractus-diar` | 선택 | 22MB(+도우미 빌드) | `speaker-diarization` | `diarize-many` |

크기 합계(GiB): `required` 2.3(16GB 이상, 미만이면 1.0), `standard` 4.3, `lite` 1.1, `all`(fluid 제외) 5.2.

기능(`capabilities`): `record`(도구 `recorder`) · `convert`(`vad` + `asr-std`/`asr-lite` 중 하나 + 도구 `ffmpeg`) · `diarize`(`diarizer`) · `diarize-many`(`fluid`) · `align`(`aligner` + 도구 `ffmpeg`: 노트 오디오를 디코딩한다) · `smart-search`(`embedding`) · `live`(`vad` + `asr-lite` + 도구 `recorder` + 메모리 16GB 이상: **표준 엔진이 있어도 0.6B가 따로 필요하다.** 1.7B로 실시간을 재 봤으나 확정 지연 p95가 1.59–1.95초로 기준(1.0초)을 넘어 쓰지 않는다, §2.8. 16GB 미만이면 `tractus live`가 `live_low_memory`로 거절하므로 `missing`에 `memory`가 든다) · `voices`(`voices` + 도구 `ffmpeg`). 요약·질문은 모델이 아니라 API 키라 코어 점검에 없다(앱이 키 상태를 더한다). 녹음 자체는 모델이 필요 없다: 변환 엔진이 없어도 녹음은 저장되고 앱은 `변환 대기 중인 녹음`으로 보인다.

#### `tractus models list [--json]`

네트워크를 쓰지 않는다. 설치 여부는 파일 존재와 **크기**(고정한 리비전의 값)로 판단한다. voices는 sha256까지 본다.

```json
{"models_dir": "/Users/me/Tractus/models", "disk_free_bytes": 199610109952, "download_active": false,
 "models": [{"id": "asr-lite", "name": "변환 엔진 (가벼운 것)", "purpose": "…", "level": "required", "level_note": "one_of",
             "size_bytes": 1010771234, "installed": false, "installed_bytes": 0, "state": "missing",
             "needed_by": ["convert", "live"], "group": "convert", "path": "/Users/me/Tractus/models/qwen3-asr-0.6b-8bit",
             "model_name": "Qwen3-ASR 0.6B (8bit 양자화)", "publisher": "Alibaba Qwen 팀", "converted_by": "mlx-community (MLX 변환본)",
             "source": "mlx-community/Qwen3-ASR-0.6B-8bit", "revision": "89e96d92ba34aca20b3e29fb10cc284097d1219f",
             "license": "Apache-2.0", "languages": "한국어·영어 등 30개 언어와 중국어 방언 22개", "params": "0.6B"}, …],
 "unregistered": [{"name": "qwen3-embedding-0.6b", "bytes": 1191586416}]}
```

- **모델 소개(2026-10-14, 추가 키만).** `model_name`(공식 이름을 풀어 쓴 것)·`publisher`(만든 곳)·`license`(Apache-2.0, MIT, OpenMDW-1.1, CC-BY-4.0 …)·`source`(내려받는 곳: HF 저장소 ID 또는 URL)는 항상 비어 있지 않은 문자열이다. `converted_by`(커뮤니티 변환본이면 변환한 곳, 공식 가중치 그대로면 `null`)·`revision`(고정한 리비전 전체. 고정하지 않은 voices·fluid는 `null`)·`languages`·`params`(카드에 적혀 있을 때만)는 `null`일 수 있다. 앱은 `revision`의 앞 8자만 보이고 전체는 `title`에 둔다. 값은 `models_registry.py`의 모델 줄 주석에 적은 모델 카드(HF API·README)·NOTICE로 2026-10-14에 확인했고, 확인하지 못한 값은 추측하지 않고 `null`이다(`tests/test_models.py`가 빈 값과 다운로드 상수와의 일치를 검사한다). 이름·만든 곳 같은 문구의 기준은 WORDS.md §4.14다.

- **`unregistered`(추가 키, 2026-10-15).** 모델 폴더 바로 아래의 **등록되지 않은 폴더**(옛 버전 모델 등)의 `[{name, bytes}]`(이름순, 없으면 `[]`). 파일·숨김 항목(`.tractus-models.lock` 포함)·심볼릭 링크는 세지 않는다. `bytes`는 폴더 안 파일 크기의 합이다. `models prune`이 지우는 목록과 같다. **모델 모양(완료 표시·`config.json`·`*.safetensors`가 있는) 폴더만** 나오고, 모델 폴더에 등록된 모델이 하나도 없거나 노트 폴더(`TRACTUS_HOME`이거나 `meetings/`·`recordings/`를 품은 곳)면 항상 `[]`다: 모델 폴더를 문서·노트 폴더로 잘못 골랐을 때 사용자 폴더가 지워지지 않게 한다.
- `state`: `installed`(파일이 모두 있고 크기가 맞음) · `missing`(없음) · `partial`(일부만, 또는 받다 만 `.incomplete`·`.part`가 있음. `installed_bytes`에 받은 바이트) · `corrupt`(파일 크기가 다름, voices는 sha256 불일치). fluid는 모델 폴더와 도우미 프로그램이 모두 있어야 `installed`(모델만 있으면 `partial`).
- `group`: `convert` · `speakers` · `words` · `search`. `level`: `required` · `recommended` · `optional`. `level_note`(추가 키, 2026-10-14): 같은 기능의 필수 모델 여럿 중 하나만 있으면 될 때 `"one_of"`, 아니면 `null`. 지금은 `asr-std`·`asr-lite`만 `one_of`이고(레지스트리의 `ONE_OF`, `tests/test_models.py`가 `CAPABILITIES`의 둘 중 하나 묶음과 일치를 검사한다) `level`은 그대로 `required`다: **`level` 값을 바꾸지 않아 옛 소비자는 그대로 읽는다.** 앱은 `level: required` + `level_note: one_of`를 `필수 (둘 중 하나)`로 보이고, 둘 중 하나라도 설치됐으면 `변환 엔진: 설치됨`으로 본다(WORDS.md §4.15). `tractus models list`(사람용 출력)도 같은 글자를 쓴다. `doctor`의 `models` 항목에도 같은 키가 있다. `download_active`: 다른 프로세스가 이 폴더에서 받는 중.
- 받기를 마치면 HF 모델 폴더에 `.tractus-model.json`(`{id, revision, files, completed_at}`)을 **맨 마지막에** 쓴다. 상태 판단은 파일 크기가 기본이고, 이 표시가 있으면 `revision`이 레지스트리와 같은지도 본다(다르면 `partial`: 다시 받으면 새 리비전으로 채운다). 표시가 없는 폴더(직접 받은 것)는 파일이 맞으면 설치로 본다. 내용 해시는 voices만 확인한다.

#### `tractus models download [ID …] [--preset required|standard|lite|all] [--progress-json]`

ID와 프리셋을 함께 주면 합친다(중복 제거, 레지스트리 순서). 이미 설치된 모델은 건너뛴다. HF 모델은 `huggingface_hub.snapshot_download(repo, revision, local_dir, allow_patterns=<레지스트리의 파일 목록>)`로 받고(이어받기), voices는 URL에서 받아 sha256을 검증하며(`.part`에서 Range로 이어받기. 이미 크기가 다 찬 `.part`는 요청 없이 sha256만 확인한다), fluid는 도우미 `tractus-diar download --models <폴더>`를 부른다.

| 프리셋 | 모델 |
| --- | --- |
| `required` | `vad` + 메모리가 권하는 엔진(16GB 이상 `asr-std`, 미만 `asr-lite`) |
| `standard` | `vad` `asr-std` `diarizer` `aligner` `embedding` `voices` (실시간 텍스트 변환을 쓰려면 `asr-lite`를 더한다: 표준 엔진은 실시간 지연이 길어 못 쓴다, §2.8) |
| `lite` | `vad` `asr-lite` `diarizer` |
| `all` | 전부. `tractus-diar`가 없으면 fluid는 건너뛰고 경고 `fluid_skipped` |

- **받기 전 확인.** 받을 바이트(이미 받은 만큼 뺀 값)의 1.1배보다 남은 공간이 적으면 아무것도 받지 않고 `disk_full`. `corrupt`인 모델이 있으면 `corrupt`(받기는 아무것도 지우지 않는다: `models remove <id> --yes` 뒤에 다시 받는다).
- **한 번에 하나.** 모델 폴더의 `.tractus-models.lock`을 `flock`으로 잡고 PID를 적는다. 이미 받는 중이면 `busy`. 프로세스가 죽으면 잠금은 저절로 풀린다. `models list`의 `download_active`는 잠금을 잡아 보지 않고 이 PID가 살아 있는지만 본다(확인이 받기를 막지 않는다).
- **SIGTERM·SIGINT.** HF 받기는 `hf_xet`을 끄고(`HF_HUB_DISABLE_XET`) 일반 HTTP로 받는다: xet은 진행을 자기 스레드에서 알려서 취소가 전송을 멈추지 못한다. 받던 파일(`.incomplete`·`.part`)을 남기고 잠금을 놓고 `{"event":"cancelled"}`, 종료 코드 130. 같은 명령을 다시 돌리면 이어받는다. 두 번째 신호는 즉시 종료한다.
- 종료 코드: 성공 0, 오류 1, 인수 오류 2, 중단 130.

이벤트(`--progress-json`, stdout JSON Lines):

```jsonc
{"event":"warning","code":"fluid_skipped","message":"…"}                       // preset all인데 도우미가 없음
{"event":"stage","stage":"download","model":"asr-std","index":2,"count":3,"size_bytes":2467856503}
{"event":"progress","model":"asr-std","file":"model.safetensors","bytes_done":123456,"bytes_total":2467856503,
 "overall_done":1361779,"overall_total":2469094826}                              // 0.25초에 한 번 이하. file은 최선(아직 덜 받은 가장 큰 파일, 없으면 null)
{"event":"model_done","model":"asr-std"}
{"event":"done","models":["vad","asr-std"],"already":["diarizer"]}              // models: 이번에 받음, already: 이미 설치돼 건너뜀
{"event":"error","message":"…","code":"no_network","model":"asr-std"}           // model은 있을 때만. 종료 코드 1
{"event":"cancelled"}                                                           // 종료 코드 130
```

오류 코드: `no_network`(연결·DNS·시간 초과·`HF_HUB_OFFLINE`) · `disk_full`(사전 확인 또는 `ENOSPC`) · `auth`(HTTP 401·403, 비공개·약관 동의가 필요한 저장소) · `hash_mismatch`(sha256 또는 받은 뒤 크기 불일치. voices는 받은 파일을 지운다) · `helper_missing`(fluid인데 `tractus-diar`가 없음, `message`에 빌드 명령) · `corrupt`(받기 거부, 먼저 remove) · `busy`(다른 받기 진행 중) · `bad_argument`(모르는 ID·프리셋, 종료 코드 2) · `unknown`. 오류 문구는 `자세히`에 접는다.

#### `tractus models remove ID [--yes]`

모델 폴더 하나를 지운다. 모델 폴더(`TRACTUS_MODELS_DIR`) 바로 아래의 실제 폴더만 지우고(심볼릭 링크나 바깥을 가리키면 `unsafe_path`. 폴더가 아닌 파일이어도 같다), 받기 잠금을 잡을 수 없으면 `busy`. `--yes` 없이는 확인한다. 출력: `{"id": "vad", "removed": true, "freed_bytes": 1238323}`(폴더가 없으면 `removed: false`). fluid는 모델 폴더만 지우고 도우미 프로그램은 그대로 둔다. 이 명령 말고는 코어가 모델 파일을 지우지 않는다.

#### `tractus models prune [--yes] [--json]`

등록되지 않은 폴더(`models list`의 `unregistered`: 모델 모양인 폴더만, 노트 폴더·모델 없는 폴더에서는 비어 있다)를 모두 지운다. 모델 폴더(`TRACTUS_MODELS_DIR`) 바로 아래의 실제 폴더만 대상이다: 파일·숨김 항목·심볼릭 링크는 건드리지 않고, 지우기 직전에 `remove`와 같은 검사(링크 아님, 부모가 모델 폴더)를 다시 한다. 받기 잠금을 잡을 수 없으면 `busy`(받는 중이면 거부). `--yes` 없이는 폴더 목록과 크기를 **stderr**에 보이고 확인한다(stdout은 결과뿐이다). 출력(stdout, `--json`일 때 JSON; 없으면 한 줄 요약): `{"removed": [{"name", "bytes"}], "freed_bytes": N}`. 지울 것이 없으면 `{"removed": [], "freed_bytes": 0}`. 레지스트리가 폴더 이름을 바꾸면(예: 2026-10-15 임베딩 bf16 → 8bit) 옛 폴더가 여기에 나타나므로 새 버전으로 올린 사용자가 용량을 되찾는 길이다.

#### `tractus doctor [--json]`

없는 것이 있어도 종료 코드 0이다. 앱은 시작할 때, 받기·지우기 뒤, 창에 초점이 돌아올 때 부른다.

```json
{"system": {"arch": "arm64", "macos_version": "15.2", "memory_gb": 16.0, "meets_min": true, "problems": [],
            "standard_recommended": true, "disk_free_bytes": 199610109952, "models_dir": "…"},
 "tools": {"brew": {"found": true, "path": "/opt/homebrew/bin/brew", "version": null},
           "ffmpeg": {"found": true, "path": "/opt/homebrew/bin/ffmpeg", "version": "8.1.1"},
           "recorder": {"found": true, "path": "…/recorder/.build/release/tractus-rec"},
           "diar_helper": {"found": false, "path": "…/recorder/diar/.build/release/tractus-diar"}},
 "models": [{"id": "vad", "level": "required", "level_note": null, "state": "installed"}, …],
 "capabilities": [{"id": "convert", "name": "텍스트로 변환", "ready": false, "missing": ["asr-std", "ffmpeg"],
                   "hint": "tractus models download asr-std; brew install ffmpeg"}, …],
 "recommended_track": "standard", "effective_track": null}
```

- 최소 사양: Apple Silicon(`arm64`), macOS 14.4 이상, 메모리 8GB 이상. 못 미치면 `meets_min: false`와 `problems`(`not_apple_silicon` · `macos_too_old` · `memory_low`). 표준 엔진은 16GB 이상을 권한다(`standard_recommended`).
- 도구 위치: `brew`는 `PATH` 또는 `/opt/homebrew/bin`·`/usr/local/bin`(ffmpeg 설치 안내용, 기능에는 쓰지 않는다), `ffmpeg`는 `PATH`, `recorder`는 `$TRACTUS_REC_BIN` → 앱 번들(`sys.executable`이 `<앱>/Contents/Resources/runtime/bin`에 있을 때 `../../bin/tractus-rec`) → 저장소에서 빌드한 `recorder/.build/release/tractus-rec` 순으로 찾고, `diar_helper`는 같은 규칙으로 `$TRACTUS_DIAR_BIN` → `bin/tractus-diar` → `recorder/diar/.build/release/tractus-diar`다(`paths.tool_bin`, 존재하는 첫 후보. 하나도 없으면 저장소 배치일 때 저장소 경로, 아니면 번들 경로를 `path`로 알린다). **코어는 저장소 위치를 가정하지 않는다**: `capabilities[].hint`와 `helper_missing`의 빌드 명령(`cd <저장소>/recorder … swift build`)은 저장소 배치(`recorder/Package.swift`가 있음)일 때만 나오고, 아니면 `TRACTUS_REC_BIN`·`TRACTUS_DIAR_BIN`으로 위치를 알리라는 일반 안내가 나온다(`paths.build_hint`). 앱이 다른 위치를 쓰면(설정의 녹음 프로그램 경로) 환경변수로 넘긴다. 마이크·시스템 오디오 권한은 macOS가 첫 녹음에서 물으므로 미리 확인할 방법이 없다.
- `capabilities[].missing`은 채울 모델 ID와 도구 이름(`ffmpeg` · `recorder` · `diar_helper`), 그리고 못 채우는 `memory`(live, 16GB 미만)다. `vad`+엔진이 둘 다 없으면 엔진은 메모리가 권하는 쪽만 적는다. `partial`·`corrupt`인 모델은 없는 것으로 친다. `hint`는 개발자용 명령이다(`tractus models download <id>`, `brew install ffmpeg`, 빌드 명령).
- `recommended_track`: 메모리가 권하는 트랙(`standard`|`lite`). `effective_track`: 지금 `--track` 없이 변환하면 쓸 트랙, 쓸 수 있는 엔진이 없으면 `null`.

#### 변환 엔진 자동 선택 (`transcribe`)

`--track`이 없으면 메모리가 권하는 트랙의 모델이 있으면 그것을 쓴다. 없고 다른 트랙의 모델이 있으면 그것으로 변환하고 경고 `{"event":"warning","code":"asr_track_fallback","message":"…"}`를 낸다(진행 중 작업의 이어하기는 기록된 트랙을 그대로 쓴다). 둘 다 없으면 지금처럼 `model_missing`(종료 코드 1, `message`에 `tractus models download <id>`와 `hf download …`). 고른 트랙은 지금처럼 `transcript.json`의 `asr.track`에 남는다. `--track`을 직접 주면 그 트랙만 쓴다. "쓸 수 있다"는 설치가 끝났거나(§위), 가중치 없이 `config.json`만 있는 폴더(직접 만든 폴더·테스트 픽스처)이고 받다 만 파일이 없는 경우다. `local_model`(변환·실시간이 모델을 열기 전)도 같은 검사를 하므로, 받다 만 모델은 트레이스백 대신 `model_missing`으로 알린다.

- **테스트.** `tests/test_models.py`(가짜 폴더·로컬 HTTP 서버·시뮬레이션 오류, 실제 모델 불필요) + `@pytest.mark.network` 하나(`pytest -m network`: 작은 VAD를 임시 폴더에 받아 `list`가 설치됨으로 읽는지).
- **알려진 한계.** 허브가 파일 이름을 알려 주지 않아 `progress.file`은 추정이다. 이어받기 때 `bytes_done`은 허브 막대의 값이라 이미 받은 바이트를 빼고 시작할 수 있다. `fluid`의 받기 진행은 도우미가 이벤트를 내지 않아 `stage`와 `model_done`뿐이다. 받는 중에 앱 프로세스가 강제 종료되면 `.incomplete`가 남는다(다시 받으면 이어받는다). 설치 판정은 크기만 보므로 같은 크기로 바뀐 가중치는 못 잡는다(voices는 sha256 확인, 리비전이 다른 폴더는 완료 표시로 잡는다).

### 2.16 녹음과 변환 나누기: `tractus recording finish`, `tractus transcribe --into` (v3.25)

지금까지는 녹음을 멈추면 곧바로 텍스트 변환이 돌았다. 이제 **저장**과 **변환**이 따로다: 녹음을 멈추고 변환 없이 노트로 저장해 두었다가(**변환 전** 노트) 나중에 같은 노트를 그 자리에서 텍스트로 변환한다. 바로 변환하는 길(`transcribe --recording <폴더>`)은 그대로이고 한 바이트도 달라지지 않는다.

```
tractus recording finish <녹음 폴더> [--title T] [--progress-json]     # 변환 없이 "변환 전" 노트로 저장
tractus transcribe --into <노트> [--track …] [--language …] [--term …] [--keep-tracks] [--no-diarize] [--max-speakers N] [--diarizer …] [--no-align] [--progress-json]   # 변환 전 노트를 그 자리에서 변환
```

**"변환 전" 노트의 transcript.json** (schema_version 2, `kind`는 없다 = 녹음 노트):

```jsonc
{ "schema_version": 2, "state": "recorded",            // 선택 키. 변환이 끝나면 키가 없어진다. 판별은 store.is_recorded(t)
  "meeting_id": "01K…", "title": "녹음 14:00", "created_at": "2026-10-02T14:00:00+09:00",   // created_at = 녹음 시작 시각
  "audio": { "file": "audio.ogg", "duration_sec": 8.0, "source": "<녹음 폴더 이름>", "sha256": "<원본 트랙 해시>" },
  "speakers": {}, "diarization": null, "segments": [] }  // asr 키는 없다 (변환 뒤에 생긴다)
```

노트 폴더: `audio.ogg`(Opus 32kbps, 바로 들을 수 있다), `memos.json`(녹음 중 메모·북마크, 있으면), `tracks/`(원본 `mic.wav`·`system.wav`·`recording.json`, 손실 없는 변환용), `transcript.json`, `transcript.md`(머리말 `state: recorded`, 본문은 `아직 텍스트로 변환하지 않았습니다.`와 녹음 중 메모·북마크·`## 메모`. **`transcript.vtt`는 없다**, 변환하면 생긴다). 변환이 끝나면 `state`가 사라지고 `tracks/`가 지워진다(`--keep-tracks`면 남긴다).

#### `recording finish`

- `<녹음 폴더>` = `tractus-rec`가 만든 폴더(`recordings/<ULID>`). `--title`이 없으면 `녹음 HH:MM`(녹음을 시작한 이 Mac의 시각), 폴더는 `meetings/<날짜>_<제목>_<새 ULID>/`. 제목은 `notes.clean_title`(공백 정리, 1–120자, 아니면 종료 코드 2 `bad_input`). 녹음 폴더의 `attach.json`(§2.11)은 보지 않는다: 항상 새 노트다(덧붙일 녹음은 앱이 `transcribe --recording --append-to`를 쓴다).
- 이벤트: `stage(decode)`(원본 해시·길이 계산) → `stage(encode)`(`audio.ogg`가 이미 있으면 생략) → `done {meeting_id, meeting_dir}`. `--progress-json`이 없으면 stdout에 `{"meeting_id": "01K…", "meeting_dir": "<절대 경로>"}` 한 줄.
- 오류(코드는 위 표): `recording_missing`(폴더 없음·소리 없음, 종료 코드 2), `bad_input`(2), `ffmpeg_missing`·`audio_failed`(1), `interrupted`(130). **오류가 나도 녹음 폴더는 지우지 않는다.**
- **순서와 안전.** 노트 폴더 만들기(+표시 파일 `.finish.json` = 녹음 폴더 이름·`meeting_id`·제목·원본 해시·길이) → `audio.ogg`(`audio.part.ogg`로 만들어 이름 바꾸기) → `memos.json` → 트랙·`recording.json`을 `tracks/`로 **복사**(`.part`로 복사한 뒤 이름 바꾸기) → **`transcript.json`(마지막, 완료 표시)** → 녹음 폴더 비우기(원본은 여기서 지운다) → `.finish.json` 지우기. `transcript.json`이 없는 폴더는 노트가 아니다(목록·검색·`find_meeting_dir`에 나오지 않는다). 어디서 끊겨도(SIGKILL 포함) 같은 명령을 다시 실행하면 `.finish.json`으로 같은 노트 폴더를 찾아 이어서 끝낸다. 끊겨도 녹음 폴더는 온전해서(복사이므로) 앱의 `변환 대기 중인 녹음` 목록(`recording.json`이 있는 폴더)에서 사라지지 않고, 그 목록의 `변환`이 트랙 일부만 변환하는 일도 없다. 디스크 부족 같은 `OSError`는 코드 없는 오류 이벤트(`녹음을 저장하지 못했습니다: …`, 종료 코드 1)로 알린다. `transcript.json`까지 쓰고 끊겼으면 다시 실행했을 때 녹음 폴더 정리만 한다. 이미 정리된 녹음 폴더(없음)는 `recording_missing`이다.
- 소리 길이는 녹음의 오디오 시계(`recording.json`의 `duration`과 같다, §1)가 아니라 트랙을 실제로 디코딩해 잰다(충돌한 녹음은 `duration`이 null일 수 있다). 일시정지(`pauses`, §1)는 WAV에 이미 빠져 있어 코어가 할 일이 없다: `memos.json`의 `t`는 `marks[].t` 그대로 오디오 시계이고 `audio.ogg`·원본 트랙과 같은 시각이다.
- 끊긴 녹음 폴더(충돌로 `duration`이 null)도 그대로 저장한다. 바로 변환하는 길과 마찬가지로 `recording.json`의 `tracks`와 `started_at`만 필요하다.

#### `transcribe --into <노트>`

- `<노트>` = 폴더 또는 `meeting_id`(일부). 파일·`--recording`·`--append-to`와 함께 쓰면 종료 코드 2(`BadParameter`). `--title`은 무시한다(제목은 노트의 것). 나머지 옵션은 `transcribe`와 같다.
- **입력.** `tracks/`의 원본 트랙을 `recording.json` 순서대로 `amix`(normalize=0)해 변환한다(바로 변환하는 길과 같은 소리 → 같은 결과). `tracks/`가 없거나 비었으면 `audio.ogg`를 디코딩해 변환하고 경고 `tracks_missing`을 낸다(음질이 조금 낮을 수 있다). 둘 다 없으면 `note_audio_missing`(종료 코드 2).
- **검사(처리 전, 종료 코드 2, 아무것도 쓰지 않는다).** 노트를 못 찾으면 `code` 없는 `error`(`resolve_meeting`과 같다). 변환 전이 아니면 `code: not_recorded` + 문장 `이미 텍스트로 변환한 노트입니다.`(메모 노트는 `녹음이 없는 노트라 텍스트로 변환할 수 없습니다.`). 중복 파일 검사(`duplicate`)는 하지 않는다.
- **이벤트는 `transcribe`와 같다**: `stage(decode)` → `vad` → (`diarize`) → (`voices`) → `load_model` → `transcribe` + `progress` → `align` → `index` → `done {meeting_id, meeting_dir}`. 이미 `audio.ogg`가 있으므로 `encode` 단계는 나오지 않는다. 중단하면 종료 코드 130 `interrupted`.
- **노트 폴더 안에서 돈다.** 이어하기 파일 `.job.json`(새 필드 `convert: true`)·`.chunks.jsonl`을 그 폴더에 둔다. 변환 전 노트는 `transcript.json`이 있으므로 평소 `store._clean_stale_job`은 작업 파일을 낡은 것으로 지우지만, **노트가 아직 `state: recorded`인 동안**(`store._job_pending`, §2.11의 덧붙이기와 같은 방식)은 지우지 않는다. `find_job(meetings, sha, append_to=…, into=<meeting_id>)`는 작업을 세 종류(새 노트 / 덧붙이기 / 변환)로 가르므로 서로 이어받지 않는다. 중단해도 노트는 변환 전 그대로이고 같은 명령으로 이어진다(VAD·화자 분리·끝난 청크는 다시 하지 않는다). 해시는 저장할 때 잰 원본 트랙의 것을 쓴다.
- **합치기(`deferred.finish_convert`, `note_lock` 안).** 끝난 청크로 만든 결과(`build_transcript`)의 `schema_version`·`audio`·`asr`·`speakers`·`diarization`·`segments`를 **다시 읽은** transcript.json에 쓰고 `state`를 지우고 `updated_at`을 올린다. 그 밖의 키(`title`·`memo`·`favorite`·`tags`·`folder`·알 수 없는 키)는 다시 읽은 쪽 그대로라서 **변환하는 동안 앱에서 고친 제목·메모·태그가 살아남는다**. `align`의 단어 시각 저장(`_save_words`)도 같은 방식이다. `transcript.json`이 마지막, 끝나면 `.job.json`·`.chunks.jsonl`을 지운다. 변환하는 사이 다른 실행이 먼저 변환했으면 덮어쓰지 않고 `not_recorded`(종료 코드 2)다.
- **결과는 바로 변환한 노트와 같다.** 같은 녹음을 `transcribe --recording`으로 바로 변환한 노트와 `meeting_id`·`updated_at`을 뺀 transcript.json·`memos.json`·파일 구성이 같다(`tests/test_deferred.py`, `slow`는 실제 모델로 같은 `say` 음성을 비교).

#### 변환 전 노트를 읽는 쪽 (대화 0개, 오디오 있음)

| 기능 | 동작 |
| --- | --- |
| 검색·색인 | 대화가 없으니 **메모 줄만** 색인된다(§2.10 `source: "memo"`). 메모도 없으면 청크가 없다. 오류 없음 |
| `summarize` | 종료 코드 2, `code: not_converted`, `먼저 텍스트로 변환하세요.` 파일은 만들지 않는다 |
| `ask --meeting` | 근거가 메모 줄뿐(또는 없음). 근거가 없으면 경고 `not_converted`를 내고 LLM을 부르지 않고 `근거 없음` done(`provider`·`model` null)으로 끝난다. 메모가 있으면 메모로 답한다 |
| `export` | `txt`·`md`·`csv`·`docx`·`bundle`은 된다(대화 내용은 비고 메모 절은 있다. `bundle`은 `audio.ogg`·transcript.json·md·memos.json이고 `tracks/`는 넣지 않는다). **`srt`·`vtt`는 종료 코드 2** + `아직 텍스트로 변환하지 않아 자막 파일로 내보낼 수 없습니다. 먼저 텍스트로 변환하세요.` (`export.NO_SUBTITLES_RECORDED`) |
| MCP | `list_meetings`에 `state`(`"recorded"` 또는 null)가 있다. `get_transcript`는 `변환 전` 머리 줄 + 안내 한 줄 + 메모 구간을 돌려준다. `save_summary`는 ToolError |
| `notes list --json` | 한 줄마다 `"state": "recorded" \| null`가 더해진다(`organize.note_row`) |
| 앱 `list_meetings`·`load_meeting`(Rust `MeetingInfo`) | 변환 전 노트에만 `tracks_bytes`(노트 폴더 `tracks/` 아래 파일 크기의 합, 없으면 0)가 더해진다. 코어 JSON이 아니라 앱이 폴더를 읽어 만든다. 화면은 이 크기를 보여 주기만 한다(WORDS §4.18) |
| `render` | `transcript.md`만 다시 쓴다(vtt 없음). 몇 번 돌려도 같다. `asr` 블록이 없어도 죽지 않는다 |
| `align`, `speakers rename/set/merge/dismiss`, `segments edit`, `voices enroll/match` | 종료 코드 2, `code: not_converted`, `먼저 텍스트로 변환하세요.` (`speakers list`는 빈 목록) |
| `note save`, `note title`, `note meta`, `folders` | 그대로 된다. `note save`는 `memo` 블록을 쓴다(`kind: "recording"`) |
| 삭제 | 폴더째 휴지통(§2.9)이라 `tracks/`도 함께 간다. 변환 중이던 작업이 끊겨 `.job.json`·`transcript.json`이 둘 다 있으면 "끝난 노트"로 보아 앱의 삭제 검사를 통과한다(§2.7.2) — 변환 중(실행 중)에는 앱의 `BusyGuard`가 막는다 |
| `transcribe <파일>`·`--recording`·`--append-to` | 변환 전 노트의 해시는 `find_transcribed`(중복 검사)에서 제외된다. `--append-to`는 `append_has_audio`로 거절한다 |

문장(`먼저 텍스트로 변환하세요.` 등)은 WORDS.md §4.7이고 코어는 `store.NOT_CONVERTED`·`store.NOT_CONVERTED_NOTE`·`deferred.NOT_RECORDED_*`·`export.NO_SUBTITLES_RECORDED`에 둔다.

**"이어서 녹음"(`recording attach`)은 만들지 않았다.** 변환 전 노트에 녹음을 더하려면 트랙을 여러 부분(`tracks/part2/…`)으로 두고 `audio.ogg`·변환 입력·길이·`memos.json`의 시각(두 번째 녹음의 `t`에 첫 부분의 길이를 더해야 한다)을 이어 붙여야 한다. 일시정지 후 계속(§1)이 같은 녹음 안에서 "끊었다 이어서"를 이미 해결하므로 따로 두고 필요해지면 만든다.

**테스트.** `tests/test_deferred.py`(가짜 ASR·화자 분리 + 실제 FFmpeg, 42개 + `slow` 1개): 저장(메모·북마크·md·`audio.ogg`·`tracks/`·길이·제목·stdout JSON), 잘못된 입력(제목·없는 폴더·소리 없음·ffmpeg 없음)과 중단 뒤 이어하기(transcript.json 직전 끊김, 인코딩 실패, 정리 직전 끊김), 변환(제자리 변환·`--keep-tracks`·화자·바로 변환과 같은 결과·중단 뒤 이어하기·바로 변환과 작업 파일 분리·변환 중 메모·제목·태그 수정이 살아남음·트랙 없이 `audio.ogg`로·`not_recorded`·옵션 충돌·덧붙이기 대상 거절·다른 실행이 먼저 변환), 읽는 쪽 전부(색인·검색·summarize·ask·내보내기 7형식·MCP·notes list·편집 명령 거절·note save/title/meta·render). `slow`는 실제 모델로 `say` 음성을 저장 → SIGKILL → 이어서 저장 → 변환 → SIGKILL → 이어서 변환하고 바로 변환한 결과와 대화 텍스트·시각·참석자를 비교한다.

### 2.17 노트 완성: `tractus summarize <노트> --template enhanced` (v3.36)

설계: [docs/design/enhanced-notes.md](design/enhanced-notes.md). 문구: WORDS.md §4.22.

- **입력:** 대화 내용(요약과 같은 줄 모양) + `내가 적은 메모`. 메모 탭 줄(`m####`)을 적은 순서로 먼저, 녹음 중 메모·북마크(`memos.json`)를 시각 순으로 그 뒤에 둔다. 녹음 중 메모에는 저장하지 않는 ID `r####`를 시각 순으로 매번 같은 규칙으로 붙인다. 기존 요약 프롬프트는 바뀌지 않는다(녹음 중 메모는 노트 완성에만 쓴다).
- **출력:** `summaries/enhanced.json`(요약 v2) + `kind: "enhanced"`, 섹션마다 `part`(`memo` | `extra` | `todos`)·`source`(`m####`·`r####`, memo만)·`at`(녹음 중 메모·북마크의 초). `overview`는 비고, `prompt`는 없다(`prompt_hash`만). 순서는 내 메모(입력 순서) → 메모에 없던 내용 → `할 일`.
- **검증(1회 재요청):** 근거는 대화 줄 `s####`만이고 비어 있지 않다. 모든 메모 ID가 블록 `source`에 빠짐없이 한 번씩 나온다. 없는 메모 ID를 쓰지 않는다. **후처리(재요청 없음):** 메모 원문을 제목으로 덮어쓰고(북마크는 `북마크 m:ss`) 입력 순서로 다시 정렬한다. owner 정리는 요약과 같다.
- **거절:** 메모 노트 → 종료 코드 2, code `no_recording`. 변환 전 → `not_converted`. 대화 없음 → `no_segments`. `--custom`과 함께 쓰면 `bad_input`. `templates list`에는 나오지 않는다.
- **이벤트:** 요약과 같다(`stage summarize` → `done`의 `summary_key: "enhanced"`). 검색 색인은 갱신하지 않는다.
- **앱:** 메모 탭의 `EnhancedNote`가 `summary_start`(template `enhanced`)로 만든다. `내 메모 | 완성된 노트` 전환이 있고, 내 메모 편집기는 숨기기만 하고 언마운트하지 않는다. 요약·AI 질문의 `메모 n번째 줄` 칩이 사용자의 마지막 보기 전환보다 나중이면 내 메모를 보인다(`memoTabShowing`, 그리는 시점에 정해야 편집기가 보이는 채로 줄을 고른다). 세부를 못 찾은 내 메모 줄은 화면·`enhanced.md`·docx 모두 `대화에서 관련 내용을 찾지 못했습니다`로 남는다. 낡음은 요약과 같은 편집 횟수 비교다. 요약 탭 목록에도 한 칸으로 보이고, `다시 만들기`는 같은 명령이다(`rerunSpec`). 만드는 동안 노트 삭제를 막는다. 내보내기·MCP는 요약 key `enhanced`로 읽는다.
- **확인:** `tests/test_enhance.py`(가짜 응답), `pytest -m llm -k enhance`(가상 회의 + 메모 3줄·녹음 중 메모·북마크, Upstage solar-pro4로 3회 통과, 2026-10-16), 미리보기(`/preview.html`) 라이트·다크.

**알려진 한계.** 완성된 노트는 읽기 전용이다(고치려면 내 메모를 고친 뒤 `다시 완성`). 녹음이 길면 대화 전체를 한 번에 보낸다(요약과 같다). 메모가 대화보다 단정적인 표현으로 바뀌는 경우가 있다(가상 회의에서 '모으면 좋겠다'를 '모으기로 했다'에 가깝게 씀). WKWebView에서 손으로 확인하지 못했다(미리보기·vitest·tsc만).

### 2.17.1 회의록: `tractus summarize <노트> --template minutes`, `tractus minutes <노트> show|save` (v3.56)

설계·형식은 docs/design/meeting-minutes.md, 문구는 WORDS.md §4.26이다.

- **코어 `minutes.py`:** 녹음 노트만(메모 노트 `no_recording`, 변환 전 `not_converted`, 대화 없음 `no_segments`). AI는 근거가 달린 칸만 낸다(strict JSON, 근거 ID 검사 1회 재요청). 담당·팀·기한·다음에 볼 날은 근거 문장과 대조해 없으면 지우고, 근거에 없는 숫자는 `unverified`로 표시한다. 결과는 `summaries/minutes.json`(요약 v2 + `kind: minutes`·`minutes`·`attendees`·`edited_at`, 기존 소비자용 `sections`)과 `minutes.md`(위키용 Markdown)다. 다시 만들면 `edited_at`이 지워진다.
- **`minutes <노트> show`** → `{"minutes", "attendees", "title", "generated_at", "edited_at", "markdown", "short"}` (없으면 `{"minutes": null}`). **`minutes <노트> save`**(stdin `{"minutes": …}`, show의 `minutes` 모양): 비운 줄은 지우고, 근거 ID는 노트에 있는 것만 받고, 숫자 표시를 새 문장으로 다시 잰다. 사람이 고친 담당·기한은 대조하지 않는다. 형식이 틀리면 종료 코드 2. 출력은 show와 같다.
- **앱:** `회의록` 탭(`MinutesPanel`, 녹음 노트만, 처음 열 때 만든다). `summary_start`(template `minutes`)로 만들고 Rust `minutes_show`·`minutes_save`로 읽고 고친다(저장은 차례로, 실패하면 화면을 되돌린다). `복사`는 `markdown`, `짧게 복사`는 `short`를 클립보드에 넣는다. 고친 적이 있으면 다시 만들기 전에 묻는다. 만드는 동안 노트 삭제를 막는다. 요약 탭은 `summaryTabDocs`·`summaryTemplates`로 회의록(옛 `summary.json`과 `minutes`)과 유형 `회의록`을 뺀다.
- 내보내기·MCP·Obsidian은 요약 key `minutes`로 읽는다(md는 `minutes.md`, docx·MCP 구조는 `sections`).

### 2.18 Obsidian으로 보내기: `tractus obsidian <노트> --vault <폴더>` (v3.37)

설계: [docs/design/obsidian-export.md](design/obsidian-export.md). 문구: WORDS.md §4.23.

- **명령:** `tractus obsidian <노트> --vault <볼트> [--summary KEY] [--audio] [--force]` → stdout `{"status": "created|updated|unchanged|edited", "path": <절대 경로>, "audio": <첨부 경로>|null}`. `edited`면 아무것도 쓰지 않았다(볼트에서 고친 파일). 없는 요약 key는 종료 코드 2, 볼트가 없거나 `<볼트>/Tractus`가 데이터 폴더와 겹치면 종료 코드 2·code `obsidian_vault`, 쓰기 실패는 code `obsidian_write`.
- **위치:** `<볼트>/Tractus/<Tractus 폴더 이름 경로>/<YYYY-MM-DD 제목>.md`. 파일 이름에 못 쓰는 글자(`/\:*?"<>|`, 제어 문자, 앞의 `.`)는 공백. 같은 이름의 남의 파일이 있으면 ` (2)`부터. 오디오(`--audio`)는 `<볼트>/Tractus/attachments/<meeting_id>.<확장자>`(크기가 같으면 다시 복사하지 않는다)이고 노트 위에 `![[…]]`로 붙인다.
- **내용:** frontmatter(`tractus_id`·`title`·`created`·녹음이면 `duration`·확정된 이름만 `participants`·`tags`·`favorite`·`folder`) → `# 제목` → 완성된 노트(`summaries/enhanced.md`, 없으면 `내 메모`) → `요약 · {이름}`(`--summary`, 없거나 `enhanced`면 기본 요약, 그것도 없으면 처음 있는 요약) → 접힌 상자 `> [!note]- 대화 내용`. 요약 md는 frontmatter·제목 줄을 빼고 제목 단계를 하나 내린다. 메모 노트는 본문이 곧 노트다.
- **기록:** `<볼트>/Tractus/.tractus.json` `{"notes": {<id>: {"path": <Tractus/ 기준>, "sha256"}}}`. 기록된 위치에 없으면 `Tractus/` 아래에서 frontmatter `tractus_id`로 찾는다. 기록이 없거나 sha256이 다르면 `edited`이고 `--force`로만 덮어쓴다. 위치가 바뀌면 새 위치에 쓰고, 고치지 않은 옛 파일만 지운다.
- **앱:** 설정 `obsidian_vault`(비면 안 고름)·`obsidian_audio`(기본 꺼짐)는 `set_obsidian(vault, audio)`이 바로 저장하고 `save_settings`는 지금 값을 지킨다. 내보내기 메뉴의 `Obsidian`은 쓰던 메모를 저장한 뒤 `obsidian_send(id, summary, force)`(요약 탭에서 고른 요약), 볼트를 안 골랐으면 먼저 폴더를 고르게 하고, `edited`면 묻고 `force`로 다시 부른다. `obsidian_open(path)`는 `<볼트>/Tractus` 안의 `.md`만 `obsidian://open?path=…`로 연다.

### 2.19 캘린더 일정으로 녹음하기: 녹음 폴더의 `event.json` (v3.38)

설계: [docs/design/calendar.md](design/calendar.md). 문구: WORDS.md §4.24.

- 앱이 녹음을 시작할 때 녹음 폴더에 `event.json` `{"title", "start", "end", "calendar", "attendees": ["이름"]}`을 쓴다. 코어는 `calendar_event.load_event`로 검사해 읽고(제목 1~200자, ISO 8601 시각, 참석자 한 줄 80자 이하·중복 제거·50명까지, 깨졌으면 없는 것), 노트 폴더로 옮긴다(`memos.json`처럼, 이미 있으면 그대로). transcript.json은 바뀌지 않는다.
- **제목:** `transcribe --recording`·`recording finish`의 기본 제목이 `녹음 HH:MM` 대신 일정 제목이다(`--title`이 이긴다).
- **hotwords:** 참석자 이름을 그 노트의 변환에만 더한다(v3.51부터 맨 앞, 그다음 `--term` → 자주 쓰는 단어 → 노트의 제목·메모에서 고른 낱말(v3.53, `asr.note_terms`), 앞의 50개). `transcribe --into`는 노트 폴더의 `event.json`을 읽는다. `glossary.md`에는 쓰지 않는다.
- **읽는 곳:** Obsidian frontmatter `attendees`, 내보내기 ZIP, 앱의 노트 상세 `attendees`(참석자 이름 고르기).

### 2.20 예시 노트: `tractus note sample` (v3.39)

첫 사용자 온보딩용 가상 회의 하나(`src/tractus/sample_note.json`, 내용은 tests/fixtures/sample_meeting.json의 가상 회의)를 만든다. 모델·AI 키 없이 돈다.

- stdout `{"meeting_id", "meeting_dir", "created"}`. 이미 있으면(`transcript.json`의 `"sample": true`) 그것을 돌려주고 `created: false`(하나만). 지우면(앱은 휴지통) 다시 만들 수 있다.
- 들어 있는 것: 대화 10줄과 확정한 참석자 이름 3명, 메모 탭 3줄(`memo`), 녹음 중 메모·북마크(`memos.json`), 회의록(`summary.json`), 완성된 노트(`summaries/enhanced.json`, `enhance.check`를 통과한다). 요약·완성된 노트의 provider·model은 `예시`다. 오디오는 없다(`audio.file`은 있지만 파일이 없어 재생 칸이 그렇게 말한다).
- **`"sample": true`인 노트는 검색 색인(`Index.sync`)과 MCP `list_meetings`에 넣지 않는다**: 전체 AI 질문·검색·에이전트가 가상 회의를 사실로 쓰지 않게. 노트 안의 AI 질문·요약·내보내기는 다른 노트와 같다.

## 3. Tauri 앱 (app/)

- **스택:** Tauri 2 + React + TypeScript + Vite. 오디오는 자체 `media://` URI 스킴(`convertFileSrc(path, "media")`, MIME `audio/ogg`, HTTP Range 지원, `TRACTUS_HOME` 밖 경로 거부)으로 `<audio>`에 연결한다. Tauri 기본 asset protocol은 `.ogg`/`.opus`의 MIME과 Range 처리가 맞지 않아 쓰지 않는다(`app/README.md`).
- **남은 녹음:** `recordings/<ULID>/recording.json`이 남아 있는 폴더는 "변환 대기 중인 녹음"으로 보여 준다. 코어는 전사에 **성공했을 때만** 녹음 폴더를 지운다(앱이 강제 종료되거나 전사가 실패해도 녹음은 남는다).
- **API 키·모델 위치:** 코어는 현재 폴더에 이어 `$TRACTUS_HOME/.env` / `.env.local`도 읽는다. 저장소 밖에 설치한 앱은 `$TRACTUS_HOME/.env.local`에 `UPSTAGE_API_KEY`, `TRACTUS_MODELS_DIR` 등을 둔다.
- **설정:** `TRACTUS_HOME`(기본 `~/Tractus`), `TRACTUS_MODELS_DIR`(비우면 코어가 정한다: §3.4), `tractus` 실행 파일 경로와 `tractus-rec` 경로(비우면 `자동`: 실행할 때마다 찾는다, §3.4). GUI 앱은 셸 PATH를 물려받지 않으므로 직접 지정은 절대 경로로 둔다.
- **데이터:** 노트 목록·전사·요약·메모는 Rust에서 파일을 직접 읽는다. 검색만 상주 `tractus mcp`의 `search_meetings`로 한다(색인·임베딩 모델을 매번 올리지 않으려고).
- **오류 문자열 규칙:** Rust가 invoke로 돌려주는 오류는 첫 줄이 화면 문장(WORDS.md), 둘째 줄부터가 원래 오류(OS 오류 문구 등)다. 앱은 첫 줄만 문장으로 보이고 나머지는 접힌 `자세히`에 둔다(`lib.splitMessage`, `errText`·`errDetail`). 예: 실행 파일을 띄우지 못함 → `Tractus 엔진을 실행할 수 없습니다. 설정에서 … (경로)` + `자세히`: `No such file or directory (os error 2)`.
- **수정 뒤 검색 반영(`index_refresh`):** 문장을 고치면(`changed > 0`) 마지막 수정에서 60초가 지나고(앞선 갱신이 끝난 지 5분 안이면 그 뒤로 미룬다. 임베딩 엔진을 자주 올리지 않으려는 것이다) 앱이 한가할 때 `tractus index`를 조용히 한 번 돌려 고친 청크를 임베딩한다(`indexSchedule.ts`, 성공하면 아무것도 보이지 않는다). 녹음·변환·가져오기 중이면 미루고(앱), 요약·단어 싱크·질문(전체 범위 질문도 `<ask>`로 표시한다)·편집·내보내기·다른 갱신이 돌고 있으면 Rust가 `false`로 비켜 간다(`BusyGuard::new_if_idle`, 한 번에 하나). 이미 돌고 있는 갱신은 녹음·변환·질문이 시작할 때 Rust가 멈추고(`cancel_index`) `false`로 끝난다: 모델이 겹쳐 올라가지 않게 하는 것이고, 다음 갱신이 빠진 벡터를 이어서 채운다. 임베딩하는 동안 그 청크가 다시 쓰였으면 낡은 벡터는 저장하지 않는다(`Index._ensure_vectors`). 앱 창으로 돌아올 때와 질문 창을 열 때 노트 목록을 다시 읽는다(앱 밖에서 만든 노트의 인용 칩이 `삭제된 노트입니다`로 보이지 않게). 실패하면 알림을 한 번 띄우고 다음 수정 때 다시 시도한다. 설정의 '스마트 검색 상태'를 열어 둔 채 끝나면 그 줄을 새로 읽는다.
- **단어 싱크 상태:** 노트 ID별로 앱 전체 저장소(`alignStore.ts`)에 둔다. 작업 중에 노트를 닫았다 다시 열어도 진행이 보이고, 같은 노트의 단어 싱크를 또 시작하지 못한다. 끝났다는 알림은 노트가 열려 있지 않아도 App이 띄운다.
- **가라오케(재생 중인 단어 강조):** 시작 시각이 같은 단어(실측 노트 하나에 132쌍)는 다음 다른 시작 시각까지를 균등하게 나눠 차례로 칠하고, 길이 0인 단어도 최소 0.12초는 칠한다(`lib.wordClock`, 단어 배열마다 캐시한 시작 시각 배열을 이진 탐색해 O(log n)). 마지막 단어는 `max(세그먼트 끝, wordClock.end)`까지 칠한다. 단어를 눌러 이동할 때도 같은 시각을 쓴다.
- **삭제된 노트의 인용:** 전체 범위 AI 질문의 인용 칩은 노트 목록에 없는 노트를 가리키면(답을 쓰는 사이에 지워졌거나 지워진 뒤) 누를 수 없고 `삭제된 노트입니다`라는 설명만 보인다. 목록을 새로 읽을 때마다 다시 판단한다.
- **목소리 등록 가능 여부:** 이름 바꾸기의 '목소리 등록' 체크는 `doctor`의 기능 `voices`가 준비되지 않았으면 `aria-disabled`로 두고 이유와 `모델 설치`를 보인다(`useVoicesGate`). 점검을 못 읽는 옛 코어일 때만 `voices list --json`의 `model_present`(키가 없으면 쓸 수 있다고 본다)를 쓴다. Rust `voices_list`가 이 값을 그대로 넘긴다(`VoiceList.model_present`).

#### 모델·점검의 앱 쪽 (§2.15를 쓴다, v3.23)

- **Rust 명령** (`models.rs`, 모두 인수 배열): `models_list`(`models list --json`), `doctor`(`doctor --json` + 앱이 쓰는 `tractus`·`tractus-rec` 경로가 있는지), `models_download(job, ids, preset)`(`models download <id>… [--preset P] --progress-json`), `models_cancel`, `models_remove(id)`(`models remove <id> --yes`), `models_move(dest)`(`models move --yes <절대 경로>`, 설정은 바꾸지 않는다: 화면이 성공한 뒤 `models_dir`을 저장한다. 노트 폴더(`TRACTUS_HOME`이거나 `meetings/`·`recordings/`가 있는 곳)는 목적지로 `bad_argument` 거부한다. 다른 볼륨이면 복사를 끝낸 뒤 원본을 지우고, 지우기가 실패해도 복사본은 두고 응답에 `leftover`(남은 옛 폴더 이름)와 stderr 경고를 준다), `models_prune`(`models prune --yes --json`), `set_checkup_done(done)`(설정 파일의 `checkup_done`만 바꾼다). 모델 ID는 `^[a-z0-9-]{1,40}$`(처음은 `-`가 아님), 구성은 `required|standard|lite|all`만 받고, 한 번에 16개까지다. 응답은 느슨하게 읽는다: 모르는 키·이상한 항목은 버리고 빠진 키는 빈 값이다(`parse_models_list`·`parse_doctor`). 모델 소개 키(`model_name` 등)는 문자열일 때만 받고 아니면 없는 것으로 본다(옛 코어는 키가 없어 모델 화면이 이름 아래 한 줄과 `자세히`를 보이지 않는다). **`doctor`는 실패하지 않는다**: 코어를 못 불러도(경로가 틀림, `doctor`가 없는 옛 코어) `{doctor: null, core_error, tractus_bin(_exists), rec_bin(_exists)}`로 답한다. 경로 키는 앱이 찾은 경로이고, 출처 `tractus_source`·`rec_source`(`custom|env|bundle|repo|known|none`), 이번 실행에서 되돌린 저장 경로 `stale_saved`, 데이터 폴더 `home`·`home_risk`(`iCloud Drive|Dropbox|OneDrive|Google Drive|Obsidian|null`)가 덧붙는다. `models_list`는 코어의 `unregistered`(`[{name, bytes}]`)를 느슨하게 싣는다(없으면 빈 목록 = 정리 줄을 숨긴다).
- **받기 작업.** `job` 이벤트(`kind: "models"`, `job`은 프론트엔드가 만든 ID)로 코어의 JSON 줄(§2.15 이벤트)과 마지막 `exit`를 그대로 보낸다. 받기는 앱 전체에서 한 번에 하나다(앱이 한 번 더 확인하고, 코어도 `busy`). `models_cancel`은 SIGTERM을 보내 코어가 받던 파일을 남기고 멈추게 하고(`cancelled` + 종료 코드 130), 10초 뒤에도 남아 있으면 SIGKILL한다. 앱을 끄면 받기에 SIGTERM을 보낸다. 상태는 `modelsJob.ts`(앱 전체 저장소)가 `models.downloadReduce`로 모으므로 모델 화면·시작 점검을 닫았다 열어도 진행이 이어진다. 코어가 알리는 `overall_done/overall_total`을 전체 진행률로 쓰고, 없으면 받을 모델의 크기 합으로 센다.
- **기능 잠금 (`useCapabilities`, `caps.ts`).** App이 시작할 때, 받기·지우기·설정 저장 뒤에, 창 초점이 돌아올 때(0.6초 디바운스, 5초 이내 반복 없음) `doctor`를 불러 `CapsContext`로 내려 준다. `can(id)` → `{ok}` 또는 `{ok: false, reason, missing, fix}`. 점검 결과가 없거나 그 기능이 점검에 없으면 `ok`다(앱을 막지 않는다). 못 쓰는 단추는 `GatedButton`(`aria-disabled`, 누르면 이유 팝오버 + 고치는 단추)과 `GateHint`(이유 한 줄 + 단추)로 한 곳에서 그린다. 잠그는 곳: 변환(파일 가져오기·`파일에서 추가`·끌어 놓기·`변환 대기 중인 녹음`의 변환), 녹음 프로그램(녹음 시작·녹음 추가), 단어 싱크 맞추기, 실시간 텍스트 변환 체크, 목소리 등록 체크, 참석자 구분 안내(노트마다 한 번 닫기), 스마트 검색(설정 상태·⌘K 검색). 변환할 수 없는 동안 녹음은 저장만 하고 변환을 시작하지 않는다(`변환 대기 중인 녹음`으로 남는다).
- **시작 점검 (`Checkup.tsx`, `checkupRows.ts`).** 설정의 `checkup_done`이 `false`(키가 없어도)인 처음 실행에 한 번 저절로 열린다. 닫으면(Esc·닫기·`점검 마치기`) `true`로 저장한다. 행은 `ok|warn|blocked|info`: 시스템(Apple Silicon·macOS 14.4+·메모리·디스크), 도구(앱이 쓰는 `tractus` 경로·`ffmpeg`+복사할 `brew install ffmpeg`·`tractus-rec` 경로·`tractus-diar`), 모델(필수·권장·선택 요약 + 구성 단추), 권한 안내(글), AI 키(`llm_settings`의 서비스별 등록 여부). 디스크 기준: 표준 구성 약 5.2 GB, 저사양 약 1.2 GB(레지스트리 크기의 합).

### 3.1 메뉴 막대 아이콘 (v3.24, 이슈 #1)

macOS 메뉴 막대에 Tractus 아이콘을 둔다. 창을 열지 않고 녹음을 시작·종료하고, 북마크를 남기고, 최근 노트를 열고, 창을 닫아도 앱(녹음·변환)이 계속 돌게 한다. 코어(Python)는 바뀌지 않는다. 구현은 `app/src-tauri/src/tray.rs`(메뉴·제목·아이콘·팝오버 창)와 `app/src/tray.ts`(화면 상태 → 메뉴 상태, 동작 라우팅), 팝오버 화면은 `app/src/TrayPopover.tsx`(`tray.html`), 문구는 WORDS.md §4.16이다. **아이콘을 왼쪽 클릭하면 팝오버, 오른쪽 클릭하면 아래의 기본 메뉴**가 뜬다(v3.57, 이슈 #32).

- **역할 나누기.** Rust는 그리기만 한다: 메뉴·아이콘·제목, 창 보이기·숨기기. 녹음 시작·종료·북마크는 Rust가 하지 않고 화면이 창의 단추와 **같은 함수**(`onRecordButton`·`sendRec`·`openMeeting`)로 처리한다. 그래서 쓰던 메모 저장, 마이크 권한 처리, 마지막으로 고른 녹음 방식, 기능 잠금 알림, 글만 있는 노트의 녹음 추가 흐름이 그대로 적용된다.
- **상태 → Rust: 명령 `tray_update(payload)`.** 화면(`App.tsx`)이 `deriveTrayState`로 만든 값을 보낸다. 같은 값은 다시 보내지 않고(`createTraySender`), 최근 노트 목록은 바뀔 때만 싣는다(없으면 Rust가 이전 목록을 둔다). 타이머로 모으지 않는다: 숨은 webview의 `setTimeout`은 한참 늦어져 메뉴가 낡은 채로 남는다.

  ```json
  {"phase": "idle" | "recording" | "paused" | "converting",
   "started_at_ms": 1760000000000,   // recording만. 녹음 시작 시각 (epoch ms). 일시정지한 시간은 센 적이 없다: 계속할 때마다 `지금 - 경과`로 다시 보낸다 (§3.3)
   "elapsed_ms": 754000,             // paused만. 일시정지한 순간의 경과 (녹음 시각, ms). 일시정지 중에는 시계를 읽지 않고 이 값으로 멈춘다
   "progress_pct": 45,               // converting만. 총량을 모르면 없다
   "can_record": true,               // 녹음 프로그램(caps `record`)이 있고 녹음·변환 중이 아닐 때만
   "can_bookmark": false,            // 녹음 중일 때만
   "recent": [{"id": "…", "title": "…"}]}   // 최근에 고친 순 5개 (updated_at, 없으면 만든 시각)
  ```

  Rust의 읽기는 관대하다(`parse_payload`): 모르는 `phase`는 `idle`, 이상한 타입은 기본값, `progress_pct`는 0~100으로 끌어 넣고, 객체가 아니어도 패닉하지 않는다(오래된 화면). 화면의 `starting`은 시각 없는 `recording`(`녹음 준비 중…`, 종료·북마크 막음), `paused`는 `paused`(`일시정지됨 12:34`, 종료·북마크·계속은 켜고 새 녹음은 막음), `stopping`은 `converting`으로 보낸다. 노트로 저장하는 중(`recording finish`)과 변환 전 노트 변환도 `converting`이다. 녹음을 변환하는 중(`stopping`·변환 작업·대기)에는 `can_record`가 `false`다: 사이드바 녹음 단추가 변환이 끝난 뒤에만 녹음을 시작하는 규칙과 같다. 파일 가져오기·노트에 파일 추가 변환(`imp.job.running`·대기 파일·attach `converting`)은 창의 녹음 단추를 막지 않으므로 `phase: "converting"`(상태 줄 `변환 중 N%`)이지만 `can_record`는 녹음 프로그램 유무 그대로다. Rust는 `녹음 시작`을 `녹음 중이 아니고 can_record`일 때 켠다.
- **알림: 명령 `tray_show_if_hidden`.** 녹음 시작 실패(`rec.phase === "error"`)나 녹음 경고는 녹음 화면에만 보이므로, 화면이 이때 이 명령을 불러 숨었거나 최소화한 창을 꺼낸다(보이는 창은 그대로). 메뉴 막대에서 시작한 녹음이 숨은 창에서 조용히 실패하지 않게 한다. 북마크는 창을 숨긴 동안 따로 알리지 않는다(알려진 한계).
- **동작 → 화면: 이벤트 `tray-action`** (메인 창에만 `emit_to`). `{"action": "record_start" | "record_pause" | "record_resume" | "record_stop" | "bookmark" | "open_note", "id"?: 노트 ID}`. 화면이 아직 준비되지 않았으면 이벤트는 조용히 버려진다. `routeTrayAction`이 지금 상태에서 뜻 없는 동작(이미 녹음 중인 시작, 녹음 중이 아닌 종료·북마크)을 무시하고, 메뉴를 빠르게 두 번 눌러도 두 번째가 들어오기 전에 단계를 앞당겨 `rec_start`가 두 번 불리지 않게 한다. `Tractus 열기`와 `open_note`는 Rust가 창을 직접 보이고(`show`+`unminimize`+`set_focus`) 숨은 창에서도 된다. `종료`는 ⌘Q와 같은 `begin_quit`이다(쓰던 메모 저장, 3초 안에 종료, 녹음에는 `stop`).
- **경과 시간.** 화면 타이머를 쓰지 않는다. 화면이 녹음 시작 시각(`rec` 이벤트 `started`를 받은 `Date.now()`)을 한 번 보내고, Rust가 1초 틱(별도 스레드가 메인 스레드에 `sync`를 맡긴다)으로 상태 줄과 아이콘 옆 글자(`●12:34`, 한 시간이 넘으면 `●1:02:03`)를 고친다. 틱은 단계가 바뀌거나 아이콘을 끄거나 앱이 끝나면(`RunEvent::Exit`) 멈춘다. **일시정지 중에는 틱이 멈춘다**: 상태 줄 `일시정지됨 12:34`와 아이콘 옆 `‖12:34`는 화면이 보낸 `elapsed_ms`로 고정되고 시계를 읽지 않는다. 메뉴는 줄이 바뀔 때만 다시 만들고, 경과 시간은 글자만 바꾼다. 팝오버의 녹음 시각도 같은 틱이 센다: 틱마다 보이는 팝오버에 `tray-popover`를 다시 보내고, 팝오버는 받은 `started_at_ms`와 받은 순간의 시계로 그린다(팝오버에는 타이머가 없다).
- **팝오버 (왼쪽 클릭, v3.57).** 창 `tray`(`tray.html`, 폭 300pt, 투명·테두리 없음·항상 위·모든 Space, 높이는 화면이 내용에 맞춘다). 맨 위 녹음 막대(대기 중: 상태 문구 + `녹음 시작` / 녹음 중·일시정지: 녹음 시각 + `북마크 남기기`·`일시정지`(`계속`)·`녹음 종료` / 변환 중: 진행률 + 진행 막대, 녹음을 시작할 수 없으면 시작 단추를 숨긴다) · 구분선 · `Tractus 열기` · `종료`. **최근 노트는 팝오버에 없고 오른쪽 클릭 메뉴에만 있다.** 단추는 글자 없이 `aria-label`·`title`만 둔다.
  - **상태 → 팝오버.** 명령 `tray_popover_state`(처음 뜰 때)와 이벤트 `tray-popover`(열 때, 상태가 바뀔 때, 녹음 중 1초 틱마다; 보일 때만). 값은 `popover_state(payload)`: `{"phase": "idle"|"starting"|"recording"|"paused"|"converting", "status", "started_at_ms", "elapsed_ms", "progress_pct", "can": {"start","pause","resume","stop","bookmark"}, "recent"}`. 단추를 누를 수 있는지는 메뉴와 같은 `render` 판단이다.
  - **팝오버 → 동작.** 명령 `tray_popover_action(id)`: 메뉴 항목과 같은 ID(`tray:` 접두어만 받는다)로 `on_menu_event`를 지나 `tray-action`이 된다. 녹음 단추는 팝오버를 연 채로 두고(바뀐 시각·단추가 바로 보인다), `Tractus 열기`·`종료`는 닫는다(`popover_closes_on`).
  - **닫기.** 바깥 클릭(`Focused(false)`), Esc(명령 `tray_popover_hide`), 아이콘 다시 클릭, `Tractus 열기`·`종료`. 모두 `hide_popover`를 지나 숨긴 시각을 남기고, 그 뒤 300ms 안의 아이콘 클릭은 다시 열지 않는다(아이콘을 눌러 닫을 때 포커스를 잃어 숨는 것이 클릭보다 먼저 온다).
  - **위치.** 카드 왼쪽 끝을 아이콘 왼쪽 끝에, 위 끝을 메뉴 막대 바로 아래에 붙이고, 아이콘이 있는 화면의 오른쪽 끝을 넘으면 안쪽으로 민다. tray-icon이 주는 아이콘 사각형은 전역 논리 좌표에 **아이콘이 있는 화면의 배율**을 곱한 값이라, 화면마다 그 배율로 되돌려 아이콘의 화면을 찾고(`icon_rect_pt`, 배율이 다른 두 화면에 모두 들면 높이가 메뉴 막대 24pt에 가까운 쪽) 논리 좌표로 놓는다(`popover_origin`). 팝오버 창이 지금 있는 화면의 배율을 쓰지 않는다.
  - **언어·테마.** 언어를 바꾸면(`set_ui_lang` → `relabel`) 팝오버 창을 없애고 다음 클릭에 새 언어로 다시 만든다(문구가 창을 불러올 때 정해진다). 테마는 팝오버가 포커스를 받을 때마다 메인 창과 같은 저장소의 선택을 다시 적용한다.
  - **권한** (`capabilities/tray.json`, 창 `tray`만): `core:event:default`, `core:window:allow-set-size`, `core:window:allow-set-theme`. 앱 명령은 따로 막지 않는다(앱 매니페스트 없음).
  - **빌드.** 둥근 카드 밖을 비우는 투명 창이라 Tauri `macOSPrivateApi: true`(Cargo 기능 `macos-private-api`)를 켰다. 비공개 API를 쓰므로 Mac App Store에는 낼 수 없다(ARCHITECTURE.md v3.57).
- **메뉴 (오른쪽 클릭).** 상태 줄(눌리지 않음) · `녹음 시작` · `일시정지`(일시정지 중에는 같은 자리가 `계속`) · `녹음 종료` · `북마크 남기기` · 구분선 · `최근 노트` ▸ (최대 5개, 제목 40자, 클릭하면 노트 열기) · 구분선 · `Tractus 열기` · `종료`. 항목을 숨기지 않고 못 쓸 때는 비활성으로 둔다.
- **설정** (`settings.json`, 없으면 기본값 — 옛 설정 파일 호환): `tray_enabled`(기본 `true`, `메뉴 막대에 Tractus 표시`), `keep_in_tray`(기본 `true`, `창을 닫아도 메뉴 막대에 남기기`, `tray_enabled`가 꺼지면 쓸 수 없다). 설정 화면의 두 스위치는 저장 단추를 기다리지 않고 `set_tray_prefs`로 바로 적용한다(그 두 키만 병합해 쓴다. `save_settings`도 같은 적용을 한다). 아이콘은 실행 중에 만들고 없앤다(다시 시작 없음). 끌 때 창이 숨어 있으면 다시 보인다(다시 찾을 길이 Dock뿐이라서).
- **창 닫기.** `should_hide_on_close(settings, tray_exists)` = `tray_enabled && keep_in_tray && 아이콘이 실제로 떠 있음`. 참이면 Rust의 창 이벤트 핸들러가 `prevent_close` + `hide`한다. 화면의 닫기 핸들러는 `tray_hides_on_close`로 같은 판단을 물어 참이면 쓰던 메모만 저장하고 닫기를 막는다(숨기기만 하므로 변환 취소 경고를 띄우지 않는다). 거짓(설정이 꺼짐, OS가 아이콘을 거절)이면 기존 흐름 그대로다: 닫기 확인 → 마지막 창이 닫히며 `ExitRequested` → `defer_exit`. Dock 아이콘(`RunEvent::Reopen`)은 숨은 창을 다시 보인다. ⌘Q와 아이콘의 `종료`는 `begin_quit`이다.
- **아이콘.** 검정 + 투명 배경 macOS 템플릿 이미지(18×18 @1x, 36×36 @2x: tray-icon이 macOS에서 모든 이미지를 높이 18pt로 맞추므로 그 크기로 그려 줄이지 않는다, `set_icon_as_template(true)`로 라이트·다크에 맞춘다). 쉬는 중은 소리 막대 5개, 녹음 중은 막대 3개 + 꽉 찬 점. `scripts/make_tray_icons.py`(표준 라이브러리만, 재현 가능)가 `app/src-tauri/icons/tray/`의 PNG 4개를 만든다. 자리표시자라 디자이너가 PNG를 바로 바꿔 끼우면 된다(코드는 `@2x`를 `include_bytes!`로 읽는다). macOS `set_icon`은 템플릿 표시를 지우므로 아이콘을 바꿀 때마다 다시 건다.
- **견고함.** `tray_update`는 잠금이 오염돼도 패닉하지 않는다. 아이콘을 만들지 못하면(OS가 거절) 기록만 하고 앱은 계속 뜨며, 그때는 창을 닫으면 그대로 끝난다. 메뉴 이벤트 핸들러는 앱 전체에 하나만 둔다(아이콘을 다시 만들 때마다 쌓이지 않게). 트레이 핸들은 메인 스레드에서만 만지고 버린다.
- **빌드.** Tauri 기능 `tray-icon`, `image-png`를 켰다. 새로 잠기는 크레이트: `image 0.25`(MIT OR Apache-2.0), `byteorder-lite`(Unlicense OR MIT), `moxcms`·`pxfm`(BSD-3-Clause OR Apache-2.0) — `image-png`가 PNG를 읽으려고 끌어온다. `tray-icon`(MIT OR Apache-2.0)은 이미 `Cargo.lock`에 있던 것이다.

### 3.2 양쪽 패널 접기·펼치기 (v3.26)

왼쪽 노트 목록(사이드바)과 노트 화면의 오른쪽 패널(`요약`·`회의록`·`AI 질문`·`메모` 탭)을 각각 접고 펼 수 있다. 코어(Python)·Rust는 바뀌지 않는다. 구현은 `app/src/panels.ts`(순수 로직), `PanelToggle.tsx`(상태·단추), 문구는 WORDS.md §4.17이다. ⌘J AI 어시스턴트 서랍은 따로 뜨는 덮개라 그대로다.

- **단추.** 패널마다 하나. 아이콘(꺾쇠) + 이름(`aria-label`)이고 `title`에 단축키가 붙는다: `노트 목록 접기`/`펼치기`(`⌘B`), `오른쪽 패널 접기`/`펼치기`(`⌥⌘B`). `aria-expanded`, `aria-controls`(`sidebar-body`·`rail-body`), `aria-keyshortcuts`(`Meta+B`·`Alt+Meta+B`), 32×32 눌림 영역, 전역 `:focus-visible` 고리. 단추는 패널 안쪽이 아니라 **가장자리 띠에 붙어 있어** 접힌 뒤에도 남는다.
- **접힌 모양.** 왼쪽은 56px 띠: 펼치기 단추 + **녹음 단추**(동그란 점, 녹음 중에는 붉게, 이름 `녹음 시작`/`녹음 중`/`변환 중…`, 기능 잠금·변환 중 규칙은 사이드바 녹음 단추와 같고, 파일 가져오기·대기 중도 `변환 중…`으로 보인다). 목록 안에만 있는 `변환 대기 중인 녹음`이 있으면 단추 아래에 개수 배지(`변환 대기 중인 녹음 N개`)가 뜬다. 가져오기 진행 막대·경고·목록 불러오기 오류는 목록 안에만 있어 접힌 동안 안 보인다(알려진 한계: 완료·실패는 알림 토스트와 메뉴 막대 아이콘이 알린다). 녹음은 한 번에 닿아야 해서 두었고, 새 노트·검색·설정은 두지 않았다(`⌘N`은 그대로 되고, `⌘K`는 목록을 펼친다). 오른쪽은 52px 띠에 펼치기 단추만 있다. 가운데(전사·편집기)가 남는 너비를 모두 쓴다. 1180px 이하의 좁은 창에서는 오른쪽 패널이 전사 아래로 가므로, 접으면 단추 줄(60px)만 남는다.
- **내용은 마운트한 채 숨긴다.** `hidden`(`display: none`)이라 탭 순서·화면 읽기에서 빠지고, React 트리는 그대로다: 메모 편집기의 쓰던 글, AI 질문의 스트리밍, 요약 작업이 접어도 이어진다. 접힌 패널의 스크롤 위치는 돌아오면 맨 위일 수 있다(알려진 한계).
- **움직임.** 너비·높이를 움직이지 않는다: 한 번에 바뀐다(애니메이션 없음 → `prefers-reduced-motion`에서도 같다). 색 전환만 `--fast`.
- **상태.** `{left, right}` 불리언(`true` = 접힘). `localStorage` 키 **`tractus.panels.v1`**(이 창 전용, 읽기·쓰기는 try/catch, 비어 있거나 깨졌거나 모양이 다르면 없는 것으로 본다. 칸마다 따로 읽어 불리언이 아닌 칸은 버린다). 기본은 둘 다 펼침. **저장한 선택이 없고** 처음 그릴 때 창 너비가 960px 미만이면 오른쪽만 접고 시작한다(이 기본값은 저장하지 않으므로 창을 넓히고 다시 켜면 펼쳐진다). 저장한 값은 항상 이긴다. **사용자가 단추·단축키로 접고 편 칸만** 저장한다(`{left}`만 저장될 수 있다): 좁은 창에서 왼쪽만 접어도 오른쪽은 계속 기본값을 따른다. 아래 자동 펼침은 저장하지 않는다.
- **단축키.** `⌘B` 왼쪽, `⌥⌘B` 오른쪽. 물리 키(`e.code === "KeyB"`)로 보므로 한글 입력 상태에서도 되고(⌥B는 `∫`), 글을 쓰는 중에도 된다(Tauri 기본 macOS 메뉴에 ⌘B가 없다). 단 메모 입력창에서 글자를 골랐을 때의 ⌘B는 굵게 쓰기다(v3.50, 고른 글이 없으면 그대로 목록 접기). 한글 조합 중에는 무시하고, 키를 누르고 있어도 한 번만 바꾼다. 맨 `B`(녹음 중 북마크)는 ⌘를 거부하므로 겹치지 않는다. 노트 화면이 아닐 때 `⌥⌘B`는 아무것도 하지 않는다(오른쪽 패널이 없다). 첫 화면 단축키 목록에 두 줄을 더했다.
- **초점.** 접는 패널 안에 초점이 있으면(`document.activeElement`가 `sidebar-body`·`rail-body` 안) 접기 전에 그 패널의 단추로 옮긴다. 펼칠 때는 초점을 옮기지 않는다.
- **오른쪽을 접을 때 메모 저장.** 접기 전에 `flushMemos()`로 열려 있는 메모를 저장한다(숨기면 입력창 blur가 믿을 수 없고 단축키로 접으면 blur가 없다). **저장하지 못하면 접지 않는다**(화면 이동과 같은 규칙: 오류는 열려 있는 편집기가 이미 보인다). 왼쪽을 접을 때는 저장하지 않는다.
- **자동 펼침(`panels.revealFor`, 순수 함수).** (a) 녹음 노트의 `메모 N번째 줄` 칩·검색 결과(`openMemoLine`)는 메모 탭이 오른쪽 패널에 있으므로 접혀 있으면 펼친다. 메모(글쓰기) 노트의 줄은 가운데 본문이라 펼치지 않는다. (b) 대화 시각으로 이동, ⌘K·목록·인용으로 노트 열기, 녹음 단추는 접힘을 건드리지 않는다. (c) **`⌘K`만은 접힌 왼쪽을 펼치고 검색창에 초점을 준다**(검색창이 목록 안에 있어서 안 펼치면 단축키가 죽는다). 요약 만들기·질문은 오른쪽 패널 안의 단추라 접힌 채로는 누를 수 없고, 시작해도 접힌 패널을 대신 펼치지 않는다.
- **다른 기능과.** 녹음 화면·점검·모델 화면은 가운데 화면이라 왼쪽 접기가 그대로 된다(오른쪽 패널은 노트 화면에만 있다). 메모 노트·변환 전 노트도 같은 단추다(탭 구성만 다르다). 찾기 막대(⌘F)는 가운데에 있어 영향이 없다. PDF 인쇄는 `#root` 전체를 숨기고 인쇄 문서만 그리므로 접힘 상태와 무관하다. 메뉴 막대 아이콘·⌘J 서랍은 바뀌지 않는다(서랍은 창 오른쪽에 떠 있고, 접힌 목록이면 `AI 어시스턴트` 단추가 숨는다: `⌘J`로 연다).
- **폭 조절(v3.49).** 펼친 패널의 경계에 손잡이(`PanelResizer`, `role="separator"`, `aria-valuenow`·`min`·`max`). 끌거나 초점을 두고 ←/→(16px, 화살표 방향으로 경계가 움직인다)·Home·End, 두 번 누르면 기본 폭. 범위는 왼쪽 200~400px(기본 260), 오른쪽 280~560px(기본 340)이고 가운데는 420px보다 좁히지 않는다(`panels.clampWidth`). 폭은 CSS 변수 `--sidebar-w`·`--rail`로 그리고 놓을 때 `localStorage` **`tractus.panelWidths.v1`**에 기억한다. 창을 줄이면 그리는 폭만 맞추고 정한 폭은 그대로라 창을 키우면 돌아온다. 오른쪽 손잡이는 1180px보다 좁아 패널이 아래로 내려가면 숨는다. 손잡이의 ←/→는 재생 단축키로 가지 않는다.
- **검사.** `panels.test.ts`(접기·저장·깨진 값·좁은 창 기본값·자동 펼침·단축키·메모 저장 순서·문구·단추 렌더·폭 범위·키·손잡이 렌더). 화면에서 보는 항목은 `app/README.md` 체크리스트.

### 3.3 녹음과 변환 나누기: 일시정지·끝낼 때 고르기·변환 전 노트 (v3.25)

코어 §2.16(`recording finish`, `transcribe --into`, 노트 상태 `state: "recorded"`)과 녹음 헬퍼 §1(`pause`·`resume`·`paused`·`resumed`)을 앱이 쓰는 방법이다. 문구는 WORDS.md §4.18. 순수 로직은 `afterRecord.ts`·`pause.ts`·`convertQueue.ts`·`recorded.ts`(테스트가 같이 있다)이고 화면은 `AfterRecordDialog.tsx`·`ConvertPanel.tsx`·`RecordView.tsx`·`MeetingView.tsx`·`NoteRow.tsx`·`App.tsx`다.

**쓰는 계약.** 녹음 헬퍼: stdin `pause`·`resume`(이미 일시정지 중인 `pause`는 아무 일도 없다), 이벤트 `paused {elapsed}`·`resumed {elapsed}`(`elapsed`는 일시정지를 뺀 오디오 시각, 초), 일시정지 중에는 `level`이 없다. 코어: `tractus recording finish <녹음 폴더> [--title=T] --progress-json`(→ `stage(encode)`, `done {meeting_id, meeting_dir}`, 실패해도 녹음 폴더는 남는다), `tractus transcribe --into <노트> --progress-json`(→ `transcribe`와 같은 이벤트, 변환 전이 아니면 종료 코드 2 + `not_recorded`), 목록·상세의 `state`(`"recorded"`일 때만 키가 있다).

- **일시정지·계속.** 녹음 화면에 `일시정지`/`계속` 단추(레이블이 바뀐다), 메뉴 막대에 같은 항목. 앱은 `rec_send("pause"|"resume")`(Rust `procs::recorder_line`이 이 두 줄만 더 받는다)로 보내고 **이벤트가 올 때만** 상태를 바꾼다(`recReduce`: `paused` → 단계 `paused` + `t = elapsed` + 미터 비움, `resumed` → `recording` + `t = elapsed`, 순서가 어긋난 이벤트는 무시). 화면 시계는 마지막 이벤트의 녹음 시각에서 시작해 `recording`일 때만 0.5초마다 흐른다(`pause.clockAt`, 기준은 `level`·`paused`·`resumed` 이벤트): 일시정지 중에는 멈추고 계속하면 `elapsed`에서 다시 시작한다. 메뉴 막대는 시작 시각을 `지금 - elapsed`로 다시 보내(`pause.resumedStartMs`) 일시정지한 시간을 세지 않고, 일시정지 중에는 `elapsed_ms`만 보내 Rust 틱이 멈춘다(§3.1). 북마크·메모·`녹음 종료`는 일시정지 중에도 된다. **한계:** 일시정지해도 녹음 프로그램은 떠 있어 macOS 마이크 사용 표시가 켜진 채다(안내문이 말한다).
- **끝낸 뒤.** 설정 `after_record`(`"ask"`(기본)|`"convert"`|`"later"`, 없거나 모르는 값은 `ask`, Rust `Settings.after_record`, 설정 화면의 `녹음을 끝내면`은 `set_after_record`로 바로 저장한다)와 변환 기능 잠금으로 `afterRecord.stopAction`이 정한다. `recorder stopped`를 받으면 설정 파일을 다시 읽어(`get_settings`) 아래 중 하나를 한다.

  | 설정 | 변환 가능 | 변환 불가 |
  | --- | --- | --- |
  | `convert` | 옛 흐름 그대로 `transcribe --recording` | 옛 흐름 그대로: 녹음 폴더만 남기고 `UNCONVERTED_SAVED` 안내 |
  | `later` | `recording finish` → 끝나면 새 노트를 연다 | 같음 (변환 엔진 없이도 된다) |
  | `ask` | 묻는 창 | 묻는 창(`바로 변환하기`는 `aria-disabled` + 이유, 초점은 `나중에 변환하기`) |

  글만 있는 노트에 추가하는 녹음(`attach.json`)은 설정과 상관없이 위 `convert` 줄이다(덧붙이는 변환이라 변환 전 노트로 둘 수 없다). 묻는 창은 네이티브 모달 `<dialog>`다: 처음 초점은 `바로 변환하기`(못 쓰면 `나중에 변환하기`), **Esc = `나중에 변환하기`**(녹음을 버리는 길은 없다), 체크 `다음부터 묻지 않기`를 하고 고르면 `set_after_record`로 그 선택을 남긴다(Esc는 남기지 않는다). 메뉴 막대에서 끝냈으면 창이 숨어 있어도 `tray_show_if_hidden`으로 꺼내 묻는다. **녹음은 항상 남는다**: 묻는 중에 앱이 끝나거나 저장·변환이 실패하면 녹음 폴더가 그대로라 `변환 대기 중인 녹음`에 보인다.
- **Rust 명령** (`deferred.rs`). `recording_finish(dir, title?, job)`: 녹음 폴더(`meetings::is_recording_dir`)만 받고 `--title=T`(`clean_title`, 빈 제목은 안 넘겨 코어가 `녹음 HH:MM`)로 `recording finish --progress-json`을 띄운다. `convert_note(id, job)`: `^[A-Za-z0-9]+$` ID만 받아 `transcribe --into <ID> --progress-json`. 둘 다 `job` 이벤트로 `{job, kind: "finish" | "convert"}`를 달아 보내고, 끝날 때까지 대상(녹음 폴더 / 노트 ID)을 쓰는 중으로 표시해(`hold`) 삭제를 거절하며(`BusyGuard`와 같은 표), 돌고 있는 백그라운드 검색 갱신을 멈춘다. `convert` 작업의 프로세스는 작업 ID로 `AppState.asks` 표(질문과 같은 표)에 넣어 `ask_cancel(job)`이 kill할 수 있게 한다(새 녹음이 변환을 멈출 때). 변환 전 여부는 Rust가 보지 않는다(코어 `not_recorded`). `set_after_record(value)`는 설정 파일의 그 키만 바꾼다(`ask|convert|later`만).
- **변환 줄(`convertQueue.ts`).** 노트 하나를 변환하는 것도 `변환 전 노트 모두 변환`도 같은 줄이다: 한 번에 하나(변환 엔진이 한 번에 하나만 올라간다), 줄은 `{current, pending, finished, total}`이고 실패해도 이어진다(실패는 알림 `‘제목’ 노트를 텍스트로 변환하지 못했습니다` + `자세히`). 줄의 첫 노트는 **녹음·바로 변환(`transcribe --recording`)·노트로 저장·가져오기가 끝난 뒤에** 시작하고(앱 전체 `transcribing` 규칙에 `finish`·`convert`를 넣어 새 녹음·가져오기·창 닫기 확인이 같은 규칙을 쓴다), 시작하기 전에 노트가 지워졌거나 이미 변환됐으면(`state` 없음) 건너뛴다. 진행은 `convertJobs.ts`(앱 전체 저장소, 단어 싱크 `alignStore`와 같은 틀)가 노트 ID별로 들고 있어 노트 화면을 닫았다 열어도 보인다. 한 노트의 변환이 끝나면 열려 있는 노트 화면이 대화 내용을 다시 읽는다.
- **새 녹음은 변환 줄을 멈춘다(리뷰 반영).** 새 녹음을 막는 일(`recordBlocked`)은 녹음 변환·노트로 저장·변환 대기(`waitDir`)와 끝낸 녹음을 묻는 창(`afterAsk`)뿐이다. 변환 줄(돌든 기다리든)은 막지 않는다: 도는 변환이 있으면 녹음을 시작하는 순간 `convertStore.cancel`(→ `ask_cancel`)로 kill하고(변환은 멈춘 곳부터 이어 할 수 있다) 알림 `녹음하는 동안 변환을 멈춥니다. …`을 낸다. 그 변환의 끝 알림은 실패로 알리지 않고 줄도 넘기지 않으며(`preempted`), 줄은 `recording`·`asking`이 풀릴 때까지 시작하지 않는다. 그 뒤 같은 노트를 `transcribe --into`로 다시 시작해 이어서 한다. 메뉴 막대는 변환 줄을 가져오기와 같이 본다(`importing`: 상태 줄만 `변환 중`이고 `can_record`는 그대로). 묻는 창이 떠 있는 동안에는 `waiting`으로 보내 `can_record: false`다. 바로 변환(`waitDir`)도 `recording` 중에는 시작하지 않는다.
- **노트 화면(`state: "recorded"`).** 날짜 옆 배지 `변환 전`, 통계 `{길이} · 녹음 중 메모 N개`, 가운데에 `ConvertPanel`(`아직 텍스트로 변환하지 않았습니다` + `텍스트로 변환`: 변환 엔진·ffmpeg가 없으면 `GatedButton`이 이유와 고치는 길, 변환 중이면 단계·진행률, 줄에서 기다리면 `녹음이 끝나면 …`/`앞선 변환이 …`, 실패하면 이유 + `자세히` + `다시 변환`). 플레이어·메모 탭·제목·태그·폴더·즐겨찾기·내보내기(SRT·WebVTT 제외)는 그대로고 `찾아 바꾸기`·`단어 싱크 맞추기`·참석자 막대는 없다. 요약·AI 질문 탭은 남겨 두고 안에 `먼저 텍스트로 변환하세요`를 보인다(`recorded.railNotice`). 변환하는 동안(또는 줄에서 기다리는 동안) `삭제`는 막힌다(앱) — Rust도 `hold`로 거절한다. 메모는 계속 쓸 수 있고 코어가 합친다(§2.16).
- **사이드바.** 변환 전 노트 줄에 배지 `변환 전`(줄에 올리면 `변환 대기`·`변환 중…`)과 `…` 메뉴 `텍스트로 변환`. `변환 대기 중인 녹음`의 줄에는 `변환하기`·`삭제`에 `노트로 저장`(→ `recording finish`, 진행은 녹음 화면)이 더해진다(글만 있는 노트에 추가하려던 녹음은 제외). 변환 전 노트가 2개 이상이면 `파일 가져오기` 아래에 `변환 전 노트 모두 변환 (N)`(만든 순서, 오래된 것부터)이 보이고, 도는 동안은 같은 자리에 진행 줄 `2 / 3 · ‘제목’`이 보인다. 사이드바 녹음 단추는 `녹음 중 12:34` → `일시정지됨 12:34` → `저장 중…`/`변환 중…`(`pause.recButton`).
- **파싱.** `meetings.rs`가 `state`를 관대하게 읽는다: 문자열 `"recorded"`이고 `kind`가 메모가 아닐 때만 `info.state: "recorded"`, 그 밖의 값(숫자·모르는 문자열·메모 노트)은 키가 없는 평범한 노트다.
- **한계.** (1) 변환 줄에 따로 취소 단추는 없다(새 녹음 시작이 도는 변환을 멈추는 길이고, 줄은 그대로 남는다). 글만 있는 노트에 추가하는 녹음(`startAttachRecord`)은 변환 줄이 있으면 전처럼 막힌다. (2) "이어서 녹음"(`recording attach`)은 코어가 만들지 않아 앱에도 없다. (3) 줄에 올린 노트도 지워지지 않게 막지만 앱 밖(터미널)에서 지우면 시작할 때 코어 오류로 알린다. (4) 묻는 창에서 변환 가능 여부는 창을 띄울 때 한 번 읽고, 뜬 사이 바뀌면 `바로 변환`을 `나중에`로 바꾼다(`effectiveChoice`).
- **검사.** vitest: `afterRecord.test.ts`(설정 읽기·끝낸 뒤 할 일·묻는 창), `pause.test.ts`(사이드바 녹음 단추·화면 시계·메뉴 막대 시작 시각), `convertQueue.test.ts`, `recorded.test.ts`(변환 전 판정·화면 모델·탭 안내·내보내기 형식·삭제 막기), `lib.test.ts`(`recReduce` 일시정지·계속), `tray.test.ts`(일시정지 상태·라우팅). cargo: `deferred.rs`(`recording finish`·`transcribe --into` 인수와 검증, 설정 기본값 `ask`, 한 키만 저장), `procs.rs`(`pause`·`resume` 줄), `tray.rs`(일시정지 메뉴·고정 시계·읽기), `meetings.rs`(`state` 관대한 읽기). 화면에서 보는 항목은 `app/README.md` 체크리스트.

### 3.4 경로: 자동 / 직접 지정, 모델 폴더, 데이터 폴더 (v3.28)

- **자동이 기본.** `settings.json`의 `tractus_bin`·`rec_bin`·`models_dir`이 비어 있으면 자동이다. 저장하는 것은 사용자가 입력한 값뿐이고(`save_settings`는 자동 후보와 같은 값을 비운다: 화면이 찾은 경로를 되돌려 보내도 굳지 않는다), 옛 파일의 필드 이름은 그대로다(`serde(default)`).
- **찾는 순서(`paths.rs`, 코어·녹음 프로그램 같은 규칙).** ① 직접 지정(파일이 있을 때) → ② 환경변수 `TRACTUS_BIN`·`TRACTUS_REC_BIN` → ③ 앱 번들 안: `current_exe()`의 `../Resources/runtime/bin/tractus`, `../Resources/bin/tractus-rec`(있을 때만) → ④ 컴파일 때 저장소(`CARGO_MANIFEST_DIR`: `.venv/bin/tractus`, `recorder/.build/release/tractus-rec`, 있을 때만) → ⑤ `~/.local/bin/tractus`, `/opt/homebrew/bin/tractus`(코어만). 하나도 없으면 출처 `none`이고 경로는 안내용이다(직접 지정한 값, 없으면 저장소 경로). 하위 프로세스(`tractus()`·`mcp_spawn`·`rec_start`·`doctor`)가 모두 이 한 함수를 쓰고, `TRACTUS_REC_BIN`은 찾은 녹음 프로그램 경로를 코어에 넘긴다. 번들 구성(`Resources/runtime/`의 옮길 수 있는 Python과 래퍼 `runtime/bin/tractus`, `Resources/bin/tractus-rec`)은 `scripts/build_app_bundle.sh`가 만든다(ARCHITECTURE.md v3.30, docs/setup.md §10). 번들의 코어는 `sys.executable`이 `runtime/bin/python3.12`라서 `paths.tool_bin`이 `../../bin/`에서 녹음 프로그램을 찾는다. 코어는 번들 안에 쓰지 않는다(`PYTHONDONTWRITEBYTECODE=1`).
- **옛 설정 이전.** 읽을 때 저장된 `tractus_bin`·`rec_bin`이 없는 파일이면 자동으로 되돌리고(`Settings.stale`, 파일에는 쓰지 않는다) 시작 점검이 `저장된 경로가 없어 자동 경로를 씁니다`로 알린다. 자동 후보와 같은 값(예전 앱이 저장한 기본값)은 조용히 자동으로 바꾼다. 다음 저장 때 파일이 고쳐진다.
- **화면.** 설정의 두 경로 칸은 찾은 경로(읽기만)와 배지 `자동`/`직접 지정`(`BinField.tsx`, 순수 로직 `paths.ts`)을 보이고, `직접 지정`은 입력 + `찾아보기…`(`tauri-plugin-dialog`) + `자동으로 되돌리기`다. 시작 점검의 도구 행은 같은 경로·출처와 같은 단추를 준다(`checkupRows.ts`, 고르기·저장은 `pathFix.ts`, 점검을 닫지 않고 처리한다).
- **모델 폴더(코어 `paths.models_dir`).** `TRACTUS_MODELS_DIR` → `$TRACTUS_HOME/models`(등록된 모델 폴더가 하나라도 있을 때만, 기존 사용자 호환) → 새 기본 `~/Library/Application Support/dev.tractus.app/models`. 앱은 사용자가 정하지 않으면 `TRACTUS_MODELS_DIR`을 넘기지 않는다. 모델 화면의 `모델 폴더` 줄: `위치 바꾸기…`는 폴더를 고른 뒤(설치한 모델이 있으면 확인) `models_move`로 옮기고 **성공한 뒤에** `models_dir`을 저장한다. `사용하지 않는 폴더 N개 (xx MB) 정리`는 `models list`의 `unregistered`가 있을 때만 보이고 확인 뒤 `models_prune`을 부른다.
- **데이터 폴더 점검.** 시작 점검 `저장 위치` > `데이터 폴더`: 경로 또는 그 위 폴더가 `Library/Mobile Documents`(iCloud Drive), `Dropbox*`, `OneDrive*`, `GoogleDrive*`·`Google Drive`이거나 `.obsidian` 폴더가 그 폴더나 위 폴더에 있으면 확인 필요와 `폴더 바꾸기…`(폴더를 골라 `home` 저장). **노트는 옮기지 않는다**: 새 폴더로 직접 옮긴 뒤 다시 시작하라고 알린다. 판정은 이름·`.obsidian`뿐이다(`paths::sync_risk`, iCloud `데스크탑 및 문서` 동기화는 못 잡는다).

### 3.5 앱 업데이트 (v3.34)

미리 만든 앱(번들)이 GitHub 릴리스에서 새 버전을 찾아 사용자가 누를 때만 받아 설치한다. 코어(Python)는 바뀌지 않는다. 플러그인은 `tauri-plugin-updater` 2.14(`@tauri-apps/plugin-updater`)와 다시 열기용 `tauri-plugin-process` 2.4(`@tauri-apps/plugin-process`)다. 문구는 WORDS.md §4.21이다.

- **흐름.** 확인은 두 곳에서만 한다: 앱이 뜨고 약 10초 뒤 한 번, 그리고 `설정 > 업데이트`의 `업데이트 확인` 단추. 저절로 받거나 설치하는 일은 없다. 시작 때 새 버전이 있으면 기존 알림(토스트) 패턴으로 `새 버전이 있습니다: X` + `설정 열기`(`go({kind: 'settings'})`)만 보이고, 같은 실행에서 두 번 알리지 않는다. 설정의 절은 지금 버전(`getVersion`, `@tauri-apps/api/app`) → `업데이트 확인` → 상태 문구(`확인 중…` / `최신입니다` / `새 버전 X` + 릴리스 노트 일부 + `업데이트 설치`) → `받는 중 N%`(`downloadAndInstall`의 진행 이벤트) → `설치가 끝났습니다` + `다시 열기`(`relaunch`)다. `relaunch`는 `ExitRequested(RESTART_EXIT_CODE)`라 tauri가 `prevent_exit`를 무시해 `begin_quit`의 메모 저장 대기와 `onCloseRequested`의 '변환 중' 확인을 거치지 않고 바로 끝난다. 그래서 App이 `relaunchBlocked`(녹음·변환·가져오기 중, `idleBlockers`와 같은 조건)를 SettingsView에 넘겨 그동안 `다시 열기`를 잠그고 상태 줄에 `녹음·변환이 끝난 뒤 누르세요.`를 붙인다. 오류는 §3의 규칙대로 첫 줄 문장 + `자세히`다.
- **번들에서만.** Rust 명령 `update_available(): bool` 하나가 판별한다: `paths.rs`의 번들 판별(`current_exe()` 옆 `../Resources/runtime/bin/tractus`가 있을 때)을 그대로 쓴다. `false`면 확인을 아예 하지 않고(시작 때도, 단추도 없다) 설정의 절에는 `저장소에서 만든 앱은 scripts/update.sh로 업데이트합니다` 한 줄만 보인다(`install.sh`로 만든 앱, `pnpm tauri dev`). 플러그인 등록은 항상 해도 되지만 `check`는 번들에서만 부른다.
- **권한.** `capabilities/default.json`에 `updater:default`, `process:allow-restart`. CSP는 바꾸지 않는다(내려받기는 Rust 쪽 플러그인이 한다).
- **엔드포인트와 서명.** `plugins.updater.endpoints`는 정적 JSON `https://github.com/sjoon21/Tractus/releases/latest/download/latest.json` 하나다. GitHub의 `latest`는 공개 저장소의 정식 릴리스(pre-release 아님)만 가리킨다. 플랫폼 키는 `darwin-aarch64`, `url`은 같은 릴리스의 `Tractus.app.tar.gz`(앱 폴더가 아카이브 루트), `signature`는 `.sig` 내용이다. 공개 키는 `plugins.updater.pubkey`(저장소에 넣는다), 개인 키는 `~/.tauri/tractus.key`(비밀번호 없음, 저장소 밖, 백업 필수)다. 이 파일들은 `scripts/release.sh`만 만든다(`bundle.createUpdaterArtifacts`는 쓰지 않는다: `tauri build`가 만드는 tar.gz는 번들 스크립트의 마지막 ad-hoc 재서명 전이라 쓸모없다. docs/setup.md §10). 서명이 맞지 않으면 플러그인이 설치하지 않는다. `plugins.updater.requireSignedVersion: true`라 서명의 trusted comment에 적힌 버전(`tauri signer sign --app-version`, `release.sh`가 늘 붙인다)이 `latest.json`의 `version`과 다르거나 없으면 설치하지 않는다: 누가 `latest.json`을 바꿔치기해 옛 릴리스의 `url`·`signature`에 높은 버전을 붙여도 그 옛 앱으로 내려가지 않는다. 모든 릴리스를 `release.sh`로 서명한다는 전제이고, `tests/update_signature.rs`가 산출물의 이 버전을 검사한다.
- **실패 시 조용함.** 시작 때의 확인이 실패하면(오프라인, 404, 서명 불일치, 릴리스 없음) 아무것도 보이지 않고 로그에도 키·주소 말고는 남길 것이 없다. 단추로 확인했을 때만 오류 문장이 보인다.
- **알려진 한계.** 업데이트마다 앱 전체(약 240MB)를 받는다(차이만 받지 않는다). ad-hoc 재서명이라 업데이트 뒤 마이크·시스템 오디오 권한을 다시 물을 수 있다(확인하지 못함). v0.1.0에는 업데이터가 없어 한 번은 수동으로 새 `.dmg`를 설치해야 한다. Apple Developer ID 서명·공증은 아직이다. 깨끗한 Mac·macOS 14.4~15에서의 동작은 확인하지 못했다.

### v1 화면

| 화면 | 기능 |
| --- | --- |
| 사이드바 | 노트 목록(날짜별), 검색 입력, 녹음 시작 버튼 |
| 녹음 | 경과 시간, 트랙별 레벨미터, 북마크(단축키), 메모 입력(Enter → 경과 시각과 함께 저장), 정지 → 전사 진행률 |
| 노트 상세 | 머리의 '삭제'(휴지통으로 이동, §2.9). 오디오 플레이어. 전사 세그먼트를 클릭하면 그 위치로 이동하고, 재생 중인 세그먼트를 강조·자동 스크롤. 메모·북마크를 시각 순으로 함께 표시. 요약 패널(결정 사항·할 일, 항목의 시각을 클릭하면 이동). 요약이 없으면 "요약 만들기" |
| 검색 결과 | 세그먼트 단위 결과. 클릭하면 노트 상세의 해당 시각으로 이동 |

### 제외 (v1)

실시간 전사(Phase 7.2에서 옵트인 미리보기로 추가, §2.8), 전사 텍스트 직접 편집(찾아 바꾸기는 다음 단계), 회의 자동 감지, 자동 설치 업데이트(v3.34에서 알림 뒤 사용자가 누를 때만 설치하는 방식으로 추가, §3.5), 공증.

### 3.6 캘린더 (v3.38)

- 설정 `calendar_enabled`(기본 꺼짐: 연결하기 전에는 권한을 묻지 않는다)·`calendar_hidden`(끈 캘린더 ID, 처음에는 모두 읽는다)은 `calendar_set`·`calendar_connect`가 바로 저장하고 `save_settings`는 지금 값을 지킨다.
- 명령(`calendar.rs`): `calendar_status`(`list` + 설정), `calendar_connect`(`request`, 허락되면 켠다), `calendar_set(enabled, hidden)`, `calendar_next`(꺼져 있으면 빈 목록, `next --ahead 15 --exclude …`), `calendar_privacy`(시스템 설정의 캘린더 화면).
- 홈은 1분마다·창이 다시 보일 때 `calendar_next`를 읽어 첫 일정을 카드로 보인다(실패하면 카드가 없다). `이 일정으로 녹음`은 `rec_start(flags, target, event)`이고 Rust가 다시 검사해 녹음 폴더에 `event.json`을 쓴다(시작에 실패하면 지운다).
- 참석자 이름 고르기: 이름 바꾸기 폼에 `일정 참석자` 버튼(다른 참석자에게 이미 붙인 이름은 뺀다). 누르면 입력한 것과 같은 `rename`이다.

### 3.7 첫 사용자 온보딩 (v3.39)

세 겹이다. 문구는 WORDS.md §4.25, 상태는 이 Mac의 브라우저 저장소(`tractus.onboarding`·`tractus.tips`, 막혀 있으면 이번 실행만 기억)다.

1. **홈 `Tractus 시작하기` 목록** (`onboarding.ts`·`OnboardingCard.tsx`): 변환 모델 받기(caps `convert`) → 예시 노트 둘러보기(예시 노트를 열면 표시) → 첫 녹음(예시가 아닌 녹음 노트가 있으면) → 완성된 노트 보기(완성된 노트 화면을 보면 표시). 다 하거나 `닫기`를 누르면 사라진다.
2. **예시 노트**: `note_sample` 명령(`tractus note sample`) → 먼저 열고 목록은 뒤에 다시 읽는다(v3.42). 노트 목록에 `예시` 표시(`MeetingInfo.sample`, 예시일 때만 싣는다).
3. **기능 안내** (`tips.ts`·`CoachMark.tsx`): 화면의 `data-tip="<ID>"`(또는 선택자) 요소 옆에 한 번씩 뜬다. **한 번에 하나**이고 보이는 자리만 차례를 잡는다(숨은 탭 안의 단추가 다른 안내를 막지 않게). 초점을 빼앗지 않고 Esc로 닫힌다. 홈의 안내(AI 어시스턴트·일정 카드)는 시작하기 목록이 사라진 뒤에 뜬다.

설정 `도움말`: `다시 보기`(목록·안내를 처음부터), `기능 안내` 스위치.

### 3.8 화면 언어 (v3.44)

- **한국어 문구가 원본이자 키다.** 화면 코드는 `t("노트 {n}개", { n })`(`i18n.ts`)로 쓰고, 영어는 `en/*.ts` 사전(화면 영역마다 파일 하나, `common.ts`는 함께 쓰는 짧은 말)에 둔다. 값이 `["{n} note", "{n} notes"]`면 `n`이 1일 때 앞의 것이다. 문체·용어는 WORDS.md §7.
- **언어는 Rust가 정한다**(`i18n.rs`, v3.45): 고른 값은 `settings.json` `ui_lang`(`system` 기본 | `ko` | `en`, `patch_settings`로만 쓴다) → `system`이면 macOS 첫 선호 언어(`defaults read -g AppleLanguages`. WKWebView의 `navigator.language`는 번들 지역화를 따라가 macOS 언어와 다를 수 있다) → 한국어(`ko…`)면 한국어, 그 밖은 영어, 못 읽으면 한국어. 앱 시작 때 정하고, 화면은 `ui_lang` 명령으로 `{pref, lang}`을 받아 영어일 때만 사전을 불러온 뒤 화면 모듈을 불러온다(모듈 상수의 `t()`도 그 언어로 만들어지게). 설정 > 화면 > 언어(`set_ui_lang`)를 바꾸면 메뉴 막대를 바로 다시 그리고 화면을 다시 연다.
- **Rust 문장**(오류·메뉴 막대)은 `t()`/`tv()`(`i18n.rs`) + `en.json`. **코어**는 앱이 모든 실행에 싣는 `TRACTUS_LANG`(`child_env`)이 `en`일 때만 영어다(`tractus/i18n.py` + `i18n_en.json`. 셸의 `LANG`은 보지 않는다). 코어가 옮기는 것: 앱·터미널로 가는 오류·경고·`console.print`, 모델·기능 이름과 안내(`models list`·`doctor`), 내보낸 문서(txt·md·srt·vtt·csv·docx·Obsidian, 이름 없는 참석자는 `Speaker N`). 옮기지 않는 것: MCP 출력, `store.stamp()`(앱이 검색 결과에서 읽는다), 노트 폴더 파일(`transcript.md`·`vtt`·`summary.md`), 노트에 저장되는 기본 제목, AI 프롬프트 — 줄 끝 `i18n-ok`. 권한 창 문구는 `locales/{ko,en}.lproj/InfoPlist.strings`(macOS 언어를 따른다).
- **3단계(v3.46): AI 결과·노트 데이터.** 영어 화면이면 요약·노트 완성 프롬프트의 결과 언어 규칙 한 줄을 "영어로 쓴다"로 바꾼다(`i18n.ai_prompt`, 프롬프트 본문은 한국어 그대로, 한국어 화면의 프롬프트는 바뀌지 않는다). AI 질문은 원래대로 질문의 언어로 답하고, 근거가 없을 때의 답(`ask.NO_EVIDENCE`)은 화면 언어다. 요약 유형 이름·설명은 유형 파일의 `name_en`·`description_en`. 노트에 저장되는 것은 **만들 때의 화면 언어**다: 기본 제목(`녹음 HH:MM`/`Recording HH:MM`, `메모 HH:MM`/`Memo HH:MM`), 요약·완성된 노트의 머리말, `template_name`, `transcript.md`·`vtt`, 새 `glossary.md` 머리말, 예시 노트(`sample_note_en.json`, 같은 가상 회의를 옮긴 것). 이미 있는 노트는 바뀌지 않는다. `store.stamp()`·MCP 출력·검색 색인·프롬프트 안의 참석자 표시(`참석자 N`)는 그대로다.
- **검사**: Rust `i18n.rs` 테스트·`tests/test_i18n.py`(AST)가 같은 규칙(빠진 번역·쓰이지 않는 번역·자리표시자·`t()` 밖 한국어)을 본다. 화면은 `i18n.test.ts`가 빠진 번역·쓰이지 않는 번역·두 사전에 겹친 키·자리표시자 불일치·영어 값의 한국어·`t()` 밖에 남은 한국어 문자열/JSX 글자(주석 제외, 언어와 상관없는 데이터는 줄 끝 `i18n-ok`)를 잡는다. 템플릿 문자열 안의 `t()`는 검사가 못 보므로 `t()`를 템플릿 문자열에 넣지 않는다. 미리보기는 `/preview.html?lang=en-US`.

## 4. B안 판정 기준 (D안으로 갈지 정할 때)

| 기준 | 통과 조건 | 결과 (2026-10-03) |
| --- | --- | --- |
| 녹음 | 실제 회의 1시간을 끊김 없이 녹음, 권한 문제를 사용자에게 알림 | 🔶 앱 녹음 → 전사 경로 동작 확인(짧은 테스트). 실제 1시간 대면 회의는 미검증 |
| 리뷰 UI | 클릭 → 재생 위치 이동, 현재 세그먼트 강조, 요약 항목 → 원문 이동이 매끄러움 | ✅ 실제 30분 회의로 사용자 확인 (클릭 이동, 강조·자동 스크롤, 스크롤 성능) |
| 검색 | 회의에서 기억나는 단어로 해당 대목을 찾음 | ✅ 사용자 확인 |
| 요약 | 요약 만들기 → 결정 사항·할 일 표시 | ✅ 사용자 확인 (Upstage) |
| 성능 | 앱 시작 3초 이내, 1시간 회의 상세 화면이 끊김 없이 스크롤 | ✅ 30분 회의 기준 |
| 유지보수 | 1인이 Rust·TS·Swift·Python 네 언어를 감당할 수 있는지 | 관찰 중 |
| Obsidian | 같은 회의 폴더를 볼트에서 열었을 때 노트·오디오·자막이 그대로 쓰이는지 | 미검증 (D안과 공통) |

**중간 판단 (2026-10-03):** 리뷰 UI·검색·요약은 B안으로 충분하다. 남은 판정 항목은 실제 1시간 녹음이다. 다음 기능은 화자 분리(대면 회의의 기본 기능)다.