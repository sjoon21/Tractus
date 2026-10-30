# 설계: 변환 엔진 고르기·바꾸기·직접 추가 (0.4.2)

> 상태: 0.4.2에 들어감 (2026-10-21). 목록은 Qwen3-ASR 둘, Whisper·SenseVoice 계열은 직접 추가. 후보 측정은 BuzzASR까지 하고 멈춤.
> 2026-10-22: BuzzASR을 목록에 넣었다(`asr-ko-mix`, 아래 "BuzzASR 등록").

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
- **TeamUNIVA/qwen3_asr_1.7b_ko**(Qwen3-ASR 1.7B 한국어 파인튜닝, Apache-2.0, bf16)는 간이 점검만 했다(2026-10-30, 스프린트 회의 5분, 같은 청크 11개): 반복 루프는 없고, 언어를 한국어로 고정하면 기본과 비슷하게 나온다(CER 25.4 대 24.1, 기준은 스마트 교정본이라 기본에 유리). **자동 감지에서는 청크의 27%가 영어로 오감지되며 토큰 0개로 비었다.** 그래서 `asr.py`는 자동 감지가 빈 글을 내면 그 청크만 한국어로 다시 변환한다. 숫자·고유명사(`본부장님`, `CMP`)는 나았고 영어 브랜드는 한글로 적는 경향이 있다(`ALMS` → `알류엠에스`). 소유자가 직접 추가해 쓴다(`models add`). FLEURS·HiKE·AI Hub는 재지 않았다.
- ghost613·seastar·SenseVoice는 소유자 요청으로 측정을 멈췄다(14:00). 짧은 합성 음성에서 ghost613은 글자가 깨지고, seastar는 문장 뒤를 지어내고, SenseVoice는 띄어쓰기가 깨졌다.

측정: FLEURS(낭독, CER), HiKE(한·영 혼용, MER), AI Hub 회의(CER, 용어 재현율). 한국어 전용 파인튜닝은 영어 용어를 한글로 적는 경향이 있고, AI Hub 정답도 한글 표기라 AI Hub CER이 좋게 나온다. **HiKE를 같이 본다.** 기준: Qwen3-ASR 1.7B 8bit — AI Hub 9.49(자주 쓰는 단어 넣으면 9.36), FLEURS 2.62.

## BuzzASR 등록 (2026-10-22)

