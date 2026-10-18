# Tractus — 에이전트 작업 지침

Local-first 노트·녹음 도구(메모·노트가 본체이고, 녹음은 텍스트 변환·요약·AI 질문·검색으로 확장하는 기능이다). ASR·저장·검색은 사용자 Mac에서 하고, LLM만 OpenAI 호환 API로 호출한다. 설계 결정은 `ARCHITECTURE.md`가 원본이다. 바꾸려면 그 문서부터 고친다.

## 앱 화면 디자인

- 앱 화면을 만들거나 고치기 전에 [app/DESIGN.md](app/DESIGN.md)를 읽는다(토큰·글자 크기·부품·규칙). 새 CSS 파일·색 상수를 만들지 않고 `app/src/theme.css` 토큰과 `app/src/components/ui/` 부품을 쓴다. 화면 확인은 `pnpm dev` 중 `/preview.html`(가짜 데이터)에서 라이트·다크, 폭 900·1280·1600으로 한다.
- 테스트가 HTML 문자열에서 `aria-disabled`·`disabled`를 찾으므로 클래스 이름에 그 글자를 쓰지 않는다: 변형은 `gated:`(aria-disabled)·`off:`(입력창 disabled)다.

## UI 문구·용어

- 사용자에게 보이는 문구(앱 UI·`aria-label`·토스트, 내보낸 문서, 앱이 보여 주는 코어 경고·오류·답변)를 쓰거나 고치기 전에 [WORDS.md](WORDS.md)를 읽고, 커밋 전에 그 문서 §5의 금지어 검사를 돌린다. 출력이 없어야 한다.
- 앱의 대상은 `노트`다. `회의`는 `대면 회의`처럼 현실의 상황을 말할 때만 쓰고(WORDS.md §2 `노트와 회의`), 화면에 남기면 줄 끝에 `words-ok`를 붙인다. 코드의 `meeting`은 그대로다.
- 화면에는 `대화 내용`·`텍스트로 변환`·`참석자`·`단어 싱크`·`자주 쓰는 단어`·`스마트 검색`을 쓰고, `전사`·`세그먼트`·`화자`·`색인`·`s0012`·`S1`은 보이지 않는다.
- 코드 식별자(`meeting_id`, `meetings/`, `--meeting`), CLI 명령·옵션, JSON 키, 이벤트·단계 키, MCP 출력, 개발 문서는 기술 용어를 그대로 쓴다.
- 제목이 없는 녹음의 기본 제목은 `녹음 HH:MM`이다(`cli._source_from_recording`, 영어 화면은 `Recording HH:MM`: 노트에 저장되는 문구는 만들 때의 화면 언어).
- **화면 문구는 `t("한국어 문구")`(`app/src/i18n.ts`)로 쓰고 영어를 `app/src/en/*.ts`에 더한다**(WORDS.md §7, docs/desktop.md §3.8). 한국어 문구가 키라 한국어를 고치면 사전의 키도 고친다. `t()`를 템플릿 문자열에 넣지 않고, 변수는 `{이름}` 자리표시자, 개수는 `n`(영어 복수형). `app/src/i18n.test.ts`가 빠진 번역과 `t()` 밖에 남은 한국어를 잡는다(언어와 상관없는 데이터는 줄 끝 `i18n-ok`).
- **Rust·코어도 같은 규칙이다**: Rust는 `i18n::t()`/`tv()` + `app/src-tauri/src/en.json`, 코어는 `tractus.i18n.t()` + `src/tractus/i18n_en.json`(앱이 넘기는 `TRACTUS_LANG=en`일 때만 영어). 검사는 Rust `i18n.rs` 테스트와 `tests/test_i18n.py`. MCP 출력·`store.stamp()`·노트 폴더 파일·AI 프롬프트는 옮기지 않는다(`i18n-ok`).

## ASR 모델 (Phase 0 확정, 2026-10-02)

| 트랙 | 모델 (MLX 8bit) | 로컬 경로 |
| --- | --- | --- |
| 기본 | `mlx-community/Qwen3-ASR-1.7B-8bit` | `models/qwen3-asr-1.7b-8bit` |
| 저사양 | `mlx-community/Qwen3-ASR-0.6B-8bit` | `models/qwen3-asr-0.6b-8bit` |

- 런타임은 `mlx-audio`(`mlx_audio.stt.utils.load`)를 **프로세스 안에서** 호출한다. `mlx_audio.server` HTTP 엔드포인트는 `hotwords`를 전달하지 않으므로 쓰지 않는다. 두 트랙은 모델 경로만 다르고 코드는 같다.
- VAD는 `mlx-community/silero-vad-v6`(`models/silero-vad-v6`). torch를 의존성에 넣지 않는다.
- Whisper·Nemotron은 Phase 0에서 탈락했다(`ARCHITECTURE.md` §8 "Phase 0 결과"). 새 벤치마크(`bench/`) 없이 ASR 모델을 바꾸거나 추가하지 않는다.

## 화자 분리 모델 (2026-10-04 확정)

| 모델 | revision | 로컬 경로 | 라이선스 |
| --- | --- | --- | --- |
| `mlx-community/Nemotron-3-Diarization` | `59ed2dbfc1346dcea9d423c71306a3a2499c568f` | `models/nemotron-3-diarization` | OpenMDW-1.1 |
| `FluidInference/speaker-diarization-coreml` (fluid, 9명 이상, 2026-10-07) | `df2625ac79a7ac6b65ad868fee6d80f320da4232` (FluidAudio 0.17.5가 고정) | `models/speaker-diarization` (폴더 이름은 FluidAudio가 정함) | CC-BY-4.0 (NOTICE 9번에 출처 표기) |

- `mlx_audio.vad.load`로 프로세스 안에서 돈다. ASR 전에 회의 전체로 1회 돌리고, 화자가 바뀌는 지점에서 VAD 청크를 나눈다. 최대 8명.
- **9명 이상은 fluid**(`transcribe --diarizer auto|nemotron|fluid`, 기본 auto): Swift 헬퍼 `tractus-diar`(`recorder/diar/`, 녹음 프로그램과 별도 패키지, FluidAudio v0.17.5 = `0b1f462`, Apache-2.0)를 subprocess(인수 배열)로 부른다. auto는 Nemotron이 평활 뒤 8라벨을 모두 썼을 때만 다시 돌린다. 기본 엔진을 fluid로 바꾸지 않는다(7명 세션 195에서 조금 나쁨, ARCHITECTURE §2.4.1).
- 헬퍼 위치: `$TRACTUS_DIAR_BIN`, 없으면 `<저장소>/recorder/diar/.build/release/tractus-diar`. 실행은 오프라인(`ModelHub.offlineMode`)이고, 모델은 `tractus-diar download --models models/speaker-diarization`으로 한 번 받는다. 없으면 `diarizer_cap`(auto)·`fluid_missing`(fluid) 경고 후 Nemotron. 쓴 엔진은 `diarization.engine`.
- FluidAudio 패키지는 `traits: []`로 NeMo 텍스트 정규화(Rust)를 빼고, 실행 파일 옆 `FluidAudio_FluidAudio.bundle`(espeak-ng에서 만든 TTS 사전)은 배포하지 않는다. `Package.resolved`의 새 의존성은 라이선스를 확인한다.
- 화자 분리 모델은 ASR 모델을 올리기 전에 내린다(`del` + `mx.clear_cache()`).
- 모델이 없거나 실패하면 화자 없이 전사하고 `warning` 이벤트 + stderr로 알린다. 이어하기는 화자 분리를 다시 돌리지 않는다.
- **화자 분리 엔진·평활 파라미터를 바꾸면 AI Hub(로컬, 지표만)와 가상 음성(macOS `say`) 둘 다에서 DER·confusion을 다시 잰다**: `uv run python bench/diar_eval.py der --engine nemotron fluid [--set <가상 음성 폴더>]`(가상 음성은 `bench/diar_synth.py <폴더>`로 만든다) → `bench/results/diar_summary.json`(지표만). 엔진은 `diarize(pcm, max_speakers) → [(시작, 끝, "S1"), …]`과 `.info`(engine 포함)만 맞추면 된다. AI Hub 세션으로 파라미터를 맞추지 않는다.
- 가상 음성은 `say -v Yuna`와 `say -v "Grandpa (한국어(한국))"`처럼 **엔진이 다른** 음성을 쓴다. 그냥 `Eddy`처럼 쓰면 영어 음성이 골라져 한국어가 거의 빈 오디오가 된다. Grandpa·Grandma처럼 같은 엔진 음성은 한 화자로 합쳐질 수 있다.

