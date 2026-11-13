//! 앱 설정(settings.json): 읽기·자동 경로·하위 프로세스 환경, 그리고 설정 한 칸씩 저장하는 명령.
//! 파일을 쓰는 곳은 모두 `patch_settings`를 거친다 (CLAUDE.md 경로 규칙).

use crate::i18n::tv;
use super::{ask, i18n, llm_key, mcp, models, paths, tray, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// 앱 설정. 앱 설정 폴더의 settings.json에 저장한다. GUI 앱은 셸 환경을 물려받지 않으므로 경로는 절대 경로로 둔다.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// 직접 지정한 코어 경로. 비어 있으면 "자동": 실행할 때마다 찾는다 (paths.rs). 저장하는 것은 사용자가 입력한 값뿐이다
    pub tractus_bin: String,
    /// 직접 지정한 녹음 프로그램 경로 (비어 있으면 자동)
    pub rec_bin: String,
    pub home: String,
    /// 비어 있으면 코어가 정한다 (TRACTUS_MODELS_DIR → $TRACTUS_HOME/models에 모델이 있으면 그곳 → 앱 설정 폴더의 models)
    pub models_dir: String,
    /// 개발용: tractus-rec record --fake (권한 없이 합성 신호로 녹음)
    pub fake_recorder: bool,
    /// 마지막으로 고른 녹음 방식: "in_person"(마이크만) | "hybrid"(마이크 + 시스템, 에코 제거). 앱이 해석한다
    pub rec_mode: String,
    /// 녹음 중 실시간 자막 (Phase 7.2, `tractus live`). 기본 꺼짐: 메모리를 약 2 GB 더 쓴다 (실측 footprint 1.8 GB)
    pub live_captions: bool,
    /// 노트 목록 정렬 (docs/desktop.md §2.12): created | updated | title | duration, asc | desc
    pub list_sort: String,
    pub list_order: String,
    /// 시작 점검(docs/desktop.md §2.15)을 한 번 보여 줬는가. 처음 실행할 때만 저절로 열린다
    pub checkup_done: bool,
    /// 메뉴 막대에 Tractus 아이콘을 둔다 (docs/desktop.md §3.1). 켜져 있어야 `keep_in_tray`가 뜻이 있다
    pub tray_enabled: bool,
    /// 창을 닫아도 앱을 끝내지 않고 메뉴 막대에 남긴다 (아이콘이 실제로 떠 있을 때만)
    pub keep_in_tray: bool,
    /// 녹음 중 메인 창을 보고 있지 않으면 화면 구석에 작은 녹음 창을 띄운다 (mini.rs). 기본 켜짐
    pub mini_recorder: bool,
    /// 통화 앱이 마이크를 쓰기 시작하면 녹음할지 묻는다 (calls.rs). 기본 켜짐
    pub call_detect: bool,
    /// 통화로 시작한 녹음을 통화 앱이 마이크를 놓으면 끝낸다. 끄면(기본) 끝낼지 묻는다
    pub call_autostop: bool,
    /// 녹음을 끝내면: "ask"(매번 묻기) | "convert"(바로 텍스트로 변환) | "later"(노트로 저장만 하고 나중에 변환). 모르는 값은 화면이 "ask"로 읽는다 (docs/desktop.md §3.3)
    pub after_record: String,
    /// 요약·질문에서 서비스를 따로 고르지 않을 때 쓰는 AI 서비스 (llm_key::PROVIDERS의 이름). 키는 settings.json이 아니라 서비스별 파일에 있다 (llm_key.rs)
    pub llm_default: String,
    /// 서비스마다 주소·AI 모델 (비어 있으면 서비스 기본값). 예전 설정의 `llm_provider` 등은 읽을 때 여기로 옮긴다 (llm_key::migrate_llm)
    pub llm_profiles: BTreeMap<String, llm_key::Profile>,
    /// 스마트 검색 방식: "local"(이 Mac, 기본) | "upstage"(문장·검색어를 Upstage로 보낸다. 옵트인)
    pub embedding_provider: String,
    /// Obsidian으로 보내기의 볼트 폴더 (비어 있으면 아직 고르지 않음). 노트는 <볼트>/Tractus/ 아래에 쓴다 (obsidian.rs)
    pub obsidian_vault: String,
    /// Obsidian으로 보낼 때 오디오도 볼트에 복사한다 (기본 꺼짐: 1시간 약 14MB가 볼트와 함께 동기화된다)
    pub obsidian_audio: bool,
    /// macOS 캘린더를 연결했는가 (calendar.rs). 기본 꺼짐: 연결하기 전에는 권한을 묻지 않는다
    pub calendar_enabled: bool,
    /// 홈 카드에서 뺄 캘린더 ID (처음에는 모두 읽는다)
    pub calendar_hidden: Vec<String>,
    /// 화면 언어: "system"(macOS 언어, 기본) | "ko" | "en" (i18n.rs, docs/desktop.md §3.8)
    pub ui_lang: String,
    /// 기본 변환 엔진 (모델 ID, docs/design/asr-engines.md). 비어 있으면 자동: 코어가 메모리에 맞는 기본 엔진을 고른다. 변환할 때 `--engine`으로 넘긴다
    pub asr_engine: String,
    /// 앱 설정 폴더 (키가 있는 곳). 파일에는 쓰지 않고 `AppState::settings()`가 채운다
    #[serde(skip)]
    pub config_dir: Option<PathBuf>,
    /// 이번 실행에서 없는 저장 경로를 자동으로 되돌린 설정 이름 (`tractus_bin`·`rec_bin`). 파일에는 쓰지 않는다 (시작 점검이 알린다)
    #[serde(skip)]
    pub stale: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Settings {
            tractus_bin: String::new(),
            rec_bin: String::new(),
            home: var("TRACTUS_HOME").unwrap_or_else(|| "~/Tractus".into()),
            models_dir: String::new(), // 환경변수는 하위 프로세스가 물려받는다. 파일에 굳히지 않는다
            fake_recorder: false,
            rec_mode: "in_person".into(),
            live_captions: false,
            list_sort: "updated".into(),
            list_order: "desc".into(),
            checkup_done: false,
            tray_enabled: true,
            keep_in_tray: true,
            mini_recorder: true,
            call_detect: true,
            call_autostop: false,
            after_record: "ask".into(),
            llm_default: llm_key::DEFAULT_PROVIDER.into(),
            llm_profiles: BTreeMap::new(),
            embedding_provider: "local".into(),
            obsidian_vault: String::new(),
            obsidian_audio: false,
            calendar_enabled: false,
            calendar_hidden: vec![],
            ui_lang: "system".into(),
            asr_engine: String::new(),
            config_dir: None,
            stale: vec![],
        }
    }
}

/// `~/`를 홈 폴더로. Windows에는 HOME이 없어 USERPROFILE을 본다
pub(crate) fn expand(p: &str) -> PathBuf {
    let home = if cfg!(windows) { std::env::var_os("USERPROFILE") } else { std::env::var_os("HOME") };
    match (p.strip_prefix("~/"), home) {
        (Some(rest), Some(h)) => PathBuf::from(h).join(rest),
        _ => PathBuf::from(p),
    }
}

