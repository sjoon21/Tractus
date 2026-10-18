# Claude Code·Codex·Antigravity 연동 (MCP)

에이전트 CLI가 Tractus를 도구로 써서 과거 노트를 검색합니다. 근거를 `[노트 제목 00:05:31]` 형식으로 인용하고, 요약을 직접 써서 저장할 수도 있습니다. **MCP 서버는 LLM을 호출하지 않습니다.** 추론은 각 CLI가 자기 구독·키로 합니다.

## Claude Code 플러그인 (권장)

Tractus 앱을 설치했다면 이것으로 끝입니다. 플러그인이 `tractus`와 데이터 폴더를 스스로 찾습니다.

```
/plugin install tractus --marketplace sjoon21/Tractus
```

셸에서는 `claude plugin marketplace add sjoon21/Tractus && claude plugin install tractus@tractus`입니다(Claude Code 2.1.275 이상은 `--marketplace`로 한 번에).

- **찾는 순서** (`plugins/tractus/bin/tractus-mcp`): `tractus`는 `TRACTUS_BIN` → 앱 설정의 직접 지정 경로 → `/Applications/Tractus.app`·`~/Applications/Tractus.app` 안 → `~/.local/bin`·`/opt/homebrew/bin` → PATH. 데이터 폴더는 `TRACTUS_HOME` → 앱 설정의 데이터 폴더 → `~/Tractus`. 모델 폴더는 `TRACTUS_MODELS_DIR` → 앱 설정 → 코어 기본값.
- **직접 지정:** 자동으로 못 찾으면 `/plugin` › Installed › tractus › Configure options에서 `tractus executable`·`Tractus data folder`를 고르거나, 설치할 때 `--config tractus_bin=/path --config tractus_home=/path`를 줍니다.
- **들어 있는 것:** MCP 서버 `tractus`(도구 이름 `mcp__plugin_tractus_tractus__search_meetings` 등), 스킬 `meetings`(과거 회의 질문에 검색하고 `(노트 제목, 시각)`으로 인용), `/tractus:recap [기간]`(결정·할 일·미결 회고).
- 서버는 데이터 폴더에서 실행되고(열어 둔 프로젝트의 `.env`를 읽지 않음), 노트는 ID나 이 데이터 폴더 안의 경로로만 찾습니다.
- 노트 색인은 앱이 합니다(앱을 한 번 열면 됨). 앱 없이 저장소에서 쓰면 `uv run tractus index`를 먼저 돌립니다.
- 스마트 검색을 Upstage로 고른 경우 플러그인은 Upstage 키를 받지 않으므로 키워드 검색으로 찾습니다(키를 MCP에 넘기지 않는다는 원칙).

## 직접 연결 (Codex·Antigravity·플러그인 없이)

먼저 한 번 색인합니다(벡터는 CLI 쪽에서 만듭니다): `uv run tractus index`

아래 예시의 `/path/to/Tractus`는 이 저장소 경로입니다. `.venv/bin/tractus`는 `uv sync`(또는 `scripts/install.sh`) 뒤에 생깁니다. `TRACTUS_MODELS_DIR`은 모델을 받은 폴더입니다(`uv run tractus models list`의 `모델 폴더`. 기본은 앱 설정 폴더의 `models`이고, 예전에 `~/Tractus/models`에 받았다면 그곳이니 아래 예시를 그대로 쓰면 됩니다).

**Claude Code** — 이름을 `-e`보다 앞에 둡니다.

```bash
claude mcp add -s user tractus -e TRACTUS_HOME=$HOME/Tractus -e TRACTUS_MODELS_DIR=$HOME/Tractus/models \
  -- /path/to/Tractus/.venv/bin/tractus mcp
```

**Codex CLI** — Codex는 셸 환경변수를 MCP 서버에 넘기지 않으므로 `env`를 꼭 적습니다. `~/.codex/config.toml`:

```toml
[mcp_servers.tractus]
command = "/path/to/Tractus/.venv/bin/tractus"
args = ["mcp"]
env = { TRACTUS_HOME = "/Users/me/Tractus", TRACTUS_MODELS_DIR = "/Users/me/Tractus/models" }
# 읽기 도구는 자동 승인됩니다. 요약 저장(save_summary)까지 묻지 않고 쓰려면 다음 줄을 추가합니다.
# tools.save_summary.approval_mode = "approve"
```

**Antigravity CLI (agy)**

```bash
agy mcp add --env TRACTUS_HOME=$HOME/Tractus --env TRACTUS_MODELS_DIR=$HOME/Tractus/models \
  tractus /path/to/Tractus/.venv/bin/tractus mcp
```

헤드리스(`agy -p`)에서 쓰려면 `~/.gemini/antigravity-cli/settings.json`의 `permissions.allow`에 `"mcp(tractus/*)"`를 추가합니다. 워크스페이스 설정은 무시됩니다. Gemini CLI는 개인 계정 지원이 끝나 대상에서 뺐습니다.

| 도구 | 기능 |
| --- | --- |
| `status` | 데이터 위치, 색인 상태 (결과가 비어 보이면 먼저 확인) |
| `search_meetings` | 하이브리드 검색, 날짜·노트·태그·폴더 필터, 세그먼트별 인용 표기 |
| `list_meetings` | 기간별 노트 목록 |
| `get_transcript` | 전사 본문, 고친 내용 반영 (페이지 단위) |
| `get_summary` / `list_action_items` | 요약(`template`으로 유형 지정), 할 일(기본 요약만, 최근 것부터 `limit`개, 빠진 수는 `omitted`) |
| `save_summary` | 에이전트가 쓴 요약을 검증해서 저장 (유일한 쓰기 도구) |

예: `claude -p "지난 분기 GPU 서버 구매 결정이 어떻게 바뀌었는지 내 노트에서 찾아서 근거와 함께 알려줘"`

AI Hub 같은 재배포 금지 데이터의 전사가 들어 있는 홈은 MCP에 연결하지 마세요. 에이전트가 읽는 내용은 각 CLI의 서비스로 전달됩니다.