## 단어 정렬 모델 (2026-10-06)

| 모델 | revision | 로컬 경로 | 라이선스 |
| --- | --- | --- | --- |
| `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | `0e1a68e91d815300c7c9754b2a7639378b23db15` | `models/qwen3-forcedaligner-0.6b-8bit` | Apache-2.0 |

- `mlx_audio.stt.utils.load`로 프로세스 안에서 돈다. ASR 모델을 내린 뒤(`_free_mlx`) 세그먼트마다 1회 돌리고, 끝나면 내린 뒤 색인한다.
- **soynlp(LGPL-3) 금지.** mlx-audio의 `tokenize_korean`이 soynlp를 불러오므로 `align.Aligner`가 `aligner_processor.tokenize_korean`을 `align.tokenize`(공백 토큰마다 하나)로 바꿔 끼우고 `language="Korean"`으로 부른다. `tokenize_space_lang`은 한자를 글자마다 나눠 단어 수가 어긋나므로 쓰지 않는다.
- **불변식:** `words`가 null이 아니면 `words[k]["text"] == seg_text(s).split()[k]`이다. 텍스트를 바꾸는 코드는 `align.remap_words`로 `words`를 함께 옮긴다(`store.apply_text_edits`).
- 모델이 없거나 실패하면(`aligner_missing`/`aligner_failed`) 변환 직후 `words`는 null이다. `tractus align <회의>`가 나중에 채운다. 모델이 단어 시각을 못 낸 세그먼트(길이 0, 단어 수 불일치)는 null 대신 단어를 고르게 편 `approx: true` 추정이 되고, `align`은 이를 건너뛰고 `--force`가 다시 맞춘다. 단어 스키마에는 필수 키를 더하지 않는다.
- **텍스트를 처음 고칠 때 `words`를 `words_asr`(선택 키)에 복사하고, 원문으로 되돌리면 그 시각을 그대로 복원한다.** `words_asr`를 읽는 쪽은 `apply_text_edits`뿐이다.

## 목소리 프로필 (Phase 7.1, 2026-10-07)

| 모델 | 로컬 경로 | 라이선스 |
| --- | --- | --- |
| 3D-Speaker CAM++ zh_en advanced (k2-fsa 릴리스 ONNX, sha256 `aa3cfc16…ceba2`) | `models/3dspeaker-campplus-zh-en/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | Apache-2.0 |

- 런타임은 `onnxruntime`(1.29 이상, CPU) + `kaldi-native-fbank`다. **`sherpa-onnx`를 넣지 않는다**(휠에 espeak-ng GPL-3가 정적 링크). 화자 분리 뒤, 등록된 사람이 있을 때만 `voices` 단계를 돌린다. 결과는 `speakers.S1.suggested` **제안**이고 `name`(사용자 확정)이 아니다.
- **벡터는 `$TRACTUS_HOME/voices.json`(0600)에만 둔다.** 회의 폴더·transcript.json·MCP·LLM 프롬프트·색인·내보내기·로그·stdout에 쓰지 않는다. `voices list`도 이름·표본 수만 낸다.
- **제안 이름을 표시 이름으로 쓰지 않는다.** `store.speaker_name`은 `name`만 본다. bundle 내보내기는 `suggested`를 뺀다. `summarize.clean_owners(s, transcript)`는 확정되지 않은 제안 이름 owner를 null로 바꾼다.
- **등록에는 동의가 필수다**(`voices enroll --consent`, 개인정보보호법 제23조). `--consent` 없이 등록하는 경로를 만들지 않는다.
- **모델·`voices.THRESHOLD`·`MARGIN`·구간 선택·onnxruntime 버전을 바꾸면 `bench/voice_eval.py`(AI Hub, 로컬 전용, 지표만, 저장소 루트에서 `uv run --with soundfile python bench/voice_eval.py`)를 다시 돌린다.** AI Hub 라벨 행과 ALIASES 민감도 행을 둘 다 보고, 수치가 같은 세션 기준임을 적는다. 모델을 바꾸면 `MODEL_ID`가 바뀌어 기존 프로필은 매칭에서 빠지고 다시 등록해야 한다.
- 테스트는 가짜 임베더를 쓴다. 실제 모델은 `pytest -m slow`(가상 `say` 음성)만.

## 실시간 자막 (Phase 7.2, 2026-10-07)

- **미리보기 전용이다.** `tractus live`는 아무것도 저장하지 않는다(회의 폴더·색인·로그·stdout 외 어디에도 자막 텍스트를 쓰지 않는다). 정식 전사는 녹음을 멈춘 뒤 배치 `transcribe --recording`이 만든다. 앱은 `stop`을 보내 워커가 끝난 **뒤에** 배치 전사를 띄운다.
- 모델은 Qwen3-ASR **0.6B** 8bit와 Silero `feed()`만 쓴다. 1.7B를 올리지 않는다(`--engine std`는 개발·벤치 전용. 2026-10-14 실측으로 확정 지연 p95가 1.59–1.95초라 기준 1.0초를 넘어 실시간에 못 쓴다. 다시 따지려면 `bench/live_sim.py --engine std`로 다시 재고 docs/desktop.md §2.8의 표를 고친다). 물리 메모리 16GB 미만이면 `--force` 없이 거부한다.
- 실시간 화자 라벨(`--speakers`, Nemotron 스트리밍 'low')은 기본으로 끈다. GPU 사용률 증가분(시스템 전체 − 시작 전 기준값)이 약 세 배(12–17%p → 42%p)라서다. `gpu_util_mean`은 시스템 전체 값이니 `gpu_util_delta`로 비교한다. 최종 라벨과 다를 수 있다.
- **확정 규칙·임계값(`live.SILENCE_FRAMES`, `MAX_FRAMES`, `PARTIAL_FRAMES`, `TAIL_FRAMES`, 뒤처짐 상한)을 바꾸면 `uv run python bench/live_sim.py`(가상 `say` 대화, 실시간 약 75초)를 다시 돌려** `bench/results/live_summary.json`의 확정 지연·footprint·GPU를 비교한다. AI Hub 파일은 `--source`/`--reference`로 로컬에서만 재고 지표만 남긴다.
- 테스트는 가짜 VAD·ASR로 돈다(`tests/test_live.py`). 실제 모델은 `pytest -m slow`의 `test_real_live_captions_follow_a_growing_recording`(2배속).

## ASR 파이프라인 기본값 (Phase 0 근거)

- **언어는 자동 감지(`language=None`)가 기본이다.** `Korean`으로 고정하면 영어 위주 발화를 한국어로 번역하거나 반복 루프에 빠진다.
- **용어집은 `hotwords=[...]`로 넣는다.** 용어 재현율이 72%에서 84%로 오른다.
- **청크는 Silero VAD로 무음 지점에서 최대 30초 단위로 자른다.**
- **반복 루프를 막는다.** 청크 길이에 비례한 `max_tokens` 상한을 두고, 반복을 감지하면 재시도한다(언어 고정이면 자동 감지로, 아니면 그 청크만 온도 0.3으로 한 번 더, 그래도 루프면 반복을 접는다). 0.6B에서 한 발화가 11,000자 넘게 반복된 사례가 있다.
- **자주 쓰는 단어(hotwords) 안전장치(v3.51).** 이 노트에 가까운 것부터(일정 참석자 → `--term` → glossary → 노트의 제목·녹음 중 메모·내 메모에서 고른 낱말 `asr.note_terms` 20개까지, v3.53) 앞의 50개(`asr.HOTWORDS_MAX`)만, 1초 미만 청크에는 넣지 않고, 출력이 목록을 받아 적었으면(`asr.echoes_hotwords`) 그 청크만 단어 없이 다시 변환한다. 전역 `repetition_penalty`·앞 청크 텍스트를 문맥으로 넣기는 하지 않는다(리서치: 근거 없음·오류 전파).

