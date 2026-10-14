//! AI 서비스(Upstage) API 키 (docs/desktop.md §2.14). 앱 설정 폴더의 `llm_key` 파일 한 개에만 둔다.
//! 노트 폴더($TRACTUS_HOME)는 동기화될 수 있어 쓰지 않는다. 키는 webview·settings.json·인수·로그·오류 문구로 나가지 않고,
//! 요약·질문을 돌리는 tractus 프로세스의 환경변수로만 들어간다 (Settings::tractus_llm).

use crate::AppState;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tauri::State;

const FILE: &str = "llm_key";
const KEY_ENV: &str = "UPSTAGE_API_KEY";
const PROVIDER_ENV: &str = "TRACTUS_LLM_PROVIDER";
/// 키를 등록하면 쓰는 AI 서비스 (코어 PROVIDERS의 이름)
pub const PROVIDER: &str = "upstage";
const MIN_LEN: usize = 10;
const MAX_LEN: usize = 200;

/// 저장 전 검증. 앞뒤 공백은 떼고, 길이와 공백·제어 문자, 인쇄 가능한 ASCII 밖의 글자(HTTP 헤더에 못 실린다)를 본다. 오류 문장에 키를 넣지 않는다
pub fn validate(raw: &str) -> Result<String, String> {
    let key = raw.trim();
    let len = key.chars().count();
    if len == 0 {
        return Err("API 키를 입력하세요.".into());
    }
    if !(MIN_LEN..=MAX_LEN).contains(&len) {
        return Err(format!("API 키는 {MIN_LEN}자에서 {MAX_LEN}자 사이여야 합니다."));
    }
    if key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("API 키 중간에 공백이나 줄바꿈이 있습니다. 키만 그대로 붙여 넣으세요.".into());
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("API 키에 영문·숫자·기호가 아닌 글자가 있습니다. 키만 그대로 붙여 넣으세요.".into());
    }
    Ok(key.to_string())
}

/// 저장된 키. 없거나 비어 있으면 None
pub fn load(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join(FILE)).ok()?;
    Some(raw.trim().to_string()).filter(|k| !k.is_empty())
}

/// 임시 파일(0600으로 만든다) → rename. 덮어쓸 때도 권한을 0600으로 맞춘다
pub fn save(dir: &Path, raw: &str) -> Result<(), String> {
    let key = validate(raw)?;
    let fail = |e: std::io::Error| format!("API 키를 저장하지 못했습니다\n{e}");
    fs::create_dir_all(dir).map_err(fail)?;
    let tmp = dir.join(format!("{FILE}.tmp"));
    let written = (|| {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.set_permissions(fs::Permissions::from_mode(0o600))?; // 임시 파일이 남아 있었어도
        f.write_all(key.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, dir.join(FILE))
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        fail(e)
    })
}

/// 없어도 성공
pub fn delete(dir: &Path) -> Result<(), String> {
    match fs::remove_file(dir.join(FILE)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("API 키를 지우지 못했습니다\n{e}")),
        _ => Ok(()),
    }
}

/// LLM을 부르는 tractus 프로세스에만 덧붙이는 환경변수. 키가 없으면 비어 있다(지금까지와 똑같이 실행).
/// 앱 프로세스(셸)에 이미 있는 값은 덮어쓰지 않는다: UPSTAGE_API_KEY가 셸에 있으면 넣지 않고,
/// 공급자는 셸·.env.local·.env 어디에도 없을 때만 upstage로 정한다(provider_set)
pub fn env(key: Option<&str>, process_env: impl Fn(&str) -> Option<String>, provider_set: bool) -> Vec<(String, String)> {
    let Some(key) = key else { return vec![] };
    let mut env = vec![];
    if process_env(KEY_ENV).is_none_or(|v| v.is_empty()) {
        env.push((KEY_ENV.to_string(), key.to_string()));
    }
    if !provider_set {
        env.push((PROVIDER_ENV.to_string(), PROVIDER.to_string()));
    }
    env
}

/// 보내기 전 안내: 키가 등록돼 있고 다른 설정이 없으면 Upstage로 보낸다고 알린다
pub fn with_saved_key(mut cfg: crate::ask::LlmConfig, saved: bool) -> crate::ask::LlmConfig {
    if saved && cfg.provider.is_none() {
        cfg.provider = Some(PROVIDER.to_string());
    }
    cfg
}

#[derive(Serialize)]
pub struct KeyStatus {
    saved: bool,
}

fn dir(state: &AppState) -> Result<&Path, String> {
    state.config_path.parent().ok_or_else(|| "앱 설정 폴더를 찾을 수 없습니다".to_string())
}

