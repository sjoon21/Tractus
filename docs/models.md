# 모델과 라이선스

## 모델 받기

모델 파일은 저장소에 들어 있지 않습니다. 앱은 왼쪽 아래 `모델` 화면(또는 시작 점검)에서, 터미널은 다음 명령으로 받습니다. 받는 위치는 기본 `~/Library/Application Support/dev.tractus.app/models`입니다(예전에 `~/Tractus/models`에 받았다면 그곳을 그대로 씁니다). 앱의 `모델` 화면 `위치 바꾸기…`나 `tractus models move <폴더>`로 옮기고, `TRACTUS_MODELS_DIR`로도 바꿉니다(`.env.example`을 복사하면 `./models`로 바뀝니다). 받다 끊겨도 같은 명령으로 이어 받습니다. 목록의 원본은 `src/tractus/models_registry.py`입니다.

```bash
uv run tractus models list                          # 설치 상태
uv run tractus models download --preset standard    # required | standard | lite | all, 또는 모델 ID
uv run tractus models remove aligner                # 하나 지우기
```

구성은 `standard`(약 4.6GB, 메모리 16GB 이상), `lite`(약 1.2GB, 메모리 8GB), `required`(1.0~2.5GB, 변환에 꼭 필요한 것만), `all`(약 10GB, 변환 엔진 넷 모두)입니다. 기본 흐름(녹음·가져오기 → 변환 → 요약)은 `required`로 됩니다. 실시간 텍스트 변환(미리보기)은 메모리 16GB 이상에서만 켜지고 가벼운 엔진(`asr-lite`)이 따로 필요하므로, 8GB Mac(`lite` 구성)에서는 쓸 수 없습니다. 변환 엔진(`asr-std`·`asr-lite`·`asr-ko-mix`·`asr-ko-univa`)은 **필수 (엔진 중 하나)** 입니다: 하나만 받아도 텍스트 변환이 되고, 모델 화면에는 `변환 엔진: 설치됨`으로 보입니다.

모델이 없는 기능은 단추를 눌러 보면 이유와 설치 방법을 알려 줍니다. 녹음은 모델 없이 되고, 변환 엔진이 없으면 `변환 대기 중인 녹음`으로 남습니다.

## 모델과 라이선스

Tractus는 모델 가중치를 저장소에 넣지 않습니다. 사용자가 받으며, 모델마다 라이선스가 다릅니다. 앱의 `모델` 화면에 이름, 만든 곳, 라이선스가 있고, 고지 전문은 [NOTICE](../NOTICE)에 있습니다.

