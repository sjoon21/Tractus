//! AI 서비스 설정과 API 키 (docs/desktop.md §2.14). 서비스마다 주소·AI 모델(`llm_profiles`)과 키가 따로 있고, 요약·질문은 그때그때 서비스를 고른다. 키는 앱 설정 폴더에만 둔다: Upstage는 `llm_key`(예전 그대로), 나머지는 `llm_key.<서비스>`.
//! 노트 폴더($TRACTUS_HOME)는 동기화될 수 있어 쓰지 않는다. 키는 webview·settings.json·인수·로그·오류 문구로 나가지 않고,
//! 요약·질문·연결 테스트를 돌리는 tractus 프로세스의 환경변수로만 들어간다 (Settings::tractus_llm). 고른 서비스·주소·AI 모델은 settings.json에 둔다.

use crate::i18n::{t, tv};
use crate::{ask, AppState, BusyGuard, Settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::io::Read;
use std::process::{Child, Output, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

const PROVIDER_ENV: &str = "TRACTUS_LLM_PROVIDER";
const BASE_URL_ENV: &str = "TRACTUS_LLM_BASE_URL";
const MODEL_ENV: &str = "TRACTUS_LLM_MODEL";
/// 고를 수 있는 AI 서비스 (코어 PROVIDERS의 이름) → (키를 싣는 환경변수, 기본 주소). 목록에 있는 이름만 파일 이름에 쓴다 (^[a-z0-9-]+$).
/// 기본 주소는 코어 llm.PROVIDERS와 같아야 한다 (끝의 `/`는 뗀다). 직접 입력은 기본 주소가 없다
const PROVIDERS: [(&str, &str, &str); 5] = [
    ("upstage", "UPSTAGE_API_KEY", "https://api.upstage.ai/v1"),
    ("openai", "OPENAI_API_KEY", "https://api.openai.com/v1"),
    ("claude", "ANTHROPIC_API_KEY", "https://api.anthropic.com/v1"),
    ("gemini", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai"),
    ("custom", "TRACTUS_LLM_API_KEY", ""),
];
pub const DEFAULT_PROVIDER: &str = "upstage";
const MIN_LEN: usize = 5;
const MAX_LEN: usize = 200;
const MODEL_MAX: usize = 200;
fn local_only_embed() -> String {
    t("로컬 전용 모드에서는 스마트 검색을 Upstage로 처리할 수 없습니다.")
}
/// 코어는 30초에 스스로 끝낸다 (llm.TEST_TIMEOUT_S). 그래도 안 끝나면 이 시간 뒤에 죽여 BusyGuard가 풀리게 한다
const TEST_DEADLINE: Duration = Duration::from_secs(35);
/// 연결 테스트가 도는 동안 표시하는 대상 (노트가 아니므로 삭제를 막지 않는다)
const TEST_TARGET: &str = "<llm-test>";

pub fn is_provider(id: &str) -> bool {
    PROVIDERS.iter().any(|(p, ..)| *p == id)
}

/// 서비스 이름들 (표의 순서)
pub fn provider_ids() -> impl Iterator<Item = &'static str> {
    PROVIDERS.iter().map(|(p, ..)| *p)
}

/// 표에 있는 이름이면 그 이름(정적 문자열), 아니면 None
pub fn canonical(id: &str) -> Option<&'static str> {
    PROVIDERS.iter().find(|(p, ..)| *p == id).map(|(p, ..)| *p)
}

/// 서비스마다 저장하는 주소·AI 모델 (비어 있으면 서비스 기본값)
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Profile {
    pub base_url: String,
    pub model: String,
}

/// 쓸 수 있는 서비스인가: 키가 등록돼 있거나, 이 Mac 주소의 직접 입력 (키 없이 쓴다)
pub fn usable(provider: &str, base_url: &str, key_saved: bool) -> bool {
    key_saved || (provider == "custom" && is_loopback(base_url))
}

/// 예전 settings.json의 `llm_provider`·`llm_base_url`·`llm_model`(한 서비스만)을 `llm_default`와 `llm_profiles`로 옮기고 예전 키는 지운다.
/// 새 형식이 이미 있으면 예전 값은 버린다. 모르는 서비스 이름은 무시한다
pub fn migrate_llm(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else { return };
    let old = ["llm_provider", "llm_base_url", "llm_model"].map(|k| obj.remove(k).and_then(|x| x.as_str().map(String::from)));
    if obj.contains_key("llm_profiles") || obj.contains_key("llm_default") {
        return;
    }
    let [Some(provider), base, model] = old else { return };
    let Some(provider) = canonical(&provider) else { return };
    obj.insert("llm_default".into(), provider.into());
    let (base_url, model) = (base.unwrap_or_default(), model.unwrap_or_default());
    if !base_url.is_empty() || !model.is_empty() {
        obj.insert("llm_profiles".into(), serde_json::json!({ provider: { "base_url": base_url, "model": model } }));
    }
}

fn key_env(provider: &str) -> Option<&'static str> {
    PROVIDERS.iter().find(|(p, ..)| *p == provider).map(|(_, e, _)| *e)
}

/// 서비스의 기본 주소 (직접 입력은 None)
pub fn default_url(provider: &str) -> Option<&'static str> {
    PROVIDERS.iter().find(|(p, ..)| *p == provider).map(|(.., u)| *u).filter(|u| !u.is_empty())
}

/// 서비스의 기본 AI 모델 (코어 llm.PROVIDERS와 같아야 한다. OpenAI·직접 입력은 없다)
fn default_model(provider: &str) -> Option<&'static str> {
    match provider {
        "upstage" => Some("solar-pro4"),
        "claude" => Some("claude-sonnet-5-5"),
        "gemini" => Some("gemini-flash-latest"),
        _ => None,
    }
}

/// 셸·.env가 정한 서비스가 이 앱의 다섯 서비스가 아닌 이름(예: gemma-local)이면 그것. 그러면 서비스·주소·AI 모델을 모두 환경이 정한다.
/// 다섯 서비스 이름이면 기본값일 뿐이다: 앱이 고른 서비스가 이긴다 (저장소 .env의 `TRACTUS_LLM_PROVIDER=upstage`가 Gemini를 Upstage로 돌리지 않게)
pub fn fixed_provider(set: &ask::LlmConfig) -> Option<&str> {
    set.provider.as_deref().filter(|p| canonical(p).is_none())
}

/// 앱이 서비스를 정하는가: 환경이 앱 밖의 서비스를 정하지 않았고, 환경이 다섯 서비스 중 하나를 정했다면 고른 서비스가 쓸 수 있을 때만
/// (키를 .env.local에만 두는 예전 개발 환경은 그대로 환경 것)
fn app_decides(c: &Choice, key_saved: bool, set: &ask::LlmConfig) -> bool {
    fixed_provider(set).is_none() && (set.provider.is_none() || usable(c.provider, c.base_url, key_saved))
}

