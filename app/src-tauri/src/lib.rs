//! Tractus 데스크톱 앱 (docs/desktop.md §3). 파일은 직접 읽고, 검색만 상주 `tractus mcp`로 한다.

mod ask;
mod attach;
mod deferred;
mod llm_key;
mod mcp;
mod media;
mod meetings;
mod models;
mod organize;
mod paths;
mod procs;
mod removal;
mod summaries;
mod tray;
mod voices;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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
    /// 녹음을 끝내면: "ask"(매번 묻기) | "convert"(바로 텍스트로 변환) | "later"(노트로 저장만 하고 나중에 변환). 모르는 값은 화면이 "ask"로 읽는다 (docs/desktop.md §3.3)
    pub after_record: String,
    /// 요약·질문에서 서비스를 따로 고르지 않을 때 쓰는 AI 서비스 (llm_key::PROVIDERS의 이름). 키는 settings.json이 아니라 서비스별 파일에 있다 (llm_key.rs)
    pub llm_default: String,
    /// 서비스마다 주소·AI 모델 (비어 있으면 서비스 기본값). 예전 설정의 `llm_provider` 등은 읽을 때 여기로 옮긴다 (llm_key::migrate_llm)
    pub llm_profiles: BTreeMap<String, llm_key::Profile>,
    /// 스마트 검색 방식: "local"(이 Mac, 기본) | "upstage"(문장·검색어를 Upstage로 보낸다. 옵트인)
    pub embedding_provider: String,
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
            after_record: "ask".into(),
            llm_default: llm_key::DEFAULT_PROVIDER.into(),
            llm_profiles: BTreeMap::new(),
            embedding_provider: "local".into(),
            config_dir: None,
            stale: vec![],
        }
    }
}

fn expand(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(h)) => PathBuf::from(h).join(rest),
        _ => PathBuf::from(p),
    }
}

impl Settings {
    fn home(&self) -> PathBuf {
        expand(&self.home)
    }

    /// 설정 파일을 읽는다. 없거나 깨졌으면 기본값. 저장된 코어·녹음 프로그램 경로가 없는 파일이면 자동으로 되돌리고 `stale`에 남긴다
    /// (파일 자체는 다음 저장 때 고쳐진다). 자동 후보와 같은 값(예전에 기본값을 저장한 것)은 조용히 자동으로 바꾼다
    fn load(raw: Option<&str>) -> Settings {
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
    fn for_save(mut self) -> Settings {
        for (field, bin) in [(&mut self.tractus_bin, &paths::TRACTUS), (&mut self.rec_bin, &paths::REC)] {
            if bin.is_default(field) {
                field.clear();
            }
        }
        self.stale.clear();
        self
    }

    fn tractus_resolved(&self) -> paths::Resolved {
        paths::TRACTUS.find(&self.tractus_bin)
    }

    fn rec_resolved(&self) -> paths::Resolved {
        paths::REC.find(&self.rec_bin)
    }

    fn tractus_path(&self) -> PathBuf {
        PathBuf::from(self.tractus_resolved().path)
    }

    fn rec_path(&self) -> PathBuf {
        PathBuf::from(self.rec_resolved().path)
    }

    /// 하위 프로세스에 명시적으로 넘기는 환경변수.
    fn child_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("TRACTUS_HOME".into(), self.home().to_string_lossy().into_owned()),
            // GUI 앱의 PATH에는 Homebrew가 없다. ffmpeg를 찾으려면 넣어야 한다
            ("PATH".into(), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("PYTHONUNBUFFERED".into(), "1".into()), // 진행 이벤트가 버퍼에 묶이지 않게
            ("PYTHONIOENCODING".into(), "utf-8".into()),
            // 오류를 rich 상자 대신 평문 한 줄로 (stderr 마지막 줄을 그대로 보여 준다)
            ("TYPER_USE_RICH".into(), "0".into()),
        ];
        if !self.models_dir.is_empty() {
            env.push(("TRACTUS_MODELS_DIR".into(), expand(&self.models_dir).to_string_lossy().into_owned()));
        }
        // `doctor`가 앱이 쓰는 녹음 프로그램을 보게 한다 (자동으로 찾은 경로가 코어의 기본 경로와 다를 수 있다)
        env.push(("TRACTUS_REC_BIN".into(), self.rec_resolved().path));
        env.push(self.embed_mode());
        env
    }

    /// 스마트 검색 방식. 앱이 정한다: `.env`의 TRACTUS_EMBED가 이 선택을 뒤집지 못하게 모든 실행에 늘 싣는다 (뒤집히면 노트 내용이 Upstage로 가거나, 벡터가 계속 다시 만들어진다)
    fn embed_mode(&self) -> (String, String) {
        ("TRACTUS_EMBED".into(), if self.embedding_provider == "upstage" { "upstage" } else { "local" }.into())
    }

    /// 옵트인(upstage)일 때만 Upstage 키와 주소. 이것이 "키는 요약·질문 실행에만"의 유일한 예외다: 노트 문장·검색어를 임베딩하는 실행(색인, 변환·가져오기·요약 뒤의 색인, 질문의 검색)과
    /// 상주 검색 프로세스에만 `tractus_embed`·`llm_cmd`·`mcp_spawn`이 싣는다. 녹음·화자·내보내기 등 나머지 실행(child_env)에는 없다.
    /// 셸에 이미 있는 값은 덮어쓰지 않는다. 주소는 Upstage 서비스에 저장한 주소, 없으면 기본 주소 (노트 폴더 .env의 UPSTAGE_BASE_URL이 키를 받지 못하게 늘 정한다)
    fn embed_key_env(&self, shell: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
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

    fn upstage_base_url(&self) -> String {
        let stored = self.llm_profiles.get("upstage").map_or("", |p| p.base_url.as_str());
        if stored.is_empty() { llm_key::default_url("upstage").unwrap_or_default().into() } else { stored.into() }
    }

    fn key_saved(&self, provider: &str) -> bool {
        self.config_dir.as_deref().and_then(|d| llm_key::load(d, provider)).is_some()
    }

    /// 지금 쓸 수 있는 서비스 (키가 있거나 이 Mac 주소의 직접 입력), 표의 순서대로
    fn registered(&self) -> Vec<&'static str> {
        llm_key::provider_ids().filter(|p| llm_key::usable(p, self.llm_profiles.get(*p).map_or("", |x| x.base_url.as_str()), self.key_saved(p))).collect()
    }