- **왜:** HF에 BuzzASR의 MLX 판이 없어 직접 추가로는 쓸 수 없었다(`BuzzASR/korean`은 transformers 형식). 측정(위 표)에서 한·영 혼용과 영어 용어가 가장 좋았다.
- **어떻게:** `BuzzASR/korean` @ `411b6854`를 mlx-audio 0.5.7 `mlx_audio.convert --quantize --q-bits 8`로 바꿔 소유자 계정 [`voyagar/BuzzASR-korean-mlx-8bit`](https://huggingface.co/voyagar/BuzzASR-korean-mlx-8bit)에 공개로 올렸다(커밋 `b73fdad4`, `model.safetensors` sha256 `51e3f340…5d78`, MIT 원작자 표기와 측정표를 모델 카드에 적음). 다시 바꾼 것이 지난 측정본과 같은지는 FLEURS 50문장으로 봤다: 47개가 글자까지 같고, 나머지 3개는 같은 모델로도 돌릴 때마다 달랐다(Whisper 온도 재시도).
- **목록(v0.5.2):** `asr-ko-univa` = `변환 엔진 (한국어 파인튜닝)`, TeamUNIVA/qwen3_asr_1.7b_ko bf16 4.7GB, 계열 `qwen3`(자주 쓰는 단어 사용), 소유자가 측정 없이 올렸다(CLAUDE.md 면제 기록). 위 간이 점검만 했다.
- **목록:** `asr-ko-mix` = `변환 엔진 (영어 섞인 한국어)`, `required` + `one_of`(직접 추가한 엔진과 같다), 계열 `whisper`(자주 쓰는 단어 없음). 기본 엔진 순서(`pick_asr`)는 그대로라 사용자가 모델 화면의 `변환 엔진` 목록에서 고를 때만 쓴다. 구성: 앱의 표준·저사양·필수에는 넣지 않고, 명령줄 `--preset all`(약 7.3GB)에만 들어간다.
- **확인:** 빈 모델 폴더에서 `tractus models download asr-ko-mix` → `transcribe --engine asr-ko-mix`(가상 `say` 음성): `asr.model`이 이 저장소, 영어 용어·숫자(`30만원`)를 그대로 적었다.
- 바꾸지 않은 것: 실시간 텍스트 변환(0.6B), 자주 쓰는 단어(Whisper 계열은 넣지 않는다, 다시 넣으려면 재서 정한다).


## LFM3-Audio-2B 측정 (2026-10-29, 벤치만)

`LiquidAI/LFM3-Audio-2B-MLX-8bit`(2026-10-27 공개, 커밋 `22d29921`, 가중치 2.33GB + 코덱 0.15GB)를 `bench/`에서만 쟀다. 앱 목록에는 넣지 않는다.

- **어떻게:** mlx-vlm 0.7.11(MIT, `mlx_vlm.models.lfm3_audio`)을 프로세스 안에서 부른다(`bench/asr.py`의 `lfm3` 계열). 모델 카드대로 시스템 프롬프트 `Perform ASR in Korean.`(자동 감지는 `Perform ASR.`), 사용자 글은 비우고 오디오만, 온도 0. 토큰 상한은 앱과 같은 식(오디오 1초당 16 + 32). 자주 쓰는 단어를 넣는 방법이 없어 무시한다.
- **조건:** Apple M3 16GB, 지난 Qwen3 행과 같은 `run.py` 명령(AI Hub 4세션 311.5분, VAD 캐시 같음). 다른 작업(테스트·빌드)이 같은 Mac에서 돌던 중이라 RTF는 ±10% 정도로 본다. mlx-vlm이 `mlx-audio>=0.6.2`·`mlx>=0.32.4`를 요구해 LFM3 행만 mlx-audio 0.6.3·mlx 0.32.4에서 쟀다. 벤치 기본 환경은 앱과 같은 mlx-audio 0.5.7·mlx 0.32.3 그대로이고(`bench/pyproject.toml`의 `app` 그룹), mlx-vlm은 서로 겹치지 않는 `lfm3` 그룹에만 있다. Qwen3 행은 기본 환경에서 잰 그대로다(다시 돌리지 않았다).

| 조건 (AI Hub) | 모델 | CER | 발음전사 CER | 반복 | 용어 재현율 | RTF | 피크 MLX | 최대 RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vad · 언어 고정 | Qwen3-ASR 1.7B | **9.49** | **9.76** | 0 | **71.6%** | 0.136 | 3.63GB | 2.17GB |
| | Qwen3-ASR 0.6B | 11.47 | 10.97 | 0 | 65.3% | **0.055** | 2.00GB | 1.85GB |
| | LFM3-Audio 2B | 17.47 | 18.15 | 2 | 50.5% | 0.132 | 2.69GB | 0.80GB |
| vad · 자동 감지 | Qwen3-ASR 1.7B | **9.48** | **9.75** | 0 | 70.5% | 0.131 | 3.63GB | 2.53GB |
| | LFM3-Audio 2B | 17.38 | 18.05 | 0 | 48.4% | 0.119 | 2.70GB | 1.67GB |
| label · 언어 고정 | Qwen3-ASR 1.7B | **9.34** | **9.67** | 0 | 65.3% | 0.145 | 3.63GB | 1.14GB |
| | LFM3-Audio 2B | 17.48 | 18.14 | 2 | 54.7% | 0.119 | 2.71GB | 1.18GB |
| utt · 언어 고정 | Qwen3-ASR 1.7B | **9.45** | **9.27** | 0 | 68.4% | 0.170 | 3.40GB | 1.27GB |
| | LFM3-Audio 2B | 18.58 | 19.16 | 2 | 53.7% | 0.148 | 2.56GB | 1.26GB |

| HiKE (한·영 혼용) | 모델 | MER 전체 (고정 / 자동) | PIER (고정 / 자동) | 반복 루프 | RTF (고정) | 피크 MLX |
| --- | --- | --- | --- | --- | --- | --- |
| | Qwen3-ASR 1.7B | 28.3 / **24.1** | **35.4** / 36.1 | 2 / 1 | 0.129 | 3.53GB |
| | LFM3-Audio 2B | 32.7 / 35.2 | 46.2 / 51.8 | 1 / 0 | 0.114 | 2.60GB |

- **판정: 쓰지 않는다.** 회의 CER이 어느 자르기·언어 조건에서도 Qwen3 1.7B의 거의 두 배(17.4–18.6 대 9.3–9.5)이고 0.6B(11.5)보다도 나쁘다. 세션별로도 모두 나쁘다(고정·vad: 20.0 / 20.9 / 15.5 / 12.5 대 11.5 / 12.0 / 7.3 / 6.5). 틀린 글자는 대부분 바꿔 적기(치환 8–13%, Qwen3 3–7%)이고, 세션마다 한자·가나가 섞인다(고정·vad 7–19글자, 자동 감지에서는 최대 37글자. Qwen3는 0). 잘리거나 반복이 늘어서 나쁜 것이 아니다. 영어 용어 재현율도 50% 안팎으로 낮고, 한·영 혼용(HiKE)도 나쁘다.
- 장점은 메모리뿐이다: 피크 MLX가 1.7B보다 약 0.9GB 적다. 속도는 1.7B와 비슷하다(RTF 0.12–0.15). 0.6B보다 2배 이상 느리고 정확도도 낮다.
- **막는 것 (품질과 별개):**
  - 라이선스: LFM Open License v1.0은 연 매출 1천만 달러 이상인 회사의 상업 사용을 허락하지 않는다. 앱 기본 목록에 넣기 어렵다.
  - 자주 쓰는 단어(hotwords)를 넣는 방법이 문서에 없다. Qwen3에서 용어 재현율을 72% → 84%로 올린 수단을 잃는다.
  - 의존성: mlx-vlm이 opencv-python(약 120MB)·fastapi·uvicorn·starlette·datasets·aiohttp·cryptography·llguidance 등 31개 패키지를 끌어온다(벤치 `uv.lock` 기준). 앱 번들을 늘리고 `scripts/bundle_modules.txt`를 다시 만들어야 한다. mlx-audio도 0.6.x로 올려야 한다.
  - 실시간: 모델 카드의 LiveASR(스트리밍)은 영어만이라 실시간 텍스트 변환(0.6B)을 대신할 수 없다.
- 다시 볼 때: 한국어 파인튜닝판이 나오거나 라이선스가 바뀌면 같은 `run.py` 명령으로 다시 잰다(`uv run --no-default-groups --group lfm3 python run.py lfm3-audio-2b aihub --lang fixed`).