## 데이터와 저장소 규칙

- **이미 있는 transcript.json을 고쳐 쓰는 코드는 모두 `store.note_lock(dir)`(`<노트>/.lock`, `fcntl.flock`) 안에서 읽고 쓴다.** 보통은 `store.edit_transcript(dir, fn)`을 쓴다(읽기→`fn`→바뀌었을 때만 쓰기). 오래 걸리는 계산(임베딩·정렬)은 잠금 밖에서 하고, 끝난 뒤 최신 노트를 다시 읽어 합친다. 새 노트의 첫 transcript.json(`write_transcript`)만 예외다. 앱은 transcript.json을 직접 쓰지 않고 CLI를 부른다.
- 끝난 노트(transcript.json 있음)에 남은 `.job.json`·`.chunks.jsonl`은 transcript.json이 이긴다(`find_job`이 지운다). 앱의 삭제 검사도 같은 규칙이다.
- 다음은 커밋하지 않는다(`.gitignore` 처리됨):
  - `models/`(가중치), `data/`(데이터셋)
  - `bench/results/raw/`(전사 원문), `bench/cache/`
- `data/aihub-meeting/`은 AI Hub 데이터다. 재배포가 금지되어 있다. 여기서 나온 전사 텍스트도 커밋하지 않는다.
- 커밋해도 되는 벤치마크 산출물은 지표 요약(`bench/results/summary.jsonl`)과 리포트(`bench/results/REPORT.md`)뿐이다.

## 코드 구조 (`src/tractus/`)

| 모듈 | 역할 |
| --- | --- |
| `audio.py` | FFmpeg 외부 호출(디코딩, Opus 보관), SHA-256 |
| `vad.py` | VAD 발화 구간 → 30초 이하 청크 |
| `diarize.py` | 화자 분리(Nemotron 3 `Diarizer`, fluid `FluidDiarizer` = `tractus-diar` 헬퍼), 단일 화자 평활(`smooth`), turn 정리(`_tidy`), 화자 경계로 청크 나누기(`split_chunks`) |
| `asr.py` | `Transcriber`: 청크 전사, 토큰 상한, 반복 루프 재시도·보정 |
| `align.py` | 단어 정렬(Qwen3-ForcedAligner): `tokenize`(soynlp 대체), `Aligner.align`, `align_segments`, 편집 뒤 시각 옮기기 `remap_words` |
| `attach.py` | 글만 있는 노트에 녹음 덧붙이기(`transcribe --append-to`, `finish_append`): 메모 노트 → 녹음 노트 변환, 세그먼트 ID(`s####` → `m####`) 옮김표로 요약(`summary.json`·`summaries/*.json`)·질문 기록 근거 옮기기, 녹음 폴더 `attach.json` 읽기 |
| `deferred.py` | 녹음과 변환 나누기(`tractus recording finish`, `transcribe --into`): 녹음 폴더 → "변환 전" 노트(`state: "recorded"`, `tracks/`·`audio.ogg`·`memos.json`, `.finish.json`으로 끊긴 저장 이어서 끝내기), 변환 전 노트의 입력 찾기(`note_tracks`)와 변환 결과 합치기(`finish_convert`) |
| `notes.py` | 직접 쓴 메모 노트(`kind: "memo"`, 오디오 없음)와 녹음 노트의 메모(`"memo"` 블록): 본문 → 줄(`derive_lines`, ID 유지·재사용 금지, `s####`/`m####`), 제목 정리, 요약 파일 제목 바꾸기 |
| `organize.py`, `organize_cli.py` | 노트 정리(즐겨찾기·태그·폴더, v3.20): 태그·폴더 규칙·한도, `note meta`·`folders`·`notes list`, `folders.json`(flock, 3단계), 목록 정렬·필터(`matching_ids` → 검색·MCP 필터) |
| `store.py` | 회의 폴더, `.job.json`·`.chunks.jsonl`(이어하기, 목소리 제안 포함), transcript.json/md/vtt (schema_version 2: 화자), `apply_speaker_edit`(rename·set·merge·dismiss), `apply_suggestions`, `apply_text_edits`(words도 옮김), `seg_text`(표시 텍스트 = `corrected_text` 우선), `add_glossary_terms` |
| `live.py` | 실시간 자막(미리보기): `WavTail`(커지는 WAV 꼬리 읽기), `Mixer`(트랙 합산·클립), `Resampler`(48k → 16k FIR), `Segmenter`(Silero feed, 0.5초 무음·8초 상한·3초 미리보기·쉼 미리 전사), `Live`(ASR·뒤처짐·정지), `SpeakerTrack`(선택) |
| `voices.py` | 목소리 프로필: CAM++ 임베딩(onnxruntime + kaldi-native-fbank), 화자 구간 고르기, `voices.json`(0600, 원자적 쓰기), `match`(헝가리안 + 임계값 + 2위와 차이) |
| `export.py` | 내보내기 txt·md·srt·vtt·csv(utf-8-sig)·docx(python-docx, `w:eastAsia`)·bundle(zip) |
| `llm.py` | 공급자 표(`PROVIDERS`: 서비스 주소·온도 정책 포함), `resolve_provider`(주소 덮어쓰기·호스트 기반 로컬 전용), `map_error`(SDK 오류 → `LLMError` 코드), `check_connection`(`tractus llm test`), `list_models`(`tractus llm models`), `complete_json`: strict JSON + Pydantic 검증 + 1회 재요청, `stream_chat`: 평문 스트리밍 |
| `summarize.py` | 요약 스키마, segment_ids 검증, summary.md/json |
| `summary_templates.py` | 요약 유형: 기본(`templates/*.md`)·내 유형(`$TRACTUS_HOME/templates/u-*.md`) 로더·CRUD·검증 |
| `summaries.py` | 유형별 요약(스키마 v2, `summaries/<key>.json`), 시스템 프롬프트 + 지침 구분자, 근거·owner 검증, 목록·삭제 |
| `enhance.py` | 노트 완성(`summarize --template enhanced`): 뼈대(메모 탭 `m####` → 녹음 중 메모·북마크 `r####`), 입력, 검증, 원문 덮어쓰기·정렬, `summaries/enhanced.json`(v2 + `kind`·`part`·`source`·`at`) |
| `obsidian.py` | Obsidian으로 보내기(`tractus obsidian`): 볼트/Tractus/<폴더…>/<날짜 제목>.md 하나, `.tractus.json`(경로·sha256)으로 고친 파일은 `--force` 없이 덮어쓰지 않음, 데이터 폴더와 겹치는 볼트 거부 |
| `calendar_event.py` | 캘린더 일정으로 시작한 녹음(`event.json`, 녹음 폴더 → 노트 폴더): 검사(`clean_event`·`load_event`), 기본 제목·참석자 hotwords(그 노트만, glossary에 쓰지 않음) |
| `sample_note.py` | 예시 노트(첫 사용자 온보딩, `tractus note sample`): `sample_note.json`(가상 회의) → 대화·참석자·메모·녹음 중 메모·회의록·완성된 노트. `"sample": true`는 색인·MCP 목록에서 뺀다 |
| `ask.py` | 회의 질의: 근거 모으기(회의 전사 전체 / 검색 8개 + 앞뒤 이웃), 프롬프트, 인용 대조·정리(`finalize`), 대화 기록 자르기, `chat.json` |
| `env.py` | `.env` / `.env.local` 로더 |
| `paths.py` | `TRACTUS_HOME`, `TRACTUS_MODELS_DIR` 해석 (CLI·MCP 공용). 녹음·도우미 프로그램 위치 `tool_bin`(`TRACTUS_REC_BIN`·`TRACTUS_DIAR_BIN` → 앱 번들 `bin/` → 저장소에서 빌드한 것)과 빌드 안내 `build_hint`(저장소 배치일 때만 `swift build` 명령, 아니면 일반 안내). 모델 폴더 순서: `TRACTUS_MODELS_DIR` → 등록된 모델이 이미 있는 `$TRACTUS_HOME/models` → 앱 설정 폴더의 `models` |
| `models_registry.py` | **모델·기능 목록의 원본**: 저장소·리비전·폴더·파일 크기, 기능(`CAPABILITIES`), 설치 상태(`inspect`), 프리셋, 받기 안내 문구 |
| `models_install.py` | `models download`(잠금·이어받기·sha256·오류 코드)·`remove` |
| `doctor.py`, `models_cli.py` | `tractus doctor`, `tractus models list|download|remove|prune` (docs/desktop.md §2.15) |
| `embed.py` | Qwen3-Embedding-0.6B 8bit (`mlx-community/Qwen3-Embedding-0.6B-8bit`, mlx-lm `load_model`), `LazyEmbedder`, 선택: `UpstageEmbedder`(solar-embedding-2, `TRACTUS_EMBED=upstage`), `load_embedder`가 고른다 |
| `index.py` | SQLite FTS5 음절 bigram + sqlite-vec, 증분 동기화(`stats()['pending']` = 지금 모델로 벡터가 없는 청크), strict 우선 + 가중 RRF |
| `mcp_server.py` | MCP 서버 7개 도구 (`build_server(home, embedder)`) |
| `cli.py` | `tractus transcribe`, `align`, `summarize`, `ask`, `index`, `search`, `speakers`, `voices`(`list --json`은 `model_present` 포함), `segments`, `render`, `glossary`, `export`, `note`(`new`·`save`·`title`), `mcp` |