fn check_provider(id: &str) -> Result<&str, String> {
    if is_provider(id) {
        Ok(id)
    } else {
        Err(tv("알 수 없는 AI 서비스입니다: {id}", &[("id", id.to_string())]))
    }
}

/// Upstage는 예전 파일 이름(`llm_key`)을 그대로 쓴다. 그 밖의 서비스는 `llm_key.<서비스>`
fn file_name(provider: &str) -> String {
    if provider == DEFAULT_PROVIDER {
        "llm_key".into()
    } else {
        format!("llm_key.{provider}")
    }
}

/// 저장 전 검증. 앞뒤 공백은 떼고, 길이와 공백·제어 문자, 인쇄 가능한 ASCII 밖의 글자(HTTP 헤더에 못 실린다)를 본다. 오류 문장에 키를 넣지 않는다
pub fn validate(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    let len = key.chars().count();
    if len == 0 {
        return Err(t("API 키를 입력하세요."));
    }
    if !(MIN_LEN..=MAX_LEN).contains(&len) {
        return Err(tv("API 키는 {MIN_LEN}자에서 {MAX_LEN}자 사이여야 합니다.", &[("MIN_LEN", MIN_LEN.to_string()), ("MAX_LEN", MAX_LEN.to_string())]));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(t("API 키 중간에 공백이나 줄바꿈이 있습니다. 키만 그대로 붙여 넣으세요."));
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(t("API 키에 영문·숫자·기호가 아닌 글자가 있습니다. 키만 그대로 붙여 넣으세요."));
    }
    Ok(key.to_string())
}

/// 저장된 키. 없거나 비어 있거나 모르는 서비스면 None
pub fn load(dir: &Path, provider: &str) -> Option<String> {
    check_provider(provider).ok()?;
    let raw = fs::read_to_string(dir.join(file_name(provider))).ok()?;
    Some(raw.trim().to_string()).filter(|k| !k.is_empty())
}

/// 임시 파일(0600으로 만든다) → rename. 덮어쓸 때도 권한을 0600으로 맞춘다
pub fn save(dir: &Path, provider: &str, raw: &str) -> Result<(), String> {
    let file = file_name(check_provider(provider)?);
    let key = validate(raw)?;
    let fail = |e: std::io::Error| tv("API 키를 저장하지 못했습니다\n{e}", &[("e", e.to_string())]);
    fs::create_dir_all(dir).map_err(fail)?;
    let tmp = dir.join(format!("{file}.tmp"));
    let written = (|| {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?; // 임시 파일이 남아 있었어도
        f.write_all(key.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, dir.join(&file))
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        fail(e)
    })
}

/// 없어도 성공
pub fn delete(dir: &Path, provider: &str) -> Result<(), String> {
    match fs::remove_file(dir.join(file_name(check_provider(provider)?))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(tv("API 키를 지우지 못했습니다\n{e}", &[("e", e.to_string())])),
        _ => Ok(()),
    }
}

// ── 주소: 코어 llm.py의 host_of / is_loopback / normalize_base_url과 같은 규칙 ──

/// (호스트(소문자, 대괄호 없음), 포트). http/https + 호스트가 있고 사용자 이름·비밀번호·공백·역슬래시가 없을 때만
fn parse_url(url: &str) -> Option<(String, Option<String>)> {
    let url = url.trim().to_ascii_lowercase();
    let rest = url.strip_prefix("http://").or_else(|| url.strip_prefix("https://"))?;
    if url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '\\') {
        return None;
    }
    let auth = rest.split(['/', '?', '#']).next()?;
    if auth.contains('@') {
        return None;
    }
    let (host, port) = match auth.strip_prefix('[') {
        Some(r) => {
            let (h, after) = r.split_once(']')?;
            (h, if after.is_empty() { None } else { Some(after.strip_prefix(':')?) })
        }
        None => auth.rsplit_once(':').map_or((auth, None), |(h, p)| (h, Some(p))),
    };
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok());
    (!host.is_empty() && port_ok).then(|| (host.to_string(), port.map(String::from)))
}

fn has_userinfo(url: &str) -> bool {
    let url = url.trim().to_ascii_lowercase();
    url.strip_prefix("http://").or_else(|| url.strip_prefix("https://")).and_then(|r| r.split(['/', '?', '#']).next().map(|a| a.contains('@'))).unwrap_or(false)
}

/// 화면에 보일 호스트 (`host` 또는 `host:포트`). 경로·계정 정보는 버린다
pub fn host_of(url: &str) -> Option<String> {
    let (host, port) = parse_url(url)?;
    let host = if host.contains(':') { format!("[{host}]") } else { host };
    Some(match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    })
}

/// 호스트가 정확히 localhost / 127.0.0.1 / ::1인가 (localhost.evil.com, user@host 속임수는 아니다)
pub fn is_loopback(url: &str) -> bool {
    parse_url(url).is_some_and(|(h, _)| matches!(h.as_str(), "localhost" | "127.0.0.1" | "::1"))
}

/// 저장하는 주소: 비어 있으면 "서비스 기본 주소". 아니면 http/https + 호스트, 계정 정보 없이, 끝의 `/`는 뗀다
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    if has_userinfo(raw) {
        return Err(t("서비스 주소에 사용자 이름이나 비밀번호를 넣을 수 없습니다. API 키는 따로 입력하세요."));
    }
    match parse_url(raw) {
        Some(_) => Ok(raw.trim_end_matches('/').to_string()),
        None => Err(t("서비스 주소는 http:// 또는 https://로 시작하는 올바른 주소여야 합니다.")),
    }
}

/// AI 모델 이름: 비어 있으면 서비스 기본값. 공백·제어 문자 없이 200자까지
pub fn normalize_model(raw: &str) -> Result<String, String> {
    let model = raw.trim();
    if model.chars().count() > MODEL_MAX || model.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(t("AI 모델 이름에는 공백이나 줄바꿈을 넣을 수 없고 200자까지 쓸 수 있습니다."));
    }
    Ok(model.to_string())
}

/// settings.json에 두는 선택 (서비스·주소·AI 모델). 주소·AI 모델이 비어 있으면 서비스 기본값
pub struct Choice<'a> {
    pub provider: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
}