impl Settings {
    pub(crate) fn home(&self) -> PathBuf {
        expand(&self.home)
    }

    /// 설정 파일을 읽는다. 없거나 깨졌으면 기본값. 저장된 코어·녹음 프로그램 경로가 없는 파일이면 자동으로 되돌리고 `stale`에 남긴다
    /// (파일 자체는 다음 저장 때 고쳐진다). 자동 후보와 같은 값(예전에 기본값을 저장한 것)은 조용히 자동으로 바꾼다
    pub(crate) fn load(raw: Option<&str>) -> Settings {
        let parsed = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()).map(|mut v| {
            llm_key::migrate_llm(&mut v);
            v
        });
        let mut s: Settings = parsed.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        // 손으로 고친 파일의 모르는 값
        if !llm_key::is_provider(&s.llm_default) {
            s.llm_default = llm_key::DEFAULT_PROVIDER.into();
        }
        s.llm_profiles.retain(|p, _| llm_key::is_provider(p));
        if s.embedding_provider != "upstage" {
            s.embedding_provider = "local".into();
        }
        for (name, field, bin) in [("tractus_bin", &mut s.tractus_bin, &paths::TRACTUS), ("rec_bin", &mut s.rec_bin, &paths::REC)] {
            if field.is_empty() {
                continue;
            }
            if !expand(field).is_file() {
                s.stale.push(name.into());
                field.clear();
            } else if bin.is_default(field) {
                field.clear();
            }
        }
        s
    }

    /// 파일에 쓸 설정: 자동이 찾을 기본값은 저장하지 않는다 (화면이 해석된 경로를 그대로 돌려보내도 굳지 않는다). 직접 입력한 값은 그대로
    pub(crate) fn for_save(mut self) -> Settings {
        for (field, bin) in [(&mut self.tractus_bin, &paths::TRACTUS), (&mut self.rec_bin, &paths::REC)] {
            if bin.is_default(field) {
                field.clear();
            }
        }
        self.stale.clear();
        self
    }

    pub(crate) fn tractus_resolved(&self) -> paths::Resolved {
        paths::TRACTUS.find(&self.tractus_bin)
    }

    pub(crate) fn rec_resolved(&self) -> paths::Resolved {
        paths::REC.find(&self.rec_bin)
    }

    pub(crate) fn tractus_path(&self) -> PathBuf {
        PathBuf::from(self.tractus_resolved().path)
    }

    pub(crate) fn rec_path(&self) -> PathBuf {
        PathBuf::from(self.rec_resolved().path)
    }

    /// 하위 프로세스에 명시적으로 넘기는 환경변수.
    pub(crate) fn child_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("TRACTUS_HOME".into(), self.home().to_string_lossy().into_owned()),
            ("PYTHONUNBUFFERED".into(), "1".into()), // 진행 이벤트가 버퍼에 묶이지 않게
            ("PYTHONIOENCODING".into(), "utf-8".into()),
            // 오류를 rich 상자 대신 평문 한 줄로 (stderr 마지막 줄을 그대로 보여 준다)
            ("TYPER_USE_RICH".into(), "0".into()),
        ];
        // GUI 앱의 PATH에는 Homebrew가 없다. ffmpeg를 찾으려면 넣어야 한다 (Windows는 사용자 PATH를 그대로 물려준다)
        if cfg!(target_os = "macos") {
            env.push(("PATH".into(), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()));
        }
        if !self.models_dir.is_empty() {
            env.push(("TRACTUS_MODELS_DIR".into(), expand(&self.models_dir).to_string_lossy().into_owned()));
        }
        // `doctor`가 앱이 쓰는 녹음 프로그램을 보게 한다 (자동으로 찾은 경로가 코어의 기본 경로와 다를 수 있다)
        env.push(("TRACTUS_REC_BIN".into(), self.rec_resolved().path));
        env.push(self.embed_mode());
        env.push(("TRACTUS_LANG".into(), i18n::lang().into())); // 코어가 앱에 보내는 문장의 언어 (셸의 값보다 앱의 선택이 먼저다)
        env
    }

    /// 스마트 검색 방식. 앱이 정한다: `.env`의 TRACTUS_EMBED가 이 선택을 뒤집지 못하게 모든 실행에 늘 싣는다 (뒤집히면 노트 내용이 Upstage로 가거나, 벡터가 계속 다시 만들어진다)
    pub(crate) fn embed_mode(&self) -> (String, String) {
        ("TRACTUS_EMBED".into(), if self.embedding_provider == "upstage" { "upstage" } else { "local" }.into())
    }

    /// 옵트인(upstage)일 때만 Upstage 키와 주소. 이것이 "키는 요약·질문 실행에만"의 유일한 예외다: 노트 문장·검색어를 임베딩하는 실행(색인, 변환·가져오기·요약 뒤의 색인, 질문의 검색)과
    /// 상주 검색 프로세스에만 `tractus_embed`·`llm_cmd`·`mcp_spawn`이 싣는다. 녹음·화자·내보내기 등 나머지 실행(child_env)에는 없다.
    /// 셸에 이미 있는 값은 덮어쓰지 않는다. 주소는 Upstage 서비스에 저장한 주소, 없으면 기본 주소 (노트 폴더 .env의 UPSTAGE_BASE_URL이 키를 받지 못하게 늘 정한다)
    pub(crate) fn embed_key_env(&self, shell: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
        if self.embedding_provider != "upstage" {
            return vec![];
        }
        let unset = |k: &str| shell(k).is_none_or(|v| v.is_empty());
        let mut env = vec![];
        if unset("UPSTAGE_BASE_URL") {
            env.push(("UPSTAGE_BASE_URL".into(), self.upstage_base_url()));
        }
        if let (true, Some(key)) = (unset("UPSTAGE_API_KEY"), self.config_dir.as_deref().and_then(|d| llm_key::load(d, "upstage"))) {
            env.push(("UPSTAGE_API_KEY".into(), key));
        }
        env
    }

    pub(crate) fn upstage_base_url(&self) -> String {
        let stored = self.llm_profiles.get("upstage").map_or("", |p| p.base_url.as_str());
        if stored.is_empty() { llm_key::default_url("upstage").unwrap_or_default().into() } else { stored.into() }
    }

    pub(crate) fn key_saved(&self, provider: &str) -> bool {
        self.config_dir.as_deref().and_then(|d| llm_key::load(d, provider)).is_some()
    }

    /// 지금 쓸 수 있는 서비스 (키가 있거나 이 Mac 주소의 직접 입력), 표의 순서대로
    pub(crate) fn registered(&self) -> Vec<&'static str> {
        llm_key::provider_ids().filter(|p| llm_key::usable(p, self.llm_profiles.get(*p).map_or("", |x| x.base_url.as_str()), self.key_saved(p))).collect()
    }

    /// 요약·질문의 기본 서비스: 고른 서비스가 등록돼 있으면 그것, 아니면 등록된 첫 서비스, 하나도 없으면 고른 서비스
    pub(crate) fn default_provider(&self) -> &'static str {
        let chosen = llm_key::canonical(&self.llm_default).unwrap_or(llm_key::DEFAULT_PROVIDER);
        let reg = self.registered();
        if reg.contains(&chosen) { chosen } else { reg.first().copied().unwrap_or(chosen) }
    }

    /// tractus CLI는 현재 폴더의 .env/.env.local(API 키)을 읽는다. 저장소 .venv의 실행 파일이면 저장소 루트에서 실행한다.
    pub(crate) fn tractus_cwd(&self) -> PathBuf {
        let bin = self.tractus_path();
        match bin.parent().filter(|p| p.ends_with(".venv/bin")).and_then(Path::parent).and_then(Path::parent) {
            Some(repo) => repo.to_path_buf(),
            None => {
                // 깨끗한 Mac에는 데이터 폴더가 아직 없다: 없는 폴더에서는 실행이 ENOENT로 실패하므로 먼저 만든다 (만들지 못하면 그대로 두고 실행이 오류를 말한다)
                let home = self.home();
                let _ = std::fs::create_dir_all(&home);
                home
            }
        }
    }

    pub(crate) fn tractus<S: AsRef<OsStr>>(&self, args: &[S]) -> Command {
        let mut cmd = crate::procs::command(self.tractus_path());
        cmd.args(args).envs(self.child_env()).current_dir(self.tractus_cwd());
        cmd
    }

    /// 변환 명령(`transcribe …`)에 고른 기본 변환 엔진을 붙인다 (자동이면 그대로). 받아 두지 않은 엔진이면 코어가 경고하고 기본 엔진으로 변환한다
    pub(crate) fn with_asr_engine(&self, mut args: Vec<String>) -> Vec<String> {
        if args.first().is_some_and(|a| a == "transcribe") && models::valid_id(&self.asr_engine) {
            args.extend(["--engine".to_string(), self.asr_engine.clone()]);
        }
        args
    }

    /// 노트 문장·검색어를 임베딩하는 실행 (색인·변환·가져오기). 스마트 검색을 Upstage로 쓰면 그 키가 더해진다 (`embed_key_env`)
    pub(crate) fn tractus_embed<S: AsRef<OsStr>>(&self, args: &[S]) -> Command {
        let mut cmd = self.tractus(args);
        cmd.envs(self.embed_key_env(|k| std::env::var(k).ok()));
        cmd
    }

    /// 요약·질문처럼 AI 서비스를 부르는 실행만 쓴다 (녹음·변환은 `tractus`). provider: 이번에 고른 서비스 (없으면 기본). 그 서비스의 키를 환경변수로만 넘긴다 (llm_key.rs)
    pub(crate) fn tractus_llm<S: AsRef<OsStr>>(&self, args: &[S], provider: Option<&str>) -> Result<Command, String> {
        let mut cmd = self.tractus_llm_with(args, self.config_dir.as_deref(), provider, |k| std::env::var(k).ok())?;
        cmd.envs(self.embed_key_env(|k| std::env::var(k).ok())); // 요약 뒤 색인·질문의 검색이 임베딩한다 (옵트인일 때만)
        Ok(cmd)
    }

    pub(crate) fn tractus_llm_with<S: AsRef<OsStr>>(&self, args: &[S], config_dir: Option<&Path>, provider: Option<&str>, env: impl Fn(&str) -> Option<String>) -> Result<Command, String> {
        let mut cmd = self.tractus(args);
        let choice = self.llm_choice(provider)?;
        let key = config_dir.and_then(|d| llm_key::load(d, choice.provider));
        let set = ask::llm_config(&[&self.tractus_cwd(), &self.home()], &env);
        cmd.envs(llm_key::env(&choice, key.as_deref(), &env, &set));
        Ok(cmd)
    }

    /// 이번에 고른 AI 서비스(없으면 기본 서비스)와 그 서비스에 저장한 주소·AI 모델. 모르는 서비스는 오류
    pub(crate) fn llm_choice(&self, provider: Option<&str>) -> Result<llm_key::Choice<'_>, String> {
        let provider = match provider {
            Some(p) => llm_key::canonical(p).ok_or_else(|| tv("알 수 없는 AI 서비스입니다: {id}", &[("id", p.to_string())]))?,
            None => self.default_provider(),
        };
        let profile = self.llm_profiles.get(provider);
        Ok(llm_key::Choice { provider, base_url: profile.map_or("", |p| &p.base_url), model: profile.map_or("", |p| &p.model) })
    }

    pub(crate) fn mcp_spawn(&self) -> mcp::Spawn {
        mcp::Spawn {
            program: self.tractus_path(),
            args: vec!["mcp".into()],
            env: self.child_env().into_iter().chain(self.embed_key_env(|k| std::env::var(k).ok())).collect(),
            cwd: Some(self.tractus_cwd()),
        }
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

/// settings.json을 쓰는 곳은 모두 이것을 거친다: 한 번에 하나만(읽고 합치고 쓰는 사이에 다른 저장이 끼어 바뀐 값을 잃지 않게),
/// 임시 파일에 쓴 뒤 이름을 바꾼다(쓰다 꺼져도 깨진 파일이 남지 않는다. 깨지면 Settings::load가 기본값으로 돌아가 데이터 폴더가 바뀐다).
/// merge는 지금 파일 내용(없으면 None)을 받아 새 내용을 돌려준다
static SETTINGS_FILE: Mutex<()> = Mutex::new(());

pub(crate) fn patch_settings(path: &Path, merge: impl FnOnce(Option<&str>) -> Result<String, String>) -> Result<(), String> {
    let _held = SETTINGS_FILE.lock().unwrap_or_else(|e| e.into_inner());
    let raw = merge(std::fs::read_to_string(path).ok().as_deref())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(raw.as_bytes())?;
        f.sync_all()
    });
    written.and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        tv("설정을 저장할 수 없습니다\n{e}", &[("e", e.to_string())])
    })
}