환경변수는 `.env.example`에 모두 있다. 개발 중에는 저장소 루트의 `.env`(기본값)와 `.env.local`(API 키)을 CLI가 읽는다. 우선순위는 셸 > `.env.local` > `.env`.

## 메모 노트·제목 규칙

- 메모는 `transcript.json`의 `"kind": "memo"`다(`"kind"`가 없으면 녹음 노트, 옛 파일을 고치지 않는다). 오디오·vtt·asr가 없고 `audio.file`은 null이다. `store.is_memo(t)`로 가른다.
- 세그먼트는 `body`에서 만든다(줄마다 하나, `start=end=0`, `line` = 본문 줄 번호). 메모 내용은 `tractus note save`로만 고친다(`segments edit`·`speakers`는 거절). 시각이 필요한 출력은 `store.stamp(s)`(메모는 `n번째 줄`)를 쓴다. `_hms(s['start'])`를 직접 쓰지 않는다.
- **녹음 노트도 메모를 가진다**(오른쪽 패널 메모 탭, 선택 키 `"memo": {"body", "lines": [{"id": "m0001", "line", "text"}], "seq"}`). `tractus note save`가 메모 노트는 본문·세그먼트, 녹음 노트는 `memo` 블록만 쓴다(비우면 키를 지우고 마지막 줄 번호만 `memo_seq`로 남긴다: 다시 쓴 메모가 옛 요약 근거 `m####`와 겹치지 않게. ASR 세그먼트·단어·화자는 건드리지 않는다). 읽을 때는 항상 `store.memo_lines(t)`(키가 없거나 깨져도 빈 목록)·`store.memo_segments(t)`로 읽고 `t["memo"]`를 직접 읽지 않는다. 줄 ID `m####`는 ASR ID `s####`와 다른 번호 공간이고, 메모 줄은 `source: "memo"`로 ASR과 가른다(색인 청크·AI 질문 근거 블록 `[내가 적은 메모]`·요약 프롬프트 블록·내보내기 `메모` 절). 위치 표기는 `store.stamp`(`메모 n번째 줄`). 이 프롬프트를 바꾸면 `uv run pytest -m llm`과 `bench/ask_eval.py --memo`를 돌린다. 메모 없는 노트의 프롬프트는 바뀌면 안 된다.
- **글만 있는 노트에 녹음 추가**(`tractus transcribe … --append-to <노트>`, `attach.py`, docs/desktop.md §2.11): 대상은 `kind: "memo"`이고 오디오가 없는 노트뿐이다(아니면 종료 코드 2). 노트 폴더 안에서 변환하고, 끝날 때 `note_lock` 안에서 `kind`·`body`·`seg_seq`를 지우고 글을 `memo` 블록(`m####`)으로 옮긴다. 메모 노트의 `s####`는 새 ASR ID와 겹치므로 요약·질문 기록(`summary.json`·`chat.json`)의 근거를 `attach.id_map`으로 `m####`에 옮긴다 — **같은 일을 다시 해도 결과가 같아야 한다**(이미 `m####`면 그대로). 작업 파일 `.job.json`의 `attach: true`는 노트가 아직 메모 노트인 동안 낡은 것이 아니다(`store._job_pending`). `attach.json`만으로는 덧붙이지 않는다. 앱이 `--append-to`를 명시한다. 새 사용자 문구는 WORDS.md §4.11이고 `attach.py`도 §5 검사 대상이다.
- **녹음과 변환 나누기**(`tractus recording finish <녹음 폴더>` → "변환 전" 노트, `tractus transcribe --into <노트>` → 그 자리에서 변환, `deferred.py`, docs/desktop.md §2.16): 변환 전 노트는 `"state": "recorded"`(`store.is_recorded(t)`, `kind` 없음 = 녹음 노트)이고 `segments: []`·`asr` 없음·`audio` 채움이다. **새 소비자를 쓸 때 대화가 0개이고 `asr`가 없을 수 있음을 가정한다**(`t["asr"]` 직접 읽기 금지). 저장은 `transcript.json`이 마지막이고 어디서 끊겨도 같은 명령이 이어서 끝내며 **녹음 폴더는 끝까지 지우지 않는다**. 변환은 `.job.json`의 `convert: true`(`find_job(into=)`, `_job_pending`)로 이어하고, 합칠 때 `note_lock` 안에서 다시 읽어 결과 키(`audio`·`asr`·`speakers`·`diarization`·`segments`)만 덮어쓴다 — 변환 중에 고친 제목·메모·태그를 잃지 않는다. 변환 전 노트에는 요약·단어 싱크·참석자·대화 내용 수정·목소리 등록을 거절한다(`not_converted`, `먼저 텍스트로 변환하세요.`). `transcribe --recording`(바로 변환)은 바뀌지 않는다. 새 문구는 WORDS.md §4.7이고 `deferred.py`도 §5 검사 대상이다.
- **노트 정리**(선택 키 `favorite`·`tags`·`folder`·`updated_at`, docs/desktop.md §2.12): 쓰기는 `note meta`·`folders`만(`edit_transcript`/`note_lock`, 폴더는 `folders.json`+flock, 잠금 순서 폴더 → 노트). 이 키만 바뀐 저장은 `updated_at`을 올리지 않는다(`store.META_KEYS`): transcript.json을 통째로 새로 만드는 경로는 이 키를 옮겨 와야 한다. 폴더를 지워도 노트는 지우지 않고 상위로 올린다. 읽는 쪽은 키가 없거나 모양이 달라도 정리하지 않은 노트로 본다. 태그는 필터일 뿐 검색어가 아니다.
- 제목은 `tractus note title`(녹음·메모 공통)으로만 바꾼다. 폴더 이름은 그대로 두고 `transcript.json`·md·vtt·요약 파일 제목·색인이 바뀐다. 사용자에게 보이는 문구는 `WORDS.md`를 따르고 새 모듈 `notes.py`도 §5 검사 대상이다.

## 모델 목록 규칙