/// LLM을 부르는 tractus 프로세스에만 덧붙이는 환경변수. 선택한 서비스의 키만 그 서비스의 환경변수로 싣는다.
/// 앱 프로세스(셸)에 이미 있는 키 환경변수는 덮어쓰지 않는다.
/// 앱이 서비스를 정할 때는 서비스(TRACTUS_LLM_PROVIDER)와 주소를 키와 함께 늘 싣는다: 셸·.env의 값이 이 서비스의 키와 대화 내용을 엉뚱한 서비스·주소로 받지 못하게
/// (입력칸이 비어 있으면 서비스 기본 주소). 주소가 없는 직접 입력은 키를 싣지 않는다. AI 모델은 입력칸이 비었을 때 환경 것이 쓰이지만,
/// 환경이 다른 서비스를 정해 놓았으면 그 서비스의 모델이므로 이 서비스의 기본 모델을 싣는다 (ponytail: 기본 모델이 없는 OpenAI·직접 입력은 입력이 필수라 겹치지 않는다).
/// 환경이 앱 밖의 서비스(gemma-local 등)를 정했거나, 고른 서비스를 쓸 수 없는 채 환경이 서비스를 정했으면 아무것도 싣지 않는다 (환경 것).
/// 아무것도 설정하지 않은 처음 상태(Upstage, 키 없음)도 지금까지와 똑같이 아무것도 싣지 않는다
pub fn env(c: &Choice, key: Option<&str>, process_env: impl Fn(&str) -> Option<String>, set: &ask::LlmConfig) -> Vec<(String, String)> {
    let mut env = vec![];
    if !app_decides(c, key.is_some(), set) {
        return env;
    }
    let no_target = c.base_url.is_empty() && default_url(c.provider).is_none();
    if let (Some(key), Some(name)) = (key, key_env(c.provider)) {
        if !no_target && process_env(name).is_none_or(|v| v.is_empty()) {
            env.push((name.to_string(), key.to_string()));
        }
    }
    let pristine = key.is_none() && c.provider == DEFAULT_PROVIDER && c.base_url.is_empty() && c.model.is_empty();
    if !pristine {
        env.push((PROVIDER_ENV.to_string(), c.provider.to_string()));
        let base = if c.base_url.is_empty() { default_url(c.provider).unwrap_or("") } else { c.base_url };
        let other_env = set.provider.as_deref().is_some_and(|p| p != c.provider);
        let model = if c.model.is_empty() && other_env { default_model(c.provider).unwrap_or("") } else { c.model };
        for (name, value) in [(BASE_URL_ENV, base), (MODEL_ENV, model)] {
            if !value.is_empty() {
                env.push((name.to_string(), value.to_string()));
            }
        }
    }
    env
}

/// 보내기 전 안내용: 앱이 서비스를 정하면(env()와 같은 조건) 설정 화면의 선택, 아니면 환경 것. 앱이 정하면 주소(입력칸이 비면 서비스 기본 주소)는 앱 것이고
/// (env()가 그렇게 싣는다), AI 모델은 입력칸이 비었을 때만 환경 것이다 (환경이 다른 서비스를 정했으면 환경 모델은 버리고 화면이 기본 모델을 보인다).
/// 키가 없는 서비스는 "설정되지 않음"(이 Mac의 주소로 직접 입력한 경우만 키 없이 쓴다)
pub fn effective(cfg: ask::LlmConfig, c: &Choice, key_saved: bool) -> ask::LlmConfig {
    let (provider, model, base) = if !app_decides(c, key_saved, &cfg) {
        (cfg.provider, cfg.model, cfg.base_url)
    } else {
        let usable = usable(c.provider, c.base_url, key_saved);
        let some = |v: &str| Some(v.to_string()).filter(|v| !v.is_empty());
        let base = some(c.base_url).or_else(|| default_url(c.provider).map(String::from)).or(cfg.base_url);
        let env_model = cfg.model.filter(|_| cfg.provider.as_deref().is_none_or(|p| p == c.provider));
        (usable.then(|| c.provider.to_string()), some(c.model).or(env_model), base)
    };
    ask::LlmConfig { provider, model, local_only: cfg.local_only, host: base.as_deref().and_then(host_of), base_url: None }
}

fn dir(state: &AppState) -> Result<&Path, String> {
    state.config_path.parent().ok_or_else(|| t("앱 설정 폴더를 찾을 수 없습니다"))
}

#[derive(Serialize)]
pub struct KeyStatus {
    saved: bool,
}

/// 키 자체는 돌려주지 않는다
#[tauri::command]
pub fn llm_key_status(state: State<'_, AppState>, provider: String) -> Result<KeyStatus, String> {
    check_provider(&provider)?;
    Ok(KeyStatus { saved: dir(&state).ok().and_then(|d| load(d, &provider)).is_some() })
}

#[tauri::command]
pub fn llm_key_save(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    save(dir(&state)?, &provider, &key)?;
    refresh_mcp(&state);
    Ok(())
}

/// Upstage 키가 바뀌면 상주 검색 프로세스의 환경도 바뀐다 (스마트 검색을 Upstage로 쓸 때만 그 키가 실린다)
fn refresh_mcp(state: &AppState) {
    state.mcp.set_spawn(state.settings().mcp_spawn());
}

#[tauri::command]
pub fn llm_key_delete(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    delete(dir(&state)?, &provider)?;
    refresh_mcp(&state);
    Ok(())
}

#[derive(Serialize)]
pub struct LlmSettings {
    /// 요약·질문에서 서비스를 따로 고르지 않을 때 쓰는 서비스 (등록된 것 중에서: 고른 서비스가 등록돼 있지 않으면 등록된 첫 서비스)
    default: String,
    /// 서비스마다 저장한 주소·AI 모델 (비어 있으면 서비스 기본값). 다섯 서비스가 모두 있다
    profiles: BTreeMap<String, Profile>,
    /// 서비스별 키가 등록돼 있는가 (불리언만)
    saved: BTreeMap<String, bool>,
    /// 지금 쓸 수 있는 서비스 (키가 있거나 이 Mac 주소의 직접 입력), 표의 순서대로
    registered: Vec<String>,
    /// AI 모델·주소를 셸이나 .env.local이 정하고 있는가, 또는 서비스를 앱 밖의 것으로 정하고 있는가 (이 화면의 선택보다 그쪽이 먼저일 수 있다)
    env_override: bool,
    /// 서비스 자체를 이 앱의 다섯 서비스가 아닌 것(gemma-local 등)으로 환경이 정하고 있는가 (그러면 요약·질문에서 서비스를 고를 수 없다)
    provider_fixed: bool,
    /// 스마트 검색 방식: "local"(이 Mac) | "upstage"
    embedding_provider: String,
    /// 로컬 전용 모드(TRACTUS_LOCAL_ONLY)인가: 그러면 Upstage로 보내지 않는다 (스마트 검색 방식에서 Upstage를 고를 수 없다)
    local_only: bool,
}

#[tauri::command]
pub async fn llm_settings(state: State<'_, AppState>) -> Result<LlmSettings, String> {
    let s = state.settings();
    crate::blocking(move || {
        let saved = PROVIDERS.iter().map(|(p, ..)| (p.to_string(), s.key_saved(p))).collect();
        let profiles = PROVIDERS.iter().map(|(p, ..)| (p.to_string(), s.llm_profiles.get(*p).cloned().unwrap_or_default())).collect();
        let set = ask::llm_config(&[&s.tractus_cwd(), &s.home()], |k| std::env::var(k).ok());
        let fixed = fixed_provider(&set).is_some();
        let env_override = fixed || set.model.is_some() || set.base_url.is_some();
        let registered = s.registered().into_iter().map(String::from).collect();
        Ok(LlmSettings { default: s.default_provider().into(), profiles, saved, registered, env_override, provider_fixed: fixed, embedding_provider: s.embedding_provider.clone(), local_only: set.local_only })
    })
    .await
}