/// 설정 화면의 저장: 화면이 고치는 칸(데이터 위치·실행 파일·모의 녹음·실시간 텍스트 변환)과 모델 폴더만 바꾼다.
/// 나머지(정렬·시작 점검·녹음 방식·AI 서비스·Obsidian·캘린더…)는 각자 바로 저장하므로, 화면을 연 뒤 바뀐 값을 옛 화면 값이 되돌리지 않게 지금 값을 쓴다
fn apply_form(mut cur: Settings, form: Settings) -> Settings {
    (cur.home, cur.models_dir, cur.tractus_bin, cur.rec_bin) = (form.home, form.models_dir, form.tractus_bin, form.rec_bin);
    (cur.fake_recorder, cur.live_captions) = (form.fake_recorder, form.live_captions);
    cur.for_save()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, state: State<'_, AppState>, tray: State<'_, tray::TrayState>, settings: Settings) -> Result<(), String> {
    let settings = apply_form(state.settings(), settings);
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    patch_settings(&state.config_path, |_| Ok(raw))?;
    state.mcp.set_spawn(settings.mcp_spawn());
    *state.settings.lock().unwrap() = settings.clone();
    tray.apply(&app, &settings); // 메뉴 막대 아이콘 설정은 다시 시작하지 않아도 바로 적용된다
    Ok(())
}