- **모델을 쓰는 기능을 새로 만들면 `src/tractus/models_registry.py`에 모델(`MODELS`)과 기능(`CAPABILITIES`)을 선언하고, 앱에서 그 기능의 단추를 막는다**(없을 때 이유와 `모델 화면 열기`). 모델이 없어도 코어는 죽지 않고 그 단계를 건너뛰며 `code`가 있는 경고를 낸다. 변환 엔진 둘은 `필수 (둘 중 하나)`다: `Model.level_note = "one_of"`를 달고 `level`은 `required`로 둔다(둘 다 필수로 보이게 하지 않는다). 필수 모델(VAD + 변환 엔진 하나)과 ffmpeg만으로 녹음·가져오기 → 텍스트 변환 → 요약이 돌아야 한다.
- 저장소·리비전·폴더 상수는 한 곳에 둔다. `diarize`·`align`·`embed`·`voices`의 상수를 바꾸면 레지스트리가 따라가고(가져온다), ASR·VAD는 레지스트리가 원본이다. 파일 크기는 허브 API(`model_info(files_metadata=True)`)로 대조한다. 받기 안내 문구는 `registry.install_hint`로 만든다(`hf download …`를 직접 쓰지 않는다).
- 코어는 모델 파일을 `tractus models remove`·`prune`(등록되지 않은 폴더)으로만 지운다. **`prune`은 모델 모양(완료 표시·`config.json`·`*.safetensors`)인 폴더만, 모델이 하나라도 든 모델 폴더에서만 지운다.** 노트 폴더(`TRACTUS_HOME`, `meetings/`·`recordings/`가 있는 곳)를 모델 폴더로 잘못 골라도 아무것도 지우지 않고, `models move`도 그런 곳을 목적지로 거부한다. 앱의 확인 창은 지울 폴더 이름을 보여 준다. 코어는 저장소 위치를 가정하지 않는다: 도우미 프로그램 경로는 `paths.tool_bin`(환경변수 → 앱 번들 → 저장소), 저장소 경로가 든 빌드 안내는 `paths.in_repo()`일 때만 말한다.

## 경로 규칙 (앱 `app/src-tauri/src/paths.rs`)

- **`settings.json`은 `patch_settings`(lib.rs)로만 쓴다**: 한 번에 하나, 임시 파일 → 이름 바꾸기. 새 설정 키는 그 키만 바꾸는 `merge_*`를 만들어 넘긴다. 설정 화면의 `save_settings`는 화면이 고치는 칸(데이터 위치·실행 파일·모의 녹음·실시간 텍스트 변환)과 `models_dir`만 바꾼다.
- 설정의 `tractus_bin`·`rec_bin`·`models_dir`이 비어 있으면 `자동`이다. 저장하는 것은 사용자가 입력한 값뿐이다: 자동으로 찾은 경로를 `settings.json`에 쓰지 않는다(`Settings::for_save`).
- 찾는 순서는 직접 지정(파일이 있을 때) → 환경변수 → 앱 번들 안 → 컴파일 때 저장소 → 알려진 설치 위치다. 하위 프로세스를 띄우는 곳은 모두 `Settings::tractus_path`·`rec_path`를 쓴다. `s.tractus_bin`을 직접 실행하지 않는다.
- 데이터 폴더를 바꿔도 노트를 옮기지 않는다(원본 보호). 모델 폴더를 옮길 때는 옮긴 **뒤에** 설정을 바꾼다.

## 검색·MCP 규칙

- **표시 텍스트는 언제나 `store.seg_text(s)`(`corrected_text`가 있으면 그것, 없으면 `text`)다.** 출력·프롬프트·색인·내보내기에서 `s['text']`를 직접 읽지 않는다. 원문 `text`는 바꾸지 않는다.

- 검색 결합 방식이나 토크나이저를 바꾸면 `bench/search_eval.py`(가상)와 `bench/aihub_search_eval.py`(AI Hub, 로컬 전용)를 **둘 다** 돌려 비교한다. 가상 평가셋만 보면 동일 가중 RRF가 좋아 보이지만, 실제 ASR 전사에서는 키워드 단독보다 나빴다.
- 임베딩 모델·revision·지시문을 바꾸면 `embed.MODEL_ID`가 바뀌어 벡터가 전부 다시 만들어진다.
- **검색 평가 면제 기록 (2026-10-15, 소유자 결정).** 임베딩을 bf16 공식 가중치에서 `mlx-community/Qwen3-Embedding-0.6B-8bit`(revision `407ad232…`)로 바꿀 때 위 평가(`bench/search_eval.py`·`bench/aihub_search_eval.py`)를 **돌리지 않았다.** 확인한 것은 bf16 대비 코사인 0.999 이상과 "바꿔 쓴 문장 > 무관한 문장" 점검뿐이다. 즉 8bit의 검색 품질은 검증되지 않았다. 다음에 검색(결합·토크나이저·임베딩)을 건드릴 때 둘 다 돌려 기준선을 다시 잡는다.
- `mlx-embeddings`(GPL-3), Kiwi(LGPL-3) 같은 copyleft 의존성을 넣지 않는다.
- MCP 도구는 async로 쓴다(sqlite·MLX는 스레드에 묶임). 예상된 실패는 `ToolError`로 던진다. stdout에는 아무것도 출력하지 않는다.
- MCP 서버는 임베딩하지 않는다(`sync(embed=False)`). 벡터는 CLI가 만든다.
- **검색 임베딩은 선택이다(v3.33): `TRACTUS_EMBED=local`(기본) | `upstage`.** `embed.load_embedder`가 CLI·MCP 모두의 단일 선택 지점이다(오타는 로컬로 본다: 원격 전송은 정확히 `upstage`일 때만). `UpstageEmbedder`는 로컬 임베더와 같은 모양(`model_id`·`dim`·`embed(texts, is_query)`)이고 passage는 `solar-embedding-2-passage`, 질의는 `solar-embedding-2-query`, 1024차원(첫 응답이 아니라 **모든** 응답에서 확인, 어긋나면 오류: 섞인 벡터를 넣지 않는다), `MODEL_ID` `upstage/solar-embedding-2/1024`라 바꾸면 벡터가 다시 만들어진다. 요청 하나 100개·입력 3500자 초과는 자른다. 429·5xx는 SDK 재시도, 그래도 실패하면 `Index._embed`가 키워드로 물러나고(벡터는 `pending`) 오류 줄에는 상태 코드만 남긴다(노트 문장·키 없음). **키는 `UPSTAGE_API_KEY`, 주소는 `UPSTAGE_BASE_URL`만 읽는다**(전역 `TRACTUS_LLM_BASE_URL`은 읽지 않는다: 다른 서비스를 가리키는 전역 값이 Upstage 키를 엉뚱한 곳에 보내면 안 된다). `TRACTUS_LOCAL_ONLY`면 쓰지 않는다. **"MCP에 키를 넘기지 않는다"의 유일한 예외**: 사용자가 Upstage 임베딩을 고르면 앱이 `TRACTUS_EMBED=upstage`와 `UPSTAGE_API_KEY`(그 키 하나)를 색인 작업과 MCP·검색 프로세스에 싣는다. 노트 문장(색인)과 검색어(검색)가 Upstage로 간다. Upstage 임베딩의 검색 품질은 `bench/search_eval.py`·`aihub_search_eval.py`로 아직 재지 않았다(선택 사항이고 기본은 로컬 그대로. 기본으로 삼으려면 둘 다 돌려 비교한다).
- **노트 삭제는 앱 전용이다.** 앱이 폴더를 macOS 휴지통으로 옮기고(`app/src-tauri/src/removal.rs`), 색인은 `Index.sync`가 사라진 폴더를 지운다. `tractus delete`나 MCP 삭제 도구를 만들지 않는다. 목소리 프로필·자주 쓰는 단어는 지우지 않는다.
- 에이전트 CLI 인수 테스트에는 `tests/fixtures/eval`(가상 회의)만 쓴다. AI Hub 전사가 들어 있는 홈을 MCP에 연결하지 않는다.

## LLM 규칙