    /// 요약·질문의 기본 서비스: 고른 서비스가 등록돼 있으면 그것, 아니면 등록된 첫 서비스, 하나도 없으면 고른 서비스
    fn default_provider(&self) -> &'static str {
        let chosen = llm_key::canonical(&self.llm_default).unwrap_or(llm_key::DEFAULT_PROVIDER);
        let reg = self.registered();
        if reg.contains(&chosen) { chosen } else { reg.first().copied().unwrap_or(chosen) }
    }

    /// tractus CLI는 현재 폴더의 .env/.env.local(API 키)을 읽는다. 저장소 .venv의 실행 파일이면 저장소 루트에서 실행한다.
    fn tractus_cwd(&self) -> PathBuf {
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

    fn tractus<S: AsRef<OsStr>>(&self, args: &[S]) -> Command {
        let mut cmd = Command::new(self.tractus_path());
        cmd.args(args).envs(self.child_env()).current_dir(self.tractus_cwd());
        cmd
    }

    /// 노트 문장·검색어를 임베딩하는 실행 (색인·변환·가져오기). 스마트 검색을 Upstage로 쓰면 그 키가 더해진다 (`embed_key_env`)
    fn tractus_embed<S: AsRef<OsStr>>(&self, args: &[S]) -> Command {
        let mut cmd = self.tractus(args);
        cmd.envs(self.embed_key_env(|k| std::env::var(k).ok()));
        cmd
    }

    /// 요약·질문처럼 AI 서비스를 부르는 실행만 쓴다 (녹음·변환은 `tractus`). provider: 이번에 고른 서비스 (없으면 기본). 그 서비스의 키를 환경변수로만 넘긴다 (llm_key.rs)
    fn tractus_llm<S: AsRef<OsStr>>(&self, args: &[S], provider: Option<&str>) -> Result<Command, String> {
        let mut cmd = self.tractus_llm_with(args, self.config_dir.as_deref(), provider, |k| std::env::var(k).ok())?;
        cmd.envs(self.embed_key_env(|k| std::env::var(k).ok())); // 요약 뒤 색인·질문의 검색이 임베딩한다 (옵트인일 때만)
        Ok(cmd)
    }

    fn tractus_llm_with<S: AsRef<OsStr>>(&self, args: &[S], config_dir: Option<&Path>, provider: Option<&str>, env: impl Fn(&str) -> Option<String>) -> Result<Command, String> {
        let mut cmd = self.tractus(args);
        let choice = self.llm_choice(provider)?;
        let key = config_dir.and_then(|d| llm_key::load(d, choice.provider));
        let set = ask::llm_config(&[&self.tractus_cwd(), &self.home()], &env);
        cmd.envs(llm_key::env(&choice, key.as_deref(), &env, &set));
        Ok(cmd)
    }

    /// 이번에 고른 AI 서비스(없으면 기본 서비스)와 그 서비스에 저장한 주소·AI 모델. 모르는 서비스는 오류
    fn llm_choice(&self, provider: Option<&str>) -> Result<llm_key::Choice<'_>, String> {
        let provider = match provider {
            Some(p) => llm_key::canonical(p).ok_or_else(|| format!("알 수 없는 AI 서비스입니다: {p}"))?,
            None => self.default_provider(),
        };
        let profile = self.llm_profiles.get(provider);
        Ok(llm_key::Choice { provider, base_url: profile.map_or("", |p| &p.base_url), model: profile.map_or("", |p| &p.model) })
    }

    fn mcp_spawn(&self) -> mcp::Spawn {
        mcp::Spawn {
            program: self.tractus_path(),
            args: vec!["mcp".into()],
            env: self.child_env().into_iter().chain(self.embed_key_env(|k| std::env::var(k).ok())).collect(),
            cwd: Some(self.tractus_cwd()),
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    config_path: PathBuf,
    mcp: Arc<mcp::McpClient>,
    rec: Arc<Mutex<Option<ChildStdin>>>,
    /// 진행 중인 질문과 변환 전 노트의 변환 (작업 ID → 프로세스). 멈추기(ask_cancel)가 kill한다
    asks: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    /// 녹음 중 실시간 자막 프로세스. 녹음이 끝나면(stopped·exit) 정식 전사보다 먼저 끝낸다
    live: LiveSlot,
    /// 지금 쓰는 중인 대상 (작업·질문·녹음 ID → 노트 ID 또는 녹음 폴더). 삭제가 이 대상을 거절한다
    busy: Busy,
    /// 돌고 있는 백그라운드 검색 정보 갱신 프로세스. 변환·녹음·질문이 시작하면 kill해 임베딩 모델이 겹쳐 올라가지 않게 한다 (다음 갱신이 이어서 한다)
    index: IndexSlot,
}

type IndexSlot = Arc<Mutex<Option<Arc<Mutex<Child>>>>>;

/// 갱신 중인 검색 정보 프로세스를 멈춘다. 없으면 아무 일도 없다. 먼저 `hold`로 자기 표시를 한 뒤 부른다
/// (그 뒤에 시작하는 갱신은 `new_if_idle`에서 비켜 가고, 이미 시작한 갱신은 아래에서 멈춘다)
fn cancel_index(slot: &IndexSlot) {
    if let Some(child) = slot.lock().unwrap().as_ref() {
        // 대기 스레드가 이미 wait 중이면 끝나는 중이다
        if let Ok(mut c) = child.try_lock() {
            let _ = c.kill();
        }
    }
}

type Busy = Arc<Mutex<HashMap<String, String>>>;

/// 대상이 지금 쓰이는 중인지
fn is_busy(busy: &Busy, target: &str) -> bool {
    busy.lock().unwrap().values().any(|t| t == target)
}

/// 대상을 쓰는 중으로 표시하고 풀 때 쓸 키를 돌려준다 (프로세스가 끝나는 exit 이벤트나 시작 실패 때 `release`)
fn hold(busy: &Busy, target: &str) -> String {
    let key = ulid::Ulid::new().to_string();
    busy.lock().unwrap().insert(key.clone(), target.to_string());
    key
}

fn release(busy: &Busy, key: &str) {
    busy.lock().unwrap().remove(key);
}

/// 짧은 명령(문장 수정·참석자 편집·내보내기·목소리 등록)이 노트를 쓰는 동안 노트를 쓰는 중으로 표시한다. 놓으면(Drop) 풀린다.
/// 삭제는 이 표시가 있으면 거절한다 (앱은 먼저 수정 줄을 비우지만, 그 사이를 뚫은 호출이 폴더가 사라진 뒤에 '노트 없음'으로 실패하지 않게)
struct BusyGuard {
    busy: Busy,
    key: String,
}

impl BusyGuard {
    fn new(busy: &Busy, target: &str) -> Self {
        BusyGuard { busy: busy.clone(), key: hold(busy, target) }
    }

    /// 아무것도 쓰이지 않을 때만 잡는다. 확인과 표시를 한 번의 잠금 안에서 하므로 동시에 둘이 잡을 수 없다
    fn new_if_idle(busy: &Busy, target: &str) -> Option<Self> {
        let mut m = busy.lock().unwrap();
        if !m.is_empty() {
            return None;
        }
        let key = ulid::Ulid::new().to_string();
        m.insert(key.clone(), target.to_string());
        Some(BusyGuard { busy: busy.clone(), key })
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        release(&self.busy, &self.key);
    }
}

/// 가져오기 작업이 쓰는 표시 대상 (노트 ID나 녹음 폴더가 아니므로 삭제를 막지 않는다)
const IMPORT_TARGET: &str = "<import>";
/// 백그라운드 검색 정보 갱신이 쓰는 표시 대상
const INDEX_TARGET: &str = "<index>";
/// 노트 하나에 묶이지 않는 질문(전체 범위)이 쓰는 표시 대상 (갱신이 비켜 간다. 삭제는 막지 않는다)
const ASK_TARGET: &str = "<ask>";

type LiveSlot = Arc<Mutex<Option<procs::Stoppable>>>;

impl AppState {
    fn settings(&self) -> Settings {
        Settings { config_dir: self.config_path.parent().map(Path::to_path_buf), ..self.settings.lock().unwrap().clone() }
    }

    /// 요약·질문 프로세스 (고른 서비스의 API 키 포함)
    fn llm_cmd<S: AsRef<OsStr>>(&self, args: &[S], provider: Option<&str>) -> Result<Command, String> {
        self.settings().tractus_llm(args, provider)
    }
}

/// 파일 읽기·MCP 대기를 블로킹 풀에서 돌린다 (UI·비동기 런타임 스레드를 막지 않게).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, tray: State<'_, tray::TrayState>, settings: Settings) -> Result<(), String> {
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut settings = settings.for_save();
    // AI 서비스·스마트 검색 방식 선택은 llm_key.rs의 명령이 따로 저장한다: 오래된 화면 값이 덮어쓰지 못하게 지금 값을 지킨다
    let cur = state.settings();
    (settings.llm_default, settings.llm_profiles, settings.embedding_provider, settings.config_dir) = (cur.llm_default, cur.llm_profiles, cur.embedding_provider, cur.config_dir);
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, raw).map_err(|e| format!("설정을 저장할 수 없습니다\n{e}"))?;
    state.mcp.set_spawn(settings.mcp_spawn());
    *state.settings.lock().unwrap() = settings.clone();
    tray.apply(&app, &settings); // 메뉴 막대 아이콘 설정은 다시 시작하지 않아도 바로 적용된다
    Ok(())
}

/// 설정 파일의 rec_mode만 바꾼다. 파일이 없으면 rec_mode만 쓴다:
/// 모드 버튼 한 번에 환경변수에서 온 home 같은 기본값이 파일에 굳지 않게 한다.
fn merge_rec_mode(raw: Option<&str>, mode: &str) -> Result<String, String> {
    if !matches!(mode, "in_person" | "hybrid") {
        return Err(format!("알 수 없는 녹음 방식: {mode}"));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["rec_mode"] = json!(mode);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_rec_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let raw = merge_rec_mode(std::fs::read_to_string(&state.config_path).ok().as_deref(), &mode)?;
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&state.config_path, raw).map_err(|e| format!("설정을 저장할 수 없습니다\n{e}"))?;
    state.settings.lock().unwrap().rec_mode = mode;
    Ok(())
}

/// 설정 파일의 불리언 키 하나만 바꾼다 (merge_rec_mode와 같은 방식: 환경변수 기본값이 파일에 굳지 않게)
fn merge_flag(raw: Option<&str>, key: &str, value: bool) -> Result<String, String> {
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v[key] = json!(value);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_checkup_done(state: State<'_, AppState>, done: bool) -> Result<(), String> {
    let raw = merge_flag(std::fs::read_to_string(&state.config_path).ok().as_deref(), "checkup_done", done)?;
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&state.config_path, raw).map_err(|e| format!("설정을 저장할 수 없습니다\n{e}"))?;
    state.settings.lock().unwrap().checkup_done = done;
    Ok(())
}

#[tauri::command]
async fn list_meetings(state: State<'_, AppState>) -> Result<Vec<meetings::MeetingInfo>, String> {
    let home = state.settings().home();
    blocking(move || Ok(meetings::list(&home))).await
}

/// 전사되지 않은 녹음 (앱 종료로 끊긴 녹음, 전사 실패). 사이드바에서 다시 전사한다.
#[tauri::command]
async fn list_recordings(state: State<'_, AppState>) -> Result<Vec<meetings::PendingRecording>, String> {
    let home = state.settings().home();
    blocking(move || Ok(meetings::pending_recordings(&home))).await
}

#[tauri::command]
async fn load_meeting(state: State<'_, AppState>, id: String) -> Result<meetings::MeetingDetail, String> {
    let home = state.settings().home();
    blocking(move || meetings::load(&home, &id)).await
}

/// MCP 도구 호출. 결과는 JSON-RPC result 그대로 (프론트엔드 lib.ts의 parseToolResult가 해석).
#[tauri::command]
async fn mcp_call(state: State<'_, AppState>, name: String, arguments: Value) -> Result<Value, String> {
    if !matches!(name.as_str(), "search_meetings" | "status") {
        return Err(format!("허용하지 않는 검색 요청입니다: {name}"));
    }
    let client = state.mcp.clone();
    blocking(move || client.call_tool(&name, arguments)).await
}

/// 녹음 방식에 따라 앱이 넘기는 `record` 인수 (lib.ts recFlags). 그 밖의 인수는 받지 않는다.
const REC_FLAGS: &[&str] = &["--no-system", "--echo-cancel"];

