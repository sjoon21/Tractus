# tractus-rec — 녹음 헬퍼

마이크와 시스템 오디오를 **트랙을 섞지 않고** 각각 48 kHz mono 16-bit WAV로 녹음하는 Swift 실행 파일이다. Tauri 앱(B안)과 메뉴바 녹음기(D안)가 같이 쓴다. CLI·이벤트·파일 계약은 [`docs/desktop.md` §1](../docs/desktop.md)이 원본이다.

| 트랙 | 방식 |
| --- | --- |
| `mic.wav` | `AVAudioEngine` 입력 노드 tap |
| `system.wav` | Core Audio process tap(`CATapDescription` + `AudioHardwareCreateProcessTap`) → private aggregate device → IOProc |

요구 사항: macOS 14.4 이상, Apple Silicon, Xcode 15.3 이상(Swift 5.10 이상, 개발 기기의 Swift 6.4·Xcode 27에서만 빌드 확인). 소스는 Swift 5 언어 모드로 빌드한다.

화자 분리 헬퍼 `tractus-diar`는 하위 폴더 `diar/`의 **별도 패키지**다(FluidAudio가 Swift 6.2 이상을 요구해서 나눴다. 이 패키지만 Xcode 26이 필요하다). 아래 [tractus-diar](#tractus-diar--9명-이상-화자-분리-헬퍼) 절을 본다.

## 빌드

```bash
cd recorder
swift build -c release     # → recorder/.build/release/tractus-rec
swift test                 # 단위 테스트 + --fake E2E (권한 불필요)
```

`Info.plist`(`NSMicrophoneUsageDescription`, `NSAudioCaptureUsageDescription`)는 링커 옵션 `-sectcreate __TEXT __info_plist`로 실행 파일 안에 들어간다. 확인 방법은 다음과 같다.

```bash
launchctl plist __TEXT,__info_plist .build/release/tractus-rec
```

## 사용법

```bash
tractus-rec record --out <dir> [--no-mic] [--no-system] [--echo-cancel] [--fake]
tractus-rec check
```

녹음 모드는 회의 형태에 맞춰 고른다. 헤드폰을 쓴다고 가정하지 않으므로 스피커로 들어도 된다.

| 모드 | 명령 | 설명 |
| --- | --- | --- |
| 대면 회의(기본) | `record --out <dir> --no-system` | 한 방에 모인 사람들의 목소리를 마이크로만 받는다. 스피커로 나가는 소리가 없으므로 에코 문제가 없다 |
| 화상·하이브리드 회의 | `record --out <dir> --echo-cancel` | 마이크 + 시스템 오디오. 스피커로 나간 상대방 목소리가 마이크 트랙에 다시 섞이지 않게 macOS 에코 제거를 켠다 |

- stdout에는 JSON Lines 이벤트만 나온다. 로그는 stderr로 간다.
- stdin 명령은 `bookmark`, `memo <텍스트>`, `pause`, `resume`, `stop`이다. 모르는 명령은 stderr에 로그만 남긴다.
- `stop`, SIGINT, SIGTERM, **stdin EOF**는 모두 같은 마무리 절차를 밟는다. 파일을 닫고 `recording.json`에 `duration`을 채운 뒤 `stopped` 이벤트를 내고 종료 코드 0으로 끝난다. stdin EOF로 멈추는 이유는 부모 앱이 죽었을 때 녹음이 고아로 남지 않게 하려는 것이다. 그래서 하위 프로세스로 띄울 때는 stdin을 파이프로 열어 두어야 한다.
- WAV 헤더는 0.25초 분량마다 갱신한다. `kill -9`로 죽어도 마지막 0.25초 이내까지는 재생된다.
- `<dir>`에 `mic.wav`·`system.wav`·`recording.json`이 이미 있으면 덮어쓰지 않고 `error` 이벤트와 함께 종료 코드 1로 끝난다.
- 일시정지 구간은 0으로 채우지 않는다(위 절). 트랙마다 첫 버퍼가 늦게 온 만큼 앞을 0으로 채워 두 트랙의 시작 시각을 맞춘다. 녹음 중에 끊긴 구간(장치 재연결, 0.5초 넘는 공백)도 0으로 채운다. 장치 간 클록 드리프트는 보정하지 않는다.
- 각 WAV는 4 GiB(약 12.4시간)가 상한이다. 상한에 닿으면 파일을 닫고 `error` 이벤트와 함께 종료 코드 1로 끝난다.

### 일시정지 (`pause` / `resume`)

```text
→ pause     ← {"event":"paused","elapsed":95.0}
→ resume    ← {"event":"resumed","elapsed":95.0}
```

- **오디오 시계는 일시정지 시간을 뺀다.** `level.t`, `mark.t`, `elapsed`, `duration`, `recording.json`의 `marks[].t`·`pauses[].at`이 모두 이 시계다. WAV 길이 = `duration`.
- 일시정지 중에는 두 트랙 표본을 모두 버린다. WAV에 일시정지 구간(무음)이 들어가지 않고 두 트랙은 계속 정렬된다. 계속하면 같은 오디오 시각에서 이어 쓴다.
- **캡처 엔진은 멈추지 않는다.** 마이크를 놓지 않으므로 macOS 마이크 사용 표시(주황 점)는 일시정지 중에도 켜져 있다. (엔진을 껐다 켜면 장치 전환·권한·에코 제거 재설정을 다시 거쳐야 해서 쓰지 않았다.)
- 일시정지 중에는 `level` 이벤트를 내지 않는다. `bookmark`·`memo`는 받아서 멈춘 오디오 시각에 찍는다.
- 이미 일시정지 중인 `pause`, 일시정지 중이 아닌 `resume`은 조용히 무시한다(이벤트도 경고도 없다).
- `stop`·SIGTERM·stdin EOF는 일시정지 중에도 정상 마무리한다. `duration`은 멈춘 시각이다.
- `recording.json`의 `pauses`: `[{"at": <오디오 초>, "wall_start": iso, "wall_end": iso}]`. 끝난 일시정지만 들어가고(종료 때 열려 있던 것은 닫는다) 없으면 `[]`. 추가 키라 `schema_version`은 1 그대로다.
- `--fake`도 똑같이 동작한다(합성 신호가 오디오 시계를 따라 이어진다).

### `--echo-cancel`

마이크 입력에 macOS 내장 음성 처리(`AVAudioInputNode.setVoiceProcessingEnabled(true)`)를 켠다.

- 다른 앱 소리를 줄이는 덕킹은 최소로 둔다(`enableAdvancedDucking: false`, `duckingLevel: .min`). 화상회의 상대 목소리가 작아지지 않게 하려는 것이다.
- 음성 처리는 에코 제거와 함께 **AGC(자동 음량 조절)와 잡음 억제도 같이 켠다.** 통화에는 알맞지만 회의실의 멀리 앉은 사람 목소리나 작은 소리가 깎일 수 있다. 그래서 대면 회의 기본값에서는 끈다.
- 음성 처리를 켜면 입력 포맷이 바뀐다(여러 채널일 수 있다). 처리된 첫 채널만 48 kHz mono 16-bit로 바꿔 쓴다.
- 장치가 바뀌어 마이크를 다시 열 때도 음성 처리를 유지한다.
- 켜지 못하면(켜기, 입력 포맷, 엔진 시작 중 어디서든) `echo_cancel_failed` 경고를 내고 음성 처리를 끈 채 마이크를 다시 열어 녹음을 이어 간다. 장치 전환으로 다시 열 때 실패해도 같다. 한 번 꺼지면 그 녹음이 끝날 때까지 다시 켜지 않는다.
- 실제로 켜졌는지는 `started` 이벤트와 `recording.json`의 `"echo_cancel": true|false`로 알 수 있다. 녹음 중에 꺼지면 `started`는 그대로 두고 `recording.json`만 `false`로 고친다. 마이크 트랙이 없으면(`--no-mic`, 권한 거부, 시작 실패) `false`다. `recording.json`의 `schema_version`은 1 그대로이고, 읽는 쪽은 모르는 키를 무시한다.
- `--fake`는 실제 장치를 쓰지 않으므로 `--echo-cancel`을 무시하고 `echo_cancel: false`로 녹음한다.

### `--fake`

실제 장치 대신 합성 신호를 쓴다. 권한 창이 뜨지 않으므로 앱 개발과 CI에서 쓴다.

| 트랙 | 신호 | 레벨 |
| --- | --- | --- |
| mic | 440 Hz 사인파, 진폭 0.3 | 약 -13.5 dBFS |
| system | 660 Hz 사인파, 진폭 0.3. 2초 주기마다 1.0~1.5초 구간은 정확히 0 | 약 -13.5 dBFS, 무음 구간은 -100 |

```bash
( sleep 1; echo bookmark; echo "memo 예산 다시 확인"; sleep 1; echo stop ) \
  | .build/release/tractus-rec record --out /tmp/rec-test --fake
```

### 계약에 없는 동작

- 레벨이 정확히 0이거나 창 안에 표본이 없으면 `-100`(dBFS 하한)을 낸다.
- `started` 이벤트와 `recording.json`에 `echo_cancel`(불리언)이 더 들어간다. 위 `--echo-cancel` 절을 본다.
- 트랙을 시작하지 못하면 `warning` 이벤트를 `mic_failed`·`system_failed` 코드로 내고 그 트랙을 뺀 채 계속 녹음한다. 남은 트랙이 없으면 `error`로 끝난다.
- 녹음 중 장치가 바뀌거나(마이크: `AVAudioEngineConfigurationChange`, 시스템: 기본 출력 장치 변경) 표본이 2초 넘게 안 오면 그 트랙을 다시 연다. 성공하면 `mic_restarted`·`system_restarted`, 실패하면 `mic_failed`·`system_failed` 경고를 한 번 내고 2초마다 재시도한다.
- `system_zero`는 tap을 연 뒤 0이 아닌 표본이 **한 번도** 오지 않은 채 5초가 지났을 때 한 번만 낸다. 신호를 한 번 본 뒤의 무음(상대가 음소거 등)은 권한 문제가 아니므로 알리지 않는다.

## 권한

| 권한 | 언제 묻나 | 거부됐을 때 |
| --- | --- | --- |
| 마이크 | `record` 시작 시 상태가 `undetermined`이면 `AVCaptureDevice.requestAccess`로 묻는다 | `mic_denied` 경고 후 시스템 트랙만 녹음 |
| 화면 및 시스템 오디오 녹음 | 처음 tap을 만들 때 macOS가 묻는다 | tap이 정확히 0만 보내므로 5초 뒤 `system_zero` 경고 |

- 터미널에서 실행하면 권한은 **터미널 앱**(Terminal, iTerm 등)에 붙는다. Tauri 앱이 하위 프로세스로 실행하면 **부모 앱**(Tractus.app)에 붙는다.
- `check`의 `mic` 값은 권한 창을 띄우지 않는다. 반면 `system` 값을 구하려고 tap을 1초 열기 때문에, 처음 실행하면 시스템 오디오 권한 창이 뜰 수 있다.

## 사람이 직접 확인할 것 (자동 테스트 범위 밖)

자동 테스트는 `--fake`와 단위 테스트만 돌린다. 실제 장치와 권한 창은 아래 순서로 직접 확인한다.

1. 권한 초기화(선택): `tccutil reset Microphone`. 시스템 오디오 권한은 시스템 설정에서 해당 앱을 지운다
2. `tractus-rec check`를 실행한다. 권한 창이 뜨면 허용한다. 출력의 `mic`이 `granted`인지 본다.
3. 유튜브 등에서 소리를 재생하고 `tractus-rec check`를 다시 실행한다. `system`이 `ok`여야 한다.
4. 소리를 재생하면서 말하며 30초 녹음한다.

   ```bash
   .build/release/tractus-rec record --out ~/Desktop/rec-test
   # 녹음 중에 bookmark, memo 테스트 입력 후 stop (또는 Ctrl-C)
   ```

   - `level` 이벤트의 `mic`이 말할 때 올라가고 `system`이 재생 소리에 반응하는지 본다.
   - `afplay ~/Desktop/rec-test/mic.wav`와 `afplay ~/Desktop/rec-test/system.wav`로 두 트랙이 따로 들어갔는지 듣는다.
5. 시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 녹음에서 터미널 권한을 끄고 4를 반복한다. 5초 안에 `system_zero` 경고가 나와야 한다.
6. 마이크 권한을 끄고 4를 반복한다. `mic_denied` 경고가 나오고 `tracks`가 `["system"]`이어야 한다.
7. 녹음 중 `kill -9 <pid>`로 죽인 뒤 `afinfo`로 두 WAV가 열리는지 본다.
8. 녹음 중 출력 장치를 바꾼다(스피커 → 이어폰, AirPods 연결·해제). `system_restarted` 경고가 나오고 바뀐 장치의 소리가 계속 들어오는지 본다. 마이크 입력을 바꿨을 때도 `mic_restarted`가 나오고 녹음이 이어지는지 본다. 재시작 경고가 끝없이 반복되지 않는지도 본다. 녹음 후 두 WAV 길이가 거의 같은지 `afinfo`로 확인한다.
9. 에코 제거를 확인한다. 헤드폰 없이 Mac 스피커로 유튜브 영상을 틀고, 영상 소리 위로 말하면서 30초씩 두 번 녹음한다.

   ```bash
   .build/release/tractus-rec record --out ~/Desktop/rec-aec --echo-cancel
   .build/release/tractus-rec record --out ~/Desktop/rec-noaec
   ```

   - `rec-aec`의 `started` 이벤트에 `"echo_cancel":true`가 있고 `echo_cancel_failed` 경고가 없어야 한다. 시작 직후 `mic_restarted`가 나오지 않는지도 본다.
   - `afplay ~/Desktop/rec-aec/mic.wav`에는 내 목소리만 들리고 영상 소리는 들리지 않거나 크게 줄어야 한다. `rec-noaec/mic.wav`에는 영상 소리가 들어 있어야 비교가 된다.
   - 두 `system.wav`의 영상 소리 크기가 비슷해야 한다(덕킹 최소).
   - `rec-aec/mic.wav`의 내 목소리 레벨이 지나치게 작거나 끊기지 않는지 본다(첫 채널만 쓰므로).
   - 녹음 중 마이크 입력을 바꿔 `mic_restarted` 뒤에도 영상 소리가 계속 지워지는지 본다. `echo_cancel_failed`가 나왔다면 `mic_failed` 없이 `mic.wav`가 이어지는지, `recording.json`이 `"echo_cancel": false`인지 본다.
   - USB 마이크나 집계(aggregate) 장치를 입력으로 골라 `--echo-cancel`로 시작해 본다. 음성 처리가 실패하더라도 `echo_cancel_failed` 경고만 나오고 `tracks`에 `mic`이 남아야 한다.
10. 대면 회의를 `--no-system`으로 녹음한다. 여러 명이 Mac 주위에 앉아 30분 이상 이야기하고, 멀리 앉은 사람 목소리까지 `mic.wav`에 들어가는지 확인한다.
11. 실제 화상회의 1시간을 녹음해 끊김과 두 트랙의 싱크를 확인한다(`docs/desktop.md` §4 판정 기준).

## tractus-diar — 9명 이상 화자 분리 헬퍼

Nemotron 3 Diarization은 화자 8명이 상한이다. `tractus-diar`(`recorder/diar/`, Swift 6.2 이상)는 [FluidAudio](https://github.com/FluidInference/FluidAudio) v0.17.5(커밋 `0b1f462`)의 `OfflineDiarizerManager`(pyannote community-1 파이프라인을 Core ML로 옮긴 것: 분할 → WeSpeaker 임베딩 → PLDA·VBx 군집)를 돌린다. 화자 수 상한이 없다. Python 코어가 `transcribe --diarizer auto|fluid`일 때 하위 프로세스로 부른다.

| 항목 | 값 |
| --- | --- |
| 코드 | FluidAudio Apache-2.0 (`diar/Package.resolved`로 고정). NeMo 텍스트 정규화 바이너리는 `traits: []`로 빼서 링크하지 않는다 |
| 모델 | `FluidInference/speaker-diarization-coreml` revision `df2625ac79a7ac6b65ad868fee6d80f320da4232` (FluidAudio가 고정), 21MB |
| 모델 라이선스 | CC-BY-4.0 (pyannote community-1, WeSpeaker, BUT Speech@FIT PLDA, Fluid Inference 변환). 출처 표기는 저장소 `NOTICE` |
| 로컬 경로 | `models/speaker-diarization` (FluidAudio가 정한 폴더 이름) |

### 빌드

```bash
cd recorder/diar
swift build -c release     # → recorder/diar/.build/release/tractus-diar (처음에는 FluidAudio를 받는다)
swift test                 # 인수 해석·결과 이벤트 단위 테스트 + 실행 파일 오류 경로 (모델이 없으면 실제 모델 테스트만 건너뜀)
```

구조: `Sources/DiarKit`(FluidAudio에 의존하지 않는 순수 로직 + `Support.swift`, `../Sources/RecorderKit`에서 복사한 작은 함수 셋), `Sources/tractus-diar`(실행 파일), `Tests/DiarTests`.

### 모델 받기 (한 번)

```bash
.build/release/tractus-diar download --models ../../models/speaker-diarization
```

- 라이선스 범위(CC-BY-4.0) 안의 파일만 받는다: `Segmentation`·`FBank`·`Embedding`·`PldaRho.mlmodelc`, `plda-parameters.json`, `xvector-transform.json`, `provenance.json`(SHA-256 목록). 같은 저장소의 레거시 파일(`pyannote_segmentation`, `wespeaker*`)은 받지 않는다.
- revision은 `.fluidaudio-revision`에 적힌다. 다시 실행하면 받지 않고 열어 보기만 한다.
- `--models`에는 `speaker-diarization` 폴더 자체나 그 부모를 준다. 어느 쪽이든 `<부모>/speaker-diarization`에 둔다.

### 실행

```bash
.build/release/tractus-diar run --audio <16kHz mono wav> --models ../../models/speaker-diarization [--max-speakers N]
```

- **네트워크를 쓰지 않는다**(`ModelHub.offlineMode = true`). 모델이 없거나 revision이 다르거나 깨졌으면 받지 않고 `error`로 끝난다.
- stdout에는 JSON Lines만 나온다. 로그는 stderr로 간다.

  ```json
  {"event":"progress","done":120,"total":2694}
  {"event":"result","turns":[[0,7.67,"S1"],[7.67,12.33,"S2"]],"speakers":2,"engine":"fluid","model":"FluidInference/speaker-diarization-coreml@df2625ac79a7ac6b65ad868fee6d80f320da4232","elapsed":0.57}
  ```

  - `progress`는 분할 청크 기준으로 약 5%마다 낸다.
  - `turns`는 겹치지 않는 `[시작 초, 끝 초, 화자]`이고 시작 순이다. 라벨은 처음 말한 순서대로 `S1`, `S2`, …다.
  - `elapsed`는 프로세스 시작부터 잰 초(모델 로드 포함)다.
  - 실패하면 `{"event":"error","message":…}` 하나를 내고 종료 코드 1로 끝난다.
- 설정은 FluidAudio 기본값(`OfflineDiarizerConfig.default`, community-1 설정: 군집 임계값 0.6, Fa 0.07, Fb 0.8, 창 10초, step 0.2)이다. `--max-speakers`만 `withSpeakers(max:)`로 넘긴다.
- 실행 파일 옆의 `FluidAudio_FluidAudio.bundle`(TTS 발음 사전)은 화자 분리에 쓰지 않는다. 헬퍼만 복사해도 동작한다.

### 실측 (2026-10-07, M3 16GB, release)

| 입력 | 결과 | 시간 |
| --- | --- | --- |
| 가상 대화 43초 (`say` Yuna·Grandpa 번갈아 6발화) | 2명, 경계 오차 0.4초 이내 | 첫 실행 4.3초(Core ML 컴파일), 이후 0.57초 |
| AI Hub 90분 세션(화자 17명, 로컬 전용) | 11명 | 32.3초 (RTF 0.006), 최대 RSS 0.71GB, peak footprint 0.90GB |

정확도(DER·confusion)는 `bench/diar_eval.py der`가 잰다. AI Hub 17명 세션 confusion 6.9%(Nemotron 28.5%), 4세션 합 4.7%(Nemotron 12.6%). 표는 ARCHITECTURE.md §2.4.1. 실행 시 네트워크 차단(`sandbox-exec … (deny network*)`)에서도 위와 같이 끝났다.

## 참고

시스템 오디오 tap 절차는 [AudioCap](https://github.com/insidegui/AudioCap)(BSD-2-Clause)의 `ProcessTap.swift`를 참고했다. 코드를 복사하지 않았고 GPL 의존성(BlackHole 등)은 쓰지 않는다.
