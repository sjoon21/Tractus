# 설계: 변환 엔진 고르기·바꾸기·직접 추가 (0.4.2)

> 상태: 0.4.2에 들어감 (2026-10-21). 목록은 Qwen3-ASR 둘, Whisper·SenseVoice 계열은 직접 추가. 후보 측정은 BuzzASR까지 하고 멈춤.

## 한 줄 요약

받아 적기 모델(변환 엔진)을 앱 안에서 고르고, 새 모델을 받아 바꾸고, 쓰지 않는 모델을 지운다. 목록에 없는 모델도 Hugging Face 저장소 ID로 직접 추가한다. 로컬 모델을 쓰는 이점을 살리는 기능이다.

## 왜 하나

- 좋은 모델이 계속 나온다. 지금은 모델을 바꾸려면 코드를 고치고 앱을 새로 내야 한다. 받아 적는 코드가 Qwen3-ASR 두 개(1.7B·0.6B)에 묶여 있고, 앱에는 엔진을 고르는 설정이 없다(메모리로 자동 결정).
- 한국어 데이터로 파인튜닝한 모델이 회의 받아쓰기에서 어떤지 직접 재 보고 싶다(소유자, 2026-10-21). Qwen3-ASR은 한국어를 학습했지만 한국어 특화는 아니다.

## 결정 (2026-10-21)

1. **등록 목록 + 직접 추가.** 앱이 측정한 엔진 목록과 함께, 사용자가 HF 저장소 ID로 지원 계열(Qwen3-ASR·Whisper·SenseVoice)의 모델을 추가한다. 받은 뒤 `config.json`의 `model_type`으로 계열을 확인한다.
2. **라이선스 표기가 없는 모델도 측정 결과가 좋으면 목록에 넣는다. 경고 문구를 붙이지 않는다.** 사용자가 자기 Mac에 받아 자기가 쓰는 모델이고 앱은 돈을 받지 않는다(소유자). 모델 정보의 `라이선스` 칸은 다른 모델과 같은 자리에 사실대로 적는다(`표기 없음`).
3. **엔진을 바꾸지 않는 것:** 실시간 텍스트 변환은 Qwen3-ASR 0.6B 그대로다(지연 측정 기준이 그 모델이다). 단어 싱크(Qwen3-ForcedAligner)는 띄어쓰기가 있는 출력이면 엔진과 상관없이 돈다.
4. **새 엔진은 `bench/`로 잰 뒤에 목록에 넣는다**(CLAUDE.md 규칙). 직접 추가는 사용자의 선택이라 측정을 요구하지 않는다.

## 구조

**계열(Engine) 어댑터 (`asr.py`).** 계열마다 다른 것만 나눈다.

| 계열 | `model_type` | 자주 쓰는 단어 | 짧은 청크 오감지 재시도 | 토큰 상한 | 호출 |
| --- | --- | --- | --- | --- | --- |
| `qwen3` | `qwen3_asr` | 넣음(안전장치 포함) | 중국어·일본어 → 한국어 | 씀 | `language=Korean`, `hotwords`, `max_tokens` |
| `whisper` | `whisper` | **넣지 않음**(Phase 0: 영어 용어 프롬프트로 CER 16.7 → 58.3. 한국어 파인튜닝판은 측정 후 다시 본다) | 없음 | 안 씀 | `language=ko`, `condition_on_previous_text=False`(청크마다 따로) |
| `sensevoice` | `sensevoice` | 없음(CTC) | 없음 | 안 씀 | `language=ko|auto`, `use_itn=True` |

반복 루프 감지·자동 감지 재시도·온도 0.3 재시도·접기는 공통이다. 모르는 `model_type`은 오류로 막는다(조용히 Qwen처럼 부르지 않는다).

**모델 목록 (`models_registry.py`).** `Model.engine`(계열)을 더했다. 변환 기능의 "하나면 되는 모델"은 `engine`이 있는 모델 전체다(`asr_ids()`). 기본 두 엔진(`asr-std`·`asr-lite`)은 그대로이고, 엔진을 정하지 않았을 때는 메모리가 권하는 기본 엔진 → 다른 기본 엔진 → 받아 둔 다른 엔진 순으로 고른다(`pick_asr`).

**고르기 (`cli.py`).** `transcribe --engine <모델 ID>`가 `--track`보다 우선한다. 받아 두지 않은 엔진이면 경고 `asr_engine_missing` 뒤 기본 엔진으로 변환한다. 작업(`.job.json`)과 `transcript.json`의 `asr`에 `engine`(계열)을 남긴다. `track`은 기본 두 엔진이면 `standard`·`lite`(예전과 같음), 나머지는 모델 ID다.