/// 설정 파일의 한 서비스의 주소·AI 모델만 바꾼다 (다른 서비스·다른 설정은 그대로)
fn with_profile(v: &mut Value, provider: &str, base_url: &str, model: &str) {
    if !v["llm_profiles"].is_object() {
        v["llm_profiles"] = serde_json::json!({});
    }
    v["llm_profiles"][provider] = serde_json::json!({ "base_url": base_url, "model": model });
}

/// 설정 파일을 읽어 (예전 AI 서비스 설정은 옮기고) 고친 뒤 쓴다. 파일이 없거나 깨졌으면 고친 항목만 쓴다:
/// 환경변수에서 온 home 같은 기본값이 파일에 굳지 않게 (merge_rec_mode와 같은 방식)
fn patch_file(state: &AppState, edit: impl FnOnce(&mut Value)) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| {
        let mut v = raw.and_then(|r| serde_json::from_str::<Value>(r).ok()).filter(Value::is_object).unwrap_or_else(|| serde_json::json!({}));
        migrate_llm(&mut v);
        edit(&mut v);
        serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
    })
}

/// 한 서비스의 주소·AI 모델을 저장한다
#[tauri::command]
pub fn llm_settings_save(state: State<'_, AppState>, provider: String, base_url: String, model: String) -> Result<(), String> {
    let provider = check_provider(&provider)?.to_string();
    let (base_url, model) = (normalize_base_url(&base_url)?, normalize_model(&model)?);
    patch_file(&state, |v| with_profile(v, &provider, &base_url, &model))?;
    state.settings.lock().unwrap().llm_profiles.insert(provider, Profile { base_url, model });
    refresh_mcp(&state); // Upstage 주소가 바뀌면 상주 검색 프로세스가 옛 주소로 키를 보내지 않게
    Ok(())
}

/// 요약·질문의 기본 서비스를 바꾼다
#[tauri::command]
pub fn llm_default_save(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    let provider = check_provider(&provider)?.to_string();
    patch_file(&state, |v| v["llm_default"] = provider.clone().into())?;
    state.settings.lock().unwrap().llm_default = provider;
    Ok(())
}

/// 스마트 검색 방식을 바꾼다. Upstage는 Upstage 키가 있어야 한다. 상주 검색 프로세스는 다음 호출 때 새 환경으로 다시 뜬다
/// (옵트인일 때만 그 키를 싣는다: Settings::embed_key_env)
#[tauri::command]
pub fn embedding_provider_save(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    if !matches!(provider.as_str(), "local" | "upstage") {
        return Err(tv("알 수 없는 스마트 검색 방식입니다: {provider}", &[("provider", provider.to_string())]));
    }
    let s = state.settings();
    if provider == "upstage" && !s.key_saved("upstage") {
        return Err(t("Upstage API 키를 먼저 등록하세요."));
    }
    if provider == "upstage" && ask::llm_config(&[&s.tractus_cwd(), &s.home()], |k| std::env::var(k).ok()).local_only {
        return Err(local_only_embed());
    }
    patch_file(&state, |v| v["embedding_provider"] = provider.clone().into())?;
    state.settings.lock().unwrap().embedding_provider = provider;
    refresh_mcp(&state);
    Ok(())
}

/// 연결 테스트 결과. 실패해도 화면이 문장으로 바꿀 수 있게 code·message를 싣는다 (키는 어디에도 없다)
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct TestResult {
    pub ok: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub host: Option<String>,
    pub latency_ms: Option<u64>,
    /// 서비스가 응답했지만 내용이 비어 있었다 (생각하는 AI가 토큰을 생각에 다 쓴 경우). 연결은 된 것이다
    pub empty: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// `tractus llm test`의 stdout 마지막 JSON 한 줄 → 결과. 성공 줄이 없으면 error 이벤트, 그것도 없으면 stderr 마지막 줄
pub fn parse_test(stdout: &str, stderr: &str, exit_ok: bool) -> TestResult {
    let line = stdout.lines().rev().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).find(|v| v.is_object());
    let get = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
    match line {
        Some(v) if exit_ok && v["ok"] == true => TestResult { ok: true, provider: get(&v, "provider"), model: get(&v, "model"), host: get(&v, "host"), latency_ms: v["latency_ms"].as_u64(), empty: v["empty"] == true, ..Default::default() },
        Some(v) if v["event"] == "error" => TestResult { code: get(&v, "code"), message: get(&v, "message"), ..Default::default() },
        _ => TestResult { message: crate::last_error_line(stderr).or_else(|| Some(t("연결 테스트 결과를 읽지 못했습니다"))), ..Default::default() },
    }
}

/// 직접 입력은 이 Mac이 아니면 키가 있어야 한다. 요약·질문에서는 코어가 같은 검사를 한다 (llm_config)
fn custom_needs_key(c: &Choice, key: Option<&str>) -> bool {
    c.provider == "custom" && key.is_none() && !is_loopback(c.base_url)
}

/// `wait_with_output`에 시간 제한을 붙인다: 넘기면 죽이고 None. 출력은 별도 스레드가 읽는다 (파이프가 차서 멈추지 않게)
/// ponytail: 자식만 죽인다 (손자 프로세스까지는 아니다)
fn wait_with_deadline(mut child: Child, limit: Duration) -> Result<Option<Output>, String> {
    fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = vec![];
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        })
    }
    let (out, err) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if start.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(None);
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    Ok(Some(Output { status, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() }))
}

/// `tractus llm <sub>`를 선택한 서비스의 환경(실제 요약·질문과 같은 환경변수)으로 시간 제한 안에 돌린다.
/// 실행하기 전에 막히거나(키 없는 직접 입력) 시간이 넘으면 Err(코드, 문장). 실행하지 못하면 바깥 Err(화면 문장)
fn run_llm_sub(s: &Settings, config_dir: Option<&Path>, provider: Option<&str>, env: impl Fn(&str) -> Option<String>, sub: &str) -> Result<Result<Output, (&'static str, String)>, String> {
    let set = ask::llm_config(&[&s.tractus_cwd(), &s.home()], &env);
    let c = s.llm_choice(provider)?;
    if set.provider.is_none() && custom_needs_key(&c, config_dir.and_then(|d| load(d, c.provider)).as_deref()) {
        return Ok(Err(("llm_config", t("직접 입력한 서비스는 이 Mac이 아니면 API 키가 필요합니다"))));
    }
    let mut cmd = s.tractus_llm_with(&["llm", sub], config_dir, provider, env)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| crate::procs::cannot_run(&s.tractus_resolved().path, e))?;
    Ok(wait_with_deadline(child, TEST_DEADLINE)?.ok_or_else(|| ("llm_conn", t("시간이 너무 오래 걸렸습니다"))))
}

