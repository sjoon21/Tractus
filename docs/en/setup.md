[한국어](../setup.md) · **English**

# Install guide

Tractus is built from source on your own Mac. `scripts/bootstrap.sh` sets up the build tools, `scripts/install.sh` builds the core, the recorder and the app, and the **setup check** that appears the first time you open the app downloads the models. This guide walks through each step in order.

- Audience: developers who can clone and build this repository
- To skip building, download the prebuilt app (`.dmg`) from [GitHub Releases](https://github.com/sjoon21/Tractus/releases): see [§10](#10-downloading-the-prebuilt-app)
- Requirements: Apple Silicon Mac, macOS 14.4 or later, 15GB free disk space, internet access (used only for installing and downloading models)
- Nothing uses `sudo`, and the scripts never run scripts downloaded from the internet.

## 1. Quick install

Three commands:

```bash
git clone https://github.com/sjoon21/Tractus.git && cd Tractus
scripts/bootstrap.sh      # build tools (installs only what's missing, via Homebrew)
scripts/install.sh        # core, recorder, app build
```

| Command | What it does | Time |
| --- | --- | --- |
| `scripts/bootstrap.sh` | Checks for the Xcode Command Line Tools and Homebrew, installs only the missing tools from the [Brewfile](../../Brewfile) (Rust, Node.js, pnpm, uv, ffmpeg), then runs `install.sh --check` as a final check. Asks once before installing | A few seconds if the tools are already there; a few minutes if something needs installing (depends on your connection) |
| `scripts/install.sh` | Runs `uv sync`, `swift build`, `pnpm install` and `pnpm tauri build` in order, then shows a `tractus doctor` check at the end | About 5 minutes (measured: Apple M3, 16GB, clean copy, including `--with-fluid`: 5 min 17 s, 2026-10-15. Varies with your connection) |
| Download models | From the setup check in the app ([§2](#2-first-launch)) | 5–20 minutes (estimate; depends on the set and your connection) |

- **You don't need to open a new terminal.** Tools installed by `bootstrap.sh` work in the same terminal right away. The exceptions: you installed the Xcode Command Line Tools or Homebrew for the first time just now, or Homebrew wasn't on your PATH and was found at `/opt/homebrew/bin/brew`. In the latter case, first run the `eval "$(/opt/homebrew/bin/brew shellenv)"` line the script prints at the end. In these cases, finish the installation as the two scripts instruct, open a new terminal, and run `bootstrap.sh` again.
- If something blocks the install, the script tells you what to do (its messages are in Korean) and stops with exit code 1. The Xcode Command Line Tools (`xcode-select --install`) and Homebrew need a system dialog or an administrator password, so the script won't install them for you.
- If you already have the tools (it's fine if they're on your PATH via rustup, nvm and so on), you can skip `bootstrap.sh` and just run `scripts/install.sh --check`.
- To do everything in one go: `scripts/bootstrap.sh --yes --with-install`.
- To see the status without changing anything: `scripts/bootstrap.sh --check` and `scripts/install.sh --check`.
- To also download models and copy the app to `~/Applications`: `scripts/install.sh --models standard --copy-app`.
- To update to a new version, use `scripts/update.sh`; to delete accumulated build output, use `scripts/clean.sh` ([§7](#7-updating), [Disk usage](#disk-usage)).

> **Don't move or delete the repository folder after installing.** The app runs `.venv/bin/tractus` and `recorder/.build/release/tractus-rec` inside the repository it was built from, and these paths are compiled into the app. If you moved the folder, run `scripts/install.sh` again from the new location. The `tractus` and `tractus-rec` paths in Settings default to `Automatic` and are looked up on every launch, so you don't need to edit them. If a path you saved earlier no longer exists, the app falls back to automatic and the setup check says `A saved path no longer exists, so the automatic path is used`. To use an executable somewhere else, choose `Custom` in Settings and pick it with `Browse…`.

## 2. First launch

```bash
open app/src-tauri/target/release/bundle/macos/Tractus.app    # or ~/Applications/Tractus.app
```

If you see an "unidentified developer" warning the first time, see [§5](#5-permissions). The order is setup check → download models → API key. The first two are enough for recording and transcription.

The app's interface is available in English and Korean: choose under `Settings` › `Appearance` › `Language` (`System` follows your macOS language).

### Setup check

The **setup check** opens automatically on first launch. You can reopen it any time from Settings or the home screen. Each item shows pass, warning or blocked, and blocked items come with a fix.

| Section | What it checks |
| --- | --- |
| System | Apple Silicon, macOS 14.4 or later, memory, free disk space |
| Tools | ffmpeg (if missing, shows `brew install ffmpeg` and `Check again`), the recorder, the core location |
| Models | Whether the required models are present; buttons to install the standard set, the lite set, or required only |
| Permissions | Microphone and system audio (macOS asks on your first recording). Calendar access is requested only when you connect it in Settings |
| AI summaries and questions | Whether an API key has been added |

The check never blocks you from using the app. If a feature's model is missing, clicking it tells you why and how to install it.

You can run the same check in the terminal:

```bash
uv run tractus doctor            # human-readable summary
uv run tractus doctor --json     # JSON for the app
```

### Downloading models

Models are downloaded to `~/Library/Application Support/dev.tractus.app/models` (outside your notes folder and iCloud sync). If you previously downloaded models to `~/Tractus/models`, that folder keeps being used. To change the location, click `Change location…` on the `Models` screen in the app (installed models move to the new folder with it), run `uv run tractus models move <folder>` in the terminal, or set the `TRACTUS_MODELS_DIR` environment variable. If the repository has a `.env`, its value is used. Old folders that aren't in the model list can be removed with `Clean up` unused folders on the `Models` screen (in the terminal, `uv run tractus models prune`).

In the app, download and delete models on the `Models` screen at the bottom left. In the terminal, use:

```bash
uv run tractus models list                          # install status (--json works too)
uv run tractus models download --preset standard    # a whole set at once
uv run tractus models download diarizer aligner     # pick by model ID
uv run tractus models remove aligner                # remove one
```

If a download is interrupted, run the same command again to resume.

#### Model reference

| ID | Name | Size | Level | Unavailable without it |
| --- | --- | --- | --- | --- |
| `vad` | Speech detection (Silero VAD v6) | 1.2MB | Required | Transcription, live transcription |
| `asr-std` | Standard transcription engine (Qwen3-ASR 1.7B) | 2.5GB | Required (any one engine) | Transcription |
| `asr-lite` | Lite transcription engine (Qwen3-ASR 0.6B) | 1.0GB | Required (any one engine) | Transcription, **live transcription (needs this engine even if the standard engine is installed)** |
| `asr-ko-mix` | Korean-with-English transcription engine (BuzzASR Korean, Whisper large-v3 fine-tuned for Korean) | 1.7GB | Required (any one engine) | Transcription |
| `asr-ko-univa` | Korean fine-tuned transcription engine (TeamUNIVA Qwen3-ASR 1.7B Korean, bf16) | 4.7GB | Required (any one engine) | Transcription (custom vocabulary works) |
| `diarizer` | Speaker detection (Nemotron 3 Diarization) | 199MB | Recommended | Speaker detection (without it, transcripts have no speakers) |
| `aligner` | Word sync (Qwen3 ForcedAligner 0.6B) | 1.3GB | Optional | Word sync, word highlighting during playback |
| `embedding` | Smart search (Qwen3 Embedding 0.6B, 8bit) | 0.6GB | Optional | Smart search (word match search still works) |
| `voices` | Speaker voices (3D-Speaker CAM++) | 28MB | Optional | Registering speaker voices and name suggestions |
| `fluid` | Speaker detection for 9+ speakers (FluidAudio) | 22MB + helper | Optional | Speaker detection for 9 or more speakers (without it, up to 8) |

- **`Required (any one engine)`**: you need only one transcription engine (`asr-std`, `asr-lite`, `asr-ko-mix`, or `asr-ko-univa`) to transcribe. There's no need to download them all. If any one is installed, the Models screen shows `Transcription engine: installed`. The standard engine is the most accurate; 16GB of memory or more is recommended. The lite engine uses less memory, and **live transcription needs this engine specifically.** We tried the standard engine (1.7B) for live use too, but text took about 1.6–2 seconds at p95 to finalize (measured on a Mac under load; the median was also about 1 second or more), which exceeds the 1-second target, so it isn't used (measured 2026-10-14, docs/desktop.md §2.8, Korean).
- **`asr-ko-mix` (BuzzASR)**: more accurate than the standard engine when Korean conversations mix in a lot of English terms (Korean–English HiKE MER 22.8 vs 28.3, English term recall 86% vs 72%). For Korean-only meetings the standard engine is slightly more accurate (AI Hub CER 9.5 vs 10.3). It is a Whisper-family engine, so it doesn't use custom vocabulary. Press `Use as default` on the Models screen to transcribe with it.
- Some things aren't tied to a model. **Recording** works without any model. Without a transcription engine, the recording is saved and stays in `Recordings waiting to transcribe`; once you download a model, you can transcribe it.
- **Summaries and Ask AI** need an API key, not a model ([API key](#adding-an-api-key)).
- `fluid` also needs the `tractus-diar` helper. Build it with `scripts/install.sh --with-fluid`, then download the model (requires Swift 6.2 or later).
- Model licenses are listed in [NOTICE](../../NOTICE).

#### Recommended sets

| Set | Models included | Disk | For |
| --- | --- | --- | --- |
| Standard | Required (standard engine) + speaker detection + word sync + smart search + voices (download `asr-lite` too if you want live transcription) | About 4.6GB | 16GB of memory or more (`--preset standard`) |
| Lite | Lite engine + speaker detection | About 1.2GB | 8GB of memory, or when running alongside other work (`--preset lite`) |
| Required only | `vad` + one transcription engine that fits your memory | 1.0–2.5GB | Try it first and download more later (`--preset required`) |
| All | Every model above (including `fluid` if the helper is present) | About 5.7GB | (`--preset all`) |

The required models alone cover the whole basic flow: record or import a file, transcribe it, and, with an API key, summarize it.

### Adding an API key

Summaries and Ask AI call an LLM API. Only your question and the supporting text are sent; audio never is.

- **App:** In Settings › `AI summaries and questions`, choose an AI service (Upstage, OpenAI, Claude, Gemini, or Custom), enter the API key (plus the service URL and AI model name if needed), and confirm with `Test connection`. Each service's key is stored separately in the app's settings folder and never written to your notes folder. When you request a summary or ask a question, that note's transcript (including the title and speaker names) is sent to the chosen service. Keys of 5 characters or more can be saved. If you register more than one service, you can pick one each time in the `AI service` field of the Summary tab and the Ask AI input (the initial choice is the one set with `Use as default`). Under `Smart search method` in Settings, you can switch smart search to Upstage (requires an Upstage key; note content and search queries are sent to Upstage).
- **Terminal:** Put the key in `.env.local` at the repository root, like `UPSTAGE_API_KEY=...` (excluded from git). For other providers and URLs, see the provider table in [AI services and keys](ai-services.md#summaries-decisions-and-to-dos) and `.env.example`. Test the connection with `uv run tractus llm test` and list a service's AI model IDs with `uv run tractus llm models --provider gemini`. To set a URL and AI model per service, add entries like `GEMINI_BASE_URL` and `GEMINI_MODEL` to `.env.local`. Switching search embeddings to Upstage requires `TRACTUS_EMBED=upstage` (sentences from your notes and your search queries are sent to Upstage) and `UPSTAGE_API_KEY`.

Without a key, recording, transcription, search and export all work. Only summaries and questions don't.

---

## 3. Requirements and tools

| Item | Minimum | Recommended |
| --- | --- | --- |
| Chip | Apple Silicon (M1 or later) | M1 Pro or later |
| macOS | 14.4 | Latest version |
| Memory | 8GB | 16GB or more |
| Free disk space | 15GB (build output about 3GB (measured, including the 9+ speaker helper) + up to 5.7GB of models) | 25GB |

- **The minimum specs are design targets and haven't been tested directly.** 8GB comes from memory-usage estimates, and macOS 14.4 is the floor for the Core Audio process tap described below. The development machine is an Apple M3, 16GB, macOS 26.6. Install time and build size were measured on that machine on 2026-10-15 ([Disk usage](#disk-usage)); model sizes are totals from the registry.
- On 8GB of memory, use the lite set (0.6B model). Live transcription (requires 16GB or more) isn't available with this set. The standard set (1.7B model) is recommended for 16GB or more.
- Intel Macs aren't supported. The transcription models run on MLX (Apple Silicon only).
- macOS 14.4 is the floor for recording system audio (Core Audio process tap).

### Disk usage

Measured with `du` on 2026-10-15 after one run of `scripts/install.sh --with-fluid` on a clean copy (`git archive`, no models or build output) (Apple M3, 16GB, release build).

| Item | Size | Notes |
| --- | --- | --- |
| `.venv` (core) | 0.58GB | mlx, scipy, onnxruntime, transformers, etc. |
| `recorder/.build` | 0.10GB | Recorder |
| `recorder/diar/.build` | 0.95GB | Only with `--with-fluid` (FluidAudio and its dependencies) |
| `app/src-tauri/target` | 1.22GB | Release compile output. The finished `Tractus.app` is about 17MB |
| `app/node_modules` | 0.19GB | |
| **Total (repository folder)** | **About 3.05GB** | About 2.1GB without `--with-fluid`. Models are separate |

Total install time was 5 min 17 s: recorder 11 s, 9+ speaker helper 167 s (including the FluidAudio download), app release compile about 2 minutes.

If you develop with `cargo build` or `pnpm tauri dev`, `app/src-tauri/target` grows further (incremental caches plus both debug and release builds pile up). On the Mac where this repository is developed, it ballooned to `app/src-tauri/target` 12GB+ (12.9GB measured on 2026-10-15, and still growing), `recorder/.build` 1.0GB, `recorder/diar/.build` 1.3GB, and `bench/.venv` 1.2GB. Two changes address this:

- **`[profile.dev] debug = "line-tables-only"`** (`app/src-tauri/Cargo.toml`): development builds keep only line numbers and skip variable info. A clean development build's `target` (one `cargo build`) **shrank from 2.88GB to 2.08GB, 28% smaller**, with no difference in compile time (64 s vs. 68 s; measured 2026-10-15). File and line numbers in backtraces are unchanged, but you can no longer inspect local variables in the debugger (lldb). If you need variables, change that line to `debug = true`. Incremental compilation stays at its default (on). Release builds (`install.sh`) aren't affected.
- **`scripts/clean.sh`**: deletes only output that can be rebuilt ([§4](#scriptscleansh)).

### Tools

`scripts/bootstrap.sh` checks for the tools below and installs any that are missing with Homebrew. You can also install them yourself.

| Tool | Used for | Install | Required |
| --- | --- | --- | --- |
| Xcode Command Line Tools (Swift 5.10 or later, Xcode 15.3. Build verified only with Swift 6.4 / Xcode 27 on the development machine) | Building the recorder | `xcode-select --install` | Required |
| Swift 6.2 or later (Xcode 26) | Building the 9+ speaker detection helper (`tractus-diar`) | Update Xcode | Only with `--with-fluid` |
| Homebrew | Installing the tools below | Official install command at <https://brew.sh> | Not needed if you install the tools yourself |
| Rust (`cargo`) | Building the app (Tauri) | `brew install rust` (an existing rustup install is used as-is) | Required |
| Node.js 22.12 or later | Building the app UI | `brew install node` | Required |
| pnpm | App dependencies | `brew install pnpm` | Required |
| uv | Installing the core (Python) | `brew install uv` | Required |
| ffmpeg | Reading audio, importing files, transcription | `brew install ffmpeg` | Required for transcription |

- If your Swift is too old, update Xcode. Xcode 15.3 installs on macOS 13.5 or later, Xcode 16 on 14.5 or later, and Xcode 26 on 15.6 or later. The Command Line Tools alone may not include the latest Swift.
- Only `tractus-diar` needs Swift 6.2, and it's a separate package (`recorder/diar/`). It's split out because FluidAudio, which the helper uses, requires it. Speaker detection for up to 8 speakers works without the helper.
- **ffmpeg is not bundled with the app** (licensing). Installing and recording work without it, but transcription and file import need ffmpeg.
- You can also install everything at once with `brew bundle --file Brewfile`. Unlike `bootstrap.sh`, though, it installs Homebrew copies even of tools you already have through other means such as rustup.

## 4. Install scripts

### `scripts/bootstrap.sh`

| Option | Effect |
| --- | --- |
| `--check` | Installs nothing and just shows the status, including the `brew bundle check` result |
| `--yes` | Doesn't ask before installing. Required to install when not running in a terminal (CI, etc.) |
| `--with-install` | Runs `scripts/install.sh` once setup is done |

Exit codes: 0 ready, 1 blocked (Xcode tools or Homebrew missing, install failed, etc.), 2 option error.

### `scripts/install.sh`

`--check` changes nothing. It shows ✓ (pass), `!` (warning) and ✗ (blocked), and exits with code 1 if anything is blocked. If tools are missing, it tells you to run `scripts/bootstrap.sh` first.

The script runs four steps in the same order every time. It's safe to run repeatedly.

| Step | Command | Result |
| --- | --- | --- |
| 1 | `uv sync` | `.venv/bin/tractus` (core) |
| 2 | `swift build -c release` (`recorder/`) | `recorder/.build/release/tractus-rec` (recorder) |
| 3 | `pnpm install --frozen-lockfile` | App dependencies |
| 4 | `pnpm tauri build --bundles app` | `app/src-tauri/target/release/bundle/macos/Tractus.app` |

| Option | Effect |
| --- | --- |
| `--with-fluid` | Also builds the 9+ speaker detection helper: runs `swift build -c release` in `recorder/diar/` to produce `recorder/diar/.build/release/tractus-diar`. Requires Swift 6.2 or later, and the first build downloads FluidAudio, adding 2–3 minutes. If it fails, the rest of the install continues |
| `--models <set>` | Downloads models at the end. One of `required`, `standard`, `lite`, `all` ([Downloading models](#downloading-models)) |
| `--copy-app` | Copies the built app to `~/Applications/Tractus.app` |

At the end there's a read-only **install check**. It shows a `tractus doctor` summary and warns if a custom `tractus_bin` or `rec_bin` path saved in the app settings (`~/Library/Application Support/dev.tractus.app/settings.json`) doesn't exist or differs from what was just built (the message, in Korean, tells you to revert the path to `Automatic` in Settings). It only warns and never fails the install, and `--check` still changes nothing.

### `scripts/update.sh`

```bash
scripts/update.sh --check                  # show incoming commits only (git fetch + git log)
scripts/update.sh [install.sh options]     # git pull --ff-only → show new commits → scripts/install.sh → install check
```

Every option except `--check` is passed straight to `install.sh` (for example, `scripts/update.sh --with-fluid --models standard`). It stops in three cases: the working tree has uncommitted changes (new untracked files don't count), the branch doesn't track `origin` (including a detached HEAD), or you have local commits so it can't fast-forward. When it stops, it changes nothing and tells you why. If you're already up to date, it says so and exits, so it's safe to run repeatedly. If the install fails after pulling, the code is still current: fix the problem and run `scripts/install.sh` again.

### `scripts/clean.sh`

Shows the size of the build output and deletes it after you confirm. `scripts/install.sh` rebuilds it afterward.

| Option | Effect |
| --- | --- |
| (none) | Deletes `app/src-tauri/target`, `recorder/.build` and `recorder/diar/.build`. **The finished `Tractus.app` lives inside `target`, so it's deleted too** (a copy made with `--copy-app` at `~/Applications/Tractus.app` stays) |
| `--all` | Also deletes `app/node_modules` and `bench/.venv` (they have to be downloaded again, so you'll need internet) |
| `--yes` | Doesn't ask for confirmation. Required to delete when not running in a terminal |
| `--force` | Deletes even if this repository's Tractus app or recorder is running (by default it stops if they are) |

**Never deleted:** `.venv` (core), `models/`, `data/`, your notes folder (`TRACTUS_HOME`), source files. Only the listed folders are deleted, and links pointing outside the repository are skipped.

## 5. Permissions

| Permission | When it's requested | If you denied it |
| --- | --- | --- |
| Microphone | macOS asks on your first recording | Turn on Tractus in System Settings > Privacy & Security > Microphone |
| System audio | The first time you record in a mode that also captures system sound | Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording |
| Calendar (optional) | Only when you click `Connect calendar` in Settings › `Calendar`. Never asked if you don't connect | Use `Open System Settings` in Settings, then turn on Tractus under Privacy & Security > Calendars |

Permissions can't be checked in advance; the setup check only explains them. The default in-person mode uses only the microphone.

### "Unidentified developer" warning

An app you build yourself is ad-hoc signed and not notarized by Apple. Opening it on the Mac that built it usually shows no warning. If you see a warning when opening a copy on another Mac or a downloaded app, use one of these:

- macOS 14 and earlier: right-click the app in Finder and choose `Open`.
- macOS 15 and later: try opening the app once, then go to System Settings > Privacy & Security and choose `Open Anyway`.
- Or remove the quarantine attribute in the terminal: `xattr -dr com.apple.quarantine ~/Applications/Tractus.app` (`app/src-tauri/target/release/bundle/macos/Tractus.app` if you didn't use `--copy-app`)

## 6. Folders

| What | Where |
| --- | --- |
| Notes (audio, transcripts, summaries) | `~/Tractus/meetings/` (change with the `TRACTUS_HOME` environment variable) |
| Custom vocabulary, registered voices | `~/Tractus/glossary.md`, `~/Tractus/voices.json` |
| Search index | `~/Tractus/.tractus/` (rebuilt from your notes if deleted) |
| Models | `~/Library/Application Support/dev.tractus.app/models/` (or `~/Tractus/models/` if you downloaded there before. Change with `TRACTUS_MODELS_DIR`) |
| App settings, saved API keys | `~/Library/Application Support/dev.tractus.app/` |
| Core, recorder, helper, app build | Inside the repository folder (`.venv`, `recorder/.build`, `recorder/diar/.build`, `app/src-tauri/target`) |
| Core, recorder (prebuilt app) | Inside the app: `Tractus.app/Contents/Resources/runtime/` (core), `Resources/bin/` (recorder). Folders outside the app are the same as above |

We recommend not keeping your notes folder (`~/Tractus`) inside iCloud Drive, Dropbox, OneDrive, Google Drive or an Obsidian vault, since your notes and audio may get synced along with it. If it is in such a folder, the setup check's `Data folder` item tells you and offers `Change folder…` (notes aren't moved, so move them to the new folder yourself and restart the app).

## 7. Updating

```bash
cd Tractus
scripts/update.sh --check   # show incoming commits (optional)
scripts/update.sh           # git pull --ff-only + scripts/install.sh (add --with-fluid if you installed with it)
```

Quit the app first if it's running. Notes and models are left untouched. For details, see [§4](#scriptsupdatesh). The prebuilt app (`.dmg`) isn't updated with this script but from `Settings` › `Updates` inside the app ([§10](#data-and-updates)).

**When updating to the version where the smart search model changed to 8bit (2026-10-15):** download the new model (0.6GB) on the Models screen and rebuild the search vectors (`uv run tractus index`; the model identifier changed, so everything is rebuilt automatically). The old model folder (`qwen3-embedding-0.6b`, 1.2GB) remains as an "unregistered folder", so delete it with `uv run tractus models prune` (`tractus models list` shows how many there are and their size). The search quality of the new model hasn't been evaluated yet (see the exemption record in [CLAUDE.md](../../CLAUDE.md), Korean).

## 8. Troubleshooting

| Symptom | Check and fix |
| --- | --- |
| Says `ffmpeg` is missing | Run `brew install ffmpeg` (or `scripts/bootstrap.sh`), then click `Check again` in the setup check. The app looks in `/opt/homebrew/bin`, `/usr/local/bin` and system folders. If you installed it elsewhere, create a link in `/opt/homebrew/bin` |
| Transcribe button is disabled with a reason | The transcription engine or `vad` is missing. Download it with `Install models` in the message |
| A model shows `Partially downloaded` | The download was interrupted. Downloading again resumes it (`Resume` in the app) |
| A model shows `Damaged` | The downloaded files are corrupt. Run `uv run tractus models remove <ID>`, then `uv run tractus models download <ID>`. `Download again` in the app does both steps at once |
| Model download stalls | Run the same command again to resume. Check free disk space and your internet connection |
| App slows down or runs out of memory while transcribing | Quit other apps; on an 8GB Mac, switch to the lite set. Live transcription uses about 2GB more memory, so we recommend turning it off |
| Recording is silent | Check the microphone permission ([Permissions](#5-permissions)). If only system sound is missing, check the system audio recording permission |
| App says it can't run `tractus` or `tractus-rec` | The repository folder was moved or never built. Run `scripts/install.sh` again from the repository. If the path in Settings is `Automatic`, the app finds the newly built files; if it's `Custom`, fix it with `Revert to automatic` or `Browse…`. The setup check's `Tools` section shows which path is in use. The install check at the end of the install also warns if a saved path doesn't match |
| Old models are taking up space in the models folder | `uv run tractus models list` shows the number and size of unregistered folders. `uv run tractus models prune` shows their sizes and deletes them after you confirm (registered models, hidden files and links are left alone) |
| `app/src-tauri/target` and similar folders are too big | Delete build output with `scripts/clean.sh` (`--all` includes `node_modules`) and rebuild with `scripts/install.sh` when needed |
| Summaries say there's no key or authentication failed | Re-enter the key in Settings › `AI summaries and questions` |
| `scripts/bootstrap.sh` stops because the Xcode Command Line Tools or Homebrew are missing | The script won't install these two for you. Run the command shown (`xcode-select --install`, or the install command from brew.sh) yourself, then run the script again |
| `command not found` after installing tools | If you just installed Homebrew for the first time, open a new terminal (and follow the two `Next steps` lines printed at the end of its install). Otherwise you don't need a new terminal |
| Says Node.js is too old even though you ran `brew install node` | An older version (nvm, etc.) comes first on your PATH. Check with `which -a node` and clean up the earlier one |
| `swift build` reports a Swift version error | Check `swift --version`. The recorder (`recorder/`) needs 5.10 or later (Xcode 15.3), and the 9+ speaker helper (`recorder/diar/`) needs 6.2 or later (Xcode 26). If you don't need the helper, install without `--with-fluid` |
| `tractus-diar` fails to build | Basic features aren't affected (speaker detection works for up to 8 speakers). Make sure you have Swift 6.2 or later and retry with `cd recorder/diar && swift build -c release`. The first build downloads FluidAudio, so you need internet |
| You want to see the install check results again | `scripts/bootstrap.sh --check`, `scripts/install.sh --check`, `uv run tractus doctor` |

## 9. Uninstalling

```bash
rm -rf ~/Applications/Tractus.app                       # if you copied it
rm -rf "$HOME/Library/Application Support/dev.tractus.app"   # app settings, saved API keys, models in the default location (models can be re-downloaded)
rm -rf ~/Tractus/models                                 # if you downloaded models here before
rm -rf <repo folder>                                    # core, recorder, app build
tccutil reset All dev.tractus.app                       # reset permissions (optional)
```

Line by line: the app copy (if you copied it); app settings, saved API keys and models in the default location (models can be downloaded again); models in the old location (if you used it); the repository folder (core, recorder, app build); and an optional permissions reset.

**`~/Tractus/meetings/` contains your notes and recordings.** It's deliberately left out of the commands above. Delete it only after confirming you no longer need it.

## 10. Downloading the prebuilt app

This is how to use a `Tractus.app` that runs without the repository, downloaded as a `.dmg`. The app bundles the core (a relocatable Python, its dependencies, and `tractus`) and the recorder (`tractus-rec`), so you don't need developer tools like Rust, Node or uv. Models (several GB) and ffmpeg are not included.

> **Current status, honestly:** this was verified on a copy on the Mac that built it, with access to the repository and the original Python blocked (`sandbox-exec`) and an empty environment (`env -i`). **It hasn't yet been tested on a clean Mac (a new user account), and we haven't confirmed how Gatekeeper behaves with a downloaded, quarantined copy or under which name the microphone permission appears.** It isn't formally signed or notarized (ad-hoc signature). **It also hasn't been run on macOS 14.4–15** (the build Mac runs macOS 26.6): we've only confirmed that the build pins dependency wheels to the lowest macOS build (`macosx_14_0`) and stops if any Mach-O requires a system newer than 14.4. Before this check was added, builds had an `mlx` that required macOS 26.2 or later.

### Installing

1. From the latest release on [GitHub Releases](https://github.com/sjoon21/Tractus/releases), download `Tractus-<version>[-<date>]-arm64.dmg`. This DMG doesn't include the 9+ speaker detection helper (`tractus-diar`), so it detects up to 8 speakers (Nemotron). Open the `.dmg` and drag `Tractus` onto the `Applications` shortcut. No administrator password is needed (you can also put it in `~/Applications`). The same instructions are in `설치 안내.txt` on the disk image (in Korean).
2. The first time you open it, you'll see an "unidentified developer" warning, because the signature isn't registered with Apple.
   - macOS 15 and later: open the app once and dismiss the warning, then click `Open Anyway` near the bottom of System Settings > Privacy & Security and enter your password.
   - macOS 14.x: Control-click the app and choose `Open`.
   - Terminal: `xattr -dr com.apple.quarantine /Applications/Tractus.app` (removes the quarantine flag from the downloaded file. This also fixes the "is damaged and can't be opened" message)
3. On first launch, the order is **setup check** → **download models** → **API key** (same as [§2](#2-first-launch)). The first two are enough for recording and transcription.
4. **ffmpeg is not included in the app** (left out for licensing reasons). Install it in the terminal with `brew install ffmpeg`. Without it, recording works, but transcription and file import don't (the setup check tells you).

### Data and updates

Notes, models and settings all live outside the app ([§6](#6-folders)): notes in `~/Tractus`, models in `~/Library/Application Support/dev.tractus.app/models`, settings and API keys in `~/Library/Application Support/dev.tractus.app/`. Your data stays put however you update.

**Updates happen inside the app (from 0.1.1).** About 10 seconds after launch, the app checks once for a new version; if there is one, you'll see a `New version available: X` notice with an `Open settings` button (it won't notify twice in the same session). `Settings` › `Updates` shows the current version, a `Check for updates` button, and a status line (`Checking…` / `You’re up to date.` / the new version with part of its release notes + `Install update`). The update is downloaded (`Downloading N%`) and installed only after you click `Install update`, and clicking `Relaunch` after the "Installed" message restarts into the new version (locked during recording or transcription; click it once they finish). Nothing installs on its own. If the launch check fails (no internet, etc.), nothing is shown; error messages appear only when you check with the button in Settings.

- New versions are looked up only among the public repository's **full releases** (not pre-releases), via `latest.json` under `releases/latest`. Downloaded files are signature-checked against the public key built into the app and aren't installed if they don't match.
- **v0.1.0 doesn't have this feature.** Once, download the new `.dmg` and replace `Tractus.app` (quit the app and overwrite it). This method always works afterward too.
- Each update downloads the whole app (about 240MB), not just the differences.
- Because every new build of the app has a different ad-hoc signature hash, the warning in step 2 and the microphone and system audio permission prompts may appear again ([§5](#5-permissions); this is expected but not verified).
- Apps built from the repository with `scripts/install.sh` don't have this feature; `Settings` › `Updates` shows just one line: `Apps built from the repository update with scripts/update.sh.` ([§7](#7-updating)).

To remove the app, move it to the Trash and delete the data folders yourself as in [§9](#9-uninstalling).

### Building it yourself

```bash
scripts/build_app_bundle.sh --check               # check tools only
scripts/build_app_bundle.sh [--out dist/bundle.noindex] [--with-fluid]   # → <out>/Tractus.app
scripts/make_dmg.sh dist/bundle.noindex/Tractus.app       # → dist/Tractus-<version>[-<date>]-arm64.dmg (version from tauri.conf.json, date = build day; --version sets the name without a date)
```

(The `make_dmg.sh` output name takes the version from `tauri.conf.json` and the build date; with `--version`, it uses that name without a date.)

- `build_app_bundle.sh` copies `uv`'s Python 3.12 (python-build-standalone) into the app's `Contents/Resources/runtime/` and slims it down (removes tkinter, idle, tests, pip and headers, strips the x86_64 slices from universal2 wheels, and deletes `tests` and `*.pyi`). It then installs the dependencies pinned in `uv.lock` **as wheels only** (`--only-binary :all:`; source builds are refused) **with hash verification** (`--require-hashes`). For packages with several macOS wheels (such as `mlx`), letting uv pick by the build Mac's macOS version would select one that's too new, so the script pins the URL and hash of the lowest-macOS wheel in `uv.lock`. The build stops if even one Mach-O requires a system newer than 14.4. Internet is used only to download those wheels from PyPI (not at all if they're cached), and the first run may download Python via `uv python install 3.12`. It builds `tractus-rec` and puts it in `Resources/bin/` (plus `tractus-diar` with `--with-fluid`, Swift 6.2 or later), and merges `runtime/` and `bin/` into `bundle.resources` via `--config` on `pnpm tauri build --bundles app` (they aren't hard-coded in `tauri.conf.json` so that the regular `install.sh` build doesn't break). Finally, it ad-hoc signs every Mach-O inside, signs the app with `Entitlements.plist`, and runs `codesign --verify --deep --strict`.
- It writes only to the `--out` folder, `app/src-tauri/target` and `app/dist` (and `app/node_modules` if it's missing). The repository's `.venv` and `recorder/.build` are left untouched (the recorder is built in a temporary folder under `--out`).
- The core executable `runtime/bin/tractus` uses only the Python inside the bundle, located relative to itself (it finds its real location even when invoked through a link, and starts Python with `-I` so it ignores `PYTHON*` environment variables and user site-packages; it clears `PYTHONEXECUTABLE` and `__PYVENV_LAUNCHER__`, which `-I` doesn't block). Bytecode is precompiled (`unchecked-hash`) and never written at runtime. This keeps the signed app unmodified, and startup with heavy imports dropped from about 2.3 s to 1.2 s.
- Size and time (Apple M3, clean copy, measured 2026-10-15): app about 694MB (Python 35MB, `site-packages` 632MB: mlx 155, transformers 111, onnxruntime 79, scipy 92, including about 126MB of bytecode; app itself 16MB; recorder 0.3MB), `.dmg` 242MB, build about 2.5 minutes (with a warm cache; 175 s the first time).
- No `.pkg` is produced. It would only help for installs that need an administrator password or for MDM deployment.

#### Making a release (`scripts/release.sh`)

`scripts/release.sh` produces the full set of files to upload for a release. It's the only thing that creates `latest.json`, which the in-app updater reads.

```bash
pnpm --dir app tauri signer generate -w ~/.tauri/tractus.key --ci   # once, if you have no signing key (no password; won't overwrite an existing key)
scripts/release.sh                 # build only (default); prints the gh release create command
scripts/release.sh --publish       # also creates the GitHub release
```

(The first line runs once if you don't have a signing key yet: no password, and an existing key is never overwritten. By default `release.sh` only builds and prints the `gh release create` command; `--publish` also creates the GitHub release.)

The sequence is `build_app_bundle.sh` → package the final signed `Tractus.app` with `COPYFILE_DISABLE=1 tar czf Tractus.app.tar.gz` (the app folder at the archive root) → `.sig` via `pnpm tauri signer sign -f ~/.tauri/tractus.key` → `latest.json` → `make_dmg.sh` → sha256. The version is read from `app/src-tauri/tauri.conf.json`, and the results are collected in `dist/release/<version>/`. `bundle.createUpdaterArtifacts` in `tauri build` isn't used: the tar.gz it produces is the app before our script's final ad-hoc re-signing, so it's useless.

| File | Purpose |
| --- | --- |
| `Tractus-<version>-arm64.dmg` | Disk image for first-time installs |
| `Tractus-<version>-arm64.dmg.sha256` | Hash of the disk image |
| `Tractus.app.tar.gz` | File the in-app updater downloads (the whole app, about 240MB) |
| `Tractus.app.tar.gz.sig` | Signature of the file above (`minisign` format, checked by the app against its public key) |
| `latest.json` | Manifest the app reads: `version`, `notes`, `pub_date`, `platforms.darwin-aarch64.{url, signature}`. `url` is `https://github.com/sjoon21/Tractus/releases/download/v<version>/Tractus.app.tar.gz` |

- **Always back up the signing key `~/.tauri/tractus.key`.** The public key is in `plugins.updater.pubkey` in `tauri.conf.json`, and installed apps check signatures against it. If you lose the private key, existing installs will reject updates signed with a new key, and every user will have to reinstall from a `.dmg`. Never put the private key in the repository or print its contents. If the key is missing, the script explains and stops. To use a key from another location, pass `TAURI_SIGNING_PRIVATE_KEY_PATH` (path) or `TAURI_SIGNING_PRIVATE_KEY` (key contents). To check that a generated `.sig` matches the app's public key, run `TRACTUS_UPDATE_ARTIFACT=<tar.gz> TRACTUS_UPDATE_SIG=<.sig> cargo test --test update_signature` (in `app/src-tauri`), which verifies it the same way the app does (it passes silently if the environment variables aren't set).
- **It must be a full release.** The app reads `releases/latest/download/latest.json`, and GitHub's `latest` points only to the most recent release that isn't a pre-release. Publish as a pre-release and nobody gets the update. The tag is `v<version>`, and the `url` in `latest.json` points to that tag, so publishing under any other name makes downloads fail with a 404.
- When bumping the version, keep `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml`, `app/package.json` and `pyproject.toml` in sync (`Cargo.lock` follows via cargo, `uv.lock` via `uv lock`).
- Not yet verified: whether macOS asks again for microphone and system audio permissions after an update (ad-hoc re-signing), install and update on a clean Mac (a new user account), and behavior on macOS 14.4–15.
