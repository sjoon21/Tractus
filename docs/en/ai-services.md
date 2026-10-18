# AI services and keys

[한국어](../ai-services.md) · **English**

Summaries and Ask AI need an LLM API. Without a key you can still record, transcribe, search and export.

- **App:** In Settings › `AI summaries and questions`, choose an AI service (Upstage, OpenAI, Claude, Gemini or `Custom`), enter the service URL, API key and AI model, then click `Test connection` (it saves what you entered first). Each service's key is stored separately, only in the app's settings folder (`~/Library/Application Support/dev.tractus.app/`), never in your notes folder. The service URL is filled in with a default. For OpenAI and `Custom` you need to type the AI model name yourself; for Gemini, leaving it empty always uses the latest Flash (`gemini-flash-latest`). `Custom` is for the URL and key of any OpenAI-compatible service (OpenRouter, a company gateway, Ollama and so on); an address on this Mac (`localhost`) works without a key. The URL, AI model and key are saved per service (`Added` / `Not added`). If you add more than one, pick a service each time with the service button (logo and name) in the Summary tab or the Ask AI input (the initial choice is the one set with `Use as default`). `Load AI models` lists the model names the service knows as suggestions in the AI model field. API keys must be at least 5 characters. Under `Smart search method` you can switch smart search to Upstage (requires an Upstage key; note content and search queries are sent to Upstage) or back to `This Mac (default)`.
- **Terminal:** Put keys in `.env.local` at the repository root (ignored by git). Precedence is shell environment variables > `.env.local` > `.env`. Test the connection with `uv run tractus llm test --provider claude`.

```bash
# .env.local
UPSTAGE_API_KEY=up_...
```

### Summaries, decisions and to-dos

Only OpenAI-compatible APIs with API keys are supported. Choose a provider with `TRACTUS_LLM_PROVIDER` or `--provider`, change the service URL with `TRACTUS_LLM_BASE_URL` and the AI model with `TRACTUS_LLM_MODEL`. To set them per service, use `UPSTAGE_`, `OPENAI_`, `ANTHROPIC_` or `GEMINI_` followed by `BASE_URL` or `MODEL` (see `.env.example`). Precedence is arguments > global values (only when `TRACTUS_LLM_PROVIDER` is that service or empty) > per-service values > defaults. To see the AI model IDs a service offers, run `uv run tractus llm models --provider gemini`.

| Provider | Key | Default model | Status |
| --- | --- | --- | --- |
| `upstage` | `UPSTAGE_API_KEY` | `solar-pro4` | Verified |
| `openai` | `OPENAI_API_KEY` | None (`--model` required) | Awaiting a key. Temperature isn't sent (gpt-5 and o-series reject it) |
| `claude` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | Awaiting a key. Connects through the compatibility layer; temperature isn't sent |
| `gemini` | `GEMINI_API_KEY` | `gemini-flash-latest` (an alias; `gemini-2.5-flash` returns 404 for new users) | Summaries verified. URL `https://generativelanguage.googleapis.com/v1beta/openai` |
| `custom` | `TRACTUS_LLM_API_KEY` (not needed for a `localhost` URL) | None (`TRACTUS_LLM_BASE_URL` and `--model` required) | Any OpenAI-compatible service |
| `gemma-local` | None (`localhost:11434`) | `gemma4:31b` | Requires a local server |

In the app you can add keys per service for Upstage, OpenAI, Claude, Gemini and `Custom` (`custom`). Only Upstage summaries, Gemini summaries, the connection test and the AI model list have been checked against real servers; OpenAI and Claude have only been tested against a fake server without a key. With `TRACTUS_LOCAL_ONLY=1`, any service whose URL host isn't this Mac (`localhost`, `127.0.0.1`, `::1`) is blocked. Subscription CLIs (`claude -p`, `codex exec`, `agy`) aren't used as providers because of their terms of service ([ARCHITECTURE.md](../../ARCHITECTURE.md) §0, Korean).

### Search embeddings (optional)

The default is Qwen3-Embedding on this Mac. Setting `TRACTUS_EMBED=upstage` (in the app, a setting) switches to Upstage `solar-embedding-2`. **Sentences from your notes (when indexing) and your search queries (when searching) are sent to Upstage.** The key is `UPSTAGE_API_KEY` (URL: `UPSTAGE_BASE_URL`), and switching rebuilds the vectors. If there's no key or a call fails, search falls back to word match. Search quality hasn't been measured with `bench/search_eval.py` yet.