pub fn run_test_for(s: &Settings, config_dir: Option<&Path>, provider: Option<&str>, env: impl Fn(&str) -> Option<String>) -> Result<TestResult, String> {
    Ok(match run_llm_sub(s, config_dir, provider, env, "test")? {
        Ok(out) => parse_test(&String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr), out.status.success()),
        Err((code, message)) => TestResult { code: Some(code.into()), message: Some(message), ..Default::default() },
    })
}

/// 저장된 선택과 키로 `tractus llm test`를 돌린다. 한 번에 하나만, 노트는 잠그지 않는다. provider가 없으면 기본 서비스
#[tauri::command]
pub async fn llm_test(state: State<'_, AppState>, provider: Option<String>) -> Result<TestResult, String> {
    if crate::is_busy(&state.busy, TEST_TARGET) {
        return Err(t("이미 연결을 확인하고 있습니다."));
    }
    let guard = BusyGuard::new(&state.busy, TEST_TARGET);
    let s = state.settings();
    let config_dir = state.config_path.parent().map(Path::to_path_buf);
    crate::blocking(move || {
        let _guard = guard;
        run_test_for(&s, config_dir.as_deref(), provider.as_deref(), |k| std::env::var(k).ok())
    })
    .await
}

/// `tractus llm models`의 결과: 서비스가 아는 AI 모델 이름들. 실패하면 models는 비고 code·message가 있다 (키는 어디에도 없다)
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct ModelList {
    pub models: Vec<String>,
    pub code: Option<String>,
    pub message: Option<String>,
}

/// stdout 마지막 JSON 줄 `{"models": [...]}` → 목록. 성공 줄이 없으면 error 이벤트, 그것도 없으면 stderr 마지막 줄
pub fn parse_models(stdout: &str, stderr: &str, exit_ok: bool) -> ModelList {
    let line = stdout.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v.is_object());
    let get = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    match line {
        Some(v) if exit_ok && v["models"].is_array() => ModelList { models: v["models"].as_array().unwrap().iter().filter_map(|m| m.as_str().map(String::from)).collect(), ..Default::default() },
        Some(v) if v["event"] == "error" => ModelList { code: get(&v, "code"), message: get(&v, "message"), ..Default::default() },
        _ => ModelList { message: crate::last_error_line(stderr).or_else(|| Some(t("AI 모델 목록을 읽지 못했습니다"))), ..Default::default() },
    }
}

pub fn run_models_for(s: &Settings, config_dir: Option<&Path>, provider: Option<&str>, env: impl Fn(&str) -> Option<String>) -> Result<ModelList, String> {
    Ok(match run_llm_sub(s, config_dir, provider, env, "models")? {
        Ok(out) => parse_models(&String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr), out.status.success()),
        Err((code, message)) => ModelList { code: Some(code.into()), message: Some(message), ..Default::default() },
    })
}

