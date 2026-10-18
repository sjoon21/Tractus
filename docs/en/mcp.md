# Claude Code, Codex and Antigravity (MCP)

[한국어](../mcp.md) · **English**

Agent CLIs can use Tractus as a tool to search your past notes. They cite sources as `[note title 00:05:31]` and can also write and save summaries. **The MCP server doesn't call an LLM.** Each CLI does the reasoning with its own subscription or key.

## Claude Code plugin (recommended)

If you've installed the Tractus app, this is all you need. The plugin finds `tractus` and your data folder on its own.

```
/plugin install tractus --marketplace sjoon21/Tractus
```

From a shell: `claude plugin marketplace add sjoon21/Tractus && claude plugin install tractus@tractus` (Claude Code 2.1.275 or later can do it in one step with `--marketplace`).

- **Lookup order** (`plugins/tractus/bin/tractus-mcp`): `tractus` is found via `TRACTUS_BIN` → the path set manually in the app's settings → inside `/Applications/Tractus.app` or `~/Applications/Tractus.app` → `~/.local/bin` or `/opt/homebrew/bin` → PATH. The data folder: `TRACTUS_HOME` → the data folder in the app's settings → `~/Tractus`. The models folder: `TRACTUS_MODELS_DIR` → the app's settings → the core default.
- **Setting paths manually:** If they can't be found automatically, choose `tractus executable` and `Tractus data folder` in `/plugin` › Installed › tractus › Configure options, or pass `--config tractus_bin=/path --config tractus_home=/path` when installing.
- **What's included:** the MCP server `tractus` (tool names like `mcp__plugin_tractus_tractus__search_meetings`), the `meetings` skill (searches when you ask about past meetings and cites `(note title, time)`), and `/tractus:recap [period]` (a recap of decisions, to-dos and open questions).
- The server runs from the data folder (it doesn't read the `.env` of the project you have open) and finds notes only by ID or by a path inside this data folder.
- The app builds the search index (just open the app once). If you use Tractus from the repository without the app, run `uv run tractus index` first.
- If you've switched smart search to Upstage, the plugin doesn't receive the Upstage key, so it searches by keyword (keys are never passed to MCP).

## Connecting directly (Codex, Antigravity, or without the plugin)

Index once first (vectors are built on the CLI side): `uv run tractus index`

In the examples below, `/path/to/Tractus` is the path to this repository. `.venv/bin/tractus` is created by `uv sync` (or `scripts/install.sh`). `TRACTUS_MODELS_DIR` is the folder you downloaded models into (the models folder shown by `uv run tractus models list`). It defaults to `models` in the app's settings folder; if you downloaded models to `~/Tractus/models` earlier, that's where they are and you can use the examples as is.

**Claude Code** — put the name before `-e`.

```bash
claude mcp add -s user tractus -e TRACTUS_HOME=$HOME/Tractus -e TRACTUS_MODELS_DIR=$HOME/Tractus/models \
  -- /path/to/Tractus/.venv/bin/tractus mcp
```

**Codex CLI** — Codex doesn't pass shell environment variables to MCP servers, so `env` is required. In `~/.codex/config.toml`:

```toml
[mcp_servers.tractus]
command = "/path/to/Tractus/.venv/bin/tractus"
args = ["mcp"]
env = { TRACTUS_HOME = "/Users/me/Tractus", TRACTUS_MODELS_DIR = "/Users/me/Tractus/models" }
# Read tools are approved automatically. To also allow saving summaries (save_summary) without asking, add the next line.
# tools.save_summary.approval_mode = "approve"
```

**Antigravity CLI (agy)**

```bash
agy mcp add --env TRACTUS_HOME=$HOME/Tractus --env TRACTUS_MODELS_DIR=$HOME/Tractus/models \
  tractus /path/to/Tractus/.venv/bin/tractus mcp
```

To use it headless (`agy -p`), add `"mcp(tractus/*)"` to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Workspace settings are ignored. Gemini CLI is no longer supported here because it ended support for personal accounts.

| Tool | What it does |
| --- | --- |
| `status` | Data location and index status (check this first if results look empty) |
| `search_meetings` | Hybrid search with date, note, tag and folder filters, and a citation for each segment |
| `list_meetings` | Notes in a date range |
| `get_transcript` | Transcript text with your edits applied (paged) |
| `get_summary` / `list_action_items` | Summary (pick a type with `template`); to-dos (default summary only, the most recent `limit` items, with the number left out in `omitted`) |
| `save_summary` | Validates and saves a summary written by the agent (the only write tool) |

Example: `claude -p "Find in my notes how last quarter's GPU server purchase decision changed, and show me the sources"`

Don't connect a home folder that contains transcripts of data that can't be redistributed, such as AI Hub. Whatever an agent reads is sent to that CLI's service.