fn check_rec_flags(flags: &[String]) -> Result<(), String> {
    match flags.iter().find(|f| !REC_FLAGS.contains(&f.as_str())) {
        Some(f) => Err(format!("허용하지 않는 녹음 설정입니다: {f}")),
        None => Ok(()),
    }
}

/// 실시간 자막이 정지 명령을 받고 끝나기를 기다리는 시간. 넘으면 kill한다 (자막은 저장하지 않으므로 잃을 것이 없다)
const LIVE_STOP_WAIT: Duration = Duration::from_secs(5);

/// `tractus live --recording <녹음 폴더> --progress-json` (docs/desktop.md §2.8). 이 앱이 만든 녹음 폴더만 받는다
fn live_args(home: &Path, dir: &Path) -> Result<Vec<String>, String> {
    if !meetings::is_recording_dir(home, dir) {
        return Err(format!("녹음 폴더가 아닙니다: {}", dir.display()));
    }
    Ok(vec!["live".into(), "--recording".into(), dir.to_string_lossy().into_owned(), "--progress-json".into()])
}

/// 실시간 자막 시작. 이벤트는 "live"로 보낸다 (작업 "job"이 아니므로 회의를 열지 않는다).
/// 실행조차 못 하면 error + exit를 대신 보내 화면이 "자막이 멈췄습니다"를 보이게 한다. 녹음은 그대로 계속된다
fn start_live(app: &AppHandle, s: &Settings, dir: &Path, live: &LiveSlot) {
    let forward = app.clone();
    let spawned = live_args(&s.home(), dir).and_then(|args| {
        procs::spawn_stoppable(s.tractus(&args), serde_json::Map::new(), move |ev| {
            let _ = forward.emit("live", ev);
        })
    });
    match spawned {
        Ok(p) => {
            let old = live.lock().unwrap().replace(p);
            if let Some(old) = old {
                old.kill();
            }
        }
        Err(e) => {
            let _ = app.emit("live", json!({"event": "error", "message": e}));
            let _ = app.emit("live", json!({"event": "exit", "code": null, "stderr": ""}));
        }
    }
}

/// 정지 명령을 보내고 끝나기를 기다린다 (LIVE_STOP_WAIT, 넘으면 kill). 잠금은 기다리기 전에 푼다
fn stop_live(live: &LiveSlot) {
    let running = live.lock().unwrap().take();
    if let Some(p) = running {
        p.stop(LIVE_STOP_WAIT);
    }
}

/// 녹음 시작. 이벤트는 "rec"로 보낸다. 반환값은 녹음 폴더.
/// target: 글만 있는 노트의 ID. 있으면 그 노트에 녹음을 추가하는 녹음이다 (녹음 폴더에 attach.json을 쓰고, 녹음하는 동안 노트를 쓰는 중으로 표시한다. docs/desktop.md §2.11)
#[tauri::command]
fn rec_start(app: AppHandle, state: State<'_, AppState>, flags: Vec<String>, target: Option<String>) -> Result<String, String> {
    check_rec_flags(&flags)?;
    let mut rec = state.rec.lock().unwrap();
    if rec.is_some() {
        return Err("이미 녹음 중입니다".into());
    }
    let s = state.settings();
    if let Some(id) = &target {
        attach::check_target(&s.home(), id, |t| is_busy(&state.busy, t))?;
    }
    let dir = s.home().join("recordings").join(ulid::Ulid::new().to_string());
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
    if let Some(id) = &target {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        attach::write_attach(&dir, id).inspect_err(|_| attach::discard(&dir))?;
    }
    let mut cmd = Command::new(s.rec_path());
    cmd.arg("record").arg("--out").arg(&dir).args(&flags).envs(s.child_env());
    if s.fake_recorder {
        cmd.arg("--fake");
    }
    let (slot, live, live_dir) = (state.rec.clone(), state.live.clone(), dir.clone());
    let (busy, busy_key) = (state.busy.clone(), hold(&state.busy, &dir.to_string_lossy()));
    let note_key = target.as_deref().map(|id| hold(&state.busy, id)); // 녹음하는 동안 그 노트는 삭제할 수 없다
    cancel_index(&state.index); // 실시간 변환 모델과 임베딩 모델이 함께 올라가지 않게
    let release_key = busy_key.clone();
    let release_note = note_key.clone();
    // 실시간 자막은 녹음 헬퍼가 트랙 파일을 만든 뒤(started)에 띄운다. 설정은 녹음을 시작할 때의 값을 쓴다
    let live_settings = s.live_captions.then(|| s.clone());
    let started = procs::spawn_streaming(cmd, serde_json::Map::new(), move |ev| {
        match (ev["event"].as_str(), &live_settings) {
            (Some("started"), Some(ls)) => start_live(&app, ls, &live_dir, &live),
            // stopped를 화면에 보내기 전에 자막 프로세스를 끝낸다: 프론트엔드는 stopped를 받고 정식 전사를 시작하므로
            // 작은 모델(0.6B)과 정식 전사 모델이 메모리에 같이 올라가지 않는다. 녹음 헬퍼가 죽어도(exit) 자막을 남기지 않는다
            (Some("stopped" | "exit"), _) => stop_live(&live),
            _ => {}
        }
        if ev["event"] == "exit" {
            slot.lock().unwrap().take();
            release(&busy, &busy_key);
            if let Some(k) = &note_key {
                release(&busy, k);
            }
        }
        let _ = app.emit("rec", ev);
    });
    let (stdin, _) = match started {
        Ok(s) => s,
        Err(e) => {
            release(&state.busy, &release_key);
            if let Some(k) = &release_note {
                release(&state.busy, k);
            }
            if target.is_some() {
                attach::discard(&dir);
            }
            return Err(e);
        }
    };
    *rec = Some(stdin);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn rec_send(state: State<'_, AppState>, cmd: String, text: Option<String>) -> Result<(), String> {
    let line = procs::recorder_line(&cmd, text.as_deref())?;
    let mut rec = state.rec.lock().unwrap();
    let stdin = rec.as_mut().ok_or("녹음 중이 아닙니다")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("녹음 프로그램에 명령을 보내지 못했습니다\n{e}"))?;
    // 자막도 지금 멈추기 시작한다 (녹음 헬퍼가 파일을 마무리하는 동안). 끝나기를 기다리는 것은 stopped 때(stop_live)
    if cmd == "stop" {
        if let Some(p) = state.live.lock().unwrap().as_mut() {
            p.send_stop();
        }
    }
    Ok(())
}

/// 작업 종류 → tractus 인수. 대상은 종류마다 검사한다
fn job_args(home: &Path, kind: &str, target: &str) -> Result<Vec<String>, String> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
    match kind {
        "transcribe" => {
            // 녹음 폴더만 받는다 (임의 경로 전사 방지. 성공하면 코어가 이 폴더를 지운다)
            if !meetings::is_recording_dir(home, Path::new(target)) {
                return Err(format!("녹음 폴더가 아닙니다: {target}"));
            }
            Ok(args(&["transcribe", "--recording", target, "--progress-json"]))
        }
        "summarize" if is_meeting_id(target) => Ok(args(&["summarize", target, "--progress-json"])),
        // 단어 타이밍 (Phase 6.1). words가 없는 세그먼트만 맞춘다. 정렬하는 동안 앱에서 고친 문장은 코어가 덮어쓰지 않는다
        "align" if is_meeting_id(target) => Ok(args(&["align", target, "--progress-json"])),
        // 파일 가져오기 (Phase 5.5). 원본 파일은 건드리지 않는다. 이미 전사한 파일이면 코어가 duplicate 경고 + done
        "import" => import_args(Path::new(target)),
        _ => Err(format!("잘못된 작업: {kind} {target}")),
    }
}

/// 전사·요약·단어 타이밍 작업. 이벤트는 "job"으로 보내고 {job, kind}를 덧붙인다. job은 프론트엔드가 만든 ID.
/// append_to: 글만 있는 노트의 ID. 있으면(transcribe·import만) 새 노트를 만들지 않고 그 노트에 녹음을 덧붙인다 (`--append-to`, docs/desktop.md §2.11). 작업하는 동안 그 노트는 삭제할 수 없다
#[tauri::command]
fn job_start(app: AppHandle, state: State<'_, AppState>, kind: String, target: String, job: String, append_to: Option<String>, provider: Option<String>) -> Result<(), String> {
    let s = state.settings();
    let args = attach::with_target(job_args(&s.home(), &kind, &target)?, &kind, append_to.as_deref(), &s.home(), |t| is_busy(&state.busy, t))?;
    // provider: 요약에서 고른 AI 서비스 (없으면 기본 서비스). 다른 작업은 쓰지 않는다
    let cmd = match kind.as_str() {
        "summarize" => state.llm_cmd(&args, provider.as_deref())?,
        "transcribe" | "import" => s.tractus_embed(&args), // 끝나면 색인한다
        _ => s.tractus(&args),
    };
    let tag = json!({"job": job, "kind": kind}).as_object().unwrap().clone();
    // 노트·녹음을 쓰는 동안은 삭제를 거절한다. 가져오기는 대상이 아직 없어 IMPORT_TARGET으로 표시만 한다 (백그라운드 검색 정보 갱신이 비켜 간다)
    let held = if kind == "import" { IMPORT_TARGET } else { target.as_str() };
    let key = Some((state.busy.clone(), hold(&state.busy, held)));
    let note = append_to.as_deref().map(|id| (state.busy.clone(), hold(&state.busy, id)));
    cancel_index(&state.index);
    let (slot, note_slot) = (key.clone(), note.clone());
    // stdin은 쓰지 않으므로 바로 닫는다
    let started = procs::spawn_streaming(cmd, tag, move |ev| {
        if let (true, Some((busy, k))) = (ev["event"] == "exit", &slot) {
            release(busy, k);
        }
        if let (true, Some((busy, k))) = (ev["event"] == "exit", &note_slot) {
            release(busy, k);
        }
        let _ = app.emit("job", ev);
    });
    match (started, key) {
        (Ok(_), _) => Ok(()),
        (Err(e), key) => {
            for (busy, k) in key.into_iter().chain(note) {
                release(&busy, &k);
            }
            Err(e)
        }
    }
}