## 단계

1. **코어 엔진 구조** (이 브랜치): 어댑터, `engine` 칸, `--engine`. ✅
2. **후보 측정**: 아래 표. 측정 결과로 목록에 넣을 엔진을 정한다.
3. **직접 추가 (코어)**: `tractus models add <저장소> [--revision]` → HF API로 파일·크기를 읽어 `<모델 폴더>/custom-models.json`에 등록(ID `custom-…`), 받기는 기존 `models download`. 정리(`prune`)는 등록된 직접 추가 모델을 지우지 않는다. 지우면 목록에서도 뺀다.
4. **앱**: 설정 › 모델의 `변환 엔진` 구역(엔진마다 받기 · `기본으로` · 지우기, 사용 중 표시), `직접 추가`(저장소 ID 입력), 설정 `asr_engine`(`patch_settings`) → 변환할 때 `--engine`.
5. 문서·문구(WORDS.md, docs/desktop.md §2.15, ARCHITECTURE.md), 0.4.2 릴리스.

## 후보 (2026-10-21 조사, 측정 중)

| 후보 | 계열 | 라이선스 | 비고 |
| --- | --- | --- | --- |
| BuzzASR/korean | whisper large-v3 | MIT | FLEURS·Common Voice 한국어 전용 파인튜닝 |
| Sorimac/Sorimac-V2.1-Korean-1.7B-MLX-8bit | qwen3 | 표기 없음 | Qwen3-ASR 1.7B 한국어 파인튜닝, 지금 코드 그대로 |
| ghost613/whisper-large-v3-turbo-korean | whisper turbo | 표기 없음 | Zeroth(낭독 뉴스) |
| seastar105/whisper-medium-komixv2 | whisper medium | 표기 없음 | AI Hub 회의 데이터로 학습해 **우리 AI Hub 측정이 오염된다**. FLEURS·HiKE로 판단 |
| mlx-community/SenseVoiceSmall | sensevoice | FunASR Model License 1.1 | 234M, 아주 빠름, 자주 쓰는 단어 없음 |

제외: wav2vec2 계열(영어를 못 적음), NeMo·SpeechBrain 계열(mlx-audio 미지원), SKT A.X-K2(가중치 미공개).

### 측정 결과 (2026-10-21, Apple M3 16GB, `bench/`, 자주 쓰는 단어 없이, 앱의 반복 재시도 없이 = 지난 기준선과 같은 조건)

| 엔진 | FLEURS CER | HiKE MER (전체) | AI Hub CER | AI Hub 용어 재현율 | RTF (1시간 처리) | 최대 메모리 |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-ASR 1.7B 8bit (기본) | **2.62** | 28.3 | **9.49** | 71.6% (단어 넣으면 84.2%) | 0.136 (8.2분) | 3.6GB |
| Whisper large-v3-turbo (Phase 0) | 3.08 | 27.7 | 14.92 | 87.4% | 0.100 (6.0분) | 2.2GB |
| **BuzzASR/korean** (large-v3 한국어 파인튜닝, 8bit 변환) | 4.02 | **22.8** (반복 6) | 10.29 | **86.3%** | 0.169 (10.1분) | 2.3GB |
| Sorimac V2.1 1.7B (Qwen3 한국어 파인튜닝) | 4.71 | 315 (반복 7) | 114.4 (반복 11) | 13.7% | 0.225 | 3.9GB |

- **Sorimac은 탈락.** 회의와 한·영 혼용에서 반복 루프에 빠져 무너진다.
- **BuzzASR은 쓸 만한 대안.** 회의 CER은 기본보다 0.8%p 나쁘지만, 영어 용어를 자주 쓰는 단어 없이도 86% 맞히고(기본은 단어를 넣어야 84%) 한·영 혼용은 가장 좋다. 메모리는 1.3GB 덜 쓰고 속도는 25% 느리다. 낭독(FLEURS)은 나쁘다.
- ghost613·seastar·SenseVoice는 소유자 요청으로 측정을 멈췄다(14:00). 짧은 합성 음성에서 ghost613은 글자가 깨지고, seastar는 문장 뒤를 지어내고, SenseVoice는 띄어쓰기가 깨졌다.

측정: FLEURS(낭독, CER), HiKE(한·영 혼용, MER), AI Hub 회의(CER, 용어 재현율). 한국어 전용 파인튜닝은 영어 용어를 한글로 적는 경향이 있고, AI Hub 정답도 한글 표기라 AI Hub CER이 좋게 나온다. **HiKE를 같이 본다.** 기준: Qwen3-ASR 1.7B 8bit — AI Hub 9.49(자주 쓰는 단어 넣으면 9.36), FLEURS 2.62.