/// 키 자체는 돌려주지 않는다
#[tauri::command]
pub fn llm_key_status(state: State<'_, AppState>) -> KeyStatus {
    KeyStatus { saved: dir(&state).ok().and_then(load).is_some() }
}

#[tauri::command]
pub fn llm_key_save(state: State<'_, AppState>, key: String) -> Result<(), String> {
    save(dir(&state)?, &key)
}

#[tauri::command]
pub fn llm_key_delete(state: State<'_, AppState>) -> Result<(), String> {
    delete(dir(&state)?)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(validate("123456789").is_err()); // 9자
        assert!(validate("1234567890").is_ok());
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
        for bad in ["secret key with spaces", "short", "secret\u{7}key-123456", "secret\u{201c}key-123456"] {
            let e = validate(bad).unwrap_err();
            assert!(!e.contains("secret") && !e.contains(bad), "{e}");
        }
        let d = tmp("err");
        fs::create_dir_all(&d).unwrap();
        fs::create_dir(d.join(FILE)).unwrap(); // 파일 자리에 폴더: rename이 실패한다
        let e = save(&d, KEY).unwrap_err();
        assert!(!e.contains(KEY) && !format!("{e:?}").contains(KEY), "{e}");
        assert!(!d.join("llm_key.tmp").exists()); // 임시 파일을 치운다
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn save_creates_0600_and_rewrite_keeps_it() {
        let d = tmp("save").join("config"); // 폴더가 없어도 만든다
        assert_eq!(load(&d), None);
        save(&d, &format!("  {KEY} ")).unwrap();
        let p = d.join(FILE);
        assert_eq!(fs::read_to_string(&p).unwrap(), KEY); // 트림해서 저장
        assert_eq!(mode(&p), 0o600);
        assert_eq!(load(&d).as_deref(), Some(KEY));
        // 넓은 권한으로 바뀌어 있어도 다시 쓰면 0600
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
        save(&d, "another-key-456").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "another-key-456");
        assert_eq!(mode(&p), 0o600);
        // 남아 있던 임시 파일이 넓은 권한이어도 결과는 0600
        fs::write(d.join("llm_key.tmp"), "old").unwrap();
        fs::set_permissions(d.join("llm_key.tmp"), fs::Permissions::from_mode(0o644)).unwrap();
        save(&d, KEY).unwrap();
        assert_eq!(mode(&p), 0o600);
        assert!(!d.join("llm_key.tmp").exists());
        // 잘못된 키는 기존 파일을 건드리지 않는다
        assert!(save(&d, "short").is_err());
        assert_eq!(load(&d).as_deref(), Some(KEY));
        fs::remove_dir_all(d.parent().unwrap()).unwrap();
    }

    #[test]
    fn delete_is_idempotent_and_status_follows() {
        let d = tmp("del");
        delete(&d).unwrap(); // 폴더도 파일도 없다
        save(&d, KEY).unwrap();
        assert!(load(&d).is_some());
        delete(&d).unwrap();
        assert_eq!(load(&d), None);
        delete(&d).unwrap();
        fs::write(d.join(FILE), " \n").unwrap(); // 비어 있으면 등록 안 됨
        assert_eq!(load(&d), None);
        fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn env_injection_rules() {
        let none = |_: &str| None;
        assert!(env(None, none, false).is_empty()); // 키 없음: 지금과 똑같이
        let both = [(KEY_ENV.to_string(), KEY.to_string()), (PROVIDER_ENV.to_string(), "upstage".to_string())];
        assert_eq!(env(Some(KEY), none, false), both);
        // 공급자가 이미 정해져 있으면 키만
        assert_eq!(env(Some(KEY), none, true), [(KEY_ENV.to_string(), KEY.to_string())]);
        // 셸에 키가 있으면 덮어쓰지 않는다. 빈 값은 없는 것
        let shell = |k: &str| (k == KEY_ENV).then(|| "from-shell".to_string());
        assert_eq!(env(Some(KEY), shell, false), [(PROVIDER_ENV.to_string(), "upstage".to_string())]);
        let empty = |k: &str| (k == KEY_ENV).then(String::new);
        assert_eq!(env(Some(KEY), empty, false), both);
    }

    #[test]
    fn notice_reports_upstage_only_when_nothing_else_is_set() {
        let cfg = |p: Option<&str>| crate::ask::LlmConfig { provider: p.map(String::from), model: None, local_only: false };
        assert_eq!(with_saved_key(cfg(None), true).provider.as_deref(), Some("upstage"));
        assert_eq!(with_saved_key(cfg(None), false).provider, None);
        assert_eq!(with_saved_key(cfg(Some("gemma-local")), true).provider.as_deref(), Some("gemma-local"));
    }
}