/// 설정 파일의 rec_mode만 바꾼다. 파일이 없으면 rec_mode만 쓴다:
/// 모드 버튼 한 번에 환경변수에서 온 home 같은 기본값이 파일에 굳지 않게 한다.
fn merge_rec_mode(raw: Option<&str>, mode: &str) -> Result<String, String> {
    if !matches!(mode, "in_person" | "hybrid") {
        return Err(tv("알 수 없는 녹음 방식: {mode}", &[("mode", mode.to_string())]));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["rec_mode"] = json!(mode);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_rec_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    patch_settings(&state.config_path, |raw| merge_rec_mode(raw, &mode))?;
    state.settings.lock().unwrap().rec_mode = mode;
    Ok(())
}

/// 기본 변환 엔진 하나만 바꾼다. None이면 키를 지운다 (자동)
fn merge_asr_engine(raw: Option<&str>, id: Option<&str>) -> Result<String, String> {
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    match id {
        Some(id) if models::valid_id(id) => v["asr_engine"] = json!(id),
        Some(id) => return Err(tv("잘못된 변환 엔진 ID입니다: {id}", &[("id", id.to_string())])),
        None => {
            v.as_object_mut().map(|o| o.remove("asr_engine"));
        }
    }
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// 기본 변환 엔진 고르기 (모델 화면). 받아 두었는지는 코어가 변환할 때 본다
#[tauri::command]
pub fn set_asr_engine(state: State<'_, AppState>, id: Option<String>) -> Result<(), String> {
    patch_settings(&state.config_path, |raw| merge_asr_engine(raw, id.as_deref()))?;
    state.settings.lock().unwrap().asr_engine = id.unwrap_or_default();
    Ok(())
}

/// 설정 파일의 불리언 키 하나만 바꾼다 (merge_rec_mode와 같은 방식: 환경변수 기본값이 파일에 굳지 않게)
pub(crate) fn merge_flag(raw: Option<&str>, key: &str, value: bool) -> Result<String, String> {
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v[key] = json!(value);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// 화면 언어: 고른 값과 지금 언어 (화면은 시작할 때 이것으로 언어를 정한다)
#[tauri::command]
pub fn ui_lang(state: State<'_, AppState>) -> Value {
    json!({ "pref": state.settings().ui_lang, "lang": i18n::lang() })
}

/// 화면 언어를 바꾼다. 화면은 이 뒤에 다시 열린다. 메뉴 막대는 바로 새 언어로 다시 그린다
#[tauri::command]
pub fn set_ui_lang(app: AppHandle, state: State<'_, AppState>, tray: State<'_, tray::TrayState>, pref: String) -> Result<(), String> {
    patch_settings(&state.config_path, |raw| i18n::merge_ui_lang(raw, &pref))?;
    i18n::set(i18n::resolve(&pref, i18n::system_lang().as_deref()));
    state.settings.lock().unwrap().ui_lang = pref;
    tray.relabel(&app);
    Ok(())
}

#[tauri::command]
pub fn set_checkup_done(state: State<'_, AppState>, done: bool) -> Result<(), String> {
    patch_settings(&state.config_path, |raw| merge_flag(raw, "checkup_done", done))?;
    state.settings.lock().unwrap().checkup_done = done;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn settings_defaults_and_env() {
        let s = Settings { home: "~/Tractus".into(), models_dir: String::new(), ..Default::default() };
        assert!(s.tractus_bin.is_empty() && s.rec_bin.is_empty()); // 자동: 경로를 저장하지 않는다
        assert!(s.tractus_resolved().path.ends_with("/.venv/bin/tractus"));
        let env = s.child_env();
        assert!(env.iter().any(|(k, v)| k == "TRACTUS_HOME" && !v.starts_with('~')));
        assert!(!env.iter().any(|(k, _)| k == "TRACTUS_MODELS_DIR"));
        assert!(env.iter().any(|(k, v)| k == "TRACTUS_REC_BIN" && v.ends_with("/recorder/.build/release/tractus-rec")));
        // typer의 rich 오류 상자 대신 평문 "Error: …" 한 줄 (앱은 stderr 마지막 줄을 보여 준다)
        assert!(env.iter().any(|(k, v)| k == "TYPER_USE_RICH" && v == "0"));
        // 저장소 .venv 실행 파일이면 저장소 루트에서 실행 (.env.local을 읽도록)
        assert!(s.tractus_cwd().join("pyproject.toml").exists());
        let partial: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert_eq!(partial.home, "/x");
        assert!(partial.rec_bin.is_empty());
        assert_eq!(partial.rec_mode, "in_person"); // 예전 설정 파일에는 녹음 방식이 없다
        assert_eq!(partial.after_record, "ask"); // 예전 설정 파일에는 `녹음을 끝내면`이 없다: 매번 묻는다
    }

    /// 깨끗한 Mac(데이터 폴더가 아직 없음): 번들 코어를 부르기 전에 폴더가 만들어져 실행이 된다
    #[test]
    fn missing_home_is_created_so_the_core_can_run() {
        let home = std::env::temp_dir().join(format!("tractus-fresh-{}", std::process::id())).join("Tractus");
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
        paths::NO_AUTO.set(true);
        let s = Settings { tractus_bin: "/bin/echo".into(), home: home.to_string_lossy().into_owned(), ..Default::default() };
        let out = s.tractus(&["ok"]).output().expect("없는 폴더에서도 실행된다");
        assert!(out.status.success() && home.is_dir());
        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    /// 번들 배치(<앱>/Contents/Resources/runtime/bin/tractus)를 앱 해석기가 찾고, ~/Tractus 가 없는 Mac에서도 그 코어가 실제로 뜬다.
    /// 코어는 저장소가 없으니 .venv/bin 이 아니고, 실행 폴더는 (만들어 둔) 데이터 폴더다
    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
    #[test]
    fn bundled_core_spawns_on_a_mac_without_the_data_folder() {
        let root = std::env::temp_dir().join(format!("tractus-bundle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (exe, core) = (root.join("Tractus.app/Contents/MacOS/tractus-app"), root.join("Tractus.app/Contents/Resources/runtime/bin/tractus"));
        std::fs::create_dir_all(core.parent().unwrap()).unwrap();
        std::fs::write(&core, "#!/bin/sh\npwd -P\n").unwrap();
        std::fs::set_permissions(&core, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let home = root.join("fresh-home/Tractus"); // 아직 없음
        assert_eq!(paths::TRACTUS.resolve("", None, Some(&exe)).source, "bundle");
        let s = Settings { tractus_bin: core.to_string_lossy().into_owned(), home: home.to_string_lossy().into_owned(), ..Default::default() };
        assert!(!home.exists());
        let out = s.tractus(&["x"]).output().expect("번들 코어 실행이 ENOENT 없이 시작된다");
        assert!(out.status.success(), "{out:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), home.canonicalize().unwrap().to_string_lossy());
        assert!(s.tractus_cwd().is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn envs(c: &Command) -> HashMap<String, String> {
        c.get_envs().filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string()))).collect()
    }

    fn llm_env(s: &Settings, cfg: &Path, provider: Option<&str>, shell: impl Fn(&str) -> Option<String>) -> HashMap<String, String> {
        envs(&s.tractus_llm_with(&["summarize"], Some(cfg), provider, shell).unwrap())
    }

    fn profiles(items: &[(&str, &str, &str)]) -> BTreeMap<String, llm_key::Profile> {
        items.iter().map(|(p, b, m)| (p.to_string(), llm_key::Profile { base_url: b.to_string(), model: m.to_string() })).collect()
    }

    /// 저장된 API 키는 요약·질문 실행에만 들어간다 (llm_key.rs). 녹음·변환 등은 키를 보지 못한다. 예외는 스마트 검색을 Upstage로 쓰는 옵트인뿐이다 (아래 테스트)
    #[test]
    fn saved_key_reaches_only_llm_commands() {
        let root = std::env::temp_dir().join(format!("tractus-llmenv-{}", std::process::id()));
        let (home, cfg) = (root.join("home"), root.join("config"));
        std::fs::create_dir_all(&home).unwrap();
        paths::NO_AUTO.set(true); // 저장소의 .env가 끼지 않게: 없는 코어 경로면 데이터 폴더에서 실행한다
        let s = Settings { tractus_bin: "/x/tractus".into(), home: home.to_string_lossy().into_owned(), config_dir: Some(cfg.clone()), ..Default::default() };
        let none = |_: &str| None;
        let key = || llm_env(&s, &cfg, None, none);
        // 키가 없으면 지금까지와 똑같다
        assert_eq!(key(), envs(&s.tractus(&["summarize"])));
        llm_key::save(&cfg, "upstage", "test-key-123").unwrap();
        let e = key();
        assert_eq!((e["UPSTAGE_API_KEY"].as_str(), e["TRACTUS_LLM_PROVIDER"].as_str()), ("test-key-123", "upstage"));
        // .env.local이 다섯 서비스 중 하나를 정해 두어도 앱이 고른 서비스가 이긴다 (서비스·주소·AI 모델을 함께 싣는다)
        std::fs::write(home.join(".env.local"), "TRACTUS_LLM_PROVIDER=openai\nTRACTUS_LLM_BASE_URL=https://elsewhere.example.com/v1\nTRACTUS_LLM_MODEL=gpt-env\n").unwrap();
        let e = key();
        assert_eq!((e["UPSTAGE_API_KEY"].as_str(), e["TRACTUS_LLM_PROVIDER"].as_str(), e["TRACTUS_LLM_BASE_URL"].as_str()), ("test-key-123", "upstage", "https://api.upstage.ai/v1"));
        assert_eq!(e["TRACTUS_LLM_MODEL"], "solar-pro4"); // 환경이 다른 서비스(openai)를 정했으면 그 모델은 이 서비스에 가지 않는다
        // 환경이 같은 서비스를 정했으면 주소는 앱 것, AI 모델은 입력칸이 비었을 때 환경 것
        std::fs::write(home.join(".env.local"), "TRACTUS_LLM_PROVIDER=upstage\nTRACTUS_LLM_BASE_URL=https://elsewhere.example.com/v1\nTRACTUS_LLM_MODEL=solar-env\n").unwrap();
        let e = key();
        assert_eq!((e["TRACTUS_LLM_BASE_URL"].as_str(), e.get("TRACTUS_LLM_MODEL")), ("https://api.upstage.ai/v1", None));
        // 앱 밖의 서비스(gemma-local)를 환경이 정했으면 환경이 모두 정한다: 아무것도 싣지 않는다 (키도)
        std::fs::write(home.join(".env.local"), "TRACTUS_LLM_PROVIDER=gemma-local\n").unwrap();
        assert_eq!(key(), envs(&s.tractus(&["summarize"])));
        std::fs::remove_file(home.join(".env.local")).unwrap();
        // 셸(앱 프로세스)의 키는 덮어쓰지 않는다. 서비스는 앱이 정한다
        let shell = |k: &str| match k {
            "UPSTAGE_API_KEY" => Some("from-shell".to_string()),
            "TRACTUS_LLM_PROVIDER" => Some("claude".to_string()),
            _ => None,
        };
        let e = llm_env(&s, &cfg, None, shell);
        assert!(!e.contains_key("UPSTAGE_API_KEY") && e["TRACTUS_LLM_PROVIDER"] == "upstage");
        // 키를 지우면 다시 들어가지 않는다
        llm_key::delete(&cfg, "upstage").unwrap();
        assert_eq!(key(), envs(&s.tractus(&["summarize"])));
        // 키가 있어도 일반 실행·MCP·녹음 환경에는 없다 (이 Mac 방식이 기본이다)
        llm_key::save(&cfg, "upstage", "test-key-123").unwrap();
        let has_key = |env: &[(String, String)]| env.iter().any(|(k, v)| k.contains("API_KEY") || v.contains("test-key-123"));
        assert!(!has_key(&s.child_env()) && !has_key(&s.mcp_spawn().env));
        assert!(s.child_env().contains(&("TRACTUS_EMBED".into(), "local".into()))); // .env의 TRACTUS_EMBED가 뒤집지 못하게 늘 정한다
        assert!(!envs(&s.tractus(&["index"])).values().any(|v| v.contains("test-key-123")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 스마트 검색을 Upstage로 쓰는 옵트인: 그때만, Upstage 키만 색인·검색 프로세스(MCP 포함)에 실린다. 다른 서비스의 키는 어느 경우에도 없다
    #[test]
    fn upstage_search_opt_in_is_the_only_way_a_key_reaches_the_search_processes() {
        let root = std::env::temp_dir().join(format!("tractus-embenv-{}", std::process::id()));
        let (home, cfg) = (root.join("home"), root.join("config"));
        std::fs::create_dir_all(&home).unwrap();
        paths::NO_AUTO.set(true);
        for p in ["upstage", "openai", "gemini"] {
            llm_key::save(&cfg, p, &format!("key-for-{p}-0000")).unwrap();
        }
        let base = Settings { tractus_bin: "/x/tractus".into(), home: home.to_string_lossy().into_owned(), config_dir: Some(cfg.clone()), ..Default::default() };
        let on = Settings { embedding_provider: "upstage".into(), ..base.clone() };
        let secrets = |env: &[(String, String)]| env.iter().filter(|(k, v)| k.contains("API_KEY") || v.contains("key-for-")).map(|(k, _)| k.clone()).collect::<Vec<_>>();
        let cmd_env = |c: &Command| c.get_envs().filter_map(|(k, v)| Some((k.to_str()?.to_string(), v?.to_str()?.to_string()))).collect::<Vec<_>>();
        assert!(secrets(&base.mcp_spawn().env).is_empty() && secrets(&base.child_env()).is_empty() && secrets(&cmd_env(&base.tractus_embed(&["index"]))).is_empty());
        // 키가 가는 곳: 색인·변환·가져오기, 요약·질문(색인·검색), 상주 검색 프로세스
        let keyed = [on.mcp_spawn().env, cmd_env(&on.tractus_embed(&["index"])), cmd_env(&on.tractus_llm(&["ask"], Some("upstage")).unwrap()), on.embed_key_env(|_| None)];
        for env in keyed {
            assert_eq!(secrets(&env).iter().filter(|k| *k == "UPSTAGE_API_KEY").count(), 1);
            assert!(env.contains(&("UPSTAGE_API_KEY".into(), "key-for-upstage-0000".into())));
            assert!(!env.iter().any(|(_, v)| v.contains("key-for-openai") || v.contains("key-for-gemini"))); // 다른 서비스의 키는 어느 경우에도 없다
            assert!(env.contains(&("UPSTAGE_BASE_URL".into(), "https://api.upstage.ai/v1".into()))); // 노트 폴더 .env의 주소가 키를 받지 못하게 늘 정한다
        }
        // 그 밖의 모든 실행(녹음 프로그램 포함: child_env, 화자·내보내기 등: tractus)에는 키도 주소도 없고 방식만 있다
        for env in [on.child_env(), cmd_env(&on.tractus(&["speakers"]))] {
            assert!(secrets(&env).is_empty() && !env.iter().any(|(k, _)| k == "UPSTAGE_BASE_URL"));
            assert!(env.contains(&("TRACTUS_EMBED".into(), "upstage".into())));
        }
        // Upstage에 저장한 주소를 쓴다. 셸의 값이 먼저다
        let gw = Settings { llm_profiles: profiles(&[("upstage", "https://gw.example.com/v1", "")]), ..on.clone() };
        assert!(gw.embed_key_env(|_| None).contains(&("UPSTAGE_BASE_URL".into(), "https://gw.example.com/v1".into())));
        let shell = |k: &str| (k == "UPSTAGE_API_KEY" || k == "UPSTAGE_BASE_URL").then(|| "from-shell".to_string());
        assert!(on.embed_key_env(shell).is_empty());
        // 키가 없으면 방식만 싣는다 (코어는 단어 일치로만 찾는다)
        llm_key::delete(&cfg, "upstage").unwrap();
        assert!(secrets(&on.mcp_spawn().env).is_empty() && secrets(&cmd_env(&on.tractus_embed(&["index"]))).is_empty() && on.child_env().contains(&("TRACTUS_EMBED".into(), "upstage".into())));
        // 설정 파일의 모르는 값은 이 Mac 방식
        assert_eq!(Settings::load(Some(r#"{"embedding_provider": "../x"}"#)).embedding_provider, "local");
        assert_eq!(Settings::load(Some(r#"{"embedding_provider": "upstage"}"#)).embedding_provider, "upstage");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 서비스마다 자기 환경변수에만, 고른 서비스의 키·주소·AI 모델만 싣는다. 다른 서비스의 키는 파일에 있어도 싣지 않는다. 녹음·일반 실행에는 어느 서비스 키도 없다
    #[test]
    fn injection_follows_the_selected_provider() {
        let root = std::env::temp_dir().join(format!("tractus-llmsel-{}", std::process::id()));
        let (home, cfg) = (root.join("home"), root.join("config"));
        std::fs::create_dir_all(&home).unwrap();
        paths::NO_AUTO.set(true);
        let none = |_: &str| None;
        let base = Settings { tractus_bin: "/x/tractus".into(), home: home.to_string_lossy().into_owned(), config_dir: Some(cfg.clone()), ..Default::default() };
        for p in ["upstage", "openai", "claude", "gemini", "custom"] {
            llm_key::save(&cfg, p, &format!("key-for-{p}-0000")).unwrap();
        }
        let vars = ["UPSTAGE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "TRACTUS_LLM_API_KEY"];
        // 서비스마다 다른 주소·AI 모델을 저장해 두고, 요청마다 그 서비스의 것만 간다
        let all = ["upstage", "openai", "claude", "gemini", "custom"];
        let prof: Vec<(String, String)> = all.iter().map(|p| (format!("https://{p}.example.com/v1"), format!("m-{p}"))).collect();
        let s = Settings { llm_profiles: profiles(&all.iter().zip(&prof).map(|(p, (b, m))| (*p, b.as_str(), m.as_str())).collect::<Vec<_>>()), ..base.clone() };
        for (i, p) in all.iter().enumerate() {
            let e = llm_env(&s, &cfg, Some(p), none);
            assert_eq!(e[vars[i]], format!("key-for-{p}-0000"), "{p}");
            assert_eq!(vars.iter().filter(|v| e.contains_key(**v)).count(), 1, "{p}: 선택한 서비스의 키만");
            assert_eq!((e["TRACTUS_LLM_PROVIDER"].as_str(), e["TRACTUS_LLM_BASE_URL"].as_str(), e["TRACTUS_LLM_MODEL"].as_str()), (*p, prof[i].0.as_str(), prof[i].1.as_str()));
            // 다른 실행에는 키도 주소도 없다
            let has_key = |env: &[(String, String)]| env.iter().any(|(k, v)| k.contains("API_KEY") || v.contains("key-for-") || k.starts_with("TRACTUS_LLM_"));
            assert!(!has_key(&s.child_env()) && !has_key(&s.mcp_spawn().env), "{p}");
            let plain = envs(&s.tractus(&["index"]));
            assert!(!plain.keys().any(|k| k.contains("API_KEY") || k.starts_with("TRACTUS_LLM_")) && !plain.values().any(|v| v.contains("key-for-")), "{p}");
        }
        // 서비스를 정하지 않으면 기본 서비스 (등록된 것 중에서)
        let d = Settings { llm_default: "gemini".into(), ..s.clone() };
        assert_eq!(llm_env(&d, &cfg, None, none)["TRACTUS_LLM_PROVIDER"], "gemini");
        assert_eq!(d.registered(), all);
        assert!(s.llm_choice(Some("../x")).is_err() && s.tractus_llm(&["x"], Some("gemma-local")).is_err());
        // 기본 서비스가 등록돼 있지 않으면 등록된 첫 서비스
        llm_key::delete(&cfg, "gemini").unwrap();
        assert_eq!((d.default_provider(), d.registered().contains(&"gemini")), ("upstage", false));
        // AI 모델이 비어 있으면 싣지 않는다 (서비스 기본값). 주소가 비어 있으면 서비스 기본 주소를 싣는다:
        // 노트 폴더 .env의 TRACTUS_LLM_BASE_URL이 키를 받지 못하게 (프로세스 환경변수는 dotenv 값이 덮지 못한다)
        std::fs::write(home.join(".env"), "TRACTUS_LLM_BASE_URL=http://127.0.0.1:9/v1\nCLAUDE_BASE_URL=http://127.0.0.1:9/v1\n").unwrap();
        let e = llm_env(&base, &cfg, Some("claude"), none);
        assert!(!e.contains_key("TRACTUS_LLM_MODEL") && e["TRACTUS_LLM_PROVIDER"] == "claude");
        assert_eq!(e["TRACTUS_LLM_BASE_URL"], "https://api.anthropic.com/v1");
        std::fs::remove_file(home.join(".env")).unwrap();
        // 키 없는 서비스를 골라도 다른 서비스의 키를 대신 싣지 않는다
        llm_key::delete(&cfg, "claude").unwrap();
        let e = llm_env(&base, &cfg, Some("claude"), none);
        assert!(!e.keys().any(|k| k.contains("API_KEY")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 새 설정 항목은 더하기만 했다: 예전 settings.json은 그대로 읽히고 Upstage가 기본이다. 한 서비스만 저장하던 예전 값은 그 서비스의 프로필이 된다
    #[test]
    fn llm_settings_defaults_and_migration() {
        let old = Settings::load(Some(r#"{"home": "/x", "rec_mode": "hybrid", "after_record": "later"}"#));
        assert_eq!((old.llm_default.as_str(), old.llm_profiles.len(), old.embedding_provider.as_str()), ("upstage", 0, "local"));
        assert_eq!((old.home.as_str(), old.rec_mode.as_str()), ("/x", "hybrid"));
        let sel = Settings::load(Some(r#"{"llm_provider": "claude", "llm_base_url": "https://x.example.com/v1", "llm_model": "claude-x"}"#));
        assert_eq!(sel.llm_default, "claude");
        assert_eq!(sel.llm_profiles["claude"], llm_key::Profile { base_url: "https://x.example.com/v1".into(), model: "claude-x".into() });
        assert_eq!(sel.llm_choice(Some("claude")).unwrap().model, "claude-x");
        assert_eq!(sel.llm_choice(Some("openai")).unwrap().model, ""); // 다른 서비스는 기본값
        // 새 형식은 그대로, 손으로 고친 모르는 서비스는 기본으로
        let new = Settings::load(Some(r#"{"llm_default": "gemini", "llm_profiles": {"gemini": {"model": "gemini-flash-latest"}, "../x": {"model": "y"}}}"#));
        assert_eq!((new.llm_default.as_str(), new.llm_profiles.len(), new.llm_profiles["gemini"].base_url.as_str()), ("gemini", 1, ""));
        assert_eq!(Settings::load(Some(r#"{"llm_provider": "../etc"}"#)).llm_default, "upstage");
        assert_eq!(Settings::load(Some(r#"{"llm_default": "../etc"}"#)).llm_default, "upstage");
        assert_eq!(Settings::load(None).llm_default, "upstage");
        // 파일에 쓰면 키는 없고 선택만 있다 (예전 필드도, 설정 폴더 경로도 없다)
        let raw = serde_json::to_string(&sel.for_save()).unwrap();
        assert!(raw.contains("llm_profiles") && !raw.contains("key") && !raw.contains("llm_provider") && !raw.contains("config_dir"));
    }

    /// 연결 테스트·모델 목록: `tractus llm test|models`를 인수 없이 (서비스·주소·AI 모델은 환경변수로) 돌리고 키를 선택한 서비스의 변수에만 싣는다. 코어는 가짜 스크립트
    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
    #[test]
    fn llm_test_runs_the_core_with_injected_env() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("tractus-llmtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (home, cfg, bin) = (root.join("home"), root.join("config"), root.join("fake-tractus"));
        std::fs::create_dir_all(&home).unwrap();
        paths::NO_AUTO.set(true);
        // 받은 인수와 환경을 JSON 한 줄로 돌려준다. 키는 있다는 사실만 (값은 출력하지 않는다)
        let script = |ok: bool| {
            let body = if ok {
                r#"if [ "$2" = models ]; then printf '{"models": ["%s"]}\n' "$TRACTUS_LLM_PROVIDER"; else printf '{"ok": true, "provider": "%s", "model": "%s", "host": "%s", "latency_ms": 7}\n' "$TRACTUS_LLM_PROVIDER" "$*" "${ANTHROPIC_API_KEY:+key-set}${OPENAI_API_KEY:+WRONG}"; fi"#
            } else {
                r#"printf '{"event":"error","message":"boom","code":"llm_auth"}\n'; exit 1"#
            };
            std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let s = Settings { tractus_bin: bin.to_string_lossy().into_owned(), home: home.to_string_lossy().into_owned(), llm_default: "openai".into(), llm_profiles: profiles(&[("claude", "", "claude-x")]), config_dir: Some(cfg.clone()), ..Default::default() };
        let none = |_: &str| None;
        llm_key::save(&cfg, "claude", "test-key-123").unwrap();
        llm_key::save(&cfg, "openai", "other-key-4567").unwrap();
        script(true);
        // 고른 서비스(claude)로 돈다: 기본 서비스(openai)가 아니라
        let r = llm_key::run_test_for(&s, Some(&cfg), Some("claude"), none).unwrap();
        assert!(r.ok && r.provider.as_deref() == Some("claude"));
        assert_eq!(r.model.as_deref(), Some("llm test")); // 인수는 `llm test`뿐
        assert_eq!(r.host.as_deref(), Some("key-set")); // 키는 선택한 서비스의 변수에만
        assert_eq!(llm_key::run_models_for(&s, Some(&cfg), Some("claude"), none).unwrap().models, ["claude"]);
        assert_eq!(llm_key::run_models_for(&s, Some(&cfg), None, none).unwrap().models, ["openai"]); // 없으면 기본 서비스
        // 실패: 코어의 코드와 문구가 그대로 온다
        script(false);
        let r = llm_key::run_test_for(&s, Some(&cfg), Some("claude"), none).unwrap();
        assert_eq!((r.ok, r.code.as_deref(), r.message.as_deref()), (false, Some("llm_auth"), Some("boom")));
        let m = llm_key::run_models_for(&s, Some(&cfg), Some("claude"), none).unwrap();
        assert_eq!((m.models.len(), m.code.as_deref(), m.message.as_deref()), (0, Some("llm_auth"), Some("boom")));
        // 직접 입력: 이 Mac이 아닌 주소에 키가 없으면 실행하지 않고 설정 오류
        let custom = Settings { llm_profiles: profiles(&[("custom", "https://gw.example.com/v1", "")]), ..s.clone() };
        let r = llm_key::run_test_for(&custom, Some(&cfg), Some("custom"), none).unwrap();
        assert_eq!(r.code.as_deref(), Some("llm_config"));
        assert_eq!(llm_key::run_models_for(&custom, Some(&cfg), Some("custom"), none).unwrap().code.as_deref(), Some("llm_config"));
        // 이 Mac 주소는 키 없이도 실행한다
        script(true);
        let local = Settings { llm_profiles: profiles(&[("custom", "http://localhost:11434/v1", "")]), ..s.clone() };
        assert!(llm_key::run_test_for(&local, Some(&cfg), Some("custom"), none).unwrap().ok);
        // 모르는 서비스는 실행하지 않는다. 실행 파일이 없으면 오류 (첫 줄은 화면 문장)
        assert!(llm_key::run_test_for(&local, Some(&cfg), Some("../x"), none).is_err());
        let missing = Settings { tractus_bin: "/no/such/tractus".into(), ..local };
        assert!(llm_key::run_test_for(&missing, Some(&cfg), Some("custom"), none).unwrap_err().contains("실행할 수 없습니다"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn asr_engine_is_passed_to_transcribe_only() {
        let mut s = Settings { asr_engine: "custom-buzzasr-korean".into(), ..Settings::default() };
        let v = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(s.with_asr_engine(v(&["transcribe", "--recording", "/r", "--progress-json"])), v(&["transcribe", "--recording", "/r", "--progress-json", "--engine", "custom-buzzasr-korean"]));
        assert_eq!(s.with_asr_engine(v(&["summarize", "01A"])), v(&["summarize", "01A"]));
        s.asr_engine = String::new(); // 자동
        assert_eq!(s.with_asr_engine(v(&["transcribe", "x"])), v(&["transcribe", "x"]));
        s.asr_engine = "--bad".into();
        assert_eq!(s.with_asr_engine(v(&["transcribe", "x"])), v(&["transcribe", "x"]));
    }

    #[test]
    fn asr_engine_setting_is_merged_and_cleared() {
        let set = merge_asr_engine(Some(r#"{"ui_lang":"ko"}"#), Some("asr-lite")).unwrap();
        let v: Value = serde_json::from_str(&set).unwrap();
        assert_eq!((v["asr_engine"].as_str(), v["ui_lang"].as_str()), (Some("asr-lite"), Some("ko")));
        let cleared: Value = serde_json::from_str(&merge_asr_engine(Some(&set), None).unwrap()).unwrap();
        assert!(cleared.get("asr_engine").is_none() && cleared["ui_lang"] == "ko");
        assert!(merge_asr_engine(None, Some("a b")).is_err());
    }

    #[test]
    fn rec_mode_saves_only_its_key() {
        // 파일이 없으면 rec_mode만 쓴다 (home 등 기본값을 굳히지 않는다)
        let v: Value = serde_json::from_str(&merge_rec_mode(None, "hybrid").unwrap()).unwrap();
        assert_eq!(v, json!({"rec_mode": "hybrid"}));
        // 있으면 다른 값은 그대로 둔다
        let v: Value = serde_json::from_str(&merge_rec_mode(Some(r#"{"home":"/x","rec_mode":"hybrid"}"#), "in_person").unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "rec_mode": "in_person"}));
        assert!(merge_rec_mode(None, "../etc").is_err());
    }

    #[test]
    fn checkup_flag_saves_only_its_key_and_defaults_to_not_done() {
        let v: Value = serde_json::from_str(&merge_flag(None, "checkup_done", true).unwrap()).unwrap();
        assert_eq!(v, json!({"checkup_done": true}));
        let v: Value = serde_json::from_str(&merge_flag(Some(r#"{"home":"/x","checkup_done":false}"#), "checkup_done", true).unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "checkup_done": true}));
        // 깨진 파일은 새로 쓴다 (설정을 읽지 못해도 점검 표시는 남는다)
        assert_eq!(serde_json::from_str::<Value>(&merge_flag(Some("not json"), "checkup_done", true).unwrap()).unwrap(), json!({"checkup_done": true}));
        // 예전 설정 파일에는 키가 없다: 아직 안 본 것으로 읽는다
        let old: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(!old.checkup_done);
    }

    fn tmp_file(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("tractus-settings-{name}-{}", std::process::id()));
        std::fs::write(&p, "").unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn load_missing_or_broken_file_is_auto() {
        for raw in [None, Some("not json"), Some("{}")] {
            let s = Settings::load(raw);
            assert!(s.tractus_bin.is_empty() && s.rec_bin.is_empty() && s.stale.is_empty(), "{raw:?}");
        }
    }

    #[test]
    fn load_turns_a_missing_saved_path_into_auto_and_reports_it() {
        let alive = tmp_file("alive");
        let raw = json!({"tractus_bin": "/nonexistent/old/tractus", "rec_bin": alive, "home": "/x"}).to_string();
        let s = Settings::load(Some(&raw));
        assert_eq!((s.tractus_bin.as_str(), s.rec_bin.as_str(), s.home.as_str()), ("", alive.as_str(), "/x")); // 있는 직접 지정은 그대로
        assert_eq!(s.stale, ["tractus_bin"]);
    }

    #[test]
    fn load_turns_a_saved_default_into_auto_without_a_report() {
        // 예전 앱이 저장한 기본값: 컴파일할 때 소스 위치의 코어 (이 저장소에는 .venv가 있다)
        let default = paths::TRACTUS.auto(None).into_iter().find(|(src, _)| *src == "repo").unwrap().1;
        if !default.is_file() {
            return; // 빌드하지 않은 저장소에서는 없는 경로라 위 시험(stale)과 같다
        }
        let s = Settings::load(Some(&json!({"tractus_bin": default}).to_string()));
        assert!(s.tractus_bin.is_empty() && s.stale.is_empty());
    }

    #[test]
    fn save_never_pins_resolved_defaults_but_keeps_what_the_user_typed() {
        let mine = tmp_file("mine");
        let default = paths::TRACTUS.auto(None).into_iter().find(|(src, _)| *src == "repo").unwrap().1.to_string_lossy().into_owned();
        let saved = Settings { tractus_bin: default, rec_bin: mine.clone(), stale: vec!["x".into()], ..Default::default() }.for_save();
        assert_eq!((saved.tractus_bin.as_str(), saved.rec_bin.as_str()), ("", mine.as_str()));
        assert!(saved.stale.is_empty());
        // 파일에는 stale이 없고, 자동은 빈 문자열로 남는다
        let raw = serde_json::to_string(&saved).unwrap();
        assert!(!raw.contains("stale") && raw.contains(r#""tractus_bin":"""#));
        // 아직 없는 경로를 직접 입력하면 저장은 한다 (다음 실행 때 load가 자동으로 되돌린다)
        assert_eq!(Settings { tractus_bin: "/typed/not/yet".into(), ..Default::default() }.for_save().tractus_bin, "/typed/not/yet");
    }

    #[test]
    fn the_settings_form_saves_only_its_own_keys() {
        // 설정 화면을 연 뒤 사이드바에서 바꾼 정렬·시작 점검을 옛 화면 값이 되돌리지 않는다
        let cur = Settings { list_sort: "title".into(), checkup_done: true, home: "/old".into(), ..Settings::default() };
        let form = Settings { list_sort: "updated".into(), checkup_done: false, home: "/new".into(), live_captions: true, ..Settings::default() };
        let out = apply_form(cur, form);
        assert_eq!((out.home.as_str(), out.live_captions), ("/new", true));
        assert_eq!((out.list_sort.as_str(), out.checkup_done), ("title", true));
    }

    #[test]
    fn settings_writes_are_atomic_and_never_lose_a_concurrent_key() {
        let dir = std::env::temp_dir().join(format!("tractus-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        let threads: Vec<_> = (0..8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || patch_settings(&path, |raw| merge_flag(raw, &format!("k{n}"), true)).unwrap())
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!((0..8).all(|n| v[format!("k{n}")] == true), "{v}");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1); // 임시 파일이 남지 않는다
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