/// 회의 질의 (Phase 6.3). 이벤트는 "ask"로 보내고 {job}을 덧붙인다. meeting이 있으면 그 회의만 보고 chat.json에 남긴다
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 프론트엔드 invoke 인수 그대로
fn ask_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job: String,
    meeting: Option<String>,
    from: Option<String>,
    to: Option<String>,
    question: String,
    history: Vec<ask::ChatMessage>,
    provider: Option<String>,
) -> Result<(), String> {
    let args = ask::ask_args(meeting.as_deref(), from.as_deref(), to.as_deref())?;
    let input = ask::ask_input(&question, &history)?;
    let cmd = state.llm_cmd(&args, provider.as_deref())?;
    let tag = json!({ "job": job }).as_object().unwrap().clone();
    let (asks, key) = (state.asks.clone(), job.clone());
    // 한 노트에 묻는 동안은 그 노트 삭제를 거절한다
    // 전체 범위 질문도 표시한다 (검색 정보 갱신이 비켜 가고, 이미 돌고 있으면 멈춘다)
    let held = Some((state.busy.clone(), hold(&state.busy, meeting.as_deref().unwrap_or(ASK_TARGET))));
    cancel_index(&state.index);
    let slot = held.clone();
    // 넣기 전에 잠가 둔다: 바로 끝나는 프로세스의 exit가 넣기보다 먼저 지우지 않게
    let mut running = state.asks.lock().unwrap();
    let spawned = procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            asks.lock().unwrap().remove(&key);
            if let Some((busy, k)) = &slot {
                release(busy, k);
            }
        }
        let _ = app.emit("ask", ev);
    });
    let (mut stdin, child) = match spawned {
        Ok(p) => p,
        Err(e) => {
            if let Some((busy, k)) = &held {
                release(busy, k);
            }
            return Err(e);
        }
    };
    running.insert(job, child);
    // 코어는 stdin을 끝까지 읽고 시작한다. 파이썬이 뜨는 동안 UI 스레드가 파이프에 막히지 않게 따로 쓰고 닫는다
    std::thread::spawn(move || {
        if let Err(e) = stdin.write_all(input.as_bytes()) {
            eprintln!("질문을 넘기지 못했습니다: {e}"); // 코어가 입력 오류로 끝나고 exit가 간다
        }
    });
    Ok(())
}

/// 질문 멈추기. 이미 끝났으면 아무것도 하지 않는다 (exit 이벤트는 프로세스가 끝나며 간다)
#[tauri::command]
fn ask_cancel(state: State<'_, AppState>, job: String) {
    let child = state.asks.lock().unwrap().get(&job).cloned();
    if let Some(c) = child {
        let _ = c.lock().unwrap().kill();
    }
}

/// 회의의 질문 기록 (chat.json)
#[tauri::command]
async fn load_chat(state: State<'_, AppState>, id: String) -> Result<Vec<meetings::ChatEntry>, String> {
    let home = state.settings().home();
    blocking(move || meetings::load_chat(&home, &id)).await
}

/// 노트를 휴지통으로 옮긴다 (docs/desktop.md §2.8). 처리 중인 노트·변환이 끝나지 않은 노트·폴더 밖은 거절한다.
/// 검색 색인은 사라진 폴더를 스스로 지운다: 백그라운드로 MCP `status`(= `sync(embed=False)`)를 불러 바로 맞춘다
/// (실패해도 검색·질문이 매번 먼저 동기화하므로 지워진 노트는 나오지 않는다)
#[tauri::command]
async fn delete_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (home, busy, mcp) = (state.settings().home(), state.busy.clone(), state.mcp.clone());
    blocking(move || removal::trash_note(&home, &id, |k| is_busy(&busy, k), removal::to_trash)).await?;
    sync_index_later(mcp);
    Ok(())
}

/// ⌘Q 종료 흐름: 화면이 쓰던 메모를 저장하는 동안 종료를 미룬다. QUIT_ASKED는 한 번만 묻게, QUIT_READY는 미룬 종료를 통과시킨다
static QUIT_ASKED: AtomicBool = AtomicBool::new(false);
static QUIT_READY: AtomicBool = AtomicBool::new(false);
/// 화면이 응답하지 않아도 이 시간 뒤에는 끝낸다
const QUIT_WAIT: Duration = Duration::from_secs(3);

/// 화면이 쓰던 메모를 저장했다: 미룬 종료를 이어 간다
#[tauri::command]
fn quit_ready(app: AppHandle) {
    QUIT_READY.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 종료를 한 번만 미루고 화면에 저장하라고 알린다. 3초 안에 quit_ready가 오지 않아도 끝낸다
fn begin_quit(app: &AppHandle) {
    if app.webview_windows().is_empty() {
        QUIT_READY.store(true, Ordering::SeqCst);
        return app.exit(0);
    }
    if QUIT_ASKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = app.emit("quit-requested", ());
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_WAIT);
        QUIT_READY.store(true, Ordering::SeqCst);
        handle.exit(0);
    });
}

/// 마지막 창이 닫혀 앱이 끝나려 할 때: 열린 창이 있으면 한 번 미룬다. 이미 통과시키기로 했거나 창이 없으면 그대로 둔다
fn defer_exit(app: &AppHandle, api: &tauri::ExitRequestApi) {
    if QUIT_READY.load(Ordering::SeqCst) || app.webview_windows().is_empty() {
        return;
    }
    api.prevent_exit();
    begin_quit(app);
}

/// macOS ⌘Q: 기본 메뉴의 종료 항목은 Cocoa `terminate:`라 ExitRequested를 거치지 않고 바로 끝난다(미룰 수 없다).
/// 그래서 그 항목을 직접 만든 항목으로 바꿔, 눌렀을 때 begin_quit을 부른다. (Dock의 종료는 여전히 `terminate:`다)
const QUIT_MENU_ID: &str = "quit-tractus";

#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_sub)) = menu.items()?.into_iter().next() {
        // 기본 앱 메뉴의 마지막 항목이 종료다 (tauri 2.12.1 menu.rs)
        if let Some(last) = app_sub.items()?.pop().filter(|k| matches!(k, MenuItemKind::Predefined(_))) {
            app_sub.remove(&last)?;
        }
        let name = app.package_info().name.clone();
        app_sub.append(&MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {name}"), true, Some("Cmd+Q"))?)?;
    }
    Ok(menu)
}

/// 변환하지 않은 녹음을 휴지통으로 옮긴다. 녹음 중이거나 변환 중인 폴더는 거절한다
#[tauri::command]
async fn delete_recording(state: State<'_, AppState>, dir: String) -> Result<(), String> {
    let (home, busy) = (state.settings().home(), state.busy.clone());
    blocking(move || removal::trash_recording(&home, Path::new(&dir), |k| is_busy(&busy, k), removal::to_trash)).await
}

fn sync_index_later(mcp: Arc<mcp::McpClient>) {
    std::thread::spawn(move || {
        if let Err(e) = mcp.call_tool("status", json!({})) {
            eprintln!("검색 색인 정리 실패: {e}");
        }
    });
}

/// 질문을 보내기 전 '어디로 전송되는지' 안내에 쓸 서비스·AI 모델·호스트 (API 키는 읽지 않고 등록 여부만 본다). provider: 고른 서비스 (없으면 기본)
#[tauri::command]
async fn llm_config(state: State<'_, AppState>, provider: Option<String>) -> Result<ask::LlmConfig, String> {
    let s = state.settings();
    blocking(move || {
        let c = s.llm_choice(provider.as_deref())?;
        let cfg = ask::llm_config(&[&s.tractus_cwd(), &s.home()], |k| std::env::var(k).ok());
        Ok(llm_key::effective(cfg, &c, s.key_saved(c.provider)))
    })
    .await
}