- 공급자는 OpenAI 호환 API 키 방식만 쓴다. `claude -p`, `codex exec`, `agy`를 공급자로 붙이지 않는다(약관, ARCHITECTURE.md §0).
- **공급자 표(`llm.PROVIDERS`): `upstage`·`openai`·`claude`·`gemini`·`custom`(직접 입력, OpenAI 호환, 엄격 JSON 끔, 기본 AI 모델 없음)·`gemma-local`.** 서비스 주소는 `TRACTUS_LLM_BASE_URL`로 바꾼다(http/https + 호스트, 계정 정보·공백·역슬래시는 `llm_config`). **서비스별 변수(v3.33)**: `UPSTAGE_`·`OPENAI_`·`ANTHROPIC_`·`GEMINI_` + `BASE_URL`·`MODEL`(`.env.example`). 우선순위는 인수 > 전역 `TRACTUS_LLM_BASE_URL`·`TRACTUS_LLM_MODEL`(**`TRACTUS_LLM_PROVIDER`가 그 서비스이거나 비었을 때만**, `custom`은 항상) > 서비스별 > 표의 기본값. 전역 값이 다른 서비스를 가리킬 때 이 서비스에 새지 않게 한 것이다. `gemini` 기본 AI 모델은 별칭 `gemini-flash-latest`(`gemini-2.5-flash`는 새 사용자에게 404, 2026-10-15). `custom`의 키는 `TRACTUS_LLM_API_KEY`이고 비워도 되는 것은 주소가 이 Mac(`localhost`·`127.0.0.1`·`::1`)일 때뿐이다. 새 라이브러리(LiteLLM 등)를 들이지 않는다(`docs/llm-providers.md`).
- **Claude와 OpenAI는 온도를 보내지 않는다**(`Provider.temperature=None`). Claude 호환 계층은 4.7 이상의 온도 1 미만을, OpenAI gpt-5·o 계열은 기본값이 아닌 온도를 400으로 거절한다. 다른 공급자는 0.2다.
- **코어는 HTTP 3xx를 따라가지 않는다**(`make_client`). 앱은 서비스를 정하면 주소도 정한다(비면 서비스 기본 주소를 `TRACTUS_LLM_BASE_URL`로 싣는다): 노트 폴더 `.env`·셸의 주소가 키를 받지 못하게. 연결 테스트는 코어 30초(총 시간)·앱 35초(프로세스 kill) 제한이 있다. 공급자를 더하면 온도 정책을 표에 적는다.
- **로컬 전용 모드(`TRACTUS_LOCAL_ONLY`)는 이름이 아니라 주소의 호스트로 판단한다.** `urlsplit`으로 파싱한 호스트가 정확히 `localhost`·`127.0.0.1`·`::1`이 아니면 `llm_local_only`다(부분 문자열 비교 금지: `localhost.evil.com`, `user@host`). 앱(`llm_key.rs`)·화면(`llmKey.ts`)에도 같은 규칙이 있다: 셋을 함께 바꾼다.
- **SDK 오류는 `llm.map_error`가 `LLMError`로 바꾼다**(`llm_auth` 401·403 / `llm_rate` 429 / `llm_busy` 503·529·`UNAVAILABLE`·`overloaded` / `llm_model` 404(서버 안내 문장을 키 가리고 200자로 `자세히`에 싣는다) / `llm_context` / `llm_conn` 연결·시간 초과 / `llm_api`). 실제 호출은 SDK가 408·409·429·5xx를 4회 지수 백오프로 다시 보낸다. `cli.py`는 `LLMError`만 잡고 `code`를 오류 이벤트에 싣는다. 새 코드를 더하면 `app/src/lib.ts` `ERROR_TEXT`·WORDS.md·docs/desktop.md 표도 고친다. `tractus llm test`는 같은 해석·환경으로 짧은 요청 한 번(`max_tokens` 256, 재시도 없음)을 보내고 HTTP 200이면 성공이다(`empty: true`: 생각하는 AI가 토큰을 생각에 다 써 답이 비어도 연결은 된 것). `tractus llm models [--provider P]`는 `GET /models`로 `{"models": [ID…]}`를 낸다(앞의 `models/` 제거).
- 모든 추출 항목은 근거 `segment_ids`가 필수다. 프롬프트·스키마를 바꾸면 `uv run pytest -m llm`으로 확인한다.
- **노트 완성(`enhance.py`, docs/design/enhanced-notes.md).** 녹음 중 메모·북마크는 노트 완성에만 쓰고 기존 요약 프롬프트에는 넣지 않는다(넣으려면 요약 품질을 따로 잰다). 메모 원문은 모델이 아니라 코어가 제목으로 쓴다. 프롬프트·스키마를 바꾸면 `uv run pytest -m llm -k enhance`를 돌린다.
- **요약 유형·직접 프롬프트(v3.21).** 기본 유형(회의록)은 옛 스키마의 `summary.json`이고 다른 유형·직접 요약은 `summaries/<key>.json`(스키마 v2)이다. 요약 지침(유형 본문·내가 쓴 방법)은 시스템 규칙(`summaries.SYSTEM_PROMPT`)이 항상 이기고 `<요약 지침>`으로 감싼다. 새 유형 파일이나 시스템 프롬프트를 바꾸면 `uv run pytest -m llm -k template`을 돌린다(유형마다 스키마·근거·owner 라벨·한국어를 본다). 직접 요약이 내 유형으로 저장되는 것은 요약이 성공한 뒤다.
- 화자는 자동 추정이다. owner에는 사용자가 이름을 붙인 화자만 쓰고 `S1` 같은 라벨은 쓰지 않는다. 프롬프트만으로는 새어 나와서 `summarize.clean_owners`가 null로 바꾼다.
- **회의 질의(`ask`)는 원격 공급자로 질문, 최근 대화, 근거 세그먼트 텍스트만 보낸다.** 오디오·요약·근거 밖 전사는 보내지 않는다. 답의 인용은 `ask.finalize`가 근거와 대조해 없는 ID를 지운다. 프롬프트를 바꾸면 `uv run pytest -m llm`과 `bench/ask_eval.py`(가상 회의만)를 돌린다. 전체 범위 질의는 단독 질문에 keyword 일치가 없으면 직전 사용자 질문 2개를 보탠 검색을 섞는다(`ask._hits`). `done`·`chat.json`의 `no_evidence`는 인용이 하나도 안 남았다는 뜻이다(거절 문장과 같은 말이 아니다).
- **AI Hub 데이터의 전사를 원격 LLM에 보내지 않는다.** 테스트는 `tests/fixtures/sample_meeting.json`(가상 회의)만 쓴다.
- API 키를 코드·로그·커밋·대화에 남기지 않는다. `.env.local`에만 둔다.
- **앱의 API 키는 앱 설정 폴더의 서비스별 파일(0600)에만 둔다**(Upstage는 `llm_key`, 나머지는 `llm_key.<서비스>`. `$TRACTUS_HOME`·`settings.json`·webview·인수·로그에 두지 않는다). 서비스마다 주소·AI 모델은 `settings.json`의 `llm_profiles`에 두고(`llm_default`는 기본 서비스, 예전 `llm_provider` 등은 읽을 때 옮긴다), 요약·질문은 등록된 서비스 중에서 그때그때 고른다. **이번에 고른 서비스의** 키·주소·AI 모델만(서비스 `TRACTUS_LLM_PROVIDER`도 함께 싣는다: 셸·`.env`가 다섯 서비스 중 하나를 정해 두어도 앱의 선택이 이긴다. 앱 밖의 서비스 `gemma-local`은 환경이 정한다) 요약·질문·연결 테스트·모델 목록을 돌리는 `tractus` 프로세스(`Settings::tractus_llm(args, provider)`)에 그 서비스의 환경변수로 넘기고, 녹음 등에는 키도 주소도 넘기지 않는다. 앱은 `TRACTUS_EMBED`를 늘 정하고, 사용자가 스마트 검색을 Upstage로 고른 옵트인일 때만 `UPSTAGE_API_KEY` 하나(와 `UPSTAGE_BASE_URL`)를 문장·검색어를 임베딩하는 실행(색인·변환·가져오기·요약·질문)과 상주 검색 프로세스에만 싣는다(`Settings::embed_key_env`: 위 "MCP에 키를 넘기지 않는다"의 유일한 예외. 녹음 프로그램·화자·내보내기 등 `child_env`에는 없다). 키는 5~200자. 화면에는 요약·답변에 쓴 AI 서비스·모델 이름을 쓰지 않는다(WORDS §6 2026-10-15). 키를 로그·오류 문구·`error` 이벤트에 찍지 않는다(서버가 돌려준 문구에서도 가린다). 테스트는 가짜 키(`test-key-123`)와 로컬 가짜 서버(`tests/test_llm_providers.py`)만 쓴다(`app/src-tauri/src/llm_key.rs`, docs/desktop.md §2.14).

