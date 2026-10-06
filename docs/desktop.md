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
│                         ├─ spawn: tractus speakers <id> rename | set | merge   (화자 목록은 transcript.json을 직접 읽는다)
│                         ├─ spawn: tractus ask [--meeting <id>] --progress-json   (stdin JSON, 대화 기록은 chat.json을 직접 읽는다)
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
| 화자 분리 (2026-10-04) | `transcribe`가 VAD 다음에 화자 분리를 한다(기본 켜짐, `--no-diarize`로 끔, `--max-speakers N`으로 상한 1–8). `transcript.json` schema_version 2: `segments[].speaker`(`"S1"`… 또는 null), 최상위 `speakers: {"S1": {"name": null}}`, `diarization`(끄거나 모델이 없으면 null). 표시 이름 = `name`, 없으면 라벨, `speaker`가 null이면 md·vtt에 표시 안 함(앱은 화자 있는 회의에서 "화자 미상" 칩으로 보여 주고 화자를 고를 수 있게 한다). schema_version 1 회의는 `speakers`가 없다 (ARCHITECTURE.md §6) |
| `tractus speakers` | 화자 편집. transcript.json을 고치고 md·vtt를 다시 쓴 뒤 검색 색인을 갱신한다. 오디오는 건드리지 않는다. 아래 §2.1 |
| 표시 텍스트 (Phase 5) | 어디서나 `corrected_text`가 null이 아니면 그것, 아니면 `text`(코어 `store.seg_text`). md·vtt·요약 프롬프트·MCP·색인·CLI 검색·내보내기가 모두 따른다. 앱도 같은 규칙으로 표시한다 |
| `tractus segments` | 텍스트 편집. 아래 §2.2 |
| `tractus glossary add` | 용어집 추가. 아래 §2.3 |
| `tractus export` | 내보내기. 아래 §2.4 |
| `tractus ask` (Phase 6) | 회의 질의. 아래 §2.5 |
| 가져오기 (Phase 5) | 앱 job kind `import` = `tractus transcribe <파일> --progress-json` (다른 작업과 같은 환경변수). ffmpeg가 읽는 모든 형식을 받는다(m4a, mp3, wav, webm, mp4, mov …). 동영상은 소리만 쓴다(`-vn`) |

진행 이벤트:

```jsonc
{"event":"stage","stage":"decode"}            // decode | vad | diarize | encode | load_model | transcribe | index | summarize
{"event":"progress","done":37,"total":145}
{"event":"warning","code":"diarizer_missing","message":"…"}   // 화자 분리 모델이 없음 → 화자 없이 계속 (diarizer_failed: 실패 → 화자 없이 계속)
{"event":"warning","code":"duplicate","message":"…"}           // 이미 전사된 파일 → 바로 기존 회의의 done이 이어진다 (종료 코드 0)
{"event":"done","meeting_id":"01K…","meeting_dir":"/…/meetings/2026-10-02_…"}
{"event":"error","message":"…"}               // 종료 코드 1
```

- `diarize` 단계는 모델이 있을 때만 나온다(84분 회의 약 14초). 이어하기에서는 다시 하지 않는다.
- `warning`은 종료가 아니다. 앱은 `message`를 알림으로 보여 주고 진행을 계속 표시한다.
- `transcribe`는 첫 이벤트로 `{"event":"stage","stage":"decode"}`를 낸다. 큰 파일의 SHA-256 계산(중복 확인)보다 먼저 나온다.
- 이미 전사된 파일이면 `stage(decode)` → `warning(duplicate)` → `done`(기존 회의의 `meeting_id`·`meeting_dir`) 순서다. 앱은 화면을 바꾸지 않고 "이미 전사한 파일입니다" 알림에 **열기**를 붙인다(고치던 문장을 잃지 않게).
- 오디오 트랙이 없는 동영상은 `{"event":"error","message":"오디오 트랙이 없습니다 (소리 없는 동영상인지 확인하세요): …"}`, 종료 코드 1.

### 2.1 `tractus speakers <회의>` (화자 편집)

`<회의>`는 meeting_id(일부) 또는 회의 폴더 경로다. 편집 명령은 성공하면 종료 코드 0, 잘못된 인자(없는 라벨·세그먼트, 같은 화자 병합)는 stderr에 이유를 쓰고 종료 코드 1이다. 편집 뒤 앱은 transcript.json을 다시 읽는다.