fn is_meeting_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// "S1", "s0012" 꼴: 접두 글자 + 숫자
fn is_tagged(s: &str, prefix: char) -> bool {
    s.strip_prefix(prefix).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// 화자 편집 (docs/desktop.md §2.1). 프론트엔드가 {"op":"rename","label":"S1","name":"김민수"} 꼴로 보낸다.
/// dismiss: 목소리 제안 거절 (Phase 7.1, §2.7). 제안 확정은 그 이름으로 rename
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
enum SpeakerEdit {
    Rename { label: String, name: String },
    Set { segment: String, label: String },
    Merge { from: String, into: String },
    Dismiss { label: String },
}

/// `tractus speakers <회의> <명령> -- <인자…>`. 인자는 `--` 뒤에 둔다("-박" 같은 이름을 옵션으로 읽지 않게)
fn speakers_args(id: &str, edit: &SpeakerEdit) -> Result<Vec<String>, String> {
    let bad = || "잘못된 참석자 편집입니다".to_string();
    if !is_meeting_id(id) {
        return Err(format!("잘못된 노트 ID: {id}"));
    }
    let (op, rest) = match edit {
        SpeakerEdit::Rename { label, name } if is_tagged(label, 'S') && !name.contains(['\n', '\r']) => ("rename", vec![label.as_str(), name.trim()]),
        SpeakerEdit::Set { segment, label } if is_tagged(segment, 's') && (is_tagged(label, 'S') || label == "new") => ("set", vec![segment.as_str(), label]),
        SpeakerEdit::Merge { from, into } if is_tagged(from, 'S') && is_tagged(into, 'S') && from != into => ("merge", vec![from.as_str(), into]),
        SpeakerEdit::Dismiss { label } if is_tagged(label, 'S') => ("dismiss", vec![label.as_str()]),
        _ => return Err(bad()),
    };
    Ok(["speakers", id, op, "--"].into_iter().chain(rest).map(String::from).collect())
}

/// tractus 명령을 끝까지 실행하고 stdout을 돌려준다. input이 있으면 stdin으로 넘기고 닫는다.
/// 실패하면 코어가 stderr 마지막 줄에 쓴 이유(없는 세그먼트 등)를 오류로 돌려준다.
fn run_tractus(s: &Settings, args: &[String], input: Option<&str>, what: &str) -> Result<String, String> {
    let mut cmd = s.tractus(args);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| procs::cannot_run(&s.tractus_resolved().path, e))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        // 코어는 stdin을 다 읽은 뒤에 출력하므로 먼저 쓰고 닫아도 막히지 않는다
        stdin.write_all(text.as_bytes()).map_err(|e| format!("{what}\n입력을 넘기지 못했습니다: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(last_error_line(&err).unwrap_or_else(|| format!("{what} (종료 코드 {})", out.status.code().map_or("없음".into(), |c| c.to_string()))));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// stderr 마지막 줄 (코어가 WORDS.md 문장으로 쓴다). typer 접두어 `Error: `·`Error: Invalid value for MEETING: `는 뗀다
/// (param_hint를 문자열로 주면 click은 따옴표 없이 찍는다. 자동 이름이면 `'--x'`처럼 따옴표가 붙는다)
fn last_error_line(stderr: &str) -> Option<String> {
    let line = stderr.trim().lines().last()?.trim();
    let line = line.strip_prefix("Error: ").unwrap_or(line);
    let line = match line.strip_prefix("Invalid value for ").and_then(|r| r.split_once(": ")) {
        Some((_, rest)) => rest,
        None => line,
    };
    (!line.is_empty()).then(|| line.to_string())
}

/// stdout 마지막 줄의 JSON 객체 ({"changed": N}, {"added": N}, {"path": …}).
fn stdout_json(out: &str) -> Result<Value, String> {
    out.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .ok_or_else(|| "결과를 읽지 못했습니다".to_string())
}

/// 화자 편집을 코어에 맡기고(transcript.json·md·vtt·검색 색인을 코어가 고친다) 고친 회의를 다시 읽어 돌려준다.
#[tauri::command]
async fn edit_speakers(state: State<'_, AppState>, id: String, edit: SpeakerEdit) -> Result<meetings::MeetingDetail, String> {
    let s = state.settings();
    let args = speakers_args(&id, &edit)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        run_tractus(&s, &args, None, "참석자를 고치지 못했습니다")?;
        meetings::load(&s.home(), &id)
    })
    .await
}

/// 문장 편집 한 건 (Phase 5.3). text가 원문과 같으면 코어가 corrected_text를 해제한다
#[derive(Deserialize, Serialize, Debug)]
struct TextEdit {
    id: String,
    text: String,
}

/// `tractus segments <회의> edit` 인수와 stdin JSON. 문장은 인수가 아니라 stdin으로 넘긴다(길이·특수 문자 걱정 없이)
fn segments_edit(id: &str, edits: &[TextEdit]) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(format!("잘못된 노트 ID: {id}"));
    }
    if edits.is_empty() || edits.iter().any(|e| !is_tagged(&e.id, 's') || e.text.trim().is_empty()) {
        return Err("빈 내용은 저장할 수 없습니다".into());
    }
    Ok((["segments", id, "edit"].map(String::from).to_vec(), json!({ "edits": edits }).to_string()))
}

/// 문장 편집 결과: 코어가 실제로 바꾼 세그먼트 수({"changed": N})와 고친 회의
#[derive(Serialize)]
struct EditResult {
    changed: u64,
    meeting: meetings::MeetingDetail,
}

/// 문장 편집 묶음을 한 번에 저장하고 고친 회의를 돌려준다. 바꾸기 200건도 호출 1회다
#[tauri::command]
async fn edit_segments(state: State<'_, AppState>, id: String, edits: Vec<TextEdit>) -> Result<EditResult, String> {
    let s = state.settings();
    let (args, input) = segments_edit(&id, &edits)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let changed = stdout_json(&run_tractus(&s, &args, Some(&input), "대화 내용을 수정하지 못했습니다")?)?["changed"].as_u64().unwrap_or(0);
        Ok(EditResult { changed, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// `tractus glossary add -- <용어…>`. 다음 전사의 hotwords가 된다. 중복 제거는 코어가 한다
fn glossary_args(terms: &[String]) -> Result<Vec<String>, String> {
    let terms: Vec<&str> = terms.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if terms.is_empty() || terms.iter().any(|t| t.contains(['\n', '\r'])) {
        return Err("자주 쓰는 단어에 추가할 단어가 없습니다".into());
    }
    Ok(["glossary", "add", "--"].into_iter().chain(terms).map(String::from).collect())
}

/// 용어집에 더한 개수
#[tauri::command]
async fn glossary_add(state: State<'_, AppState>, terms: Vec<String>) -> Result<u64, String> {
    let s = state.settings();
    let args = glossary_args(&terms)?;
    blocking(move || Ok(stdout_json(&run_tractus(&s, &args, None, "자주 쓰는 단어에 추가하지 못했습니다")?)?["added"].as_u64().unwrap_or(0))).await
}

/// 수정한 문장을 검색에 반영한다: `tractus index` (바뀐 노트만 다시 읽고 임베딩한다). 앱이 한가할 때 조용히 부른다.
/// 다른 작업(변환·요약·단어 싱크·녹음·질문·수정·내보내기)이 하나라도 돌고 있거나 이미 갱신 중이면 하지 않고 false를 돌려준다.
/// 실행했으면 true. 도는 중에 변환·녹음·질문이 시작하면 갱신 프로세스를 멈추고 false (다음 갱신이 이어서 한다). 실패는 오류 문장(코어 마지막 줄)
#[tauri::command]
async fn index_refresh(state: State<'_, AppState>) -> Result<bool, String> {
    let s = state.settings();
    let Some(guard) = BusyGuard::new_if_idle(&state.busy, INDEX_TARGET) else { return Ok(false) };
    let (busy, slot) = (state.busy.clone(), state.index.clone());
    blocking(move || {
        let _guard = guard;
        let (tx, rx) = std::sync::mpsc::channel();
        let (stdin, child) = procs::spawn_streaming(s.tractus_embed(&["index".to_string()]), serde_json::Map::new(), move |ev| {
            if ev["event"] == "exit" {
                let _ = tx.send(ev);
            }
        })?;
        drop(stdin);
        *slot.lock().unwrap() = Some(child);
        // 시작하는 사이에 다른 작업이 표시를 하고 cancel_index를 지나갔을 수 있다: 내 표시 말고 다른 표시가 있으면 비켜 준다
        if busy.lock().unwrap().len() > 1 {
            cancel_index(&slot);
        }
        let exit = rx.recv().map_err(|e| e.to_string());
        *slot.lock().unwrap() = None;
        index_outcome(&exit?)
    })
    .await
}

/// 검색 정보 갱신 프로세스의 exit 이벤트 → 했으면 true, 다른 작업에 밀려 멈췄으면 false(신호로 끝나 종료 코드가 없다), 실패는 오류 문장
fn index_outcome(exit: &Value) -> Result<bool, String> {
    match exit["code"].as_i64() {
        Some(0) => Ok(true),
        None => Ok(false),
        Some(code) => Err(last_error_line(exit["stderr"].as_str().unwrap_or("")).unwrap_or_else(|| format!("스마트 검색 정보를 갱신하지 못했습니다 (종료 코드 {code})"))),
    }
}

/// 메모 본문 상한 (글자 수). 코어 `note save`와 같다
const MEMO_BODY_MAX: usize = 200_000;
/// 제목 길이 상한 (글자 수). 코어 `note title`과 같다
const TITLE_MAX: usize = 120;

/// 제목: 공백·줄바꿈은 한 칸으로 줄이고 앞뒤를 자른다 (코어 store.one_line). 1~120자. 화면이 먼저 거르므로 여기는 마지막 방어선이다
fn clean_title(raw: &str) -> Result<String, String> {
    let title = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    match title.chars().count() {
        0 => Err("제목을 입력하세요.".into()),
        n if n > TITLE_MAX => Err(format!("제목은 {TITLE_MAX}자까지 쓸 수 있습니다.")),
        _ => Ok(title),
    }
}

/// `tractus note new`. 제목이 없으면 코어가 `메모 HH:MM`으로 정한다. 있으면 stdin JSON으로 넘긴다
fn note_new_args(title: Option<&str>) -> Result<(Vec<String>, Option<String>), String> {
    let input = match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => Some(json!({ "title": clean_title(t)? }).to_string()),
        None => None,
    };
    Ok((["note", "new"].map(String::from).to_vec(), input))
}

/// `tractus note save <노트>` 인수와 stdin JSON. 본문은 인수가 아니라 stdin으로 넘긴다 (길이·특수 문자 걱정 없이)
fn note_save_args(id: &str, body: &str) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(format!("잘못된 노트 ID: {id}"));
    }
    if body.chars().count() > MEMO_BODY_MAX {
        return Err("메모는 200,000자까지 쓸 수 있습니다.".into());
    }
    Ok((["note", "save", id].map(String::from).to_vec(), json!({ "body": body }).to_string()))
}

