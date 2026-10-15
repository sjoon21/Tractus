# CLI 빠른 참조

앱 없이 터미널만으로도 변환, 요약, 질문, 검색, 내보내기를 할 수 있습니다. 노트는 `meeting_id`의 앞부분만 써도 찾습니다(아래 `01K6X3`). 전체 옵션은 `uv run tractus <명령> --help`입니다.

```bash
uv run tractus transcribe 주간회의.m4a --title "3분기 예산 회의" -t 김철수 -t "Project Atlas"
uv run tractus transcribe 회의.m4a --append-to 01K6X3     # 글만 있는 노트에 녹음 추가
uv run tractus recording finish ~/Tractus/recordings/01K… # 녹음만 저장 ("변환 전" 노트, 변환은 나중에)
uv run tractus transcribe --into 01K6X3                    # 변환 전 노트를 그 자리에서 텍스트로 변환
uv run tractus doctor                                      # 시스템·도구·모델·기능 점검 (--json)
uv run tractus models list                                 # 모델 설치 상태 (download · remove)
uv run tractus summarize 01K6X3                            # 회의록 요약
uv run tractus summarize 01K6X3 --template brief           # todo | lecture | interview | ideas, templates list로 확인
echo "GPU 서버 구매는 어떻게 하기로 했어?" | uv run tractus ask --meeting 01K6X3
uv run tractus search "GPU 서버 구매" --from 2026-07-01 --to 2026-09-30
uv run tractus export 01K6X3 --format docx --out 주간회의.docx   # txt | md | srt | vtt | csv | docx | bundle
uv run tractus note new --title "장보기"                   # 메모 노트 (save · title · meta)
uv run tractus render --all                                # transcript.md·vtt를 다시 만듭니다
```

<details>
<summary><b>더 보기: 변환 옵션, 참석자, 목소리, 정리 명령</b></summary>

| `transcribe` 옵션 | 설명 |
| --- | --- |
| `--track standard\|lite` | 생략하면 메모리 16GB 이상이면 `standard`(1.7B), 아니면 `lite`(0.6B) |
| `--language auto\|ko\|en` | 기본 `auto`. `ko`로 고정하면 영어 위주 말을 번역할 수 있어 권장하지 않습니다 |
| `-t`, `--term` | 이 노트의 용어(참석자 이름, 제품명). 여러 번 지정할 수 있습니다 |
| `--recording <폴더>` | `tractus-rec` 녹음 폴더를 변환(마이크·시스템 트랙을 섞음). `--keep-tracks`면 원본 트랙을 보관 |
| `--into <노트>` | `tractus recording finish`로 저장해 둔 "변환 전" 노트를 그 자리에서 변환합니다. 제목·메모·태그·폴더는 그대로이고, 변환이 끝나면 원본 트랙(`tracks/`)을 지웁니다(`--keep-tracks`면 보관). 중단돼도 같은 명령으로 이어서 합니다 |
| `--no-diarize`, `--max-speakers N` | 참석자 구분을 끄거나 상한을 둡니다 |
| `--diarizer auto\|nemotron\|fluid` | 기본 `auto`: Nemotron으로 나누고 8명을 모두 쓰면 `tractus-diar`로 다시 나눕니다 |
| `--no-align` | 단어 싱크를 만들지 않습니다 (나중에 `tractus align <노트>`) |

```bash
uv run tractus speakers 01K6X3 list                  # rename S1 "김민수" | set s0012 S2 | merge S3 S1 | dismiss S2
uv run tractus voices enroll 01K6X3 S1 --name "홍길동" --consent   # 목소리 등록 (list · match · forget)
echo '{"edits":[{"id":"s0012","text":"새 문장"}]}' | uv run tractus segments 01K6X3 edit
uv run tractus glossary add 쿠버네티스 "Project Atlas"   # 자주 쓰는 단어: ~/Tractus/glossary.md
echo '{"favorite": true, "tags": ["회의", "Q3"]}' | uv run tractus note meta 01K6X3
uv run tractus folders create --name 업무                # list | rename | move | delete
uv run tractus notes list --tag Q3 --sort title --order asc --json
uv run tractus search 예산 --tag Q3 --folder 업무
uv run tractus index --rebuild                            # 검색 색인을 처음부터 다시
echo '{"prompt": "결정은 번호를 붙여 정리해줘", "save_as": "결정"}' | uv run tractus summarize 01K6X3 --custom
uv run tractus live --recording ~/Tractus/recordings/01K… --progress-json   # 녹음 중 미리보기 (저장하지 않음)
```

- 이어하기: 중간에 멈춰도 같은 `transcribe` 명령을 다시 실행하면 끝난 청크 다음부터 이어갑니다.
- 목소리 등록에는 `--consent`가 필요합니다. 등록한 목소리는 `~/Tractus/voices.json`(권한 0600)에만 저장되고 Mac 밖으로 나가지 않습니다.
- `S1`·`S2` 같은 라벨은 CLI·JSON·MCP에서 그대로 쓰고, 앱과 내보낸 문서에서는 `참석자 1`로 보입니다.
- 노트 한 건의 폴더 구조는 [ARCHITECTURE.md](../ARCHITECTURE.md) §4.1, JSON 스키마는 §6, 앱과 코어의 계약은 [docs/desktop.md](desktop.md)에 있습니다.

</details>