## Claude Code 플러그인 (v3.40)

- **`plugins/tractus/`가 플러그인이고 저장소 루트 `.claude-plugin/marketplace.json`이 마켓플레이스다.** 플러그인 폴더에는 앱 소스를 넣지 않는다(설치하면 그 폴더만 복사된다). MCP는 `bin/tractus-mcp`가 띄운다: stdout에 아무것도 찍지 않는다(MCP 통로), 경로를 찾는 순서를 바꾸면 `tests/test_plugin.py`와 docs/mcp.md를 함께 고친다. 키를 MCP에 넘기지 않는다(앱의 Upstage 옵트인 예외는 플러그인에 없다).
- 릴리스할 때 `plugins/tractus/.claude-plugin/plugin.json`의 `version`을 앱 버전과 맞춘다(버전이 같으면 사용자에게 업데이트가 가지 않는다). 매니페스트를 바꾸면 `claude plugin validate . --strict`와 `claude plugin validate plugins/tractus --strict`를 돌린다.
- 플러그인을 실제 세션으로 시험할 때는 가상 회의 홈(tests/fixtures/eval을 복사해 색인)만 쓴다: `.mcp.json`의 `TRACTUS_HOME`을 그 홈으로 바꾼 복사본을 `claude --plugin-dir`로 띄운다. 실제 노트·AI Hub 홈을 연결하지 않는다.
- 실행기는 `cd "$TRACTUS_HOME"`(없으면 `/`) 뒤에 서버를 띄운다: 코어가 작업 폴더의 `.env`를 읽으므로, Claude Code가 연 프로젝트의 `.env`가 끼어들지 않게. MCP 도구는 노트 경로를 이 데이터 폴더 안만 받는다.
- MCP `cite`는 사람이 읽는 `[노트 제목 시각]`이다. 에이전트가 정확한 자리를 다룰 때는 결과의 `meeting_id`·세그먼트 `id`를 쓴다.

## 메뉴 막대 아이콘 (v3.24)

- **메뉴 막대(트레이)의 녹음 시작·종료·북마크는 Rust가 하지 않는다.** Rust(`tray.rs`)는 메뉴·제목·아이콘만 그리고 `tray-action` 이벤트를 화면에 보내며, 화면이 창의 단추와 같은 함수로 처리한다(쓰던 메모 저장·권한·기능 잠금이 한 곳에 있게). 경과 시간은 화면 타이머가 아니라 Rust 틱이 센다(숨은 창은 타이머가 늦다). 창 닫기는 `should_hide_on_close`, 종료는 언제나 `begin_quit`이다 (docs/desktop.md §3.1, WORDS.md §4.16).

## 앱 번들 규칙 (미리 만든 앱, `scripts/build_app_bundle.sh`·`make_dmg.sh`)

- **번들 구성은 `Tractus.app/Contents/Resources/`의 `runtime/`(옮길 수 있는 Python 3.12 + `site-packages` + 래퍼 `runtime/bin/tractus`, 파이썬은 `-I`로 실행)와 `bin/`(`tractus-rec`, 선택 `tractus-diar`)다.** 코어(Python)는 파일 위치를 `sys.executable`·`__file__` 기준 상대 경로로만 찾는다(`paths.tool_bin`: `runtime/bin/python3.12`에서 `../../bin/`). 만든 Mac의 절대 경로(`REPO_ROOT`, `.venv`, 홈 폴더)를 가정하는 코드를 넣지 않는다. 앱(Rust)은 `current_exe()` 기준 `../Resources/…`(`paths.rs`)다.
- 번들 안은 서명으로 봉인되어 있다. **코어는 실행 중에 번들 안에 아무것도 쓰지 않는다**(`PYTHONDONTWRITEBYTECODE=1`, 바이트코드는 빌드 때 `unchecked-hash`로 미리 만든다). 캐시·임시 파일은 데이터 폴더나 `$TMPDIR`에 쓴다.
- 의존성을 바꾸면(`pyproject.toml`·`uv.lock`) 번들은 wheel만 설치한다(`--only-binary :all:`). sdist만 있는 패키지는 번들 빌드가 실패하므로 넣기 전에 wheel이 있는지 본다. copyleft 의존성 금지 규칙은 그대로다.
- **번들을 바꾸는 변경은 복사본을 옮겨 놓고 확인한다**: 빌드한 앱을 다른 폴더에 복사해 저장소·원래 Python 읽기를 막은 `sandbox-exec` + `env -i`에서 `tractus doctor --json`·텍스트 변환·`tractus-rec record --fake`·`tractus mcp`를 돌린다(절차와 결과: ARCHITECTURE.md v3.30). 깨끗한 Mac에서의 확인은 GitHub Actions `Bundle smoke`(`.github/workflows/bundle-smoke.yml`, 매주·수동)가 한다: 러너에서 번들을 만들고 저장소 밖 `env -i`에서 `doctor`·메모 만들기·`record --fake`·서명 검증을 돌린다(2026-10-16 첫 통과, 파이썬 3.12.15). 옮길 수 있는 파이썬 판정은 불러오는 라이브러리가 시스템 것이거나 실행 파일 기준인지로 본다(새 python-build-standalone은 libpython을 정적으로 품는다). `tauri.conf.json`에는 `bundle.resources`를 고정하지 않는다(스크립트가 `--config`로 합친다).
- 번들 빌드와 `.dmg`는 저장소 복사본에서 돌려 시험한다(`rsync`로 `.git`·`target`·`node_modules`·`.venv`·`models`·`data` 제외). 결과는 `dist/`(gitignore)에 둔다.
- **앱 안 업데이트(v3.34, Tauri updater)는 번들에서만 켠다**: Rust `update_available()`이 `paths.rs`의 번들 판별(`../Resources/runtime/bin/tractus`)로 가르고, 저장소에서 만든 앱·개발 실행에서는 확인하지 않는다. **자동 설치 금지**: 확인은 시작 약 10초 뒤와 `업데이트 확인` 단추에서만, 받기·설치는 사용자가 `업데이트 설치`를 누른 뒤에만, 다시 열기도 단추다.
- 서명 개인 키는 `~/.tauri/tractus.key`(비밀번호 없음, 저장소 밖, **백업 필수**: 잃으면 기존 설치본이 새 업데이트를 거부한다). 저장소에는 공개 키(`tauri.conf.json` `plugins.updater.pubkey`)만 두고 개인 키 내용을 출력·로그·커밋하지 않는다.
- **`latest.json`·`Tractus.app.tar.gz`·`.sig`는 `scripts/release.sh`만 만든다.** `bundle.createUpdaterArtifacts`는 쓰지 않는다(`tauri build`의 tar.gz는 최종 ad-hoc 재서명 전이다). 엔드포인트 `releases/latest/download/latest.json`은 공개 저장소의 정식 릴리스(pre-release 아님)만 가리킨다. 사용자 문구는 WORDS.md §4.21이다.

## 자주 쓰는 명령