/// `tractus note title <노트>` 인수와 stdin JSON
fn note_title_args(id: &str, title: &str) -> Result<(Vec<String>, String, String), String> {
    if !is_meeting_id(id) {
        return Err(format!("잘못된 노트 ID: {id}"));
    }
    let title = clean_title(title)?;
    Ok((["note", "title", id].map(String::from).to_vec(), json!({ "title": title }).to_string(), title))
}

/// 새 메모 노트. 코어가 폴더·transcript.json·검색 정보(단어 일치)까지 만든다
#[derive(Serialize)]
struct NoteNew {
    meeting_id: String,
}

#[tauri::command]
async fn note_new(state: State<'_, AppState>, title: Option<String>) -> Result<NoteNew, String> {
    let s = state.settings();
    let (args, input) = note_new_args(title.as_deref())?;
    blocking(move || {
        let v = stdout_json(&run_tractus(&s, &args, input.as_deref(), "메모를 만들지 못했습니다")?)?;
        let meeting_id = v["meeting_id"].as_str().filter(|id| is_meeting_id(id)).ok_or("만든 메모를 찾지 못했습니다")?.to_string();
        Ok(NoteNew { meeting_id })
    })
    .await
}

/// 메모 저장 결과: 코어가 만든 줄(대화) 수와 고친 노트
#[derive(Serialize)]
struct NoteSaved {
    segments: u64,
    meeting: meetings::MeetingDetail,
}

/// 메모 본문을 저장하고(코어가 대화·md·검색 정보를 고친다) 고친 노트를 돌려준다. 메모 노트는 본문을, 녹음 노트는 오른쪽 패널 메모 탭의 글을 저장한다 (코어가 노트 종류로 가른다).
/// 노트를 처리 중으로 표시해 삭제가 기다리게 한다
#[tauri::command]
async fn note_save(state: State<'_, AppState>, id: String, body: String) -> Result<NoteSaved, String> {
    let s = state.settings();
    let (args, input) = note_save_args(&id, &body)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let segments = stdout_json(&run_tractus(&s, &args, Some(&input), "메모를 저장하지 못했습니다")?)?["segments"].as_u64().unwrap_or(0);
        Ok(NoteSaved { segments, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// 노트 제목을 바꾼다 (녹음·메모 모두). 폴더 이름은 그대로다. 코어가 돌려준 제목(없으면 보낸 제목)
#[tauri::command]
async fn note_title(state: State<'_, AppState>, id: String, title: String) -> Result<String, String> {
    let s = state.settings();
    let (args, input, sent) = note_title_args(&id, &title)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let v = stdout_json(&run_tractus(&s, &args, Some(&input), "제목을 바꾸지 못했습니다")?)?;
        Ok(v["title"].as_str().map_or(sent, String::from))
    })
    .await
}

const EXPORT_FORMATS: &[&str] = &["txt", "md", "srt", "vtt", "csv", "docx", "bundle"];

/// `tractus export`. 경로는 저장 대화상자가 고른 절대 경로이고, 덮어쓰기는 대화상자가 이미 물었으므로 --force
/// summary: md·docx에 넣을 요약의 key (화면에서 고른 요약). 없으면 코어가 기본 요약을 쓴다
fn export_args(id: &str, format: &str, out: &Path, summary: Option<&str>) -> Result<Vec<String>, String> {
    if !is_meeting_id(id) || !EXPORT_FORMATS.contains(&format) || !out.is_absolute() || out.file_name().is_none() || summary.is_some_and(|k| !summaries::is_summary_key(k)) {
        return Err(format!("잘못된 내보내기: {id} {format} {}", out.display()));
    }
    let out = out.to_string_lossy();
    let mut args: Vec<String> = ["export", id, "--format", format, "--out", &out, "--force"].map(String::from).to_vec();
    if let Some(k) = summary {
        args.push(format!("--summary={k}"));
    }
    Ok(args)
}

/// 내보내고 Finder에서 그 파일을 보여 준다. 반환값은 코어가 쓴 절대 경로
#[tauri::command]
async fn export_meeting(state: State<'_, AppState>, id: String, format: String, out: String, summary: Option<String>) -> Result<String, String> {
    let s = state.settings();
    let args = export_args(&id, &format, Path::new(&out), summary.as_deref())?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        let v = stdout_json(&run_tractus(&s, &args, None, "내보내지 못했습니다")?)?;
        let path = v["path"].as_str().ok_or("내보낸 파일 위치를 알 수 없습니다")?.to_string();
        // Finder 보여 주기가 실패해도 파일은 이미 저장됐다
        if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&path) {
            eprintln!("Finder에서 보여 주지 못했습니다: {e}");
        }
        Ok(path)
    })
    .await
}