| 명령 | 동작 |
| --- | --- |
| `tractus speakers <회의> list --json` | 아래 JSON 한 줄을 stdout에 출력 |
| `tractus speakers <회의> rename S1 "김민수"` | 이름 지정. `""`이면 이름을 지운다. `` []<>*_`\ `` 문자는 빠지고, `S2`처럼 라벨 모양인 이름은 exit 1 |
| `tractus speakers <회의> set s0012 S2` | 세그먼트 하나의 화자 변경. `S2` 대신 `new`면 다음 라벨(예: `S4`)을 만든다 |
| `tractus speakers <회의> merge S3 S1` | S3의 세그먼트를 모두 S1으로 옮기고 S3을 없앤다. S1에 이름이 없으면 S3의 이름을 이어받는다 |

세그먼트가 하나도 남지 않은 라벨은 `speakers`에서 지워진다.

```jsonc
// tractus speakers 01K6X3 list --json
{"meeting_id":"01K6X3…","speakers":[
  {"label":"S1","name":"김민수","display":"김민수","segments":31,"talk_sec":812.4},
  {"label":"S2","name":null,"display":"S2","segments":18,"talk_sec":402.0}],
 "diarization":{"model":"mlx-community/Nemotron-3-Diarization","revision":"59ed2dbf…","params":{…}}}   // 화자 분리 안 했으면 speakers [], diarization null
```

### 2.2 `tractus segments <회의> edit` (텍스트 편집)

stdin으로 JSON 객체 하나를 받는다. 앱은 argv로 실행하고(셸 없이) `TYPER_USE_RICH=0`을 준다.

```jsonc
// stdin
{"edits":[{"id":"s0012","text":"새 문장"},{"id":"s0013","text":"원문 그대로"}]}
// stdout (한 줄)
{"changed":2}
```

- 각 편집의 `text`는 앞뒤 공백을 지우고 연속 공백·줄바꿈을 한 칸으로 줄인다. 그 값이 원문 `text`와 같으면 `corrected_text = null`(교정 해제), 다르면 `corrected_text = 그 값`이다. 원문 `text`와 `words`는 그대로 둔다.
- `changed`는 `corrected_text`가 실제로 바뀐 세그먼트 수다. 0이면 파일을 쓰지 않는다.
- 없는 id, 빈 텍스트, 형식 오류(JSON 아님, `edits`가 목록이 아님, `id`·`text`가 문자열이 아님)가 하나라도 있으면 아무것도 쓰지 않고 stderr에 이유를 쓴 뒤 종료 코드 1이다.
- 저장은 화자 편집과 같다. transcript.md·vtt를 먼저, transcript.json을 마지막에 원자적으로 쓴다. 색인은 `sync(embed=False)`로 갱신한다. 본문이 바뀐 청크는 다음 임베딩 동기화(`tractus index`, 전사·요약 뒤)까지 키워드로만 찾힌다.
- 편집 뒤 앱은 transcript.json을 다시 읽는다. 요약(summary.*)은 다시 만들지 않는다.

### 2.3 `tractus glossary add <용어> [<용어>…]`

`$TRACTUS_HOME/glossary.md`에 `- 용어` 줄로 덧붙인다(없으면 짧은 머리말과 함께 만든다). 앞뒤 공백을 지우고, 빈 값과 이미 있는 용어(대소문자 구분)는 건너뛴다. stdout: `{"added":N}`. 용어가 `-`로 시작할 수 있으므로 앱은 `tractus glossary add -- <용어>…`처럼 `--`를 앞에 둔다. 다음 전사부터 hotwords로 들어간다.

### 2.4 `tractus export <회의> --format <형식> --out <경로> [--force]`

파일을 쓰고 stdout에 `{"path":"<절대 경로>"}`를 출력한다. `--out`이 이미 있으면 `--force`일 때만 덮어쓰고, 아니면 종료 코드 1이다. 모든 형식이 화자는 표시 이름, 본문은 `corrected_text ?? text`를 쓴다.

| 형식 | 내용 |
| --- | --- |
| `txt` | 제목, `날짜 시각 · 길이` 줄, 빈 줄, 그다음 `[HH:MM:SS] 화자: 문장` (화자를 모르면 `[HH:MM:SS] 문장`) |
| `md` | transcript.md와 같은 내용(메모·북마크 포함) + summary.md가 있으면 `---` 뒤에 붙인다 |
| `srt` | 번호 큐, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, 본문 `화자: 문장` |
| `vtt` | transcript.vtt와 같다 |
| `csv` | UTF-8 BOM(utf-8-sig), 열 `시작,끝,화자,문장`, 시각은 `HH:MM:SS` |
| `docx` | 제목, 일시·길이, 화자 목록, summary.json이 있으면 요약·결정 사항·할 일, 그다음 전사(시각 + **화자** + 문장). 한글 글꼴 `w:eastAsia = Apple SD Gothic Neo` |
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
{"event":"done","answer":"3분기 총 예산은 … [s0012]","citations":[{"meeting_id":"01K…","segment_id":"s0012","start":176.6}],"provider":"upstage","model":"solar-pro4"}
{"event":"error","message":"…"}                          // 종료 코드 1
{"event":"warning","code":"chat_save_failed","message":"…"}   // --save 저장 실패 (done 바로 앞). 답(done)은 그대로 나온다
```

