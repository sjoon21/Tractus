<a id="readme-top"></a>

<div align="center">

<img src="docs/images/icon.png" alt="Tractus" width="112" height="112">

# Tractus

**녹음과 메모를 내 Mac 안에서 텍스트로 바꾸고, 요약·검색·AI 질문까지 하는 노트 앱**

오디오는 Mac을 떠나지 않습니다. 노트는 내 폴더의 파일로 남습니다.

[![Release][release-shield]][release-url] [![License][license-shield]][license-url] [![macOS][macos-shield]][setup-url] [![Local-first][local-shield]][how-url]

[**다운로드**](https://github.com/sjoon21/Tractus/releases/latest) · [설치 안내](docs/setup.md) · [사용법](docs/usage.md) · [동작 방식](docs/how-it-works.md) · [로드맵](docs/roadmap.md)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/note-dark.png">
  <img src="docs/images/note-light.png" alt="노트 화면: 참석자별 대화 내용과 근거가 달린 요약" width="100%">
</picture>

</div>

## 왜 Tractus인가

- 🔒 **오디오는 이 Mac에** — 녹음, 텍스트 변환, 참석자 구분, 검색이 모두 Apple Silicon에서 돕니다. 서버로 올리지 않습니다.
- 📁 **파일이 원본** — 노트는 `~/Tractus/meetings/` 아래 폴더(오디오·JSON·Markdown·자막)입니다. Obsidian 같은 도구로도 엽니다.
- 🧾 **근거가 달린 요약** — 결정 사항과 할 일마다 근거 대화의 시각이 붙습니다. 누르면 그 자리부터 다시 듣습니다.
- 🤖 **에이전트가 읽는 노트** — MCP 서버로 Claude Code·Codex·Antigravity가 내 노트를 검색하고 인용합니다.

## 주요 기능

- **녹음** — 대면 녹음, 화상 통화(시스템 소리 포함), 일시정지, 녹음 중 메모·북마크, 메뉴 막대에서 바로 녹음
- **텍스트 변환** — Qwen3-ASR(MLX)로 한국어·영어 자동 감지, 오디오·동영상 파일 끌어 놓기
- **참석자** — 목소리로 말하는 사람을 나누고 이름을 붙임, 목소리 등록 뒤 다음 녹음부터 이름 제안
- **단어 싱크** — 재생 중인 단어 강조, 단어를 누르면 그 자리부터 재생
- **요약** — 회의록·핵심 요약·할 일 중심 등 6가지 유형과 직접 쓴 요약 방법
- **AI 질문** — 한 노트나 모든 노트에 질문하고 근거 대화가 붙은 답을 받음
- **검색** — 단어 일치와 비슷한 뜻을 함께 찾음 (⌘K)
- **정리·내보내기** — 즐겨찾기·태그·폴더, txt·md·srt·vtt·csv·docx·PDF·전체 백업
- **화면** — 라이트·다크 모드, macOS 네이티브 톤, 앱 안 업데이트

## 스크린샷

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
        <img src="docs/images/home-light.png" alt="홈: 빠른 동작과 최근 노트">
      </picture>
      <p align="center"><b>홈</b> — 녹음·글쓰기·가져오기와 최근 노트</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/ask-dark.png">
        <img src="docs/images/ask-light.png" alt="AI 질문: 근거 시각이 달린 답">
      </picture>
      <p align="center"><b>AI 질문</b> — 답마다 근거 대화의 시각</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/record-dark.png">
        <img src="docs/images/record-light.png" alt="녹음 화면">
      </picture>
      <p align="center"><b>녹음</b> — 레벨 미터, 북마크, 시각이 붙는 메모</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/images/settings-dark.png">
        <img src="docs/images/settings-light.png" alt="설정 화면">
      </picture>
      <p align="center"><b>설정</b> — 테마, 녹음, AI 서비스</p>
    </td>
  </tr>
</table>

> 스크린샷은 가상 회의 데이터로 찍었습니다.

## 빠른 시작

1. [릴리스](https://github.com/sjoon21/Tractus/releases/latest)에서 `Tractus-…-arm64.dmg`를 받아 `Tractus.app`을 `Applications`로 끌어다 놓습니다.
2. 터미널에서 ffmpeg를 설치합니다.
   ```bash
   brew install ffmpeg
   ```
3. 앱을 열면 **시작 점검**이 모델 받기와 AI 키 등록을 안내합니다.

> [!NOTE]
> 아직 Apple 서명·공증을 받지 않았습니다. 처음 열 때 "확인되지 않은 개발자" 경고가 나오면 시스템 설정 › 개인정보 보호 및 보안 › `그래도 열기`를 누릅니다. 소스에서 직접 빌드하는 방법과 문제 해결은 [설치 안내](docs/setup.md)에 있습니다.

**요구 사항:** Apple Silicon(M1 이상), macOS 14.4 이상, 메모리 16GB 권장(8GB는 저사양 구성)

## 무엇이 이 Mac에 남고, 무엇이 나가나

| 데이터 | 처리 위치 |
| --- | --- |
| 오디오, 참석자 목소리 | 이 Mac에만 남음 |
| 노트, 검색 색인 | 이 Mac의 폴더와 SQLite |
| 요약·AI 질문 요청 | 필요한 텍스트만 내가 고른 AI 서비스로 전송 (Upstage·OpenAI·Claude·Gemini·OpenAI 호환) |

AI 서비스 키가 없어도 녹음, 변환, 검색, 내보내기는 모두 됩니다. 자세한 범위는 [동작 방식](docs/how-it-works.md#무엇이-이-mac에-남고-무엇이-나가는가)에 있습니다.

## 문서

| 문서 | 내용 |
| --- | --- |
| [설치 안내](docs/setup.md) | 미리 만든 앱, 소스에서 빌드, 권한, 업데이트, 문제 해결 |
| [사용법](docs/usage.md) | 노트 만들기, 참석자·대화 다듬기, 요약·AI 질문, 단축키 |
| [AI 서비스와 키](docs/ai-services.md) | 서비스 등록, 서비스별 기본값, 검색 임베딩 |
| [모델과 라이선스](docs/models.md) | 모델 받기, 모델 목록과 라이선스, 선정 근거 |
| [CLI](docs/cli.md) | 터미널에서 변환·요약·질문·검색·내보내기 |
| [에이전트 연동 (MCP)](docs/mcp.md) | Claude Code·Codex·Antigravity 설정과 도구 7개 |
| [동작 방식](docs/how-it-works.md) | 구성도, 이 Mac에 남는 데이터와 나가는 데이터 |
| [아키텍처](ARCHITECTURE.md) | 설계 결정, 변경 이력, 벤치마크 결과 |
| [앱 계약](docs/desktop.md) · [디자인 지침](app/DESIGN.md) | 앱과 코어의 계약, 화면 디자인 규칙 |
| [로드맵](docs/roadmap.md) | 진행 현황과 알려진 한계 |
| [기여 안내](CONTRIBUTING.md) | 개발 환경, 테스트, 커밋 규칙 |

## 만든 기술

[![Python][python-badge]][python-url] [![MLX][mlx-badge]][mlx-url] [![Tauri][tauri-badge]][tauri-url] [![React][react-badge]][react-url] [![Tailwind][tailwind-badge]][tailwind-url] [![Swift][swift-badge]][swift-url] [![SQLite][sqlite-badge]][sqlite-url] [![MCP][mcp-badge]][mcp-url]

코어 CLI는 Python, 변환·참석자 구분·임베딩은 MLX, 앱은 Tauri 2(Rust + React), 녹음 프로그램은 Swift입니다. 구성은 [동작 방식](docs/how-it-works.md)에 있습니다.

## 기여·문의

버그, 기능 제안, 질문은 [이슈](https://github.com/sjoon21/Tractus/issues)로 남겨 주세요. 코드 기여는 [기여 안내](CONTRIBUTING.md)를 먼저 읽어 주세요.

## 라이선스

[Apache License 2.0](LICENSE). 모델마다 라이선스가 따로 있습니다. 고지 전문은 [NOTICE](NOTICE), 목록은 [모델과 라이선스](docs/models.md)에 있습니다.

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