/// 가져올 수 있는 파일 (lib.ts IMPORT_EXTS와 같다). 대소문자 무시
const IMPORT_EXTS: &[&str] = &["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "m4v"];

/// `tractus transcribe <파일> --progress-json`. 절대 경로의 기존 파일이고 확장자가 allowlist에 있을 때만
fn import_args(path: &Path) -> Result<Vec<String>, String> {
    let ext_ok = path.extension().and_then(OsStr::to_str).is_some_and(|e| IMPORT_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    if !(path.is_absolute() && ext_ok && path.is_file()) {
        return Err(format!("가져올 수 없는 파일입니다: {}", path.display()));
    }
    Ok(vec!["transcribe".into(), path.to_string_lossy().into_owned(), "--progress-json".into()])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == QUIT_MENU_ID {
                begin_quit(app);
            } else {
                tray::on_menu_event(app, id); // 메뉴 막대 아이콘의 메뉴 (트레이 항목이 아니면 아무것도 하지 않는다)
            }
        })
        // 창을 닫아도 메뉴 막대에 남기는 설정이면 끝내지 않고 숨긴다. 끄면 마지막 창이 닫히며 기존 종료 흐름(defer_exit)이 돈다
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && tray::hides_on_close(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        // 회의 오디오: media://localhost/<경로> (media.rs). 파일 읽기는 UI 스레드 밖에서
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let home = ctx.app_handle().state::<AppState>().settings().home();
            std::thread::spawn(move || {
                let range = request.headers().get(tauri::http::header::RANGE).and_then(|v| v.to_str().ok());
                responder.respond(media::respond(&home.join("meetings"), request.uri().path(), range));
            });
        })
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("settings.json");
            let mut settings = Settings::load(std::fs::read_to_string(&config_path).ok().as_deref());
            settings.config_dir = config_path.parent().map(Path::to_path_buf);
            let mcp = Arc::new(mcp::McpClient::new(settings.mcp_spawn()));
            // 첫 검색이 빠르도록 미리 띄워 둔다 (실패해도 검색 때 다시 시도)
            let warm = mcp.clone();
            std::thread::spawn(move || {
                if let Err(e) = warm.call_tool("status", json!({})) {
                    eprintln!("MCP 예열 실패: {e}");
                }
            });
            app.manage(AppState { settings: Mutex::new(settings.clone()), config_path, mcp, rec: Arc::default(), asks: Arc::default(), live: Arc::default(), busy: Arc::default(), index: Arc::default() });
            app.manage(tray::TrayState::default());
            app.state::<tray::TrayState>().apply(app.handle(), &settings); // 아이콘을 못 만들어도(OS가 거절) 앱은 계속 뜬다
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_rec_mode,
            set_checkup_done,
            tray::tray_update,
            tray::tray_hides_on_close,
            tray::tray_show_if_hidden,
            tray::set_tray_prefs,
            deferred::set_after_record,
            deferred::recording_finish,
            deferred::convert_note,
            models::models_list,
            models::doctor,
            models::models_download,
            models::models_cancel,
            models::models_remove,
            models::models_move,
            models::models_prune,
            list_meetings,
            list_recordings,
            load_meeting,
            edit_speakers,
            edit_segments,
            glossary_add,
            index_refresh,
            export_meeting,
            note_new,
            note_save,
            note_title,
            organize::list_folders,
            organize::note_meta,
            organize::folders_create,
            organize::folders_rename,
            organize::folders_move,
            organize::folders_delete,
            organize::set_list_prefs,
            mcp_call,
            rec_start,
            rec_send,
            job_start,
            summaries::summary_start,
            summaries::summaries_list,
            summaries::summaries_delete,
            summaries::templates_list,
            summaries::templates_save,
            summaries::templates_delete,
            ask_start,
            ask_cancel,
            load_chat,
            delete_meeting,
            delete_recording,
            quit_ready,
            llm_config,
            llm_key::llm_key_status,
            llm_key::llm_key_save,
            llm_key::llm_key_delete,
            llm_key::llm_settings,
            llm_key::llm_settings_save,
            llm_key::llm_default_save,
            llm_key::embedding_provider_save,
            llm_key::llm_test,
            llm_key::llm_models,
            voices::voices_list,
            voices::voices_enroll,
            voices::voices_forget
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 만들 수 없습니다")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                defer_exit(app, api);
            }
            // macOS Dock 아이콘: 창을 숨겨 둔 채(메뉴 막대에 남기기) 눌러도 다시 보인다
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
                tray::reopen(app, *has_visible_windows);
            }
            // 앱을 닫으면 녹음을 정상 종료시킨다 (WAV 헤더 마무리). 실시간 자막은 저장할 것이 없으므로 바로 끝낸다
            if let tauri::RunEvent::Exit = event {
                app.state::<tray::TrayState>().shutdown(); // 메뉴 막대 시계 타이머를 멈춘다
                let state = app.state::<AppState>();
                if let Some(stdin) = state.rec.lock().unwrap().as_mut() {
                    let _ = stdin.write_all(b"stop\n").and_then(|_| stdin.flush());
                }
                let live = state.live.lock().unwrap().take();
                if let Some(p) = live {
                    p.kill();
                }
                models::stop_download(); // 모델 받기는 멈추고 받은 부분은 남긴다 (다시 받으면 이어서)
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn speakers_command_args() {
        let edit = |v: Value| serde_json::from_value::<SpeakerEdit>(v).unwrap();
        let args = |v: Value| speakers_args("01ABC", &edit(v));
        // 인자는 `--` 뒤에 둔다: "-박" 같은 이름을 옵션으로 읽지 않게
        assert_eq!(
            args(json!({"op":"rename","label":"S1","name":" 김민수 "})).unwrap(),
            ["speakers", "01ABC", "rename", "--", "S1", "김민수"]
        );
        assert_eq!(args(json!({"op":"rename","label":"S2","name":""})).unwrap()[5], ""); // 이름 지우기
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"new"})).unwrap(), ["speakers", "01ABC", "set", "--", "s0012", "new"]);
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"S2"})).unwrap()[5], "S2");
        assert_eq!(args(json!({"op":"merge","from":"S3","into":"S1"})).unwrap(), ["speakers", "01ABC", "merge", "--", "S3", "S1"]);
        assert_eq!(args(json!({"op":"dismiss","label":"S2"})).unwrap(), ["speakers", "01ABC", "dismiss", "--", "S2"]);

        for bad in [
            json!({"op":"rename","label":"S1; rm","name":"x"}),
            json!({"op":"rename","label":"S1","name":"a\nb"}),
            json!({"op":"set","segment":"../x","label":"S1"}),
            json!({"op":"set","segment":"s0001","label":"S"}),
            json!({"op":"merge","from":"S1","into":"S1"}),
            json!({"op":"merge","from":"new","into":"S1"}),
            json!({"op":"dismiss","label":"new"}),
        ] {
            assert!(args(bad.clone()).is_err(), "{bad}");
        }
        assert!(speakers_args("../01ABC", &edit(json!({"op":"merge","from":"S2","into":"S1"}))).is_err());
        assert!(serde_json::from_value::<SpeakerEdit>(json!({"op":"list"})).is_err()); // 편집만 받는다
    }

    #[test]
    fn import_command_args() {
        let dir = std::env::temp_dir().join(format!("tractus-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("회의 녹음.MOV"); // 대소문자 무시
        std::fs::write(&file, b"x").unwrap();
        let args = import_args(&file).unwrap();
        assert_eq!(args, ["transcribe", file.to_str().unwrap(), "--progress-json"]);
        for bad in [dir.join("없음.m4a"), dir.clone(), PathBuf::from("rel/a.m4a")] {
            assert!(import_args(&bad).is_err(), "{bad:?}");
        }
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert!(import_args(&dir.join("a.txt")).is_err());
        std::fs::write(dir.join(".m4a"), b"x").unwrap();
        assert!(import_args(&dir.join(".m4a")).is_err()); // 확장자가 아니라 숨김 파일 이름
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn live_command_args() {
        let home = Path::new("/h");
        assert_eq!(live_args(home, Path::new("/h/recordings/01REC")).unwrap(), ["live", "--recording", "/h/recordings/01REC", "--progress-json"]);
        for bad in ["/etc", "/h/recordings", "/h/recordings/../x", "/h/recordings/01REC/mic.wav", "/h/meetings/01ABC"] {
            assert!(live_args(home, Path::new(bad)).is_err(), "{bad}");
        }
        let partial: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(!partial.live_captions); // 기본 꺼짐 (예전 설정 파일에는 없다)
    }

    /// 실제 `tractus live`(저장소 .venv + 0.6B·VAD 모델)를 앱과 같은 명령·환경으로 띄우고 stop으로 끝낸다.
    /// 모델이 필요해 기본에서는 빠진다: `cargo test -- --ignored real_live`
    #[test]
    #[ignore]
    fn real_live_starts_and_stops_through_app_command() {
        let home = std::env::temp_dir().join(format!("tractus-live-{}", std::process::id()));
        let dir = home.join("recordings").join("01LIVETEST");
        std::fs::create_dir_all(&dir).unwrap();
        // tractus-rec 레이아웃: 48 kHz mono 16-bit mic.wav (무음 1초) + recording.json
        let data = vec![0u8; 96000];
        let mut wav = b"RIFF".to_vec();
        wav.extend((36 + data.len() as u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend([1u16, 1].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend([48000u32, 96000].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend([2u16, 16].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend(b"data");
        wav.extend((data.len() as u32).to_le_bytes());
        wav.extend(data);
        std::fs::write(dir.join("mic.wav"), wav).unwrap();
        std::fs::write(dir.join("recording.json"), r#"{"schema_version":1,"started_at":"2026-10-07T10:00:00+09:00","duration":null,"tracks":{"mic":"mic.wav"},"marks":[]}"#).unwrap();

        let s = Settings { home: home.to_string_lossy().into_owned(), ..Default::default() };
        let (tx, rx) = std::sync::mpsc::channel();
        let p = procs::spawn_stoppable(s.tractus(&live_args(&s.home(), &dir).unwrap()), serde_json::Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        let wait_live = std::time::Instant::now();
        loop {
            let ev = rx.recv_timeout(Duration::from_secs(60)).expect("no event from tractus live");
            assert_ne!(ev["event"], "exit", "tractus live exited early: {ev}");
            if ev["stage"] == "live" {
                break;
            }
        }
        assert!(wait_live.elapsed() < Duration::from_secs(60));
        let t = std::time::Instant::now();
        assert!(p.stop(LIVE_STOP_WAIT), "not stopped by the stop line");
        assert!(t.elapsed() < Duration::from_secs(2), "stop took {:?}", t.elapsed());
        let rest: Vec<Value> = rx.try_iter().collect();
        let kinds: Vec<&str> = rest.iter().filter_map(|v| v["event"].as_str()).collect();
        assert_eq!(kinds[kinds.len() - 2..], ["done", "exit"], "{rest:?}");
        assert_eq!(rest.last().unwrap()["code"], 0);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn job_command_args() {
        let home = Path::new("/h");
        assert_eq!(job_args(home, "align", "01ABC").unwrap(), ["align", "01ABC", "--progress-json"]);
        assert_eq!(job_args(home, "summarize", "01ABC").unwrap(), ["summarize", "01ABC", "--progress-json"]);
        assert_eq!(job_args(home, "transcribe", "/h/recordings/01REC").unwrap(), ["transcribe", "--recording", "/h/recordings/01REC", "--progress-json"]);
        for (kind, target) in [("align", "../x"), ("align", ""), ("align", "01ABC --force"), ("summarize", "a/b"), ("transcribe", "/etc"), ("rm", "01ABC")] {
            assert!(job_args(home, kind, target).is_err(), "{kind} {target}");
        }
    }

    #[test]
    fn segments_edit_args_and_stdin() {
        let e = |id: &str, text: &str| TextEdit { id: id.into(), text: text.into() };
        let (args, input) = segments_edit("01ABC", &[e("s0012", "새 문장"), e("s0013", "-- $(rm) \"따옴표\"")]).unwrap();
        assert_eq!(args, ["segments", "01ABC", "edit"]); // 문장은 인수가 아니라 stdin JSON으로
        let v: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(v, json!({"edits": [{"id": "s0012", "text": "새 문장"}, {"id": "s0013", "text": "-- $(rm) \"따옴표\""}]}));
        assert!(segments_edit("../x", &[e("s0001", "a")]).is_err());
        assert!(segments_edit("01ABC", &[]).is_err());
        assert!(segments_edit("01ABC", &[e("S1", "a")]).is_err());
        assert!(segments_edit("01ABC", &[e("s0001", "  ")]).is_err()); // 빈 문장은 코어도 거부한다
    }

    #[test]
    fn glossary_command_args() {
        let t = |v: &[&str]| glossary_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(t(&[" budget ", "", "-WTO"]).unwrap(), ["glossary", "add", "--", "budget", "-WTO"]);
        assert!(t(&["  "]).is_err());
        assert!(t(&["a\nb"]).is_err());
    }

    #[test]
    fn note_command_args() {
        // 새 메모: 제목이 없으면 stdin 없이 (코어가 `메모 HH:MM`), 있으면 한 줄로 줄여 JSON으로
        assert_eq!(note_new_args(None).unwrap(), (vec!["note".to_string(), "new".into()], None));
        assert_eq!(note_new_args(Some("  \n ")).unwrap().1, None);
        let (_, input) = note_new_args(Some("  주간\n 아이디어 ")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&input.unwrap()).unwrap(), json!({"title": "주간 아이디어"}));
        assert!(note_new_args(Some(&"가".repeat(121))).is_err());

        // 저장: 본문은 stdin JSON으로 그대로 (줄바꿈·따옴표·-- 포함)
        let body = "첫 줄\n\n-- $(rm) \"따옴표\" 😀";
        let (args, input) = note_save_args("01ABC", body).unwrap();
        assert_eq!(args, ["note", "save", "01ABC"]);
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({ "body": body }));
        assert!(note_save_args("01ABC", "").is_ok(), "빈 메모도 저장한다");
        assert!(note_save_args("../x", "a").is_err());
        assert!(note_save_args("01ABC", &"가".repeat(200_000)).is_ok());
        assert_eq!(note_save_args("01ABC", &"가".repeat(200_001)).unwrap_err(), "메모는 200,000자까지 쓸 수 있습니다.");

        // 제목: 한국어·이모지는 글자 수로 센다 (코어 len과 같다), 빈 제목·너무 긴 제목은 문장으로 거절
        let (args, input, title) = note_title_args("01ABC", " 회의 😀\t정리\n").unwrap();
        assert_eq!((args, title.as_str()), (vec!["note".to_string(), "title".into(), "01ABC".into()], "회의 😀 정리"));
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), json!({"title": "회의 😀 정리"}));
        assert!(note_title_args("01ABC", &"😀".repeat(120)).is_ok());
        assert_eq!(note_title_args("01ABC", &"😀".repeat(121)).unwrap_err(), "제목은 120자까지 쓸 수 있습니다.");
        assert_eq!(note_title_args("01ABC", " \n ").unwrap_err(), "제목을 입력하세요.");
        assert!(note_title_args("a b", "x").is_err());
    }

    #[test]
    fn export_command_args() {
        let out = Path::new("/Users/me/Desktop/2026-10-02_주간회의.docx");
        assert_eq!(
            export_args("01ABC", "docx", out, None).unwrap(),
            ["export", "01ABC", "--format", "docx", "--out", out.to_str().unwrap(), "--force"] // 덮어쓰기는 저장 대화상자가 이미 물었다
        );
        assert!(export_args("01ABC", "pdf", out, None).is_err());
        assert!(export_args("01ABC", "--force", out, None).is_err());
        assert!(export_args("01ABC", "txt", Path::new("rel.txt"), None).is_err());
        assert!(export_args("../x", "txt", out, None).is_err());
        assert_eq!(export_args("01ABC", "md", out, Some("brief")).unwrap().last().unwrap(), "--summary=brief");
        assert!(export_args("01ABC", "md", out, Some("../x")).is_err() && export_args("01ABC", "md", out, Some("--force")).is_err());
    }

    #[test]
    fn busy_target_is_held_until_released() {
        let busy = Busy::default();
        let a = hold(&busy, "01AAA");
        let b = hold(&busy, "01AAA"); // 같은 노트를 쓰는 작업이 둘이면 둘 다 끝나야 풀린다
        assert!(is_busy(&busy, "01AAA") && !is_busy(&busy, "01BBB"));
        release(&busy, &a);
        assert!(is_busy(&busy, "01AAA"));
        release(&busy, &b);
        release(&busy, &b); // 두 번 풀어도 무해하다
        assert!(!is_busy(&busy, "01AAA"));
    }

    #[test]
    fn quick_edit_guard_marks_the_note_busy_and_blocks_delete_until_dropped() {
        let busy = Busy::default();
        let guard = BusyGuard::new(&busy, "01AAA");
        assert!(is_busy(&busy, "01AAA") && !is_busy(&busy, "01BBB"));
        // 삭제는 처리 중이라는 문장으로 깨끗하게 거절된다 (없는 노트로 실패하지 않는다)
        let home = std::env::temp_dir().join(format!("tractus-guard-{}", std::process::id()));
        let dir = home.join("meetings/2026-10-08_t_01AAA");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01AAA","segments":[]}"#).unwrap();
        std::fs::create_dir_all(home.join("recordings")).unwrap();
        let e = removal::note_dir(&home, "01AAA", |k| is_busy(&busy, k)).unwrap_err();
        assert!(e.contains("처리하는 중") && dir.exists());
        drop(guard);
        assert!(!is_busy(&busy, "01AAA"));
        assert!(removal::note_dir(&home, "01AAA", |k| is_busy(&busy, k)).is_ok());
        std::fs::remove_dir_all(&home).unwrap();
        // 다른 노트의 표시는 서로 영향이 없다
        let (a, b) = (BusyGuard::new(&busy, "01AAA"), BusyGuard::new(&busy, "01BBB"));
        drop(a);
        assert!(!is_busy(&busy, "01AAA") && is_busy(&busy, "01BBB"));
        drop(b);
    }

    #[test]
    fn index_refresh_runs_only_when_nothing_else_is_busy_and_one_at_a_time() {
        let busy = Busy::default();
        let first = BusyGuard::new_if_idle(&busy, INDEX_TARGET).expect("한가하면 잡는다");
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none(), "이미 갱신 중이면 하나만");
        drop(first);
        // 변환·요약·수정·녹음·가져오기 같은 다른 표시가 있으면 비켜 간다
        for target in ["01AAA", "/h/recordings/01REC", IMPORT_TARGET] {
            let key = hold(&busy, target);
            assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none(), "{target}");
            release(&busy, &key);
        }
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_some());
        // 갱신 표시는 어느 노트의 삭제도 막지 않는다
        let _g = BusyGuard::new(&busy, INDEX_TARGET);
        assert!(!is_busy(&busy, "01AAA"));
    }

    #[test]
    fn index_outcome_maps_exit_events() {
        assert_eq!(index_outcome(&json!({"code": 0, "stderr": ""})), Ok(true));
        assert_eq!(index_outcome(&json!({"code": null, "stderr": ""})), Ok(false)); // kill로 비켜 줬다
        assert_eq!(index_outcome(&json!({"code": 1, "stderr": "log\nError: 디스크가 가득 찼습니다"})), Err("디스크가 가득 찼습니다".into()));
        assert!(index_outcome(&json!({"code": 2, "stderr": ""})).unwrap_err().contains("종료 코드 2"));
    }

    #[test]
    fn global_ask_holds_a_busy_mark_that_blocks_index_but_not_delete() {
        let busy = Busy::default();
        let key = hold(&busy, ASK_TARGET);
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none());
        assert!(!is_busy(&busy, "01AAA"));
        release(&busy, &key);
    }

    #[test]
    fn cancel_index_kills_a_running_refresh_and_ignores_an_empty_slot() {
        let slot = IndexSlot::default();
        cancel_index(&slot);
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let child = Arc::new(Mutex::new(child));
        *slot.lock().unwrap() = Some(child.clone());
        cancel_index(&slot);
        let status = child.lock().unwrap().wait().unwrap();
        assert!(status.code().is_none(), "신호로 끝났다");
    }

    #[test]
    fn last_json_line() {
        assert_eq!(stdout_json("log\n{\"path\": \"/a b.txt\"}\n\n").unwrap()["path"], "/a b.txt");
        assert!(stdout_json("").is_err());
        assert!(stdout_json("done").is_err());
    }

    #[test]
    fn rec_flags_allowlist() {
        assert!(check_rec_flags(&["--no-system".into()]).is_ok());
        assert!(check_rec_flags(&["--echo-cancel".into()]).is_ok());
        assert!(check_rec_flags(&[]).is_ok());
        assert!(check_rec_flags(&["--out".into(), "/etc".into()]).is_err());
        assert!(check_rec_flags(&["--fake".into()]).is_err()); // --fake는 설정(fake_recorder)으로만
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

    #[test]
    fn last_error_line_strips_typer_prefix() {
        assert_eq!(last_error_line("로그\n같은 참석자끼리는 합칠 수 없습니다.\n").as_deref(), Some("같은 참석자끼리는 합칠 수 없습니다."));
        assert_eq!(last_error_line("Error: 이름을 입력하세요.").as_deref(), Some("이름을 입력하세요."));
        // resolve_meeting의 실제 출력 (TYPER_USE_RICH=0, param_hint="MEETING"이라 따옴표 없음)
        assert_eq!(
            last_error_line("Try 'tractus speakers --help' for help.\n\nError: Invalid value for MEETING: ‘x’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.\n").as_deref(),
            Some("‘x’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.")
        );
        assert_eq!(last_error_line("Error: Invalid value for '--recording': 녹음된 소리가 없습니다").as_deref(), Some("녹음된 소리가 없습니다"));
        assert_eq!(last_error_line(" \n"), None);
    }

    #[test]
    fn cannot_run_names_the_program() {
        assert!(procs::cannot_run("/x/recorder/.build/release/tractus-rec", "없음").starts_with("녹음 프로그램을 실행할 수 없습니다"));
        assert!(procs::cannot_run("~/.local/bin/tractus", "없음").starts_with("Tractus 엔진을 실행할 수 없습니다"));
    }

    #[test]
    fn cannot_run_keeps_the_os_text_out_of_the_sentence() {
        let e = procs::cannot_run("/x/.venv/bin/tractus", "No such file or directory (os error 2)");
        let (sentence, detail) = e.split_once('\n').expect("문장과 자세히가 줄로 갈린다");
        assert!(!sentence.contains("os error") && !sentence.contains("No such file"), "{sentence}");
        assert!(sentence.ends_with("(/x/.venv/bin/tractus)"));
        assert_eq!(detail, "No such file or directory (os error 2)");
        // 실행해 보면 실제 OS 오류도 같은 꼴이다
        let real = procs::cannot_run("/nonexistent/tractus", Command::new("/nonexistent/tractus").spawn().unwrap_err());
        assert!(real.lines().next().is_some_and(|l| !l.contains("os error")) && real.contains("os error 2"), "{real}");
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
}