| 모델 | 역할 | 크기 | 라이선스 |
| --- | --- | --- | --- |
| [Qwen3-ASR 1.7B (MLX 8bit)](https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit) | 텍스트 변환, 표준 | 2.5GB | Apache-2.0 |
| [Qwen3-ASR 0.6B (MLX 8bit)](https://huggingface.co/mlx-community/Qwen3-ASR-0.6B-8bit) | 텍스트 변환, 저사양·실시간 미리보기 | 1.0GB | Apache-2.0 |
| [Silero VAD v6 (MLX)](https://huggingface.co/mlx-community/silero-vad-v6) | 무음 기준 청크 분할 | 1MB | MIT |
| [Nemotron 3 Diarization (MLX)](https://huggingface.co/mlx-community/Nemotron-3-Diarization) | 참석자 구분 (최대 8명) | 0.2GB | [OpenMDW-1.1](https://openmdw.ai/license/1-1/) |
| [FluidInference/speaker-diarization-coreml](https://huggingface.co/FluidInference/speaker-diarization-coreml) | 9명 이상 참석자 구분 (pyannote community-1의 Core ML 변환) | 22MB + 도우미 | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) (출처 표기 필요) |
| [Qwen3-ForcedAligner 0.6B (MLX 8bit)](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit) | 단어 싱크 | 1.3GB | Apache-2.0 |
| [Qwen3-Embedding 0.6B (MLX 8bit)](https://huggingface.co/mlx-community/Qwen3-Embedding-0.6B-8bit) | 스마트 검색 (비슷한 뜻) | 0.6GB | Apache-2.0 |
| [3D-Speaker CAM++ zh_en](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced) ([ONNX 변환](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models)) | 참석자 목소리 프로필 | 28MB | Apache-2.0 |

변환 엔진(1.7B·0.6B·BuzzASR·한국어 파인튜닝)은 **필수 (엔진 중 하나)** 입니다. 하나만 있어도 텍스트 변환이 됩니다. 1.7B는 가장 정확하고 메모리 16GB 이상을 권하며, 0.6B는 메모리를 덜 쓰고 실시간 미리보기에는 0.6B가 따로 필요합니다. BuzzASR(`asr-ko-mix`)은 영어 용어가 많이 섞인 한국어 대화에 강하고 자주 쓰는 단어를 쓰지 않습니다.

Tractus 자체는 Apache-2.0입니다. 모델의 라이선스와 약관은 각각 따로 확인하세요. 크기와 리비전의 원본은 `src/tractus/models_registry.py`입니다.

<details>
<summary><b>모델을 고른 근거 (Phase 0 측정, 2026-10-02)</b></summary>

개발 기기(Apple M3, 16GB)에서 측정했습니다. 숫자는 낮을수록 좋습니다. 전체 표는 [bench/results/REPORT.md](../bench/results/REPORT.md)에 있습니다.

| 모델 | 한국어 회의 CER | 한·영 혼용 MER | 영어 회의 WER | 1시간 회의 처리 시간 | 피크 메모리 |
| --- | --- | --- | --- | --- | --- |
| Qwen3-ASR-1.7B (표준) | 9.49% | 24.1 | 9.50% | 8.2분 | 3.6 GB |
| Qwen3-ASR-0.6B (저사양) | 11.47% | 26.1 | 10.14% | 3.3분 | 2.0 GB |
| Whisper-large-v3-turbo (대조군, 미채택) | 14.92% | 26.6 | 14.28% | 6.0분 | 2.2 GB |
| Nemotron 3.5 ASR 0.6B (참고, 미채택) | 10.93% | 45.1 | 14.13% | 7.6분 | 2.0 GB |

- CER·시간·메모리는 언어를 고정한 AI Hub 4개 세션, MER은 자동 감지 기준입니다. 메모리는 AI Hub 기준이고 [REPORT.md](../bench/results/REPORT.md)의 최댓값은 0.6B가 2.37GB입니다.
- 언어는 자동 감지가 기본입니다. `Korean`으로 고정하면 영어 위주 말을 번역하거나 반복 루프에 빠졌습니다.
- 자주 쓰는 단어를 `hotwords`로 넣으면 용어 재현율이 72%에서 84%로 올랐습니다.
- 참석자 구분: AI Hub 7명 세션에서 7/7명, DER 7.6%(2026-10-04). 17명 세션은 Nemotron 혼동 28.5%에서 FluidAudio 6.9%로 줄었습니다(2026-10-07). 실제 대면 회의의 9명 이상은 재지 못했습니다.
- 벤치마크 재현: `cd bench && ./setup.sh && ./run_all.sh`. AI Hub 데이터는 재배포가 금지되어 저장소에 없습니다.

</details>

## 오픈소스와 공개 모델

Tractus는 아래 오픈소스와 공개 모델 위에 만들었습니다. 라이선스 고지는 [NOTICE](../NOTICE)에 있습니다.

- [Qwen3-ASR · Qwen3-ForcedAligner · Qwen3-Embedding](https://huggingface.co/Qwen) (Alibaba Qwen 팀): 변환, 단어 싱크, 스마트 검색
- [mlx-audio](https://github.com/Blaizzy/mlx-audio), [MLX](https://github.com/ml-explore/mlx), [mlx-lm](https://github.com/ml-explore/mlx-lm): Apple Silicon에서 모델 실행
- [Silero VAD](https://github.com/snakers4/silero-vad): 목소리 구간 감지
- [NVIDIA Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization): 참석자 구분
- [FluidAudio](https://github.com/FluidInference/FluidAudio), [pyannote community-1](https://huggingface.co/pyannote/speaker-diarization-community-1), [WeSpeaker](https://github.com/wenet-e2e/wespeaker): 9명 이상 참석자 구분
- [3D-Speaker CAM++](https://modelscope.cn/models/iic/speech_campplus_sv_zh_en_16k-common_advanced), [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)(ONNX 변환본), [onnxruntime](https://github.com/microsoft/onnxruntime), [kaldi-native-fbank](https://github.com/csukuangfj/kaldi-native-fbank): 참석자 목소리 프로필
- [SQLite](https://www.sqlite.org), [sqlite-vec](https://github.com/asg017/sqlite-vec): 검색 색인
- [Tauri](https://tauri.app), [React](https://react.dev), [Vite](https://vite.dev), [Tailwind CSS](https://tailwindcss.com): 데스크톱 앱
- [shadcn/ui](https://ui.shadcn.com)(부품 구조), [Lucide](https://lucide.dev)(아이콘), [Magic UI](https://magicui.design)(홈 배경 효과의 동작), [Lobe Icons](https://github.com/lobehub/lobe-icons)(AI 서비스 로고, NOTICE 10번): 화면
- [python-docx](https://github.com/python-openxml/python-docx), [Typer](https://typer.tiangolo.com), [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk), [openai-python](https://github.com/openai/openai-python): 코어
- [Pretendard](https://github.com/orioncactus/pretendard): 앱 글꼴
- 벤치마크 데이터: [FLEURS](https://huggingface.co/datasets/google/fleurs), [HiKE](https://huggingface.co/datasets/thetaone-ai/HiKE), [AMI](https://huggingface.co/datasets/edinburghcstr/ami), [AI Hub 회의 음성](https://www.aihub.or.kr/aihubdata/data/view.do?dataSetSn=464)
- [docs/roadmap.md](roadmap.md)에 설계를 참고한 프로젝트와 라이선스를 적어 두었습니다.
