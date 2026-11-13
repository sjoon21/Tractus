<a id="readme-top"></a>

<div align="center">

<img src="docs/images/icon.png" alt="Tractus" width="112" height="112">

# Tractus

**음성 녹음과 메모를 온디바이스(로컬)에서 텍스트로 변환하고, 요약·검색·AI 질의응답까지 지원하는 로컬 우선 AI 노트 앱**

오디오 데이터는 로컬 환경에만 안전하게 보관되며, 모든 노트는 파일 시스템에 직접 소유할 수 있는 파일로 저장됩니다.

[![Release][release-shield]][release-url] [![License][license-shield]][license-url] [![macOS][macos-shield]][setup-url] [![Local-first][local-shield]][how-url]

[English](README.md) · **한국어**

[**다운로드**](https://github.com/sjoon21/Tractus/releases/latest) · [웹사이트](https://sjoon21.github.io/Tractus/ko/) · [설치 안내](docs/setup.md) · [사용법](docs/usage.md) · [동작 방식](docs/how-it-works.md) · [로드맵](docs/roadmap.md)

<br>

<img src="docs/images/demo.gif" alt="데모: 녹음 노트의 메모 탭에서 노트 완성을 누르면 내 메모에 대화 내용의 세부가 붙고, Claude Code에서 같은 회의를 물으면 노트 제목과 시각을 인용해 답한다" width="100%">

<sub>녹음 노트 → <b>노트 완성</b>(내 메모 + 대화 내용) → Claude Code에서 <b>내 회의 물어보기</b> (가상 회의 데이터)</sub>

</div>

## 핵심 특징

- 🔒 **100% 로컬 처리 제공** — 음성 녹음, 텍스트 변환(STT), 화자 분리, 벡터 검색이 Apple Silicon 온디바이스(MLX)에서 직접 실행되며, 오디오 데이터를 외부 서버로 전송하지 않습니다.
- 📁 **로컬 파일 기반 저장** — 모든 노트는 `~/Tractus/meetings/` 내의 표준 파일(오디오·JSON·Markdown·자막)로 관리되어 사용자가 데이터를 온전히 소유하며, Obsidian 등 원하는 도구와 자유롭게 연동됩니다.
- 🧾 **타임스탬프 연동 요약** — 회의 결정 사항 및 액션 아이템마다 원본 대화 타임스탬프가 링크되어, 클릭 한 번으로 해당 오디오 구간을 즉시 다시 들을 수 있습니다.
- 🇰🇷 **한국어 회의에 강한 음성 인식** — 실제 회의 녹음으로 직접 재 보니 Qwen3-ASR-1.7B가 Whisper-large-v3-turbo보다 글자 오류가 36% 적었고(CER 9.49 vs 14.92), 1시간 녹음을 8.2분에 받아 적었습니다 (M3 · 16GB, [벤치마크](docs/benchmark.md)).
- 🤖 **AI 에이전트 연동 (MCP 지원)** — Model Context Protocol(MCP) 서버를 기본 내장하여 Claude Code, Codex, Antigravity 등의 AI 에이전트가 로컬 노트를 직접 검색하고 인용할 수 있습니다.

## 주요 기능

- **유연한 음성 녹음** — 대면 마이크 녹음, 화상 회의 시스템 오디오 캡처, 녹음 일시정지, 실시간 메모 및 북마크, 메뉴바 빠른 녹음
- **온디바이스 음성 인식(STT)** — Apple MLX 기반 Qwen3-ASR 모델로 한국어·영어 자동 감지, 오디오 및 동영상 파일 드래그 앤 드롭 변환
- **화자 분리 및 식별 (Diarization)** — 음성 특징 기반 화자 분리 및 프로필 등록을 통한 화자 자동 인식/제안
- **단어 단위 오디오 싱크 (Word-level Alignment)** — 재생 중인 단어 실시간 하이라이트 및 단어 클릭 시 해당 위치 즉시 탐색/재생
- **다양한 AI 요약** — 회의록, 핵심 요약, 할 일 중심 등 6가지 기본 템플릿 및 사용자 정의(커스텀) 프롬프트 요약 지원
- **AI 질의응답 (Q&A)** — 단일 노트 또는 전체 노트를 대상으로 한 자연어 질의응답 및 원본 발화 타임스탬프 근거 제공
- **하이브리드 검색** — 키워드 정확 일치(BM25/FTS5) 및 시맨틱 벡터 유사도 결합 검색 (⌘K)
- **정리 및 내보내기** — 즐겨찾기, 태그, 폴더 관리 / TXT, MD, SRT, VTT, CSV, DOCX, PDF 및 전체 백업(ZIP) 지원, Obsidian 볼트로 보내기
- **캘린더 연동** — macOS 캘린더의 곧 시작하는 일정을 홈에 보여 주고, 일정 제목과 참석자 이름으로 바로 녹음
- **네이티브 UI/UX** — 라이트·다크 모드, 한국어·영어 화면, macOS 네이티브 인터페이스, 인앱 자동 업데이트

## 스크린샷

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/note-dark.png">
  <img src="docs/images/note-light.png" alt="노트 화면: 화자별 대화 내용과 타임스탬프가 연동된 요약" width="100%">
</picture>

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
        <img src="docs/images/home-light.png" alt="홈: 곧 시작하는 일정, 이번 주, 최근 노트">
      </picture>
      <p align="center"><b>홈</b> — 곧 시작하는 일정, 이번 주, 최근 노트</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/ask-dark.png">
        <img src="docs/images/ask-light.png" alt="AI 질의응답: 근거 타임스탬프가 연동된 답변">
      </picture>
      <p align="center"><b>AI 질의응답</b> — 답변마다 원본 대화 타임스탬프 근거 제공</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/record-dark.png">
        <img src="docs/images/record-light.png" alt="녹음 화면">
      </picture>
      <p align="center"><b>녹음</b> — 흐르는 파형, 북마크, 타임스탬프 메모</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
        <img src="docs/images/settings-light.png" alt="설정 화면">
      </picture>
      <p align="center"><b>설정</b> — 테마, 녹음, AI 서비스 및 모델 설정</p>
    </td>
  </tr>
</table>

> 스크린샷은 가상 회의 데이터로 생성되었습니다.

## 빠른 시작

1. [릴리스](https://github.com/sjoon21/Tractus/releases/latest)에서 `Tractus-…-arm64.dmg`를 다운로드하여 `Tractus.app`을 `Applications` 폴더로 끌어다 놓습니다.
2. 터미널에서 ffmpeg를 설치합니다.
   ```bash
   brew install ffmpeg
   ```
3. 앱을 실행하면 **초기 설정 마법사(Setup Doctor)**가 온디바이스 모델 다운로드 및 AI 서비스 설정을 안내합니다.

> [!NOTE]
> 아직 Apple 서명 및 공증을 받지 않은 빌드입니다. 처음 실행 시 "확인되지 않은 개발자" 경고가 나타나면 시스템 설정 › 개인정보 보호 및 보안 › `그래도 열기`를 클릭하세요. 소스 코드 직접 빌드 방법과 문제 해결은 [설치 안내](docs/setup.md)에서 확인할 수 있습니다.

**요구 사양:** Apple Silicon(M1 이상), macOS 14.4 이상, 권장 메모리 16GB (8GB 환경은 경량 구성 권장)

### Claude Code에서 내 회의 물어보기

앱을 설치했다면 Claude Code에 플러그인 하나만 추가하면 됩니다. 경로·환경변수를 따로 설정할 필요가 없습니다.

```
/plugin install tractus --marketplace sjoon21/Tractus
```

```text
> 지난주 회의에서 정한 릴리스 날짜가 언제였지?
릴리스는 10월 22일로 확정했습니다. 결제 이슈와 QA 기간 부족으로 일주일 미뤘습니다. (주간 개발 회의, 00:02:11)
```

검색·요약·할 일 도구(MCP)와 회의 기억 스킬, `/tractus:recap 지난주`(기간 회고)가 들어 있습니다. 노트는 이 Mac에 있고, Claude가 읽는 내용만 Claude로 전달됩니다. 자세한 내용은 [에이전트 연동](docs/mcp.md)을 참고하세요.

## 데이터 처리 및 프라이버시 정책

| 데이터 구분 | 처리 및 저장 위치 |
| --- | --- |
| 음성 오디오, 화자 음성 프로필 | 로컬 기기 내에서만 처리 및 보관 (외부 전송 없음) |
| 노트 원본, 메타데이터, 검색 색인 | 로컬 파일 시스템(`~/Tractus/meetings/`) 및 SQLite DB |
| 요약 및 AI 질문 요청 | 사용자가 설정한 AI 서비스로 필요한 텍스트만 전송 (Upstage·OpenAI·Claude·Gemini·OpenAI 호환 API) |

외부 AI 서비스 API 키가 없어도 녹음, 음성 인식(STT), 화자 분리, 로컬 검색, 파일 내보내기 등 핵심 기능은 온디바이스에서 완전히 동작합니다. 자세한 데이터 흐름은 [동작 방식](docs/how-it-works.md#무엇이-이-mac에-남고-무엇이-나가는가)에서 확인하실 수 있습니다.

## 자주 묻는 질문

<details><summary><strong>"확인되지 않은 개발자"라고 나옵니다. 괜찮은가요?</strong></summary>

<br>

> Tractus는 개인 오픈소스 프로젝트라 Apple 서명·공증(유료 개발자 계정 필요)을 받지 않았습니다. Releases의 DMG는 이 저장소에서 만들고, 릴리스마다 SHA-256 체크섬을 함께 올립니다. 처음 열 때 시스템 설정 › 개인정보 보호 및 보안에서 `그래도 열기`를 누르거나 `xattr -dr com.apple.quarantine /Applications/Tractus.app`을 실행하세요. 앱 안 업데이트는 프로젝트의 업데이트 키로 서명돼 있고 설치 전에 검사합니다.

</details>

<details><summary><strong>인터넷 없이, AI 키 없이도 쓸 수 있나요?</strong></summary>

<br>

> 네. 녹음, 텍스트 변환, 참석자 구분, 단어 싱크, 검색, 내보내기는 모두 Mac에서 돌고 모델을 받은 뒤에는 인터넷 없이 됩니다. 요약·회의록·노트 완성·AI 질문만 AI 서비스가 필요하고, 이것도 내 Mac에서 도는 모델(Ollama·LM Studio 같은 OpenAI 호환 서버)로 돌릴 수 있습니다.

</details>

<details><summary><strong>얼마나 받고, 메모리는 얼마나 필요한가요?</strong></summary>

<br>

> 저사양 구성은 모델 약 1.2GB에 메모리 8GB로 돕니다. 표준 구성(가장 정확한 변환, 참석자, 단어 싱크, 스마트 검색)은 약 4.6GB이고 메모리 16GB를 권합니다. 전부 받으면 약 5.7GB입니다. 앱 DMG는 166MB입니다. 변환 엔진 하나로 시작해 나머지는 모델 화면에서 나중에 받아도 됩니다.

</details>

<details><summary><strong>회의에 봇이 들어가나요?</strong></summary> <!-- words-ok -->

<br>

> 아니요. Tractus는 내 마이크와, 화상 통화라면 Mac에서 나오는 소리(시스템 소리)를 녹음합니다. 녹음한다는 것을 다른 분들께 알려 주세요.

</details>

<details><summary><strong>노트와 녹음은 어디에 있나요?</strong></summary>

<br>

> `~/Tractus/meetings/` 아래 노트마다 폴더 하나입니다: 압축한 오디오, `transcript.json`, Markdown, 자막, 요약. 모델은 따로 고르지 않으면 앱 설정 폴더(`~/Library/Application Support/dev.tractus.app/models`)에 있습니다. API 키는 같은 폴더의 서비스별 파일(권한 `0600`)에만 두고 노트 폴더에는 두지 않습니다.

</details>

<details><summary><strong>AI 에이전트(MCP)는 무엇을 보고 할 수 있나요?</strong></summary>

<br>

> MCP 서버와 Claude Code 플러그인은 내 Mac에서 돌고 노트 폴더만 읽습니다. 도구 여섯 개는 읽기만 하고(상태, 검색, 목록, 대화 내용, 요약, 할 일), `save_summary` 하나만 검사를 거쳐 요약을 저장합니다. MCP 서버는 AI 모델을 부르지 않고 API 키도 받지 않습니다. 에이전트가 읽은 내용은 그 에이전트의 AI 서비스로 갈 수 있습니다.

</details>

<details><summary><strong>어떤 언어를 알아듣나요?</strong></summary>

<br>

> 변환 엔진이 언어를 스스로 알아내고 한국어, 영어, 섞어 쓴 말을 잘 받아 적습니다. 중국어·일본어 등 Qwen3-ASR이 지원하는 다른 언어도 됩니다. 제품 이름·사람 이름은 사전에 넣으면 더 정확해집니다. 앱 화면은 한국어와 영어입니다.

</details>

<details><summary><strong>Windows나 Intel Mac에서도 되나요?</strong></summary>

<br>

> 아직은 아닙니다. 기기 안 모델이 Apple Silicon(MLX)에서 돕니다. Windows 지원은 시작했고 단계적으로 나옵니다. [로드맵](docs/roadmap.md)을 보세요.

</details>

## 문서

| 문서 | 내용 |
| --- | --- |
| [설치 안내](docs/setup.md) | 설치 프로그램 배포판, 소스 빌드, 시스템 권한, 자동 업데이트, 문제 해결 |
| [사용법](docs/usage.md) | 노트 생성, 화자 관리 및 대화 편집, 요약·AI 질의응답, 단축키 |
| [AI 서비스와 키](docs/ai-services.md) | AI 서비스 설정, 서비스별 기본 모델, 검색 임베딩 설정 |
| [모델과 라이선스](docs/models.md) | 모델 다운로드, 모델 목록 및 라이선스, 기술 선정 근거 |
| [CLI](docs/cli.md) | 터미널 CLI 도구(변환·요약·질문·검색·내보내기) 사용법 |
| [음성 인식 벤치마크](docs/benchmark.md) | Mac에서 한국어 회의를 받아 적는 모델 비교 (Qwen3-ASR · Whisper · Nemotron) |
| [에이전트 연동 (MCP)](docs/mcp.md) | Claude Code 플러그인, Codex·Antigravity 연동 설정 및 제공 도구(7개) 안내 |
| [동작 방식](docs/how-it-works.md) | 시스템 구성 아키텍처, 로컬 처리 및 외부 전송 데이터 흐름 |
| [아키텍처](ARCHITECTURE.md) | 설계 결정 사유, 변경 이력, 벤치마크 결과 |
| [앱 계약](docs/desktop.md) · [디자인 지침](app/DESIGN.md) | 데스크톱 앱과 코어 간 인터페이스 계약, 화면 UI/UX 규칙 |
| [로드맵](docs/roadmap.md) | 개발 로드맵, 진행 현황 및 알려진 한계점 |
| [기여 안내](CONTRIBUTING.md) | 개발 환경 구축, 테스트 실행, 커밋 및 기여 규칙 |

## 기술 스택 (Tech Stack)

[![Python][python-badge]][python-url] [![MLX][mlx-badge]][mlx-url] [![Tauri][tauri-badge]][tauri-url] [![React][react-badge]][react-url] [![Tailwind][tailwind-badge]][tailwind-url] [![Swift][swift-badge]][swift-url] [![SQLite][sqlite-badge]][sqlite-url] [![MCP][mcp-badge]][mcp-url]

코어 CLI 및 파이프라인은 Python, 온디바이스 모델 추론(음성 인식·화자 분리·임베딩)은 Apple MLX, 데스크톱 앱은 Tauri 2(Rust + React), 시스템 오디오 캡처 모듈은 Swift로 구현되었습니다. 세부 아키텍처는 [동작 방식](docs/how-it-works.md)을 참조하세요.

## 기여 및 문의

버그 리포트, 기능 제안, 문의 사항은 [GitHub Issues](https://github.com/sjoon21/Tractus/issues)에 남겨 주세요. 코드 기여를 원하시는 분은 [기여 안내](CONTRIBUTING.md)를 먼저 확인해 주시기 바랍니다.

## 라이선스

본 프로젝트는 [Apache License 2.0](LICENSE) 라이선스를 따릅니다. 포함된 각 AI 모델의 개별 라이선스 및 고지 사항은 [NOTICE](NOTICE) 및 [모델과 라이선스](docs/models.md)를 참조하세요.

<p align="right"><a href="#readme-top">맨 위로 ↑</a></p>

[release-shield]: https://img.shields.io/github/v/release/sjoon21/Tractus?style=for-the-badge&color=blue
[release-url]: https://github.com/sjoon21/Tractus/releases/latest
[license-shield]: https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge
[license-url]: LICENSE
[macos-shield]: https://img.shields.io/badge/macOS-Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white
[setup-url]: docs/setup.md
[local-shield]: https://img.shields.io/badge/local--first-audio_stays_on_Mac-2ea44f?style=for-the-badge
[how-url]: docs/how-it-works.md
[python-badge]: https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white
[python-url]: https://www.python.org
[mlx-badge]: https://img.shields.io/badge/MLX-000000?style=flat&logo=apple&logoColor=white
[mlx-url]: https://github.com/ml-explore/mlx
[tauri-badge]: https://img.shields.io/badge/Tauri_2-24C8D8?style=flat&logo=tauri&logoColor=white
[tauri-url]: https://tauri.app
[react-badge]: https://img.shields.io/badge/React-149ECA?style=flat&logo=react&logoColor=white
[react-url]: https://react.dev
[tailwind-badge]: https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat&logo=tailwindcss&logoColor=white
[tailwind-url]: https://tailwindcss.com
[swift-badge]: https://img.shields.io/badge/Swift-F05138?style=flat&logo=swift&logoColor=white
[swift-url]: https://www.swift.org
[sqlite-badge]: https://img.shields.io/badge/SQLite-003B57?style=flat&logo=sqlite&logoColor=white
[sqlite-url]: https://www.sqlite.org
[mcp-badge]: https://img.shields.io/badge/MCP-111111?style=flat
[mcp-url]: https://modelcontextprotocol.io