- **앱은 `done`의 `answer`로 스트리밍 텍스트를 바꿔 표시한다.** `done`에서 인용을 정리한다: 근거(`sources`)에 있는 ID만 `[s0012]` / `[<meeting_id>#s0012]` 하나씩으로 다시 쓰고(`[s0012, s0013]` → `[s0012][s0013]`), 근거에 없는 ID는 답에서 지운다. `citations`는 답에 남은 인용을 처음 나온 순서로 중복 없이 모은 것이다.
- 근거에 답이 없으면 답은 `회의 기록에서 근거를 찾지 못했습니다.`(질문이 한국어가 아니면 같은 뜻의 질문 언어)이고 `citations`는 비어 있다. 전체 범위에서 검색 결과가 하나도 없으면 LLM을 부르지 않고 `sources: []` 다음에 바로 이 답으로 `done`을 낸다(`stage answer`·`delta` 없음).
- 공급자 해석은 `summarize`와 같다(`--provider` > `TRACTUS_LLM_PROVIDER`, `TRACTUS_LOCAL_ONLY`, 키 없음 오류 메시지 동일). 이런 오류는 첫 이벤트로 `error`가 나온다. 앱은 보내기 전에 설정된 `TRACTUS_LLM_PROVIDER`로 "질문과 관련 전사 일부가 Upstage(solar-pro4)로 전송됩니다"를 표시한다. 실제로 답한 곳(`done`의 `provider`·`model`)은 각 답 아래에 적는다. 근거가 없어 LLM을 부르지 않은 `done`은 `provider`·`model`이 `null`이다(아무것도 보내지 않았으므로 전송 안내에 쓰지 않는다).
- **원격 공급자로는 질문, history, `sources`의 텍스트만 보낸다.** 오디오, 요약, 다른 회의 전사는 보내지 않는다.
- 취소: 앱은 자식 프로세스를 종료한다. `chat.json`은 `done`을 내보내기 직전에 원자적으로 쓰므로, 답 도중에 끊으면 기록이 바뀌지 않고 `done`을 받았다면 이미 저장돼 있다.

`--save` (회의 범위): `done`을 내보내기 직전에 `<회의 폴더>/chat.json`에 한 쌍을 덧붙이고 최근 50개만 남겨 원자적으로 쓴다. 앱은 회의를 열 때 이 파일을 Rust에서 직접 읽어 대화 기록을 보여 준다. 파일이 없으면 새로 만든다. 깨졌거나 형식이 다르면(`schema_version` ≠ 1) 기록을 잃지 않게 덮어쓰지 않고 `warning chat_save_failed`를 낸다(답은 그대로 나온다). 색인·내보내기에는 들어가지 않는다.

```jsonc
{"schema_version":1,"meeting_id":"01K…","turns":[
  {"question":"…","answer":"… [s0012]","citations":[{"meeting_id":"01K…","segment_id":"s0012","start":176.6}],
   "provider":"upstage","model":"solar-pro4","created_at":"2026-10-06T15:10:30+09:00"}]}
```

`--progress-json` 없이 실행하면 정리된 답을 stdout에 출력하고, 인용이 있으면 빈 줄 뒤에 `근거:`와 `[s0012 00:02:56]` 줄을 붙인다.

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

실시간 전사, 전사 텍스트 직접 편집(찾아 바꾸기는 다음 단계), 회의 자동 감지, 자동 업데이트, 공증.

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