개발 도구(Rust·Node·pnpm·uv·ffmpeg)는 `scripts/bootstrap.sh [--check] [--yes] [--with-install]`가 `Brewfile`로 빠진 것만 설치한다(Xcode 명령줄 도구·Homebrew는 안내만, sudo·curl|sh 없음). 설치(코어 + 녹음 프로그램 + 앱 빌드)는 `scripts/install.sh [--check] [--with-fluid] [--models <구성>] [--copy-app]`(끝에 `tractus doctor` 점검과, 앱 설정의 직접 지정 경로가 맞는지 읽기만 하는 경고)이고, 업데이트는 `scripts/update.sh [--check] [install.sh 옵션]`(작업 폴더가 깨끗하고 origin을 따라가는 브랜치에서만 `git pull --ff-only` 뒤 install), 빌드 산출물 정리는 `scripts/clean.sh [--all] [--yes] [--force]`(`target`·`.build`만, 정해진 폴더 밖·`.venv`·`models/`·노트는 안 지운다, 실행 중이면 거부)이다. 미리 만든 앱은 `scripts/build_app_bundle.sh [--check] [--out D] [--with-fluid]`(→ `<out>/Tractus.app`)와 `scripts/make_dmg.sh <앱> [--version X] [--out dist]`(→ `dist/Tractus-<버전>-arm64.dmg`)다. 릴리스 한 벌은 `scripts/release.sh [--publish]`(번들 → `Tractus.app.tar.gz` + `.sig` + `latest.json` → `.dmg` + sha256 → `dist/release/<버전>/`, 기본은 `gh release create` 명령 출력만, 키는 `~/.tauri/tractus.key`)다. 설치 안내는 `docs/setup.md`가 원본이다. **`clean.sh` 같은 삭제 스크립트는 실제 저장소에서 시험하지 않는다(빌드한 앱이 지워진다). 저장소 복사본(`git archive`)에서 시험한다.** 앱은 빌드한 저장소 안의 `.venv/bin/tractus`·`recorder/.build/release/tractus-rec`를 쓰므로(컴파일 때 경로가 들어간다) 설치 뒤 저장소를 옮기면 다시 설치한다. 필수 도구·버전 하한을 바꾸면 `Brewfile`, `scripts/bootstrap.sh`, `scripts/install.sh`, `docs/setup.md`를 같이 고친다. Swift 하한: `recorder/`(tractus-rec)는 tools 5.10(Xcode 15.3), `recorder/diar/`(tractus-diar, FluidAudio `traits: []`)는 tools 6.2(Xcode 26)이고 `--with-fluid`일 때만 요구한다. `recorder/`의 tools-version을 6.x로 올리지 않는다.

```bash
uv run pytest                                       # 단위·CLI 테스트 (모델 불필요). PR마다 GitHub Actions CI(.github/workflows/ci.yml)가 같은 것을 돈다
scripts/check_words.sh                              # WORDS.md §5 금지어 검사 (출력 없으면 통과)
uv run python scripts/check_licenses.py             # copyleft(GPL·LGPL·AGPL) 의존성 검사: Python·npm·Rust
scripts/demo/make_demo.sh [--lang en]              # README 데모 GIF(docs/images/demo.gif, 영어는 demo-en.gif) 다시 만들기 (pnpm dev 미리보기 + Chrome + ffmpeg, 가짜 데이터만)
scripts/screenshots/make_shots.sh [--lang en]       # README 스크린샷(docs/images/*.png, 영어는 docs/images/en/) 다시 만들기
uv run pytest -m slow                               # 실제 모델 테스트
uv run pytest -m llm                                # 실제 LLM API 스모크 (키 있는 공급자만)
uv run pytest -m network                            # 작은 VAD(1.3MB)를 임시 폴더에 실제로 받는다
uv run tractus doctor [--json]                      # 시스템·도구·모델·기능 점검
uv run tractus models list [--json]                 # 설치 상태 (download [ID…|--preset required|standard|lite|all] [--progress-json], remove ID --yes)
uv run tractus summarize <meeting_id>               # 요약
uv run tractus llm test [--provider P] [--model M]   # AI 서비스 연결 테스트 (한 줄 JSON, 키 출력 없음)
uv run tractus llm models [--provider P]              # 서비스의 AI 모델 ID 목록 → {"models": […]}
TRACTUS_EMBED=upstage uv run tractus index            # 검색 임베딩을 Upstage로 (UPSTAGE_API_KEY 필요, 노트 문장이 전송됨)
uv run tractus summarize <meeting_id> --template brief   # 요약 유형 (templates list --json). 직접: echo '{"prompt": "…"}' | … --custom
uv run tractus summaries <meeting_id> list --json   # 노트의 요약들 (delete KEY)
echo "질문" | uv run tractus ask [--meeting <id>] [--from/--to YYYY-MM-DD] [--save]   # 회의 질의 (앱: stdin JSON + --progress-json)
uv run tractus index / search "<질의>"              # 색인, 검색
uv run tractus speakers <meeting_id> list --json    # 화자 (rename S1 이름 / set s0012 S2|new / merge S3 S1 / dismiss S1)
uv run tractus voices enroll <meeting_id> S1 --name 이름 --consent   # 목소리 등록 + 이름 확정 (list --json / forget / match)
echo '{"edits":[{"id":"s0012","text":"새 문장"}]}' | uv run tractus segments <meeting_id> edit   # 텍스트 교정 → {"changed": N}
uv run tractus glossary add 쿠버네티스 "Project Atlas"  # 용어집 추가 → {"added": N}
uv run tractus note new [--title T]                  # 메모 만들기 → {"meeting_id","meeting_dir"} (stdin 선택: {"title","body"})
uv run tractus note sample                          # 예시 노트(온보딩, 가상 회의) → {"meeting_id","meeting_dir","created"}. 이미 있으면 그것
echo '{"body":"…"}' | uv run tractus note save <meeting_id>   # 메모 본문 저장(메모 노트·녹음 노트) → {"saved":true,"segments":N,"changed":bool,"kind":"memo"|"recording"}
echo '{"title":"…"}' | uv run tractus note title <meeting_id> # 제목 바꾸기 → {"title":"…"}
echo '{"favorite":true,"tags":["a"],"folder":"<폴더 ID>"|null}' | uv run tractus note meta <meeting_id>   # 즐겨찾기·태그·폴더 → 저장된 값
uv run tractus folders list --json | create --name N [--parent ID] | rename ID --name N | move ID --parent ID|none | delete ID
uv run tractus notes list --json [--favorite] [--tag T] [--folder ID|이름|none] [--sort created|updated|title|duration] [--order asc|desc]
uv run tractus models prune [--yes] [--json]         # 등록되지 않은 모델 폴더(옛 버전 등) 지우기 → {removed: [{name, bytes}], freed_bytes}
uv run tractus models move <새 폴더> [--yes]         # 등록된 모델만 모델 폴더에서 옮김 → {moved, freed_bytes}
uv run tractus export <meeting_id> --format docx --out 회의.docx [--force] [--summary KEY]   # txt|md|srt|vtt|csv|docx|bundle → {"path": …}. md·docx에 넣을 요약(기본: meeting, 없으면 있는 것)
uv run tractus obsidian <meeting_id> --vault <볼트> [--summary KEY] [--audio] [--force]   # Obsidian으로 보내기 → {"status": created|updated|unchanged|edited, "path", "audio"}
uv run python bench/search_eval.py                  # 검색 평가 (가상)
uv run python bench/ask_eval.py [--memo]            # 질의 평가 (가상 회의만 원격 LLM으로, --memo: 메모가 달린 가상 노트 3건 + 메모 질문 6개)
uv run tractus transcribe <파일> [--no-align] [--diarizer auto|nemotron|fluid]   # 전사 (+ 단어 타이밍)
(cd recorder && swift build -c release && swift test)                # tractus-rec (Swift 5.10+)
(cd recorder/diar && swift build -c release && swift test)           # tractus-diar (Swift 6.2+)
uv run python bench/diar_eval.py der --engine nemotron fluid         # 화자 분리 DER (AI Hub 로컬 전용, 지표만)
uv run tractus align <meeting_id> [--force]         # 단어 타이밍 채우기 → {"aligned": N, "failed": M, "skipped": K}
echo stop | uv run tractus live --recording <녹음 폴더> --progress-json   # 녹음 중 실시간 자막 (stdin stop/EOF로 끝, 저장 안 함)
uv run python bench/live_sim.py                     # 실시간 자막 시뮬레이션 (가상 대화, 실시간 약 75초)

cd bench && uv sync                                 # 벤치마크 의존성
uv run python run.py qwen3-1.7b hike --lang auto    # 실험 1회 (모델 × 데이터셋 × 조건)
uv run python rescore.py                            # 추론 없이 지표만 다시 계산
uv run python report.py > results/REPORT.md         # 표 생성
uv run python score.py                              # 채점 함수 자체 테스트
```