/// 서비스가 아는 AI 모델 이름 목록 (설정의 `모델 목록 불러오기`). 연결 테스트와 같은 시간 제한
#[tauri::command]
pub async fn llm_models(state: State<'_, AppState>, provider: Option<String>) -> Result<ModelList, String> {
    let s = state.settings();
    let config_dir = state.config_path.parent().map(Path::to_path_buf);
    crate::blocking(move || run_models_for(&s, config_dir.as_deref(), provider.as_deref(), |k| std::env::var(k).ok())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const KEY: &str = "test-key-123";

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-llmkey-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn mode(p: &Path) -> u32 {
        fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn validates_length_and_characters() {
        assert_eq!(validate("  test-key-123\n").unwrap(), KEY);
        assert!(validate("").is_err());
        assert!(validate("   ").is_err());
        assert!(validate("1234").is_err()); // 4자
        assert!(validate("12345").is_ok()); // 5자부터
        assert!(validate(&"a".repeat(200)).is_ok());
        assert!(validate(&"a".repeat(201)).is_err());
        assert!(validate("test key 123").is_err());
        assert!(validate("test-key\n123").is_err());
        assert!(validate("test-key-\u{7}123").is_err());
        assert!(validate("test-key\u{3000}123").is_err()); // 전각 공백
        assert!(validate("test-\u{201c}key-123").is_err()); // 둥근 따옴표
        assert!(validate("test-키-1234567").is_err()); // 한글
        assert!(validate("test-key-ＡＢＣ123").is_err()); // 전각 영문
    }

    #[test]
    fn errors_never_contain_the_key() {
        for bad in ["secret key with spaces", "ab12", "secret\u{7}key-123456", "secret\u{201c}key-123456"] {
            let e = validate(bad).unwrap_err();
            assert!(!e.contains("secret") && !e.contains(bad), "{e}");
        }
        let d = tmp("err");
        fs::create_dir_all(&d).unwrap();
        fs::create_dir(d.join("llm_key.claude")).unwrap(); // 파일 자리에 폴더: rename이 실패한다
        let e = save(&d, "claude", KEY).unwrap_err();
        assert!(!e.contains(KEY) && !format!("{e:?}").contains(KEY), "{e}");
        assert!(!d.join("llm_key.claude.tmp").exists()); // 임시 파일을 치운다
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn provider_ids_are_a_fixed_safe_list() {
        for (p, env, _) in PROVIDERS {
            assert!(p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "{p}");
            assert!(env.ends_with("_KEY") && is_provider(p));
        }
        let d = tmp("ids");
        for bad in ["", "../x", "upstage/../x", "Upstage", "claude ", "gemma-local", "llm_key", "a/b"] {
            assert!(!is_provider(bad), "{bad}");
            assert!(save(&d, bad, KEY).is_err() && delete(&d, bad).is_err() && load(&d, bad).is_none(), "{bad}");
        }
        assert!(!d.exists(), "나쁜 이름은 폴더도 만들지 않는다");
    }

    #[test]
    fn upstage_keeps_the_legacy_file_and_others_get_their_own() {
        let d = tmp("files");
        save(&d, "upstage", KEY).unwrap();
        save(&d, "claude", "claude-key-456").unwrap();
        assert_eq!(fs::read_to_string(d.join("llm_key")).unwrap(), KEY); // 예전 설치의 키 그대로
        assert_eq!(fs::read_to_string(d.join("llm_key.claude")).unwrap(), "claude-key-456");
        assert_eq!(load(&d, "upstage").as_deref(), Some(KEY));
        assert_eq!(load(&d, "claude").as_deref(), Some("claude-key-456"));
        assert_eq!(load(&d, "openai"), None);
        delete(&d, "claude").unwrap();
        assert_eq!((load(&d, "claude"), load(&d, "upstage").as_deref()), (None, Some(KEY))); // 서비스마다 따로
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn save_creates_0600_and_rewrite_keeps_it() {
        for provider in ["upstage", "gemini"] {
            let d = tmp(&format!("save-{provider}")).join("config"); // 폴더가 없어도 만든다
            let file = file_name(provider);
            assert_eq!(load(&d, provider), None);
            save(&d, provider, &format!("  {KEY} ")).unwrap();
            let p = d.join(&file);
            assert_eq!(fs::read_to_string(&p).unwrap(), KEY); // 트림해서 저장
            assert_eq!(mode(&p), 0o600);
            assert_eq!(load(&d, provider).as_deref(), Some(KEY));
            // 넓은 권한으로 바뀌어 있어도 다시 쓰면 0600
            fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
            save(&d, provider, "another-key-456").unwrap();
            assert_eq!(fs::read_to_string(&p).unwrap(), "another-key-456");
            assert_eq!(mode(&p), 0o600);
            // 남아 있던 임시 파일이 넓은 권한이어도 결과는 0600
            let t = d.join(format!("{file}.tmp"));
            fs::write(&t, "old").unwrap();
            fs::set_permissions(&t, fs::Permissions::from_mode(0o644)).unwrap();
            save(&d, provider, KEY).unwrap();
            assert_eq!(mode(&p), 0o600);
            assert!(!t.exists());
            // 잘못된 키는 기존 파일을 건드리지 않는다
            assert!(save(&d, provider, "ab12").is_err());
            assert_eq!(load(&d, provider).as_deref(), Some(KEY));
            fs::remove_dir_all(d.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn delete_is_idempotent_and_status_follows() {
        let d = tmp("del");
        delete(&d, "openai").unwrap(); // 폴더도 파일도 없다
        save(&d, "openai", KEY).unwrap();
        assert!(load(&d, "openai").is_some());
        delete(&d, "openai").unwrap();
        assert_eq!(load(&d, "openai"), None);
        delete(&d, "openai").unwrap();
        fs::write(d.join("llm_key.openai"), " \n").unwrap(); // 비어 있으면 등록 안 됨
        assert_eq!(load(&d, "openai"), None);
        fs::remove_dir_all(&d).unwrap();
    }

    fn cfg(provider: Option<&str>) -> ask::LlmConfig {
        ask::LlmConfig { provider: provider.map(String::from), model: None, local_only: false, host: None, base_url: None }
    }

    fn pairs(v: Vec<(String, String)>) -> Vec<(String, String)> {
        v
    }

    fn kv(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn env_injection_rules() {
        let none = |_: &str| None;
        let up = Choice { provider: "upstage", base_url: "", model: "" };
        assert!(env(&up, None, none, &cfg(None)).is_empty()); // 처음 상태: 지금과 똑같이
        let both = kv(&[("UPSTAGE_API_KEY", KEY), ("TRACTUS_LLM_PROVIDER", "upstage"), ("TRACTUS_LLM_BASE_URL", "https://api.upstage.ai/v1")]);
        assert_eq!(pairs(env(&up, Some(KEY), none, &cfg(None))), both);
        // 환경이 다른 서비스(openai)를 정해 두어도 앱이 고른 서비스가 이긴다: 서비스·주소를 키와 함께 싣는다. 환경 모델은 이 서비스에 가지 않게 기본 모델을 싣는다
        let with_env = |p: &str, model: &str| ask::LlmConfig { model: Some(model.into()), ..cfg(Some(p)) };
        let e = env(&up, Some(KEY), none, &with_env("openai", "gpt-env"));
        assert_eq!(e, kv(&[("UPSTAGE_API_KEY", KEY), ("TRACTUS_LLM_PROVIDER", "upstage"), ("TRACTUS_LLM_BASE_URL", "https://api.upstage.ai/v1"), ("TRACTUS_LLM_MODEL", "solar-pro4")]));
        // 같은 서비스를 정했으면 환경 모델은 입력칸이 빌 때 그대로 쓰인다 (싣지 않는다)
        assert_eq!(env(&up, Some(KEY), none, &with_env("upstage", "solar-env")), kv(&[("UPSTAGE_API_KEY", KEY), ("TRACTUS_LLM_PROVIDER", "upstage"), ("TRACTUS_LLM_BASE_URL", "https://api.upstage.ai/v1")]));
        // 앱 밖의 서비스(gemma-local)를 정했으면 환경이 모두 정한다: 키도 싣지 않는다
        assert!(env(&up, Some(KEY), none, &cfg(Some("gemma-local"))).is_empty());
        // 환경이 서비스를 정해 두었는데 고른 서비스를 쓸 수 없으면(키를 .env.local에만 두는 개발 환경) 환경 것
        assert!(env(&up, None, none, &cfg(Some("upstage"))).is_empty());
        assert!(env(&Choice { provider: "gemini", base_url: "", model: "" }, None, none, &cfg(Some("upstage"))).is_empty());
        // 셸에 키가 있으면 덮어쓰지 않는다. 빈 값은 없는 것
        let shell = |k: &str| (k == "UPSTAGE_API_KEY").then(|| "from-shell".to_string());
        assert_eq!(env(&up, Some(KEY), shell, &cfg(None)), kv(&[("TRACTUS_LLM_PROVIDER", "upstage"), ("TRACTUS_LLM_BASE_URL", "https://api.upstage.ai/v1")]));
        let empty = |k: &str| (k == "UPSTAGE_API_KEY").then(String::new);
        assert_eq!(env(&up, Some(KEY), empty, &cfg(None)), both);
    }

    #[test]
    fn each_provider_key_goes_only_to_its_own_variable() {
        let none = |_: &str| None;
        for (p, var, url) in PROVIDERS {
            // 직접 입력은 주소가 있어야 키가 간다 (아래 테스트)
            let c = Choice { provider: p, base_url: if url.is_empty() { "https://gw.example.com/v1" } else { "" }, model: "m-1" };
            let e = env(&c, Some(KEY), none, &cfg(None));
            assert_eq!(e.iter().filter(|(_, v)| v == KEY).map(|(k, _)| k.as_str()).collect::<Vec<_>>(), [var], "{p}");
            assert!(e.contains(&("TRACTUS_LLM_PROVIDER".into(), p.into())) && e.contains(&("TRACTUS_LLM_MODEL".into(), "m-1".into())));
            // 주소 칸이 비어 있어도 서비스 기본 주소를 싣는다: 노트 폴더 .env의 주소가 키를 받지 못하게
            let base = if url.is_empty() { "https://gw.example.com/v1" } else { url };
            assert!(e.contains(&("TRACTUS_LLM_BASE_URL".into(), base.into())), "{p}");
        }
    }

    #[test]
    fn a_base_url_from_dotenv_cannot_receive_the_key() {
        let none = |_: &str| None;
        // 직접 입력인데 주소가 비어 있으면 키를 싣지 않는다 (남의 .env 주소로 가지 않게)
        let c = Choice { provider: "custom", base_url: "", model: "m" };
        assert!(env(&c, Some(KEY), none, &cfg(None)).iter().all(|(_, v)| v != KEY));
        // 서비스 기본 주소가 있으면 환경변수 주소보다 앞선다
        let c = Choice { provider: "claude", base_url: "", model: "" };
        let e = env(&c, Some(KEY), none, &cfg(None));
        assert!(e.contains(&("TRACTUS_LLM_BASE_URL".into(), "https://api.anthropic.com/v1".into())));
    }

    #[test]
    fn base_url_and_model_follow_the_environment_rule() {
        let none = |_: &str| None;
        let c = Choice { provider: "custom", base_url: "https://gw.example.com/v1", model: "my-model" };
        // 키 없이도(이 Mac 주소의 Ollama) 서비스·주소·AI 모델은 싣는다
        let e = env(&c, None, none, &cfg(None));
        assert_eq!(e, kv(&[("TRACTUS_LLM_PROVIDER", "custom"), ("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1"), ("TRACTUS_LLM_MODEL", "my-model")]));
        // 환경이 다른 서비스를 정했어도 앱의 선택(서비스·주소·AI 모델)이 이긴다
        let e = env(&c, Some(KEY), none, &cfg(Some("openai")));
        assert_eq!(e, kv(&[("TRACTUS_LLM_API_KEY", KEY), ("TRACTUS_LLM_PROVIDER", "custom"), ("TRACTUS_LLM_BASE_URL", "https://gw.example.com/v1"), ("TRACTUS_LLM_MODEL", "my-model")]));
    }

    #[test]
    fn effective_config_for_the_send_notice() {
        let c = |provider, base_url, model| Choice { provider, base_url, model };
        // 키가 없으면 설정되지 않은 것 (예전과 같다)
        assert_eq!(effective(cfg(None), &c("upstage", "", ""), false).provider, None);
        assert_eq!(effective(cfg(None), &c("upstage", "", ""), true).provider.as_deref(), Some("upstage"));
        // 고른 서비스·주소(호스트만)·AI 모델
        let e = effective(cfg(None), &c("custom", "https://user.example.com:8443/v1", "m"), true);
        assert_eq!((e.provider.as_deref(), e.host.as_deref(), e.model.as_deref()), (Some("custom"), Some("user.example.com:8443"), Some("m")));
        assert_eq!(e.base_url, None); // 주소 전체는 화면에 보내지 않는다
        // 앱이 서비스를 정하면 주소는 앱 것 (입력칸이 비면 서비스 기본 주소), AI 모델은 입력칸이 비었을 때만 환경 것
        let env_url = ask::LlmConfig { provider: None, model: Some("env-m".into()), local_only: false, host: None, base_url: Some("https://elsewhere.example.com/v1".into()) };
        let e = effective(env_url, &c("claude", "", ""), true);
        assert_eq!((e.host.as_deref(), e.model.as_deref()), (Some("api.anthropic.com"), Some("env-m")));
        let env_url = ask::LlmConfig { provider: None, model: Some("env-m".into()), local_only: false, host: None, base_url: Some("https://elsewhere.example.com/v1".into()) };
        let e = effective(env_url, &c("custom", "https://mine.example.com/v1", "app-m"), true);
        assert_eq!((e.host.as_deref(), e.model.as_deref()), (Some("mine.example.com"), Some("app-m")));
        // 이 Mac 주소의 직접 입력은 키 없이도 설정된 것
        assert_eq!(effective(cfg(None), &c("custom", "http://localhost:11434/v1", "x"), false).provider.as_deref(), Some("custom"));
        assert_eq!(effective(cfg(None), &c("custom", "https://gw.example.com", "x"), false).provider, None);
        // 환경이 다섯 서비스 중 하나(upstage)를 정해 두어도 앱이 고른 서비스(키가 있는 gemini)가 이긴다. 환경 모델은 다른 서비스의 것이라 버린다
        let env_up = ask::LlmConfig { provider: Some("upstage".into()), model: Some("solar-env".into()), local_only: false, host: None, base_url: Some("https://elsewhere.example.com/v1".into()) };
        let e = effective(env_up, &c("gemini", "", ""), true);
        assert_eq!((e.provider.as_deref(), e.host.as_deref(), e.model), (Some("gemini"), Some("generativelanguage.googleapis.com"), None));
        // 고른 서비스가 쓸 수 없는데 환경이 서비스를 정했으면 환경 것 (.env.local에만 키를 둔 개발 환경)
        let env_up = ask::LlmConfig { provider: Some("upstage".into()), model: Some("solar-env".into()), local_only: false, host: None, base_url: None };
        let e = effective(env_up, &c("gemini", "", ""), false);
        assert_eq!((e.provider.as_deref(), e.model.as_deref()), (Some("upstage"), Some("solar-env")));
        // 앱 밖의 서비스를 환경이 정했으면 설정 화면의 주소·AI 모델은 보지 않는다
        let env_cfg = ask::LlmConfig { provider: Some("gemma-local".into()), model: None, local_only: true, host: None, base_url: Some("http://127.0.0.1:1234/v1".into()) };
        let e = effective(env_cfg, &c("claude", "https://api.anthropic.com/v1", "claude-x"), true);
        assert_eq!((e.provider.as_deref(), e.host.as_deref(), e.model, e.local_only), (Some("gemma-local"), Some("127.0.0.1:1234"), None, true));
    }

    #[test]
    fn hosts_are_compared_after_parsing() {
        for ok in ["http://localhost:11434/v1", "http://127.0.0.1/", "http://[::1]:8080/v1", "HTTP://LOCALHOST/x", "https://localhost"] {
            assert!(is_loopback(ok), "{ok}");
        }
        for bad in [
            "https://api.openai.com/v1",
            "http://localhost.evil.com/v1",
            "http://127.0.0.1.evil.com",
            "http://evil.com/localhost",
            "http://evil.com/?h=localhost",
            "http://evil.com#@localhost",
            "http://localhost@evil.com/v1",
            "http://evil.com@localhost/v1",
            "http://localhost./v1",
            "http://0.0.0.0/v1",
            "http://[::2]/v1",
            "http://evil.com\\@localhost/",
            "localhost:11434",
            "ftp://localhost/",
            "http://localhost:99999/v1",
            "http://localhost:/v1",
        ] {
            assert!(!is_loopback(bad), "{bad}");
        }
        assert_eq!(host_of("https://api.anthropic.com/v1/").as_deref(), Some("api.anthropic.com"));
        assert_eq!(host_of("http://[::1]:11434/v1").as_deref(), Some("[::1]:11434"));
        assert_eq!(host_of("https://user:pw@evil.com/v1"), None); // 계정 정보가 든 주소는 화면에 내지 않는다
    }

    #[test]
    fn base_url_and_model_are_validated() {
        assert_eq!(normalize_base_url("  ").unwrap(), "");
        assert_eq!(normalize_base_url(" https://gw.example.com/v1/ ").unwrap(), "https://gw.example.com/v1");
        assert!(normalize_base_url("gw.example.com/v1").unwrap_err().contains("http://"));
        assert!(normalize_base_url("ftp://x.com").is_err() && normalize_base_url("https://").is_err());
        assert!(normalize_base_url("https://a b.com").is_err() && normalize_base_url("https://x.com:99999").is_err());
        let e = normalize_base_url("https://user:secret-pw@x.com/v1").unwrap_err();
        assert!(e.contains("사용자 이름") && !e.contains("secret-pw"));
        assert_eq!(normalize_model("  gpt-x ").unwrap(), "gpt-x");
        assert_eq!(normalize_model("").unwrap(), "");
        assert!(normalize_model("a b").is_err() && normalize_model("a\nb").is_err() && normalize_model(&"a".repeat(201)).is_err());
        assert!(normalize_model("models/gemini-x:y_1.5").is_ok());
    }

    #[test]
    fn profiles_change_one_service_and_old_settings_migrate() {
        let mut v: Value = serde_json::from_str(r#"{"home":"/x","rec_mode":"hybrid","llm_provider":"claude","llm_base_url":"","llm_model":"claude-x"}"#).unwrap();
        migrate_llm(&mut v);
        assert_eq!((v["llm_default"].as_str(), v["llm_profiles"]["claude"]["model"].as_str(), v["home"].as_str()), (Some("claude"), Some("claude-x"), Some("/x")));
        assert!(v.get("llm_provider").is_none() && v.get("llm_model").is_none() && v.get("llm_base_url").is_none());
        with_profile(&mut v, "gemini", "", "gemini-flash-latest");
        assert_eq!((v["llm_profiles"]["claude"]["model"].as_str(), v["llm_profiles"]["gemini"]["model"].as_str()), (Some("claude-x"), Some("gemini-flash-latest"))); // 다른 서비스는 그대로
        // 새 형식이 이미 있으면 예전 값은 버린다. 비어 있는 예전 설정·모르는 서비스는 아무것도 만들지 않는다
        let mut v: Value = serde_json::from_str(r#"{"llm_default":"openai","llm_provider":"claude","llm_model":"x"}"#).unwrap();
        migrate_llm(&mut v);
        assert_eq!((v["llm_default"].as_str(), v.get("llm_profiles"), v.get("llm_provider")), (Some("openai"), None, None));
        let mut v: Value = serde_json::from_str(r#"{"llm_provider":"upstage"}"#).unwrap();
        migrate_llm(&mut v);
        assert_eq!((v["llm_default"].as_str(), v.get("llm_profiles")), (Some("upstage"), None));
        let mut v: Value = serde_json::from_str(r#"{"llm_provider":"../etc","llm_model":"x"}"#).unwrap();
        migrate_llm(&mut v);
        assert!(v.get("llm_default").is_none() && v.get("llm_profiles").is_none());
        // 손으로 고쳐 객체가 아니게 된 값도 덮어쓴다 (패닉하지 않는다)
        let mut v = serde_json::json!({"llm_profiles": 3});
        with_profile(&mut v, "openai", "", "m");
        assert_eq!(v["llm_profiles"]["openai"]["model"], "m");
    }

    #[test]
    fn usable_means_a_key_or_a_local_custom_address() {
        assert!(usable("gemini", "", true) && !usable("gemini", "", false));
        assert!(usable("custom", "http://localhost:11434/v1", false) && !usable("custom", "https://gw.example.com", false));
        assert!(!usable("openai", "http://localhost:11434/v1", false)); // 직접 입력만
    }

    #[test]
    fn models_output_parsing() {
        let ok = r#"{"models": ["gemini-flash-latest", "gemini-3.8-flash"]}"#;
        assert_eq!(parse_models(ok, "", true).models, ["gemini-flash-latest", "gemini-3.8-flash"]);
        assert!(parse_models(ok, "", false).models.is_empty()); // 종료 코드가 실패면 성공이 아니다
        let err = r#"{"event":"error","message":"HTTP 401","code":"llm_auth"}"#;
        let r = parse_models(err, "", false);
        assert_eq!((r.models.len(), r.code.as_deref(), r.message.as_deref()), (0, Some("llm_auth"), Some("HTTP 401")));
        assert_eq!(parse_models("", "Traceback\nError: 깨졌습니다", false).message.as_deref(), Some("깨졌습니다"));
    }

    /// 2026-10-15 실제 Gemini·Upstage 호출에서 받은 줄 그대로 (합성 "OK" 요청만, 키 없음)
    #[test]
    fn parses_lines_captured_from_real_providers() {
        let ok = r#"{"ok": true, "provider": "gemini", "model": "gemini-flash-latest", "host": "generativelanguage.googleapis.com", "latency_ms": 9560, "empty": false}"#;
        let r = parse_test(ok, "", true);
        assert_eq!((r.ok, r.latency_ms, r.empty, r.model.as_deref()), (true, Some(9560), false, Some("gemini-flash-latest")));
        let notfound = r#"{"event": "error", "message": "generativelanguage.googleapis.com HTTP 404: This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.", "code": "llm_model"}"#;
        let r = parse_test(notfound, "", false);
        assert_eq!(r.code.as_deref(), Some("llm_model"));
        assert!(r.message.unwrap().contains("gemini-3.8-flash"));
        let list = r#"{"models": ["aqa", "gemini-2.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "solar-pro4"]}"#;
        assert_eq!(parse_models(list, "", true).models.len(), 5);
    }

    #[test]
    fn test_process_is_killed_after_the_deadline() {
        let spawn = |script: &str| Command::new("sh").args(["-c", script]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let t0 = Instant::now();
        assert!(wait_with_deadline(spawn("sleep 30"), Duration::from_millis(300)).unwrap().is_none());
        assert!(t0.elapsed() < Duration::from_secs(5));
        let out = wait_with_deadline(spawn("echo hi; echo oops >&2"), Duration::from_secs(10)).unwrap().unwrap();
        assert_eq!((String::from_utf8_lossy(&out.stdout).trim(), String::from_utf8_lossy(&out.stderr).trim(), out.status.success()), ("hi", "oops", true));
    }

    #[test]
    fn test_output_parsing() {
        let ok = r#"{"ok": true, "provider": "claude", "model": "claude-x", "host": "api.anthropic.com", "latency_ms": 412}"#;
        assert_eq!(
            parse_test(ok, "", true),
            TestResult { ok: true, provider: Some("claude".into()), model: Some("claude-x".into()), host: Some("api.anthropic.com".into()), latency_ms: Some(412), empty: false, code: None, message: None }
        );
        assert!(parse_test(r#"{"ok": true, "provider": "gemini", "model": "m", "host": "h", "latency_ms": 9, "empty": true}"#, "", true).empty); // 빈 답도 성공
        let err = r#"{"event":"error","message":"api.anthropic.com HTTP 401","code":"llm_auth"}"#;
        let r = parse_test(err, "api.anthropic.com HTTP 401", false);
        assert_eq!((r.ok, r.code.as_deref(), r.message.as_deref()), (false, Some("llm_auth"), Some("api.anthropic.com HTTP 401")));
        // 성공 줄이어도 종료 코드가 실패면 성공이 아니다
        assert!(!parse_test(ok, "", false).ok);
        // 이벤트 없이 죽으면 stderr 마지막 줄
        assert_eq!(parse_test("", "Traceback\nError: 깨졌습니다", false).message.as_deref(), Some("깨졌습니다"));
        assert!(parse_test("", "", false).message.is_some());
    }
}
